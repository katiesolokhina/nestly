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


// ---------- Types and prep ----------
// Types that read after the item: "chicken breast", not "breast chicken".
const AFTER = new Set(['breast', 'breasts', 'thigh', 'thighs', 'wing', 'wings', 'drumstick', 'drumsticks', 'leg', 'legs', 'tenderloin', 'tenderloins', 'loin', 'chop', 'chops', 'fillet', 'fillets', 'steak', 'steaks', 'roast', 'shoulder', 'ribs', 'cutlets', 'cutlet']);
// Types that read before it, to start with; the household's own add to these.
const BEFORE = ['red', 'yellow', 'green', 'orange', 'white', 'purple', 'brown', 'sweet', 'russet', 'yukon gold', 'roma', 'cherry', 'baby', 'ground', 'boneless skinless', 'boneless', 'skinless', 'unsalted', 'salted', 'whole', 'skim', 'extra virgin', 'smoked', 'dark', 'light'];
const MOD = '(?:finely|roughly|coarsely|thinly|thickly|freshly|lightly|very|well)';

// What an ingredient is called on the shopping list: type and item, in the order they're said.
function itemName(ing) {
  const name = shoppingName(ing.name);
  const type = String(ing.type || '').trim();
  if (!type) return name;
  if (name.toLowerCase().includes(type.toLowerCase())) return name;
  return (AFTER.has(type.toLowerCase()) ? `${name} ${type}` : `${type} ${name}`).slice(0, 80);
}

// How an ingredient reads in a recipe: "red bell pepper, diced".
// Works on saved subdocuments too, so it reads fields one by one.
function ingredientText(ing) {
  const name = String(ing.name || '').trim();
  const rest = shoppingName(name) !== name ? name.slice(shoppingName(name).length) : ''; // ", sifted"
  return [`${itemName({ type: ing.type, name })}${rest}`, ing.prep].filter(Boolean).join(', ').replace(/,\s*,/g, ',');
}

// Best guess at type and prep in an imported line: "red bell pepper, finely diced" ->
// { type: 'red', name: 'bell pepper', prep: 'finely diced' }. types: ones this household has used.
function splitIngredient(ing, { preps = [], types = [] } = {}) {
  let name = String(ing.name || '').trim();
  let prep = '';
  let type = '';
  const prepList = preps.map((p) => p.toLowerCase());
  const isPrep = (s) => {
    const t = s.trim().toLowerCase().replace(new RegExp(`^${MOD}\\s+`), '').replace(/\s+(?:into|in)\s+.*$/, '').trim();
    return prepList.includes(t) || prepList.some((p) => t.startsWith(`${p} `));
  };
  // After a comma: "onion, finely diced"
  const parts = name.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const found = parts.slice(1).filter(isPrep);
    if (found.length) {
      prep = found.join(', ');
      name = [parts[0], ...parts.slice(1).filter((p) => !found.includes(p))].join(', ');
    }
  }
  // In front: "diced onion", "finely chopped parsley"
  if (!prep) {
    const m = name.match(new RegExp(`^((?:${MOD}\\s+)?(\\S+))\\s+(.+)$`, 'i'));
    if (m && prepList.includes(m[2].toLowerCase())) { prep = m[1]; name = m[3]; }
  }
  // Type: a known word or two at the start ("red bell pepper"), or a cut at the end ("chicken thighs").
  const head = shoppingName(name);
  const known = [...new Set([...types, ...BEFORE])].filter(Boolean).sort((a, b) => b.length - a.length);
  const t = known.find((k) => head.toLowerCase().startsWith(`${k.toLowerCase()} `));
  if (t) {
    type = head.slice(0, t.length);
    name = name.slice(t.length).trim();
  } else {
    const words = head.split(' ');
    if (words.length > 1 && AFTER.has(words[words.length - 1].toLowerCase())) {
      type = words.pop();
      name = words.join(' ') + name.slice(head.length);
    }
  }
  return { qty: ing.qty || '', type: type.slice(0, 40), name: name.slice(0, 120), prep: prep.slice(0, 60) };
}

module.exports = { parseIngredient, shoppingName, combine, itemName, ingredientText, splitIngredient, BEFORE };
