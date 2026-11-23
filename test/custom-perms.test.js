// Custom permissions: a Child adds to Shopping but can't check off or start shopping; own vs.
// everyone's; page permissions; Today cards; and view-as on the Households page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Membership = require('../models/Membership');
const ShoppingItem = require('../models/ShoppingItem');
const Chore = require('../models/Chore');

const PW = 'correct horse';

test('custom permissions', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_custom_perms',
    port: 4015,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const second = await Household.create({ name: 'Cabin' });
      const hash = await User.hashPassword(PW);
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const mia = await User.create({ householdId: home._id, email: 'mia@test.dev', name: 'Mia', passwordHash: hash });
      await Membership.create({ userId: katie._id, householdId: second._id, role: 'admin' });
      const k = { householdId: home._id, createdBy: katie._id, byName: 'Katie' };
      const milk = await ShoppingItem.create({ ...k, name: 'Milk', key: 'milk' });
      await Chore.create({ ...k, title: 'Feed cat', date: today });
      return { homeId: home.id, miaId: mia.id, milkId: milk.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const mia = await signIn('mia@test.dev');
  await katie(`/settings/household/members/${app.seeded.miaId}/role`, { method: 'POST', form: { role: 'child' } });

  // The Child role starts with Shopping and Chores on Custom.
  let page = await katie('/settings/roles/child');
  assert.match(page.text, /name="s_shopping" value="custom" checked/);
  assert.match(page.text, /name="c_shopping_add" checked/);
  assert.doesNotMatch(page.text, /name="c_shopping_check" checked/);

  // Shopping as a Child: add yes; check off, start shopping, and deleting others' no.
  page = await mia('/s/shopping');
  assert.match(page.text, /action="\/s\/shopping\/quick"/);
  assert.doesNotMatch(page.text, /Start shopping/);
  assert.doesNotMatch(page.text, /\/toggle"/);
  assert.doesNotMatch(page.text, /swipe-delete/, 'Milk is Katie’s');
  let r = await mia(`/s/shopping/${app.seeded.milkId}/toggle`, { method: 'POST', form: { bought: '1' } });
  assert.equal(r.status, 303);
  assert.match((await mia('/s/shopping')).text, /can’t check things off as bought/);
  await withDb(app.uri, async () => assert.equal((await ShoppingItem.findById(app.seeded.milkId).lean()).bought, false));
  assert.equal((await mia('/s/shopping/start', { method: 'POST' })).status, 303);
  assert.doesNotMatch((await mia('/s/shopping?mode=shop')).text, /Shopping<\/strong>/, 'no shopping mode');
  await mia(`/s/shopping/${app.seeded.milkId}/delete`, { method: 'POST' });
  await withDb(app.uri, async () => assert.ok(await ShoppingItem.exists({ _id: app.seeded.milkId }), 'not hers to delete'));
  await mia('/s/shopping/quick', { method: 'POST', form: { name: 'Cookies' } });
  const cookies = await withDb(app.uri, async () => String((await ShoppingItem.findOne({ key: 'cookies' }))._id));
  assert.match((await mia('/s/shopping')).text, new RegExp(`/s/shopping/${cookies}/delete`), 'her own she can delete');
  await mia(`/s/shopping/${cookies}/delete`, { method: 'POST' });
  await withDb(app.uri, async () => assert.equal(await ShoppingItem.countDocuments({ key: 'cookies' }), 0));
  // Fetch (in-page) requests get a JSON refusal.
  r = await mia(`/s/shopping/${app.seeded.milkId}/toggle`, { method: 'POST', form: { bought: '1' }, headers: { 'X-Requested-With': 'fetch' } });
  assert.equal(r.status, 403);

  // Chores: done yes, adding no.
  assert.match((await mia('/s/chores')).text, /\/done"/);
  await mia('/s/chores', { method: 'POST', form: { title: 'Nap', repeat: 'none', date: today } });
  await withDb(app.uri, async () => assert.equal(await Chore.countDocuments({ title: /Nap/ }), 0));

  // Katie changes the Child role: let them check off; turn off Search; no Use soon on Today.
  page = await katie('/settings/roles/child');
  const form = [['name', 'Child']];
  for (const m of page.text.matchAll(/name="(s_\w+)" value="(\w+)" checked/g)) form.push([m[1], m[2]]);
  for (const m of page.text.matchAll(/name="(c_\w+)" checked/g)) form.push([m[1], 'on']);
  form.push(['c_shopping_check', 'on'], ['c_shopping_edit', 'own'], ['c_shopping_delete', 'own'], ['c_chores_edit', 'none'], ['c_chores_delete', 'none']);
  form.push(['p_spending', 'on'], ['p_feedback', 'on']); // search and households off
  for (const k of ['attention', 'shopping', 'remember', 'meals', 'upcoming', 'chores']) form.push(['cards', k]);
  await katie('/settings/roles/child', { method: 'POST', form });
  await mia(`/s/shopping/${app.seeded.milkId}/toggle`, { method: 'POST', form: { bought: '1' } });
  await withDb(app.uri, async () => assert.equal((await ShoppingItem.findById(app.seeded.milkId).lean()).bought, true));
  assert.equal((await mia('/search?q=milk')).status, 404);
  assert.doesNotMatch((await mia('/')).text, /href="\/search"/);
  assert.match((await mia('/more')).text, /href="\/spending"/);
  assert.doesNotMatch((await mia('/')).text, /<h2>Use soon<\/h2>/);
  assert.doesNotMatch((await mia('/customize')).text, /Use soon/);
  assert.equal((await mia('/households', { method: 'POST', form: { name: 'Mine' } })).status, 404);

  // A second household of Katie's, to check View as covers every household, not just this one.
  await katie('/households', { method: 'POST', form: { name: 'Lake house' } });

  await katie('/households/switch', { method: 'POST', form: { id: app.seeded.homeId } });
  const otherId = (await katie('/households')).text.match(/name="id" value="([a-f0-9]{24})"/)[1];
  assert.notEqual(otherId, app.seeded.homeId);


  // View as Child: no delete, copy, start, or leave anywhere, for any household.
  await katie('/view-as', { method: 'POST', form: { role: 'child' } });
  page = await katie('/households');
  assert.doesNotMatch(page.text, /Delete Home|Delete Lake House/i);
  assert.doesNotMatch(page.text, /Start a new household|Leave /);
  assert.doesNotMatch(page.text, /· Admin/);
  assert.equal((await katie(`/households/${app.seeded.homeId}/delete`)).text.includes('Only an admin'), true);
  assert.equal((await katie(`/households/${otherId}/delete`)).text.includes('Only an admin'), true);
  r = await katie(`/households/${otherId}/delete`, { method: 'POST', form: { confirmName: "Lake house" } });
  assert.equal(r.status, 409);
  assert.equal((await katie('/households/copy')).status, 404);
  assert.equal((await katie('/households', { method: 'POST', form: { name: 'Sneaky' } })).status, 404);
  await katie('/view-as/exit', { method: 'POST' });
  page = await katie('/households');
  assert.match(page.text, /Start a new household/);
  assert.match(page.text, /Delete Lake House/i);

  // Switching household while viewing ends View as.
  await katie('/view-as', { method: 'POST', form: { role: 'child' } });
  await katie('/households/switch', { method: 'POST', form: { id: otherId } });
  assert.doesNotMatch((await katie('/')).text, /Viewing as/);
});
