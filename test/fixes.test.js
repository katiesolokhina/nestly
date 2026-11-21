// Double saves, friendly error pages, renaming a household, and bought dates in the pantry.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Chore = require('../models/Chore');
const PantryItem = require('../models/PantryItem');
const ShoppingItem = require('../models/ShoppingItem');

const PW = 'correct horse';

test('fixes', async (t) => {
  const app = await startApp({
    name: 'nestly_test_fixes',
    port: 4011,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      await User.create({ householdId: home._id, email: 'naum@test.dev', name: 'Naum', passwordHash: hash });
      return { homeId: home.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const naum = await signIn('naum@test.dev');
  const today = localToday();

  // Every page loads the form guard.
  assert.match((await naum('/s/chores/new')).text, /<script src="\/js\/forms\.js" defer>/);
  // The same form sent three times at once (same token) saves once; all three land on the same page.
  const form = { title: 'Water plants', repeat: 'none', date: today, _once: 'tok-123' };
  const sent = await Promise.all([1, 2, 3].map(() => naum('/s/chores', { method: 'POST', form })));
  await withDb(app.uri, async () => assert.equal(await Chore.countDocuments({ title: /Water Plants/i }), 1));
  assert.ok(sent.every((r) => r.status === 302 || r.status === 303));
  assert.equal(new Set(sent.map((r) => r.location)).size, 1);
  // A new token is a new save.
  await naum('/s/chores', { method: 'POST', form: { ...form, _once: 'tok-456' } });
  await withDb(app.uri, async () => assert.equal(await Chore.countDocuments({ title: /Water Plants/i }), 2));

  // Not found: a page for people, plain text for scripts.
  let r = await naum('/s/chores/0123456789abcdef01234567', { headers: { accept: 'text/html' } });
  assert.equal(r.status, 404);
  assert.match(r.text, /We can’t find that/);
  assert.match(r.text, /Go to Today/);
  r = await naum('/no-such-page', { headers: { accept: 'application/json' } });
  assert.equal(r.text, 'Not found');
  assert.match((await naum('/maintenance.html')).text, /getting an update/);

  // Household name: admins only.
  assert.match((await katie('/settings/people')).text, /action="\/settings\/household\/name"/);
  assert.doesNotMatch((await naum('/settings/people')).text, /action="\/settings\/household\/name"/);
  await naum('/settings/household/name', { method: 'POST', form: { name: 'Hacked' } });
  await katie('/settings/household/name', { method: 'POST', form: { name: 'Solokhin Home' } });
  await withDb(app.uri, async () => assert.equal((await Household.findById(app.seeded.homeId).lean()).name, 'Solokhin Home'));

  // Bought dates: Skip from Put away uses the day it was bought; the add page fills it in.
  const shop = await withDb(app.uri, async () => String((await ShoppingItem.create({ householdId: app.seeded.homeId, byName: 'Katie', name: 'Milk', key: 'milk', bought: true, boughtAt: new Date(Date.now() - 2 * 86400000), putAway: 'pending' }))._id));
  r = await katie(`/s/pantry/add?from=${shop}`);
  assert.match(r.text, /name="bought" type="date" value="\d{4}-\d{2}-\d{2}"/);
  await katie(`/s/pantry/putaway/${shop}/skip`, { method: 'POST' });
  await withDb(app.uri, async () => {
    const milk = await PantryItem.findOne({ key: 'milk' }).lean();
    assert.ok(milk.batches[0].bought && milk.batches[0].bought < today, 'two days ago');
  });
  await katie('/s/pantry/add', { method: 'POST', form: { name: 'Eggs', count: '12', bought: '2020-01-05' } });
  await withDb(app.uri, async () => assert.equal((await PantryItem.findOne({ key: 'eggs' }).lean()).batches[0].bought, '2020-01-05'));
  const eggs = await withDb(app.uri, async () => String((await PantryItem.findOne({ key: 'eggs' }))._id));
  assert.match((await katie(`/s/pantry/${eggs}/edit`)).text, /name="bBought" type="date" value="2020-01-05"/);
  // The bought date can be changed or cleared on the item.
  await katie(`/s/pantry/${eggs}`, { method: 'POST', form: [['name', 'Eggs'], ['status', 'have'], ['spot', 'Pantry'], ['bCount', '12'], ['bExpires', ''], ['bBought', ''], ['bCount', ''], ['bExpires', ''], ['bBought', today]] });
  await withDb(app.uri, async () => assert.deepEqual((await PantryItem.findById(eggs).lean()).batches.map((b) => [b.count, b.bought]), [[12, '']]));
});
