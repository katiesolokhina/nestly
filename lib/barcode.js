// What a scanned barcode is. First the household's own saved items (a code scanned once is
// remembered), then Open Food Facts, a free public product database (best for food).
const CatalogItem = require('../models/CatalogItem');

const OFF = () => (process.env.OFF_URL || 'https://world.openfoodfacts.org').replace(/\/$/, '');
const CODE = /^\d{8,14}$/;
const cache = new Map(); // code -> { at, product|null }, so the same code isn't looked up again for a day
const DAY = 86400000;

// UPC-A (12 digits) is EAN-13 with a leading 0; phones report either, so they're stored as 13.
const norm = (code) => (String(code).length === 12 ? `0${code}` : String(code));
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Only Open Food Facts' own image server, over https.
function okImage(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:' && /(^|\.)openfoodfacts\.org$/.test(u.hostname) ? u.href : '';
  } catch {
    return '';
  }
}

async function fromOpenFoodFacts(code) {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < DAY) return hit.product;
  let product = null;
  try {
    const res = await fetch(`${OFF()}/api/v2/product/${code}.json?fields=product_name,generic_name,brands,quantity,image_front_url`, {
      headers: { 'User-Agent': 'Nestly/1.0 (household app; https://nestly.trisolocreations.com)' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const p = data && data.status === 1 && data.product;
      const name = p && clean(p.product_name || p.generic_name, 80);
      if (name) product = { name, brand: clean(String(p.brands || '').split(',')[0], 80), size: clean(p.quantity, 40), image: okImage(p.image_front_url) };
    }
  } catch {
    return null; // offline or slow: not cached, so the next scan tries again
  }
  cache.set(code, { at: Date.now(), product });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return product;
}

// { code, name, brand, size, source: 'saved' | 'lookup' | null, catalog }
async function lookup(householdId, raw) {
  if (!CODE.test(raw)) return null;
  const code = norm(raw);
  const saved = await CatalogItem.findOne({ householdId, barcodes: code }).lean();
  if (saved) return { code, name: saved.name, brand: saved.brand || '', size: '', source: 'saved', catalog: saved };
  const p = await fromOpenFoodFacts(code);
  return p ? { code, ...p, source: 'lookup', catalog: null } : { code, name: '', brand: '', size: '', source: null, catalog: null };
}

// Remembers that this code means this saved item (and no other).
async function remember(householdId, raw, key, brand) {
  if (!CODE.test(raw)) return;
  const code = norm(raw);
  await CatalogItem.updateMany({ householdId, barcodes: code, key: { $ne: key } }, { $pull: { barcodes: code } });
  await CatalogItem.updateOne({ householdId, key }, { $addToSet: { barcodes: code } });
  if (brand) await CatalogItem.updateOne({ householdId, key, brand: '' }, { $set: { brand: clean(brand, 80) } });
}

// The product's front photo from Open Food Facts, as a file to save ({ buffer, originalname }), or
// null. Used as the pantry item's reference photo when someone keeps "Use the product's photo".
async function productPhotoUrl(raw) {
  if (!CODE.test(String(raw || ''))) return '';
  const p = await fromOpenFoodFacts(norm(raw));
  return (p && p.image) || '';
}
async function productPhoto(raw) {
  const url = await productPhotoUrl(raw);
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Nestly/1.0 (household app; https://nestly.trisolocreations.com)' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
    return { buffer, originalname: `product${require('node:path').extname(new URL(url).pathname) || '.jpg'}` };
  } catch {
    return null;
  }
}

module.exports = { lookup, remember, productPhotoUrl, productPhoto, CODE };
