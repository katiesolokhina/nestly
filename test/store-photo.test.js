// The pantry item's usual store (shared with its saved item, so Shopping uses it), and its
// reference photo on the Shopping list.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const PantryItem = require('../models/PantryItem');
const CatalogItem = require('../models/CatalogItem');
const ShoppingItem = require('../models/ShoppingItem');
const Upload = require('../models/Upload');

const PW = 'correct horse';

test('usual store and photo on shopping', async (t) => {
  const app = await startApp({
    name: 'nestly_test_store_photo',
    port: 4035,
    async seed() {
      const home = await Household.create({ name: 'Home', setupStep: 0, pantrySpots: ['Pantry'], stores: ['Kroger', 'Costco'] });
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword(PW) });
      const photo = await Upload.create({ householdId: home._id, createdBy: katie._id, file: 'x.jpg', name: 'x.jpg', type: 'image/jpeg', size: 10 });
      const oats = await PantryItem.create({ householdId: home._id, createdBy: katie._id, byName: 'Katie', name: 'Oats', key: 'oats', spot: 'Pantry', status: 'have', batches: [{ count: 1, expires: '' }], photoId: photo._id });
      return { oatsId: oats.id, photoId: photo.id };
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });

  let page = await katie(`/s/pantry/${app.seeded.oatsId}/edit`);
  assert.match(page.text, /<label for="store">Usually bought at<\/label>/);
  assert.match(page.text, /<option selected>Any store<\/option>/);

  const fd = new FormData();
  [['name', 'Oats'], ['spot', 'Pantry'], ['status', 'low'], ['bCount', '1'], ['bExpires', ''], ['store', 'Costco'], ['autoShop', 'on']].forEach(([k, v]) => fd.append(k, v));
  await katie(`/s/pantry/${app.seeded.oatsId}`, { method: 'POST', formData: fd });
  await withDb(app.uri, async () => {
    assert.equal((await CatalogItem.findOne({ key: 'oats' }).lean()).store, 'Costco', 'saved item has the store');
    assert.equal((await ShoppingItem.findOne({ key: 'oats' }).lean()).store, 'Costco', 'added to Shopping under it');
  });
  assert.match((await katie(`/s/pantry/${app.seeded.oatsId}/edit`)).text, /<option selected>Costco<\/option>/);
  // Not one of the household's stores: ignored.
  const bad = new FormData();
  [['name', 'Oats'], ['spot', 'Pantry'], ['status', 'low'], ['bCount', '1'], ['bExpires', ''], ['store', 'Nowhere']].forEach(([k, v]) => bad.append(k, v));
  await katie(`/s/pantry/${app.seeded.oatsId}`, { method: 'POST', formData: bad });
  await withDb(app.uri, async () => assert.equal((await CatalogItem.findOne({ key: 'oats' }).lean()).store, 'Costco'));

  // Shopping shows the pantry item's photo next to it.
  page = await katie('/s/shopping');
  assert.match(page.text, new RegExp(`class="row-thumb" href="/files/${app.seeded.photoId}/view\\?back=/s/shopping"><img src="/files/${app.seeded.photoId}" alt="Photo of Oats"`));
});
