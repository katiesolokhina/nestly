// Bills: splits, repeating bills, paying, paying back, balances, and bill notifications.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startApp, startDatabase, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Bill = require('../models/Bill');
const BillSeries = require('../models/BillSeries');
const PushSubscription = require('../models/PushSubscription');
const NotifyLog = require('../models/NotifyLog');
const { addDays } = require('../lib/dates');
const { balances, buildShares, nextDue, ensureUpcoming } = require('../lib/bills');
const { tick } = require('../lib/notify');

const PW = 'correct horse';

test('bill math', () => {
  const people = [{ _id: 'k', name: 'Katie' }, { _id: 's', name: 'Sam' }, { _id: 'm', name: 'Mia' }];
  assert.deepEqual(buildShares(10000, 'even', people).shares.map((s) => s.cents), [3334, 3333, 3333]);
  assert.deepEqual(buildShares(10000, 'percent', people.slice(0, 2), { percents: { k: 60, s: 40 } }).shares.map((s) => s.cents), [6000, 4000]);
  assert.match(buildShares(10000, 'percent', people.slice(0, 2), { percents: { k: 60, s: 30 } }).error, /90%/);
  assert.match(buildShares(10000, 'amount', people.slice(0, 2), { amounts: { k: 5000, s: 4000 } }).error, /\$90\.00/);
  assert.equal(nextDue({ repeat: 'monthly', interval: 1, startDate: '2026-01-31' }, '2026-01-31'), '2026-02-28');
  assert.equal(nextDue({ repeat: 'monthly', interval: 1, startDate: '2026-01-31' }, '2026-02-28'), '2026-03-31');
  assert.equal(nextDue({ repeat: 'monthly', interval: 3, startDate: '2026-11-15' }, '2026-11-15'), '2027-02-15');

  // Katie paid $100 split with Sam; Sam paid $30 split with Katie: Sam owes Katie $35, net.
  const bills = [
    { _id: 1, name: 'Internet', dueDate: '2026-11-01', paid: true, paidBy: 'k', paidByName: 'Katie', shares: [{ userId: 'k', name: 'Katie', cents: 5000, settled: true }, { userId: 's', name: 'Sam', cents: 5000, settled: false }] },
    { _id: 2, name: 'Water', dueDate: '2026-11-02', paid: true, paidBy: 's', paidByName: 'Sam', shares: [{ userId: 'k', name: 'Katie', cents: 1500, settled: false }, { userId: 's', name: 'Sam', cents: 1500, settled: true }] },
    { _id: 3, name: 'Gas', dueDate: '2026-11-03', paid: false, shares: [{ userId: 's', name: 'Sam', cents: 900, settled: false }] },
  ];
  const b = balances(bills);
  assert.equal(b.length, 1);
  assert.deepEqual([b[0].from.name, b[0].to.name, b[0].cents], ['Sam', 'Katie', 3500]);
});

