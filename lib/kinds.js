// Kinds: the brands or flavors of one item (Nature Sweet and Sunset cherry tomatoes), one per
// barcode, each with a name and a photo. They live on the item's saved item, so the pantry item,
// Shopping, and scans all see the same ones. Older saved items' bare barcodes count as unnamed kinds.
const CatalogItem = require('../models/CatalogItem');
const { remember, productPhoto, CODE, norm } = require('./barcode');
const { saveUpload } = require('./uploads');

// Every kind of a saved item, oldest first: { code, name, photoId }.
function kindsOf(cat) {
  if (!cat) return [];
  const list = (cat.kinds || []).map((k) => ({ code: k.code, name: k.name || '', photoId: k.photoId ? String(k.photoId) : '' }));
  (cat.barcodes || []).forEach((code) => { if (!list.some((k) => k.code === code)) list.push({ code, name: '', photoId: '' }); });
  return list;
}
const kindName = (k) => (k && k.name) || 'Unnamed';

// The saved item's kinds for one key (and the saved item itself).
async function kindsFor(user, key) {
  const cat = key ? await CatalogItem.findOne({ householdId: user.householdId, key }).lean() : null;
  return { cat, kinds: kindsOf(cat) };
}

// Kinds for many keys at once: Map key -> kinds.
async function kindsByKey(user, keys) {
  const cats = keys.length ? await CatalogItem.find({ householdId: user.householdId, key: { $in: [...new Set(keys)] } }, { key: 1, kinds: 1, barcodes: 1 }).lean() : [];
  return new Map(cats.map((c) => [c.key, kindsOf(c)]));
}

// A kind's photo from Open Food Facts, saved once (when it has none yet).
async function fetchKindPhoto(user, key, code) {
  const cat = await CatalogItem.findOne({ householdId: user.householdId, key, 'kinds.code': code }, { kinds: 1 }).lean();
  const k = cat && cat.kinds.find((x) => x.code === code);
  if (!k || k.photoId) return k ? k.photoId : null;
  const file = await productPhoto(code);
  if (!file) return null;
  const up = await saveUpload(user, file, { isPrivate: false, imagesOnly: true });
  await CatalogItem.updateOne({ householdId: user.householdId, key, 'kinds.code': code }, { $set: { 'kinds.$.photoId': up._id } });
  return up._id;
}

// The "Kinds and barcodes" part of a form: renames (kindName_<code>), removals (kindRemove), and
// one added by typing its code (kindAdd, kindAddName). Returns a message for anything worth saying.
async function applyKindsForm(user, { key, name }, b) {
  const { cat } = await kindsFor(user, key);
  const notes = [];
  if (cat) {
    const remove = new Set([].concat(b.kindRemove || []).map(String));
    const kinds = (cat.kinds || []).filter((k) => !remove.has(k.code));
    kinds.forEach((k) => { const v = b[`kindName_${k.code}`]; if (typeof v === 'string') k.name = v.trim().slice(0, 60); });
    // Bare barcodes from before kinds: named ones become kinds.
    (cat.barcodes || []).forEach((code) => {
      if (remove.has(code) || kinds.some((k) => k.code === code)) return;
      const v = String(b[`kindName_${code}`] || '').trim();
      if (v) kinds.push({ code, name: v.slice(0, 60), by: user.name, at: new Date() });
    });
    await CatalogItem.updateOne({ _id: cat._id }, { $set: { kinds, barcodes: (cat.barcodes || []).filter((c) => !remove.has(c)) } });
  }
  const typed = String(b.kindAdd || '').replace(/\D/g, '');
  if (typed) {
    if (!CODE.test(typed)) notes.push('That barcode should be 8 to 14 digits.');
    else {
      const code = norm(typed);
      const other = await CatalogItem.findOne({ householdId: user.householdId, key: { $ne: key }, barcodes: code }, { name: 1 }).lean();
      await remember(user.householdId, code, key, '', { name, kindName: String(b.kindAddName || '').trim(), by: user.name });
      if (other) notes.push(`That barcode was on ${other.name}; it’s on ${name} now.`);
      try { await fetchKindPhoto(user, key, code); } catch { /* no photo is fine */ }
    }
  }
  return notes.join(' ');
}

module.exports = { kindsOf, kindName, kindsFor, kindsByKey, fetchKindPhoto, applyKindsForm };
