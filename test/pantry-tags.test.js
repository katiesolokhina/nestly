// Pantry tags (several per item, filter by them, cravings match them) and Select mode's bulk changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const PantryItem = require('../models/PantryItem');
const Recipe = require('../models/Recipe');
const Activity = require('../models/Activity');

const PW = 'correct horse';

test('pantry tags and bulk edit', async (t) => {
  const app = await startApp({
    name: 'nestly_test_pantry_tags',
    port: 4031,
    async seed() {
      const home = await Household.create({ name: 'Home', setupStep: 0, pantrySpots: ['Pantry', 'Snacks', 'Fridge'] });
      const hash = await User.hashPassword(PW);
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const mia = await User.create({ householdId: home._id, email: 'mia@test.dev', name: 'Mia', passwordHash: hash });
      const k = { householdId: home._id, createdBy: katie._id, byName: 'Katie', status: 'have', batches: [{ count: 1, expires: '' }] };
      await PantryItem.create([
        { ...k, name: 'Gummy Bears', key: 'gummy bears', spot: 'Snacks' },
        { ...k, name: 'Chips', key: 'chips', spot: 'Snacks', tags: ['Snacks', 'Salty'] },
        { ...k, name: 'Flour', key: 'flour', spot: 'Pantry', tags: ['Baking'] },
      ]);
      await Recipe.create({ householdId: home._id, createdBy: katie._id, byName: 'Katie', title: 'Trail Mix', ingredients: [{ name: 'gummy bears' }, { name: 'peanuts' }] });
      return { miaId: mia.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const mia = await signIn('mia@test.dev');
  await katie(`/settings/household/members/${app.seeded.miaId}/role`, { method: 'POST', form: { role: 'child' } });
  const ids = await withDb(app.uri, async () => Object.fromEntries((await PantryItem.find().lean()).map((p) => [p.name, String(p._id)])));
  const get = (name) => withDb(app.uri, async () => PantryItem.findOne({ name }).lean());

  // The tag list starts with the usual ones, and the edit page offers them.
  let page = await katie(`/s/pantry/${ids['Gummy Bears']}/edit`);
  assert.match(page.text, /name="tags" value="Sweet"/);
  // Several tags on one item.
  const fd = new FormData();
  [['name', 'Gummy Bears'], ['spot', 'Snacks'], ['status', 'have'], ['bCount', '1'], ['bExpires', ''], ['tags', 'Sweet'], ['tags', 'Kids'], ['tags', 'Not a tag'], ['autoShop', 'on']].forEach(([k, v]) => fd.append(k, v));
  page = await katie(`/s/pantry/${ids['Gummy Bears']}`, { method: 'POST', formData: fd });
  assert.deepEqual((await get('Gummy Bears')).tags, ['Sweet', 'Kids']);

  // Filter by tags (every picked one).
  page = await katie('/s/pantry?tag=Snacks');
  assert.match(page.text, />Chips</);
  assert.doesNotMatch(page.text, />Gummy Bears</);
  page = await katie('/s/pantry?tag=Sweet&tag=Kids');
  assert.match(page.text, />Gummy Bears</);
  assert.doesNotMatch(page.text, />Chips</);
  assert.match(page.text, /class="tag lilac">Kids</);

  // Select mode and its changes.
  page = await katie('/s/pantry?select=1');
  assert.match(page.text, /action="\/s\/pantry\/bulk"/);
  assert.match(page.text, /value="tag\+:Kids"/);
  const both = [['ids', ids['Gummy Bears']], ['ids', ids.Chips]];
  await katie('/s/pantry/bulk', { method: 'POST', form: [...both, ['do', 'tag+:Snacks']] });
  assert.deepEqual((await get('Gummy Bears')).tags, ['Sweet', 'Kids', 'Snacks']);
  assert.deepEqual((await get('Chips')).tags, ['Snacks', 'Salty'], 'no doubles');
  await katie('/s/pantry/bulk', { method: 'POST', form: [...both, ['do', 'tag-:Snacks']] });
  assert.deepEqual((await get('Chips')).tags, ['Salty']);
  await katie('/s/pantry/bulk', { method: 'POST', form: [...both, ['do', 'move:Pantry']] });
  assert.equal((await get('Chips')).spot, 'Pantry');
  await katie('/s/pantry/bulk', { method: 'POST', form: [...both, ['do', 'status:low']] });
  assert.equal((await get('Gummy Bears')).status, 'low');
  await katie('/s/pantry/bulk', { method: 'POST', form: [...both, ['do', 'food:no']] });
  assert.equal((await get('Chips')).food, false);
  await katie('/s/pantry/bulk', { method: 'POST', form: [...both, ['do', 'shop:off']] });
  assert.equal((await get('Chips')).autoShop, false);
  // Nothing picked, or nothing to do: back to Select with a message.
  const r = await katie('/s/pantry/bulk', { method: 'POST', form: [...both, ['do', 'move:Nowhere']] });
  assert.match(r.location, /select=1/);

  // A Child (Pantry view only) can't do any of it.
  assert.doesNotMatch((await mia('/s/pantry')).text, /Select to change several/);
  await mia('/s/pantry/bulk', { method: 'POST', form: [...both, ['do', 'delete']] });
  assert.ok(await get('Chips'), 'still there');

  // A craving that names a tag finds what's at home with it, and recipes using it.
  await katie('/s/pantry/bulk', { method: 'POST', form: [...both, ['do', 'food:auto']] });
  page = await katie('/s/recipes/cook?craving=something+sweet');
  assert.match(page.text, /At home and sweet: Gummy Bears\./);
  assert.match(page.text, /Trail Mix/);
  // The Sweet mood does the same.
  assert.match((await katie('/s/recipes/cook?mood=Sweet&show=all')).text, /Trail Mix/);

  // Delete several at once; Activity can undo it.
  await katie('/s/pantry/bulk', { method: 'POST', form: [...both, ['do', 'delete']] });
  await withDb(app.uri, async () => {
    assert.equal(await PantryItem.countDocuments({ name: { $in: ['Gummy Bears', 'Chips'] } }), 0);
    assert.ok(await Activity.findOne({ text: /removed Chips, Gummy Bears from the pantry/ }));
  });
});
