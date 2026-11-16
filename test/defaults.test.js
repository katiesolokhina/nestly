// Settings → Defaults: what new items start with, on or off, across sections.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const ShoppingItem = require('../models/ShoppingItem');
const CatalogItem = require('../models/CatalogItem');

const PW = 'correct horse';

test('new-item defaults', async (t) => {
  const app = await startApp({
    name: 'nestly_test_defaults',
    port: 4003,
    async seed() {
      const home = await Household.create({ name: 'Home', stores: ['Kroger', 'Costco'] });
      const hash = await User.hashPassword(PW);
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const sam = await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      await CatalogItem.create({ householdId: home._id, name: 'Paper towels', key: 'paper towels', tag: 'Home', store: 'Costco' });
      return { homeId: home.id, samId: sam.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');

  assert.match((await katie('/settings')).text, /href="\/settings\/defaults"/);
  let page = await katie('/settings/defaults');
  assert.equal(page.status, 200);
  for (const label of ['Tag', 'How it’s bought', 'Event category', 'Recipe category', 'Who does it', 'Bill category']) assert.match(page.text, new RegExp(label));
  assert.equal((await sam('/settings/defaults')).status, 404, 'members can’t change household defaults');
  assert.doesNotMatch((await katie('/settings/s/shopping')).text, /name="defaultStore"/, 'moved to Defaults');

  // Turn some on.
  await katie('/settings/defaults', { method: 'POST', form: [
    ['on', 'shopTag'], ['shopTag', 'Groceries'], ['on', 'defaultStore'], ['defaultStore', 'Kroger'], ['on', 'shopPrivate'],
    ['on', 'recipeCat'], ['recipeCat', 'Soups'], ['on', 'choreWho'], ['choreWho', app.seeded.samId], ['on', 'choreRoom'], ['choreRoom', 'Kitchen'],
    ['on', 'billCat'], ['billCat', 'Utilities'], ['on', 'eventCat'], ['eventCat', 'Birthdays'],
    ['shopMethod', 'Online'], // not ticked: stays off
  ] });
  const h = await withDb(app.uri, () => Household.findById(app.seeded.homeId).lean());
  assert.deepEqual([h.shopTag, h.defaultStore, h.shopPrivate, h.shopMethod, h.recipeCat, h.choreRoom, h.billCat, h.eventCat], ['Groceries', 'Kroger', true, '', 'Soups', 'Kitchen', 'Utilities', 'Birthdays']);

  // Shopping: defaults win over the saved item.
  await katie('/s/shopping/quick', { method: 'POST', form: { name: 'Paper towels' } });
  await katie('/s/shopping/quick', { method: 'POST', form: { name: 'Milk' } });
  await withDb(app.uri, async () => {
    const towels = await ShoppingItem.findOne({ key: 'paper towels' }).lean();
    assert.deepEqual([towels.tag, towels.store, towels.private], ['Groceries', 'Kroger', true]);
    assert.equal((await ShoppingItem.findOne({ key: 'milk' }).lean()).tag, 'Groceries');
  });
  assert.match((await katie('/s/shopping/new')).text, /name="private"[^>]*checked/);
  // Other sections' forms start with theirs.
  assert.match((await katie('/s/recipes/new')).text, /<option selected>Soups<\/option>|value="Soups" selected/);
  page = await katie('/s/chores/new');
  assert.match(page.text, new RegExp(`value="${app.seeded.samId}" selected`));
  assert.match(page.text, /<option[^>]*selected[^>]*>Kitchen<\/option>|value="Kitchen" selected/);
  assert.match((await katie('/s/bills/new')).text, /<option selected>Utilities<\/option>|value="Utilities" selected/);
  page = await katie('/s/calendar/new');
  assert.match(page.text, /<option selected data-yearly>Birthdays<\/option>/);
  assert.match(page.text, /<option value="yearly" selected>/, 'a Birthdays default repeats yearly too');

  // Off again: back to the usual.
  await katie('/settings/defaults', { method: 'POST', form: { shopTag: 'Groceries' } });
  const off = await withDb(app.uri, () => Household.findById(app.seeded.homeId).lean());
  assert.deepEqual([off.shopTag, off.defaultStore, off.shopPrivate, off.eventCat, off.choreWho], ['', 'Any store', false, 'Uncategorized', '']);
  await katie('/s/shopping/quick', { method: 'POST', form: { name: 'Eggs' } });
  await withDb(app.uri, async () => assert.deepEqual(((({ tag, private: p }) => [tag, p])(await ShoppingItem.findOne({ key: 'eggs' }).lean())), ['Unassigned', false]));
});
