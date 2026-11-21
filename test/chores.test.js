// Chores: add, due days for repeating chores, done (late, early, twice), Today, points and rewards,
// view-only roles, and notifications for the assigned person or everyone.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startApp, startDatabase, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Membership = require('../models/Membership');
const Chore = require('../models/Chore');
const ChoreDone = require('../models/ChoreDone');
const RewardClaim = require('../models/RewardClaim');
const PushSubscription = require('../models/PushSubscription');
const NotifyLog = require('../models/NotifyLog');
const { tick } = require('../lib/notify');
const { addDays } = require('../lib/dates');

const PW = 'correct horse';
const QUICK = { 'x-requested-with': 'fetch' };

test('chores', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_chores',
    port: 3989,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const mia = await User.create({ householdId: home._id, email: 'mia@test.dev', name: 'Mia', passwordHash: hash });
      return { homeId: home.id, katieId: katie.id, miaId: mia.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const mia = await signIn('mia@test.dev');
  const { miaId, katieId } = app.seeded;
  // Mia is a Child: Chores is editable for that role.
  await katie(`/settings/household/members/${miaId}/role`, { method: 'POST', form: { role: 'child' } });

  // The section is real now, with rooms.
  let page = await katie('/s/chores');
  assert.equal(page.status, 200);
  assert.match(page.text, /No chores yet/);
  assert.match(page.text, />Kitchen</);

  // Add: a daily chore that started 3 days ago (late), one for Mia due today, one next week.
  let r = await katie('/s/chores', { method: 'POST', form: { title: 'Dishes', room: 'Kitchen', date: addDays(today, -3), repeat: 'daily' } });
  assert.equal(r.location, '/s/chores');
  await katie('/s/chores', { method: 'POST', form: { title: 'Feed The Cat', assignee: miaId, date: today } });
  await katie('/s/chores', { method: 'POST', form: { title: 'Mow', room: 'Yard', date: addDays(today, 7) } });
  r = await katie('/s/chores', { method: 'POST', form: { title: '', date: today } });
  assert.equal(r.status, 422);
  r = await katie('/s/chores', { method: 'POST', form: { title: 'X', date: today, repeat: 'daily', until: addDays(today, -1) } });
  assert.match(r.text, /Repeat until/);

  page = await katie('/s/chores');
  assert.match(page.text, /Overdue/);
  assert.match(page.text, /Dishes/);
  assert.match(page.text, /Later/);
  assert.match(page.text, /2 to do today/);
  // Mine: Katie sees anyone's chores and hers, not Mia's.
  page = await katie('/s/chores?who=me');
  assert.doesNotMatch(page.text, /Feed The Cat/);
  assert.match((await mia('/s/chores?who=me')).text, /Feed The Cat/i);
  // By room, and a room filter.
  page = await katie('/s/chores?group=room');
  assert.ok(page.text.indexOf('>Kitchen<', page.text.indexOf('data-list')) > 0);
  assert.doesNotMatch((await katie('/s/chores?room=Yard')).text, /Dishes/);

  const ids = await withDb(app.uri, async () => Object.fromEntries((await Chore.find().lean()).map((c) => [c.title, String(c._id)])));

  // Today shows Katie's due chores with a check, and the tile.
  page = await katie('/');
  assert.match(page.text, /Dishes/);
  assert.match(page.text, /Overdue since/);
  assert.match(page.text, /chores to do today|chore to do today/);
  assert.doesNotMatch(page.text, /Feed The Cat/);

  // Done late: counts for today, so it doesn't pile up; it's next due tomorrow.
  r = await katie(`/s/chores/${ids.Dishes}/done`, { method: 'POST', headers: QUICK, form: { due: addDays(today, -3) } });
  const undo = JSON.parse(r.text).undo;
  assert.match(undo.text, /Katie did Dishes/);
  await withDb(app.uri, async () => assert.equal((await ChoreDone.findOne({ choreId: ids.Dishes }).lean()).date, today));
  // A second tap (same due day) does nothing.
  r = await katie(`/s/chores/${ids.Dishes}/done`, { method: 'POST', headers: QUICK, form: { due: addDays(today, -3) } });
  assert.equal(JSON.parse(r.text).already, true);
  await withDb(app.uri, async () => assert.equal(await ChoreDone.countDocuments({ choreId: ids.Dishes }), 1));
  page = await katie('/s/chores');
  assert.match(page.text, /Due tomorrow/);
  assert.match(page.text, /Done this week/);
  // Undo puts it back.
  await katie(`/activity/${undo.id}/undo`, { method: 'POST', form: { back: '/s/chores' } });
  assert.match((await katie('/s/chores')).text, /Overdue since/);
  // From Today, it goes back to Today.
  r = await katie(`/s/chores/${ids.Dishes}/done`, { method: 'POST', form: { from: 'today' } });
  assert.equal(r.location, '/');

  // A one-off chore done early goes away.
  await katie(`/s/chores/${ids.Mow}/done`, { method: 'POST' });
  assert.doesNotMatch((await katie('/s/chores')).text, /Mark Mow done/);

  // Edit: rename and history.
  await katie(`/s/chores/${ids.Dishes}`, { method: 'POST', form: [['title', 'Load the dishwasher'], ['room', 'Kitchen'], ['date', addDays(today, -3)], ['repeat', 'weekly'], ['days', '1'], ['days', '4']] });
  page = await katie(`/s/chores/${ids.Dishes}/edit`);
  assert.match(page.text, /value="Load the dishwasher"/i);
  assert.match(page.text, /Recently done/);

  // Points: off by default.
  assert.doesNotMatch((await katie('/s/chores')).text, /Points and rewards/);
  assert.equal((await katie('/s/chores/points')).location, '/s/chores');
  // Turn on; Children and Teens earn by default. Add a reward.
  page = await katie('/settings/s/chores');
  assert.match(page.text, /Who earns points/);
  assert.match(page.text, /name="choreEarners" value="child" checked/);
  await katie('/settings/s/chores', { method: 'POST', form: [['chorePoints', 'on'], ['choreEarners', 'child'], ['choreEarners', 'teen']] });
  await katie('/settings/s/chores/rewards', { method: 'POST', form: { name: 'Pick dinner', cost: '5' } });
  await katie(`/s/chores/${ids['Feed The Cat']}`, { method: 'POST', form: { title: 'Feed The Cat', assignee: miaId, date: today, repeat: 'daily', points: '3' } });
  assert.match((await katie('/s/chores')).text, /3 pts/i);
  // Mia earns; Katie (admin) doesn't.
  await mia(`/s/chores/${ids['Feed The Cat']}/done`, { method: 'POST' });
  await withDb(app.uri, async () => assert.equal((await ChoreDone.findOne({ choreId: ids['Feed The Cat'] }).lean()).points, 3));
  page = await mia('/s/chores/points');
  assert.match(page.text, /You have 3 points/);
  assert.match(page.text, /Get it<span class="sr-only"> \(Pick dinner\)<\/span><\/button>|disabled>Get it/);
  const rid = await withDb(app.uri, async () => String((await Household.findOne().lean()).rewards[0]._id));
  // Not enough yet.
  await mia(`/s/chores/rewards/${rid}/claim`, { method: 'POST' });
  assert.match((await mia('/s/chores/points')).text, /needs 5 points/);
  // Two more days of feeding the cat: done early counts for the next day.
  await mia(`/s/chores/${ids['Feed The Cat']}/done`, { method: 'POST' });
  await withDb(app.uri, async () => assert.deepEqual((await ChoreDone.find({ choreId: ids['Feed The Cat'] }).sort({ date: 1 }).lean()).map((d) => d.date), [today, addDays(today, 1)]));
  await mia(`/s/chores/rewards/${rid}/claim`, { method: 'POST' });
  assert.match((await mia('/s/chores/points')).text, /You have 1 point\./);
  // Katie sees the request and says no: the points go back.
  page = await katie('/s/chores/points');
  assert.match(page.text, /Waiting for a yes/);
  const claimId = await withDb(app.uri, async () => String((await RewardClaim.findOne().lean())._id));
  assert.ok([303, 404].includes((await mia(`/s/chores/claims/${claimId}/give`, { method: 'POST' })).status), 'a Child can’t approve');
  await withDb(app.uri, async () => assert.equal((await RewardClaim.findById(claimId).lean()).status, 'asked'));
  await katie(`/s/chores/claims/${claimId}/decline`, { method: 'POST' });
  assert.match((await mia('/s/chores/points')).text, /You have 6 points/);
  // Remove a reward.
  await katie(`/settings/s/chores/rewards/${rid}/delete`, { method: 'POST' });
  assert.match((await katie('/s/chores/points')).text, /No rewards yet/);

  // View only: no check, no Add, and posting changes nothing.
  await katie('/settings/roles/child', { method: 'POST', form: { name: 'Child', s_chores: 'view', s_shopping: 'edit' } });
  page = await mia('/s/chores');
  assert.doesNotMatch(page.text, /Mark Feed The Cat done/);
  assert.doesNotMatch(page.text, /href="\/s\/chores\/new"/);
  await mia(`/s/chores/${ids['Feed The Cat']}/done`, { method: 'POST' });
  await withDb(app.uri, async () => assert.equal(await ChoreDone.countDocuments({ choreId: ids['Feed The Cat'] }), 2));

  // Delete, with undo kept in Activity.
  await katie(`/s/chores/${ids.Mow}/delete`, { method: 'POST' });
  await withDb(app.uri, async () => assert.equal(await Chore.exists({ _id: ids.Mow }), null));
  assert.match((await katie('/activity')).text, /deleted the chore Mow/);
  void katieId;
});