test('bills', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_bills',
    port: 3988,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const other = await Household.create({ name: 'Other' });
      const hash = await User.hashPassword(PW);
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const sam = await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      await User.create({ householdId: other._id, email: 'out@test.dev', name: 'Out', role: 'admin', passwordHash: hash });
      return { katieId: katie.id, samId: sam.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');
  const out = await signIn('out@test.dev');
  const { katieId, samId } = app.seeded;

  // Form defaults: everyone picked, split evenly.
  let r = await katie('/s/bills/new');
  assert.match(r.text, new RegExp(`name="people" value="${samId}" checked`));
  r = await katie('/s/bills', { method: 'POST', form: [['name', 'Internet'], ['amount', 'abc'], ['dueDate', today], ['splitMode', 'even'], ['people', katieId], ['people', samId]] });
  assert.equal(r.status, 422);
  assert.match(r.text, /Enter the amount/);
  r = await katie('/s/bills', { method: 'POST', form: [['name', 'Internet'], ['amount', '80'], ['dueDate', today], ['splitMode', 'amount'], ['people', katieId], ['people', samId], [`amt_${katieId}`, '50'], [`amt_${samId}`, '20']] });
  assert.match(r.text, /add up to \$70\.00/);

  // A monthly bill, split evenly.
  r = await katie('/s/bills', { method: 'POST', form: [['name', 'Internet'], ['amount', '80.00'], ['dueDate', today], ['category', 'Internet & phone'], ['repeat', 'monthly'], ['interval', '1'], ['splitMode', 'even'], ['people', katieId], ['people', samId], ['link', 'https://isp.example.com/pay']] });
  assert.equal(r.status, 302);
  const billId = r.location.split('/').pop();
  await withDb(app.uri, async () => {
    const b = await Bill.findById(billId).lean();
    assert.equal(b.cents, 8000);
    assert.deepEqual(b.shares.map((s) => s.cents), [4000, 4000]);
    const s = await BillSeries.findById(b.seriesId).lean();
    assert.ok(s.next > today);
  });

  // The list makes next month's bill as it comes within a month, with the same amount.
  r = await sam('/s/bills');
  assert.match(r.text, /Internet/);
  assert.match(r.text, /Due today/);
  assert.match(r.text, /Your share \$40\.00/);
  await withDb(app.uri, async () => assert.equal(await Bill.countDocuments({ name: 'Internet' }), 2));
  assert.doesNotMatch((await out('/s/bills')).text, /\$80\.00/);
  assert.equal((await out(`/s/bills/${billId}`)).status, 404);

  // Today shows it.
  const home = await sam('/');
  assert.match(home.text, /Internet/);
  assert.match(home.text, /bills due this week/);

  // Katie pays it: Sam now owes Katie $40.
  r = await katie(`/s/bills/${billId}/paid`, { method: 'POST', form: { paidBy: katieId, paidOn: today } });
  assert.equal(r.status, 302);
  let page = await sam(`/s/bills/${billId}`);
  assert.match(page.text, /owes Katie/);
  assert.match(page.text, /Mark paid back/);
  assert.match((await sam('/s/bills')).text, /You owe Katie \$40\.00/);
  assert.match((await katie('/s/bills')).text, /Sam owes you \$40\.00/);
  assert.match((await katie('/s/bills?tab=paid')).text, /Paid .* by Katie/);

  // A utility bill paid by Sam, split 60/40 by percent: Katie owes Sam $30.
  r = await sam('/s/bills', { method: 'POST', form: [['name', 'Electric'], ['amount', '50'], ['dueDate', today], ['splitMode', 'percent'], ['people', katieId], ['people', samId], [`pct_${katieId}`, '60'], [`pct_${samId}`, '40']] });
  const elecId = r.location.split('/').pop();
  await sam(`/s/bills/${elecId}/paid`, { method: 'POST', form: { paidBy: samId, paidOn: today } });
  const bal = await katie('/s/bills/balances');
  assert.match(bal.text, /Sam owes you/);
  assert.match(bal.text, /\$10\.00/); // $40 - $30, netted

  // Sam marks his Internet share paid back; then settle up clears the rest.
  await sam(`/s/bills/${billId}/share`, { method: 'POST', form: { userId: samId, settled: '1' } });
  assert.match((await katie(`/s/bills/${billId}`)).text, /Paid back ✓/);
  assert.match((await katie('/s/bills/balances')).text, /You owe Sam/);
  r = await katie('/s/bills/settle', { method: 'POST', form: { from: katieId, to: samId } });
  assert.match((await katie('/s/bills/balances')).text, /Everyone’s square/);
  assert.match((await katie('/activity')).text, /settled up: Katie paid Sam \$30\.00/);
  assert.equal((await out('/s/bills/settle', { method: 'POST', form: { from: katieId, to: samId } })).status, 404);

  // Next month's Internet comes with the last amount; changing it carries forward.
  const nextBill = await withDb(app.uri, async () => Bill.findOne({ name: 'Internet', paid: false }).lean());
  const nextId = String(nextBill._id);
  page = await katie(`/s/bills/${nextId}/edit`);
  assert.match(page.text, /value="80\.00"/);
  assert.match(page.text, /Use these details for future bills too/);
  await katie(`/s/bills/${nextId}`, { method: 'POST', form: [['name', 'Internet'], ['amount', '85'], ['dueDate', nextBill.dueDate], ['repeat', 'monthly'], ['interval', '1'], ['splitMode', 'even'], ['people', katieId], ['people', samId], ['applyFuture', 'on']] });
  await withDb(app.uri, async () => assert.equal((await BillSeries.findOne({ name: 'Internet' }).lean()).cents, 8500));

  // Stop repeating.
  await katie(`/s/bills/${nextId}/stop`, { method: 'POST' });
  await withDb(app.uri, async () => assert.equal((await BillSeries.findOne({ name: 'Internet' }).lean()).active, false));

  // Private bills aren't split and others can't see them.
  r = await katie('/s/bills', { method: 'POST', form: [['name', 'Gym'], ['amount', '30'], ['dueDate', today], ['private', 'on'], ['splitMode', 'even'], ['people', katieId], ['people', samId]] });
  const gymId = r.location.split('/').pop();
  await withDb(app.uri, async () => assert.deepEqual((await Bill.findById(gymId).lean()).shares, []));
  assert.equal((await sam(`/s/bills/${gymId}`)).status, 404);

  // Delete and undo.
  await katie(`/s/bills/${elecId}/delete`, { method: 'POST' });
  const undo = (await sam('/activity')).text.match(/\/activity\/([a-f0-9]{24})\/undo/);
  assert.ok(undo);

  // Settings: each person picks bill notifications.
  await sam('/settings/notifications', { method: 'POST', form: { morning: '07:00', reminders: 'on', events: 'on', billsForm: '1', billsBefore: 'on', billsBeforeDays: '7', billsDue: 'on', billsWeekly: 'on' } });
  await withDb(app.uri, async () => {
    const u = await User.findById(samId).lean();
    assert.equal(u.notify.billsBeforeDays, 7);
    assert.equal(u.notify.billsOverdue, false);
    assert.equal(u.notify.billsWeekly, true);
  });
  assert.match((await sam('/settings/notifications')).text, /Sunday reminder of what I owe/);
});

