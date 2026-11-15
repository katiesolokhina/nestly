// Search: across sections, never other people's private items, never hidden Home info values,
// and nothing from sections the role hides.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');

const PW = 'correct horse';

test('search', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_search',
    port: 3995,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const sam = await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      return { samId: sam.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');
  await katie('/s/shopping', { method: 'POST', form: { name: 'Lemon juice' } });
  await katie('/s/remember', { method: 'POST', form: { text: 'Buy lemons for Mia', date: today } });
  await katie('/s/recipes', { method: 'POST', form: [['title', 'Fish tacos'], ['ingQty', '1'], ['ingName', 'lemon']] });
  await katie('/s/chores', { method: 'POST', form: { title: 'Clean lemon tree leaves', date: today } });
  await katie('/s/info', { method: 'POST', form: [['title', 'Garage'], ['type', 'Wi-Fi & codes'], ['fLabel', 'Code'], ['fKind', 'secret'], ['fValue', 'lemon123']] });
  await sam('/s/shopping', { method: 'POST', form: { name: 'Lemon cake (secret)', private: 'on' } });

  await katie('/'); // uses up the Undo bar from the last add
  let page = await katie('/search?q=lemon');
  assert.equal(page.status, 200);
  for (const s of ['Lemon juice', 'Buy lemons for Mia', 'Fish tacos', 'Uses lemon', 'Clean lemon tree leaves', 'Saved items']) assert.match(page.text, new RegExp(s));
  assert.doesNotMatch(page.text, /Garage/, 'hidden values aren’t searched');
  assert.doesNotMatch(page.text, /Lemon cake/, 'other people’s private items');
  assert.match((await sam('/search?q=lemon')).text, /Lemon cake/);
  assert.match((await katie('/search?q=((')).text, /Nothing matches/);
  assert.match((await katie('/search?q=a')).text, /at least 2 letters/);
  assert.match((await katie('/search?q=code')).text, /Garage/, 'labels are searched');

  // A role that hides Chores doesn't find chores.
  await katie(`/settings/household/members/${app.seeded.samId}/role`, { method: 'POST', form: { role: 'child' } });
  await katie('/settings/roles/child', { method: 'POST', form: { name: 'Child', s_chores: 'hidden', s_shopping: 'edit' } });
  assert.doesNotMatch((await sam('/search?q=lemon')).text, /lemon tree/);
});
