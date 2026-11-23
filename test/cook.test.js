// "What can I cook?": ranking saved recipes by the pantry, cravings, expiring items first, and
// online search through Spoonacular (with a key) or TheMealDB (without).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Recipe = require('../models/Recipe');
const PantryItem = require('../models/PantryItem');
const CatalogItem = require('../models/CatalogItem');
const { covers, rankRecipes } = require('../lib/cook');
const { addDays } = require('../lib/dates');

const PW = 'correct horse';

test('matching what is at home', () => {
  assert.ok(covers('chicken', 'chicken thigh'));
  assert.ok(covers('red bell pepper', 'bell pepper'));
  assert.ok(covers('egg', 'eggs'));
  assert.ok(!covers('rice', 'licorice'));
  assert.ok(!covers('oil', 'foil'));
  const recipes = [
    { title: 'Omelet', ingredients: [{ name: 'eggs' }, { name: 'milk' }, { name: 'salt' }] },
    { title: 'Stir fry', ingredients: [{ name: 'chicken', type: 'thigh' }, { name: 'rice' }, { name: 'soy sauce' }] },
  ];
  const r = rankRecipes(recipes, { have: ['eggs', 'chicken'], usual: ['salt'], expiring: [{ key: 'milk', name: 'Milk', text: 'Expires tomorrow' }] });
  assert.equal(r[0].recipe.title, 'Omelet', 'uses what expires first');
  assert.deepEqual([r[0].got, r[0].missing], [2, ['milk']]);
  assert.equal(rankRecipes(recipes, { have: ['eggs'], craving: 'stir' }).length, 1);
});

test('what can I cook', async (t) => {
  const today = localToday();
  const calls = [];
  const fake = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    const u = new URL(req.url, 'http://x');
    if (u.pathname.endsWith('/filter.php')) return res.end(JSON.stringify({ meals: u.searchParams.get('i') === 'Milk' ? [{ idMeal: '52772', strMeal: 'Rice Pudding' }] : [{ idMeal: '52772', strMeal: 'Rice Pudding' }, { idMeal: '52773', strMeal: 'Egg Fried Rice' }] }));
    if (u.pathname.endsWith('/search.php')) return res.end(JSON.stringify({ meals: [{ idMeal: '52800', strMeal: 'Pea Soup' }] }));
    if (u.pathname.endsWith('/lookup.php')) return res.end(JSON.stringify({ meals: [{ idMeal: '52772', strMeal: 'Rice Pudding', strIngredient1: 'Rice', strMeasure1: '1 cup', strIngredient2: 'Milk', strMeasure2: '4 cups', strIngredient3: '', strInstructions: 'Step 1. Rinse rice.\r\nStep 2. Simmer in milk.', strSource: 'https://example.com/pudding', strMealThumb: '' }] }));
    if (u.pathname === '/recipes/complexSearch') return res.end(JSON.stringify({ results: [{ id: 641, title: 'Milk Rice', readyInMinutes: 30, usedIngredients: [{ name: 'milk' }], missedIngredients: [{ name: 'cinnamon' }] }] }));
    if (u.pathname === '/recipes/641/information') return res.end(JSON.stringify({ title: 'Milk Rice', servings: 4, readyInMinutes: 30, extendedIngredients: [{ original: '1 cup rice' }, { original: '2 cups whole milk' }], analyzedInstructions: [{ steps: [{ step: 'Cook.' }] }], sourceUrl: 'https://example.com/milk-rice', sourceName: 'Example' }));
    res.statusCode = 404; res.end('{}');
  }).listen(4010);
  t.after(() => fake.close());
  const app = await startApp({
    name: 'nestly_test_cook',
    port: 4009,
    env: { MEALDB_URL: 'http://127.0.0.1:4010/api/json/v1', SPOONACULAR_URL: 'http://127.0.0.1:4010', SPOONACULAR_KEY: '' },
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const k = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword(PW) });
      const base = { householdId: home._id, createdBy: k._id, byName: 'Katie' };
      await Recipe.create({ ...base, title: 'Omelet', time: '10 min', ingredients: [{ qty: '3', name: 'eggs' }, { qty: '1/4 cup', name: 'milk' }, { qty: '', name: 'salt' }] });
      await Recipe.create({ ...base, title: 'Chicken soup', tags: ['Homemade'], ingredients: [{ qty: '1 lb', type: 'thigh', name: 'chicken' }, { qty: '2', name: 'carrots' }, { qty: '1', name: 'onion' }] });
      await Recipe.create({ ...base, title: 'Toast', ingredients: [{ qty: '2', name: 'bread' }] });
      await PantryItem.create({ ...base, name: 'Eggs', key: 'eggs', spot: 'Fridge' });
      await PantryItem.create({ ...base, name: 'Milk', key: 'milk', spot: 'Fridge', batches: [{ count: 1, expires: addDays(today, 1) }] });
      await PantryItem.create({ ...base, name: 'Chicken', key: 'chicken', spot: 'Freezer' });
      await PantryItem.create({ ...base, name: 'Bread', key: 'bread', spot: 'Pantry', status: 'out', batches: [] });
      await CatalogItem.create({ householdId: home._id, name: 'Salt', key: 'salt', usuallyHave: true });
      return {};
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });

  assert.match((await katie('/s/recipes')).text, /href="\/s\/recipes\/cook"/);
  let page = await katie('/s/recipes/cook');
  assert.equal(page.status, 200);
  // Omelet first: it uses the milk that's about to expire (and salt counts as "usually have").
  // Then fewest missing: Toast (bread is out), then Chicken Soup.
  const order = (text) => [...text.matchAll(/<span class="cook-top"><strong>([^<]+)<\/strong>/g)].map((m) => m[1]);
  assert.deepEqual(order(page.text), ['Omelet', 'Toast', 'Chicken Soup']);
  assert.match(page.text, /Have all 3/);
  assert.match(page.text, /Uses Milk before it goes/);
  assert.match(page.text, /Have 1 of 3 · Missing 2<\/strong><\/span>\s*<span class="muted small">Need: carrots, onion/);
  assert.match(page.text, /Using everything at home \(3\)/);
  assert.match(page.text, /Use soon: Milk/);
  assert.doesNotMatch(page.text, /id="web"/, 'online only when asked');
  // Have it all / Missing ≤ 2 / Everything.
  assert.deepEqual(order((await katie('/s/recipes/cook?go=1&show=have&use=eggs&use=milk&use=chicken')).text), ['Omelet']);
  // Moods: Quick is 30 minutes or less; Use it up uses something expiring; others match words.
  assert.deepEqual(order((await katie('/s/recipes/cook?mood=Quick&show=all')).text), ['Omelet']);
  assert.deepEqual(order((await katie('/s/recipes/cook?mood=Use+it+up&show=all')).text), ['Omelet']);
  assert.deepEqual(order((await katie('/s/recipes/cook?mood=Soup&show=all')).text), ['Chicken Soup']);
  assert.match((await katie('/s/recipes/cook?mood=Soup')).text, /value="Soup" checked/);
  // A craving narrows it; unticking narrows what counts.
  page = await katie('/s/recipes/cook?go=1&craving=soup&use=chicken');
  assert.match(page.text, /Chicken soup/i);
  assert.doesNotMatch(page.text, /Omelet/);
  page = await katie('/s/recipes/cook?go=1&use=eggs');
  assert.match(page.text, /Have 2 of 3 · Missing 1<\/strong><\/span>\s*<span class="muted small">Need: milk/);

  // Online without a key: TheMealDB, merged by ingredient.
  page = await katie('/s/recipes/cook?go=1&use=milk&use=eggs&tab=online');
  assert.match(page.text, /Rice Pudding/);
  assert.match(page.text, /Uses Milk, Eggs/i);
  assert.match(page.text, /TheMealDB/);
  // "See it" puts it on the recipe form to check.
  page = await katie('/s/recipes/cook/save', { method: 'POST', form: { source: 'mealdb', id: '52772' } });
  assert.match(page.text, /Check the recipe/);
  assert.match(page.text, /value="Rice Pudding"/);
  assert.match(page.text, /Rinse rice\.\nSimmer in milk\./);
  assert.match(page.text, /https:\/\/example\.com\/pudding/);
  assert.equal((await katie('/s/recipes/cook/save', { method: 'POST', form: { source: 'mealdb', id: 'abc' } })).status, 404);
  await withDb(app.uri, async () => assert.equal(await Recipe.countDocuments({ title: 'Rice Pudding' }), 0, 'nothing saved yet'));
  void today;
  void calls;
});