test('bill notifications', async (t) => {
  const db = await startDatabase('nestly_test_bill_notify');
  await mongoose.connect(db.uri);
  await mongoose.connection.db.dropDatabase();
  await NotifyLog.createIndexes();
  await Bill.createIndexes();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  const at = (hhmm, day) => new Date(`${day}T${hhmm}:00-06:00`);

  const home = await Household.create({ name: 'Home' });
  const hash = await User.hashPassword(PW);
  const katie = await User.create({ householdId: home._id, email: 'k@t.dev', name: 'Katie', passwordHash: hash, timezone: 'America/Chicago' });
  const sam = await User.create({ householdId: home._id, email: 's@t.dev', name: 'Sam', passwordHash: hash, timezone: 'America/Chicago', notify: { morning: '09:00', billsBeforeDays: 1, billsOverdue: false, billsWeekly: true } });
  const mia = await User.create({ householdId: home._id, email: 'm@t.dev', name: 'Mia', passwordHash: hash, timezone: 'America/Chicago' });
  for (const u of [katie, sam, mia]) await PushSubscription.create({ userId: u._id, endpoint: `https://push.test/${u.name}`, keys: { p256dh: 'p', auth: 'a' } });

  const shares = buildShares(9000, 'even', [katie, sam]).shares;
  await Bill.create({ householdId: home._id, createdBy: katie._id, byName: 'Katie', name: 'Rent', cents: 9000, dueDate: '2026-11-20', shares });
  const sent = [];
  const send = async (to, p) => { sent.push({ to: String(to), ...p }); return 1; };
  const who = (re) => sent.filter((s) => re.test(s.body)).map((s) => s.to).sort();

  // Katie: 3 days before at 8:00 (defaults). Sam: 1 day before at 9:00. Mia doesn't share it.
  await tick(at('08:00', '2026-11-17'), send);
  assert.deepEqual(who(/^Due Fri/), [katie.id]);
  assert.match(sent[0].body, /\$90\.00 · Your share \$45\.00/);
  await tick(at('09:00', '2026-11-19'), send);
  assert.deepEqual(who(/^Due tomorrow/), [sam.id]);
  await tick(at('08:00', '2026-11-20'), send); // Katie's morning
  await tick(at('09:00', '2026-11-20'), send); // Sam's
  assert.deepEqual(who(/^Due today/), [katie.id, sam.id].sort());
  await tick(at('09:05', '2026-11-20'), send);
  assert.equal(who(/^Due today/).length, 2); // once each
  await tick(at('08:00', '2026-11-21'), send);
  await tick(at('09:00', '2026-11-21'), send);
  assert.deepEqual(who(/^Overdue/), [katie.id]); // Sam turned overdue off

  // Paid: no more due notifications.
  await Bill.updateOne({ name: 'Rent' }, { $set: { paid: true, paidBy: katie._id, paidByName: 'Katie', paidOn: '2026-11-21', 'shares.0.settled': true } });
  // Sunday at Sam's morning time: what Sam owes.
  const before = sent.length;
  await tick(at('09:00', '2026-11-22'), send);
  const weekly = sent.slice(before).filter((s) => s.title === 'What you owe');
  assert.deepEqual(weekly.map((s) => s.to), [sam.id]);
  assert.equal(weekly[0].body, 'Katie $45.00');

  // Repeating bills are made by the scheduler too, so their reminders still come.
  await BillSeries.create({ householdId: home._id, createdBy: katie._id, byName: 'Katie', name: 'Phone', cents: 6000, repeat: 'monthly', startDate: '2026-11-25', next: '2026-11-25', splitMode: 'none', plan: [] });
  await ensureUpcoming(home._id, '2026-11-25');
  assert.equal(await Bill.countDocuments({ name: 'Phone' }), 2); // Nov 25 and Dec 25
  await ensureUpcoming(home._id, '2026-11-25');
  assert.equal(await Bill.countDocuments({ name: 'Phone' }), 2);
});