test('chore notifications', async (t) => {
  const db = await startDatabase('nestly_test_chores_notify');
  await mongoose.connect(db.uri);
  await mongoose.connection.db.dropDatabase();
  await NotifyLog.createIndexes();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  const home = await Household.create({ name: 'Home' });
  const hash = await User.hashPassword(PW);
  const tz = 'America/Chicago';
  const katie = await User.create({ householdId: home._id, email: 'k@t.dev', name: 'Katie', passwordHash: hash, timezone: tz });
  const mia = await User.create({ householdId: home._id, email: 'm@t.dev', name: 'Mia', passwordHash: hash, timezone: tz });
  await Membership.create({ userId: katie._id, householdId: home._id, role: 'admin' });
  await Membership.create({ userId: mia._id, householdId: home._id, role: 'child' });
  for (const u of [katie, mia]) await PushSubscription.create({ userId: u._id, endpoint: `https://push.test/${u.name}`, keys: { p256dh: 'p', auth: 'a' } });
  await Chore.create({ householdId: home._id, byName: 'Katie', title: 'Feed The Cat', assignee: mia._id, date: '2026-11-15', time: '17:00' });
  await Chore.create({ householdId: home._id, byName: 'Katie', title: 'Trash', date: '2026-11-15' });
  const run = async (when) => { const to = []; await tick(new Date(when), async (u, p) => { to.push(`${String(u) === katie.id ? 'Katie' : 'Mia'}: ${p.title}`); return 1; }); return to.sort(); };
  // Morning: "Trash" (anyone) to both.
  assert.deepEqual(await run('2026-11-15T08:00:00-06:00'), ['Katie: Trash', 'Mia: Trash']);
  // 5 PM: the cat, just to Mia.
  assert.deepEqual(await run('2026-11-15T17:00:00-06:00'), ['Mia: Feed The Cat']);
  // Katie takes out the trash. Next morning only the cat is still late.
  const trash = await Chore.findOne({ title: 'Trash' });
  await ChoreDone.create({ householdId: home._id, choreId: trash._id, title: 'Trash', userId: katie._id, byName: 'Katie', date: '2026-11-15' });
  assert.deepEqual(await run('2026-11-16T08:00:00-06:00'), ['Mia: Feed The Cat']);
  // Turned off: nothing.
  await User.updateOne({ _id: mia._id }, { $set: { 'notify.choresLate': false } });
  await NotifyLog.deleteMany({});
  assert.deepEqual(await run('2026-11-16T08:00:00-06:00'), []);
});
