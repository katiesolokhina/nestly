// Notifications: when reminders and events notify, who gets them, and the settings and routes behind them.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startApp, startDatabase, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Reminder = require('../models/Reminder');
const Event = require('../models/Event');
const PushSubscription = require('../models/PushSubscription');
const NotifyLog = require('../models/NotifyLog');
const { tick, localNow, isDue, reminderAt, eventAlerts } = require('../lib/notify');
const alerts = require('../lib/alerts');

const PW = 'correct horse';
const CHICAGO = 'America/Chicago';
// Sat Nov 14 2026, 9:00 AM in Chicago (CST, UTC-6).
const at = (hhmm, day = '2026-11-14') => new Date(`${day}T${hhmm}:00-06:00`);

test('notify timing', () => {
  assert.deepEqual(localNow(CHICAGO, at('09:05')), { today: '2026-11-14', min: 545 });
  const user = { notify: { morning: '08:00' } };

  // A reminder with no time uses the morning time; with a time, its own.
  assert.deepEqual(reminderAt({ date: '2026-11-14', time: '' }, user), { date: '2026-11-14', min: 480 });
  assert.deepEqual(reminderAt({ date: '2026-11-14', time: '17:30' }, user), { date: '2026-11-14', min: 1050 });
  assert.equal(reminderAt({ date: '', time: '' }, user), null);

  // Due inside the hour after, not before, not hours later.
  const now = { today: '2026-11-14', min: 8 * 60 + 30 };
  assert.ok(isDue({ date: '2026-11-14', min: 480 }, now));
  assert.ok(!isDue({ date: '2026-11-14', min: 540 }, now));
  assert.ok(!isDue({ date: '2026-11-14', min: 400 }, now));
  // Just after midnight still catches an 11:45 PM alert from yesterday.
  assert.ok(isDue({ date: '2026-11-13', min: 23 * 60 + 45 }, { today: '2026-11-14', min: 10 }));

  // Lead times come from the event alone. Old events saved as 'default' get 1 hour / morning of.
  assert.equal(alerts.lead({ time: '10:00', alert: 'default' }), 60);
  assert.equal(alerts.lead({ time: '', alert: 'default' }), 0);
  assert.equal(alerts.lead({ time: '10:00', alert: '120' }), 120);
  assert.equal(alerts.lead({ time: '10:00', alert: 'none' }), null);
  assert.equal(alerts.lead({ time: '', alert: '60' }), 0); // all day: whole days only
  assert.equal(alerts.lead({ time: '', alert: '2880' }), 2880);
  assert.equal(alerts.alertText({ time: '10:00', alert: '120' }), '2 hours before');
  assert.equal(alerts.alertText({ time: '10:00', alert: '90' }), '1 hour 30 minutes before');
  assert.equal(alerts.alertText({ time: '10:00', alert: '0' }), 'At start time');
  assert.equal(alerts.alertText({ time: '', alert: '2880' }), 'Morning, 2 days before');
  assert.equal(alerts.alertText({ time: '', alert: '10080' }), 'Morning, 1 week before');
  assert.deepEqual(alerts.picked({ time: '10:00', alert: '90' }), { value: 'custom', amount: '90', unit: 'minutes' });
  assert.deepEqual(alerts.picked({ time: '10:00', alert: '240' }), { value: 'custom', amount: '4', unit: 'hours' });
  assert.deepEqual(alerts.readAlert({ alert: 'custom', alertAmount: '4', alertUnit: 'hours' }, false), { alert: '240' });
  assert.deepEqual(alerts.readAlert({ alert: 'custom', alertAmount: '3', alertUnit: 'days' }, true), { alert: '4320' });
  assert.ok(alerts.readAlert({ alert: 'custom', alertAmount: 'x', alertUnit: 'hours' }, false).error);
  assert.ok(alerts.readAlert({ alert: 'custom', alertAmount: '9', alertUnit: 'weeks' }, false).error);

  // A 9:30 AM event with a 1-day lead alerts at 9:30 the day before.
  const e = { date: '2026-11-15', time: '09:30', alert: '1440', repeat: 'none' };
  assert.deepEqual(eventAlerts(e, user, '2026-11-14'), [{ start: '2026-11-15', lead: 1440, at: { date: '2026-11-14', min: 570 } }]);
  // A 12:10 AM event 15 minutes ahead alerts at 11:55 PM the night before.
  const early = { date: '2026-11-15', time: '00:10', alert: '15', repeat: 'none' };
  assert.deepEqual(eventAlerts(early, user, '2026-11-14')[0].at, { date: '2026-11-14', min: 23 * 60 + 55 });
  // All day, day before: the morning before.
  const allDay = { date: '2026-11-15', time: '', alert: '1440', repeat: 'none' };
  assert.deepEqual(eventAlerts(allDay, user, '2026-11-14')[0].at, { date: '2026-11-14', min: 480 });
  // Two hours ahead, and a week ahead for an all-day event.
  assert.deepEqual(eventAlerts({ date: '2026-11-14', time: '13:00', alert: '120', repeat: 'none' }, user, '2026-11-14')[0].at, { date: '2026-11-14', min: 660 });
  const trip = { date: '2026-11-21', time: '', alert: '10080', repeat: 'none' };
  assert.deepEqual(eventAlerts(trip, user, '2026-11-14').map((a) => a.at), [{ date: '2026-11-14', min: 480 }]);
  // A weekly event alerts for this week's occurrence.
  const weekly = { date: '2026-11-07', time: '10:00', alert: '60', repeat: 'weekly', days: [6], interval: 1 };
  assert.deepEqual(eventAlerts(weekly, user, '2026-11-14').map((a) => a.start), ['2026-11-14']);
});

