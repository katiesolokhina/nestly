// Household settings, read with their defaults, for use anywhere.
const { SECTIONS } = require('./sections');

// What this household calls a section ("Reminders" instead of "Remember").
function sectionName(household, key) {
  const custom = (household && household.sectionNames || []).find((n) => n.key === key && n.label);
  const base = SECTIONS.find((s) => s.key === key);
  return custom ? custom.label : base ? base.label : key;
}

const pantryNames = (household) => {
  const n = (household && household.pantryNames) || {};
  return { have: n.have || 'Have', low: n.low || 'Low', out: n.out || 'Out' };
};

const currency = (household) => (household && household.currency) || '$';

// Which pantry statuses put an item on the shopping list.
function shopsFor(household, status) {
  const rule = (household && household.pantryShop) || 'both';
  if (rule === 'never' || status === 'have') return false;
  return rule === 'both' || status === 'out';
}

module.exports = { sectionName, pantryNames, currency, shopsFor };
