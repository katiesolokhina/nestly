const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const ShoppingItem = require('../models/ShoppingItem');
const CatalogItem = require('../models/CatalogItem');
const Upload = require('../models/Upload');
const { recordChange, recordDeleteMany, visible } = require('../lib/changes');
const { pick } = require('../lib/lists');
const { keyOf, fromCatalog, setStaple } = require('../lib/catalog');
const { parseFiles, saveUpload } = require('../lib/uploads');
const { dayLabel, todayIn } = require('../lib/dates');
const User = require('../models/User');
const { sendToUser } = require('../lib/push');
const { logActivity } = require('../lib/activity');
const { restock } = require('../lib/pantry');
const { currency } = require('../lib/prefs');
const { permsFor } = require('../lib/perms');
const { membersOf, inHome } = require('../lib/members');

const router = express.Router();
router.use('/s/shopping', requireAuth, requireSection('shopping'));

const SECTION = 'Shopping';
const money = (n, symbol = '$') => `${symbol}${Number(n).toFixed(2)}`;
const isHttp = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return ShoppingItem.findOne({ _id: req.params.id, ...visible(req.user) });
}

// Remembers the item's details for next time. Private items stay out of the shared catalog,
// so a gift's name can't appear in anyone's suggestions.
function remember(user, item) {
  if (item.private) return null;
  const { qty, store, aisle, tag, method, brand } = item;
  return CatalogItem.updateOne(
    { householdId: user.householdId, key: item.key },
    // The saved name keeps its spelling, so a rename in Saved items sticks.
    { $set: { qty, store, aisle, tag, method, brand }, $setOnInsert: { name: item.name } },
    { upsert: true }
  );
}