test('what can I cook with Spoonacular', async (t) => {
  const fake = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('apiKey') !== 'k123') { res.statusCode = 401; return res.end('{}'); }
    if (u.pathname === '/recipes/complexSearch') return res.end(JSON.stringify({ results: [{ id: 641, title: 'Milk Rice', readyInMinutes: 30, usedIngredients: [{ name: 'milk' }], missedIngredients: [{ name: 'cinnamon' }] }] }));
    if (u.pathname === '/recipes/641/information') return res.end(JSON.stringify({ title: 'Milk Rice', servings: 4, readyInMinutes: 30, extendedIngredients: [{ original: '1 cup rice' }, { original: '2 cups whole milk' }], analyzedInstructions: [{ steps: [{ step: 'Cook.' }] }], sourceUrl: 'https://example.com/milk-rice', sourceName: 'Example' }));
    res.statusCode = 404; res.end('{}');
  }).listen(4012);
  t.after(() => fake.close());
  const app = await startApp({
    name: 'nestly_test_cook2',
    port: 4011,
    env: { SPOONACULAR_URL: 'http://127.0.0.1:4012', SPOONACULAR_KEY: 'k123' },
    async seed() {
      const home = await Household.create({ name: 'Home' });
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword(PW) });
      return {};
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });
  let page = await katie('/s/recipes/cook?go=1&also=milk&craving=sweet&online=1');
  assert.match(page.text, /Milk Rice/);
  assert.match(page.text, /30 min · Have 1 of 2 · Missing 1<\/span>\s*<span class="row-meta">Missing: cinnamon/);
  assert.match(page.text, /Powered by/);
  page = await katie('/s/recipes/cook/save', { method: 'POST', form: { source: 'spoonacular', id: '641' } });
  assert.match(page.text, /value="Milk Rice"/);
  assert.match(page.text, /name="ingType"[^>]*value="whole"/, 'split like any import');
  assert.match(page.text, /value="4"/);
});
