// Roles and permissions: starter roles, hidden/view/edit per section, the other permissions,
// custom roles, invites with a role, and notifications that respect roles.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startApp, startDatabase, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Membership = require('../models/Membership');
const ShoppingItem = require('../models/ShoppingItem');
const Reminder = require('../models/Reminder');
const PushSubscription = require('../models/PushSubscription');
const NotifyLog = require('../models/NotifyLog');
const { tick } = require('../lib/notify');

const PW = 'correct horse';

test('roles and permissions', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_roles',
    port: 3983,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const sam = await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      return { homeId: home.id, katieId: katie.id, samId: sam.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');
  const { samId } = app.seeded;

  // Starter roles.
  let page = await katie('/settings/roles');
  for (const r of ['Admin', 'Member', 'Teen', 'Child']) assert.match(page.text, new RegExp(`>${r}<`));
  assert.match((await katie('/settings/people')).text, /sam@test\.dev · Member/);
  assert.equal((await sam('/settings/roles')).status, 404, 'only admins manage roles');

  // Sam becomes a Child: Bills and Home info hidden, Calendar view only, Shopping editable.
  await katie(`/settings/household/members/${samId}/role`, { method: 'POST', form: { role: 'child' } });
  assert.match((await katie('/settings/people')).text, /sam@test\.dev · Child/);
  assert.equal((await sam('/s/bills')).status, 404);
  assert.equal((await sam('/s/info')).status, 404);
  assert.doesNotMatch((await sam('/more')).text, />Bills</);
  assert.doesNotMatch((await sam('/')).text, /bills due this week/);
  page = await sam('/s/calendar');
  assert.equal(page.status, 200);
  let r = await sam('/s/calendar', { method: 'POST', form: { title: 'Sneaky', date: today } });
  assert.equal(r.location, '/s/calendar');
  assert.match((await sam('/s/calendar')).text, /can look at Calendar but not change it/);
  assert.match((await sam('/s/recipes')).text, /Recipes/);
  assert.doesNotMatch((await sam('/s/recipes')).text, /href="\/s\/recipes\/new"/, 'no Add when view only');
  // Shopping is editable, but Child can't use "Only me".
  assert.doesNotMatch((await sam('/s/shopping/new')).text, /name="private"/);
  await sam('/s/shopping', { method: 'POST', form: { name: 'Juice', qty: '1', private: 'on' } });
  await withDb(app.uri, async () => assert.equal((await ShoppingItem.findOne({ name: 'Juice' }).lean()).private, false));
  // No Activity for Child.
  assert.equal((await sam('/activity')).status, 404);
  assert.doesNotMatch((await sam('/more')).text, />Activity</);

  // Change Child: Bills view, Activity on, may change settings.
  page = await katie('/settings/roles/child');
  assert.match(page.text, /name="s_bills" value="hidden" checked/);
  await katie('/settings/roles/child', { method: 'POST', form: { name: 'Kid', s_bills: 'view', s_calendar: 'view', s_shopping: 'edit', s_info: 'hidden', activity: 'on', settings: 'on' } });
  assert.equal((await sam('/s/bills')).status, 200);
  assert.doesNotMatch((await sam('/s/bills')).text, /href="\/s\/bills\/new"/);
  assert.equal((await sam('/activity')).status, 200);
  // Activity leaves out sections the role hides.
  assert.doesNotMatch((await sam('/activity')).text, /<option[^>]*>Home info</);
  // Settings for sections they can edit, not ones they only view.
  assert.equal((await sam('/settings/s/shopping')).status, 200);
  assert.equal((await sam('/settings/s/bills')).status, 404);
  assert.match((await sam('/s/shopping')).text, /settings\/s\/shopping\?from=section/);
  assert.match((await katie('/settings/people')).text, /sam@test\.dev · Kid/, 'renamed role');
  // Can't name a role Admin.
  await katie('/settings/roles/child', { method: 'POST', form: { name: 'admin' } });
  assert.match((await katie('/settings/roles/child')).text, /value="Kid"/);

  // Invites: a role with the invite permission can invite, but never as admin.
  assert.doesNotMatch((await sam('/settings/people')).text, /Create invite link/);
  await katie('/settings/roles/member', { method: 'POST', form: { name: 'Member', invite: 'on', activity: 'on', private: 'on' } });
  await katie(`/settings/household/members/${samId}/role`, { method: 'POST', form: { role: 'member' } });
  page = await sam('/settings/people');
  assert.match(page.text, /Create invite link/);
  assert.doesNotMatch(page.text, /name="role"/, 'only admins pick the role');
  await sam('/settings/household/invites', { method: 'POST', form: { label: 'Gran', role: 'admin' } });
  // Admin invites a child.
  await katie('/settings/household/invites', { method: 'POST', form: { label: 'Mia', role: 'child' } });
  const invite = new URL((await katie('/settings/people')).text.match(/https?:\/\/[^"<\s]+\/invite\/[\w-]+/)[0]);
  const mia = client(app.base);
  await mia(invite.pathname, { method: 'POST', form: { name: 'Mia', email: 'mia@test.dev', password: 'mia password', confirmPassword: 'mia password' } });
  await withDb(app.uri, async () => {
    const u = await User.findOne({ email: 'mia@test.dev' }).lean();
    assert.equal((await Membership.findOne({ userId: u._id }).lean()).role, 'child');
    const grans = await require('../models/AccessToken').find({ label: 'Gran' }).lean();
    assert.equal(grans[0].role, 'member', 'invite permission never grants admin');
  });
  assert.equal((await mia('/s/info')).status, 404);

  // Custom roles: added as a copy, can't be deleted while someone has it.
  r = await katie('/settings/roles', { method: 'POST', form: { name: 'Babysitter' } });
  const key = r.location.split('/').pop();
  assert.match((await katie(r.location)).text, /value="Babysitter"/);
  const miaId = await withDb(app.uri, async () => String((await User.findOne({ email: 'mia@test.dev' }).lean())._id));
  await katie(`/settings/household/members/${miaId}/role`, { method: 'POST', form: { role: key } });
  await katie(`/settings/roles/${key}/delete`, { method: 'POST' });
  assert.match((await katie('/settings/roles')).text, /1 person has the Babysitter role/);
  await katie(`/settings/household/members/${miaId}/role`, { method: 'POST', form: { role: 'child' } });
  await katie(`/settings/roles/${key}/delete`, { method: 'POST' });
  assert.match((await katie('/settings/roles')).text, /Babysitter deleted/);
  // A made-up role can't be assigned.
  await katie(`/settings/household/members/${miaId}/role`, { method: 'POST', form: { role: 'superuser' } });
  await withDb(app.uri, async () => assert.equal((await Membership.findOne({ userId: miaId }).lean()).role, 'child'));
});

test('notifications respect roles', async (t) => {
  const db = await startDatabase('nestly_test_roles_notify');
  await mongoose.connect(db.uri);
  await mongoose.connection.db.dropDatabase();
  await NotifyLog.createIndexes();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  const home = await Household.create({ name: 'Home' });
  // Child can't see Remember in this household.
  home.roles = home.roles.map((r) => (r.key === 'child' ? { ...r.toObject(), sections: { ...r.toObject().sections, remember: 'hidden' } } : r));
  await home.save();
  const hash = await User.hashPassword(PW);
  const katie = await User.create({ householdId: home._id, email: 'k@t.dev', name: 'Katie', passwordHash: hash, timezone: 'America/Chicago' });
  const kid = await User.create({ householdId: home._id, email: 'c@t.dev', name: 'Kid', passwordHash: hash, timezone: 'America/Chicago' });
  await Membership.create({ userId: katie._id, householdId: home._id, role: 'admin' });
  await Membership.create({ userId: kid._id, householdId: home._id, role: 'child' });
  for (const u of [katie, kid]) await PushSubscription.create({ userId: u._id, endpoint: `https://push.test/${u.name}`, keys: { p256dh: 'p', auth: 'a' } });
  await Reminder.create({ householdId: home._id, createdBy: katie._id, byName: 'Katie', text: 'Trash', date: '2026-11-15', time: '09:00' });
  const to = [];
  await tick(new Date('2026-11-15T09:00:00-06:00'), async (u) => { to.push(String(u)); return 1; });
  assert.deepEqual(to, [katie.id]);
});
