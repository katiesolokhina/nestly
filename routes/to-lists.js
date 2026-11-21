// Lists: places to go, projects, things to watch, wishlists, packing lists, notes, and checklists.
// One section with a type per list, so it stays one place to look.
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const List = require('../models/List');
const { recordChange, visible } = require('../lib/changes');
const { logActivity } = require('../lib/activity');
const { membersOf: householdMembers } = require('../lib/members');
const { TYPES, TYPE_KEYS, ICONS, SORTS, sortsFor, MONTHS, placeStatus, seesClaims } = require('../lib/tolists');
const { todayIn, isDate, shortDay, diffDays } = require('../lib/dates');
const { isQuick } = require('../lib/quick');

const router = express.Router();
router.use('/s/lists', requireAuth, requireSection('lists'));
const SECTION = 'Lists';
const MAX_ITEMS = 500;
const body = (req) => req.body || {};
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isHttp = (v) => /^https?:\/\/\S+$/i.test(v);
const log = (req, list, text) => logActivity(req.user, { section: SECTION, text: `${req.user.name} ${text}`, private: list.private });

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return List.findOne({ _id: req.params.id, ...visible(req.user) });
}
const itemOf = (list, id) => (mongoose.isValidObjectId(id) ? list.items.id(id) : null);
const back = (list, extra = '') => `/s/lists/${list._id}${extra}`;