test('notify tick', async (t) => {
  const db = await startDatabase('nestly_test_notify_tick');
  await mongoose.connect(db.uri);
  await mongoose.connection.db.dropDatabase();
  await NotifyLog.createIndexes(); // rebuilt after the drop, so "send once" is enforced
  await PushSubscription.init();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });

  const home = await Household.create({ name: 'Home' });
  const other = await Household.create({ name: 'Other' });
  const hash = await User.hashPassword(PW);
  const mk = (h, email, name, notify = {}) => User.create({ householdId: h._id, email, name, passwordHash: hash, timezone: CHICAGO, notify });
  const katie = await mk(home, 'k@t.dev', 'Katie');
  const sam = await mk(home, 's@t.dev', 'Sam', { morning: '09:00' });
  const mia = await mk(home, 'm@t.dev', 'Mia', { reminders: false, events: false });
  const out = await mk(other, 'o@t.dev', 'Out');
  const sub = (u, n) => PushSubscription.create({ userId: u._id, endpoint: `https://push.test/${n}`, keys: { p256dh: 'p', auth: 'a' } });
  await Promise.all([sub(katie, 1), sub(sam, 2), sub(mia, 3), sub(out, 4)]);

  const base = { householdId: home._id, createdBy: katie._id, byName: 'Katie' };
  await Reminder.create({ ...base, text: 'Trash day', date: '2026-11-14' });
  const timed = await Reminder.create({ ...base, text: 'Call vet', date: '2026-11-14', time: '17:00', notify: 'some', notifyTo: [sam._id] });
  await Reminder.create({ ...base, text: 'Gift', date: '2026-11-14', private: true, notify: 'me' });
  await Reminder.create({ ...base, text: 'Quiet', date: '2026-11-14', notify: 'none' });
  await Reminder.create({ ...base, text: 'Done', date: '2026-11-14', done: true });
  await Reminder.create({ householdId: other._id, createdBy: out._id, byName: 'Out', text: 'Elsewhere', date: '2026-11-14' });
  const dentist = await Event.create({ ...base, title: 'Dentist', date: '2026-11-14', time: '10:00', location: 'Main St', alert: 'default' });

  const sent = [];
  const send = async (userId, payload) => { sent.push({ to: String(userId), ...payload }); return 1; };
  const to = (title) => sent.filter((s) => s.title === title).map((s) => s.to).sort();

  // 8:00 AM: Katie's morning reminders. Sam's morning is 9:00. Mia turned reminders off.
  await tick(at('08:00'), send);
  assert.deepEqual(to('Trash day'), [katie.id]);
  assert.deepEqual(to('Gift'), [katie.id]);
  assert.deepEqual(to('Quiet'), []);
  assert.deepEqual(to('Done'), []);
  assert.deepEqual(to('Elsewhere'), [out.id]); // only its own household
  assert.deepEqual(to('Call vet'), []);

  // 9:00 AM: Sam's morning, plus the dentist an hour ahead for both people with events on.
  await tick(at('09:00'), send);
  assert.deepEqual(to('Trash day'), [katie.id, sam.id].sort());
  assert.deepEqual(to('Dentist'), [katie.id, sam.id].sort());
  assert.equal(sent.find((s) => s.title === 'Dentist').body, 'Today at 10:00 AM · Main St');
  const link = new URL(sent.find((s) => s.title === 'Dentist').url, 'http://x');
  assert.equal(link.pathname, `/h/${home._id}`); // opens the right household first
  assert.equal(link.searchParams.get('next'), `/s/calendar/${dentist._id}?day=2026-11-14`);

  // Ticking again sends nothing new.
  const before = sent.length;
  await tick(at('09:01'), send);
  assert.equal(sent.length, before);

  // 5:00 PM: the timed reminder, only to the person chosen.
  await tick(at('17:00'), send);
  assert.deepEqual(to('Call vet'), [sam.id]);

  // Editing the time makes a new notification.
  await Reminder.updateOne({ _id: timed._id }, { $set: { time: '18:00' } });
  await tick(at('18:00'), send);
  assert.equal(to('Call vet').length, 2);

  // Missed by more than an hour: skipped, not sent late.
  await Reminder.create({ ...base, text: 'Late one', date: '2026-11-14', time: '12:00' });
  await tick(at('18:30'), send);
  assert.deepEqual(to('Late one'), []);

  // Nobody with a device: nothing to do.
  await PushSubscription.deleteMany({});
  assert.equal(await tick(at('20:00'), send), 0);
});

