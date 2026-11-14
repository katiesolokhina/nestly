// The household's shared list of things it buys, used by Shopping, Recipes, and Meals.
const CatalogItem = require('../models/CatalogItem');

const keyOf = (name) => name.trim().toLowerCase();

// A first guess for new items, so common groceries land in a sensible aisle. Anyone can change it.
function guessAisle(household, name) {
  const n = name.toLowerCase();
  const rules = [
    ['Produce', /apple|banana|lettuce|spinach|tomato|onion|potato|cilantro|lime|lemon|broccoli|berr|fruit|pepper|carrot|garlic|ginger|herb|basil|parsley|avocado|celery|mushroom|zucchini|cucumber/],
    ['Dairy & eggs', /milk|egg|cheese|yogurt|butter|cream/],
    ['Meat & seafood', /chicken|beef|pork|salmon|fish|turkey|shrimp|sausage|bacon|steak/],
    ['Frozen', /frozen|ice cream/],
    ['Pantry', /flour|sugar|rice|pasta|oil|vinegar|salt|spice|sauce|broth|stock|bean|canned|baking|oats|honey|syrup|cinnamon|paprika|cumin/],
    ['Household', /soap|towel|tissue|detergent|trash|sponge|cleaner/],
  ];
  const hit = rules.find(([aisle, re]) => household.aisles.includes(aisle) && re.test(n));
  return hit ? hit[0] : 'Unassigned';
}

function fromCatalog(user, name, c, household) {
  return {
    householdId: user.householdId, createdBy: user._id, byName: user.name,
    name: c ? c.name : name, key: keyOf(name), qty: c ? c.qty : '1',
    store: c ? c.store : 'Any store', aisle: c ? c.aisle : guessAisle(household, name), tag: c ? c.tag : 'Unassigned',
    method: c ? c.method : 'In person', brand: c ? c.brand : '',
  };
}

// Adds names the catalog hasn't seen yet, so a new recipe ingredient shows up everywhere.
// Existing entries keep their store, aisle, and other details.
function addToCatalog(user, household, names) {
  const unique = [...new Map(names.filter(Boolean).map((n) => [keyOf(n), n])).values()];
  if (!unique.length) return null;
  return CatalogItem.bulkWrite(unique.map((name) => ({
    updateOne: {
      filter: { householdId: user.householdId, key: keyOf(name) },
      update: { $setOnInsert: { name: name.slice(0, 80), key: keyOf(name), aisle: guessAisle(household, name) } },
      upsert: true,
    },
  })));
}

module.exports = { keyOf, guessAisle, fromCatalog, addToCatalog };
