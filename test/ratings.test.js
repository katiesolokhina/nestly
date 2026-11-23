// Ratings: everyone rates for themselves and sees everyone's; Never again warns on Shopping, on
// the add page, and on scans; "Buy again?" after buying; the choices in Settings; and permissions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const CatalogItem = require('../models/CatalogItem');
const ShoppingItem = require('../models/ShoppingItem');
const Rating = require('../models/Rating');

const PW = 'correct horse';
const CODE = '0012345678905';

test('ratings', async (t) => {
  const app = await startApp({
    name: 'nestly_test_ratings',
    port: 4027,
    async seed() {
      const home = await Household.create({ name: 'Home', setupStep: 0 });
      const hash = await User.hashPassword(PW);
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const naum = await User.create({ householdId: home._id, email: 'naum@test.dev', name: 'Naum', passwordHash: hash });
      const mia = await User.create({ householdId: home._id, email: 'mia@test.dev', name: 'Mia', passwordHash: hash });
      await CatalogItem.create({ householdId: home._id, name: 'Hot Cheese Puffs', key: 'hot cheese puffs', barcodes: [CODE] });
      return { naumId: naum.id, miaId: mia.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const naum = await signIn('naum@test.dev');
  const mia = await signIn('mia@test.dev');
  await katie(`/settings/household/members/${app.seeded.miaId}/role`, { method: 'POST', form: { role: 'child' } });

  // Naum rates it Never again; it's per person, by name (and so by its barcode too).
  await naum('/ratings', { method: 'POST', form: { name: 'hot cheese puffs', value: 'never', back: '/s/pantry' } });
  await withDb(app.uri, async () => assert.equal(await Rating.countDocuments({ key: 'hot cheese puffs', value: 'never' }), 1));

  // On Shopping, a warning under it.
  await katie('/s/shopping', { method: 'POST', form: { name: 'Hot Cheese Puffs', qty: '1' } });
  let page = await katie('/s/shopping');
  assert.match(page.text, /class="rate-warn">Naum: Never again</);

  // Scanning it in the store says so too.
  const scan = JSON.parse((await katie(`/api/barcode/${CODE}?for=shopping`)).text);
  assert.deepEqual(scan.warn, ['Naum: Never again']);

  // The add page warns, and Katie can rate it there.
  page = await katie('/s/pantry/add?name=Hot%20Cheese%20Puffs');
  assert.match(page.text, /class="rate-alert"[^>]*><strong>Naum: Never again<\/strong>/);
  assert.match(page.text, /name="rating" value="again"/);

  // Buying it: "Buy again?" on Pantry and Shopping, until rated or skipped.
  const id = await withDb(app.uri, async () => String((await ShoppingItem.findOne({ name: /cheese puffs/i }).lean())._id));
  await katie(`/s/shopping/${id}/toggle`, { method: 'POST', form: { bought: '1' } });
  page = await katie('/s/pantry');
  assert.match(page.text, /<h2>Buy again\?<\/h2>/);
  assert.match(page.text, /<p>Hot Cheese Puffs<\/p>/);
  await katie('/ratings', { method: 'POST', form: { name: 'Hot Cheese Puffs', value: 'again', from: 'prompt', back: '/s/pantry' } });
  assert.doesNotMatch((await katie('/s/pantry')).text, /Buy again\?<\/h2>/);
  // Both ratings show on its saved item, with Katie's own pressed.
  const savedId = await withDb(app.uri, async () => String((await CatalogItem.findOne({ key: 'hot cheese puffs' }).lean())._id));
  page = await katie(`/s/shopping/saved/${savedId}`);
  assert.match(page.text, /<span>Naum<\/span><b>Never again<\/b>/);
  assert.match(page.text, /value="clear" aria-pressed="true">Buy again</);

  // Settings: rename, add one, turn off the prompt.
  page = await katie('/settings/ratings');
  assert.match(page.text, /value="Never again"/);
  await katie('/settings/ratings', { method: 'POST', form: [
    ['id', 'again'], ['name', 'Love it'], ['color', 'green'],
    ['id', 'okay'], ['name', 'It’s okay'], ['color', 'yellow'],
    ['id', 'never'], ['name', 'Never again'], ['color', 'red'], ['warn', 'never'],
    ['id', 'new'], ['name', 'Kids only'], ['color', 'blue'],
  ] });
  await withDb(app.uri, async () => {
    const h = await Household.findOne().lean();
    assert.deepEqual(h.ratingChoices.map((c) => c.name), ['Love it', 'It’s okay', 'Never again', 'Kids only']);
    assert.equal(h.ratingPrompt, false);
  });
  assert.match((await katie(`/s/shopping/saved/${savedId}`)).text, /aria-pressed="true">Love it</);
  await katie(`/s/shopping/${id}/toggle`, { method: 'POST', form: { bought: '0' } });
  await katie(`/s/shopping/${id}/toggle`, { method: 'POST', form: { bought: '1' } });
  assert.doesNotMatch((await naum('/s/pantry')).text, /Buy again\?<\/h2>/, 'prompt off');

  // A Child sees ratings (Pantry is view only for them) but can't rate.
  assert.equal((await mia('/ratings', { method: 'POST', form: { name: 'Hot Cheese Puffs', value: 'never' } })).status, 404);
  // Only people who can change settings edit the choices.
  assert.equal((await naum('/settings/ratings')).status, 404);
});
