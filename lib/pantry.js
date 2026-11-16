// Pantry and Shopping working together.
const PantryItem = require('../models/PantryItem');
const ShoppingItem = require('../models/ShoppingItem');
const CatalogItem = require('../models/CatalogItem');
const { fromCatalog } = require('./catalog');
const { diffDays, dayLabel } = require('./dates');
const { shopsFor, pantryNames } = require('./prefs');
const { logActivity } = require('./activity');

const STATUS = { have: 'Have', low: 'Low', out: 'Out' };

// Low or Out: put it on the shopping list, unless it's there already. Returns true if added.
// With the same thing kept as separate items, only when none of them is still Have.
async function addToShopping(user, household, item) {
  if (!item.autoShop || !shopsFor(household, item.status) || household.features.shopping === false) return false;
  if (await PantryItem.exists({ householdId: user.householdId, key: item.key, _id: { $ne: item._id }, status: 'have' })) return false;
  const already = await ShoppingItem.exists({ householdId: user.householdId, key: item.key, bought: false, clearedAt: null });
  if (already) return false;
  const c = await CatalogItem.findOne({ householdId: user.householdId, key: item.key }).lean();
  await ShoppingItem.create({ ...fromCatalog(user, item.name, c, household), note: `Pantry: ${pantryNames(household)[item.status]}` });
  return true;
}

// Bought on the shopping list: if it's something the pantry keeps, it waits on the Pantry page
// to be put away (as a separate item, replacing one, or added to one's count, with its date).
// Unticked: it stops waiting. Call before saving the shopping item.
// Everything bought waits in Pantry → Put away until someone adds it or dismisses it.
// Saved items set to "always skip the details" go straight into the pantry instead.
async function markPutAway(user, item, household) {
  if (!item.bought) { item.putAway = ''; return; }
  const auto = household && (await CatalogItem.exists({ householdId: user.householdId, key: item.key, autoPantry: true }));
  if (!auto) { item.putAway = 'pending'; return; }
  await quickStock(user, household, item);
  item.putAway = 'done';
}

// Is it food (for recipes and "use soon")? Its own setting, else its spot.
function isFood(h, p) {
  if (p.food === true || p.food === false) return p.food;
  return !(h.nonFoodSpots || []).includes(p.spot);
}

// Where something from a shopping aisle is kept: the household's choice, else a guess from the
// names (Frozen → Freezer, Dairy → Fridge), else the default spot.
const GUESS = [[/frozen|freez/i, /freez/i], [/dairy|egg|meat|seafood|fish|deli/i, /fridge|refrig/i], [/pantry|canned|dry|baking|snack|cereal|pasta/i, /pantry/i], [/spice|season/i, /spice/i], [/clean|household|laundry/i, /clean/i], [/bath|personal|health|beauty|toilet/i, /bath/i]];
function defaultSpot(h) {
  return h.pantrySpots.includes(h.pantryDefaultSpot) ? h.pantryDefaultSpot : h.pantrySpots[0] || 'Other';
}
function guessSpot(h, aisle) {
  const g = GUESS.find(([a]) => a.test(aisle || ''));
  return (g && h.pantrySpots.find((s) => g[1].test(s))) || '';
}
function spotFor(h, aisle) {
  const saved = (h.aisleSpots || []).find((m) => m.aisle === aisle);
  if (saved && h.pantrySpots.includes(saved.spot)) return saved.spot;
  return guessSpot(h, aisle) || defaultSpot(h);
}

// "Skip the details": puts a bought item in the pantry as Have with no date. Already there → adds
// to its count; otherwise a new item in its aisle's spot. Logs it.
async function quickStock(user, household, shop) {
  const { visible } = require('./changes'); // here, to keep the requires one-way
  const existing = await PantryItem.find({ ...visible(user), key: shop.key }).sort({ createdAt: 1 });
  const target = existing.find((p) => p.status !== 'out') || existing[0] || null;
  const c = await CatalogItem.findOne({ householdId: user.householdId, key: shop.key }, { name: 1 }).lean();
  const { item, text } = await stockIn(user, {
    name: (c && c.name) || shop.name, key: shop.key, spot: spotFor(household, shop.aisle),
    batches: [{ count: countOf(shop.qty), expires: '' }], choice: target ? 'add' : 'new', target,
  });
  await logActivity(user, { section: 'Pantry', text: `${user.name} ${text}` });
  return item;
}

// How many came home, from the shopping quantity: "2" is 2, "2 lbs" or "a bag" is 1.
const countOf = (qty) => { const n = parseInt(String(qty || '').trim(), 10); return /^\d+$/.test(String(qty || '').trim()) && n >= 1 && n <= 99 ? n : 1; };

// Adds batches to an item, joining ones with the same date: [{ count, expires }].
function addBatches(item, batches) {
  if (!item.batches) item.syncBatches();
  for (const b of batches) {
    const same = item.batches.find((x) => (x.expires || '') === (b.expires || ''));
    if (same) same.count = Math.min(999, same.count + b.count);
    else item.batches.push({ count: b.count, expires: b.expires || '' });
  }
}

// Puts something in the pantry. choice: 'new' (its own item), 'replace' (target starts over with
// these), or 'add' (these join target's batches, each with its own date).
// batches: [{ count, expires }]. Returns { item, text } for the activity log.
async function stockIn(user, { name, key, spot, amount = '', batches = [{ count: 1, expires: '' }], choice = 'new', target = null }) {
  const now = { status: 'have', statusBy: user.name, statusAt: new Date() };
  const n = batches.reduce((t, b) => t + b.count, 0);
  if (choice !== 'new' && target) {
    if (choice === 'replace') {
      target.set({ ...now, batches, ...(amount ? { amount } : {}) });
      await target.save();
      return { item: target, text: `restocked ${target.name}` };
    }
    target.set(now);
    addBatches(target, batches);
    await target.save();
    return { item: target, text: `added ${n} to ${target.name} (${target.count} now)` };
  }
  const item = await PantryItem.create({ householdId: user.householdId, createdBy: user._id, byName: user.name, name, key, spot, amount, batches, ...now });
  return { item, text: `added ${n > 1 ? `${n} ` : ''}${item.name} to the pantry` };
}

// "Expires tomorrow", "Expired 2 days ago", or '' when it's not close.
function expiryText(expires, today, soonDays = 3) {
  if (!expires) return { text: '', tone: '' };
  const d = diffDays(today, expires);
  if (d < 0) return { text: `Expired ${-d === 1 ? 'yesterday' : `${-d} days ago`}`, tone: 'late' };
  if (d === 0) return { text: 'Expires today', tone: 'late' };
  if (d <= soonDays) return { text: `Expires ${d === 1 ? 'tomorrow' : `in ${d} days`}`, tone: 'soon' };
  return { text: `Use by ${dayLabel(expires, today)}`, tone: '' };
}

module.exports = { isFood, STATUS, addToShopping, markPutAway, quickStock, spotFor, guessSpot, defaultSpot, countOf, stockIn, addBatches, expiryText };
