// Kinds: brands or flavors of one item, one per barcode. Scanning tags the date line with its kind;
// the pantry item and saved item list them (rename, remove, add by typing); Shopping can prefer one
// and allow others, and a scan in the store says which it is. A code is never dropped.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const PantryItem = require('../models/PantryItem');
const CatalogItem = require('../models/CatalogItem');
const ShoppingItem = require('../models/ShoppingItem');
const { addDays } = require('../lib/dates');

const PW = 'correct horse';
const NS = '0068345700124';
const SUN = '0057836012004';
const STORE = '0041303015868';

test('kinds and barcodes', async (t) => {
  const off = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes(SUN)) return res.end(JSON.stringify({ status: 1, product: { product_name: 'Cherry Tomatoes', brands: 'Sunset', quantity: '10 oz' } }));
    res.end(JSON.stringify({ status: 0 }));
  }).listen(4055);
  t.after(() => off.close());
  const app = await startApp({
    name: 'nestly_test_kinds',
    port: 4057,
    env: { OFF_URL: 'http://127.0.0.1:4055' },
    async seed() {
      const home = await Household.create({ name: 'Home', setupStep: 0, pantrySpots: ['Fridge'] });
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword(PW) });
      return {};
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });
  const today = localToday();
  const get = (q) => withDb(app.uri, async () => q());

  // Scan Nature Sweet in: the date line is that kind, and the saved item gets it (made if missing).
  let page = await katie(`/s/pantry/add?name=Cherry%20Tomatoes&code=${NS}&brand=Nature%20Sweet`);
  assert.match(page.text, /name="kindName" type="text" maxlength="60" value="Nature Sweet"/);
  await katie('/s/pantry/add', { method: 'POST', form: { name: 'Cherry Tomatoes', spot: 'Fridge', count: '1', expires: addDays(today, 3), code: NS, brand: 'Nature Sweet', kindName: 'Nature Sweet' } });
  let item = await get(() => PantryItem.findOne({ key: 'cherry tomatoes' }).lean());
  assert.equal(item.batches[0].kind, NS);
  let cat = await get(() => CatalogItem.findOne({ key: 'cherry tomatoes' }).lean());
  assert.deepEqual(cat.barcodes, [NS]);
  assert.equal(cat.kinds[0].name, 'Nature Sweet');
  assert.equal(cat.kinds[0].by, 'Katie', 'who is kept, not shown');

  // Then Sunset: offered as another kind of the same item; its own date line.
  page = await katie(`/s/pantry/add?name=Cherry%20Tomatoes&code=${SUN}&brand=Sunset`);
  assert.match(page.text, /Add as another kind of Cherry Tomatoes/);
  await katie('/s/pantry/add', { method: 'POST', form: { name: 'Cherry Tomatoes', spot: 'Fridge', count: '2', expires: addDays(today, 8), code: SUN, brand: 'Sunset', kindName: 'Sunset', choice: `add:${item._id}` } });
  item = await get(() => PantryItem.findOne({ key: 'cherry tomatoes' }).lean());
  assert.deepEqual(item.batches.map((b) => [b.count, b.kind]), [[1, NS], [2, SUN]]);

  // The Pantry list shows the soonest kind; the edit page has kinds per line and the dropdown.
  page = await katie('/s/pantry');
  assert.match(page.text, /Nature Sweet \+1 · /);
  page = await katie(`/s/pantry/${item._id}/edit`);
  assert.match(page.text, new RegExp(`name="bKind"><option value="">No kind</option><option value="${NS}" selected>Nature Sweet</option>`));
  assert.match(page.text, /Kinds and barcodes \(2\)/);
  assert.doesNotMatch(page.text, /Katie<\/span>/, 'who scanned it is not shown');

  // Rename one, add one by typing (with a name), make it a staple, all from the pantry item.
  const fd = new FormData();
  [['name', 'Cherry Tomatoes'], ['spot', 'Fridge'], ['status', 'have'], ['bCount', '1'], ['bExpires', addDays(today, 3)], ['bKind', NS], ['bCount', '2'], ['bExpires', addDays(today, 8)], ['bKind', SUN],
    ['savedShown', '1'], ['staple', 'on'], [`kindName_${NS}`, 'NatureSweet Glorys'], [`kindName_${SUN}`, 'Sunset'], ['kindAdd', STORE], ['kindAddName', 'Store Brand'], ['autoShop', 'on']].forEach(([k, v]) => fd.append(k, v));
  await katie(`/s/pantry/${item._id}`, { method: 'POST', formData: fd });
  cat = await get(() => CatalogItem.findOne({ key: 'cherry tomatoes' }).lean());
  assert.equal(cat.staple, true);
  assert.deepEqual(cat.kinds.map((k) => k.name), ['NatureSweet Glorys', 'Sunset', 'Store Brand']);
  assert.ok(cat.barcodes.includes(STORE));

  // A code on another item moves (and says so).
  await get(() => CatalogItem.create({ householdId: cat.householdId, name: 'Grape Tomatoes', key: 'grape tomatoes', barcodes: ['0011110000013'] }));
  page = await katie(`/s/shopping/saved/${cat._id}`);
  assert.match(page.text, /In the pantry: Fridge · 3 \(NatureSweet Glorys 1, Sunset 2\)/);
  await katie(`/s/shopping/saved/${cat._id}`, { method: 'POST', form: { name: 'Cherry Tomatoes', qty: '1', store: 'Any store', aisle: 'Unassigned', tag: 'Unassigned', method: 'In person', staple: 'on', savedShown: '1', kindAdd: '0011110000013', kindAddName: 'Grape-ish', [`kindRemove`]: STORE } });
  cat = await get(() => CatalogItem.findOne({ key: 'cherry tomatoes' }).lean());
  assert.deepEqual(cat.kinds.map((k) => k.name), ['NatureSweet Glorys', 'Sunset', 'Grape-ish']);
  assert.ok(!cat.barcodes.includes(STORE), 'removed');
  assert.deepEqual((await get(() => CatalogItem.findOne({ key: 'grape tomatoes' }).lean())).barcodes, []);

  // Shopping: prefer Nature Sweet, Sunset is OK.
  await katie('/s/shopping', { method: 'POST', form: { name: 'Cherry Tomatoes', qty: '1' } });
  const shop = await get(() => ShoppingItem.findOne({ key: 'cherry tomatoes', bought: false }).lean());
  page = await katie(`/s/shopping/${shop._id}/edit`);
  assert.match(page.text, /Which kind/);
  await katie(`/s/shopping/${shop._id}`, { method: 'POST', form: { name: 'Cherry Tomatoes', qty: '1', store: 'Any store', aisle: 'Unassigned', tag: 'Unassigned', method: 'In person', kindsShown: '1', kindPref: NS, kindOk: SUN } });
  assert.match((await katie('/s/shopping')).text, /class="row-meta kind-want">NatureSweet Glorys \(or Sunset\)</);
  // In the store: which kind is it?
  const scan = async (code) => JSON.parse((await katie(`/api/barcode/${code}?for=shopping`)).text).kind;
  assert.equal((await scan(NS)).tone, 'good');
  assert.equal((await scan(SUN)).tone, 'ok');
  assert.equal((await scan('0011110000013')).tone, 'no');

  // The setting hides kinds everywhere (scanning still works).
  await katie('/settings/s/pantry', { method: 'POST', form: { pantrySoonDays: '3', todayExpired: 'week', kindsShown: '1' } });
  assert.doesNotMatch((await katie(`/s/pantry/${item._id}/edit`)).text, /Kinds and barcodes|name="bKind"/);
  assert.equal(await scan(NS), null);
});
