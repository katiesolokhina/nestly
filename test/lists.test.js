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

  // Places: dates, seasonal, tickets, hours; over or out of season moves to its own group.
  const { addDays } = require('../lib/dates');
  const { localToday } = require('./helpers');
  const today = localToday();
  const month = Number(today.slice(5, 7));
  const other = (month % 12) + 1 === month ? 1 : (month % 12) + 1; // next month
  await katie('/s/lists', { method: 'POST', form: { type: 'places', title: 'Holiday fun', items: 'Light show\nIce rink\nFair\nPumpkin patch' } });
  const fun = await listId('Holiday Fun');
  l = await one('Holiday Fun');
  const [show, rink, fair, patch] = l.items;
  await katie(`/s/lists/${fun}/items/${show._id}`, { method: 'POST', form: { text: 'Light show', startDate: addDays(today, -3), endDate: addDays(today, 4), tickets: 'on', price: '$25', ticketLink: 'https://tickets.example.com', hours: 'Thu–Sun 5–10 pm' } });
  await katie(`/s/lists/${fun}/items/${rink._id}`, { method: 'POST', form: { text: 'Ice rink', startDate: addDays(today, 10) } });
  await katie(`/s/lists/${fun}/items/${fair._id}`, { method: 'POST', form: { text: 'Fair', startDate: addDays(today, -30), endDate: addDays(today, -2) } });
  await katie(`/s/lists/${fun}/items/${patch._id}`, { method: 'POST', form: [['text', 'Pumpkin patch'], ['seasonal', 'on'], ['months', String(other)]] });
  assert.match((await katie(`/s/lists/${fun}/items/${patch._id}`, { method: 'POST', form: { text: 'Pumpkin patch', seasonal: 'on' } })).text, /Pick the months/);
  page = await katie(`/s/lists/${fun}`);
  assert.match(page.text, /row-meta late">Ends in 4 days/);
  assert.match(page.text, /Tickets \$25 · Thu–Sun 5–10 pm/);
  assert.match(page.text, /href="https:\/\/tickets\.example\.com"[^>]*>Tickets/);
  assert.match(page.text, /Starts /);
  const over = page.text.slice(page.text.indexOf('Over or out of season'));
  assert.match(over, /Fair<\/span>[\s\S]*Ended /);
  assert.match(over, /Pumpkin Patch<\/span>[\s\S]*Back in /);
  assert.match(page.text, /Plan it/);
  // Sort: ending soonest puts the light show first.
  await katie(`/s/lists/${fun}/sort`, { method: 'POST', form: { sort: 'soonest' } });
  page = await katie(`/s/lists/${fun}`);
  assert.ok(page.text.indexOf('Light Show') < page.text.indexOf('Ice Rink'));
  await katie(`/s/lists/${fun}/sort`, { method: 'POST', form: { sort: 'az' } });
  page = await katie(`/s/lists/${fun}`);
  assert.ok(page.text.indexOf('Ice Rink') < page.text.indexOf('Light Show'));

  // Watch: default kind for new ones, services from Settings, release dates, sort by release.
  await katie('/s/lists', { method: 'POST', form: { type: 'watch', title: 'Shows', kind: 'show', items: 'Severance\nThe Bear' } });
  const shows = await listId('Shows');
  l = await one('Shows');
  assert.deepEqual(l.items.map((i) => i.kind), ['show', 'show']);
  assert.match((await katie(`/s/lists/${shows}/items/${l.items[0]._id}`)).text, /<option>Apple TV\+<\/option>/);
  await katie('/settings/lists/watchServices', { method: 'POST', form: { action: 'add', name: 'Crunchyroll' } });
  assert.match((await katie('/settings/s/lists')).text, /Where to watch/);
  await katie(`/s/lists/${shows}/items/${l.items[0]._id}`, { method: 'POST', form: { text: 'Severance', kind: 'show', where: 'Apple TV+', release: addDays(today, 30) } });
  await katie(`/s/lists/${shows}/items/${l.items[1]._id}`, { method: 'POST', form: { text: 'The Bear', kind: 'show', where: 'Crunchyroll', release: addDays(today, -100) } });
  page = await katie(`/s/lists/${shows}`);
  assert.match(page.text, /Show · Apple TV\+ · Out /);
  assert.match(page.text, /Crunchyroll · Released /);
  await katie(`/s/lists/${shows}/sort`, { method: 'POST', form: { sort: 'release' } });
  page = await katie(`/s/lists/${shows}`);
  assert.ok(page.text.indexOf('The Bear') < page.text.indexOf('Severance'));

  // Search: the index finds lists by what's on them; a list searches its items.
  page = await katie('/s/lists?q=severance');
  assert.match(page.text, /Shows<\/span><span class="row-meta">Has Severance/);
  assert.doesNotMatch(page.text, /Holiday Fun/);
  page = await katie(`/s/lists/${fun}?q=rink`);
  assert.match(page.text, /Ice Rink/);
  assert.doesNotMatch(page.text, /Light Show/);
  assert.match((await katie('/s/lists?order=az')).text, /Beach Trip[\s\S]*Birthday/);
});
