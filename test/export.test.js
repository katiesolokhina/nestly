// Download data: admins only, includes their own private items but not other people's.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');

const PW = 'correct horse';

test('download household data', async (t) => {
  const app = await startApp({
    name: 'nestly_test_export',
    port: 3991,
    async seed() {
      const home = await Household.create({ name: 'Our Home' });
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
  await katie('/s/shopping', { method: 'POST', form: { name: 'Milk' } });
  await katie('/s/shopping', { method: 'POST', form: { name: 'My gift', private: 'on' } });
  await sam('/s/shopping', { method: 'POST', form: { name: 'Sam secret', private: 'on' } });
  await katie('/s/chores', { method: 'POST', form: { title: 'Dishes', date: '2026-11-15' } });

  assert.match((await katie('/settings')).text, /href="\/settings\/export"/);
  assert.doesNotMatch((await sam('/settings')).text, /href="\/settings\/export"/);
  assert.equal((await sam('/settings/export/download')).status, 404);

  const r = await katie('/settings/export/download');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="nestly-our-home-\d{4}-\d{2}-\d{2}\.json"/);
  const data = JSON.parse(r.text);
  assert.equal(data.household.name, 'Our Home');
  assert.deepEqual(data.people.map((p) => p.name).sort(), ['Katie', 'Sam']);
  const names = data.shopping.map((i) => i.name).sort();
  assert.deepEqual(names, ['Milk', 'My gift']);
  assert.equal(data.chores[0].title, 'Dishes');
  assert.ok(data.savedItems.some((i) => i.name === 'Milk'));
  assert.equal(data.shopping[0].householdId, undefined);
  assert.match((await katie('/activity')).text, /downloaded the household’s data/);
});
