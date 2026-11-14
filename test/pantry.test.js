// Pantry: Have / Low / Out, the shopping list link, recipes, expiry, and notifications.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startApp, startDatabase, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const PantryItem = require('../models/PantryItem');
const ShoppingItem = require('../models/ShoppingItem');
const Recipe = require('../models/Recipe');
const PushSubscription = require('../models/PushSubscription');
const NotifyLog = require('../models/NotifyLog');
const { addDays } = require('../lib/dates');
const { expiryText } = require('../lib/pantry');
const { tick } = require('../lib/notify');

const PW = 'correct horse';

test('expiry wording', () => {
  assert.deepEqual(expiryText('2026-11-13', '2026-11-14'), { text: 'Expired yesterday', tone: 'late' });
  assert.deepEqual(expiryText('2026-11-14', '2026-11-14'), { text: 'Expires today', tone: 'late' });
  assert.deepEqual(expiryText('2026-11-15', '2026-11-14'), { text: 'Expires tomorrow', tone: 'soon' });
  assert.equal(expiryText('2026-11-30', '2026-11-14').tone, '');
  assert.equal(expiryText('', '2026-11-14').text, '');
});

test('pantry', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_pantry',
    port: 3987,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const other = await Household.create({ name: 'Other' });
      const hash = await User.hashPassword(PW);
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      await User.create({ householdId: other._id, email: 'out@test.dev', name: 'Out', role: 'admin', passwordHash: hash });
      const r = await Recipe.create({ householdId: home._id, createdBy: katie._id, byName: 'Katie', title: 'Pasta', ingredients: [{ qty: '1 lb', name: 'spaghetti' }, { qty: '2 cups', name: 'Milk' }] });
      return { recipeId: r.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');
  const out = await signIn('out@test.dev');

  // Quick add, grouped by spot; no doubles.
  await katie('/s/pantry/quick', { method: 'POST', form: { name: 'Milk', spot: 'Fridge' } });
  await katie('/s/pantry/quick', { method: 'POST', form: { name: 'Rice', spot: 'Pantry' } });
  await katie('/s/pantry/quick', { method: 'POST', form: { name: 'milk', spot: 'Pantry' } });
  assert.match((await katie('/s/pantry')).text, /Milk is already in the pantry/);
  await withDb(app.uri, async () => assert.equal(await PantryItem.countDocuments({}), 2));
  const ids = await withDb(app.uri, async () => Object.fromEntries((await PantryItem.find().lean()).map((p) => [p.name, String(p._id)])));
  let page = await sam('/s/pantry');
  assert.match(page.text, /Fridge/);
  assert.match(page.text, /Milk/);
  assert.doesNotMatch((await out('/s/pantry')).text, /Milk/);
  assert.equal((await out(`/s/pantry/${ids.Milk}/status`, { method: 'POST', form: { status: 'out' } })).status, 404);

  // Low puts it on the shopping list, once.
  let r = await sam(`/s/pantry/${ids.Milk}/status`, { method: 'POST', form: { status: 'low', query: 'spot=Fridge' } });
  assert.equal(r.location, `/s/pantry?spot=Fridge#p-${ids.Milk}`);
  await sam(`/s/pantry/${ids.Milk}/status`, { method: 'POST', form: { status: 'out' } });
  await withDb(app.uri, async () => {
    const items = await ShoppingItem.find({ key: 'milk' }).lean();
    assert.equal(items.length, 1);
    assert.match(items[0].note, /Pantry: running low/);
  });
  assert.match((await katie('/activity')).text, /Sam marked Milk running low and added it to Shopping/);
  assert.match((await katie('/s/pantry?show=low')).text, /Milk/);
  assert.doesNotMatch((await katie('/s/pantry?show=low')).text, /row-title">Rice</);

  // Not every item should go to the list.
  await katie(`/s/pantry/${ids.Rice}`, { method: 'POST', form: { name: 'Rice', spot: 'Pantry', status: 'have', amount: 'Half a bag' } });
  await katie(`/s/pantry/${ids.Rice}/status`, { method: 'POST', form: { status: 'out' } });
  await withDb(app.uri, async () => assert.equal(await ShoppingItem.countDocuments({ key: 'rice' }), 0));

  // Buying it restocks the pantry.
  const milkShop = await withDb(app.uri, async () => String((await ShoppingItem.findOne({ key: 'milk' }).lean())._id));
  await sam(`/s/shopping/${milkShop}/toggle`, { method: 'POST', form: { query: '' } });
  await withDb(app.uri, async () => assert.equal((await PantryItem.findById(ids.Milk).lean()).status, 'have'));

  // Recipes: what the pantry has starts unticked.
  const rev = await katie(`/s/shopping/ingredients?recipe=${app.seeded.recipeId}`);
  assert.match(rev.text, /In pantry/);
  assert.doesNotMatch(rev.text, /value="milk" checked/);
  assert.match(rev.text, /value="spaghetti" checked/);

  // Expiry: shown, filtered, and on Today.
  await katie('/s/pantry', { method: 'POST', form: { name: 'Yogurt', spot: 'Fridge', status: 'have', expires: addDays(today, 1), autoShop: 'on' } });
  page = await katie('/s/pantry?show=soon');
  assert.match(page.text, /Yogurt/);
  assert.match(page.text, /Expires tomorrow/);
  assert.doesNotMatch(page.text, /row-title">Rice</);
  const home = await sam('/');
  assert.match(home.text, /Yogurt/);
  assert.match(home.text, /low or out in the pantry/);

  // Removing a spot moves its items to Other; spots are in Settings.
  assert.match((await katie('/settings/lists')).text, /Pantry spots/);
  await katie('/settings/lists/pantrySpots', { method: 'POST', form: { action: 'remove', value: 'Fridge' } });
  assert.match((await katie('/s/pantry')).text, /Other/);

  // Swipe delete and undo.
  await katie(`/s/pantry/${ids.Rice}/delete`, { method: 'POST', form: { query: '' } });
  const undo = (await katie('/s/pantry')).text.match(/\/activity\/([a-f0-9]{24})\/undo/);
  await katie(`/activity/${undo[1]}/undo`, { method: 'POST', form: { back: '/s/pantry' } });
  await withDb(app.uri, async () => assert.ok(await PantryItem.exists({ name: 'Rice' })));

  // Settings.
  await sam('/settings/notifications', { method: 'POST', form: { morning: '08:00', reminders: 'on', events: 'on', pantryForm: '1', pantryExpiry: 'on', pantryExpiryDays: '5' } });
  await withDb(app.uri, async () => assert.equal((await User.findOne({ name: 'Sam' }).lean()).notify.pantryExpiryDays, 5));
  assert.match((await sam('/settings')).text, /about to expire/);
});

test('pantry expiry notifications', async (t) => {
  const db = await startDatabase('nestly_test_pantry_notify');
  await mongoose.connect(db.uri);
  await mongoose.connection.db.dropDatabase();
  await NotifyLog.createIndexes();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  const at = (hhmm, day) => new Date(`${day}T${hhmm}:00-06:00`);
  const home = await Household.create({ name: 'Home' });
  const hash = await User.hashPassword(PW);
  const katie = await User.create({ householdId: home._id, email: 'k@t.dev', name: 'Katie', passwordHash: hash, timezone: 'America/Chicago' });
  const sam = await User.create({ householdId: home._id, email: 's@t.dev', name: 'Sam', passwordHash: hash, timezone: 'America/Chicago', notify: { pantryExpiry: false } });
  for (const u of [katie, sam]) await PushSubscription.create({ userId: u._id, endpoint: `https://push.test/${u.name}`, keys: { p256dh: 'p', auth: 'a' } });
  const mk = (name, expires, status = 'have') => PantryItem.create({ householdId: home._id, byName: 'Katie', name, key: name.toLowerCase(), expires, status });
  await mk('Yogurt', '2026-11-16');
  await mk('Chicken', '2026-11-15');
  await mk('Cheese', '2026-11-30');
  await mk('Old milk', '2026-11-15', 'out');
  const sent = [];
  const send = async (to, p) => { sent.push({ to: String(to), ...p }); return 1; };

  // Katie: 2 days ahead (default), at 8:00. Sam turned it off. Items marked Out are skipped.
  await tick(at('08:00', '2026-11-14'), send);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, katie.id);
  assert.equal(sent[0].title, '2 things about to expire');
  assert.equal(sent[0].body, 'Chicken (tomorrow), Yogurt (in 2 days)');
  // Each item is mentioned once, not every morning.
  await tick(at('08:00', '2026-11-15'), send);
  assert.equal(sent.length, 1);
  await tick(at('08:00', '2026-11-28'), send);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].title, 'Cheese is about to expire');
});