test('notify routes', async (t) => {
  const app = await startApp({
    name: 'nestly_test_notify_routes',
    port: 3992,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const sam = await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      return { katieId: katie.id, samId: sam.id };
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  const r = await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });
  assert.equal(r.status, 302);
  const raw = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: app.base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'katie@test.dev', password: PW }) });
  const kc = raw.headers.get('set-cookie').split(';')[0];

  // Without VAPID keys, push is off but nothing breaks.
  assert.equal((await katie('/api/push/key')).status, 503);
  const page = await katie('/settings/notifications');
  assert.match(page.text, /Turn on notifications/);
  assert.match(page.text, /Morning time/);

  // Subscriptions are validated and saved to whoever is signed in.
  const bad = await fetch(`${app.base}/api/push/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', origin: app.base, cookie: kc }, body: '{}' });
  assert.equal(bad.status, 400);

  // Notification settings save.
  const saved = await katie('/settings/notifications', { method: 'POST', form: { morning: '07:15', reminders: 'on', events: 'on' } });
  assert.equal(saved.status, 302);
  await withDb(app.uri, async () => {
    const u = await User.findById(app.seeded.katieId).lean();
    assert.equal(u.notify.morning, '07:15');
    assert.equal(u.notify.shopping, false);
  });

  // A reminder with a time and chosen people.
  const add = await katie('/s/remember', { method: 'POST', form: [['text', 'Call vet'], ['date', '2026-11-20'], ['time', '17:00'], ['category', 'Errands'], ['notify', 'some'], ['notifyTo', app.seeded.samId]] });
  assert.equal(add.status, 302);
  // Only me forces "just me", and a time without a date is caught.
  await katie('/s/remember', { method: 'POST', form: [['text', 'Gift'], ['date', '2026-11-20'], ['notify', 'all'], ['private', 'on'], ['category', 'Errands']] });
  const noDate = await katie('/s/remember', { method: 'POST', form: [['text', 'Oops'], ['time', '10:00'], ['category', 'Errands']] });
  assert.equal(noDate.status, 422);
  assert.match(noDate.text, /Add a date/);
  await withDb(app.uri, async () => {
    const vet = await Reminder.findOne({ text: 'Call vet' }).lean();
    assert.equal(vet.time, '17:00');
    assert.equal(vet.notify, 'some');
    assert.deepEqual(vet.notifyTo.map(String), [app.seeded.samId]);
    assert.equal((await Reminder.findOne({ text: 'Gift' }).lean()).notify, 'me');
  });
  const list = await katie('/s/remember');
  assert.match(list.text, /at 5:00 PM/);
  const form = await katie('/s/remember/new');
  assert.match(form.text, /Choose people/);
  assert.match(form.text, /Sam/);

  // Events keep their Notify choice and show it.
  const ev = await fetch(`${app.base}/s/calendar`, {
    method: 'POST', redirect: 'manual', headers: { cookie: kc, origin: app.base },
    body: (() => { const f = new FormData(); Object.entries({ title: 'Dentist', date: '2026-11-20', time: '10:00', alert: 'custom', alertAmount: '2', alertUnit: 'hours', repeat: 'none', category: 'Uncategorized' }).forEach(([k, v]) => f.append(k, v)); return f; })(),
  });
  assert.equal(ev.status, 302);
  await withDb(app.uri, async () => assert.equal((await Event.findOne({ title: 'Dentist' }).lean()).alert, '120'));
  const id = await withDb(app.uri, async () => String((await Event.findOne({ title: 'Dentist' }).lean())._id));
  assert.match((await katie(`/s/calendar/${id}`)).text, /Notify: 2 hours before/);

  // Start shopping opens shopping mode and logs the trip once per half hour.
  const start = await katie('/s/shopping/start', { method: 'POST', form: { query: 'store=Costco', store: 'Costco' } });
  assert.equal(start.status, 302);
  assert.equal(start.location, '/s/shopping?store=Costco&mode=shop');
  await new Promise((res) => setTimeout(res, 300));
  await katie('/s/shopping/start', { method: 'POST', form: { query: '', store: '' } });
  await new Promise((res) => setTimeout(res, 300));
  const activity = await katie('/activity');
  assert.equal((activity.text.match(/started shopping at Costco/g) || []).length, 1);
  assert.doesNotMatch(activity.text, /started out shopping/);
});

test('reminder page and snooze', async (t) => {
  const app = await startApp({
    name: 'nestly_test_snooze',
    port: 3991,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const r = await Reminder.create({ householdId: home._id, createdBy: katie._id, byName: 'Katie', text: 'Call vet', details: 'Ask about shots', date: '2026-11-14', time: '14:14' });
      return { reminderId: r.id, katieId: katie.id };
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });
  const raw = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: app.base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'katie@test.dev', password: PW }) });
  const kc = raw.headers.get('set-cookie').split(';')[0];
  const id = app.seeded.reminderId;

  const page = await katie(`/s/remember/${id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Ask about shots/);
  assert.match(page.text, />Done</);
  assert.match(page.text, /Tomorrow morning \(8:00 AM\)/);
  assert.match(page.text, /Everyone/);

  // The list and Today open the reminder page, not the edit form.
  assert.match((await katie('/s/remember')).text, new RegExp(`href="/s/remember/${id}"`));

  // Snooze 30 minutes: saved for Katie only, shown on the page, no Activity entry.
  const before = Date.now();
  const s = await katie(`/s/remember/${id}/snooze`, { method: 'POST', form: { minutes: '30' } });
  assert.equal(s.location, `/s/remember/${id}`);
  await withDb(app.uri, async () => {
    const r = await Reminder.findById(id).lean();
    assert.equal(r.snoozes.length, 1);
    assert.equal(String(r.snoozes[0].userId), app.seeded.katieId);
    const mins = (r.snoozes[0].until - before) / 60000;
    assert.ok(mins > 29.9 && mins < 30.5);
  });
  assert.match((await katie(`/s/remember/${id}`)).text, /Snoozed until/);
  assert.doesNotMatch((await katie('/activity')).text, /snooze/i);

  // Snoozing again replaces it; bad numbers are ignored.
  await katie(`/s/remember/${id}/snooze`, { method: 'POST', form: { minutes: 'morning' } });
  await katie(`/s/remember/${id}/snooze`, { method: 'POST', form: { minutes: '-5' } });
  await withDb(app.uri, async () => {
    const r = await Reminder.findById(id).lean();
    assert.equal(r.snoozes.length, 1);
    assert.ok(r.snoozes[0].until - Date.now() > 60 * 60000);
  });

  // The notification buttons: snooze 30 minutes, then done, as JSON.
  const api = (action) => fetch(`${app.base}/api/remember/${id}/${action}`, { method: 'POST', redirect: 'manual', headers: { cookie: kc, origin: app.base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await api('nope')).status, 404);
  assert.equal((await api('snooze')).status, 200);
  await withDb(app.uri, async () => {
    const mins = ((await Reminder.findById(id).lean()).snoozes[0].until - Date.now()) / 60000;
    assert.ok(mins > 29 && mins <= 30);
  });
  // Signed out, the button gets sent to sign in, so the app opens the page instead.
  assert.equal((await fetch(`${app.base}/api/remember/${id}/done`, { method: 'POST', redirect: 'manual', headers: { origin: app.base } })).status, 302);

  // Done from the reminder page.
  const done = await katie(`/s/remember/${id}/done`, { method: 'POST', form: { from: 'view' } });
  assert.equal(done.location, '/s/remember');
});

