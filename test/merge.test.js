// Merging pantry items: the others become kinds of the kept one, with their date lines, barcodes,
// photos, tags, shopping items and ratings; their pantry and saved items are gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const PantryItem = require('../models/PantryItem');
const CatalogItem = require('../models/CatalogItem');
const ShoppingItem = require('../models/ShoppingItem');
const Rating = require('../models/Rating');
const { addDays } = require('../lib/dates');

const PW = 'correct horse';
const SUN = '0057836012004';

test('merge pantry items', async (t) => {
  const app = await startApp({
    name: 'nestly_test_merge',
    port: 4061,
    async seed() {
      const today = localToday();
      const home = await Household.create({ name: 'Home', setupStep: 0, pantrySpots: ['Fridge', 'Pantry'] });
      const hash = await User.hashPassword(PW);
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const naum = await User.create({ householdId: home._id, email: 'naum@test.dev', name: 'Naum', passwordHash: hash });
      const mia = await User.create({ householdId: home._id, email: 'mia@test.dev', name: 'Mia', passwordHash: hash });
      const b = { householdId: home._id, createdBy: katie._id, byName: 'Katie', status: 'have' };
      const ct = await PantryItem.create({ ...b, name: 'Cherry Tomatoes', key: 'cherry tomatoes', spot: 'Fridge', tags: ['Salad'], batches: [{ count: 1, expires: addDays(today, 3) }] });
      const sun = await PantryItem.create({ ...b, name: 'Sunset Cherry Tomatoes', key: 'sunset cherry tomatoes', spot: 'Fridge', tags: ['Snacks'], batches: [{ count: 2, expires: addDays(today, 8) }] });
      const org = await PantryItem.create({ ...b, name: 'Cherry Tomatoes Organic', key: 'cherry tomatoes organic', spot: 'Pantry', batches: [{ count: 1, expires: addDays(today, 5) }] });
      await PantryItem.create({ ...b, name: 'Greek Yogurt', key: 'greek yogurt', spot: 'Fridge', batches: [{ count: 1, expires: '' }] });
      await CatalogItem.create({ householdId: home._id, name: 'Cherry Tomatoes', key: 'cherry tomatoes' });
      await CatalogItem.create({ householdId: home._id, name: 'Sunset Cherry Tomatoes', key: 'sunset cherry tomatoes', staple: true, barcodes: [SUN] });
      await ShoppingItem.create({ householdId: home._id, createdBy: katie._id, byName: 'Katie', addedBy: 'Katie', name: 'Cherry Tomatoes Organic', key: 'cherry tomatoes organic' });
      await Rating.create({ householdId: home._id, key: 'sunset cherry tomatoes', userId: naum._id, userName: 'Naum', value: 'never' });
      await Rating.create({ householdId: home._id, key: 'sunset cherry tomatoes', userId: katie._id, userName: 'Katie', value: 'okay' });
      await Rating.create({ householdId: home._id, key: 'cherry tomatoes', userId: katie._id, userName: 'Katie', value: 'again' });
      return { ct: ct.id, sun: sun.id, org: org.id, miaId: mia.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const mia = await signIn('mia@test.dev');
  await katie(`/settings/household/members/${app.seeded.miaId}/role`, { method: 'POST', form: { role: 'child' } });
  const { ct, sun, org } = app.seeded;

  // Select mode offers it; the merge page lists the picked ones with kind-name hints.
  assert.match((await katie('/s/pantry?select=1')).text, /data-bulk-merge>Merge into one</);
  let page = await katie(`/s/pantry/merge?ids=${ct}&ids=${sun}&ids=${org}`);
  assert.match(page.text, /Merge 3 into one/);
  assert.match(page.text, /placeholder="Sunset"/);
  assert.match(page.text, /placeholder="Organic"/);

  await katie('/s/pantry/merge', { method: 'POST', form: [['ids', ct], ['ids', sun], ['ids', org], ['keep', ct], ['name', ''], [`kindName_${org}`, 'Organic Valley']] });
  await withDb(app.uri, async () => {
    const items = await PantryItem.find({ name: /tomato/i }).lean();
    assert.equal(items.length, 1, 'one pantry item left');
    const item = items[0];
    assert.equal(item.name, 'Cherry Tomatoes');
    assert.equal(item.count, 4);
    assert.deepEqual(item.tags.sort(), ['Salad', 'Snacks']);
    const cat = await CatalogItem.findOne({ key: 'cherry tomatoes' }).lean();
    assert.deepEqual(cat.kinds.map((k) => k.name), ['Sunset', 'Organic Valley']);
    assert.deepEqual(cat.barcodes, [SUN]);
    assert.equal(cat.kinds[0].code, SUN);
    assert.match(cat.kinds[1].code, /^n[0-9a-f]{6}$/, 'no barcode: an id of its own');
    assert.equal(cat.staple, true, 'staple carries over');
    assert.deepEqual(item.batches.map((b) => [b.count, b.kind]), [[1, ''], [2, SUN], [1, cat.kinds[1].code]]);
    assert.equal(await CatalogItem.countDocuments({ key: { $in: ['sunset cherry tomatoes', 'cherry tomatoes organic'] } }), 0);
    assert.equal((await ShoppingItem.findOne({}).lean()).name, 'Cherry Tomatoes');
    // Naum's rating moves; Katie already rated Cherry Tomatoes, so hers stays.
    const r = await Rating.find({ key: 'cherry tomatoes' }).lean();
    assert.deepEqual(r.map((x) => `${x.userName}:${x.value}`).sort(), ['Katie:again', 'Naum:never']);
  });
  // The edit page shows the kinds, and the codeless one says so.
  page = await katie(`/s/pantry/${ct}/edit`);
  assert.match(page.text, /No barcode yet/);
  assert.match(page.text, />Organic Valley</);
  assert.match(page.text, /Merge into another item…/);

  // From one item, into another (with a new name).
  const yogurt = await withDb(app.uri, async () => String((await PantryItem.findOne({ name: 'Greek Yogurt' }).lean())._id));
  page = await katie(`/s/pantry/merge?ids=${yogurt}`);
  assert.match(page.text, /Merge into another item/);
  assert.match(page.text, /data-search="cherry tomatoes"/);
  await katie('/s/pantry/merge', { method: 'POST', form: [['ids', yogurt], ['keep', ct], ['name', 'Fridge Stuff'], [`kindName_${yogurt}`, 'Yogurt']] });
  await withDb(app.uri, async () => {
    assert.equal(await PantryItem.countDocuments({}), 1);
    const cat = await CatalogItem.findOne({ key: 'fridge stuff' }).lean();
    assert.ok(cat, 'saved item renamed');
    assert.equal(await Rating.countDocuments({ key: 'fridge stuff' }), 2, 'ratings follow the new name');
  });

  // A Child (Pantry view only) can't merge.
  assert.equal((await mia(`/s/pantry/merge?ids=${ct}`)).status, 303);
  assert.doesNotMatch((await mia(`/s/pantry/${ct}/edit`)).text, /Merge into another item/);
});
