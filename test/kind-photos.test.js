// Typed barcodes are looked up like scans (the kinds dropdown and Find or add), a kind's photo can
// be changed, and the main photo can be any kind's photo.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startApp, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const PantryItem = require('../models/PantryItem');
const CatalogItem = require('../models/CatalogItem');
const Upload = require('../models/Upload');

const PW = 'correct horse';
const SUN = '0057836012004';
const NS = '0068345700124';
const COCOA = '0074713000107';
// A 1×1 PNG.
const RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4XmM4IScHAAK2AQXNY+AbAAAAAElFTkSuQmCC', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('typed barcodes, kind photos, main photo', async (t) => {
  const off = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes(SUN)) return res.end(JSON.stringify({ status: 1, product: { product_name: 'Cherry Tomatoes', brands: 'Sunset', quantity: '10 oz' } }));
    res.end(JSON.stringify({ status: 0 }));
  }).listen(4065);
  t.after(() => off.close());
  const app = await startApp({
    name: 'nestly_test_kind_photos',
    port: 4066,
    env: { OFF_URL: 'http://127.0.0.1:4065' },
    async seed() {
      const home = await Household.create({ name: 'Home', setupStep: 0, pantrySpots: ['Fridge'] });
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword(PW) });
      const item = await PantryItem.create({ householdId: home._id, createdBy: katie._id, byName: 'Katie', status: 'have', name: 'Cherry Tomatoes', key: 'cherry tomatoes', spot: 'Fridge', batches: [{ count: 1, expires: '', kind: NS }] });
      await CatalogItem.create({ householdId: home._id, name: 'Cherry Tomatoes', key: 'cherry tomatoes', barcodes: [NS], kinds: [{ code: NS, name: 'Nature Sweet' }] });
      return { id: item.id };
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });
  const { id } = app.seeded;
  const cat = () => withDb(app.uri, () => CatalogItem.findOne({ key: 'cherry tomatoes' }).lean());
  const base = [['name', 'Cherry Tomatoes'], ['spot', 'Fridge'], ['status', 'have'], ['bCount', '1'], ['bExpires', ''], ['bKind', NS], ['savedShown', '1'], ['autoShop', 'on']];
  const save = (extra, files = []) => {
    const fd = new FormData();
    [...base, ...extra].forEach(([k, v]) => fd.append(k, v));
    files.forEach(([k, name, buf = PNG]) => fd.append(k, new Blob([buf], { type: 'image/png' }), name));
    return katie(`/s/pantry/${id}`, { method: 'POST', formData: fd });
  };

  // A typed code with no name takes it from Open Food Facts (minus the item's own words).
  await save([['kindAdd', SUN], ['kindAddName', '']]);
  let c = await cat();
  assert.deepEqual(c.kinds.map((k) => k.name), ['Nature Sweet', 'Sunset']);

  // The same picture twice is saved once (so it can't show twice in the picker).
  await save([], [[`kindPhoto_${NS}`, 'ns.png'], [`kindPhoto_${SUN}`, 'sun.png']]);
  c = await cat();
  assert.equal(String(c.kinds[0].photoId), String(c.kinds[1].photoId), 'identical photo reused');
  assert.equal(await withDb(app.uri, () => Upload.countDocuments({})), 1);
  // Each kind can get its own photo; the edit page then offers them as the main photo.
  await save([], [[`kindPhoto_${SUN}`, 'sun.png', RED]]);
  c = await cat();
  const [pNs, pSun] = c.kinds.map((k) => String(k.photoId || ''));
  assert.ok(pNs && pSun && pNs !== pSun, 'both kinds have photos');
  await save([['mainPhoto', pNs]]);
  let item = await withDb(app.uri, () => PantryItem.findById(id).lean());
  assert.equal(String(item.photoId), pNs);
  let page = await katie(`/s/pantry/${id}/edit`);
  assert.match(page.text, /Main photo/);
  assert.match(page.text, new RegExp(`name="mainPhoto" value="${pNs}" checked`));
  assert.match(page.text, new RegExp(`name="mainPhoto" value="${pSun}"`));
  assert.match(page.text, /Change photo/);
  await save([['mainPhoto', pSun]]);
  item = await withDb(app.uri, () => PantryItem.findById(id).lean());
  assert.equal(String(item.photoId), pSun, 'switched');
  // Only one of its kinds' photos counts.
  await save([['mainPhoto', '0123456789abcdef01234567']]);
  item = await withDb(app.uri, () => PantryItem.findById(id).lean());
  assert.equal(String(item.photoId), pSun);

  // Find or add: a barcode number goes to the add page like a scan.
  let r = await katie(`/s/pantry?q=${SUN}`);
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /\/s\/pantry\/add\?name=Cherry\+Tomatoes&code=0057836012004/);
  r = await katie('/s/pantry?q=0099999999998');
  assert.match(r.headers.get('location'), /found=Not\+found/);
  assert.match((await katie('/s/pantry')).text, /data-find-code hidden/);

  // Scanned before kinds: the barcode's kind takes the main photo instead of downloading a copy.
  const old = await withDb(app.uri, async () => {
    const h = (await PantryItem.findById(id).lean()).householdId;
    const up = await Upload.create({ householdId: h, file: 'cocoa.png', name: 'cocoa.png', type: 'image/png', size: 1 });
    const it = await PantryItem.create({ householdId: h, byName: 'Katie', status: 'have', name: 'Cocoa', key: 'cocoa', spot: 'Fridge', photoId: up._id, batches: [{ count: 1, expires: '' }] });
    await CatalogItem.create({ householdId: h, name: 'Cocoa', key: 'cocoa', barcodes: [COCOA] });
    return { id: String(it._id), photo: String(up._id) };
  });
  await katie('/s/pantry/add', { method: 'POST', form: { name: 'Cocoa', spot: 'Fridge', count: '1', expires: '', code: COCOA, brand: 'Ghirardelli', kindName: 'Ghirardelli', choice: `add:${old.id}` } });
  const cocoa = await withDb(app.uri, () => CatalogItem.findOne({ key: 'cocoa' }).lean());
  assert.equal(cocoa.kinds[0].name, 'Ghirardelli');
  assert.equal(String(cocoa.kinds[0].photoId), old.photo, 'the main photo, not a second copy');
  page = await katie(`/s/pantry/${old.id}/edit`);
  assert.doesNotMatch(page.text, /name="mainPhoto"/, 'one photo: no picker');
});