test('snoozed reminders notify the snoozer again', async (t) => {
  const db = await startDatabase('nestly_test_snooze_tick');
  await mongoose.connect(db.uri);
  await mongoose.connection.db.dropDatabase();
  await NotifyLog.createIndexes(); // rebuilt after the drop, so "send once" is enforced
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  const home = await Household.create({ name: 'Home' });
  const hash = await User.hashPassword(PW);
  const katie = await User.create({ householdId: home._id, email: 'k@t.dev', name: 'Katie', passwordHash: hash, timezone: CHICAGO });
  const sam = await User.create({ householdId: home._id, email: 's@t.dev', name: 'Sam', passwordHash: hash, timezone: CHICAGO });
  await PushSubscription.create({ userId: katie._id, endpoint: 'https://push.test/k', keys: { p256dh: 'p', auth: 'a' } });
  await PushSubscription.create({ userId: sam._id, endpoint: 'https://push.test/s', keys: { p256dh: 'p', auth: 'a' } });
  // An old reminder (outside the usual date window), snoozed by Katie until 3:00 PM.
  await Reminder.create({ householdId: home._id, createdBy: katie._id, byName: 'Katie', text: 'Old one', date: '2026-11-01', snoozes: [{ userId: katie._id, until: at('15:00') }] });
  const sent = [];
  const send = async (userId, p) => { sent.push({ to: String(userId), ...p }); return 1; };
  await tick(at('14:59'), send);
  assert.equal(sent.length, 0);
  await tick(at('15:00'), send);
  await tick(at('15:01'), send);
  assert.deepEqual(sent.map((s) => s.to), [katie.id]);
  assert.equal(sent[0].url.endsWith('/edit'), false);
});
