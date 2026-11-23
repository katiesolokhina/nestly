// Merging pantry items into one: the others become kinds of the kept one (Sunset Cherry Tomatoes →
// the kind "Sunset" of Cherry Tomatoes). Their date lines, barcodes, photos, tags, shopping items
// and ratings move over; their pantry items and saved items are then gone.
const crypto = require('node:crypto');
const PantryItem = require('../models/PantryItem');
const CatalogItem = require('../models/CatalogItem');
const ShoppingItem = require('../models/ShoppingItem');
const Rating = require('../models/Rating');
const { keyOf } = require('./catalog');

const DIGITS = /^\d{8,14}$/;
// A kind without a barcode (an item merged in before it was ever scanned) gets an id of its own.
const newKindId = () => `n${crypto.randomBytes(3).toString('hex')}`;
const isKindId = (v) => DIGITS.test(v) || /^n[0-9a-f]{6}$/.test(v);

// "Sunset Cherry Tomatoes" kept as "Cherry Tomatoes" → "Sunset".
function kindNameFrom(name, target) {
  const t = String(target).toLowerCase().split(/\s+/);
  const left = String(name).split(/\s+/).filter((w) => !t.includes(w.toLowerCase())).join(' ').trim();
  return left || name;
}

// Moves one key's ratings to another; a person who rated both keeps their rating of the target.
async function moveRatings(householdId, from, to) {
  const rows = await Rating.find({ householdId, key: from }).lean();
  for (const r of rows) {
    if (await Rating.exists({ householdId, key: to, userId: r.userId })) await Rating.deleteOne({ _id: r._id });
    else await Rating.updateOne({ _id: r._id }, { $set: { key: to } });
  }
}

// keep: the pantry item kept; others: pantry items merged into it; name: what it's called after;
// kindNames: { [otherId]: name for its kind }. Returns a short description.
async function mergeItems(user, { keep, others, name, kindNames = {} }) {
  const h = user.householdId;
  const finalName = String(name || keep.name).trim().slice(0, 80) || keep.name;
  const finalKey = keyOf(finalName);
  const allKeys = [keep.key, ...others.map((o) => o.key)];
  // Another saved item already has the new name and isn't being merged: stop, rather than mix.
  if (finalKey !== keep.key && !allKeys.includes(finalKey) && (await CatalogItem.exists({ householdId: h, key: finalKey }))) {
    throw Object.assign(new Error(`There’s already a saved item called ${finalName}. Merge it in too, or pick another name.`), { userFacing: true });
  }
  const cats = await CatalogItem.find({ householdId: h, key: { $in: allKeys } });
  const catOf = (key) => cats.find((c) => c.key === key);
  let target = catOf(keep.key) || new CatalogItem({ householdId: h, name: keep.name, key: keep.key });

  for (const o of others) {
    const cat = o.key !== keep.key ? catOf(o.key) : null;
    const kindName = String(kindNames[String(o._id)] || kindNameFrom(o.name, finalName)).trim().slice(0, 60);
    // Its kinds: its own (named ones keep their names), else its barcodes, else one without a barcode.
    const own = cat ? [...(cat.kinds || []).map((k) => k.toObject())] : [];
    (cat ? cat.barcodes : []).forEach((code) => { if (!own.some((k) => k.code === code)) own.push({ code, name: '' }); });
    if (!own.length) own.push({ code: newKindId(), name: '' });
    own.forEach((k) => { if (!k.name) k.name = kindName; if (!k.photoId && o.photoId) k.photoId = o.photoId; k.by = k.by || user.name; k.at = k.at || new Date(); });
    const mainKind = own[0].code;
    own.forEach((k) => {
      if (!target.kinds.some((x) => x.code === k.code)) target.kinds.push(k);
      if (DIGITS.test(k.code) && !target.barcodes.includes(k.code)) target.barcodes.push(k.code);
    });
    if (cat && cat.staple) target.staple = true;
    // Date lines move over, each as its kind.
    const lines = (o.batches && o.batches.length ? o.batches : o.count > 0 && o.status !== 'out' ? [{ count: o.count, expires: o.expires || '', bought: '' }] : []);
    if (!keep.batches) keep.syncBatches();
    lines.forEach((b) => keep.batches.push({ count: b.count, expires: b.expires || '', bought: b.bought || '', kind: b.kind && isKindId(b.kind) ? b.kind : mainKind }));
    keep.tags = [...new Set([...(keep.tags || []), ...(o.tags || [])])];
    if (!keep.photoId && o.photoId) keep.photoId = o.photoId;
    if (o.status !== 'out' && keep.status === 'out') keep.status = 'have';
    if (o.key !== keep.key) {
      await ShoppingItem.updateMany({ householdId: h, key: o.key, clearedAt: null }, { $set: { name: finalName, key: finalKey } });
      await moveRatings(h, o.key, finalKey);
      if (cat) await CatalogItem.deleteOne({ _id: cat._id });
    }
    await PantryItem.deleteOne({ _id: o._id });
  }

  // A new name: the kept item, its saved item, what's on the list, and ratings follow.
  if (finalKey !== keep.key || finalName !== keep.name) {
    if (finalKey !== keep.key) {
      await ShoppingItem.updateMany({ householdId: h, key: keep.key, clearedAt: null }, { $set: { name: finalName, key: finalKey } });
      await moveRatings(h, keep.key, finalKey);
    }
    keep.name = finalName;
    keep.key = finalKey;
    target.name = finalName;
    target.key = finalKey;
  }
  await target.save();
  await keep.save();
  return `merged ${others.map((o) => o.name).join(', ')} into ${keep.name}`;
}

module.exports = { mergeItems, kindNameFrom, isKindId, newKindId };
