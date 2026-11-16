// A starter set of shopping aisles (in the order of a typical store walk), pantry spots, and
// which spot each aisle's things are kept in. Settings → Pantry adds whatever is missing.
const SPOTS = ['Fridge', 'Freezer', 'Pantry', 'Spices', 'Snacks', 'Drinks', 'Bread box', 'Under sink', 'Cleaning', 'Bathroom', 'Laundry', 'Medicine cabinet', 'Bulk storage', 'Pet supplies'];
const AISLES = [
  ['Produce', ''],
  ['Bakery', 'Bread box'],
  ['Deli', 'Fridge'],
  ['Meat & seafood', 'Fridge'],
  ['Dairy & eggs', 'Fridge'],
  ['Frozen', 'Freezer'],
  ['Canned & jarred', 'Pantry'],
  ['Pasta, rice & grains', 'Pantry'],
  ['Baking', 'Pantry'],
  ['Spices & seasonings', 'Spices'],
  ['Condiments & oils', 'Pantry'],
  ['Breakfast & cereal', 'Pantry'],
  ['Snacks', 'Snacks'],
  ['Drinks', 'Drinks'],
  ['International', 'Pantry'],
  ['Cleaning', 'Cleaning'],
  ['Paper & plastic', 'Bulk storage'],
  ['Laundry', 'Laundry'],
  ['Personal care', 'Bathroom'],
  ['Health & pharmacy', 'Medicine cabinet'],
  ['Baby', ''],
  ['Pet', 'Pet supplies'],
];

const has = (list, v) => list.some((x) => x.toLowerCase() === v.toLowerCase());
const find = (list, v) => list.find((x) => x.toLowerCase() === v.toLowerCase());

// Adds what's missing (keeps existing entries and their order) and maps aisles that aren't mapped
// yet. Returns what was added.
function applyStarter(h, { aisles = true } = {}) {
  const addedSpots = SPOTS.filter((s) => !has(h.pantrySpots, s));
  h.pantrySpots = [...h.pantrySpots, ...addedSpots].slice(0, 100);
  const addedAisles = aisles ? AISLES.map(([a]) => a).filter((a) => !has(h.aisles, a)) : [];
  if (aisles) h.aisles = [...h.aisles, ...addedAisles].slice(0, 100);
  let mapped = 0;
  if (aisles) {
    const map = [...(h.aisleSpots || [])].map((m) => ({ aisle: m.aisle, spot: m.spot }));
    AISLES.forEach(([a, s]) => {
      const aisle = find(h.aisles, a);
      const spot = s && find(h.pantrySpots, s);
      if (aisle && spot && !map.some((m) => m.aisle === aisle)) { map.push({ aisle, spot }); mapped += 1; }
    });
    h.aisleSpots = map;
  }
  return { addedSpots, addedAisles, mapped };
}

module.exports = { SPOTS, AISLES, applyStarter };
