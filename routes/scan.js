// Barcode scanning: add to or restock the pantry, add to the shopping list, and tick items off
// while shopping. Mounted before Pantry and Shopping, whose /:id routes would catch these paths.
const express = require('express');
const { requireAuth, requireSection } = require('../middleware/auth');
const PantryItem = require('../models/PantryItem');
const ShoppingItem = require('../models/ShoppingItem');
const CatalogItem = require('../models/CatalogItem');
const { recordChange, visible } = require('../lib/changes');
const { keyOf, addToCatalog, fromCatalog } = require('../lib/catalog');
const { markPutAway } = require('../lib/pantry');
const { pantryNames } = require('../lib/prefs');
const { lookup, remember, CODE } = require('../lib/barcode');
const { defaultsOf } = require('../lib/defaults');

const router = express.Router();
const FOR = { pantry: 'pantry', shopping: 'shopping', shop: 'shopping' };
const body = (req) => req.body || {};
const nameOf = (req) => String(body(req).name || '').trim().slice(0, 80);
const codeOf = (req) => (CODE.test(String(body(req).code || '')) ? String(body(req).code) : '');

// What a code is, and where it already is in this household.
router.get('/api/barcode/:code', requireAuth, async (req, res, next) => {
  try {
    const mode = FOR[req.query.for] ? req.query.for : 'shopping';
    if (!req.sees(FOR[mode])) return res.status(404).json({ error: 'Not found' });
    const found = await lookup(req.user.householdId, String(req.params.code));
    if (!found) return res.status(400).json({ error: 'That isn’t a barcode number.' });
    const key = found.name ? keyOf(found.name) : null;
    const [onList, pantry] = await Promise.all([
      key && req.sees('shopping') ? ShoppingItem.findOne({ ...visible(req.user), key, clearedAt: null }, { name: 1, bought: 1 }).sort({ bought: 1 }).lean() : null,
      key && req.sees('pantry') ? PantryItem.find({ ...visible(req.user), key }, { name: 1, status: 1, spot: 1, count: 1, expires: 1 }).lean() : [],
    ]);
    res.json({
      code: found.code,
      name: found.name,
      brand: found.brand,
      size: found.size,
      source: found.source,
      onList: onList ? { id: String(onList._id), name: onList.name, bought: onList.bought } : null,
      pantry: pantry.map((p) => ({ id: String(p._id), name: p.name, status: p.status, statusName: pantryNames(req.household)[p.status], spot: p.spot, count: p.count })),
    });
  } catch (err) {
    next(err);
  }
});

// Pantry scans go to the pantry's add page (routes/pantry.js), which asks how to add it.

// Shopping: add it to the list, or (in shopping mode) tick it off, or add it already bought.
router.post('/s/shopping/scan', requireAuth, requireSection('shopping'), async (req, res, next) => {
  try {
    const name = nameOf(req);
    const code = codeOf(req);
    const action = ['add', 'tick', 'bought'].includes(body(req).action) ? body(req).action : 'add';
    const shopping = action !== 'add';
    const q = String(body(req).query || '');
    const back = `/s/shopping?${[/^[\w%+=&.\-]*$/.test(q) ? q : '', shopping ? 'mode=shop' : '', body(req).again === '1' ? 'scan=1' : ''].filter(Boolean).join('&')}`.replace(/\?$/, '');
    if (!name) { req.session.flash = 'Type a name for it first.'; return res.redirect(back); }
    const key = keyOf(name);
    const onList = await ShoppingItem.findOne({ ...visible(req.user), key, bought: false, clearedAt: null });
    let item = onList;
    if (action === 'add') {
      if (onList) {
        req.session.flash = `${onList.name} is already on the list.`;
      } else {
        const c = await CatalogItem.findOne({ householdId: req.user.householdId, key }).lean();
        item = await ShoppingItem.create({ ...fromCatalog(req.user, name, c, req.household), private: defaultsOf(req.household).private, ...(body(req).brand && !(c && c.brand) ? { brand: String(body(req).brand).slice(0, 80) } : {}) });
        await recordChange(req, { kind: 'create', model: 'ShoppingItem', doc: item, section: 'Shopping', text: `added ${item.name} to Shopping`, label: item.name });
        req.session.flash = `${item.name} added to the list.`;
      }
    } else {
      // Tick: the one on the list; "bought" also covers something that wasn't on it.
      if (!item) {
        const c = await CatalogItem.findOne({ householdId: req.user.householdId, key }).lean();
        item = new ShoppingItem(fromCatalog(req.user, name, c, req.household));
      }
      const before = item.isNew ? null : item.toObject();
      item.set({ bought: true, boughtAt: new Date(), boughtByName: req.user.name });
      if (req.household.features.pantry !== false) await markPutAway(req.user, item, req.household);
      await item.save();
      await recordChange(req, { kind: before ? 'update' : 'create', model: 'ShoppingItem', doc: item, before, section: 'Shopping', text: `bought ${item.name}${item.store !== 'Any store' ? ` at ${item.store}` : ''}`, label: item.name });
      req.session.flash = `${item.name}: bought.`;
    }
    await addToCatalog(req.user, req.household, [item.name]);
    await remember(req.user.householdId, code, item.key, body(req).brand);
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
