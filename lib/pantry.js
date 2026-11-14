// Pantry and Shopping working together.
const PantryItem = require('../models/PantryItem');
const ShoppingItem = require('../models/ShoppingItem');
const CatalogItem = require('../models/CatalogItem');
const { fromCatalog } = require('./catalog');
const { diffDays, dayLabel } = require('./dates');

const STATUS = { have: 'Have', low: 'Low', out: 'Out' };

// Low or Out: put it on the shopping list, unless it's there already. Returns true if added.
async function addToShopping(user, household, item) {
  if (!item.autoShop || item.status === 'have' || household.features.shopping === false) return false;
  const already = await ShoppingItem.exists({ householdId: user.householdId, key: item.key, bought: false, clearedAt: null });
  if (already) return false;
  const c = await CatalogItem.findOne({ householdId: user.householdId, key: item.key }).lean();
  await ShoppingItem.create({ ...fromCatalog(user, item.name, c, household), note: `Pantry: ${item.status === 'out' ? 'out' : 'running low'}` });
  return true;
}

// Bought on the shopping list: back to Have in the pantry.
function restock(user, key) {
  return PantryItem.updateMany(
    { householdId: user.householdId, key, status: { $ne: 'have' } },
    { $set: { status: 'have', statusBy: user.name, statusAt: new Date() } }
  );
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

module.exports = { STATUS, addToShopping, restock, expiryText };
