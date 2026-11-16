// Meals: "Use soon" suggestions from what expires this week, planned in one tap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Recipe = require('../models/Recipe');
const PantryItem = require('../models/PantryItem');
const Meal = require('../models/Meal');
const { addDays } = require('../lib/dates');

const PW = 'correct horse';

test('plan meals around what expires', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_plan',
    port: 4013,
    async seed() {
      const home = await Household.create({ name: 'Home', mealSlot: 'Dinner' });
      const k = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword(PW) });
      const base = { householdId: home._id, createdBy: k._id, byName: 'Katie' };
      const soup = await Recipe.create({ ...base, title: 'Spinach soup', ingredients: [{ qty: '1 bag', name: 'spinach' }, { qty: '1', name: 'onion' }] });
      await Recipe.create({ ...base, title: 'Toast', ingredients: [{ qty: '2', name: 'bread' }] });
      await PantryItem.create({ ...base, name: 'Spinach', key: 'spinach', batches: [{ count: 1, expires: addDays(today, 2) }] });
      await PantryItem.create({ ...base, name: 'Bread', key: 'bread' });
      return { soupId: soup.id };
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });

  // Today: what to use soon, and the recipes that use it.
  let page = await katie('/');
  assert.match(page.text, /<h2>Use soon<\/h2>/);
  assert.match(page.text, /Spinach<\/span><span class="row-meta">Expires in 2 days/i);
  assert.match(page.text, /Spinach soup<\/span><span class="row-meta">Uses Spinach · need 1/);
  // Shopping for the soup: onion is missing (ticked, first); spinach is home (unticked).
  page = await katie(`/s/shopping/ingredients?recipe=${app.seeded.soupId}`);
  assert.match(page.text, /1 to buy · 1 in the pantry/);
  assert.ok(page.text.indexOf('>onion<') < page.text.indexOf('>spinach<'), 'missing first');
  assert.match(page.text, /value="spinach">/);
  assert.match(page.text, /value="onion" checked>/);

  page = await katie('/s/meals');
  assert.match(page.text, /Use soon/);
  assert.match(page.text, /Spinach \(expires in 2 days\)/);
  assert.match(page.text, /Spinach soup/);
  assert.match(page.text, /Uses Spinach · Need onion/);
  assert.doesNotMatch(page.text.slice(page.text.indexOf('Use soon'), page.text.indexOf('Use soon') + 3000), /Toast/, 'only recipes that use what expires');
  // Plan it for a day.
  const day = addDays(today, 1) <= addDays(today, 6) ? addDays(today, 1) : today;
  await katie('/s/meals', { method: 'POST', form: { recipeId: app.seeded.soupId, slot: 'Dinner', date: day } });
  await withDb(app.uri, async () => assert.equal(await Meal.countDocuments({ recipeId: app.seeded.soupId }), 1));
  // Once planned this week, it's not suggested again.
  page = await katie(`/s/meals?week=${day}`);
  const card = page.text.indexOf('id="usesoon"');
  assert.ok(card < 0 || !/Spinach soup<\/span><span class="row-meta">Uses/.test(page.text.slice(card)));
  // Past weeks don't suggest.
  assert.doesNotMatch((await katie(`/s/meals?week=${addDays(today, -14)}`)).text, /Use soon/);
});
