// Admin tools: viewing Nestly as another role, and copying a household.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Membership = require('../models/Membership');
const Recipe = require('../models/Recipe');
const Meal = require('../models/Meal');
const Chore = require('../models/Chore');
const List = require('../models/List');
const CatalogItem = require('../models/CatalogItem');
const PantryItem = require('../models/PantryItem');
const Bill = require('../models/Bill');

const PW = 'correct horse';

test('view as role, and copy a household', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_admin_tools',
    port: 4013,
    async seed() {
      const home = await Household.create({ name: 'Home', aisles: ['Produce', 'Bakery'], stores: ['Kroger'] });
      const hash = await User.hashPassword(PW);
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const sam = await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      const k = { householdId: home._id, createdBy: katie._id, byName: 'Katie' };
      const s = { householdId: home._id, createdBy: sam._id, byName: 'Sam' };
      const soup = await Recipe.create({ ...k, title: 'Soup', ingredients: [{ qty: '1', name: 'onion' }] });
      await Meal.create({ ...k, date: today, slot: 'Dinner', title: 'Soup', recipeId: soup._id });
      await Meal.create({ ...k, date: '2020-01-01', slot: 'Dinner', title: 'Old meal' });
      await Chore.create({ ...k, title: 'Dishes', date: today, assignee: sam._id });
      await List.create({ ...k, type: 'wishlist', title: 'Gifts', ownerId: katie._id, ownerName: 'Katie', items: [{ text: 'Book', claimedBy: sam._id, claimedName: 'Sam' }] });
      await List.create({ ...s, type: 'note', title: 'Sam secret', private: true, body: 'x' });
      await List.create({ ...k, type: 'note', title: 'Katie secret', private: true, body: 'y' });
      await CatalogItem.create({ householdId: home._id, name: 'Milk', key: 'milk' });
      await PantryItem.create({ ...k, name: 'Rice', key: 'rice', batches: [{ count: 2, expires: '' }] });
      await Bill.create({ ...k, name: 'Rent', cents: 100000, dueDate: today, splitMode: 'even', shares: [{ userId: katie._id, name: 'Katie', cents: 50000 }, { userId: sam._id, name: 'Sam', cents: 50000 }] });
      return { homeId: home.id, katieId: katie.id, samId: sam.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');

  // ---------- View as role ----------
  assert.match((await katie('/settings/roles')).text, /action="\/view-as"/);
  assert.equal((await sam('/view-as', { method: 'POST', form: { role: 'child' } })).status, 404, 'only admins');
  await katie('/view-as', { method: 'POST', form: { role: 'child' } });
  let page = await katie('/');
  assert.match(page.text, /Viewing as <strong>Child<\/strong>/);
  assert.equal((await katie('/s/bills')).status, 404, 'a Child can’t see Bills');
  assert.equal((await katie('/settings/roles')).status, 404, 'or admin pages');

  assert.match((await katie('/s/calendar')).text, /Calendar/);
  // Saving something personal while viewing doesn't save the role.
  await katie('/customize', { method: 'POST', form: { action: 'reset' } });
  await withDb(app.uri, async () => assert.equal((await Membership.findOne({ userId: app.seeded.katieId }).lean()).role, 'admin'));
  await katie('/view-as/exit', { method: 'POST' });
  page = await katie('/s/bills');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Viewing as/);

  // ---------- Copy a household ----------
  page = await katie('/households/copy');
  assert.match(page.text, /value="settings" checked/);
  assert.match(page.text, /value="saved" checked/);
  assert.doesNotMatch(page.text, /value="recipes" checked/);
  assert.equal((await sam('/households/copy')).status, 404);
  await katie('/households/copy', { method: 'POST', form: [['name', 'lake house'], ['parts', 'settings'], ['parts', 'saved'], ['parts', 'recipes'], ['parts', 'meals'], ['parts', 'chores'], ['parts', 'lists'], ['parts', 'pantry'], ['parts', 'bills']] });
  await withDb(app.uri, async () => {
    const lake = await Household.findOne({ name: 'lake house' }).lean();
    assert.ok(lake);
    assert.deepEqual(lake.aisles, ['Produce', 'Bakery'], 'settings came along');
    assert.equal(lake.setupStep, 0);
    const members = await Membership.find({ householdId: lake._id }).lean();
    assert.deepEqual(members.map((m) => [String(m.userId), m.role]), [[app.seeded.katieId, 'admin']]);
    const at = { householdId: lake._id };
    assert.equal(await CatalogItem.countDocuments(at), 1);
    assert.equal(await PantryItem.countDocuments(at), 1);
    const recipe = await Recipe.findOne(at).lean();
    const meals = await Meal.find(at).lean();
    assert.deepEqual(meals.map((m) => m.title), ['Soup'], 'only today and later');
    assert.equal(String(meals[0].recipeId), String(recipe._id), 'linked to the copied recipe');
    assert.equal((await Chore.findOne(at).lean()).assignee, null, 'Sam isn’t there: anyone');
    const lists = await List.find(at).lean();
    assert.deepEqual(lists.map((l) => l.title).sort(), ['Gifts', 'Katie Secret']);
    assert.equal(lists.find((l) => l.title === 'Gifts').items[0].claimedBy, null);
    const bill = await Bill.findOne(at).lean();
    assert.deepEqual([bill.splitMode, bill.shares.length], ['none', 0]);
    // The original is untouched.
    assert.equal(await List.countDocuments({ householdId: app.seeded.homeId }), 3);
  });
  assert.match((await katie('/')).text, /lake house|Lake House/);
});
