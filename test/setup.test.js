// New-household guide: sections, people, staples, chores; skipping; and finishing later.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const CatalogItem = require('../models/CatalogItem');
const Chore = require('../models/Chore');

const PW = 'correct horse';

test('setup guide', async (t) => {
  const app = await startApp({
    name: 'nestly_test_setup',
    port: 4001,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      return {};
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');

  // Existing households aren't asked.
  assert.doesNotMatch((await katie('/')).text, /Finish setting up/);
  assert.equal((await sam('/setup')).status, 404, 'admins only');

  let r = await katie('/households', { method: 'POST', form: { name: 'Lake house' } });
  assert.equal(r.location, '/setup');
  let page = await katie('/setup');
  assert.match(page.text, /Step 1 of 4/);
  assert.match(page.text, /What will you use/);
  // Turn off Bills and Home info.
  await katie('/setup/sections', { method: 'POST', form: ['shopping', 'remember', 'calendar', 'meals', 'recipes', 'pantry', 'chores'].map((k) => ['sections', k]) });
  page = await katie('/setup');
  assert.match(page.text, /Step 2 of 4/);
  assert.match(page.text, /Who’s in Lake house/);
  await katie('/setup/people', { method: 'POST' });
  await katie('/setup/staples', { method: 'POST', form: { staples: 'Milk, Eggs\nBread\n\nmilk' } });
  page = await katie('/setup');
  assert.match(page.text, /Chores to start with/);
  r = await katie('/setup/chores', { method: 'POST', form: [['chores', 'Dishes'], ['chores', 'Laundry'], ['chores', 'Not a starter']] });
  assert.equal(r.location, '/');
  assert.match((await katie('/')).text, /Lake house is ready/);
  assert.doesNotMatch((await katie('/')).text, /Finish setting up/);
  await withDb(app.uri, async () => {
    const lake = await Household.findOne({ name: 'Lake house' }).lean();
    assert.equal(lake.features.bills, false);
    assert.equal(lake.setupStep, 0);
    assert.deepEqual((await CatalogItem.find({ householdId: lake._id, staple: true }).sort({ stapleOrder: 1 }).lean()).map((c) => c.name), ['Milk', 'Eggs', 'Bread']);
    assert.deepEqual((await Chore.find({ householdId: lake._id }).sort({ title: 1 }).lean()).map((c) => [c.title, c.repeat]), [['Dishes', 'daily'], ['Laundry', 'weekly']]);
  });

  // Finish later: Today offers it until it's done.
  await katie('/households', { method: 'POST', form: { name: 'Cabin' } });
  await katie('/setup/sections', { method: 'POST', form: [['sections', 'shopping']] });
  assert.match((await katie('/setup')).text, /Step 2 of 3/, 'no Chores step when Chores is off');
  assert.match((await katie('/')).text, /Finish setting up Cabin/);
  await katie('/setup/skip', { method: 'POST' });
  assert.doesNotMatch((await katie('/')).text, /Finish setting up/);
});