// ---------- The list ----------
router.get('/s/shopping', async (req, res, next) => {
  try {
    const { household, user } = req;
    const today = todayIn(user.timezone);
    const method = req.household.methods.includes(req.query.method) ? req.query.method : 'All';
    const cur = currency(req.household);
    const store = household.stores.includes(req.query.store) ? req.query.store : '';
    const tag = household.tags.includes(req.query.tag) ? req.query.tag : '';
    const shopping = req.query.mode === 'shop';
    const selecting = !shopping && req.query.select === '1';

    const filter = { ...visible(user), clearedAt: null };
    if (method !== 'All') filter.method = method;
    if (store) filter.store = { $in: [store, 'Any store'] };
    if (tag) filter.tag = tag;

    const [items, staples, catalog] = await Promise.all([
      ShoppingItem.find(filter).sort({ createdAt: 1 }).lean(),
      CatalogItem.find({ householdId: user.householdId, staple: true }).sort({ stapleOrder: 1, name: 1 }).lean(),
      CatalogItem.find({ householdId: user.householdId }, { name: 1 }).sort({ name: 1 }).lean(),
    ]);
    const active = items.filter((i) => !i.bought);
    const meta = (i) => [i.method !== req.household.methods[0] ? i.method : '', i.brand, i.store === 'Any store' ? '' : i.store, i.price != null ? money(i.price, cur) : '', i.ref, i.note].filter(Boolean).join(' · ');
    const groups = [...household.aisles, 'Unassigned']
      .map((a) => ({ name: a === 'Unassigned' ? 'Other' : a, items: active.filter((i) => i.aisle === a || (a === 'Unassigned' && !household.aisles.includes(i.aisle))).map((i) => ({ ...i, meta: meta(i) })) }))
      .filter((g) => g.items.length);

    res.render('shopping/list', {
      active: 'shopping', method, store, tag, shopping, selecting, groups, staples, catalog,
      count: active.length,
      total: money(active.reduce((n, i) => n + (i.price || 0), 0), cur),
      methods: req.household.methods,
      bought: items.filter((i) => i.bought).map((i) => ({ ...i, meta: `${i.boughtByName} · ${dayLabel(new Intl.DateTimeFormat('en-CA', { timeZone: user.timezone }).format(i.boughtAt), today)}` })),
      query: new URLSearchParams(Object.entries({ method: method === 'All' ? '' : method, store, tag }).filter(([, v]) => v)).toString(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Add ----------
async function addByName(req, res, name, back) {
  const key = keyOf(name);
  const dup = await ShoppingItem.exists({ ...visible(req.user), key, bought: false, clearedAt: null });
  if (dup) {
    req.session.flash = `${name} is already on the list.`;
    return res.redirect(back);
  }
  const c = await CatalogItem.findOne({ householdId: req.user.householdId, key }).lean();
  const item = await ShoppingItem.create(fromCatalog(req.user, name, c, req.household));
  await remember(req.user, item);
  await recordChange(req, { kind: 'create', model: 'ShoppingItem', doc: item, section: SECTION, text: `added ${item.name} to Shopping`, label: item.name });
  res.redirect(back);
}

const listBack = (req) => {
  const q = String(req.body.query || '');
  return `/s/shopping${/^[\w%+=&.\-]*$/.test(q) && q ? `?${q}` : ''}`;
};

router.post('/s/shopping/quick', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (!name) return res.redirect(listBack(req));
    await addByName(req, res, name, listBack(req));
  } catch (err) {
    next(err);
  }
});

// "Start shopping": opens shopping mode and lets everyone else know, so they can add what they need.
// One alert per person every 30 minutes, so stopping and starting again doesn't spam the house.
router.post('/s/shopping/start', async (req, res, next) => {
  try {
    const q = String(req.body.query || '');
    const query = /^[\w%+=&.\-]*$/.test(q) ? q : '';
    res.redirect(`/s/shopping?${query ? `${query}&` : ''}mode=shop`);
    if (req.household.tripAlerts === false) return; // turned off for this household
    const store = req.household.stores.includes(req.body.store) ? req.body.store : '';
    const claimed = await User.updateOne(
      { _id: req.user._id, $or: [{ lastTripAlertAt: null }, { lastTripAlertAt: { $lt: new Date(Date.now() - (req.household.tripGapMin || 30) * 60 * 1000) } }] },
      { $set: { lastTripAlertAt: new Date() } }
    );
    if (!claimed.modifiedCount) return;
    const where = store ? `shopping at ${store}` : 'out shopping';
    await logActivity(req.user, { section: SECTION, text: `${req.user.name} started ${where}` });
    const others = (await membersOf(req.user.householdId, { fields: { notify: 1 } }))
      .filter((u) => String(u._id) !== req.user.id && !(u.notify && u.notify.shopping === false) && permsFor(req.household, u).level('shopping') !== 'hidden');
    await Promise.all(others.map((u) => sendToUser(u._id, {
      title: `${req.user.name} is ${where}`,
      body: 'Need anything? Add it to the list now.',
      url: inHome(req.user.householdId, '/s/shopping'),
      tag: `trip-${req.user._id}`,
    })));
  } catch (err) {
    if (res.headersSent) console.error('Shopping alert failed:', err.message);
    else next(err);
  }
});

// Select mode: delete several items at once, without marking them bought. One Undo brings them back.
router.post('/s/shopping/delete-many', async (req, res, next) => {
  try {
    const ids = [].concat(req.body.ids || []).map(String).filter((id) => mongoose.isValidObjectId(id)).slice(0, 500);
    const items = ids.length ? await ShoppingItem.find({ _id: { $in: ids }, ...visible(req.user), clearedAt: null }).sort({ createdAt: 1 }) : [];
    if (!items.length) {
      req.session.flash = 'Nothing was selected.';
      return res.redirect(listBack(req));
    }
    const docs = items.map((i) => i.toObject());
    await ShoppingItem.deleteMany({ _id: { $in: items.map((i) => i._id) } });
    const names = items.map((i) => i.name);
    const label = names.length === 1 ? names[0] : `${names.length} items`;
    await recordDeleteMany(req, {
      model: 'ShoppingItem', docs, section: SECTION, label,
      text: names.length <= 3 ? `deleted ${names.join(', ')} from Shopping` : `deleted ${names.length} items from Shopping (${names.slice(0, 3).join(', ')}, …)`,
    });
    res.redirect(listBack(req));
  } catch (err) {
    next(err);
  }
});

router.post('/s/shopping/clear', async (req, res, next) => {
  try {
    await ShoppingItem.updateMany({ ...visible(req.user), bought: true, clearedAt: null }, { $set: { clearedAt: new Date() } });
    res.redirect(listBack(req));
  } catch (err) {
    next(err);
  }
});

// ---------- Add and edit with details ----------
async function formData(req, item, error) {
  let lastPaid = null;
  if (item && item.key) {
    const past = await ShoppingItem.findOne({ ...visible(req.user), key: item.key, bought: true, price: { $ne: null } }).sort({ boughtAt: -1 }).lean();
    if (past) {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: req.user.timezone }).format(past.boughtAt);
      lastPaid = `Last paid ${money(past.price, currency(req.household))}${past.store !== 'Any store' ? ` at ${past.store}` : ''}, ${dayLabel(day, todayIn(req.user.timezone))}`;
    }
  }
  const catalog = await CatalogItem.find({ householdId: req.user.householdId }, { name: 1 }).sort({ name: 1 }).lean();
  const [receipt, photo] = await Promise.all([
    item && item.receiptId ? Upload.findById(item.receiptId).lean() : null,
    item && item.photoId ? Upload.findById(item.photoId).lean() : null,
  ]);
  return { active: 'shopping', item, error: error || null, lastPaid, catalog, receipt, photo };
}

function readForm(req) {
  const b = req.body || {};
  const priceText = String(b.price || '').trim();
  const price = priceText === '' ? null : Number(priceText);
  const link = String(b.link || '').trim();
  const name = String(b.name || '').trim().slice(0, 80);
  const values = {
    name, key: keyOf(name),
    qty: String(b.qty || '').trim().slice(0, 30) || '1',
    price,
    method: req.household.methods.includes(b.method) ? b.method : req.household.methods[0] || 'In person',
    store: b.store === 'Any store' ? 'Any store' : pick(req.household, 'stores', b.store),
    aisle: pick(req.household, 'aisles', b.aisle),
    tag: pick(req.household, 'tags', b.tag),
    brand: String(b.brand || '').trim().slice(0, 80),
    ref: String(b.ref || '').trim().slice(0, 160),
    link,
    note: String(b.note || '').trim().slice(0, 300),
    private: b.private === 'on' && req.perms.private,
  };
  let error = req.uploadError || null;
  if (!name) error = 'Enter a name for the item.';
  else if (price !== null && (!Number.isFinite(price) || price < 0)) error = 'Enter a price like 4.99.';
  else if (link && !isHttp(link)) error = 'Enter a full product link that starts with https://';
  // Only the full form has the staple box; anything else leaves it as it was.
  return { values, staple: b.staple === 'on', stapleShown: b.stapleShown === '1', error };
}

async function applyFiles(req, item) {
  const files = req.files || {};
  const body = req.body || {};
  if (body.removeReceipt === 'on') item.receiptId = null;
  if (body.removePhoto === 'on') item.photoId = null;
  if (files.receipt) item.receiptId = (await saveUpload(req.user, files.receipt[0], { isPrivate: item.private }))._id;
  if (files.photo) item.photoId = (await saveUpload(req.user, files.photo[0], { isPrivate: item.private, imagesOnly: true }))._id;
  const ids = [item.receiptId, item.photoId].filter(Boolean);
  if (ids.length) await Upload.updateMany({ _id: { $in: ids }, householdId: req.user.householdId }, { $set: { private: item.private } });
}

const withFiles = parseFiles(['receipt', 'photo']);

router.get('/s/shopping/new', async (req, res, next) => {
  try {
    const name = String(req.query.name || '').trim().slice(0, 80);
    const c = name ? await CatalogItem.findOne({ householdId: req.user.householdId, key: keyOf(name) }).lean() : null;
    res.render('shopping/form', await formData(req, { ...fromCatalog(req.user, name, c, req.household), _id: null, private: false, staple: c ? c.staple : false }));
  } catch (err) {
    next(err);
  }
});

router.post('/s/shopping', withFiles, async (req, res, next) => {
  try {
    const { values, staple, stapleShown, error } = readForm(req);
    if (error) return res.status(422).render('shopping/form', await formData(req, { ...values, _id: null, staple }, error));
    const item = new ShoppingItem({ ...values, householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name });
    try {
      await applyFiles(req, item);
    } catch (e) {
      if (!e.userFacing) throw e;
      return res.status(422).render('shopping/form', await formData(req, { ...values, _id: null, staple }, e.message));
    }
    await item.save();
    await remember(req.user, item);
    if (!item.private && stapleShown) await setStaple(req.user.householdId, item.key, staple);
    await recordChange(req, { kind: 'create', model: 'ShoppingItem', doc: item, section: SECTION, text: `added ${item.name} to Shopping`, label: item.name });
    res.redirect('/s/shopping');
  } catch (err) {
    next(err);
  }
});

router.get('/s/shopping/:id/edit', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const c = await CatalogItem.findOne({ householdId: req.user.householdId, key: item.key }).lean();
    res.render('shopping/form', await formData(req, { ...item.toObject(), staple: !!(c && c.staple) }));
  } catch (err) {
    next(err);
  }
});

