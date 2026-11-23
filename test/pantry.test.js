// Pantry: Have / Low / Out, the shopping list link, recipes, expiry, and notifications.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startApp, startDatabase, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const CatalogItem = require('../models/CatalogItem');
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

  // Adding opens a short form first (use-by date, how many), grouped by spot after.
  let page = await katie('/s/pantry/add?name=Milk&spot=Fridge');
  assert.match(page.text, /name="expires"/);
  assert.match(page.text, /name="count"/);
  assert.doesNotMatch(page.text, /already in the pantry/);
  await katie('/s/pantry/add', { method: 'POST', form: { name: 'Milk', spot: 'Fridge', expires: addDays(today, 9), count: '1', amount: '1 gallon' } });
  await katie('/s/pantry/add', { method: 'POST', form: { name: 'Rice', spot: 'Pantry' } });
  // The old quick add form goes to the add page.
  assert.equal((await katie('/s/pantry/quick', { method: 'POST', form: { name: 'Beans', spot: 'Pantry' } })).location, '/s/pantry/add?name=Beans&spot=Pantry');
  // Adding has every detail the Edit page has, and Bought can be cleared.
  let addPage = await katie('/s/pantry/add?name=Chips');
  for (const f of ['name="status"', 'name="food"', 'name="autoShop"', 'name="note"', 'name="photo"', 'enctype="multipart/form-data"']) assert.ok(addPage.text.includes(f), f);
  await katie('/s/pantry/add', { method: 'POST', form: { name: 'Chips', spot: 'Pantry', count: '1', bought: '', status: 'low', food: 'no', details: '1', note: 'The blue bag' } });
  await withDb(app.uri, async () => {
    const c = await PantryItem.findOne({ name: /chips/i }).lean();
    assert.equal(c.batches[0].bought, '', 'no bought date when cleared');
    assert.equal(c.status, 'low');
    assert.equal(c.food, false);
    assert.equal(c.autoShop, false, 'unticked');
    assert.equal(c.note, 'The blue bag');
    await PantryItem.deleteOne({ _id: c._id });
  });
  const ids = await withDb(app.uri, async () => Object.fromEntries((await PantryItem.find().lean()).map((p) => [p.name, String(p._id)])));
  // Already there: choose to add to its count (keeping the earlier date), replace it, or keep separate.
  page = await katie('/s/pantry/add?name=milk');
  assert.match(page.text, /Milk is already in the pantry/);
  assert.match(page.text, new RegExp(`value="add:${ids.Milk}" checked`));
  await katie('/s/pantry/add', { method: 'POST', form: { name: 'milk', choice: `add:${ids.Milk}`, count: '2', expires: addDays(today, 12) } });
  await withDb(app.uri, async () => {
    const m = await PantryItem.findById(ids.Milk).lean();
    assert.equal(m.count, 3);
    assert.equal(m.expires, addDays(today, 9), 'the list shows the soonest date');
    assert.deepEqual(m.batches.map((b) => [b.count, b.expires]), [[1, addDays(today, 9)], [2, addDays(today, 12)]], 'each date is kept');
    assert.equal(await PantryItem.countDocuments({ key: 'milk' }), 1);
  });
  page = await katie('/s/pantry');
  assert.match(page.text, /3 of them/);
  assert.match(page.text, /\(\+1 later\)/);
  // The item page lists each date, with a line for more.
  page = await katie(`/s/pantry/${ids.Milk}/edit`);
  assert.match(page.text, new RegExp(`name="bExpires" type="date" value="${addDays(today, 12)}"`));
  assert.match(page.text, /No date/);
  // −1 with more than one date asks which one.
  let r0 = await katie(`/s/pantry/${ids.Milk}/use`, { method: 'POST', form: { query: '' } });
  assert.match(r0.location, new RegExp(`^/s/pantry/${ids.Milk}/use`));
  assert.match((await katie(r0.location)).text, /Which one did you use/);
  await katie(`/s/pantry/${ids.Milk}/use`, { method: 'POST', form: { query: '', batch: '0' } });
  await withDb(app.uri, async () => {
    const m = await PantryItem.findById(ids.Milk).lean();
    assert.deepEqual([m.count, m.expires], [2, addDays(today, 12)]);
  });
  // Edit: a date can be cleared (things that don't expire), and lines added.
  await katie(`/s/pantry/${ids.Milk}`, { method: 'POST', form: [['name', 'Milk'], ['spot', 'Fridge'], ['status', 'have'], ['autoShop', 'on'], ['bCount', '2'], ['bExpires', ''], ['bCount', '1'], ['bExpires', addDays(today, 30)]] });
  await withDb(app.uri, async () => {
    const m = await PantryItem.findById(ids.Milk).lean();
    assert.deepEqual([m.count, m.expires, m.batches.length], [3, addDays(today, 30), 2]);
  });
  await katie(`/s/pantry/${ids.Milk}`, { method: 'POST', form: [['name', 'Milk'], ['spot', 'Fridge'], ['status', 'have'], ['autoShop', 'on'], ['bCount', '2'], ['bExpires', '']] });
  await withDb(app.uri, async () => assert.equal((await PantryItem.findById(ids.Milk).lean()).expires, ''));
  // −1 with one line just takes one.
  await katie(`/s/pantry/${ids.Milk}/use`, { method: 'POST', form: { query: '' } });
  await withDb(app.uri, async () => assert.equal((await PantryItem.findById(ids.Milk).lean()).count, 1));
  // The Details page asks too.
  page = await katie('/s/pantry', { method: 'POST', form: { name: 'Rice', spot: 'Pantry', status: 'have', count: '1', autoShop: 'on' } });
  assert.equal(page.status, 422);
  assert.match(page.text, /Rice is already in the pantry/);
  await withDb(app.uri, async () => assert.equal(await PantryItem.countDocuments({ key: 'rice' }), 1));
  page = await sam('/s/pantry');
  assert.match(page.text, /Fridge/);
  assert.match(page.text, /Milk/);
  assert.doesNotMatch((await out('/s/pantry')).text, /Milk/);
  assert.equal((await out(`/s/pantry/${ids.Milk}/status`, { method: 'POST', form: { status: 'out' } })).status, 404);

  // Low puts it on the shopping list, once.
  await withDb(app.uri, async () => PantryItem.updateOne({ _id: ids.Milk }, { $set: { count: 1 } }));
  let r = await sam(`/s/pantry/${ids.Milk}/status`, { method: 'POST', form: { status: 'low', query: 'spot=Fridge' } });
  assert.equal(r.location, `/s/pantry?spot=Fridge#p-${ids.Milk}`);
  await sam(`/s/pantry/${ids.Milk}/status`, { method: 'POST', form: { status: 'out' } });
  await withDb(app.uri, async () => {
    const items = await ShoppingItem.find({ key: 'milk' }).lean();
    assert.equal(items.length, 1);
    assert.match(items[0].note, /Pantry: Low/);
  });
  assert.match((await katie('/activity')).text, /Sam marked Milk Low and added it to Shopping/);
  assert.match((await katie('/s/pantry?show=low')).text, /Milk/);
  assert.doesNotMatch((await katie('/s/pantry?show=low')).text, /row-title">Rice</);

  // Not every item should go to the list.
  await katie(`/s/pantry/${ids.Rice}`, { method: 'POST', form: { name: 'Rice', spot: 'Pantry', status: 'have', amount: 'Half a bag' } });
  await katie(`/s/pantry/${ids.Rice}/status`, { method: 'POST', form: { status: 'out' } });
  await withDb(app.uri, async () => assert.equal(await ShoppingItem.countDocuments({ key: 'rice' }), 0));

  // Buying it: it waits under Put away (on Pantry and Today) instead of changing the pantry.
  const milkShop = await withDb(app.uri, async () => String((await ShoppingItem.findOne({ key: 'milk' }).lean())._id));
  await withDb(app.uri, async () => ShoppingItem.updateOne({ _id: milkShop }, { $set: { qty: '2' } }));
  await sam(`/s/shopping/${milkShop}/toggle`, { method: 'POST', form: { query: '' } });
  await withDb(app.uri, async () => {
    assert.equal((await PantryItem.findById(ids.Milk).lean()).status, 'out');
    assert.equal((await ShoppingItem.findById(milkShop).lean()).putAway, 'pending');
  });
  page = await katie('/s/pantry');
  assert.match(page.text, /id="putaway"/);
  assert.match((await katie('/')).text, /Put away 1 thing from shopping/);
  page = await katie(`/s/pantry/add?from=${milkShop}`);
  assert.match(page.text, /Put away/);
  assert.match(page.text, /name="count"[^>]*value="2"/, 'from the shopping quantity');
  // Replace: Have again, with the new date and count.
  await katie('/s/pantry/add', { method: 'POST', form: { from: milkShop, name: 'Milk', choice: `replace:${ids.Milk}`, count: '2', expires: addDays(today, 10) } });
  await withDb(app.uri, async () => {
    const m = await PantryItem.findById(ids.Milk).lean();
    assert.deepEqual([m.status, m.count, m.expires], ['have', 2, addDays(today, 10)]);
    assert.equal((await ShoppingItem.findById(milkShop).lean()).putAway, 'done');
  });
  assert.doesNotMatch((await katie('/s/pantry')).text, /id="putaway"/);
  // Something new (not in the pantry yet) waits under Put away too.
  const newShop = await withDb(app.uri, async () => String((await ShoppingItem.create({ householdId: (await Household.findOne({ name: 'Home' }))._id, createdBy: null, byName: 'Sam', name: 'Paprika', key: 'paprika' }))._id));
  await sam(`/s/shopping/${newShop}/toggle`, { method: 'POST', form: { query: '' } });
  await withDb(app.uri, async () => assert.equal((await ShoppingItem.findById(newShop).lean()).putAway, 'pending'));
  assert.match((await katie('/s/pantry')).text, /Paprika/);
  // Skip: into the pantry as Have, no date, in its aisle's spot.
  const hh = await withDb(app.uri, async () => {
    const h = await Household.findOne({ name: 'Home' });
    h.aisleSpots = [{ aisle: 'Frozen', spot: h.pantrySpots[h.pantrySpots.length - 1] }];
    await h.save();
    return h._id;
  });
  await katie(`/s/pantry/putaway/${newShop}/skip`, { method: 'POST' });
  await withDb(app.uri, async () => {
    const p = await PantryItem.findOne({ key: 'paprika' }).lean();
    assert.deepEqual([p.status, p.count, p.expires || ''], ['have', 1, '']);
    assert.equal((await ShoppingItem.findById(newShop).lean()).putAway, 'done');
  });
  const buy = async (name, extra = {}) => {
    const id = await withDb(app.uri, async () => String((await ShoppingItem.create({ householdId: hh, createdBy: null, byName: 'Sam', name, key: name.toLowerCase(), ...extra }))._id));
    await sam(`/s/shopping/${id}/toggle`, { method: 'POST', form: { query: '' } });
    return id;
  };
  // Already there: Skip adds to its count.
  await katie(`/s/pantry/putaway/${await buy('Paprika', { qty: '2' })}/skip`, { method: 'POST' });
  await withDb(app.uri, async () => assert.equal((await PantryItem.findOne({ key: 'paprika' }).lean()).count, 3));
  // The aisle's spot.
  await katie(`/s/pantry/putaway/${await buy('Peas', { aisle: 'Frozen' })}/skip`, { method: 'POST' });
  await withDb(app.uri, async () => {
    const h = await Household.findById(hh).lean();
    assert.equal((await PantryItem.findOne({ key: 'peas' }).lean()).spot, h.pantrySpots[h.pantrySpots.length - 1]);
  });
  // Always: added now, and straight into the pantry next time (no Put away).
  const towels = await buy('Paper towels');
  await katie(`/s/pantry/putaway/${towels}/always`, { method: 'POST' });
  await withDb(app.uri, async () => {
    assert.equal((await CatalogItem.findOne({ householdId: hh, key: 'paper towels' }).lean()).autoPantry, true);
    assert.equal((await PantryItem.findOne({ key: 'paper towels' }).lean()).count, 1);
  });
  const towels2 = await buy('Paper towels');
  await withDb(app.uri, async () => {
    assert.equal((await ShoppingItem.findById(towels2).lean()).putAway, 'done');
    assert.equal((await PantryItem.findOne({ key: 'paper towels' }).lean()).count, 2);
  });
  // Settings → Pantry lists it; removing it asks again.
  let st = await katie('/settings/s/pantry');
  assert.match(st.text, /Skip the details/);
  assert.match(st.text, /Paper towels/i);
  assert.match(st.text, /<select id="aisleSpot\d+" name="aisleSpot\d+">/);
  await katie('/settings/lists/auto-pantry', { method: 'POST', form: { key: 'paper towels' } });
  await katie('/settings/lists/auto-pantry', { method: 'POST', form: { action: 'add', name: 'Dish soap' } });
  await withDb(app.uri, async () => {
    assert.equal((await CatalogItem.findOne({ householdId: hh, key: 'paper towels' }).lean()).autoPantry, false);
    assert.equal((await CatalogItem.findOne({ householdId: hh, key: 'dish soap' }).lean()).autoPantry, true);
  });
  // Skip all: every waiting item goes in without details.
  await buy('Soap');
  await buy('Beans');
  assert.match((await katie('/s/pantry')).text, /Skip details for all 2/);
  await katie('/s/pantry/putaway/skip-all', { method: 'POST' });
  assert.doesNotMatch((await katie('/s/pantry')).text, /id="putaway"/);
  await withDb(app.uri, async () => assert.equal(await PantryItem.countDocuments({ key: { $in: ['soap', 'beans'] } }), 2));
  // Separate items: a second milk with its own date. One running out doesn't add milk to the list.
  await katie('/s/pantry/add', { method: 'POST', form: { name: 'Milk', choice: 'new', count: '1', expires: addDays(today, 20), spot: 'Fridge' } });
  await withDb(app.uri, async () => ShoppingItem.deleteMany({ key: 'milk' }));
  await katie(`/s/pantry/${ids.Milk}/status`, { method: 'POST', form: { status: 'out' } });
  await withDb(app.uri, async () => {
    assert.equal(await PantryItem.countDocuments({ key: 'milk' }), 2);
    assert.equal(await ShoppingItem.countDocuments({ key: 'milk' }), 0);
    await PantryItem.updateOne({ _id: ids.Milk }, { $set: { status: 'have', count: 2, batches: [{ count: 2, expires: '' }] } });
  });
  // Skip: bought, but not for the pantry.
  await withDb(app.uri, async () => ShoppingItem.create({ householdId: (await Household.findOne({ name: 'Home' }))._id, createdBy: null, byName: 'Sam', name: 'Rice', key: 'rice', bought: true, boughtAt: new Date(), boughtByName: 'Sam', putAway: 'pending' }));
  const riceShop = await withDb(app.uri, async () => String((await ShoppingItem.findOne({ key: 'rice', putAway: 'pending' }).lean())._id));
  await katie(`/s/pantry/putaway/${riceShop}/skip`, { method: 'POST' });
  await withDb(app.uri, async () => assert.equal((await ShoppingItem.findById(riceShop).lean()).putAway, 'done'));

  // Recipes: what the pantry has starts unticked.
  const rev = await katie(`/s/shopping/ingredients?recipe=${app.seeded.recipeId}`);
  assert.match(rev.text, /In pantry/);
  assert.doesNotMatch(rev.text, /value="milk" checked/);
  assert.match(rev.text, /value="spaghetti" checked/);

  // Expiry: shown, filtered, and on Today.
  await katie('/s/pantry', { method: 'POST', form: { name: 'Yogurt', spot: 'Fridge', status: 'have', bCount: '1', bExpires: addDays(today, 1), autoShop: 'on' } });
  page = await katie('/s/pantry?show=soon');
  assert.match(page.text, /Yogurt/);
  assert.match(page.text, /Expires tomorrow/);
  assert.doesNotMatch(page.text, /row-title">Rice</);
  const home = await sam('/');
  assert.match(home.text, /Yogurt/);
  assert.match(home.text, /low or out in the pantry/);

  // Removing a spot moves its items to Other; spots are in Settings.
  assert.match((await katie('/settings/s/pantry')).text, /Pantry spots/);
  await katie('/settings/lists/pantrySpots', { method: 'POST', form: { action: 'remove', value: 'Fridge' } });
  assert.match((await katie('/s/pantry')).text, /Other/);
  assert.doesNotMatch((await katie('/settings/s/pantry')).text, /Starter set/, 'the starter set is only in the setup guide');
  assert.equal((await katie('/settings/lists/starter', { method: 'POST' })).status, 404);

  // Swipe delete and undo.
  await katie(`/s/pantry/${ids.Rice}/delete`, { method: 'POST', form: { query: '' } });
  const undo = (await katie('/s/pantry')).text.match(/\/activity\/([a-f0-9]{24})\/undo/);
  await katie(`/activity/${undo[1]}/undo`, { method: 'POST', form: { back: '/s/pantry' } });
  await withDb(app.uri, async () => assert.ok(await PantryItem.exists({ name: 'Rice' })));

  // Settings.
  await sam('/settings/notifications', { method: 'POST', form: { morning: '08:00', reminders: 'on', events: 'on', pantryForm: '1', pantryExpiry: 'on', pantryExpiryDays: '5' } });
  await withDb(app.uri, async () => assert.equal((await User.findOne({ name: 'Sam' }).lean()).notify.pantryExpiryDays, 5));
  assert.match((await sam('/settings/notifications')).text, /about to expire/);
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
