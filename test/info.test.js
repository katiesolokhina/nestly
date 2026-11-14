// Home info: types, flexible fields, hidden values, Wi-Fi QR, files, privacy, and warranty alerts.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startApp, startDatabase, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const InfoItem = require('../models/InfoItem');
const Activity = require('../models/Activity');
const PushSubscription = require('../models/PushSubscription');
const NotifyLog = require('../models/NotifyLog');
const { addDays } = require('../lib/dates');
const { hrefFor, wifiQr, template } = require('../lib/info');
const { tick } = require('../lib/notify');

const PW = 'correct horse';

test('info helpers', async () => {
  assert.equal(hrefFor({ kind: 'phone', value: '(214) 555-0100' }), 'tel:2145550100');
  assert.equal(hrefFor({ kind: 'email', value: 'joe@plumb.example' }), 'mailto:joe@plumb.example');
  assert.equal(hrefFor({ kind: 'link', value: 'javascript:alert(1)' }), '');
  assert.match(hrefFor({ kind: 'address', value: '1 Main St' }), /maps\/search/);
  assert.equal(template('Appliances').find((f) => f.label === 'Warranty ends').kind, 'date');
  assert.deepEqual(template('My own type'), []);
  assert.match(await wifiQr({ fields: [{ label: 'Network', value: 'Home', kind: 'text' }, { label: 'Password', value: 'pw', kind: 'secret' }] }), /^<svg/);
  assert.equal(await wifiQr({ fields: [{ label: 'Phone', value: '1', kind: 'phone' }] }), null);
});

test('home info', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_info',
    port: 3986,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const other = await Household.create({ name: 'Other' });
      const hash = await User.hashPassword(PW);
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      await User.create({ householdId: other._id, email: 'out@test.dev', name: 'Out', role: 'admin', passwordHash: hash });
      return {};
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');
  const out = await signIn('out@test.dev');

  // Pick a type, get its fields.
  assert.match((await katie('/s/info/new')).text, /What are you adding/);
  let r = await katie('/s/info/new?type=' + encodeURIComponent('Wi-Fi & codes'));
  assert.match(r.text, /value="Network"/);
  assert.match(r.text, /value="Password"/);

  r = await katie('/s/info', { method: 'POST', form: [['title', 'Home Wi-Fi'], ['type', 'Wi-Fi & codes'], ['fLabel', 'Network'], ['fKind', 'text'], ['fValue', 'Solokhina-5G'], ['fLabel', 'Password'], ['fKind', 'secret'], ['fValue', 'sup3r-s3cret'], ['fLabel', 'Garage code'], ['fKind', 'secret'], ['fValue', '4821'], ['fLabel', ''], ['fKind', 'text'], ['fValue', '']] });
  assert.equal(r.status, 302);
  const wifiId = r.location.split('/').pop();
  const page = await sam(`/s/info/${wifiId}`);
  assert.match(page.text, /<details class="secret">/);
  assert.match(page.text, /QR code for guests/);
  assert.match(page.text, /<svg/);
  assert.match(page.text, /Solokhina-5G/);
  // Hidden values never show in the list, search, or the Activity text.
  const listPage = await sam('/s/info');
  assert.match(listPage.text, /Home Wi-Fi/);
  assert.doesNotMatch(listPage.text, /sup3r-s3cret|4821/);
  assert.doesNotMatch((await sam('/s/info?q=sup3r')).text, /Home Wi-Fi/);
  assert.match((await sam('/s/info?q=solokhina')).text, /Home Wi-Fi/);
  await withDb(app.uri, async () => assert.ok(!(await Activity.exists({ text: /sup3r|4821/ }))));
  assert.equal((await out(`/s/info/${wifiId}`)).status, 404);

  // Contacts are tappable.
  r = await katie('/s/info', { method: 'POST', form: [['title', 'Plumber'], ['type', 'Contacts'], ['fLabel', 'Phone'], ['fKind', 'phone'], ['fValue', '(214) 555-0100'], ['fLabel', 'Email'], ['fKind', 'email'], ['fValue', 'joe@plumb.example']] });
  const plumb = await sam(r.location);
  assert.match(plumb.text, /href="tel:2145550100"/);
  assert.match(plumb.text, /href="sms:2145550100"/);
  assert.match(plumb.text, /href="mailto:joe@plumb.example"/);

  // Appliance with a warranty date; a bad date is caught.
  r = await katie('/s/info', { method: 'POST', form: [['title', 'Fridge'], ['type', 'Appliances'], ['fLabel', 'Warranty ends'], ['fKind', 'date'], ['fValue', 'soon']] });
  assert.equal(r.status, 422);
  r = await katie('/s/info', { method: 'POST', form: [['title', 'Fridge'], ['type', 'Appliances'], ['fLabel', 'Model'], ['fKind', 'text'], ['fValue', 'RF28'], ['fLabel', 'Warranty ends'], ['fKind', 'date'], ['fValue', addDays(today, 20)]] });
  assert.match((await sam(r.location)).text, /Warranty ends in 20 days/);
  assert.match((await sam('/s/info?type=Appliances')).text, /Warranty ends in 20 days/);

  // Only me.
  r = await katie('/s/info', { method: 'POST', form: [['title', 'Bank login'], ['type', 'Wi-Fi & codes'], ['fLabel', 'PIN'], ['fKind', 'secret'], ['fValue', '9999'], ['private', 'on']] });
  const privId = r.location.split('/').pop();
  assert.equal((await sam(`/s/info/${privId}`)).status, 404);
  assert.doesNotMatch((await sam('/s/info')).text, /Bank login/);

  // Types are editable in Settings, and new ones start blank.
  await katie('/settings/lists/infoTypes', { method: 'POST', form: { action: 'add', name: 'Car' } });
  r = await katie('/s/info/new?type=Car');
  assert.match(r.text, /Add to Car/);
  assert.match((await katie('/s/info/new')).text, />Car</);

  // Edit keeps working; delete can be undone.
  await katie(`/s/info/${wifiId}`, { method: 'POST', form: [['title', 'Home Wi-Fi'], ['type', 'Wi-Fi & codes'], ['fLabel', 'Network'], ['fKind', 'text'], ['fValue', 'Solokhina-5G'], ['notes', 'Router is in the closet']] });
  assert.match((await sam(`/s/info/${wifiId}`)).text, /Router is in the closet/);
  await katie(`/s/info/${wifiId}/delete`, { method: 'POST' });
  const undo = (await katie('/s/info')).text.match(/\/activity\/([a-f0-9]{24})\/undo/);
  await katie(`/activity/${undo[1]}/undo`, { method: 'POST', form: { back: '/s/info' } });
  await withDb(app.uri, async () => assert.ok(await InfoItem.exists({ title: 'Home Wi-Fi' })));

  // Settings.
  await sam('/settings/notifications', { method: 'POST', form: { morning: '08:00', infoForm: '1', warranty: 'on', warrantyDays: '60' } });
  await withDb(app.uri, async () => assert.equal((await User.findOne({ name: 'Sam' }).lean()).notify.warrantyDays, 60));
  assert.match((await sam('/settings')).text, /Before an appliance warranty ends/);
});

