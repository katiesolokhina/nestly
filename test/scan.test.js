// Barcodes: lookup (saved first, then Open Food Facts), pantry add and restock, shopping add,
// ticking off while shopping, and remembering codes the database doesn't know.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startApp, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const PantryItem = require('../models/PantryItem');
const ShoppingItem = require('../models/ShoppingItem');
const CatalogItem = require('../models/CatalogItem');

const PW = 'correct horse';

test('barcode scanning', async (t) => {
  // A stand-in for Open Food Facts: one known product.
  let calls = 0;
  const off = http.createServer((req, res) => {
    calls += 1;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/v2/product/0012345678905.json')) return res.end(JSON.stringify({ status: 1, product: { product_name: 'Spaghetti', brands: 'Barilla, Other', quantity: '16 oz' } }));
    res.end(JSON.stringify({ status: 0 }));
  }).listen(3998);
  t.after(() => off.close());
  const app = await startApp({
    name: 'nestly_test_scan',
    port: 3999,
    env: { OFF_URL: 'http://127.0.0.1:3998' },
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      return {};
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });
  const api = async (code, mode) => { const r = await katie(`/api/barcode/${code}?for=${mode}`); return { status: r.status, ...JSON.parse(r.text) }; };

  // The scan buttons and scanner are on the pages.
  assert.match((await katie('/s/pantry')).text, /data-scanner data-mode="pantry"/);
  assert.match((await katie('/s/shopping')).text, /data-scanner data-mode="shopping"/);
  assert.match((await katie('/s/shopping?mode=shop')).text, /data-scanner data-mode="shop"/);

  // 12-digit UPC and 13-digit EAN are the same product.
  let d = await api('012345678905', 'pantry');
  assert.equal(d.name, 'Spaghetti');
  assert.equal(d.brand, 'Barilla');
  assert.equal(d.size, '16 oz');
  assert.equal(d.source, 'lookup');
  assert.equal((await api('abc', 'pantry')).status, 400);
  assert.equal((await api('1234', 'pantry')).status, 400);

  // Pantry: a scan opens the add page (date, how many), and the code is remembered.
  let r = await katie('/s/pantry/add?name=Spaghetti&code=0012345678905&brand=Barilla&found=Found%3A%20Barilla');
  assert.match(r.text, /name="code" value="0012345678905"/);
  assert.match(r.text, /Save, scan next/);
  r = await katie('/s/pantry/add', { method: 'POST', form: { code: '012345678905', name: 'Spaghetti', brand: 'Barilla', spot: 'Pantry', expires: '2027-05-01' } });
  assert.match(r.location, /^\/s\/pantry#p-/);
  const before = calls;
  d = await api('0012345678905', 'pantry');
  assert.equal(d.source, 'saved');
  assert.equal(calls, before, 'saved codes don’t go to the database');
  assert.equal(d.pantry[0].status, 'have');
  await withDb(app.uri, async () => {
    const c = await CatalogItem.findOne({ key: 'spaghetti' }).lean();
    assert.deepEqual(c.barcodes, ['0012345678905']);
    assert.equal(c.brand, 'Barilla');
    await PantryItem.updateOne({ key: 'spaghetti' }, { $set: { status: 'low' } });
  });
  // Scanning one that's there: replace it (restocked), and scan the next one.
  const pid = await withDb(app.uri, async () => String((await PantryItem.findOne({ key: 'spaghetti' }).lean())._id));
  assert.match((await katie('/s/pantry/add?name=Spaghetti&code=0012345678905')).text, /Spaghetti is already in the pantry/);
  r = await katie('/s/pantry/add', { method: 'POST', form: { code: '0012345678905', name: 'Spaghetti', choice: `replace:${pid}`, again: '1', expires: '2027-06-01' } });
  assert.equal(r.location, '/s/pantry?scan=1');
  await withDb(app.uri, async () => {
    const p = await PantryItem.findOne({ key: 'spaghetti' }).lean();
    assert.deepEqual([p.status, p.expires], ['have', '2027-06-01']);
  });
  assert.match((await katie('/s/pantry')).text, /Spaghetti: restocked/);

  // Unknown code: named once, then remembered.
  d = await api('4006381333931', 'shopping');
  assert.equal(d.source, null);
  await katie('/s/shopping/scan', { method: 'POST', form: { code: '4006381333931', name: 'Highlighters', action: 'add' } });
  d = await api('4006381333931', 'shop');
  assert.equal(d.name, 'Highlighters');
  assert.equal(d.onList.bought, false);
  // Adding twice says so.
  await katie('/s/shopping/scan', { method: 'POST', form: { code: '4006381333931', name: 'Highlighters', action: 'add' } });
  assert.match((await katie('/s/shopping')).text, /already on the list/);
  await withDb(app.uri, async () => assert.equal(await ShoppingItem.countDocuments({ key: 'highlighters' }), 1));

  // Shopping mode: tick it off; stays in shopping mode with the scanner open next.
  r = await katie('/s/shopping/scan', { method: 'POST', form: { code: '4006381333931', name: 'Highlighters', action: 'tick', again: '1' } });
  assert.equal(r.location, '/s/shopping?mode=shop&scan=1');
  await withDb(app.uri, async () => assert.equal((await ShoppingItem.findOne({ key: 'highlighters' }).lean()).bought, true));
  // Not on the list: added as bought, and it waits to be put away in the pantry.
  await katie('/s/shopping/scan', { method: 'POST', form: { code: '0012345678905', name: 'Spaghetti', action: 'bought', again: '1' } });
  await withDb(app.uri, async () => {
    const s = await ShoppingItem.findOne({ key: 'spaghetti' }).lean();
    assert.deepEqual([s.bought, s.putAway], [true, 'pending']);
  });
  // A code moves to whichever item it was last saved as.
  await katie('/s/shopping/scan', { method: 'POST', form: { code: '4006381333931', name: 'Markers', action: 'add' } });
  assert.equal((await api('4006381333931', 'shopping')).name, 'Markers');
});
