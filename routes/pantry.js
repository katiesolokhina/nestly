const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const PantryItem = require('../models/PantryItem');
const CatalogItem = require('../models/CatalogItem');
const { recordChange, recordDeleteMany, visible } = require('../lib/changes');
const { logActivity } = require('../lib/activity');
const { pick } = require('../lib/lists');
const { keyOf, addToCatalog } = require('../lib/catalog');
const { addToShopping, expiryText, stockIn, countOf, quickStock, spotFor, boughtDay } = require('../lib/pantry');

// An item's batches, also for older items saved before there were any.
const batchesOf = (p) => p.batches || (p.status !== 'out' && p.count > 0 ? [{ count: p.count, expires: p.expires || '', bought: '' }] : []);
const ShoppingItem = require('../models/ShoppingItem');
const { remember, productPhotoUrl, productPhoto, CODE } = require('../lib/barcode');
const { ratingsFor, warnings, rate, askLater, nextPrompt } = require('../lib/ratings');
const { pantryNames } = require('../lib/prefs');
const { shortDay } = require('../lib/dates');
const Upload = require('../models/Upload');
const { parseFiles, saveUpload } = require('../lib/uploads');
const withPhoto = parseFiles(['photo']);
const STATUS_KEYS = ['have', 'low', 'out'];
const { todayIn, addDays, isDate } = require('../lib/dates');

const router = express.Router();
router.use('/s/pantry', requireAuth, requireSection('pantry'));
const SECTION = 'Pantry';

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return PantryItem.findOne({ _id: req.params.id, ...visible(req.user) });
}

// Keeps the filter after a change, without letting anything else into the address.
const backTo = (q) => {
  const s = String(q || '');
  return `/s/pantry${/^[\w%+=&.\-]*$/.test(s) && s ? `?${s}` : ''}`;
};

router.get('/s/pantry', async (req, res, next) => {
  try {
    const SOON_DAYS = req.household.pantrySoonDays || 3;
    const today = todayIn(req.user.timezone);
    const spots = [...req.household.pantrySpots];
    const show = ['low', 'soon'].includes(req.query.show) ? req.query.show : '';
    const spot = [...spots, 'Other'].includes(req.query.spot) ? req.query.spot : '';
    const filter = { ...visible(req.user) };
    if (show === 'low') filter.status = { $in: ['low', 'out'] };
    if (show === 'soon') filter.expires = { $ne: '', $lte: addDays(today, SOON_DAYS) };
    if (spot) filter.spot = spot;
    // Tags: show things with every picked tag.
    const tags = [...new Set([].concat(req.query.tag || []).map(String))].filter((t) => (req.household.pantryTags || []).includes(t));
    if (tags.length) filter.tags = { $all: tags };
    const canBulk = req.perms.parts('pantry').delete === 'all' || req.perms.parts('pantry').edit === 'all';
    const selecting = req.query.select === '1' && canBulk;
    const [putAway, items, catalog, counts] = await Promise.all([
      // Bought on Shopping and waiting to be put away (the last two weeks).
      req.perms.level('pantry') === 'edit' ? ShoppingItem.find({ ...visible(req.user), bought: true, putAway: 'pending', boughtAt: { $gte: new Date(Date.now() - 14 * 86400000) } }, { name: 1, qty: 1, boughtByName: 1, boughtAt: 1 }).sort({ boughtAt: -1 }).limit(30).lean() : [],
      PantryItem.find(filter).collation({ locale: 'en' }).sort({ name: 1 }).lean(),
      CatalogItem.find({ householdId: req.user.householdId }, { name: 1 }).sort({ name: 1 }).lean(),
      Promise.all([
        PantryItem.countDocuments({ ...visible(req.user), status: { $in: ['low', 'out'] } }),
        PantryItem.countDocuments({ ...visible(req.user), expires: { $ne: '', $lte: addDays(today, SOON_DAYS) } }),
      ]),
    ]);
    const rows = items.map((i) => {
      const exp = expiryText(i.expires, today, SOON_DAYS);
      const dated = batchesOf(i).filter((b) => b.expires).length;
      return { ...i, exp, meta: [i.count > 1 ? `${i.count} of them` : '', i.amount, exp.text + (dated > 1 ? ` (+${dated - 1} later)` : ''), i.autoShop ? '' : 'Not added to shopping'].filter(Boolean).join(' · ') };
    });
    const order = [...spots, 'Other'];
    const groups = order
      .map((name) => ({ name, items: rows.filter((r) => r.spot === name || (name === 'Other' && !spots.includes(r.spot))) }))
      .filter((g) => g.items.length);
    const params = new URLSearchParams(Object.entries({ show, spot }).filter(([, v]) => v));
    tags.forEach((t) => params.append('tag', t));
    const query = params.toString();
    // A tag chip's link: the same filters with that tag on or off.
    const tagLink = (t) => {
      const p = new URLSearchParams(Object.entries({ show, spot }).filter(([, v]) => v));
      (tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]).forEach((x) => p.append('tag', x));
      if (selecting) p.set('select', '1');
      return `/s/pantry${p.toString() ? `?${p}` : ''}`;
    };
    const ratePrompt = await nextPrompt(req);
    res.render('pantry/list', {
      active: 'pantry', ratePrompt, groups, tags, tagLink, selecting, canBulk, catalog, show, spot, query, total: items.length, putAway: putAway.map((s) => ({ ...s, meta: [s.qty && s.qty !== '1' ? s.qty : '', `bought by ${s.boughtByName}`, shortDay(boughtDay(req.user, s))].filter(Boolean).join(' · ') })),
      lowCount: counts[0], soonCount: counts[1], STATUS: pantryNames(req.household), soonDays: SOON_DAYS, shoppingOn: req.sees('shopping') && req.household.pantryShop !== 'never', defaultSpot: req.household.pantrySpots.includes(req.household.pantryDefaultSpot) ? req.household.pantryDefaultSpot : '',
    });
  } catch (err) {
    next(err);
  }
});