const LABELS = { name: 'Name', qty: 'Quantity', price: 'Price', method: 'Buying', store: 'Store', aisle: 'Aisle', tag: 'Tag', brand: 'Brand', ref: 'Reference', note: 'Note' };

router.post('/s/shopping/:id', withFiles, async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const { values, staple, stapleShown, error } = readForm(req);
    if (error) return res.status(422).render('shopping/form', await formData(req, { ...item.toObject(), ...values, staple }, error));
    const before = item.toObject();
    const changes = Object.keys(LABELS).filter((k) => String(before[k] ?? '') !== String(values[k] ?? '')).map((k) => `${LABELS[k]} ${before[k] === '' || before[k] == null ? 'blank' : before[k]} → ${values[k] === '' || values[k] == null ? 'blank' : values[k]}`);
    // The item's owner decides whether it's private.
    if (String(item.createdBy) !== req.user.id) values.private = item.private;
    item.set(values);
    try {
      await applyFiles(req, item);
    } catch (e) {
      if (!e.userFacing) throw e;
      return res.status(422).render('shopping/form', await formData(req, { ...before, ...values, staple }, e.message));
    }
    if (String(before.receiptId) !== String(item.receiptId)) changes.push(item.receiptId ? 'receipt attached' : 'receipt removed');
    await item.save();
    await remember(req.user, item);
    if (!item.private && stapleShown) await setStaple(req.user.householdId, item.key, staple);
    await recordChange(req, { kind: 'update', model: 'ShoppingItem', doc: item, before, section: SECTION, text: `edited ${item.name}${changes.length ? `: ${changes.slice(0, 2).join(', ')}${changes.length > 2 ? ', and more' : ''}` : ''}`, label: item.name });
    res.redirect('/s/shopping');
  } catch (err) {
    next(err);
  }
});

router.post('/s/shopping/:id/delete', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const before = item.toObject();
    await item.deleteOne();
    await recordChange(req, { kind: 'delete', model: 'ShoppingItem', doc: item, before, section: SECTION, text: `deleted ${item.name}`, label: item.name });
    res.redirect(listBack(req));
  } catch (err) {
    next(err);
  }
});

// ---------- Bought ----------
router.post('/s/shopping/:id/toggle', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const before = item.toObject();
    item.bought = !item.bought;
    item.boughtAt = item.bought ? new Date() : null;
    item.boughtByName = item.bought ? req.user.name : '';
    await item.save();
    const text = item.bought ? `bought ${item.name}${item.store !== 'Any store' ? ` at ${item.store}` : ''}` : `moved ${item.name} back to Shopping`;
    await recordChange(req, { kind: 'update', model: 'ShoppingItem', doc: item, before, section: SECTION, text, label: item.name });
    if (item.bought && req.household.features.pantry !== false) await restock(req.user, item.key);
    res.redirect(listBack(req));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
