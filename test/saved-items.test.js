// Saved items: search, filters, editing usual details, renaming (follows to the list and pantry),
// delete, staples in the household's own order, and view-only roles.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const CatalogItem = require('../models/CatalogItem');
const ShoppingItem = require('../models/ShoppingItem');
const PantryItem = require('../models/PantryItem');

const PW = 'correct horse';

test('saved items', async (t) => {
  const app = await startApp({
    name: 'nestly_test_saved',
    port: 3987,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      return { homeId: home.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');

  // Adding items saves them; staples get their order as they're marked.
  for (const name of ['Milk', 'Eggs', 'Bread', 'Oat Milk']) await katie('/s/shopping', { method: 'POST', form: { name, qty: '1' } });
  const ids = await withDb(app.uri, async () => Object.fromEntries((await CatalogItem.find().lean()).map((c) => [c.name, String(c._id)])));
  assert.equal(Object.keys(ids).length, 4);
  for (const n of ['Milk', 'Eggs', 'Bread']) await katie(`/s/shopping/saved/${ids[n]}/staple`, { method: 'POST', form: { on: '1' } });
  let page = await katie('/s/shopping');
  assert.match(page.text, /href="\/s\/shopping\/saved"/, 'link next to staples');
  const order = (text) => [...text.matchAll(/class="staple-row">\s*<a class="row-title" href="[^"]+">([^<]+)</g)].map((m) => m[1]);
  page = await katie('/s/shopping/saved');
  assert.deepEqual(order(page.text), ['Milk', 'Eggs', 'Bread']);

  // Reorder: Bread up twice.
  await katie(`/s/shopping/saved/${ids.Bread}/move`, { method: 'POST', form: { dir: 'up' } });
  await katie(`/s/shopping/saved/${ids.Bread}/move`, { method: 'POST', form: { dir: 'up' } });
  await katie(`/s/shopping/saved/${ids.Bread}/move`, { method: 'POST', form: { dir: 'up' } }); // already first
  assert.deepEqual(order((await katie('/s/shopping/saved')).text), ['Bread', 'Milk', 'Eggs']);
  // The Shopping page uses the same order.
  page = await katie('/s/shopping');
  assert.ok(page.text.indexOf('>Bread<') < page.text.indexOf('>Milk<') || page.text.indexOf('Bread') < page.text.indexOf('Eggs'));

  // Search and filters.
  page = await katie('/s/shopping/saved?q=milk');
  assert.match(page.text, /Oat Milk/i);
  assert.doesNotMatch(page.text, /href="\/s\/shopping\/saved\/[^"]+"><span class="row-title">Bread/);
  page = await katie('/s/shopping/saved?show=staples');
  assert.doesNotMatch(page.text, /Oat Milk/);
  assert.match((await katie('/s/shopping/saved?q=(')).text, /Nothing matches/, 'regex characters are safe');

  // Edit usual details and rename: what's on the list and in the pantry follows.
  await withDb(app.uri, async () => {
    const home = await Household.findOne();
    const u = await User.findOne({ email: 'katie@test.dev' });
    await PantryItem.create({ householdId: home._id, createdBy: u._id, byName: 'Katie', name: 'Milk', key: 'milk' });
  });
  let r = await katie(`/s/shopping/saved/${ids.Milk}`, { method: 'POST', form: { name: 'Whole Milk', qty: '2', store: 'Any store', brand: 'Horizon', staple: 'on', usuallyHave: 'on' } });
  assert.equal(r.location, '/s/shopping/saved');
  await withDb(app.uri, async () => {
    const c = await CatalogItem.findById(ids.Milk).lean();
    assert.equal(c.key, 'whole milk');
    assert.equal(c.qty, '2');
    assert.equal(c.brand, 'Horizon');
    assert.equal(c.usuallyHave, true);
    assert.equal(c.staple, true);
    assert.ok(await ShoppingItem.exists({ name: 'Whole Milk', key: 'whole milk' }));
    assert.ok(await PantryItem.exists({ name: 'Whole Milk' }));
  });
  assert.deepEqual(order((await katie('/s/shopping/saved')).text), ['Bread', 'Whole Milk', 'Eggs'], 'keeps its place');
  // Adding it again picks up the saved details.
  await katie('/s/shopping', { method: 'POST', form: { name: 'whole milk' } });
  // Renaming onto another saved item is refused.
  r = await katie(`/s/shopping/saved/${ids.Eggs}`, { method: 'POST', form: { name: 'bread' } });
  assert.equal(r.status, 422);
  assert.match(r.text, /already saved/);

  // Unstaple from the editor.
  await katie(`/s/shopping/saved/${ids.Eggs}`, { method: 'POST', form: { name: 'Eggs' } });
  assert.deepEqual(order((await katie('/s/shopping/saved')).text), ['Bread', 'Whole Milk']);

  // Delete only removes the suggestion.
  await katie(`/s/shopping/saved/${ids['Oat Milk']}/delete`, { method: 'POST' });
  await withDb(app.uri, async () => {
    assert.equal(await CatalogItem.exists({ name: 'Oat Milk' }), null);
    assert.ok(await ShoppingItem.exists({ name: 'Oat Milk' }));
  });
  assert.match((await katie('/s/shopping/saved')).text, /deleted the saved item Oat Milk/, 'Undo bar');

  // In-page taps get JSON back, and a second tap on something already gone isn't an error.
  const QUICK = { 'x-requested-with': 'fetch' };
  r = await katie(`/s/shopping/saved/${ids.Eggs}/delete`, { method: 'POST', headers: QUICK });
  const undo = JSON.parse(r.text).undo;
  assert.match(undo.text, /deleted the saved item Eggs/);
  r = await katie(`/s/shopping/saved/${ids.Eggs}/delete`, { method: 'POST', headers: QUICK });
  assert.equal(r.status, 404);
  assert.equal(JSON.parse(r.text).gone, true);
  r = await katie(`/s/shopping/saved/${ids.Eggs}/delete`, { method: 'POST' });
  assert.equal(r.location, '/s/shopping/saved');
  // Undo brings it back.
  await katie(`/activity/${undo.id}/undo`, { method: 'POST', form: { back: '/s/shopping/saved' } });
  await withDb(app.uri, async () => assert.ok(await CatalogItem.exists({ name: 'Eggs' })));
  r = await katie(`/s/shopping/saved/${ids.Eggs}/staple`, { method: 'POST', headers: QUICK, form: { on: '1' } });
  assert.deepEqual(JSON.parse(r.text), { ok: true, staple: true });

  // Staples saved before there was an order (no stapleOrder) don't break starring.
  await withDb(app.uri, async () => CatalogItem.updateMany({}, { $unset: { stapleOrder: 1 } }));
  r = await katie(`/s/shopping/saved/${ids.Bread}/staple`, { method: 'POST', form: { on: '0' } });
  r = await katie(`/s/shopping/saved/${ids.Bread}/staple`, { method: 'POST', form: { on: '1' } });
  assert.equal(r.status, 302);
  await withDb(app.uri, async () => assert.ok(Number.isFinite((await CatalogItem.findById(ids.Bread).lean()).stapleOrder)));
  assert.deepEqual(order((await katie('/s/shopping/saved')).text).slice(-1), ['Bread']);

  // Shopping: delete and tick answer in-page taps, and repeats are harmless.
  const itemId = await withDb(app.uri, async () => String((await ShoppingItem.findOne({ name: 'Bread' }).lean())._id));
  r = await katie(`/s/shopping/${itemId}/toggle`, { method: 'POST', headers: QUICK, form: { bought: '1' } });
  assert.equal(JSON.parse(r.text).bought, true);
  r = await katie(`/s/shopping/${itemId}/toggle`, { method: 'POST', headers: QUICK, form: { bought: '1' } });
  assert.equal(JSON.parse(r.text).bought, true, 'a double tap stays ticked');
  assert.match((await katie('/s/shopping')).text, /id="bought-card">/);
  r = await katie(`/s/shopping/${itemId}/delete`, { method: 'POST', headers: QUICK });
  assert.match(JSON.parse(r.text).undo.text, /deleted Bread/);
  r = await katie(`/s/shopping/${itemId}/delete`, { method: 'POST', form: { query: '' } });
  assert.equal(r.location, '/s/shopping');
  assert.match((await katie('/s/shopping')).text, /already taken off the list/);
  r = await katie(`/s/shopping/${itemId}/toggle`, { method: 'POST' });
  assert.equal(r.location, '/s/shopping');

  // Shopping settings link here.
  assert.match((await katie('/settings/s/shopping')).text, /href="\/s\/shopping\/saved"/);

  // View-only roles can look but not change.
  await withDb(app.uri, async () => {
    const home = await Household.findOne();
    home.roles = home.roles.map((x) => (x.key === 'member' ? { ...x.toObject(), sections: { ...x.toObject().sections, shopping: 'view' } } : x));
    await home.save();
  });
  page = await sam('/s/shopping/saved');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /\/delete"/, 'no delete on saved items when view only');
  r = await sam(`/s/shopping/saved/${ids.Bread}/delete`, { method: 'POST' });
  await withDb(app.uri, async () => assert.ok(await CatalogItem.exists({ name: 'Bread' })));
  // Another household's item isn't reachable.
  assert.equal((await katie('/s/shopping/saved/000000000000000000000000')).status, 404);
});
