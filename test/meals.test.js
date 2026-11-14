// Recipes, importing, the meal plan, and sending ingredients to Shopping.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Recipe = require('../models/Recipe');
const Meal = require('../models/Meal');
const ShoppingItem = require('../models/ShoppingItem');
const CatalogItem = require('../models/CatalogItem');
const { parseIngredient, shoppingName, combine } = require('../lib/ingredients');
const { extractRecipe, parsePasted, duration, checkUrl, socialOf, captionFrom, metaTag } = require('../lib/recipe-import');
const { addDays } = require('../lib/dates');

const PW = 'correct horse';

test('ingredient and recipe parsing', () => {
  assert.deepEqual(parseIngredient('2 cups all-purpose flour, sifted'), { qty: '2 cups', name: 'all-purpose flour, sifted' });
  assert.deepEqual(parseIngredient('1 (15 oz) can black beans, drained'), { qty: '1 (15 oz) can', name: 'black beans, drained' });
  assert.deepEqual(parseIngredient('2 tomatoes'), { qty: '2', name: 'tomatoes' });
  assert.deepEqual(parseIngredient('Salt to taste'), { qty: '', name: 'Salt to taste' });
  assert.equal(shoppingName('garlic (about 4 cloves), minced'), 'garlic');
  assert.deepEqual(combine([{ qty: '1', name: 'Onion, diced', from: 'Tacos' }, { qty: '2', name: 'onion', from: 'Chili' }]), [{ key: 'onion', name: 'Onion', qty: '1 + 2', from: ['Tacos', 'Chili'] }]);
  assert.equal(duration('PT1H15M'), '1 hr 15 min');
  assert.equal(duration('PT45M'), '45 min');

  const html = `<html><script type="application/ld+json">{"@graph":[{"@type":"Recipe","name":"Chili &amp; Rice","recipeYield":"6","totalTime":"PT1H","image":"https://cdn.example.com/c.jpg",
    "recipeIngredient":["2 lbs ground beef","1 onion, diced"],"recipeInstructions":"<p>Brown the beef.</p><p>Simmer.</p>"}]}</script></html>`;
  const r = extractRecipe(html, 'https://example.com/chili');
  assert.equal(r.title, 'Chili & Rice');
  assert.equal(r.servings, '6 servings');
  assert.equal(r.time, '1 hr');
  assert.deepEqual(r.steps, ['Brown the beef.', 'Simmer.']);
  assert.equal(r.ingredients.length, 2);
  assert.equal(r.photoUrl, 'https://cdn.example.com/c.jpg');
  assert.equal(extractRecipe('<html>no recipe</html>', 'https://x.dev'), null);

  const p = parsePasted('Pancakes\nIngredients\n1 cup flour\n2 eggs\nInstructions\n1. Mix.\n2. Cook.');
  assert.equal(p.title, 'Pancakes');
  assert.deepEqual(p.ingredients.map((i) => i.name), ['flour', 'eggs']);
  assert.deepEqual(p.steps, ['Mix.', 'Cook.']);

  // Instagram, TikTok, Facebook: the caption becomes the recipe; hashtags are dropped.
  assert.equal(socialOf('https://www.instagram.com/reel/x/'), 'instagram');
  assert.equal(socialOf('https://vm.tiktok.com/x'), 'tiktok');
  assert.equal(socialOf('https://fb.watch/x'), 'facebook');
  assert.equal(socialOf('https://www.allrecipes.com/x'), '');
  const og = '<meta property="og:description" content="12 likes, 3 comments - cook on May 1, 2026: &quot;Garlic pasta&#10;Ingredients:&#10;- 8 oz spaghetti&#10;- 3 cloves garlic, minced&#10;Steps:&#10;1. Boil.&#10;2. Toss. #pasta #dinner&#10;#food&quot;.">';
  const cap = captionFrom('instagram', metaTag(og, 'og:description'), '');
  assert.equal(cap, 'Garlic pasta\nIngredients:\n- 8 oz spaghetti\n- 3 cloves garlic, minced\nSteps:\n1. Boil.\n2. Toss.');
  const fromCap = parsePasted(cap);
  assert.equal(fromCap.title, 'Garlic pasta');
  assert.deepEqual(fromCap.ingredients[0], { qty: '8 oz', name: 'spaghetti' });
  assert.deepEqual(fromCap.steps, ['Boil.', 'Toss.']);

  // The server never fetches local or private addresses, or odd ports.
  for (const bad of ['http://127.0.0.1/x', 'http://localhost:3000/', 'http://10.0.0.5/', 'http://[::1]/', 'file:///etc/passwd', 'https://example.com:8443/', 'https://user:pw@example.com/']) {
    assert.throws(() => { const u = checkUrl(bad); if (u.hostname === 'localhost') throw new Error('checked at connect'); }, bad);
  }
});

