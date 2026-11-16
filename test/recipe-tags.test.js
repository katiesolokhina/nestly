// Recipe tags (editable list), ingredient type and prep, shopping names, and import splitting.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Recipe = require('../models/Recipe');
const { splitIngredient, itemName } = require('../lib/ingredients');

const PW = 'correct horse';

test('splitting and naming ingredients', () => {
  const preps = ['chopped', 'diced', 'sliced', 'minced'];
  assert.deepEqual(splitIngredient({ qty: '1', name: 'red bell pepper, finely diced' }, { preps }), { qty: '1', type: 'red', name: 'bell pepper', prep: 'finely diced' });
  assert.deepEqual(splitIngredient({ qty: '2', name: 'chicken thighs' }, { preps }), { qty: '2', type: 'thighs', name: 'chicken', prep: '' });
  assert.deepEqual(splitIngredient({ qty: '', name: 'minced garlic' }, { preps }), { qty: '', type: '', name: 'garlic', prep: 'minced' });
  assert.deepEqual(splitIngredient({ qty: '1', name: 'Vidalia onion' }, { preps, types: ['Vidalia'] }), { qty: '1', type: 'Vidalia', name: 'onion', prep: '' });
  assert.equal(itemName({ type: 'red', name: 'bell pepper' }), 'red bell pepper');
  assert.equal(itemName({ type: 'thigh', name: 'chicken' }), 'chicken thigh');
  assert.equal(itemName({ type: '', name: 'onion, diced' }), 'onion');
});

test('recipe tags, types, and prep', async (t) => {
  const app = await startApp({
    name: 'nestly_test_recipe_tags',
    port: 4003,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword(PW) });
      return {};
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });

  // Settings has both lists.
  let page = await katie('/settings/s/recipes');
  assert.match(page.text, /Recipe tags/);
  assert.match(page.text, /Ingredient prep/);
  await katie('/settings/lists/recipeTags', { method: 'POST', form: { action: 'add', name: 'Weeknight' } });

  page = await katie('/s/recipes/new');
  assert.match(page.text, /name="tags" value="To try"/);
  assert.match(page.text, /name="ingPrep"/);
  let r = await katie('/s/recipes', { method: 'POST', form: [
    ['title', 'Fajitas'], ['tags', 'To try'], ['tags', 'Weeknight'], ['tags', 'Not a tag'],
    ['ingQty', '1'], ['ingName', 'bell pepper'], ['ingType', 'red'], ['ingPrep', 'sliced'],
    ['ingQty', '1 lb'], ['ingName', 'chicken'], ['ingType', 'thigh'], ['ingPrep', ''],
    ['ingQty', ''], ['ingName', ''], ['ingType', ''], ['ingPrep', ''],
  ] });
  const id = r.location.split('/').pop();
  await withDb(app.uri, async () => {
    const rec = await Recipe.findById(id).lean();
    assert.deepEqual(rec.tags, ['To try', 'Weeknight']);
    assert.deepEqual(rec.ingredients, [{ qty: '1', type: 'red', name: 'bell pepper', prep: 'sliced' }, { qty: '1 lb', type: 'thigh', name: 'chicken', prep: '' }]);
  });
  page = await katie(`/s/recipes/${id}`);
  assert.match(page.text, /red bell pepper, sliced/);
  assert.match(page.text, /chicken thigh</);
  assert.match(page.text, /href="\/s\/recipes\?tag=To%20try"/);
  // Shopping review uses type + item, without prep.
  page = await katie(`/s/shopping/ingredients?recipe=${id}`);
  assert.match(page.text, /red bell pepper/);
  assert.doesNotMatch(page.text, /sliced/);
  // Filter by tag; search finds by type and by tag.
  assert.match((await katie('/s/recipes?tag=Weeknight')).text, /Fajitas/);
  assert.doesNotMatch((await katie('/s/recipes?tag=Homemade')).text, /Fajitas/);
  assert.match((await katie('/s/recipes?q=thigh')).text, /Fajitas/);
  // Renaming a tag follows into recipes; removing takes it off.
  await katie('/settings/lists/recipeTags', { method: 'POST', form: { action: 'rename', value: 'To try', name: 'Want to try' } });
  await katie('/settings/lists/recipeTags', { method: 'POST', form: { action: 'remove', value: 'Weeknight' } });
  await withDb(app.uri, async () => assert.deepEqual((await Recipe.findById(id).lean()).tags, ['Want to try']));
  // Types used before are suggested.
  assert.match((await katie('/s/recipes/new')).text, /<option value="thigh">/);
  // A prep style no longer in the list stays on recipes that use it.
  await katie('/settings/lists/prepStyles', { method: 'POST', form: { action: 'remove', value: 'sliced' } });
  page = await katie(`/s/recipes/${id}/edit`);
  assert.match(page.text, /<option selected>sliced<\/option>/);

  // Import splits type and prep.
  r = await katie('/s/recipes/import', { method: 'POST', form: { mode: 'text', text: 'Salsa\nIngredients\n2 roma tomatoes, diced\n1/2 red onion, finely chopped\nDirections\nMix.' } });
  assert.match(r.text, /name="ingType"[^>]*value="roma"/);
  assert.match(r.text, /<option selected>diced<\/option>/);
  assert.match(r.text, /name="ingName"[^>]*value="onion"/);
});
