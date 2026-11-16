// Title Case for new names, and leaving non-food pantry items out of recipe suggestions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const { titleCase } = require('../lib/titlecase');
const Household = require('../models/Household');
const User = require('../models/User');
const PantryItem = require('../models/PantryItem');
const Recipe = require('../models/Recipe');
const ShoppingItem = require('../models/ShoppingItem');
const { addDays } = require('../lib/dates');

const PW = 'correct horse';

test('title case', () => {
  for (const [a, b] of [['grape tomatoes', 'Grape Tomatoes'], ['iPhone charger', 'iPhone Charger'], ['BBQ sauce', 'BBQ Sauce'], ['2% milk', '2% Milk'], ['salt-and-pepper', 'Salt-and-pepper'], ['trader joe’s', 'Trader Joe’s']]) assert.equal(titleCase(a), b);
});

test('non-food stays out of recipes; names are Title Case', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_food',
    port: 4005,
    async seed() {
      const home = await Household.create({ name: 'Home', pantrySpots: ['Fridge', 'Cleaning'] });
      const k = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword(PW) });
      const base = { householdId: home._id, createdBy: k._id, byName: 'Katie' };
      await PantryItem.create({ ...base, name: 'lemons', key: 'lemons', spot: 'Fridge', batches: [{ count: 2, expires: addDays(today, 1) }] });
      await PantryItem.create({ ...base, name: 'Lemon cleaner', key: 'lemon cleaner', spot: 'Cleaning', batches: [{ count: 1, expires: addDays(today, 1) }] });
      await Recipe.create({ ...base, title: 'lemonade', ingredients: [{ qty: '3', name: 'lemons' }, { qty: '1 cup', name: 'sugar' }] });
      return { homeId: home.id };
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });

  await withDb(app.uri, async () => {
    assert.equal((await PantryItem.findOne({ key: 'lemons' }).lean()).name, 'Lemons');
    assert.equal((await Recipe.findOne().lean()).title, 'Lemonade');
  });
  await katie('/s/shopping/quick', { method: 'POST', form: { name: 'paper towels' } });
  await withDb(app.uri, async () => assert.equal((await ShoppingItem.findOne({ key: 'paper towels' }).lean()).name, 'Paper Towels'));

  let page = await katie('/s/recipes/cook');
  assert.match(page.text, /Lemons/);
  assert.doesNotMatch(page.text, /Lemon Cleaner/, 'Cleaning is not food');
  assert.match(page.text, /Have 1 of 2 · Missing 1/);
  page = await katie('/');
  assert.doesNotMatch(page.text.slice(page.text.indexOf('Use soon')), /Lemon Cleaner<\/span><span class="row-meta">Expires/);

  // An item can say it's food anyway; Settings → Pantry decides by spot.
  const cleaner = await withDb(app.uri, async () => String((await PantryItem.findOne({ key: 'lemon cleaner' }))._id));
  assert.match((await katie(`/s/pantry/${cleaner}/edit`)).text, /By where it’s kept \(no\)/);
  await withDb(app.uri, () => PantryItem.updateOne({ _id: cleaner }, { $set: { food: true } }));
  assert.match((await katie('/s/recipes/cook')).text, /Lemon Cleaner/);
  await withDb(app.uri, () => PantryItem.updateOne({ _id: cleaner }, { $set: { food: null } }));
  await katie('/settings/s/pantry', { method: 'POST', form: { nonFoodShown: '1', nameHave: 'Have', nameLow: 'Low', nameOut: 'Out' } });
  await withDb(app.uri, async () => assert.deepEqual((await Household.findById(app.seeded.homeId).lean()).nonFoodSpots, []));
  assert.match((await katie('/s/recipes/cook')).text, /Lemon Cleaner/);
});
