// One-time cleanup: the same photo saved twice (e.g. a barcode's photo downloaded again when it
// became a kind) is pointed at one file, and the extra copy is deleted when nothing else uses it.
// Also fingerprints older photos, so identical ones are reused from now on.
//
//   node scripts/dedupe-photos.js            (see what it would do: changes nothing)
//   node scripts/dedupe-photos.js --apply    (do it)
//
// Only shared (not private) photos are merged. Safe to run more than once.
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const { filePath } = require('../lib/uploads');
const Upload = require('../models/Upload');
const PantryItem = require('../models/PantryItem');
const CatalogItem = require('../models/CatalogItem');
const ShoppingItem = require('../models/ShoppingItem');
const Recipe = require('../models/Recipe');
const Event = require('../models/Event');
const InfoItem = require('../models/InfoItem');
const Bill = require('../models/Bill');
const Feedback = require('../models/Feedback');

const apply = process.argv.includes('--apply');

async function usedAnywhere(id) {
  const hits = await Promise.all([
    PantryItem.exists({ photoId: id }), ShoppingItem.exists({ $or: [{ photoId: id }, { receiptId: id }] }), Recipe.exists({ photoId: id }),
    CatalogItem.exists({ 'kinds.photoId': id }), Event.exists({ fileId: id }), InfoItem.exists({ fileIds: id }),
    Bill.exists({ receiptId: id }), Feedback.exists({ shots: id }),
  ]);
  return hits.some(Boolean);
}

(async () => {
  await connectDB(process.env.MONGODB_URI);

  // 1. Fingerprint photos saved before fingerprints existed.
  let hashed = 0;
  let missing = 0;
  for (const u of await Upload.find({ $or: [{ hash: '' }, { hash: { $exists: false } }] })) {
    let buf;
    try { buf = await fs.readFile(filePath(u)); } catch { missing += 1; continue; }
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (apply) await Upload.updateOne({ _id: u._id }, { $set: { hash } });
    u.hash = hash;
    hashed += 1;
  }
  console.log(`${apply ? "Fingerprinted" : "Would fingerprint"} ${hashed} older file(s)${missing ? `; ${missing} had no file on disk (left alone)` : ''}.`);

  // 2. Identical shared photos in a household: keep the oldest, point everything at it.
  const all = await Upload.find({ private: false }).sort({ createdAt: 1 }).lean();
  const fresh = apply ? null : new Map((await Upload.find({ $or: [{ hash: '' }, { hash: { $exists: false } }] }).lean()).map((u) => [String(u._id), u]));
  const groups = new Map();
  for (const u of all) {
    let hash = u.hash;
    if (!hash && fresh) { // dry run: fingerprint in memory
      try { hash = crypto.createHash('sha256').update(await fs.readFile(filePath(u))).digest('hex'); } catch { continue; }
    }
    if (!hash) continue;
    const k = `${u.householdId}:${hash}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(u);
  }
  let repointed = 0;
  let deleted = 0;
  let kept = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const [keep, ...dups] = list;
    const ids = dups.map((d) => d._id);
    console.log(`Same photo ×${list.length} (household ${keep.householdId}): keeping ${keep._id}`);
    if (!apply) { repointed += ids.length; continue; }
    await PantryItem.updateMany({ photoId: { $in: ids } }, { $set: { photoId: keep._id } });
    await ShoppingItem.updateMany({ photoId: { $in: ids } }, { $set: { photoId: keep._id } });
    await Recipe.updateMany({ photoId: { $in: ids } }, { $set: { photoId: keep._id } });
    await CatalogItem.updateMany({ 'kinds.photoId': { $in: ids } }, { $set: { 'kinds.$[k].photoId': keep._id } }, { arrayFilters: [{ 'k.photoId': { $in: ids } }] });
    repointed += ids.length;
    for (const d of dups) {
      if (await usedAnywhere(d._id)) { kept += 1; continue; } // a receipt or a file somewhere else: leave it
      await fs.rm(filePath(d), { force: true });
      await Upload.deleteOne({ _id: d._id });
      deleted += 1;
    }
  }
  console.log(apply
    ? `Pointed ${repointed} copy(ies) at one file; deleted ${deleted} extra file(s)${kept ? `, kept ${kept} still used elsewhere` : ''}.`
    : `Would merge ${repointed} copy(ies). Nothing changed. Run again with --apply to do it.`);
})()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
