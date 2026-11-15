const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const PantryItem = require('../models/PantryItem');
const CatalogItem = require('../models/CatalogItem');
const { recordChange, visible } = require('../lib/changes');
const { logActivity } = require('../lib/activity');
const { pick } = require('../lib/lists');
const { keyOf, addToCatalog } = require('../lib/catalog');
const { addToShopping, expiryText } = require('../lib/pantry');
const { pantryNames } = require('../lib/prefs');
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
    const [items, catalog, counts] = await Promise.all([
      PantryItem.find(filter).collation({ locale: 'en' }).sort({ name: 1 }).lean(),
      CatalogItem.find({ householdId: req.user.householdId }, { name: 1 }).sort({ name: 1 }).lean(),
      Promise.all([
        PantryItem.countDocuments({ ...visible(req.user), status: { $in: ['low', 'out'] } }),
        PantryItem.countDocuments({ ...visible(req.user), expires: { $ne: '', $lte: addDays(today, SOON_DAYS) } }),
      ]),
    ]);
    const rows = items.map((i) => {
      const exp = expiryText(i.expires, today, SOON_DAYS);
      return { ...i, exp, meta: [i.amount, exp.text, i.autoShop ? '' : 'Not added to shopping'].filter(Boolean).join(' · ') };
    });
    const order = [...spots, 'Other'];
    const groups = order
      .map((name) => ({ name, items: rows.filter((r) => r.spot === name || (name === 'Other' && !spots.includes(r.spot))) }))
      .filter((g) => g.items.length);
    const query = new URLSearchParams(Object.entries({ show, spot }).filter(([, v]) => v)).toString();
    res.render('pantry/list', {
      active: 'pantry', groups, catalog, show, spot, query, total: items.length,
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
      item.set({ status, statusBy: req.user.name, statusAt: new Date() });
      await item.save();
      const added = await addToShopping(req.user, req.household, item);
      await logActivity(req.user, { section: SECTION, text: `${req.user.name} marked ${item.name} ${pantryNames(req.household)[status]}${added ? ' and added it to Shopping' : ''}` });
      if (added) req.session.flash = `${item.name} is on the shopping list now.`;
    }
    res.redirect(`${backTo(req.body.query)}#p-${item._id}`);
  } catch (err) {
    next(err);
  }
});

function readForm(req) {
  const b = req.body || {};
  const values = {
    name: String(b.name || '').trim().slice(0, 80),
    spot: pick(req.household, 'pantrySpots', b.spot),
    status: STATUS_KEYS.includes(b.status) ? b.status : 'have',
    amount: String(b.amount || '').trim().slice(0, 40),
    expires: isDate(b.expires) ? b.expires : '',
    autoShop: b.autoShop === 'on',
    note: String(b.note || '').trim().slice(0, 300),
  };
  values.key = keyOf(values.name);
  return { values, error: values.name ? null : 'Enter the item’s name.' };
}

const formView = async (req, item, error) => ({
  active: 'pantry', item, error: error || null, STATUS: pantryNames(req.household),
  catalog: await CatalogItem.find({ householdId: req.user.householdId }, { name: 1 }).sort({ name: 1 }).lean(),
  photo: item.photoId ? await Upload.findOne({ _id: item.photoId, householdId: req.user.householdId }).lean() : null,
});

// Reference photo: a new one replaces the old; "Remove" takes it off.
async function applyPhoto(req, item) {
  if ((req.body || {}).removePhoto === 'on') item.photoId = null;
  const f = (req.files || {}).photo;
  if (f) item.photoId = (await saveUpload(req.user, f[0], { isPrivate: false, imagesOnly: true }))._id;
}

// Quick add from the top of the list: just a name and where it's kept.
router.post('/s/pantry/quick', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (!name) return res.redirect(backTo(req.body.query));
    const key = keyOf(name);
    const dup = await PantryItem.findOne({ householdId: req.user.householdId, key }).lean();
    if (dup) {
      req.session.flash = `${dup.name} is already in the pantry.`;
      return res.redirect(`${backTo(req.body.query)}#p-${dup._id}`);
    }
    const c = await CatalogItem.findOne({ householdId: req.user.householdId, key }).lean();
    const item = await PantryItem.create({
      householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name,
      name: c ? c.name : name, key, spot: pick(req.household, 'pantrySpots', req.body.spot), statusBy: req.user.name, statusAt: new Date(),
    });
    await addToCatalog(req.user, req.household, [item.name]);
    await recordChange(req, { kind: 'create', model: 'PantryItem', doc: item, section: SECTION, text: `added ${item.name} to the pantry`, label: item.name });
    res.redirect(`${backTo(req.body.query)}#p-${item._id}`);
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
    const dup = await PantryItem.findOne({ householdId: req.user.householdId, key: values.key }).lean();
    if (dup) return res.status(422).render('pantry/form', await formView(req, { ...values, _id: null }, `${dup.name} is already in the pantry. Edit that one instead.`));
    const item = new PantryItem({ ...values, householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name, statusBy: req.user.name, statusAt: new Date() });
    try {
      await applyPhoto(req, item);
    } catch (e) {
      if (!e.userFacing) throw e;
      return res.status(422).render('pantry/form', await formView(req, { ...values, _id: null }, e.message));
    }
    await item.save();
    await addToCatalog(req.user, req.household, [item.name]);
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
    res.render('pantry/form', await formView(req, item.toObject()));
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
    if (values.key !== item.key && (await PantryItem.exists({ householdId: req.user.householdId, key: values.key }))) {
      return res.status(422).render('pantry/form', await formView(req, { ...item.toObject(), ...values }, `${values.name} is already in the pantry.`));
    }
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