test('recipes and meals', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_meals',
    port: 3990,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const other = await Household.create({ name: 'Other' });
      const hash = await User.hashPassword(PW);
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      await User.create({ householdId: other._id, email: 'out@test.dev', name: 'Out', role: 'admin', passwordHash: hash });
      await CatalogItem.create({ householdId: home._id, name: 'Olive oil', key: 'olive oil', aisle: 'Pantry', usuallyHave: true });
      return { homeId: home.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');
  const out = await signIn('out@test.dev');

  // ---------- Recipes ----------
  let r = await katie('/s/recipes/new');
  assert.equal(r.status, 200);
  assert.match(r.text, /Olive oil/); // the shared item list is offered for ingredients
  r = await katie('/s/recipes', { method: 'POST', form: [['title', ''], ['category', 'Mains']] });
  assert.equal(r.status, 422);
  r = await katie('/s/recipes', {
    method: 'POST',
    form: [['title', 'Tacos'], ['category', 'Mains'], ['servings', '4'], ['time', '30 min'],
      ['ingQty', '1 lb'], ['ingName', 'Ground beef'], ['ingQty', '1'], ['ingName', 'Onion, diced'], ['ingQty', '2 tbsp'], ['ingName', 'olive oil'], ['ingQty', ''], ['ingName', ''],
      ['steps', 'Brown the beef.\n\nAdd onion.\n'], ['link', 'https://example.com/tacos']],
  });
  assert.equal(r.status, 302);
  const tacosId = r.location.split('/').pop();
  const chili = await katie('/s/recipes', { method: 'POST', form: [['title', 'Chili'], ['category', 'Soups'], ['ingQty', '2'], ['ingName', 'onion'], ['ingQty', '1 can'], ['ingName', 'Kidney beans'], ['steps', 'Simmer.']] });
  const chiliId = chili.location.split('/').pop();
  await withDb(app.uri, async () => {
    const tacos = await Recipe.findById(tacosId).lean();
    assert.deepEqual(tacos.ingredients, [{ qty: '1 lb', name: 'Ground beef' }, { qty: '1', name: 'Onion, diced' }, { qty: '2 tbsp', name: 'olive oil' }]);
    assert.deepEqual(tacos.steps, ['Brown the beef.', 'Add onion.']);
    // New ingredients join the household's item list, without notes after the comma.
    assert.ok(await CatalogItem.exists({ key: 'onion' }));
    assert.ok(await CatalogItem.exists({ key: 'kidney beans' }));
    assert.equal(await CatalogItem.countDocuments({ key: 'olive oil' }), 1);
  });
  const page = await katie(`/s/recipes/${tacosId}`);
  assert.match(page.text, /Brown the beef\./);
  assert.match(page.text, /Open original on example\.com/);
  assert.match(page.text, /Add to meal plan/);

  // Search by name or ingredient; another household sees nothing.
  assert.match((await katie('/s/recipes?q=beans')).text, /Chili/);
  assert.doesNotMatch((await katie('/s/recipes?q=beans')).text, /Tacos/);
  assert.match((await katie('/s/recipes?category=Soups')).text, /Chili/);
  assert.equal((await out(`/s/recipes/${tacosId}`)).status, 404);
  assert.doesNotMatch((await out('/s/recipes')).text, /Tacos/);

  // Copy makes a separate recipe and opens it for editing.
  r = await katie(`/s/recipes/${tacosId}/copy`, { method: 'POST' });
  assert.match(r.location, /\/edit$/);
  await withDb(app.uri, async () => assert.equal(await Recipe.countDocuments({ title: 'Tacos (copy)' }), 1));

  // Import: pasted text fills the form without saving; a local link is refused.
  r = await katie('/s/recipes/import', { method: 'POST', form: { mode: 'text', text: 'Pancakes\nIngredients\n1 cup flour\n2 eggs\nDirections\nMix and cook.' } });
  assert.equal(r.status, 200);
  assert.match(r.text, /Check the recipe/);
  assert.match(r.text, /value="Pancakes"/);
  assert.match(r.text, /value="flour"/);
  await withDb(app.uri, async () => assert.equal(await Recipe.countDocuments({ title: 'Pancakes' }), 0));
  r = await katie('/s/recipes/import', { method: 'POST', form: { mode: 'link', link: `${app.base}/health` } });
  assert.equal(r.status, 422);
  assert.match(r.text, /can’t be reached/);
  r = await katie('/s/recipes/import', { method: 'POST', form: { mode: 'link', link: 'not a link' } });
  assert.match(r.text, /starting with https/);

  // A social link that won't share its caption asks for it, keeping the link for the pasted text.
  r = await katie('/s/recipes/import', { method: 'POST', form: { mode: 'link', link: 'https://www.instagram.com/reel/abc123/' } });
  assert.equal(r.status, 422);
  assert.match(r.text, /Instagram didn’t share/);
  assert.match(r.text, /name="link"[^>]*value="https:\/\/www\.instagram\.com\/reel\/abc123\/"/);
  r = await katie('/s/recipes/import', { method: 'POST', form: { mode: 'text', link: 'https://www.instagram.com/reel/abc123/', text: 'Garlic pasta\n8 oz spaghetti\n3 cloves garlic\nBoil the pasta.' } });
  assert.match(r.text, /value="https:\/\/www\.instagram\.com\/reel\/abc123\/"/);
  assert.match(r.text, /value="spaghetti"/);

  // Share → Nestly (Android) fills in the import page, even after signing in first.
  r = await katie('/share?title=Look&text=' + encodeURIComponent('Best tacos https://www.instagram.com/reel/xyz/'));
  assert.equal(r.status, 200);
  assert.match(r.text, /Shared from Instagram/);
  assert.match(r.text, /value="https:\/\/www\.instagram\.com\/reel\/xyz\/"/);
  const fresh = client(app.base);
  r = await fresh('/share?url=' + encodeURIComponent('https://example.com/soup'));
  assert.equal(r.location, '/login');
  r = await fresh('/login', { method: 'POST', form: { email: 'sam@test.dev', password: PW } });
  assert.equal(r.location, '/share?url=' + encodeURIComponent('https://example.com/soup'));
  r = await fresh('/login', { method: 'GET' });

  // ---------- Meal plan ----------
  r = await katie(`/s/meals/new?recipe=${tacosId}`);
  assert.match(r.text, new RegExp(`value="${tacosId}" selected`));
  r = await katie('/s/meals', { method: 'POST', form: { date: today, slot: 'Dinner', recipeId: tacosId, note: 'Sam cooks' } });
  assert.equal(r.status, 302);
  await katie('/s/meals', { method: 'POST', form: { date: today, slot: 'Lunch', recipeId: '', title: 'Leftovers' } });
  await katie('/s/meals', { method: 'POST', form: { date: today, slot: 'Breakfast', recipeId: chiliId } });
  r = await katie('/s/meals', { method: 'POST', form: { date: today, slot: 'Dinner', recipeId: '', title: '' } });
  assert.equal(r.status, 422);

  const week = await sam('/s/meals');
  assert.match(week.text, /This week/);
  assert.match(week.text, /Tacos/);
  assert.match(week.text, /Leftovers/);
  assert.match(week.text, /Sam cooks/);
  assert.match(week.text, /Add ingredients to shopping/);
  const todayPage = await sam('/');
  assert.match(todayPage.text, /Today’s meals/);
  assert.match(todayPage.text, /Tacos/);

  // Renaming the recipe renames it on the plan.
  await katie(`/s/recipes/${tacosId}`, { method: 'POST', form: [['title', 'Beef tacos'], ['category', 'Mains'], ['ingQty', '1 lb'], ['ingName', 'Ground beef'], ['ingQty', '1'], ['ingName', 'Onion, diced'], ['ingQty', '2 tbsp'], ['ingName', 'olive oil']] });
  assert.match((await sam('/s/meals')).text, /Beef tacos/);

  // Next week: copy the week before, without doubling on a second copy.
  const nextWeek = addDays(today, 7);
  r = await katie('/s/meals/copy-week', { method: 'POST', form: { week: nextWeek } });
  assert.equal(r.status, 302);
  await katie('/s/meals/copy-week', { method: 'POST', form: { week: nextWeek } });
  await withDb(app.uri, async () => {
    const copied = await Meal.find({ date: { $gt: addDays(today, 6 - new Date(`${today}T00:00:00Z`).getUTCDay()) } }).lean();
    assert.ok(copied.some((m) => m.date === addDays(today, 7) && m.slot === 'Dinner'));
    assert.equal(copied.filter((m) => m.date === addDays(today, 7) && m.slot === 'Dinner').length, 1);
  });

  // Removing a meal slot moves its meals to Other, which still shows.
  await katie('/settings/lists/mealSlots', { method: 'POST', form: { action: 'remove', value: 'Lunch' } });
  assert.match((await katie('/s/meals')).text, /Other/);

  // ---------- To the shopping list ----------
  await katie('/s/shopping/quick', { method: 'POST', form: { name: 'Ground beef' } });
  const rev = await katie(`/s/shopping/ingredients?recipe=${tacosId}`);
  assert.equal(rev.status, 200);
  assert.match(rev.text, /On the list/); // ground beef
  assert.match(rev.text, /Usually have/); // olive oil
  assert.match(rev.text, /value="onion" checked/);
  assert.doesNotMatch(rev.text, /value="olive oil" checked/);

  // Add onion and kidney beans for the plan; remember skipping nothing else.
  const wk = await katie(`/s/shopping/ingredients?week=${today}`);
  assert.match(wk.text, /Kidney beans/);
  r = await katie('/s/shopping/ingredients', { method: 'POST', form: [['week', today], ['add', 'onion'], ['add', 'kidney beans'], ['add', 'ground beef'], ['add', 'made-up'], ['remember', 'on']] });
  assert.equal(r.location, '/s/shopping');
  await withDb(app.uri, async () => {
    const items = await ShoppingItem.find({ clearedAt: null }).lean();
    const onion = items.find((i) => i.key === 'onion');
    assert.ok(onion);
    assert.match(onion.note, /Beef tacos/);
    assert.match(onion.note, /Chili/);
    assert.equal(items.filter((i) => i.key === 'ground beef').length, 1); // not doubled
    assert.ok(!items.some((i) => i.key === 'made-up')); // only what the plan holds
    assert.ok(!items.some((i) => i.key === 'olive oil'));
    assert.equal((await CatalogItem.findOne({ key: 'olive oil' }).lean()).usuallyHave, true);
  });
  assert.match((await katie('/activity')).text, /ingredients for the meal plan/);

  // ---------- Undo, and sections turned off ----------
  r = await katie(`/s/recipes/${chiliId}/delete`, { method: 'POST' });
  await withDb(app.uri, async () => assert.equal(await Recipe.countDocuments({ title: 'Chili' }), 0));
  assert.match((await katie('/s/meals')).text, /Chili/); // the meal keeps its name
  await katie('/settings/sections', { method: 'POST', form: [['sections', 'shopping'], ['sections', 'remember'], ['sections', 'calendar']] });
  assert.equal((await katie('/s/meals')).status, 404);
  assert.equal((await katie('/s/recipes')).status, 404);
  assert.doesNotMatch((await katie('/')).text, /Today’s meals/);
});