// One tap: Have, Low, or Out. Low and Out put it on the shopping list.
router.post('/s/pantry/:id/status', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const status = STATUS_KEYS.includes(req.body.status) ? req.body.status : item.status;
    if (status !== item.status) {
      if (status === 'out') item.batches = []; // none left
      else if (!batchesOf(item).length) item.batches = [{ count: 1, expires: '' }]; // Have or Low means at least one
      item.set({ status, statusBy: req.user.name, statusAt: new Date() });
      await item.save();
      const added = await addToShopping(req.user, req.household, item);
      await logActivity(req.user, { section: SECTION, text: `${req.user.name} marked ${item.name} ${pantryNames(req.household)[status]}${added ? ' and added it to Shopping' : ''}` });
      if (added) req.session.flash = `${item.name} is on the shopping list now.`;
      if (status === 'out') askLater(req, [item]);
    }
    res.redirect(`${backTo(req.body.query)}#p-${item._id}`);
  } catch (err) {
    next(err);
  }
});

// Tags ticked on a form, keeping only the household's own.
const tagsFrom = (req, b) => [...new Set([].concat(b.tags == null ? [] : b.tags).map(String))].filter((t) => (req.household.pantryTags || []).includes(t));

function readForm(req) {
  const b = req.body || {};
  const values = {
    name: String(b.name || '').trim().slice(0, 80),
    spot: pick(req.household, 'pantrySpots', b.spot),
    status: STATUS_KEYS.includes(b.status) ? b.status : 'have',
    amount: String(b.amount || '').trim().slice(0, 40),
    autoShop: b.autoShop === 'on',
    food: b.food === 'yes' ? true : b.food === 'no' ? false : null,
    note: String(b.note || '').trim().slice(0, 300),
    tags: tagsFrom(req, b),
    store: b.store,
  };
  values.key = keyOf(values.name);
  // How many, by use-by date: one row each. A row with no count is left out.
  const counts = [].concat(b.bCount == null ? [] : b.bCount);
  const dates = [].concat(b.bExpires == null ? [] : b.bExpires);
  const boughts = [].concat(b.bBought == null ? [] : b.bBought);
  const today = todayIn(req.user.timezone);
  values.batches = counts
    .map((c, i) => ({ count: Math.min(999, Math.max(0, parseInt(c, 10) || 0)), expires: isDate(dates[i]) ? dates[i] : '', bought: isDate(boughts[i]) && boughts[i] <= today ? boughts[i] : '' }))
    .filter((x) => x.count > 0)
    .slice(0, 30);
  if (values.status === 'out') values.batches = [];
  else if (!values.batches.length) values.batches = [{ count: 1, expires: '' }]; // Have or Low means at least one
  return { values, error: values.name ? null : 'Enter the item’s name.' };
}

