// One-time cleanup: the same photo saved twice (e.g. a barcode's photo downloaded again when it
// became a kind) is pointed at one file, and the extra copy is deleted when nothing else uses it.
// Also fingerprints older photos, so identical ones are reused from now on.
//
//   node scripts/dedupe-photos.js            (see what it would do: changes nothing)
//   node scripts/dedupe-photos.js --apply    (do it)
//   node scripts/dedupe-photos.js --report   (changes nothing; writes photo-dupes.html showing each
//                                             group of copies side by side and what uses each one)
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

const report = process.argv.includes('--report');
const apply = process.argv.includes('--apply') && !report;

// Where a photo is used, in words ("Pantry: Cocoa", "Kind: Cocoa → Ghirardelli").
async function usedBy(id) {
  const [p, c, s, r, e, i, b, f] = await Promise.all([
    PantryItem.find({ photoId: id }, { name: 1, spot: 1 }).lean(), CatalogItem.find({ 'kinds.photoId': id }, { name: 1, kinds: 1 }).lean(),
    ShoppingItem.find({ $or: [{ photoId: id }, { receiptId: id }] }, { name: 1, receiptId: 1 }).lean(), Recipe.find({ photoId: id }, { title: 1 }).lean(),
    Event.find({ fileId: id }, { title: 1 }).lean(), InfoItem.find({ fileIds: id }, { title: 1 }).lean(), Bill.find({ receiptId: id }, { name: 1 }).lean(),
    Feedback.find({ shots: id }, { _id: 1 }).lean(),
  ]);
  return [
    ...p.map((x) => `Pantry item: ${x.name}${x.spot ? ` (${x.spot})` : ''}`),
    ...c.flatMap((x) => x.kinds.filter((k) => String(k.photoId) === String(id)).map((k) => `Kind: ${x.name} → ${k.name || 'Unnamed'}`)),
    ...s.map((x) => `Shopping: ${x.name}${String(x.receiptId) === String(id) ? ' (receipt)' : ''}`), ...r.map((x) => `Recipe: ${x.title}`),
    ...e.map((x) => `Calendar: ${x.title}`), ...i.map((x) => `Info: ${x.title}`), ...b.map((x) => `Bill: ${x.name}`), ...f.map(() => 'Feedback screenshot'),
  ];
}
const esc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

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
  if (report) {
    const parts = [];
    let n = 0;
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      n += 1;
      const cards = [];
      for (const [i, u] of list.entries()) {
        let img = '<div class="none">File missing</div>';
        try { img = `<img src="data:${esc(u.type)};base64,${(await fs.readFile(filePath(u))).toString('base64')}" alt="">`; } catch { /* missing */ }
        const uses = await usedBy(u._id);
        cards.push(`<div class="card${i === 0 ? ' keep' : ''}">${img}<b>${i === 0 ? 'Kept' : 'Copy → merged into the kept one'}</b>`
          + `<small>${esc(u._id)} · ${esc(new Date(u.createdAt).toLocaleString('en-US'))} · ${Math.round(u.size / 1024)} KB</small>`
          + `<ul>${uses.length ? uses.map((x) => `<li>${esc(x)}</li>`).join('') : '<li class="muted">Not used by anything</li>'}</ul></div>`);
      }
      parts.push(`<section><h2>Group ${n}: the same picture ×${list.length}</h2><div class="row">${cards.join('')}</div></section>`);
    }
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Duplicate photos</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;background:#F7F4FB;color:#1F2230}h1{font-size:22px}h2{font-size:16px;margin:24px 0 8px}
.row{display:flex;gap:12px;flex-wrap:wrap}.card{background:#fff;border:2px solid #DCD3E8;border-radius:14px;padding:10px;width:220px;display:flex;flex-direction:column;gap:6px}
.card.keep{border-color:#6B4C8F}.card img{width:100%;height:200px;object-fit:contain;background:#EEEAF3;border-radius:10px}.none{height:200px;display:grid;place-items:center;background:#FBE9E1;border-radius:10px}
small{color:#5D5A6E;overflow-wrap:anywhere}ul{margin:0;padding-left:18px;font-size:14px}.muted{color:#5D5A6E}</style>
<h1>Duplicate photos: ${n} group(s)</h1><p>Every picture in a group is the exact same file, byte for byte. With <code>--apply</code>, everything that uses a copy switches to the kept one (purple border), and the copy is deleted when nothing else uses it.</p>${parts.join('')}`;
    await fs.writeFile('photo-dupes.html', html);
    console.log(`Wrote photo-dupes.html (${n} group(s)). Nothing changed.`);
    return;
  }
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
