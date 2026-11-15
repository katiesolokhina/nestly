// Saved items: the suggestions when typing an item, their usual details, and staples.
// Anyone who can edit Shopping can tidy them. Mounted before Shopping's own routes.
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const CatalogItem = require('../models/CatalogItem');
const ShoppingItem = require('../models/ShoppingItem');
const PantryItem = require('../models/PantryItem');
const { logActivity } = require('../lib/activity');
const { recordChange } = require('../lib/changes');
const { isQuick, takeUndo } = require('../lib/quick');
const { pick } = require('../lib/lists');
const { keyOf, setStaple } = require('../lib/catalog');

const router = express.Router();
router.use('/s/shopping/saved', requireAuth, requireSection('shopping'));
const SECTION = 'Shopping';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return CatalogItem.findOne({ _id: req.params.id, householdId: req.user.householdId });
}

router.get('/s/shopping/saved', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 60);
    const show = ['staples', 'usual'].includes(req.query.show) ? req.query.show : '';
    const filter = { householdId: req.user.householdId };
    if (q) filter.name = new RegExp(escapeRe(q), 'i');
    if (show === 'staples') filter.staple = true;
    if (show === 'usual') filter.usuallyHave = true;
    const [items, staples, total] = await Promise.all([
      CatalogItem.find(filter).collation({ locale: 'en' }).sort({ name: 1 }).limit(500).lean(),
      CatalogItem.find({ householdId: req.user.householdId, staple: true }).sort({ stapleOrder: 1, name: 1 }).lean(),
      CatalogItem.countDocuments({ householdId: req.user.householdId }),
    ]);
    res.render('shopping/saved', { active: 'shopping', items, staples, q, show, total });
  } catch (err) {
    next(err);
  }
});

// Staples in your own order: up or down one place.
router.post('/s/shopping/saved/:id/move', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item || !item.staple) return res.redirect('/s/shopping/saved');
    const staples = await CatalogItem.find({ householdId: req.user.householdId, staple: true }).sort({ stapleOrder: 1, name: 1 });
    const i = staples.findIndex((s) => String(s._id) === String(item._id));
    const j = (req.body || {}).dir === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < staples.length) [staples[i], staples[j]] = [staples[j], staples[i]];
    // Renumber all of them, so the order stays clean.
    await CatalogItem.bulkWrite(staples.map((s, n) => ({ updateOne: { filter: { _id: s._id }, update: { $set: { stapleOrder: n + 1 } } } })));
    res.redirect('/s/shopping/saved#staples');
  } catch (err) {
    next(err);
  }
});

// One tap from the list: staple on or off.
router.post('/s/shopping/saved/:id/staple', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return isQuick(req) ? res.status(404).json({ ok: false, gone: true }) : res.redirect('/s/shopping/saved');
    await setStaple(req.user.householdId, item.key, (req.body || {}).on === '1');
    if (isQuick(req)) return res.json({ ok: true, staple: (req.body || {}).on === '1' });
    const back = String((req.body || {}).query || '');
    res.redirect(`/s/shopping/saved${/^[\w%+=&.\-]*$/.test(back) && back ? `?${back}` : ''}`);
  } catch (err) {
    next(err);
  }
});

router.get('/s/shopping/saved/:id', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    res.render('shopping/saved-item', { active: 'shopping', item: item.toObject(), error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/s/shopping/saved/:id', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const b = req.body || {};
    const h = req.household;
    const name = String(b.name || '').trim().slice(0, 80);
    const values = {
      name,
      qty: String(b.qty || '').trim().slice(0, 30) || '1',
      store: b.store === 'Any store' ? 'Any store' : pick(h, 'stores', b.store),
      aisle: pick(h, 'aisles', b.aisle),
      tag: pick(h, 'tags', b.tag),
      method: h.methods.includes(b.method) ? b.method : h.methods[0] || 'In person',
      brand: String(b.brand || '').trim().slice(0, 80),
      usuallyHave: b.usuallyHave === 'on',
    };
    const view = { ...item.toObject(), ...values, staple: b.staple === 'on' };
    if (!name) return res.status(422).render('shopping/saved-item', { active: 'shopping', item: view, error: 'Enter a name.' });
    const key = keyOf(name);
    if (key !== item.key && (await CatalogItem.exists({ householdId: h._id, key }))) {
      return res.status(422).render('shopping/saved-item', { active: 'shopping', item: view, error: `${name} is already saved. Delete one of them instead.` });
    }
    const oldKey = item.key;
    const oldName = item.name;
    item.set({ ...values, key });
    await item.save();
    await setStaple(h._id, key, b.staple === 'on');
    // A new name follows to what's on the list now and the pantry, so they stay linked.
    if (key !== oldKey || name !== oldName) {
      await Promise.all([
        ShoppingItem.updateMany({ householdId: h._id, key: oldKey, bought: false, clearedAt: null }, { $set: { name, key } }),
        PantryItem.updateMany({ householdId: h._id, key: oldKey }, { $set: { name, key } }).catch((err) => { if (err.code !== 11000) throw err; }),
      ]);
    }
    await logActivity(req.user, { section: SECTION, text: name !== oldName ? `${req.user.name} renamed the saved item ${oldName} to ${name}` : `${req.user.name} edited the saved item ${name}` });
    req.session.flash = `${name} saved.`;
    res.redirect('/s/shopping/saved');
  } catch (err) {
    next(err);
  }
});

// Delete: it stops being suggested. Anything already on the list or in the pantry stays.
router.post('/s/shopping/saved/:id/delete', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) {
      if (isQuick(req)) return res.status(404).json({ ok: false, gone: true });
      req.session.flash = 'That saved item was already deleted.';
      return res.redirect('/s/shopping/saved');
    }
    const before = item.toObject();
    await item.deleteOne();
    await recordChange(req, { kind: 'delete', model: 'CatalogItem', doc: item, before, section: SECTION, text: `deleted the saved item ${item.name}`, label: `the saved item ${item.name}` });
    if (isQuick(req)) return res.json({ ok: true, undo: await takeUndo(req) });
    res.redirect('/s/shopping/saved');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