// ---------- All lists ----------
router.get('/s/lists', async (req, res, next) => {
  try {
    const type = TYPE_KEYS.includes(req.query.type) ? req.query.type : '';
    const q = String(req.query.q || '').trim().slice(0, 60);
    const order = ['recent', 'az', 'type'].includes(req.query.order) ? req.query.order : 'recent';
    const re = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const lists = await List.find({ ...visible(req.user), ...(type ? { type } : {}), ...(re ? { $or: [{ title: re }, { body: re }, { 'items.text': re }, { 'items.note': re }] } : {}) }, { items: 1, title: 1, type: 1, private: 1, ownerName: 1, date: 1, endDate: 1, body: 1, pinned: 1, updatedAt: 1, ownerId: 1, createdBy: 1 })
      .sort({ pinned: -1, updatedAt: -1 }).lean();
    if (order === 'az') lists.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title));
    if (order === 'type') lists.sort((a, b) => TYPE_KEYS.indexOf(a.type) - TYPE_KEYS.indexOf(b.type) || a.title.localeCompare(b.title));
    const counts = await List.aggregate([{ $match: visible(req.user) }, { $group: { _id: '$type', n: { $sum: 1 } } }]);
    res.render('lists/index', {
      active: 'lists', type, q, order, TYPES, ICONS,
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
      lists: lists.map((l) => {
        const open = l.items.filter((i) => !i.done).length;
        const meta = l.type === 'note' ? l.body.split('\n')[0].slice(0, 80)
          : l.type === 'packing' && l.date ? `${shortDay(l.date)}${l.endDate && l.endDate !== l.date ? ` – ${shortDay(l.endDate)}` : ''} · ${l.items.length - open} of ${l.items.length} packed`
            : l.items.length ? `${open} ${TYPES[l.type].undone.toLowerCase()}${l.items.length - open ? ` · ${l.items.length - open} ${TYPES[l.type].done.toLowerCase()}` : ''}` : 'Empty';
        const hit = re && !re.test(l.title) ? (l.items.find((i) => re.test(i.text) || re.test(i.note || '')) || {}).text : '';
        return { ...l, meta: [l.type === 'wishlist' && l.ownerName ? `${l.ownerName}’s` : '', hit ? `Has ${hit}` : meta].filter(Boolean).join(' · ') };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- One list: new, show, edit, delete ----------
async function readList(req, list) {
  const b = body(req);
  const values = {
    title: str(b.title, 80),
    private: b.private === 'on' && req.perms.private,
    pinned: b.pinned === 'on',
  };
  if (!list) values.type = TYPE_KEYS.includes(b.type) ? b.type : 'checklist';
  const type = list ? list.type : values.type;
  if (type === 'note') values.body = str(b.body, 10000);
  if (type === 'watch') values.kind = ['movie', 'show'].includes(b.kind) ? b.kind : '';
  if (type === 'wishlist') {
    const members = await householdMembers(req.user.householdId);
    const owner = members.find((m) => String(m._id) === String(b.ownerId)) || members.find((m) => String(m._id) === String(req.user._id));
    values.ownerId = owner ? owner._id : req.user._id;
    values.ownerName = owner ? owner.name : req.user.name;
  }
  if (type === 'packing') {
    values.date = isDate(b.date) ? b.date : '';
    values.endDate = values.date && isDate(b.endDate) && b.endDate >= values.date ? b.endDate : '';
  }
  let error = values.title ? null : 'Give the list a name.';
  if (!error && type === 'note' && !values.title) error = 'Give the note a title.';
  return { values, error };
}

const formView = async (req, item, error) => ({ active: 'lists', item, error: error || null, TYPES, members: item.type === 'wishlist' ? await householdMembers(req.user.householdId) : [] });

router.get('/s/lists/new', async (req, res, next) => {
  try {
    const type = TYPE_KEYS.includes(req.query.type) ? req.query.type : 'checklist';
    res.render('lists/form', await formView(req, { _id: null, type, title: '', body: '', private: false, pinned: false, ownerId: req.user._id, date: '', endDate: '', kind: '' }));
  } catch (err) {
    next(err);
  }
});

router.post('/s/lists', async (req, res, next) => {
  try {
    const { values, error } = await readList(req, null);
    if (error) return res.status(422).render('lists/form', await formView(req, { _id: null, ...values }, error));
    const list = new List({ ...values, householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name });
    // Items typed on the new-list form (one per line).
    const lines = String(body(req).items || '').split(/\r?\n/).map((s) => s.trim().slice(0, 160)).filter(Boolean).slice(0, MAX_ITEMS);
    lines.forEach((text) => list.items.push({ text, addedBy: req.user.name, kind: list.kind || '' }));
    await list.save();
    await recordChange(req, { kind: 'create', model: 'List', doc: list, section: SECTION, text: `made the list ${list.title}`, label: list.title });
    res.redirect(back(list));
  } catch (err) {
    next(err);
  }
});

router.get('/s/lists/:id', async (req, res, next) => {
  try {
    const list = await find(req);
    if (!list) return res.status(404).send('Not found');
    const l = list.toObject();
    const claims = seesClaims(l, req.user);
    const members = l.type === 'watch' || l.type === 'wishlist' ? await householdMembers(req.user.householdId) : [];
    const nameOf = (id) => (members.find((m) => String(m._id) === String(id)) || {}).name || '';
    const today = todayIn(req.user.timezone);
    const q = String(req.query.q || '').trim().slice(0, 60).toLowerCase();
    const sort = sortsFor(l.type).includes(l.sort) ? l.sort : 'added';
    const items = l.items.filter((i) => !q || `${i.text} ${i.note} ${i.address} ${i.where}`.toLowerCase().includes(q)).map((i) => ({
      ...i,
      wanters: (i.wantIds || []).map(nameOf).filter(Boolean),
      doneDay: i.doneAt ? shortDay(i.doneAt) : '',
      // A wishlist owner never sees claims; others see who's getting it.
      claim: claims && i.claimedBy ? (String(i.claimedBy) === String(req.user._id) ? 'You’re getting this' : `${i.claimedName} is getting this`) : '',
      mine: claims && String(i.claimedBy) === String(req.user._id),
      claimable: claims && !i.claimedBy && !i.done,
      maps: i.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(i.address)}` : '',
      plan: `/s/calendar/new?${new URLSearchParams({ title: i.text, ...(i.address ? { location: i.address } : {}), ...(i.link || i.ticketLink ? { link: i.link || i.ticketLink } : {}), ...(i.startDate && i.startDate > today ? { date: i.startDate } : {}) })}`,
      place: l.type === 'places' ? placeStatus(i, today, { shortDay, diffDays }) : null,
      releaseText: i.release ? (i.release > today ? `Out ${shortDay(i.release)}` : `Released ${shortDay(i.release)}`) : '',
      upcoming: Boolean(i.release && i.release > today),
    }));
    const byName = (a, b) => a.text.localeCompare(b.text);
    const order = {
      added: () => 0,
      az: byName,
      newest: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
      soonest: (a, b) => (a.place ? a.place.sortKey : '').localeCompare(b.place ? b.place.sortKey : '') || byName(a, b),
      release: (a, b) => (a.release || '9999').localeCompare(b.release || '9999') || byName(a, b),
    }[sort];
    let open = items.filter((i) => !i.done).sort(order);
    const done = items.filter((i) => i.done).sort(order);
    // Places that are over, or out of season, wait in their own group.
    const later = l.type === 'places' ? open.filter((i) => i.place && ['later', 'over'].includes(i.place.when)) : [];
    if (later.length) open = open.filter((i) => !later.includes(i));
    // Watch: what's on now first.
    if (l.type === 'watch') open.sort((a, b) => Number(b.watching) - Number(a.watching));
    res.render('lists/show', {
      active: 'lists', list: l, T: TYPES[l.type], open, done, later, q, sort, sorts: sortsFor(l.type).map((k) => [k, SORTS[k]]), showDone: req.query.done === '1' || l.type === 'packing',
      isOwner: String(l.ownerId || l.createdBy) === String(req.user._id),
      tripText: l.date ? `${shortDay(l.date)}${l.endDate && l.endDate !== l.date ? ` – ${shortDay(l.endDate)}` : ''}` : '',
      trip: l.type === 'packing' && l.date ? `/s/calendar/new?${new URLSearchParams({ title: l.title, date: l.date, ...(l.endDate ? { endDate: l.endDate } : {}), allDay: '1' })}` : '',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/s/lists/:id/edit', async (req, res, next) => {
  try {
    const list = await find(req);
    if (!list) return res.status(404).send('Not found');
    res.render('lists/form', await formView(req, list.toObject()));
  } catch (err) {
    next(err);
  }
});

router.post('/s/lists/:id', async (req, res, next) => {
  try {
    const list = await find(req);
    if (!list) return res.status(404).send('Not found');
    const { values, error } = await readList(req, list);
    if (error) return res.status(422).render('lists/form', await formView(req, { ...list.toObject(), ...values }, error));
    // Only the person who made a list can make it private or shared.
    if (String(list.createdBy) !== String(req.user._id)) delete values.private;
    const before = list.toObject();
    list.set(values);
    await list.save();
    await recordChange(req, { kind: 'update', model: 'List', doc: list, before, section: SECTION, text: `changed the list ${list.title}`, label: list.title });
    res.redirect(back(list));
  } catch (err) {
    next(err);
  }
});

router.post('/s/lists/:id/delete', async (req, res, next) => {
  try {
    const list = await find(req);
    if (!list) return res.status(404).send('Not found');
    const before = list.toObject();
    await list.deleteOne();
    await recordChange(req, { kind: 'delete', model: 'List', doc: before, before, section: SECTION, text: `deleted the list ${before.title}`, label: before.title });
    res.redirect('/s/lists');
  } catch (err) {
    next(err);
  }
});

// How the list is ordered (kept on the list, so everyone sees it the same way).
router.post('/s/lists/:id/sort', async (req, res, next) => {
  try {
    const list = await find(req);
    if (!list) return res.status(404).send('Not found');
    const sort = String(body(req).sort || '');
    if (sortsFor(list.type).includes(sort)) { list.sort = sort; await list.save(); }
    res.redirect(back(list));
  } catch (err) {
    next(err);
  }
});

// Packing: untick everything for the next trip. Any list: copy it (unticked, no claims).
router.post('/s/lists/:id/reset', async (req, res, next) => {
  try {
    const list = await find(req);
    if (!list) return res.status(404).send('Not found');
    list.items.forEach((i) => { i.done = false; i.doneAt = ''; i.doneBy = ''; });
    await list.save();
    await log(req, list, `unticked everything on ${list.title}`);
    req.session.flash = 'Everything is unticked.';
    res.redirect(back(list));
  } catch (err) {
    next(err);
  }
});

router.post('/s/lists/:id/copy', async (req, res, next) => {
  try {
    const list = await find(req);
    if (!list) return res.status(404).send('Not found');
    const l = list.toObject();
    const copy = new List({
      householdId: l.householdId, createdBy: req.user._id, byName: req.user.name, private: l.private && String(l.createdBy) === String(req.user._id),
      type: l.type, title: `${l.title} (copy)`.slice(0, 80), body: l.body, ownerId: l.ownerId, ownerName: l.ownerName,
      items: l.items.map((i) => ({ text: i.text, note: i.note, link: i.link, address: i.address, kind: i.kind, where: i.where, price: i.price, qty: i.qty, addedBy: req.user.name })),
    });
    await copy.save();
    await recordChange(req, { kind: 'create', model: 'List', doc: copy, section: SECTION, text: `copied ${l.title}`, label: copy.title });
    req.session.flash = 'Copied. Rename it for the new trip.';
    res.redirect(`/s/lists/${copy._id}/edit`);
  } catch (err) {
    next(err);
  }
});

router.post('/s/lists/:id/clear-done', async (req, res, next) => {
  try {
    const list = await find(req);
    if (!list) return res.status(404).send('Not found');
    const n = list.items.filter((i) => i.done).length;
    list.items = list.items.filter((i) => !i.done);
    await list.save();
    if (n) await log(req, list, `cleared ${n} done from ${list.title}`);
    res.redirect(back(list));
  } catch (err) {
    next(err);
  }
});

// ---------- Items ----------
// Add one or many: one per line (packing and checklists also split on commas).
router.post('/s/lists/:id/items', async (req, res, next) => {
  try {
    const list = await find(req);
    if (!list || list.type === 'note') return res.status(404).send('Not found');
    const split = ['packing', 'checklist'].includes(list.type) ? /[\r\n,]+/ : /[\r\n]+/;
    const texts = String(body(req).text || '').split(split).map((s) => s.trim().slice(0, 160)).filter(Boolean);
    if (!texts.length) return res.redirect(back(list));
    if (list.items.length + texts.length > MAX_ITEMS) { req.session.flash = `A list holds up to ${MAX_ITEMS}.`; return res.redirect(back(list)); }
    texts.forEach((text) => list.items.push({ text, addedBy: req.user.name, kind: list.kind || '' }));
    await list.save();
    await log(req, list, `added ${texts.length === 1 ? list.items[list.items.length - 1].text : `${texts.length} things`} to ${list.title}`);
    res.redirect(back(list, '#add'));
  } catch (err) {
    next(err);
  }
});

router.post('/s/lists/:id/items/:itemId/toggle', async (req, res, next) => {
  try {
    const list = await find(req);
    const item = list && itemOf(list, req.params.itemId);
    if (!item) return res.status(404).send('Not found');
    item.done = !item.done;
    item.doneAt = item.done ? todayIn(req.user.timezone) : '';
    item.doneBy = item.done ? req.user.name : '';
    if (item.done) item.watching = false;
    await list.save();
    // Wishlist: ticking off happens when it's been given, so it doesn't spoil a surprise.
    await log(req, list, `${item.done ? 'ticked off' : 'unticked'} ${item.text} on ${list.title}`);
    if (isQuick(req)) return res.json({ ok: true, done: item.done });
    res.redirect(back(list));
  } catch (err) {
    next(err);
  }
});

// Watch: started it.
router.post('/s/lists/:id/items/:itemId/watching', async (req, res, next) => {
  try {
    const list = await find(req);
    const item = list && itemOf(list, req.params.itemId);
    if (!item) return res.status(404).send('Not found');
    item.watching = !item.watching;
    await list.save();
    res.redirect(back(list));
  } catch (err) {
    next(err);
  }
});

// Wishlist: "I'm getting this", or let it go. Never logged, so the surprise holds.
router.post('/s/lists/:id/items/:itemId/claim', async (req, res, next) => {
  try {
    const list = await find(req);
    const item = list && itemOf(list, req.params.itemId);
    if (!item || !seesClaims(list, req.user)) return res.status(404).send('Not found');
    if (!item.claimedBy) { item.claimedBy = req.user._id; item.claimedName = req.user.name; }
    else if (String(item.claimedBy) === String(req.user._id)) { item.claimedBy = null; item.claimedName = ''; }
    else { req.session.flash = `${item.claimedName} is already getting this.`; return res.redirect(back(list)); }
    await list.save();
    res.redirect(back(list));
  } catch (err) {
    next(err);
  }
});

router.get('/s/lists/:id/items/:itemId', async (req, res, next) => {
  try {
    const list = await find(req);
    const item = list && itemOf(list, req.params.itemId);
    if (!item) return res.status(404).send('Not found');
    const members = list.type === 'watch' ? await householdMembers(req.user.householdId) : [];
    res.render('lists/item', { active: 'lists', list: list.toObject(), item: item.toObject(), T: TYPES[list.type], members, MONTHS, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/s/lists/:id/items/:itemId', async (req, res, next) => {
  try {
    const list = await find(req);
    const item = list && itemOf(list, req.params.itemId);
    if (!item) return res.status(404).send('Not found');
    const b = body(req);
    const values = { text: str(b.text, 160), note: str(b.note, 500), link: str(b.link, 1000) };
    if (list.type === 'places') {
      values.address = str(b.address, 200);
      values.startDate = isDate(b.startDate) ? b.startDate : '';
      values.endDate = isDate(b.endDate) && (!values.startDate || b.endDate >= values.startDate) ? b.endDate : '';
      values.seasonal = b.seasonal === 'on';
      values.months = values.seasonal ? [...new Set([].concat(b.months || []).map(Number).filter((m) => m >= 1 && m <= 12))].sort((x, y) => x - y) : [];
      values.tickets = b.tickets === 'on';
      values.price = values.tickets ? str(b.price, 20) : '';
      values.ticketLink = values.tickets ? str(b.ticketLink, 1000) : '';
      values.hours = str(b.hours, 120);
    }
    if (list.type === 'watch') {
      values.kind = ['movie', 'show'].includes(b.kind) ? b.kind : '';
      values.where = str(b.whereOther, 60) || str(b.where, 60);
      values.release = isDate(b.release) ? b.release : '';
      const ids = new Set([].concat(b.wantIds || []).map(String));
      values.wantIds = (await householdMembers(req.user.householdId)).filter((m) => ids.has(String(m._id))).map((m) => m._id);
    }
    if (list.type === 'wishlist') values.price = str(b.price, 20);
    if (list.type === 'packing') values.qty = str(b.qty, 20);
    let error = values.text ? null : 'Enter a name.';
    if (!error && ((values.link && !isHttp(values.link)) || (values.ticketLink && !isHttp(values.ticketLink)))) error = 'Enter a full link that starts with https://';
    if (!error && values.seasonal && !values.months.length) error = 'Pick the months it’s on, or untick Every year.';
    if (error) {
      const members = list.type === 'watch' ? await householdMembers(req.user.householdId) : [];
      return res.status(422).render('lists/item', { active: 'lists', list: list.toObject(), item: { ...item.toObject(), ...values }, T: TYPES[list.type], members, MONTHS, error });
    }
    item.set(values);
    await list.save();
    await log(req, list, `changed ${item.text} on ${list.title}`);
    res.redirect(back(list));
  } catch (err) {
    next(err);
  }
});

router.post('/s/lists/:id/items/:itemId/delete', async (req, res, next) => {
  try {
    const list = await find(req);
    const item = list && itemOf(list, req.params.itemId);
    if (!item) return res.status(404).send('Not found');
    const text = item.text;
    item.deleteOne();
    await list.save();
    await log(req, list, `removed ${text} from ${list.title}`);
    if (isQuick(req)) return res.json({ ok: true });
    res.redirect(back(list));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
