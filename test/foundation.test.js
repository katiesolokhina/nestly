// Sign-in, invites, resets, admin controls, sections, and separation between households.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { startApp, client, withDb, ROOT } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Activity = require('../models/Activity');

const linkIn = (html, kind) => (html.match(new RegExp(`value="https?://[^"/]+(/${kind}/[A-Za-z0-9_-]+)"`)) || [])[1];
const PW = 'correct horse';

test('foundation', async (t) => {
  const app = await startApp({
    name: 'nestly_test_foundation',
    port: 3993,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const other = await Household.create({ name: 'Other home' });
      const hash = await User.hashPassword(PW);
      const admin = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const outsider = await User.create({ householdId: other._id, email: 'other@test.dev', name: 'Other', role: 'admin', passwordHash: hash });
      await Activity.create({ householdId: home._id, actorId: admin._id, actorName: 'Katie', section: 'Shopping', text: 'Katie added a surprise gift', private: true });
      return { homeId: home.id, adminId: admin.id, outsiderId: outsider.id };
    },
  });
  t.after(() => app.stop());

  const admin = client(app.base);
  const sam = client(app.base);
  const stranger = client(app.base);
  const outsider = client(app.base);
  let invitePath, samId, resetPath;

  await t.test('pages need a session', async () => {
    assert.equal((await stranger('/')).location, '/login');
    assert.equal((await stranger('/settings')).location, '/login');
    assert.equal((await stranger('/activity')).location, '/login');
  });

  await t.test('sign-in gives the same message for a wrong password and an unknown email', async () => {
    const wrong = await stranger('/login', { method: 'POST', form: { email: 'katie@test.dev', password: 'nope' } });
    const unknown = await stranger('/login', { method: 'POST', form: { email: 'nobody@test.dev', password: 'nope' } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.match(wrong.text, /Email or password is incorrect/);
    assert.match(unknown.text, /Email or password is incorrect/);
  });

  await t.test('signing in opens Today with the bottom bar', async () => {
    const r = await admin('/login', { method: 'POST', form: { email: 'KATIE@test.dev', password: PW } });
    assert.equal(r.location, '/');
    const home = await admin('/');
    assert.match(home.text, /Katie/);
    for (const label of ['Today', 'Shopping', 'Calendar', 'More']) assert.match(home.text, new RegExp(`</svg>${label}</a>`));
    await outsider('/login', { method: 'POST', form: { email: 'other@test.dev', password: PW } });
  });

  await t.test('another site cannot post on your behalf', async () => {
    const r = await admin('/settings/appearance', { method: 'POST', form: { theme: 'dark' }, origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });

  await t.test('an invite link is shown once and joins the admin’s household', async () => {
    await admin('/settings/household/invites', { method: 'POST', form: { label: 'Sam' } });
    const first = await admin('/settings/people');
    invitePath = linkIn(first.text, 'invite');
    assert.ok(invitePath);
    assert.match(first.text, /Invite link for Sam/);
    const second = await admin('/settings/people');
    assert.equal(linkIn(second.text, 'invite'), undefined);
    assert.match(second.text, /Waiting to be used/);

    assert.equal((await sam(invitePath, { method: 'POST', form: { name: 'Sam', email: 'katie@test.dev', password: 'longenough', confirmPassword: 'longenough' } })).status, 422);
    assert.equal((await sam(invitePath, { method: 'POST', form: { name: 'Sam', email: 'sam@test.dev', password: 'short', confirmPassword: 'short' } })).status, 422);
    const ok = await sam(invitePath, { method: 'POST', form: { name: 'Sam', email: 'sam@test.dev', password: 'sam password', confirmPassword: 'sam password', timezone: 'America/New_York' } });
    assert.equal(ok.location, '/');
    const saved = await withDb(app.uri, () => User.findOne({ email: 'sam@test.dev' }).lean());
    assert.equal(String(saved.householdId), app.seeded.homeId);
    assert.equal(saved.role, 'member');
    samId = String(saved._id);
    assert.equal((await stranger(invitePath)).status, 410, 'used links are dead');
  });

  await t.test('members cannot reach admin pages or settings', async () => {
    assert.equal((await sam(`/settings/household/members/${app.seeded.adminId}`)).status, 404);
    assert.equal((await sam('/settings/household/invites', { method: 'POST', form: {} })).status, 404);
    assert.equal((await sam('/settings/sections', { method: 'POST', form: {} })).status, 404);
    const page = await sam('/settings/people');
    assert.doesNotMatch(page.text, /Create invite link/);
    assert.equal((await sam('/settings/sections')).status, 404);
    assert.equal((await sam('/settings/s/shopping')).status, 404);
    assert.doesNotMatch((await sam('/settings')).text, /\/settings\/s\//);
  });

  await t.test('admins cannot manage themselves or other households', async () => {
    assert.equal((await admin(`/settings/household/members/${app.seeded.adminId}`)).status, 404);
    assert.equal((await admin(`/settings/household/members/${app.seeded.outsiderId}`)).status, 404);
    assert.equal((await outsider(`/settings/household/members/${samId}`)).status, 404);
    assert.equal((await outsider(`/settings/household/members/${samId}/disable`, { method: 'POST', form: {} })).status, 404);
    assert.doesNotMatch((await outsider('/settings/people')).text, /sam@test\.dev/);
    assert.doesNotMatch((await outsider('/activity')).text, /Sam/);
  });

  await t.test('private activity is visible only to its author', async () => {
    assert.match((await admin('/activity')).text, /surprise gift/);
    assert.doesNotMatch((await sam('/activity')).text, /surprise gift/);
  });

  await t.test('a reset link works once, signs out other devices, and replaces older links', async () => {
    await admin(`/settings/household/members/${samId}/reset`, { method: 'POST', form: {} });
    const older = linkIn((await admin('/settings/people')).text, 'reset');
    await admin(`/settings/household/members/${samId}/reset`, { method: 'POST', form: {} });
    resetPath = linkIn((await admin('/settings/people')).text, 'reset');
    assert.equal((await stranger(older)).status, 410, 'only the newest link works');
    assert.match((await stranger(resetPath)).text, /sam@test\.dev/);
    const r = await stranger(resetPath, { method: 'POST', form: { password: 'brand new pass', confirmPassword: 'brand new pass' } });
    assert.equal(r.location, '/');
    assert.equal((await sam('/')).location, '/login', 'old session ended');
    assert.equal((await stranger(resetPath)).status, 410);
    assert.equal((await sam('/login', { method: 'POST', form: { email: 'sam@test.dev', password: 'brand new pass' } })).location, '/');
  });

  await t.test('changing your password signs out your other devices', async () => {
    const phone = client(app.base);
    await phone('/login', { method: 'POST', form: { email: 'sam@test.dev', password: 'brand new pass' } });
    assert.equal((await sam('/settings/password', { method: 'POST', form: { currentPassword: 'wrong', newPassword: 'another pass', confirmPassword: 'another pass' } })).status, 422);
    const r = await sam('/settings/password', { method: 'POST', form: { currentPassword: 'brand new pass', newPassword: 'another pass', confirmPassword: 'another pass' } });
    assert.equal(r.location, '/settings/account?saved=password');
    assert.equal((await sam('/')).status, 200);
    assert.equal((await phone('/')).location, '/login');
  });

  await t.test('turning a section off hides it everywhere and keeps pins intact', async () => {
    assert.equal((await sam('/s/shopping')).status, 200);
    const keep = [['sections', 'remember'], ['sections', 'calendar'], ['sections', 'meals'], ['sections', 'recipes'], ['sections', 'pantry'], ['sections', 'bills'], ['sections', 'chores'], ['sections', 'info']];
    await admin('/settings/sections', { method: 'POST', form: keep });
    assert.equal((await sam('/s/shopping')).status, 404);
    assert.doesNotMatch((await sam('/')).text, /<\/svg>Shopping<\/a>/);
    assert.doesNotMatch((await sam('/more')).text, /Shopping/);
    assert.match((await admin('/activity')).text, /turned Shopping off/);
    assert.equal((await sam('/s/made-up')).status, 404);
    await admin('/settings/sections', { method: 'POST', form: [...keep, ['sections', 'shopping']] });
    assert.equal((await sam('/s/shopping')).status, 200);
    const saved = await withDb(app.uri, () => require('../models/Membership').findOne({ userId: samId }).lean());
    assert.deepEqual(saved.pins, ['shopping', 'calendar']);
  });

  await t.test('the bottom bar holds three pins, and pinned sections leave More', async () => {
    const r = await sam('/settings/pins', { method: 'POST', form: [['pins', 'bills'], ['pins', 'chores'], ['pins', 'meals'], ['pins', 'pantry']] });
    assert.equal(r.location, '/settings/bottom-bar?saved=pinLimit');
    const home = await sam('/');
    for (const label of ['Bills', 'Chores', 'Meals']) assert.match(home.text, new RegExp(`</svg>${label}</a>`));
    assert.doesNotMatch(home.text, /<\/svg>Pantry<\/a>/);
    assert.doesNotMatch((await sam('/more')).text, /more-link[^\n]*Bills/);
    assert.match((await sam('/more')).text, /more-link[^\n]*Pantry/);
    assert.equal((await admin('/settings/pins', { method: 'POST', form: [['pins', 'made-up']] })).location, '/settings/bottom-bar?saved=pins');
  });

  await t.test('appearance is saved per person', async () => {
    await sam('/settings/appearance', { method: 'POST', form: { theme: 'dark' } });
    assert.match((await sam('/')).text, /data-theme="dark"/);
    assert.doesNotMatch((await admin('/')).text, /data-theme="dark"/);
  });

  await t.test('turning someone off signs them out, and role changes stick', async () => {
    await admin(`/settings/household/members/${samId}/role`, { method: 'POST', form: { role: 'admin' } });
    assert.equal((await withDb(app.uri, () => require('../models/Membership').findOne({ userId: samId }).lean())).role, 'admin');
    await admin(`/settings/household/members/${samId}/role`, { method: 'POST', form: { role: 'member' } });
    await admin(`/settings/household/members/${samId}/disable`, { method: 'POST', form: {} });
    assert.equal((await sam('/')).location, '/login');
    const denied = await sam('/login', { method: 'POST', form: { email: 'sam@test.dev', password: 'another pass' } });
    assert.equal(denied.status, 403);
    assert.match(denied.text, /turned off/);
    await admin(`/settings/household/members/${samId}/enable`, { method: 'POST', form: {} });
    assert.equal((await sam('/login', { method: 'POST', form: { email: 'sam@test.dev', password: 'another pass' } })).location, '/');
  });

  await t.test('deleting an account needs the email typed, and history keeps the name', async () => {
    const wrong = await admin(`/settings/household/members/${samId}/delete`, { method: 'POST', form: { confirmEmail: 'nope' } });
    assert.equal(wrong.status, 422);
    assert.equal((await admin(`/settings/household/members/${samId}/delete`, { method: 'POST', form: { confirmEmail: 'SAM@test.dev' } })).location, '/settings/people?saved=removed');
    assert.equal((await sam('/')).location, '/login');
    const page = await admin('/activity');
    assert.match(page.text, /Sam joined the household/);
    assert.match(page.text, /removed Sam from the household/);
    assert.equal(await withDb(app.uri, () => User.countDocuments({ email: 'sam@test.dev' })), 0, 'only household, so the account is gone');
  });

  await t.test('sign out and sign out of all devices', async () => {
    const tablet = client(app.base);
    await tablet('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });
    await admin('/settings/signout-all', { method: 'POST', form: {} });
    assert.equal((await admin('/')).location, '/login');
    assert.equal((await tablet('/')).location, '/login');
    await tablet('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });
    await tablet('/logout', { method: 'POST', form: {} });
    assert.equal((await tablet('/')).location, '/login');
  });

  await t.test('a locked-out admin can get back in with the server scripts', async () => {
    const env = { ...process.env, MONGODB_URI: app.uri, APP_ORIGIN: app.base, NESTLY_ADMIN_PASSWORD: 'first admin pass' };
    const made = spawnSync(process.execPath, ['scripts/create-household.js', '--household=New home', '--name=Ana', '--email=ana@test.dev'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const ana = client(app.base);
    const out = spawnSync(process.execPath, ['scripts/reset-link.js', '--email=ana@test.dev'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const resetUrl = new URL(out.stdout.split('\n').find((l) => l.includes('/reset/')));
    const r = await ana(resetUrl.pathname, { method: 'POST', form: { password: 'second admin pass', confirmPassword: 'second admin pass' } });
    assert.equal(r.location, '/');
    assert.equal((await ana('/')).status, 200, 'the reset link signed her in');
    assert.equal((await withDb(app.uri, async () => require('../models/Membership').findOne({ userId: (await User.findOne({ email: 'ana@test.dev' }).lean())._id }).lean())).role, 'admin');
  });
});
