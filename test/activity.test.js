// Activity by week, CSV download, clearing a date range, and clearing old activity automatically.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Activity = require('../models/Activity');
const { addDays } = require('../lib/dates');
const { pruneActivity } = require('../lib/housekeeping');

const PW = 'correct horse';

test('activity by week', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_activity',
    port: 4005,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      const k = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash, timezone: 'America/Chicago' });
      await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000);
      await Activity.insertMany([
        { householdId: home._id, actorId: k._id, actorName: 'Katie', section: 'Shopping', text: 'Katie added "Milk", fresh', createdAt: at(0) },
        { householdId: home._id, actorId: k._id, actorName: 'Katie', section: 'Shopping', text: '=HYPERLINK("x")', createdAt: at(10) },
        { householdId: home._id, actorId: k._id, actorName: 'Katie', section: 'Bills', text: 'Katie paid rent', createdAt: at(40) },
        { householdId: home._id, actorId: k._id, actorName: 'Katie', section: 'Bills', text: 'Katie paid water', createdAt: at(400) },
      ]);
      return {};
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');

  let page = await katie('/activity');
  assert.match(page.text, /This week/);
  assert.match(page.text, /Katie added &#34;Milk&#34;, fresh|Katie added "Milk", fresh/);
  assert.doesNotMatch(page.text, /paid rent/, 'only this week');
  assert.match(page.text, /Download or clear/);
  // Earlier weeks.
  page = await katie(`/activity?week=${addDays(today, -10)}`);
  assert.match(page.text, /HYPERLINK/);
  assert.doesNotMatch(page.text, /Milk/);
  // Members see the log, not the tools.
  assert.doesNotMatch((await sam('/activity')).text, /Download or clear/);
  assert.equal((await sam('/activity/download')).status, 404);
  assert.equal((await sam('/activity/clear', { method: 'POST', form: { from: today, to: today } })).status, 404);

  // CSV: a range, and everything; formulas are neutralized.
  let r = await katie(`/activity/download?from=${addDays(today, -14)}&to=${today}`);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.text, /Date,Time,Who,Section,What/);
  assert.match(r.text, /"Katie added ""Milk"", fresh"/);
  assert.match(r.text, /"'=HYPERLINK\(""x""\)"/);
  assert.doesNotMatch(r.text, /paid rent/);
  r = await katie('/activity/download');
  assert.match(r.text, /paid water/);

  // Clear a range.
  r = await katie('/activity/clear', { method: 'POST', form: { from: addDays(today, -45), to: addDays(today, -5) } });
  assert.match((await katie('/activity')).text, /Cleared 2 entries/);
  await withDb(app.uri, async () => {
    assert.equal(await Activity.countDocuments({ text: /paid rent|HYPERLINK/ }), 0);
    assert.equal(await Activity.countDocuments({ text: /paid water|Milk/ }), 2);
  });
  assert.equal((await katie('/activity/clear', { method: 'POST', form: { from: today, to: addDays(today, -3) } })).location, '/activity#tools');

  // Auto-clear: off by default; turning it on clears older entries.
  page = await katie('/settings/activity');
  assert.match(page.text, /<option value="0" selected>Never/);
  assert.equal((await sam('/settings/activity')).status, 404);
  await katie('/settings/activity', { method: 'POST', form: { keepMonths: '6' } });
  await withDb(app.uri, async () => {
    assert.equal(await Activity.countDocuments({ text: /paid water/ }), 0);
    assert.equal(await Activity.countDocuments({ text: /Milk/ }), 1);
    await Activity.create({ householdId: (await Household.findOne())._id, actorName: 'Old', section: 'Bills', text: 'old one', createdAt: new Date(Date.now() - 300 * 86400000) });
    assert.equal(await pruneActivity(), 1);
  });
  assert.match((await katie('/settings')).text, /href="\/settings\/activity"/);
});
