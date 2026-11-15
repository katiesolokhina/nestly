// One sign-in, several households: starting, switching, inviting existing accounts,
// per-household roles and access, leaving, and notifications from every household.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startApp, startDatabase, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Membership = require('../models/Membership');
const ShoppingItem = require('../models/ShoppingItem');
const Reminder = require('../models/Reminder');
const PushSubscription = require('../models/PushSubscription');
const NotifyLog = require('../models/NotifyLog');
const { tick } = require('../lib/notify');

const PW = 'correct horse';

test('households', async (t) => {
  const app = await startApp({
    name: 'nestly_test_households',
    port: 3985,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const mias = await Household.create({ name: 'Mia’s place' });
      const hash = await User.hashPassword(PW);
      // Made the old way (role on the account): the server sets up their memberships at startup.
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const sam = await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      const mia = await User.create({ householdId: mias._id, email: 'mia@test.dev', name: 'Mia', role: 'admin', passwordHash: hash });
      return { homeId: home.id, katieId: katie.id, samId: sam.id, miaId: mia.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');
  const mia = await signIn('mia@test.dev');
  const { homeId, samId, miaId } = app.seeded;

  // Older accounts were moved over with their roles.
  await withDb(app.uri, async () => {
    assert.equal((await Membership.findOne({ userId: app.seeded.katieId }).lean()).role, 'admin');
    assert.equal((await Membership.findOne({ userId: samId }).lean()).role, 'member');
  });
  assert.doesNotMatch((await katie('/')).text, /home-chip/); // one household: no switcher

  // Start a second household: Katie is its admin and it opens.
  let r = await katie('/households', { method: 'POST', form: { name: 'Lake house' } });
  assert.equal(r.location, '/setup');
  let page = await katie('/settings');
  assert.match(page.text, /Lake house/);
  assert.match((await katie('/settings/people')).text, /Create invite link/);
  const lakeId = await withDb(app.uri, async () => String((await Household.findOne({ name: 'Lake house' }).lean())._id));
  assert.match((await katie('/')).text, /home-chip[^>]*>Lake house/);

  // Each household has its own data.
  await katie('/s/shopping/quick', { method: 'POST', form: { name: 'Firewood' } });
  assert.match((await katie('/s/shopping')).text, /Firewood/);
  await katie('/households/switch', { method: 'POST', form: { id: homeId } });
  assert.doesNotMatch((await katie('/s/shopping')).text, /Firewood/);
  assert.doesNotMatch((await sam('/s/shopping')).text, /Firewood/);
  // Can't switch into a household you're not in.
  assert.equal((await katie('/households/switch', { method: 'POST', form: { id: String(new mongoose.Types.ObjectId()) } })).status, 404);

  // Invite Sam, who already has an account, to the lake house.
  await katie(`/h/${lakeId}?next=/settings`);
  await katie('/settings/household/invites', { method: 'POST', form: { label: 'Sam' } });
  const inviteUrl = new URL((await katie('/settings/people')).text.match(/https?:\/\/[^"<\s]+\/invite\/[\w-]+/)[0]);
  page = await sam(inviteUrl.pathname);
  assert.match(page.text, /Join Lake house/);
  assert.match(page.text, /signed in as Sam/);
  r = await sam(`${inviteUrl.pathname}/join`, { method: 'POST' });
  assert.equal(r.location, '/');
  assert.match((await sam('/')).text, /home-chip[^>]*>Lake house/);
  assert.match((await sam('/s/shopping')).text, /Firewood/);
  // The link was used up.
  assert.equal((await mia(inviteUrl.pathname)).status, 410);

  // Signed out with an existing email: told to sign in, then the link picks up after sign-in.
  await katie('/settings/household/invites', { method: 'POST', form: { label: 'Mia' } });
  const invite2 = new URL((await katie('/settings/people')).text.match(/https?:\/\/[^"<\s]+\/invite\/[\w-]+/)[0]);
  const fresh = client(app.base);
  r = await fresh(invite2.pathname, { method: 'POST', form: { name: 'Mia', email: 'mia@test.dev', password: 'whatever123', confirmPassword: 'whatever123' } });
  assert.equal(r.status, 422);
  assert.match(r.text, /already has a Nestly account/);
  await fresh(`${invite2.pathname}/signin`);
  r = await fresh('/login', { method: 'POST', form: { email: 'mia@test.dev', password: PW } });
  assert.equal(r.location, invite2.pathname);
  await fresh(`${invite2.pathname}/join`, { method: 'POST' });

  // Roles are per household.
  await katie(`/settings/household/members/${samId}/role`, { method: 'POST', form: { role: 'admin' } });
  await withDb(app.uri, async () => {
    assert.equal((await Membership.findOne({ userId: samId, householdId: lakeId }).lean()).role, 'admin');
    assert.equal((await Membership.findOne({ userId: samId, householdId: homeId }).lean()).role, 'member');
  });
  await katie(`/settings/household/members/${samId}/role`, { method: 'POST', form: { role: 'member' } });

  // Password resets: Katie runs both of Sam's households, but not Mia's own.
  assert.match((await katie(`/settings/household/members/${samId}`)).text, /Create a one-time reset link/);
  page = await katie(`/settings/household/members/${miaId}`);
  assert.match(page.text, /only they can change their password/);
  assert.equal((await katie(`/settings/household/members/${miaId}/reset`, { method: 'POST' })).status, 403);

  // Turned off in the lake house: Sam still has Home, and lake links don't open it.
  await katie(`/settings/household/members/${samId}/disable`, { method: 'POST' });
  r = await sam('/');
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /home-chip/);
  await sam(`/h/${lakeId}?next=/s/shopping`);
  assert.doesNotMatch((await sam('/s/shopping')).text, /Firewood/);
  await katie(`/settings/household/members/${samId}/enable`, { method: 'POST' });

  // Removing Sam from the lake house keeps his account and Home.
  await katie(`/settings/household/members/${samId}/delete`, { method: 'POST', form: { confirmEmail: 'sam@test.dev' } });
  await withDb(app.uri, async () => {
    assert.ok(await User.exists({ _id: samId }));
    assert.equal(await Membership.countDocuments({ userId: samId }), 1);
  });
  assert.equal((await sam('/')).status, 200);

  // Notification links only redirect within Nestly.
  assert.equal((await katie(`/h/${homeId}?next=//evil.example`)).location, '/');
  assert.equal((await katie(`/h/${homeId}?next=/s/shopping`)).location, '/s/shopping');

  // Leaving: Mia can leave the lake house; Katie, its only admin, can't.
  page = await mia('/households');
  assert.match(page.text, /Leave Lake house/);
  await mia(`/households/${lakeId}/leave`, { method: 'POST' });
  await withDb(app.uri, async () => assert.equal(await Membership.countDocuments({ userId: miaId }), 1));
  r = await katie(`/households/${lakeId}/leave`, { method: 'POST' });
  await withDb(app.uri, async () => assert.equal(await Membership.countDocuments({ userId: app.seeded.katieId }), 2));
  // You can't leave your only household.
  r = await sam(`/households/${homeId}/leave`, { method: 'POST' });
  assert.match((await sam('/households')).text, /only household/);

  // The bottom bar is set per household.
  await katie(`/h/${homeId}?next=/`);
  await katie('/settings/pins', { method: 'POST', form: [['pins', 'remember']] });
  await withDb(app.uri, async () => {
    assert.deepEqual((await Membership.findOne({ userId: app.seeded.katieId, householdId: homeId }).lean()).pins, ['remember']);
    assert.deepEqual((await Membership.findOne({ userId: app.seeded.katieId, householdId: lakeId }).lean()).pins, ['shopping', 'calendar']);
  });

  // Deleting: blocked while others are in it, and for members; works once you're alone.
  // Someone still in it, even turned off, blocks it.
  await withDb(app.uri, async () => Membership.create({ userId: samId, householdId: lakeId, disabled: true }));
  page = await katie(`/households/${lakeId}/delete`);
  assert.match(page.text, /1 other person is still in Lake house/);
  assert.equal((await katie(`/households/${lakeId}/delete`, { method: 'POST', form: { confirmName: 'Lake house' } })).status, 409);
  await withDb(app.uri, async () => Membership.deleteMany({ householdId: lakeId, userId: { $ne: app.seeded.katieId } }));
  r = await katie(`/households/${lakeId}/delete`, { method: 'POST', form: { confirmName: 'lake house' } });
  assert.equal(r.status, 422);
  r = await katie(`/households/${lakeId}/delete`, { method: 'POST', form: { confirmName: 'Lake house' } });
  assert.equal(r.location, '/households');
  await withDb(app.uri, async () => {
    assert.equal(await Household.countDocuments({ _id: lakeId }), 0);
    assert.equal(await ShoppingItem.countDocuments({ householdId: lakeId }), 0);
    assert.equal(await Membership.countDocuments({ householdId: lakeId }), 0);
  });
  assert.equal((await katie('/')).status, 200); // landed in Home
  // Your only household can't be deleted.
  assert.match((await sam(`/households/${homeId}/delete`)).text, /Only an admin|only household|still in/);
  r = await katie(`/households/${homeId}/delete`, { method: 'POST', form: { confirmName: 'Home' } });
  assert.equal(r.status, 409);

  // The server script adds an existing account as admin of a new household.
  const { spawnSync } = require('node:child_process');
  const made = spawnSync(process.execPath, ['scripts/create-household.js', '--household=Office', '--name=Sam', '--email=sam@test.dev'], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, MONGODB_URI: app.uri }, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  assert.match((await sam('/households')).text, /Office/);
});

test('notifications from every household', async (t) => {
  const db = await startDatabase('nestly_test_households_notify');
  await mongoose.connect(db.uri);
  await mongoose.connection.db.dropDatabase();
  await NotifyLog.createIndexes();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  const home = await Household.create({ name: 'Home' });
  const lake = await Household.create({ name: 'Lake house' });
  const hash = await User.hashPassword(PW);
  const katie = await User.create({ householdId: home._id, email: 'k@t.dev', name: 'Katie', passwordHash: hash, timezone: 'America/Chicago' });
  await Membership.create({ userId: katie._id, householdId: home._id, role: 'admin' });
  await Membership.create({ userId: katie._id, householdId: lake._id, role: 'member' });
  await PushSubscription.create({ userId: katie._id, endpoint: 'https://push.test/k', keys: { p256dh: 'p', auth: 'a' } });
  await Reminder.create({ householdId: home._id, createdBy: katie._id, byName: 'Katie', text: 'Trash', date: '2026-11-15', time: '09:00' });
  await Reminder.create({ householdId: lake._id, createdBy: katie._id, byName: 'Katie', text: 'Close the dock', date: '2026-11-15', time: '09:00' });
  const sent = [];
  await tick(new Date('2026-11-15T09:00:00-06:00'), async (to, p) => { sent.push(p); return 1; });
  assert.deepEqual(sent.map((s) => s.title).sort(), ['Home: Trash', 'Lake house: Close the dock']);
  assert.ok(sent.find((s) => s.title === 'Lake house: Close the dock').url.startsWith(`/h/${lake._id}?next=`));
});