// "Milk · Fridge · 2 · use by Nov 20": how one existing item is described when choosing.
const describe = (p, STATUS) => [p.name, p.spot, p.count > 1 ? `${p.count} of them` : '', p.status !== 'have' ? STATUS[p.status] : '', p.expires ? `soonest use by ${shortDay(p.expires)}` : ''].filter(Boolean).join(' · ');
const sameAs = async (req, key) => (await PantryItem.find({ ...visible(req.user), key }).sort({ createdAt: 1 }).lean()).map((p) => ({ ...p, label: describe(p, pantryNames(req.household)) }));

// choice: "new", or "add:<id>" / "replace:<id>" for one of `existing`.
async function readChoice(req, existing) {
  const [how, id] = String((req.body || {}).choice || '').split(':');
  if (!['add', 'replace'].includes(how)) return { choice: 'new', target: null };
  const hit = existing.find((p) => String(p._id) === id);
  return hit ? { choice: how, target: await PantryItem.findById(hit._id) } : { choice: 'new', target: null };
}

// The store it's usually bought at. It lives on its saved item, so Shopping (and things added to
// the list when they run low) use the same one.
const ANY_STORE = 'Any store';
async function storeFor(req, key) {
  const c = key ? await CatalogItem.findOne({ householdId: req.user.householdId, key }, { store: 1 }).lean() : null;
  return c ? c.store : ANY_STORE;
}
async function saveStore(req, name, store) {
  if (store === undefined) return;
  const s = String(store);
  const key = keyOf(name);
  if (!key || (s !== ANY_STORE && !(req.household.stores || []).includes(s))) return;
  await CatalogItem.updateOne({ householdId: req.user.householdId, key }, { $set: { store: s }, $setOnInsert: { name } }, { upsert: true });
}

const formView = async (req, item, error, existing = []) => ({
  active: 'pantry', item: { ...item, batches: item.batches && item.batches.length ? item.batches : batchesOf(item) }, error: error || null, STATUS: pantryNames(req.household), existing, todayDate: todayIn(req.user.timezone),
  catalog: await CatalogItem.find({ householdId: req.user.householdId }, { name: 1 }).sort({ name: 1 }).lean(),
  photo: item.photoId ? await Upload.findOne({ _id: item.photoId, householdId: req.user.householdId }).lean() : null,
  stores: req.household.stores || [], store: item.store !== undefined ? item.store : await storeFor(req, item.key),
});

// Reference photo: a new one replaces the old; "Remove" takes it off.
async function applyPhoto(req, item) {
  if ((req.body || {}).removePhoto === 'on') item.photoId = null;
  const f = (req.files || {}).photo;
  if (f) item.photoId = (await saveUpload(req.user, f[0], { isPrivate: false, imagesOnly: true }))._id;
}

