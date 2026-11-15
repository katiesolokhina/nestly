// The Settings menu and pages, household settings for each section, and the pantry reference photo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const ShoppingItem = require('../models/ShoppingItem');
const PantryItem = require('../models/PantryItem');
const Bill = require('../models/Bill');
const Activity = require('../models/Activity');
const { addDays } = require('../lib/dates');

const PW = 'correct horse';
// A real 1×1 PNG, so the upload passes the image check.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('settings', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_settings',
    port: 3984,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      return { homeId: home.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');
  const home = () => withDb(app.uri, () => Household.findById(app.seeded.homeId).lean());

  // ---------- The menu ----------
  let page = await katie('/settings');
  for (const s of ['Account', 'Notifications', 'Appearance', 'Bottom bar', 'Households', 'People', 'Sections']) assert.match(page.text, new RegExp(`>${s}<`));
  assert.match(page.text, /href="\/settings\/s\/shopping"/);
  for (const p of ['/settings/notifications', '/settings/appearance', '/settings/bottom-bar', '/settings/people', '/settings/account', '/settings/sections', '/settings/s/pantry']) {
    const r = await katie(p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /href="\/settings">Back</, `${p} has Back`);
  }
  // Members: their own settings, no household ones.
  page = await sam('/settings');
  assert.doesNotMatch(page.text, /\/settings\/s\//);
  assert.doesNotMatch(page.text, /href="\/settings\/sections"/);
  assert.equal((await sam('/settings/s/shopping')).status, 404);
  assert.equal((await sam('/settings/s/shopping', { method: 'POST', form: { defaultStore: 'Costco' } })).status, 404);

  // The gear on a section opens its settings, and Back returns to the section. Admins only.
  assert.match((await katie('/s/shopping')).text, /href="\/settings\/s\/shopping\?from=section"/);
  assert.doesNotMatch((await sam('/s/shopping')).text, /settings\/s\/shopping/);
  assert.match((await katie('/settings/s/shopping?from=section')).text, /href="\/s\/shopping">Back</);

  // ---------- Section names ----------
  const all = ['shopping', 'remember', 'calendar', 'meals', 'recipes', 'pantry', 'bills', 'chores', 'info'].map((k) => ['sections', k]);
  await katie('/settings/sections', { method: 'POST', form: [...all, ['name_remember', 'Reminders'], ['name_info', 'House binder']] });
  assert.match((await sam('/more')).text, /Reminders/);
  assert.match((await sam('/s/remember')).text, /<h1 class="title-gear">Reminders/);
  assert.match((await sam('/s/info')).text, /House binder/);
  await katie('/settings/sections', { method: 'POST', form: [...all, ['name_remember', ''], ['name_info', 'House binder']] });
  assert.match((await sam('/s/remember')).text, /<h1 class="title-gear">Remember/);

  // ---------- Shopping ----------
  await katie('/settings/lists/methods', { method: 'POST', form: { action: 'add', name: 'Pickup' } });
  assert.match((await sam('/s/shopping/new')).text, /<option>Pickup<\/option>/);
  await katie('/settings/s/shopping', { method: 'POST', form: { defaultStore: 'Costco', tripGapMin: '60' } }); // alerts unticked = off
  await sam('/s/shopping/quick', { method: 'POST', form: { name: 'Paper towels' } });
  await withDb(app.uri, async () => assert.equal((await ShoppingItem.findOne({ name: 'Paper towels' }).lean()).store, 'Costco'));
  await sam('/s/shopping/start', { method: 'POST', form: { query: '', store: '' } });
  await new Promise((r) => setTimeout(r, 300));
  await withDb(app.uri, async () => assert.equal(await Activity.countDocuments({ text: /started/ }), 0, 'no trip alert when turned off'));
  assert.doesNotMatch((await sam('/s/shopping')).text, /Start shopping lets everyone else know/);
  const h1 = await home();
  assert.equal(h1.tripAlerts, false);
  assert.equal(h1.tripGapMin, 60);
  // Renaming a store keeps it as the default.
  await katie('/settings/lists/stores', { method: 'POST', form: { action: 'rename', value: 'Costco', name: 'Costco Plano' } });
  assert.equal((await home()).defaultStore, 'Costco Plano');
  assert.match((await katie('/activity')).text, /changed Shopping settings/);

  // ---------- Remember ----------
  await katie('/settings/s/remember', { method: 'POST', form: { remNotify: 'me', remCat: 'Car' } });
  page = await sam('/s/remember/new');
  assert.match(page.text, /value="me" checked/);
  assert.match(page.text, /<option selected>Car<\/option>/);

  // ---------- Calendar and Meals ----------
  await katie('/settings/s/calendar', { method: 'POST', form: { weekStart: '1', eventAlert: '120', eventAlertAllDay: '1440', eventCat: 'Family' } });
  page = await sam('/s/calendar');
  assert.ok(page.text.indexOf('>Mo<') < page.text.indexOf('>Su<'), 'weeks start Monday');
  page = await sam('/s/calendar/new');
  assert.match(page.text, /<option selected>Family<\/option>/);
  assert.match(page.text, /data-default-timed="120"/);
  assert.match(page.text, /data-default-allday="1440"/);
  await katie('/settings/s/meals', { method: 'POST', form: { weekStart: '1', mealSlot: 'Breakfast' } });
  assert.match((await sam('/s/meals/new')).text, /<option selected>Breakfast<\/option>/);
  const week = await sam('/s/meals');
  const firstDay = week.text.match(/id="d-(\d{4}-\d{2}-\d{2})"/)[1];
  assert.equal(new Date(`${firstDay}T00:00:00Z`).getUTCDay() === 1 || week.text.includes('Earlier this week'), true);

  // ---------- Pantry ----------
  await katie('/settings/s/pantry', { method: 'POST', form: { nameHave: 'Plenty', nameLow: 'Low', nameOut: 'Gone', pantryShop: 'out', pantrySoonDays: '7', pantryDefaultSpot: 'Fridge' } });
  page = await sam('/s/pantry');
  assert.match(page.text, /<option selected>Fridge<\/option>/);
  await sam('/s/pantry/quick', { method: 'POST', form: { name: 'Butter', spot: 'Fridge' } });
  const butter = await withDb(app.uri, async () => String((await PantryItem.findOne({ name: 'Butter' }).lean())._id));
  page = await sam('/s/pantry');
  assert.match(page.text, />Plenty<span/);
  assert.match(page.text, />Gone<span/);
  await sam(`/s/pantry/${butter}/status`, { method: 'POST', form: { status: 'low' } });
  await withDb(app.uri, async () => assert.equal(await ShoppingItem.countDocuments({ key: 'butter' }), 0, 'Low no longer adds'));
  await sam(`/s/pantry/${butter}/status`, { method: 'POST', form: { status: 'out' } });
  await withDb(app.uri, async () => assert.match((await ShoppingItem.findOne({ key: 'butter' }).lean()).note, /Pantry: Gone/));
  // "Expiring soon" now means within 7 days.
  await withDb(app.uri, async () => PantryItem.updateOne({ _id: butter }, { $set: { expires: addDays(today, 6), status: 'have' } }));
  assert.match((await sam('/s/pantry?show=soon')).text, /Butter/);

  // Reference photo on a pantry item.
  const raw = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: app.base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'sam@test.dev', password: PW }) });
  const sc = raw.headers.get('set-cookie').split(';')[0];
  const fd = new FormData();
  Object.entries({ name: 'Butter', spot: 'Fridge', status: 'have', autoShop: 'on' }).forEach(([k, v]) => fd.append(k, v));
  fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'butter.png');
  const up = await fetch(`${app.base}/s/pantry/${butter}`, { method: 'POST', redirect: 'manual', headers: { cookie: sc, origin: app.base }, body: fd });
  assert.equal(up.status, 302);
  const photoId = await withDb(app.uri, async () => String((await PantryItem.findById(butter).lean()).photoId));
  assert.match((await sam('/s/pantry')).text, new RegExp(`src="/files/${photoId}"`));
  assert.match((await sam(`/s/pantry/${butter}/edit`)).text, /Reference photo/);
  assert.equal((await sam(`/files/${photoId}`)).status, 200);
  // Remove it.
  const fd2 = new FormData();
  Object.entries({ name: 'Butter', spot: 'Fridge', status: 'have', removePhoto: 'on' }).forEach(([k, v]) => fd2.append(k, v));
  await fetch(`${app.base}/s/pantry/${butter}`, { method: 'POST', redirect: 'manual', headers: { cookie: sc, origin: app.base }, body: fd2 });
  await withDb(app.uri, async () => assert.equal((await PantryItem.findById(butter).lean()).photoId, null));

  // ---------- Bills ----------
  await katie('/settings/s/bills', { method: 'POST', form: { billSplit: 'none', currency: '€', billAheadDays: '7' } });
  page = await sam('/s/bills/new');
  assert.match(page.text, /value="none" selected/);
  await sam('/s/bills', { method: 'POST', form: [['name', 'Water'], ['amount', '40'], ['dueDate', today], ['repeat', 'monthly'], ['interval', '1'], ['splitMode', 'none']] });
  page = await sam('/s/bills');
  assert.match(page.text, /€40\.00/);
  await withDb(app.uri, async () => assert.equal(await Bill.countDocuments({ name: 'Water' }), 1, 'next month is more than a week away'));

  // ---------- Home info starting fields ----------
  await katie('/settings/s/info', { method: 'POST', form: [['type', 'Contacts'], ['fLabel', 'Phone'], ['fKind', 'phone'], ['fLabel', 'Hours'], ['fKind', 'text'], ['fLabel', ''], ['fKind', 'text']] });
  page = await sam('/s/info/new?type=Contacts');
  assert.match(page.text, /value="Hours"/);
  assert.doesNotMatch(page.text, /value="Email"/);
  assert.match((await katie('/settings/s/info')).text, /value="Hours"/);
  // Renaming a type keeps its fields.
  await katie('/settings/lists/infoTypes', { method: 'POST', form: { action: 'rename', value: 'Contacts', name: 'People we call' } });
  assert.match((await sam('/s/info/new?type=' + encodeURIComponent('People we call'))).text, /value="Hours"/);
});