test('warranty notifications', async (t) => {
  const db = await startDatabase('nestly_test_warranty');
  await mongoose.connect(db.uri);
  await mongoose.connection.db.dropDatabase();
  await NotifyLog.createIndexes();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  const at = (hhmm, day) => new Date(`${day}T${hhmm}:00-06:00`);
  const home = await Household.create({ name: 'Home' });
  const hash = await User.hashPassword(PW);
  const katie = await User.create({ householdId: home._id, email: 'k@t.dev', name: 'Katie', passwordHash: hash, timezone: 'America/Chicago' });
  const sam = await User.create({ householdId: home._id, email: 's@t.dev', name: 'Sam', passwordHash: hash, timezone: 'America/Chicago', notify: { warrantyDays: 7 } });
  for (const u of [katie, sam]) await PushSubscription.create({ userId: u._id, endpoint: `https://push.test/${u.name}`, keys: { p256dh: 'p', auth: 'a' } });
  await InfoItem.create({ householdId: home._id, byName: 'Katie', type: 'Appliances', title: 'Dishwasher', fields: [{ label: 'Warranty ends', kind: 'date', value: '2026-12-04' }] });
  const sent = [];
  const send = async (to, p) => { sent.push({ to: String(to), ...p }); return 1; };
  await tick(at('08:00', '2026-11-14'), send); // 20 days out: Katie (30 days) yes, Sam (7) no
  assert.deepEqual(sent.map((s) => s.to), [katie.id]);
  assert.equal(sent[0].body, 'The warranty ends in 20 days.');
  await tick(at('08:00', '2026-11-15'), send);
  assert.equal(sent.length, 1);
  await tick(at('08:00', '2026-11-28'), send); // 6 days out: Sam now
  assert.deepEqual(sent.map((s) => s.to), [katie.id, sam.id]);
});