// Adding: a short form with the use-by date and how many, before anything is saved. If the same
// thing is already in the pantry, it asks: keep it separate, replace that one, or add to its count.
// Also where scans and "Put away" (things bought on Shopping) land.
router.get('/s/pantry/add', async (req, res, next) => {
  try {
    const h = req.household;
    const q = req.query;
    const from = mongoose.isValidObjectId(q.from) ? await ShoppingItem.findOne({ _id: q.from, ...visible(req.user), bought: true, putAway: 'pending' }).lean() : null;
    const name = String((from && from.name) || q.name || '').trim().slice(0, 80);
    const key = name ? keyOf(name) : '';
    const existing = key ? await sameAs(req, key) : [];
    const c = key ? await CatalogItem.findOne({ householdId: req.user.householdId, key }).lean() : null;
    const defaultSpot = h.pantrySpots.includes(h.pantryDefaultSpot) ? h.pantryDefaultSpot : h.pantrySpots[0] || 'Other';
    const rList = key ? (await ratingsFor(req.household, [key])).get(key) : [];
    res.render('pantry/add', {
      rList, rWarn: warnings(rList), stores: req.household.stores || [], store: await storeFor(req, key),
      active: 'pantry', STATUS: pantryNames(h),
      todayDate: todayIn(req.user.timezone),
      item: {
        name: c ? c.name : name,
        spot: h.pantrySpots.includes(q.spot) ? q.spot : existing[0] ? existing[0].spot : from ? spotFor(h, from.aisle) : defaultSpot,
        expires: '', amount: '', count: from ? countOf(from.qty) : 1, // one batch: this date, this many
        bought: from ? boughtDay(req.user, from) : todayIn(req.user.timezone),
        status: 'have', food: null, autoShop: true, note: '',
      },
      productPhoto: CODE.test(String(q.code || '')) && Boolean(await productPhotoUrl(String(q.code))),
      existing,
      from: from ? String(from._id) : '',
      fromText: from ? `Bought by ${from.boughtByName || from.byName}${from.qty && from.qty !== '1' ? ` (${from.qty})` : ''}` : '',
      code: CODE.test(String(q.code || '')) ? String(q.code) : '',
      brand: String(q.brand || '').slice(0, 80),
      found: String(q.found || '').slice(0, 160),
      again: q.again === '1',
      error: null,
      catalog: await CatalogItem.find({ householdId: req.user.householdId }, { name: 1 }).sort({ name: 1 }).lean(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/s/pantry/add', withPhoto, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (req.uploadError) { req.session.flash = req.uploadError; return res.redirect('/s/pantry'); }
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) { req.session.flash = 'Enter the item’s name.'; return res.redirect('/s/pantry'); }
    const key = keyOf(name);
    const existing = await sameAs(req, key);
    const { choice, target } = await readChoice(req, existing);
    const c = await CatalogItem.findOne({ householdId: req.user.householdId, key }).lean();
    const { item, text } = await stockIn(req.user, {
      name: c ? c.name : name, key, choice, target,
      spot: pick(req.household, 'pantrySpots', b.spot),
      amount: String(b.amount || '').trim().slice(0, 40),
      // Bought: the date given, or none when it was cleared ("No date"); today if it wasn't sent.
      batches: [{ count: Math.min(99, Math.max(1, parseInt(b.count, 10) || 1)), expires: isDate(b.expires) ? b.expires : '', bought: isDate(b.bought) && b.bought <= todayIn(req.user.timezone) ? b.bought : b.bought === '' ? '' : todayIn(req.user.timezone) }],
    });
    // The rest of the details, as on the Edit page. Adding to one that's there keeps its own
    // details unless something new was given.
    const isNew = choice === 'new';
    if (b.status === 'low') item.status = 'low';
    if (b.food !== undefined && (isNew || b.food !== 'auto')) item.food = b.food === 'yes' ? true : b.food === 'no' ? false : null;
    if (b.details === '1' && isNew) item.autoShop = b.autoShop === 'on';
    const note = String(b.note || '').trim().slice(0, 300);
    if (note) item.note = note;
    const tags = tagsFrom(req, b);
    if (tags.length) item.tags = [...new Set([...(isNew ? [] : item.tags || []), ...tags])];
    try {
      if ((req.files || {}).photo) await applyPhoto(req, item);
      else if (b.useProductPhoto === 'on' && (isNew || !item.photoId)) {
        const file = await productPhoto(b.code);
        if (file) item.photoId = (await saveUpload(req.user, file, { isPrivate: false, imagesOnly: true }))._id;
      }
    } catch (e) {
      if (!e.userFacing) throw e;
      req.session.flash = e.message;
    }
    if (item.isModified()) await item.save();
    // Their rating, picked on the form; or asked about later when it was bought or scanned.
    if (b.rating && req.perms.can('pantry', 'ratings')) await rate(req.user, req.household, { key: item.key, name: item.name, value: String(b.rating) });
    else if (b.from || b.code) askLater(req, [item]);
    await saveStore(req, item.name, b.store);
    if (item.status === 'low' && (await addToShopping(req.user, req.household, item))) req.session.flash = `${item.name} is on the shopping list now.`;
    if (choice === 'new') await recordChange(req, { kind: 'create', model: 'PantryItem', doc: item, section: SECTION, text, label: item.name });
    else await logActivity(req.user, { section: SECTION, text: `${req.user.name} ${text}` });
    await addToCatalog(req.user, req.household, [item.name]);
    await saveStore(req, item.name, (req.body || {}).store);
    if (CODE.test(String(b.code || ''))) await remember(req.user.householdId, String(b.code), item.key, b.brand);
    // From "Put away": that bought item is done.
    if (mongoose.isValidObjectId(b.from)) await ShoppingItem.updateOne({ _id: b.from, householdId: req.user.householdId }, { $set: { putAway: 'done' } });
    if (!req.session.flash) req.session.flash = `${item.name}: ${choice === 'new' ? 'added' : choice === 'add' ? `${item.count} now` : 'restocked'}.`;
    res.redirect(b.again === '1' ? '/s/pantry?scan=1' : `/s/pantry#p-${item._id}`);
  } catch (err) {
    next(err);
  }
});

// Old quick-add form (pages still open from before): on to the add page.
router.post('/s/pantry/quick', (req, res) => {
  const b = req.body || {};
  res.redirect(303, `/s/pantry/add?${new URLSearchParams({ name: String(b.name || '').slice(0, 80), spot: String(b.spot || '').slice(0, 40) })}`);
});

// Skip: into the pantry without the details (Have, no date; added to its count if it's there).
const pendingOf = (req, extra = {}) => ShoppingItem.find({ ...visible(req.user), bought: true, putAway: 'pending', ...extra });
async function skipDetails(req, shops) {
  for (const s of shops) {
    await quickStock(req.user, req.household, s);
    s.putAway = 'done';
    await s.save();
  }
  if (shops.length) await addToCatalog(req.user, req.household, shops.map((s) => s.name));
  askLater(req, shops.map((s) => ({ key: s.key || keyOf(s.name), name: s.name })));
}

router.post('/s/pantry/putaway/skip-all', async (req, res, next) => {
  try {
    const shops = await pendingOf(req);
    await skipDetails(req, shops);
    req.session.flash = shops.length ? `Added ${shops.length} ${shops.length === 1 ? 'thing' : 'things'} to the pantry.` : 'Nothing to put away.';
    res.redirect('/s/pantry');
  } catch (err) {
    next(err);
  }
});

// Always skip the details for this item: bought → straight into the pantry from now on.
// Listed (and undone) in Settings → Pantry.
router.post('/s/pantry/putaway/:id/always', async (req, res, next) => {
  try {
    const s = mongoose.isValidObjectId(req.params.id) ? await ShoppingItem.findOne({ _id: req.params.id, ...visible(req.user), bought: true }).lean() : null;
    if (!s) return res.redirect('/s/pantry#putaway');
    await addToCatalog(req.user, req.household, [s.name]);
    await CatalogItem.updateOne({ householdId: req.user.householdId, key: s.key }, { $set: { autoPantry: true } });
    await skipDetails(req, await pendingOf(req, { key: s.key }));
    req.session.flash = `${s.name} added. From now on it goes straight into the pantry when bought (Settings → Pantry to change).`;
    res.redirect('/s/pantry#putaway');
  } catch (err) {
    next(err);
  }
});

router.post('/s/pantry/putaway/:id/skip', async (req, res, next) => {
  try {
    const shops = mongoose.isValidObjectId(req.params.id) ? await pendingOf(req, { _id: req.params.id }) : [];
    await skipDetails(req, shops);
    if (shops[0]) req.session.flash = `${shops[0].name} added to the pantry.`;
    res.redirect('/s/pantry#putaway');
  } catch (err) {
    next(err);
  }
});

// One used up. With more than one date, it asks which one; at none left it's Out (and onto
// Shopping if that's on).
router.get('/s/pantry/:id/use', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.redirect('/s/pantry');
    const today = todayIn(req.user.timezone);
    res.render('pantry/use', {
      active: 'pantry', item, query: String(req.query.query || ''),
      batches: batchesOf(item).map((x, i) => ({ i, count: x.count, label: [x.expires ? expiryText(x.expires, today, req.household.pantrySoonDays || 3).text || `Use by ${shortDay(x.expires)}` : 'No date', x.bought ? `bought ${shortDay(x.bought)}` : ''].filter(Boolean).join(' · ') })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/s/pantry/:id/use', async (req, res, next) => {
  try {
    const b = req.body || {};
    const item = await find(req);
    if (!item) return res.redirect(backTo(b.query));
    const batches = batchesOf(item).map((x) => ({ count: x.count, expires: x.expires || '', bought: x.bought || '' }));
    const i = parseInt(b.batch, 10);
    if (batches.length > 1 && !(i >= 0 && i < batches.length)) return res.redirect(`/s/pantry/${item._id}/use?${new URLSearchParams({ query: String(b.query || '') })}`);
    const before = item.toObject();
    const at = batches.length > 1 ? i : 0;
    if (batches[at]) batches[at].count -= 1;
    item.batches = batches.filter((x) => x.count > 0);
    if (!item.batches.length) item.set({ statusBy: req.user.name, statusAt: new Date() });
    await item.save();
    await recordChange(req, { kind: 'update', model: 'PantryItem', doc: item, before, section: SECTION, text: item.count ? `used one ${item.name} (${item.count} left)` : `used the last ${item.name}`, label: item.name });
    if (item.count === 0) askLater(req, [item]);
    if (item.count === 0 && (await addToShopping(req.user, req.household, item))) req.session.flash = `${item.name} is on the shopping list now.`;
    res.redirect(`${backTo(b.query)}#p-${item._id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/s/pantry/new', async (req, res, next) => {
  try {
    const h = req.household;
    const spot = h.pantrySpots.includes(req.query.spot) ? req.query.spot : h.pantrySpots.includes(h.pantryDefaultSpot) ? h.pantryDefaultSpot : h.pantrySpots[0] || 'Other';
    res.render('pantry/form', await formView(req, { _id: null, name: '', spot, status: 'have', amount: '', expires: '', autoShop: true, note: '' }));
  } catch (err) {
    next(err);
  }
});

router.post('/s/pantry', withPhoto, async (req, res, next) => {
  try {
    const { values, error } = readForm(req);
    if (error || req.uploadError) return res.status(422).render('pantry/form', await formView(req, { ...values, _id: null }, error || req.uploadError));
    // Already there: ask how to add it (separate, replace, or add to its count), then do that.
    const existing = await sameAs(req, values.key);
    if (existing.length && !(req.body || {}).choice) return res.status(422).render('pantry/form', await formView(req, { ...values, _id: null }, null, existing));
    const { choice, target } = await readChoice(req, existing);
    if (target) {
      const { item, text } = await stockIn(req.user, { ...values, choice, target });
      try { await applyPhoto(req, item); await item.save(); } catch (e) { if (!e.userFacing) throw e; }
      await saveStore(req, item.name, (req.body || {}).store);
      await logActivity(req.user, { section: SECTION, text: `${req.user.name} ${text}` });
      return res.redirect(`/s/pantry#p-${item._id}`);
    }
    const item = new PantryItem({ ...values, householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name, statusBy: req.user.name, statusAt: new Date() });
    try {
      await applyPhoto(req, item);
    } catch (e) {
      if (!e.userFacing) throw e;
      return res.status(422).render('pantry/form', await formView(req, { ...values, _id: null }, e.message));
    }
    await item.save();
    await addToCatalog(req.user, req.household, [item.name]);
    await saveStore(req, item.name, (req.body || {}).store);
    await recordChange(req, { kind: 'create', model: 'PantryItem', doc: item, section: SECTION, text: `added ${item.name} to the pantry`, label: item.name });
    if (await addToShopping(req.user, req.household, item)) req.session.flash = `${item.name} is on the shopping list now.`;
    res.redirect(`/s/pantry#p-${item._id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/s/pantry/:id/edit', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    res.render('pantry/form', { ...(await formView(req, item.toObject())), rList: (await ratingsFor(req.household, [item.key])).get(item.key) });
  } catch (err) {
    next(err);
  }
});

// Select mode: one change to many items at once (move, status, tags, food, shopping, delete).
router.post('/s/pantry/bulk', async (req, res, next) => {
  try {
    const b = req.body || {};
    const back = backTo(b.query);
    const ids = [].concat(b.ids || []).map(String).filter((id) => mongoose.isValidObjectId(id)).slice(0, 500);
    const items = ids.length ? await PantryItem.find({ _id: { $in: ids }, ...visible(req.user) }).collation({ locale: 'en' }).sort({ name: 1 }) : [];
    const [what, ...rest] = String(b.do || '').split(':');
    const value = rest.join(':');
    if (!items.length || !what) {
      req.session.flash = items.length ? 'Pick what to do with them.' : 'Nothing was selected.';
      return res.redirect(`${back}${back.includes('?') ? '&' : '?'}select=1`);
    }
    const h = req.household;
    const names = items.map((i) => i.name);
    const many = names.length === 1 ? names[0] : `${names.length} items`;
    const NAMES = pantryNames(h);
    let text = '';
    if (what === 'delete') {
      const docs = items.map((i) => i.toObject());
      await PantryItem.deleteMany({ _id: { $in: items.map((i) => i._id) } });
      await recordDeleteMany(req, { model: 'PantryItem', docs, section: SECTION, label: many, text: names.length <= 3 ? `removed ${names.join(', ')} from the pantry` : `removed ${names.length} items from the pantry (${names.slice(0, 3).join(', ')}, …)` });
      req.session.flash = `Removed ${many}.`;
      return res.redirect(back);
    }
    if (what === 'move' && [...h.pantrySpots, 'Other'].includes(value)) {
      items.forEach((i) => { i.spot = value; });
      text = `moved ${many} to ${value}`;
    } else if (what === 'status' && STATUS_KEYS.includes(value)) {
      items.forEach((i) => {
        if (i.status === value) return;
        if (value === 'out') i.batches = [];
        else if (!batchesOf(i).length) i.batches = [{ count: 1, expires: '' }];
        i.set({ status: value, statusBy: req.user.name, statusAt: new Date() });
      });
      text = `marked ${many} ${NAMES[value]}`;
    } else if ((what === 'tag+' || what === 'tag-') && (h.pantryTags || []).includes(value)) {
      items.forEach((i) => { i.tags = what === 'tag+' ? [...new Set([...(i.tags || []), value])] : (i.tags || []).filter((t) => t !== value); });
      text = `${what === 'tag+' ? 'tagged' : 'untagged'} ${many} ${value}`;
    } else if (what === 'food' && ['yes', 'no', 'auto'].includes(value)) {
      items.forEach((i) => { i.food = value === 'yes' ? true : value === 'no' ? false : null; });
      text = `set ${many} as ${value === 'yes' ? 'food' : value === 'no' ? 'not food' : 'food by where it’s kept'}`;
    } else if (what === 'shop' && ['on', 'off'].includes(value)) {
      items.forEach((i) => { i.autoShop = value === 'on'; });
      text = `turned ${value} adding ${many} to shopping when low`;
    } else {
      req.session.flash = 'Pick what to do with them.';
      return res.redirect(`${back}${back.includes('?') ? '&' : '?'}select=1`);
    }
    let added = 0;
    for (const i of items) {
      if (!i.isModified()) continue;
      await i.save();
      if (what === 'status' && (await addToShopping(req.user, h, i))) added++;
    }
    await logActivity(req.user, { section: SECTION, text: `${req.user.name} ${text}` });
    req.session.flash = `${text.charAt(0).toUpperCase()}${text.slice(1)}.${added ? ` ${added} added to the shopping list.` : ''}`;
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

router.post('/s/pantry/:id', withPhoto, async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const { values, error } = readForm(req);
    if (error) return res.status(422).render('pantry/form', await formView(req, { ...item.toObject(), ...values }, error));
    const before = item.toObject();
    const statusChanged = values.status !== item.status;
    item.set(values);
    if (statusChanged) item.set({ statusBy: req.user.name, statusAt: new Date() });
    try {
      await applyPhoto(req, item);
    } catch (e) {
      if (!e.userFacing) throw e;
      return res.status(422).render('pantry/form', await formView(req, { ...before, ...values }, e.message));
    }
    await item.save();
    await addToCatalog(req.user, req.household, [item.name]);
    await saveStore(req, item.name, (req.body || {}).store);
    await recordChange(req, { kind: 'update', model: 'PantryItem', doc: item, before, section: SECTION, text: `edited ${item.name} in the pantry`, label: item.name });
    if (statusChanged && (await addToShopping(req.user, req.household, item))) req.session.flash = `${item.name} is on the shopping list now.`;
    res.redirect(`/s/pantry#p-${item._id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/s/pantry/:id/delete', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const before = item.toObject();
    await item.deleteOne();
    await recordChange(req, { kind: 'delete', model: 'PantryItem', doc: item, before, section: SECTION, text: `removed ${item.name} from the pantry`, label: item.name });
    res.redirect(backTo(req.body.query));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
