// Shopping, Remember, Calendar, Today, undo, lists, uploads, and privacy between people.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const ShoppingItem = require('../models/ShoppingItem');
const Upload = require('../models/Upload');
const Reminder = require('../models/Reminder');

const PW = 'correct horse';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// A multipart request, the way a browser sends a form with a file.
async function upload(app, cookieClient, url, fields, file) {
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  if (file) form.append(file.field, new Blob([file.bytes], { type: file.type }), file.name);
  const res = await fetch(app.base + url, { method: 'POST', redirect: 'manual', body: form, headers: { cookie: cookieClient.cookie, origin: app.base } });
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

test('sections', async (t) => {
  const app = await startApp({
    name: 'nestly_test_sections',
    port: 3994,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const other = await Household.create({ name: 'Other' });
      const hash = await User.hashPassword(PW);
      const mk = (householdId, email, name, role) => User.create({ householdId, email, name, role, passwordHash: hash });
      const katie = await mk(home._id, 'katie@test.dev', 'Katie', 'admin');
      const sam = await mk(home._id, 'sam@test.dev', 'Sam', 'member');
      await mk(home._id, 'mia@test.dev', 'Mia', 'member');
      await mk(other._id, 'other@test.dev', 'Other', 'admin');
      return { katieId: katie.id, samId: sam.id };
    },
  });
  t.after(() => app.stop());

  const signIn = async (email) => {
    const c = client(app.base);
    await c('/login', { method: 'POST', form: { email, password: PW } });
    return c;
  };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');
  const mia = await signIn('mia@test.dev');
  const other = await signIn('other@test.dev');
  const cookieOf = async (email) => {
    const res = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: app.base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password: PW }) });
    return { cookie: res.headers.get('set-cookie').split(';')[0] };
  };
  const item = (name) => withDb(app.uri, () => ShoppingItem.findOne({ name }).lean());
  let eggsId, bootsId;

  await t.test('quick add creates an item, logs it, and offers undo', async () => {
    assert.equal((await katie('/s/shopping/quick', { method: 'POST', form: { name: 'Eggs' } })).location, '/s/shopping');
    const page = await katie('/s/shopping');
    assert.match(page.text, /Eggs/);
    assert.match(page.text, /Katie added Eggs to Shopping/);
    assert.match(page.text, /Undo/);
    assert.doesNotMatch((await katie('/s/shopping')).text, />Undo</, 'the undo message shows once');
    eggsId = String((await item('Eggs'))._id);
    assert.match((await sam('/s/shopping')).text, /Eggs/, 'shared with the household');
    assert.match((await sam('/activity')).text, /Katie added Eggs/);
  });

  await t.test('new items land in a sensible aisle', async () => {
    await katie('/s/shopping/quick', { method: 'POST', form: { name: 'Bananas' } });
    assert.equal((await item('Bananas')).aisle, 'Produce');
    await katie('/s/shopping/quick', { method: 'POST', form: { name: 'Light bulbs' } });
    assert.equal((await item('Light bulbs')).aisle, 'Unassigned');
  });

  await t.test('adding a duplicate says so instead of doubling up', async () => {
    await sam('/s/shopping/quick', { method: 'POST', form: { name: 'eggs' } });
    assert.match((await sam('/s/shopping')).text, /already on the list/);
    assert.equal(await withDb(app.uri, () => ShoppingItem.countDocuments({ key: 'eggs' })), 1);
  });

  await t.test('details save, and the catalog reuses them next time', async () => {
    const r = await katie(`/s/shopping/${eggsId}`, { method: 'POST', form: { name: 'Eggs', qty: '24', price: '7.49', method: 'In person', store: 'Costco', aisle: 'Dairy & eggs', tag: 'Groceries', brand: 'Vital', staple: 'on' } });
    assert.equal(r.status, 302);
    const page = await katie('/s/shopping');
    assert.match(page.text, /edited Eggs/);
    assert.match(page.text, /Vital · Costco · \$7\.49/);
    assert.match(page.text, /\+ Eggs/, 'saved as a staple');
  });

  await t.test('bad input is rejected', async () => {
    const form = { name: 'Bad', method: 'Online', link: 'javascript:alert(1)' };
    assert.match((await katie('/s/shopping', { method: 'POST', form })).text, /starts with https/);
    assert.equal((await katie('/s/shopping', { method: 'POST', form: { name: '' } })).status, 422);
    assert.equal((await katie('/s/shopping', { method: 'POST', form: { name: 'X', price: '-3' } })).status, 422);
    await katie('/s/shopping', { method: 'POST', form: { name: '<script>x</script>', store: 'Not a real store' } });
    const page = await katie('/s/shopping');
    assert.doesNotMatch(page.text, /<script>x/);
    assert.equal((await item('<script>x</script>')).store, 'Any store');
  });

  await t.test('private items stay private everywhere', async () => {
    await katie('/s/shopping', { method: 'POST', form: { name: 'Hiking boots', method: 'Online', store: 'Target', link: 'https://www.rei.com/boots', private: 'on' } });
    const boots = await item('Hiking boots');
    bootsId = String(boots._id);
    const mine = await katie('/s/shopping');
    assert.match(mine.text, /Hiking boots/);
    assert.match(mine.text, /Only me/);
    assert.match(mine.text, /href="https:\/\/www\.rei\.com\/boots"/);
    assert.doesNotMatch((await sam('/s/shopping')).text, /Hiking boots/);
    assert.doesNotMatch((await sam('/activity')).text, /Hiking boots/);
    assert.doesNotMatch((await sam('/')).text, /Hiking boots/);
    assert.equal((await sam(`/s/shopping/${bootsId}/edit`)).status, 404);
    assert.equal((await sam(`/s/shopping/${bootsId}/toggle`, { method: 'POST', form: {} })).status, 404);
    assert.equal((await sam(`/s/shopping/${bootsId}/delete`, { method: 'POST', form: {} })).status, 404);
    assert.doesNotMatch((await sam('/s/shopping/new')).text, /Hiking boots/, 'private names stay out of shared suggestions');
    assert.equal((await other('/s/shopping')).text.includes('Eggs'), false, 'other households see nothing');
    assert.equal((await other(`/s/shopping/${eggsId}/edit`)).status, 404);
  });

  await t.test('undo is limited to visible entries, and only the person who can see it', async () => {
    const privateEntry = await withDb(app.uri, async () => require('../models/Activity').findOne({ text: /Hiking boots/ }).lean());
    assert.equal((await sam(`/activity/${privateEntry._id}/undo`, { method: 'POST', form: { back: '/' } })).status, 404);
    assert.ok(await item('Hiking boots'));
  });

  await t.test('undo restores a deleted item, and Restore works from Activity', async () => {
    await sam(`/s/shopping/${eggsId}/delete`, { method: 'POST', form: {} });
    assert.equal(await item('Eggs'), null);
    const log = await katie('/activity');
    assert.match(log.text, /Sam deleted Eggs/);
    assert.match(log.text, />Restore</);
    const id = log.text.match(/\/activity\/([a-f0-9]{24})\/undo/)[1];
    await katie(`/activity/${id}/undo`, { method: 'POST', form: { back: '/activity' } });
    assert.ok(await item('Eggs'));
    assert.equal((await item('Eggs')).brand, 'Vital', 'details came back too');
    const after = await katie('/activity');
    assert.match(after.text, /Katie restored Eggs/);
    assert.doesNotMatch(after.text, />Restore</, 'no second restore');
    await katie(`/activity/${id}/undo`, { method: 'POST', form: { back: '/activity' } });
    assert.match((await katie('/activity')).text, /already undone/);
  });

  await t.test('undo refuses to overwrite a newer change', async () => {
    await sam(`/s/shopping/${eggsId}`, { method: 'POST', form: { name: 'Eggs', qty: '12', method: 'In person', store: 'Costco', aisle: 'Dairy & eggs', tag: 'Groceries' } });
    const samEdit = await withDb(app.uri, () => require('../models/Activity').findOne({ actorName: 'Sam', text: /edited Eggs/ }).sort({ createdAt: -1 }).lean());
    await katie(`/s/shopping/${eggsId}`, { method: 'POST', form: { name: 'Eggs', qty: '36', method: 'In person', store: 'Costco', aisle: 'Dairy & eggs', tag: 'Groceries' } });
    await sam(`/activity/${samEdit._id}/undo`, { method: 'POST', form: { back: '/s/shopping' } });
    assert.match((await sam('/s/shopping')).text, /changed again/);
    assert.equal((await item('Eggs')).qty, '36');
  });

  await t.test('buying records who and when, and feeds price history', async () => {
    await katie(`/s/shopping/${eggsId}`, { method: 'POST', form: { name: 'Eggs', qty: '24', price: '7.49', method: 'In person', store: 'Costco', aisle: 'Dairy & eggs', tag: 'Groceries' } });
    await sam(`/s/shopping/${eggsId}/toggle`, { method: 'POST', form: {} });
    let page = await katie('/s/shopping');
    assert.match(page.text, /<h2>Bought<\/h2>/);
    assert.match(page.text, /Sam · Today/);
    assert.match((await katie('/activity')).text, /Sam bought Eggs at Costco/);
    await katie('/s/shopping/clear', { method: 'POST', form: {} });
    page = await katie('/s/shopping');
    assert.doesNotMatch(page.text, /<h2>Bought<\/h2>/);
    await katie('/s/shopping/quick', { method: 'POST', form: { name: 'Eggs' } });
    const fresh = await withDb(app.uri, () => ShoppingItem.findOne({ key: 'eggs', bought: false }).lean());
    assert.equal(fresh.store, 'Costco', 'catalog remembers the details');
    assert.match((await katie(`/s/shopping/${fresh._id}/edit`)).text, /Last paid \$7\.49 at Costco, Today/);
  });

  await t.test('filters and shopping mode narrow the list', async () => {
    await katie('/s/shopping', { method: 'POST', form: { name: 'Air fryer', method: 'Online', store: 'Target', tag: 'Home' } });
    let page = await katie('/s/shopping?method=Online');
    assert.match(page.text, /Air fryer/);
    assert.doesNotMatch(page.text, /aria-label="Edit Eggs"/);
    page = await katie('/s/shopping?store=Costco&mode=shop');
    assert.match(page.text, /Shopping at Costco/);
    assert.match(page.text, /aria-label="Edit Eggs"/);
    assert.doesNotMatch(page.text, /Air fryer/);
    assert.doesNotMatch(page.text, /Add an item/);
  });

  await t.test('receipts upload securely and respect privacy', async () => {
    const k = await cookieOf('katie@test.dev');
    const s = await cookieOf('sam@test.dev');
    const o = await cookieOf('other@test.dev');
    const base = { name: 'Lamp', method: 'In person', store: 'Any store', aisle: 'Unassigned', tag: 'Home' };
    let r = await upload(app, k, '/s/shopping', base, { field: 'receipt', bytes: Buffer.from('<svg onload="alert(1)"></svg>'), type: 'image/png', name: 'evil.png' });
    assert.equal(r.status, 422, 'content is checked, not the claimed type');
    assert.match(r.text, /Choose a JPG/);
    r = await upload(app, k, '/s/shopping', base, { field: 'receipt', bytes: Buffer.alloc(11 * 1024 * 1024, 0xff), type: 'image/jpeg', name: 'big.jpg' });
    assert.equal(r.status, 422);
    assert.match(r.text, /under 10 MB/);
    r = await upload(app, k, '/s/shopping', base, { field: 'receipt', bytes: PNG, type: 'image/png', name: '../../etc/rec"eipt.png' });
    assert.equal(r.status, 302);
    const lamp = await item('Lamp');
    const uploaded = await withDb(app.uri, () => Upload.findById(lamp.receiptId).lean());
    assert.doesNotMatch(uploaded.file, /\.\./);
    const get = (who, id) => fetch(`${app.base}/files/${id}`, { redirect: 'manual', headers: { cookie: who.cookie } });
    assert.equal((await get(k, lamp.receiptId)).status, 200);
    assert.equal((await get(s, lamp.receiptId)).status, 200, 'household can see shared receipts');
    assert.equal((await get(o, lamp.receiptId)).status, 404, 'other households cannot');
    assert.equal((await fetch(`${app.base}/files/${lamp.receiptId}`, { redirect: 'manual' })).status, 302, 'signed-out visitors cannot');
    assert.equal((await get(k, lamp.receiptId)).headers.get('x-content-type-options'), 'nosniff');
    const priv = await upload(app, k, '/s/shopping', { ...base, name: 'Secret', private: 'on' }, { field: 'receipt', bytes: PNG, type: 'image/png', name: 'r.png' });
    assert.equal(priv.status, 302);
    const secret = await item('Secret');
    assert.equal((await get(s, secret.receiptId)).status, 404, 'private receipts stay private');
    assert.equal((await fetch(`${app.base}/uploads/${uploaded.file}`)).status, 404, 'uploads are not public files');
    // Viewing stays inside the app, with a Back link that only goes to Nestly pages.
    const view = await fetch(`${app.base}/files/${lamp.receiptId}/view?back=/s/shopping/${lamp._id}/edit`, { headers: { cookie: k.cookie } });
    const viewHtml = await view.text();
    assert.match(viewHtml, new RegExp(`href="/s/shopping/${lamp._id}/edit">Back`));
    assert.match(viewHtml, /class="file-full"/);
    assert.doesNotMatch(viewHtml, /target="_blank"/);
    const evil = await (await fetch(`${app.base}/files/${lamp.receiptId}/view?back=//evil.example`, { headers: { cookie: k.cookie } })).text();
    assert.match(evil, /href="\/s\/shopping">Back/);
    assert.equal((await fetch(`${app.base}/files/${lamp.receiptId}/view`, { headers: { cookie: o.cookie } })).status, 404);
    assert.match((await get(k, lamp.receiptId)).headers.get('content-disposition'), /^inline/);
    assert.match((await fetch(`${app.base}/files/${lamp.receiptId}?download=1`, { headers: { cookie: k.cookie } })).headers.get('content-disposition'), /^attachment/);
    const list = await fetch(`${app.base}/s/shopping`, { headers: { cookie: k.cookie } });
    assert.doesNotMatch(await list.text(), /files\/[a-f0-9]{24}" target/);
    // Sam can edit a shared item without changing whose it is or making it private.
    await sam(`/s/shopping/${lamp._id}`, { method: 'POST', form: { name: 'Lamp', method: 'In person', store: 'Any store', aisle: 'Unassigned', tag: 'Home', private: 'on' } });
    assert.equal((await item('Lamp')).private, false);
  });

  await t.test('reminders: add details, edit, check off, undo, filter', async () => {
    const today = localToday();
    await katie('/s/remember', { method: 'POST', form: { text: 'Renew registration', details: 'Need the insurance card', date: today, category: 'Car' } });
    assert.match((await sam('/s/remember')).text, /Need the insurance card/);
    const r = await withDb(app.uri, () => Reminder.findOne({ text: 'Renew registration' }).lean());
    await sam(`/s/remember/${r._id}`, { method: 'POST', form: { text: 'Renew car registration', details: 'Card is in the glovebox', date: today, category: 'Car' } });
    assert.match((await katie('/s/remember')).text, /Renew car registration/);
    assert.match((await katie('/s/remember?category=Car')).text, /Renew car registration/);
    assert.doesNotMatch((await katie('/s/remember?category=Home')).text, /Renew car registration/);
    assert.match((await katie('/')).text, /Renew car registration/, 'due today appears on Today');
    await katie(`/s/remember/${r._id}/done`, { method: 'POST', form: { from: 'today' } });
    const page = await katie('/');
    assert.doesNotMatch(page.text.replace(/undo-bar[\s\S]*?<\/div>/, ''), /Renew car registration/);
    const id = page.text.match(/\/activity\/([a-f0-9]{24})\/undo/)[1];
    await katie(`/activity/${id}/undo`, { method: 'POST', form: { back: '/' } });
    assert.match((await katie('/')).text, /Renew car registration/);
    assert.equal((await katie('/s/remember', { method: 'POST', form: { text: '' } })).status, 422);
    await katie('/s/remember', { method: 'POST', form: { text: 'Secret party', category: 'Family', private: 'on' } });
    assert.doesNotMatch((await sam('/s/remember')).text, /Secret party/);
  });

  await t.test('calendar: events, yearly repeats, private events, and Today', async () => {
    const today = localToday();
    const [y, m, d] = today.split('-');
    const lastYear = `${Number(y) - 1}-${m}-${d}`;
    await katie('/s/calendar', { method: 'POST', form: { title: 'Sam birthday', date: lastYear, repeat: 'yearly', category: 'Birthdays' } });
    await katie('/s/calendar', { method: 'POST', form: { title: 'Dentist', date: today, time: '16:30', category: 'Appointments' } });
    await katie('/s/calendar', { method: 'POST', form: { title: 'Surprise', date: today, private: 'on' } });
    const month = await sam(`/s/calendar?day=${today}`);
    assert.match(month.text, /Sam birthday/);
    assert.match(month.text, /Every year/);
    assert.match(month.text, /4:30 PM/);
    assert.doesNotMatch(month.text, /Surprise/);
    const home = await katie('/');
    assert.match(home.text, /Dentist/);
    assert.match(home.text, /Surprise/);
    assert.doesNotMatch((await sam('/')).text, /Surprise/);
    assert.equal((await katie('/s/calendar', { method: 'POST', form: { title: 'x', date: '2026-02-30' } })).status, 422, 'impossible dates are refused');
    assert.equal((await katie('/s/calendar?month=bad&day=bad')).status, 200);
  });

  await t.test('calendar: times, locations, links, files, and repeats', async () => {
    const today = localToday();
    const bad = (form) => katie('/s/calendar', { method: 'POST', form: { title: 'x', date: today, ...form } });
    assert.match((await bad({ time: '18:00', endTime: '17:00' })).text, /end time must be after/);
    assert.match((await bad({ endTime: '17:00' })).text, /Add a start time/);
    assert.match((await bad({ endDate: '2000-01-01' })).text, /end date can/);
    assert.match((await bad({ repeat: 'daily', until: '2000-01-01' })).text, /Repeat until/);
    assert.match((await bad({ link: 'javascript:alert(1)' })).text, /starts with https/);

    await katie('/s/calendar', { method: 'POST', form: { title: 'Concert', date: today, time: '19:00', endTime: '22:30', location: 'AT&T Center, Dallas', link: 'https://tickets.example.com/abc', category: 'Family' } });
    await katie('/s/calendar', { method: 'POST', form: [['title', 'Gym class'], ['date', today], ['time', '07:00'], ['repeat', 'weekly'], ['interval', '1'], ['days', '1'], ['days', '3'], ['days', '5']] });
    await katie('/s/calendar', { method: 'POST', form: { title: 'All day fair', date: today, time: '10:00', allDay: 'on' } });
    const month = await sam(`/s/calendar?day=${today}`);
    assert.match(month.text, /7:00 PM – 10:30 PM · AT&amp;T Center, Dallas · Family/);
    assert.match(month.text, /All day fair<\/span><span class="row-meta">All day/);

    const Event = require('../models/Event');
    const gym = await withDb(app.uri, () => Event.findOne({ title: 'Gym class' }).lean());
    assert.deepEqual(gym.days, [1, 3, 5]);
    assert.match((await sam(`/s/calendar/${gym._id}`)).text, /Every week on Mon, Wed, Fri/);
    const concert = await withDb(app.uri, () => Event.findOne({ title: 'Concert' }).lean());
    const detail = await sam(`/s/calendar/${concert._id}?day=${today}`);
    assert.match(detail.text, /href="https:\/\/tickets\.example\.com\/abc"/);
    assert.match(detail.text, /google\.com\/maps\/search\/\?api=1&amp;query=AT%26T%20Center%2C%20Dallas/);
    assert.match((await katie('/')).text, new RegExp(`/s/calendar/${concert._id}\\?day=`), 'Today links to the details page');

    const k = await cookieOf('katie@test.dev');
    const r = await upload(app, k, `/s/calendar/${concert._id}`, { title: 'Concert', date: today, time: '19:00', endTime: '22:30', location: 'AT&T Center, Dallas', link: 'https://tickets.example.com/abc', category: 'Family' }, { field: 'file', bytes: Buffer.from('%PDF-1.4 tickets'), type: 'application/pdf', name: 'tickets.pdf' });
    assert.equal(r.location, `/s/calendar/${concert._id}`);
    const withFile = await sam(`/s/calendar/${concert._id}`);
    assert.match(withFile.text, /View tickets\.pdf/);
    assert.match(withFile.text, new RegExp(`back=/s/calendar/${concert._id}`));
    const ticketId = (await withDb(app.uri, () => Event.findById(concert._id).lean())).fileId;
    assert.equal((await sam(`/files/${ticketId}`)).status, 200);
    assert.equal((await other(`/files/${ticketId}`)).status, 404);
    // Making the event private makes its file private too.
    await upload(app, k, `/s/calendar/${concert._id}`, { title: 'Concert', date: today, private: 'on' });
    assert.equal((await sam(`/files/${ticketId}`)).status, 404);
    assert.equal((await katie(`/files/${ticketId}`)).status, 200);
  });

  await t.test('event categories have colors that follow renames, and new events start uncategorized', async () => {
    const today = localToday();
    assert.match((await katie('/s/calendar/new')).text, /<option selected>Uncategorized<\/option>/);
    await katie('/s/calendar', { method: 'POST', form: { title: 'Color check', date: today, time: '08:00', category: 'Birthdays' } });
    let page = await sam(`/s/calendar?day=${today}`);
    assert.match(page.text, /style="background:#b4236b"[^>]*><\/span><a[^>]*><span class="row-title">Color check/i, 'second palette color for Birthdays');
    await katie('/settings/lists/eventCats', { method: 'POST', form: { action: 'color', value: 'Birthdays', color: '#123456' } });
    assert.match((await sam(`/s/calendar?day=${today}`)).text, /background:#123456/);
    assert.match((await sam('/')).text, /background:#123456/, 'Today shows the color too');
    assert.equal((await katie('/settings/lists/eventCats', { method: 'POST', form: { action: 'color', value: 'Birthdays', color: 'red;}' } })).location, '/settings/s/calendar#eventCats');
    assert.match((await katie('/settings/s/calendar')).text, /Choose a color/);
    assert.equal((await katie('/settings/lists/stores', { method: 'POST', form: { action: 'color', value: 'Kroger', color: '#123456' } })).status, 404);
    await katie('/settings/lists/eventCats', { method: 'POST', form: { action: 'rename', value: 'Birthdays', name: 'Bdays' } });
    await katie('/settings/lists/eventCats', { method: 'POST', form: { action: 'up', value: 'Family' } });
    page = await sam(`/s/calendar?day=${today}`);
    assert.match(page.text, /background:#123456/, 'color kept through rename and reorder');
    assert.match(page.text, /Bdays/);
    await katie('/settings/lists/eventCats', { method: 'POST', form: { action: 'remove', value: 'Bdays' } });
    page = await sam(`/s/calendar?day=${today}`);
    assert.match(page.text, /background:#8e889c[^>]*><\/span><a[^>]*><span class="row-title">Color check/i, 'removed category falls back to gray Uncategorized');
  });

  await t.test('the calendar filters by category and keeps the filter while browsing', async () => {
    const today = localToday();
    await katie('/s/calendar', { method: 'POST', form: { title: 'Filter fam', date: today, category: 'Family' } });
    await katie('/s/calendar', { method: 'POST', form: { title: 'Filter none', date: today } });
    await katie('/s/remember', { method: 'POST', form: { text: 'Filter reminder', date: today } });
    const all = await sam(`/s/calendar?day=${today}`);
    for (const t of ['Filter fam', 'Filter none', 'Filter reminder']) assert.match(all.text, new RegExp(t));
    const fam = await sam(`/s/calendar?day=${today}&cat=Family`);
    assert.match(fam.text, /Filter fam/);
    assert.doesNotMatch(fam.text, /Filter none|Filter reminder/);
    assert.match(fam.text, /&amp;cat=Family" aria-label="Next month"|&cat=Family" aria-label="Next month"/);
    assert.match(fam.text, /new\?date=[\d-]+&amp;category=Family|new\?date=[\d-]+&category=Family/);
    assert.match((await sam('/s/calendar/new?category=Family')).text, /<option selected>Family<\/option>/);
    const none = await sam(`/s/calendar?day=${today}&cat=Uncategorized`);
    assert.match(none.text, /Filter none/);
    assert.doesNotMatch(none.text, /Filter fam/);
    assert.match((await sam(`/s/calendar?day=${today}&cat=Nope`)).text, /Filter reminder/, 'unknown categories show everything');
    const rem = await sam(`/s/calendar?day=${today}&show=reminders`);
    assert.match(rem.text, /Filter reminder/);
    assert.doesNotMatch(rem.text, /Filter fam|Filter none/);
    assert.match(rem.text, /show=reminders" aria-label="Next month"/);
    assert.match(rem.text, /background:#a77bc9/i, 'default reminder color');
    assert.equal((await sam('/settings/lists/reminder-color', { method: 'POST', form: { color: '#225588' } })).status, 404, 'members can’t change household settings');
    await katie('/settings/lists/reminder-color', { method: 'POST', form: { color: '#225588' } });
    assert.match((await katie(`/s/calendar?day=${today}`)).text, /background:#225588/);
    assert.match((await katie('/')).text, /background:#225588/, 'Today uses the reminder color');
    await katie('/settings/lists/reminder-color', { method: 'POST', form: { color: 'blue' } });
    assert.match((await katie('/settings/s/calendar')).text, /Choose a color/);
    assert.match((await katie('/activity')).text, /changed the color for reminders/);
  });

  await t.test('Today can be reordered and trimmed per person, and resets', async () => {
    const order = (html) => [...html.matchAll(/<h2>(Needs attention today|Coming up)<\/h2>|tile-label">([^<]+)</g)].map((x) => x[1] || x[2]);
    assert.deepEqual(order((await sam('/')).text), ['Needs attention today', 'on the shopping list', 'to remember', 'Coming up', 'bills due this week', 'low or out in the pantry']);
    await sam('/customize', { method: 'POST', form: { k: 'upcoming', action: 'up' } });
    await sam('/customize', { method: 'POST', form: { k: 'remember', action: 'toggle' } });
    await sam('/customize', { method: 'POST', form: { k: 'events', action: 'toggle' } });
    assert.deepEqual(order((await sam('/')).text), ['Needs attention today', 'on the shopping list', 'Coming up', 'events, next 7 days', 'bills due this week', 'low or out in the pantry']);
    assert.deepEqual(order((await mia('/')).text), ['Needs attention today', 'on the shopping list', 'to remember', 'Coming up', 'bills due this week', 'low or out in the pantry'], 'only changes your view');
    await sam('/customize', { method: 'POST', form: { action: 'reset' } });
    assert.deepEqual(order((await sam('/')).text), ['Needs attention today', 'on the shopping list', 'to remember', 'Coming up', 'bills due this week', 'low or out in the pantry']);
  });

  await t.test('lists: add, rename everywhere, reorder, and remove with a fallback', async () => {
    await katie('/settings/lists/stores', { method: 'POST', form: { action: 'add', name: 'Aldi' } });
    assert.match((await katie('/s/shopping/new')).text, /Aldi/);
    await katie('/settings/lists/stores', { method: 'POST', form: { action: 'add', name: 'aldi' } });
    assert.match((await katie('/settings/s/shopping')).text, /already in stores/);
    await katie('/settings/lists/stores', { method: 'POST', form: { action: 'rename', value: 'Costco', name: 'Costco Plano' } });
    assert.equal((await withDb(app.uri, () => ShoppingItem.findOne({ key: 'eggs', bought: false }).lean())).store, 'Costco Plano');
    await katie('/settings/lists/stores', { method: 'POST', form: { action: 'up', value: 'Aldi' } });
    const home = await withDb(app.uri, () => User.findById(app.seeded.katieId).lean().then((u) => Household.findById(u.householdId).lean()));
    assert.ok(home.stores.indexOf('Aldi') < home.stores.indexOf('Target'));
    await katie('/settings/lists/stores', { method: 'POST', form: { action: 'remove', value: 'Costco Plano' } });
    assert.equal((await withDb(app.uri, () => ShoppingItem.findOne({ key: 'eggs', bought: false }).lean())).store, 'Any store');
    await katie('/settings/lists/remCats', { method: 'POST', form: { action: 'add', name: 'School' } });
    assert.match((await sam('/s/remember/new')).text, /School/);
    assert.match((await sam('/activity')).text, /Katie removed Costco Plano from stores/);
    assert.doesNotMatch((await other('/s/shopping/new')).text, /Aldi/, 'lists belong to one household');
    assert.equal((await katie('/settings/lists/made-up', { method: 'POST', form: { action: 'add', name: 'x' } })).status, 404);
  });

  await t.test('a turned-off section blocks its pages and leaves Today', async () => {
    const keep = ['shopping', 'calendar', 'meals', 'recipes', 'pantry', 'bills', 'chores', 'info'].map((k) => ['sections', k]);
    await katie('/settings/sections', { method: 'POST', form: keep });
    assert.equal((await sam('/s/remember')).status, 404);
    assert.equal((await sam('/s/remember', { method: 'POST', form: { text: 'x' } })).status, 404);
    assert.doesNotMatch((await sam('/')).text, /to remember/);
    assert.doesNotMatch((await sam('/customize')).text, /To remember/);
    await katie('/settings/sections', { method: 'POST', form: [...keep, ['sections', 'remember']] });
    assert.equal((await sam('/s/remember')).status, 200);
  });

  await t.test('deleting an account removes their private items and keeps shared ones', async () => {
    await sam('/s/shopping', { method: 'POST', form: { name: 'Sam secret', private: 'on' } });
    await sam('/s/shopping/quick', { method: 'POST', form: { name: 'Sam shared' } });
    await katie(`/settings/household/members/${app.seeded.samId}/delete`, { method: 'POST', form: { confirmEmail: 'sam@test.dev' } });
    assert.equal(await item('Sam secret'), null);
    assert.equal(await withDb(app.uri, () => require('../models/Activity').countDocuments({ text: /Sam secret/ })), 0, 'no copy left in the log');
    assert.ok(await item('Sam shared'));
  });

  await t.test('a household made before these sections gets the default lists', async () => {
    const older = await withDb(app.uri, async () => {
      const h = await Household.create({ name: 'Older' });
      await Household.collection.updateOne({ _id: h._id }, { $unset: { stores: 1, aisles: 1, tags: 1, remCats: 1, eventCats: 1 } });
      await User.create({ householdId: h._id, email: 'older@test.dev', name: 'Older', role: 'admin', passwordHash: await User.hashPassword(PW) });
      await User.collection.updateOne({ email: 'older@test.dev' }, { $unset: { dashboard: 1 } });
    });
    assert.equal(older, undefined);
    const c = await signIn('older@test.dev');
    assert.match((await c('/s/shopping/new')).text, /Kroger/);
    assert.equal((await c('/')).status, 200);
    assert.equal((await c('/settings/lists/stores', { method: 'POST', form: { action: 'add', name: 'Aldi' } })).status, 302);
  });

  await t.test('section pages still building say so', async () => {
    assert.match((await katie('/s/chores')).text, /being built/);
  });
});
