// The Lists section: list types, items, wishlist surprises, packing, notes, and privacy.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const List = require('../models/List');
const Activity = require('../models/Activity');

const PW = 'correct horse';

test('lists', async (t) => {
  const app = await startApp({
    name: 'nestly_test_lists',
    port: 4009,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const sam = await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      const mia = await User.create({ householdId: home._id, email: 'mia@test.dev', name: 'Mia', passwordHash: hash });
      return { katieId: katie.id, samId: sam.id, miaId: mia.id };
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const [katie, sam, mia] = await Promise.all(['katie', 'sam', 'mia'].map((n) => signIn(`${n}@test.dev`)));
  await katie(`/settings/household/members/${app.seeded.miaId}/role`, { method: 'POST', form: { role: 'child' } });
  const listId = async (title) => withDb(app.uri, async () => String((await List.findOne({ title }))._id));
  const one = (title) => withDb(app.uri, () => List.findOne({ title }).lean());

  let page = await katie('/s/lists');
  assert.equal(page.status, 200);
  for (const label of ['Places to go', 'Projects', 'To watch', 'Wishlist', 'Packing', 'Checklist', 'Note']) assert.match(page.text, new RegExp(label));
  assert.match((await katie('/more')).text, /href="\/s\/lists"/);

  // Places: address, map, plan it on the calendar.
  await katie('/s/lists', { method: 'POST', form: { type: 'places', title: 'date nights', items: 'Sushi place\nBotanical garden' } });
  const places = await listId('Date Nights');
  let l = await one('Date Nights');
  assert.deepEqual(l.items.map((i) => i.text), ['Sushi Place', 'Botanical Garden']);
  await katie(`/s/lists/${places}/items/${l.items[1]._id}`, { method: 'POST', form: { text: 'Botanical garden', address: '8525 Garland Rd, Dallas' } });
  page = await katie(`/s/lists/${places}`);
  assert.match(page.text, /google\.com\/maps\/search/);
  const plan = page.text.match(/href="(\/s\/calendar\/new\?[^"]+)">Plan it/g).find((h) => h.includes('Botanical'));
  const cal = await katie(plan.replace(/^href="|">Plan it$/g, '').replace(/&amp;/g, '&'));
  assert.match(cal.text, /value="Botanical Garden"/);
  assert.match(cal.text, /value="8525 Garland Rd, Dallas"/);
  await katie(`/s/lists/${places}/items/${l.items[0]._id}/toggle`, { method: 'POST' });
  page = await katie(`/s/lists/${places}?done=1`);
  assert.match(page.text, /Been there <span class="muted">· 1/);

  // Wishlist: Mia's. Sam claims; Mia (the owner) never sees it, not even in Activity.
  await mia('/s/lists', { method: 'POST', form: { type: 'wishlist', title: 'birthday', ownerId: app.seeded.miaId, items: 'Lego set\nArt kit' } });
  const wish = await listId('Birthday');
  l = await one('Birthday');
  assert.equal(String(l.ownerId), app.seeded.miaId);
  page = await sam(`/s/lists/${wish}`);
  assert.match(page.text, /I’m getting this/);
  await sam(`/s/lists/${wish}/items/${l.items[0]._id}/claim`, { method: 'POST' });
  assert.match((await sam(`/s/lists/${wish}`)).text, /You’re getting this/);
  assert.match((await katie(`/s/lists/${wish}`)).text, /Sam is getting this/);
  page = await mia(`/s/lists/${wish}`);
  assert.doesNotMatch(page.text, /getting this/i);
  assert.equal((await mia(`/s/lists/${wish}/items/${l.items[1]._id}/claim`, { method: 'POST' })).status, 404, 'owner can’t claim');
  assert.doesNotMatch((await mia('/activity')).text, /getting|claim/i);
  assert.match((await katie(`/s/lists/${wish}/items/${l.items[0]._id}/claim`, { method: 'POST' })).location, /\/s\/lists\//);
  assert.match((await katie(`/s/lists/${wish}`)).text, /Sam is getting this/, 'someone else’s claim stays');

  // Packing: commas split, untick all, copy for a new trip, trip on the calendar.
  await katie('/s/lists', { method: 'POST', form: { type: 'packing', title: 'Beach trip', date: '2027-06-01', endDate: '2027-06-05' } });
  const pack = await listId('Beach Trip');
  await katie(`/s/lists/${pack}/items`, { method: 'POST', form: { text: 'sunscreen, towels, hats' } });
  l = await one('Beach Trip');
  assert.equal(l.items.length, 3);
  for (const i of l.items.slice(0, 2)) await katie(`/s/lists/${pack}/items/${i._id}/toggle`, { method: 'POST' });
  page = await katie(`/s/lists/${pack}`);
  assert.match(page.text, /Packed <span class="muted">· 2/);
  assert.match(page.text, /Add trip to calendar/);
  await katie(`/s/lists/${pack}/reset`, { method: 'POST' });
  assert.equal((await one('Beach Trip')).items.filter((i) => i.done).length, 0);
  const r = await katie(`/s/lists/${pack}/copy`, { method: 'POST' });
  assert.match(r.location, /\/edit$/);
  assert.equal((await one('Beach Trip (copy)')).items.length, 3);

  // Watch: who wants it, watching.
  await sam('/s/lists', { method: 'POST', form: { type: 'watch', title: 'movie night', items: 'the princess bride' } });
  const watch = await listId('Movie Night');
  l = await one('Movie Night');
  await sam(`/s/lists/${watch}/items/${l.items[0]._id}`, { method: 'POST', form: [['text', 'The Princess Bride'], ['kind', 'movie'], ['where', 'Disney+'], ['wantIds', app.seeded.katieId], ['wantIds', app.seeded.miaId]] });
  await sam(`/s/lists/${watch}/items/${l.items[0]._id}/watching`, { method: 'POST' });
  page = await sam(`/s/lists/${watch}`);
  assert.match(page.text, /Movie · Disney\+ · Watching · Wanted by Katie, Mia/);

  // Note, private: only Katie sees it, and search finds it for her.
  await katie('/s/lists', { method: 'POST', form: { type: 'note', title: 'Gate codes', body: 'Front gate 1234', private: 'on' } });
  const note = await listId('Gate Codes');
  assert.match((await katie(`/s/lists/${note}`)).text, /Front gate 1234/);
  assert.equal((await sam(`/s/lists/${note}`)).status, 404);
  assert.doesNotMatch((await sam('/s/lists')).text, /Gate Codes/);
  assert.match((await katie('/search?q=gate')).text, /Gate Codes/);
  assert.doesNotMatch((await sam('/search?q=gate')).text, /Gate Codes/);

  // Delete and undo.
  await katie(`/s/lists/${places}/delete`, { method: 'POST' });
  assert.equal(await one('Date Nights'), null);
  const undo = (await katie('/s/lists')).text.match(/\/activity\/([a-f0-9]{24})\/undo/);
  await katie(`/activity/${undo[1]}/undo`, { method: 'POST', form: { back: '/s/lists' } });
  assert.ok(await one('Date Nights'));
  await withDb(app.uri, async () => assert.ok(await Activity.exists({ section: 'Lists' })));
});
