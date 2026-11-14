// Reading ingredient lines like "2 cups all-purpose flour, sifted" and combining them for shopping.
const { keyOf } = require('./catalog');

const UNITS = [
  'cups?', 'c\\.', 'tablespoons?', 'tbsps?\\.?', 'tbs\\.?', 'T', 'teaspoons?', 'tsps?\\.?', 't',
  'ounces?', 'oz\\.?', 'fl\\.? ?oz\\.?', 'pounds?', 'lbs?\\.?', 'grams?', 'g', 'kilograms?', 'kg',
  'milliliters?', 'millilitres?', 'ml', 'liters?', 'litres?', 'l', 'quarts?', 'qts?\\.?', 'pints?', 'pts?\\.?', 'gallons?', 'gal\\.?',
  'cloves?', 'cans?', 'jars?', 'packages?', 'pkgs?\\.?', 'packets?', 'sticks?', 'slices?', 'pieces?', 'bunch(?:es)?', 'heads?',
  'sprigs?', 'stalks?', 'pinch(?:es)?', 'dash(?:es)?', 'handfuls?', 'bags?', 'boxes?', 'bottles?',
  'large', 'medium', 'small',
];
const AMOUNT = '(?:about\\s+)?[\\d¼½¾⅓⅔⅛⅜⅝⅞]+(?:[\\s.,/\\-–]*[\\d¼½¾⅓⅔⅛⅜⅝⅞]+)*(?:\\s*(?:to|-|–)\\s*[\\d¼½¾⅓⅔⅛]+)?';
const LINE = new RegExp(`^(${AMOUNT}(?:\\s*\\([^)]{1,30}\\))?(?:\\s*(?:${UNITS.join('|')})(?![a-z]))?\\.?)\\s+(?:of\\s+)?(.+)$`, 'i');
const UNIT_ONLY = new RegExp(`^((?:a\\s+)?(?:pinch|dash|handful)(?:\\s+of)?)\\s+(.+)$`, 'i');

// "2 cups flour, sifted" -> { qty: '2 cups', name: 'flour, sifted' }
function parseIngredient(line) {
  const text = String(line || '').replace(/^[\s•\-*–·▢□☐]+/, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const m = text.match(LINE) || text.match(UNIT_ONLY);
  if (m) return { qty: m[1].trim().slice(0, 40), name: m[2].trim().slice(0, 120) };
  return { qty: '', name: text.slice(0, 120) };
}

// What goes on the shopping list for an ingredient: the name without notes after a comma,
// without "(optional)"-style asides, and without leading words like "fresh" kept as they are.
function shoppingName(name) {
  return String(name || '')
    .split(/,|;| - | – /)[0]
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Combines ingredients from several recipes into one row per item, for the shopping review.
// rows: [{ qty, name, from }] -> [{ key, name, qty, from: [recipe titles] }]
function combine(rows) {
  const out = new Map();
  rows.forEach(({ qty, name, from }) => {
    const label = shoppingName(name);
    if (!label) return;
    const key = keyOf(label);
    const row = out.get(key) || { key, name: label, qtys: [], from: [] };
    if (qty) row.qtys.push(qty);
    if (from && !row.from.includes(from)) row.from.push(from);
    out.set(key, row);
  });
  return [...out.values()].map((r) => ({ key: r.key, name: r.name, qty: r.qtys.join(' + ').slice(0, 30), from: r.from }));
}

module.exports = { parseIngredient, shoppingName, combine };
