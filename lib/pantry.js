// Pantry and Shopping working together.
const PantryItem = require('../models/PantryItem');
const ShoppingItem = require('../models/ShoppingItem');
const CatalogItem = require('../models/CatalogItem');
const { fromCatalog } = require('./catalog');
const { diffDays, dayLabel } = require('./dates');
const { shopsFor, pantryNames } = require('./prefs');

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
async function markPutAway(user, item) {
  item.putAway = item.bought && (await PantryItem.exists({ householdId: user.householdId, key: item.key })) ? 'pending' : '';
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

module.exports = { STATUS, addToShopping, markPutAway, countOf, stockIn, addBatches, expiryText };
