// Recipe scaling: amounts, the recipe page, the shopping review, and planned servings.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Recipe = require('../models/Recipe');
const Meal = require('../models/Meal');
const { scaleQty, servingsNum } = require('../lib/scale');

const PW = 'correct horse';

test('scaling amounts', () => {
  const cases = [['1 1/2 cups', 2, '3 cups'], ['1/2 tsp', 3, '1 ½ tsp'], ['½ cup', 2, '1 cup'], ['1 cup', 2, '2 cups'], ['1 1/2 cups', 0.5, '¾ cup'], ['2-3 cloves', 2, '4-6 cloves'], ['1 (14 oz) can', 2, '2 (14 oz) can'],
    ['pinch', 2, 'pinch'], ['1.5 lbs', 2, '3 lbs'], ['3 cups', 0.5, '1 ½ cups'], ['1 cup', 1 / 3, '⅓ cup'], ['2 to 3 tbsp', 0.5, '1 to 1 ½ tbsp'], ['1½ cups', 2, '3 cups'], ['2 large eggs', 1.5, '3 large eggs'], ['', 2, '']];
  for (const [q, f, want] of cases) assert.equal(scaleQty(q, f), want, `${q} × ${f}`);
  assert.equal(servingsNum('Serves 4-6'), 4);
  assert.equal(servingsNum('a crowd'), null);
});

test('scaling recipes', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_scale',
    port: 4007,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const k = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword(PW) });
      const r = await Recipe.create({ householdId: home._id, createdBy: k._id, byName: 'Katie', title: 'Pancakes', servings: '4', ingredients: [{ qty: '1 1/2 cups', name: 'flour' }, { qty: '2', name: 'eggs' }, { qty: 'pinch', name: 'salt' }] });
      return { rid: r.id };
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });
  const { rid } = app.seeded;

  let page = await katie(`/s/recipes/${rid}?serves=8`);
  assert.match(page.text, /<strong>3 cups<\/strong> flour/);
  assert.match(page.text, /<strong>4<\/strong> eggs/);
  assert.match(page.text, /<strong>pinch<\/strong> salt/);
  assert.match(page.text, /Scaled 2× to serve 8/);
  assert.match(page.text, /ingredients\?recipe=[a-f0-9]+&amp;x=2/);
  assert.match(page.text, /meals\/new\?recipe=[a-f0-9]+&amp;servings=8/);
  page = await katie(`/s/recipes/${rid}?x=0.5`);
  assert.match(page.text, /<strong>¾ cup<\/strong> flour/);
  assert.match(page.text, /value="2"/, 'serves 2');
  page = await katie(`/s/recipes/${rid}?x=999`);
  assert.match(page.text, /<strong>1 1\/2 cups<\/strong> flour/, 'out of range: as written');

  // Shopping review and adding use the scaled amounts.
  page = await katie(`/s/shopping/ingredients?recipe=${rid}&x=2`);
  assert.match(page.text, /3 cups/);
  assert.match(page.text, /name="x" value="2"/);
  await katie('/s/shopping/ingredients', { method: 'POST', form: [['recipe', rid], ['x', '2'], ['add', 'flour']] });
  await withDb(app.uri, async () => assert.equal((await require('../models/ShoppingItem').findOne({ key: 'flour' }).lean()).qty, '3 cups'));

  // A planned meal with its own servings scales the week's shopping.
  page = await katie(`/s/meals/new?recipe=${rid}&servings=12`);
  assert.match(page.text, /name="servings"[^>]*value="12"/);
  await katie('/s/meals', { method: 'POST', form: { date: today, slot: 'Dinner', recipeId: rid, servings: '12' } });
  await withDb(app.uri, async () => assert.equal((await Meal.findOne().lean()).servings, 12));
  assert.match((await katie(`/s/meals?week=${today}`)).text, /Serves 12/);
  page = await katie(`/s/shopping/ingredients?week=${today}`);
  assert.match(page.text, /4 ½ cups/);
});
