// Converting recipe amounts between units: "2 ¼ cups" flour -> "540 ml", "270 g" or back to cups.
// Cups <-> grams needs the ingredient: a cup of flour weighs 120 g, a cup of sugar 198 g.
// Weights per cup are King Arthur Baking's ingredient weight chart (kingarthurbaking.com).
const { readNumber, format } = require('./scale');

const ML = { cup: 236.588, tbsp: 14.787, tsp: 4.929, floz: 29.574, ml: 1, l: 1000, pint: 473.176, quart: 946.353, gallon: 3785.41 };
const G = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };

// [words to find in the ingredient, grams per cup].
const PER_CUP = [
  ['all-purpose flour', 120], ['all purpose flour', 120], ['bread flour', 120], ['cake flour', 120], ['pastry flour', 106],
  ['whole wheat flour', 113], ['almond flour', 96], ['rye flour', 106], ['semolina', 163], ['cornmeal', 138], ['cornstarch', 112],
  ['self-rising flour', 113], ['flour', 120],
  ['brown sugar', 213], ['powdered sugar', 113], ["confectioners' sugar", 113], ['confectioners sugar', 113], ['icing sugar', 113], ['sugar', 198],
  ['cocoa', 84], ['chocolate chips', 170], ['chocolate chip', 170], ['mini marshmallows', 43], ['marshmallows', 43],
  ['butter', 227], ['peanut butter', 270], ['cream cheese', 227], ['ricotta', 227], ['sour cream', 227], ['greek yogurt', 227], ['yogurt', 227],
  ['heavy cream', 227], ['whipping cream', 227], ['half and half', 227], ['half-and-half', 227], ['buttermilk', 227], ['milk', 227], ['cream', 227],
  ['olive oil', 200], ['vegetable oil', 198], ['canola oil', 198], ['coconut oil', 198], ['oil', 198],
  ['honey', 336], ['maple syrup', 312], ['corn syrup', 312], ['molasses', 340], ['vanilla', 224], ['water', 237],
  ['kosher salt', 128], ['salt', 288], ['baking soda', 288], ['baking powder', 192],
  ['rolled oats', 113], ['oats', 113], ['raisins', 149], ['pecans', 114], ['sweetened coconut', 85], ['coconut', 53],
  ['shredded cheese', 113], ['grated cheese', 113], ['cheddar', 113], ['mozzarella', 113], ['rice', 198],
  ['graham cracker crumbs', 100], ['breadcrumbs', 112], ['bread crumbs', 112],
];
// Liquids: a plain "oz" of these is read as fl oz.
const LIQUID = /\b(water|milk|buttermilk|cream|half[- ]and[- ]half|oil|juice|broth|stock|wine|beer|vinegar|coffee|tea|soy sauce|liqueur|rum|vodka|bourbon|brandy|extract|soda|lemonade)\b/i;

// The unit right after the number. T and t are case-sensitive (tablespoon, teaspoon).
const UNIT = [
  [/^(fl\.?\s?oz\.?|fluid ounces?)(?![a-z])/i, 'floz'], [/^(cups?|c\.)(?![a-z])/i, 'cup'],
  [/^(tablespoons?|tbsps?\.?|tbs\.?)(?![a-z])/i, 'tbsp'], [/^T(?![a-zA-Z])/, 'tbsp'],
  [/^(teaspoons?|tsps?\.?)(?![a-z])/i, 'tsp'], [/^t(?![a-zA-Z])/, 'tsp'],
  [/^(ounces?|oz\.?)(?![a-z])/i, 'oz'], [/^(pounds?|lbs?\.?)(?![a-z])/i, 'lb'],
  [/^(kilograms?|kg)(?![a-z])/i, 'kg'], [/^(grams?|g)(?![a-z])/i, 'g'],
  [/^(milliliters?|millilitres?|ml)(?![a-z])/i, 'ml'], [/^(liters?|litres?|l)(?![a-z])/i, 'l'],
  [/^(pints?|pts?\.?)(?![a-z])/i, 'pint'], [/^(quarts?|qts?\.?)(?![a-z])/i, 'quart'], [/^(gallons?|gal\.?)(?![a-z])/i, 'gallon'],
  [/^sticks?(?![a-z])/i, 'stick'],
];

const MODES = ['ml', 'g', 'us'];
// Longest names first ("peanut butter" before "butter"), whole words only ("butternut squash" isn't butter).
const BY_LENGTH = PER_CUP.map(([w, g]) => [new RegExp(`\\b${w.replace(/[-']/g, (c) => `\\${c}`)}\\b`, 'i'), g, w.length]).sort((a, b) => b[2] - a[2]);
const perCup = (name) => { const hit = BY_LENGTH.find(([re]) => re.test(String(name || ''))); return hit ? hit[1] : null; };
const isLiquid = (name) => LIQUID.test(String(name || ''));
const isFlour = (name) => /\bflour\b/i.test(String(name || '')) && !/\b(tortilla|dusting)\b/i.test(String(name || ''));

// Reads "about 2 ¼ cups", "2-3 tbsp", "1 stick" -> { lead, nums: [2.25], unit: 'cup', rest } or null.
function read(qty) {
  const text = String(qty || '').trim();
  const lead = text.match(/^(about\s+)?/i)[0];
  let rest = text.slice(lead.length);
  const a = readNumber(rest);
  if (!a || !a.value) return null;
  const nums = [a.value];
  rest = rest.slice(a.length);
  const range = rest.match(/^\s*(-|–|to)\s*/);
  if (range) {
    const b = readNumber(rest.slice(range[0].length));
    if (b && b.value) { nums.push(b.value); rest = rest.slice(range[0].length + b.length); }
  }
  const sp = rest.match(/^\s*/)[0];
  const after = rest.slice(sp.length);
  for (const [re, unit] of UNIT) {
    const m = after.match(re);
    if (m) return { lead, nums, unit, rest: after.slice(m[0].length).trim(), joiner: range ? range[1] : null };
  }
  return { lead, nums, unit: '', rest: after.trim(), joiner: range ? range[1] : null };
}

// One amount in grams, or null when it can't be known (unknown ingredient, a "can").
function gramsOf(n, unit, name, { flOz }) {
  const pc = perCup(name);
  if (unit === 'oz') return flOz ? (pc ? (n * ML.floz / ML.cup) * pc : null) : n * G.oz;
  if (G[unit]) return n * G[unit];
  if (unit === 'stick') return n * 113;
  if (ML[unit]) return pc ? (n * ML[unit] / ML.cup) * pc : null;
  return null;
}
function mlOf(n, unit, { flOz }) {
  if (unit === 'oz') return flOz ? n * ML.floz : null;
  return ML[unit] ? n * ML[unit] : null;
}

const metric = (n, u) => {
  if (n >= 1000) return `${String(Math.round(n / 100) / 10).replace(/\.0$/, '')} ${u === 'g' ? 'kg' : 'l'}`;
  if (n >= 100) return `${u === 'g' ? Math.round(n) : Math.round(n / 5) * 5} ${u}`; // grams exact for a scale; ml to the nearest 5 for a cup
  if (n >= 10) return `${Math.round(n)} ${u}`;
  return `${String(Math.round(n * 2) / 2).replace(/\.0$/, '')} ${u}`;
};
// ml -> the friendliest US measure: cups from ¼ cup, then tablespoons, then teaspoons.
function usVolume(ml) {
  if (ml >= ML.cup / 4 - 1) { const c = ml / ML.cup; return `${format(c)} ${c > 1 ? 'cups' : 'cup'}`; }
  if (ml >= ML.tbsp - 0.5) return `${format(ml / ML.tbsp)} tbsp`;
  return `${format(ml / ML.tsp)} tsp`;
}
const usWeight = (g) => (g >= G.lb ? `${format(g / G.lb)} lb` : `${format(g / G.oz)} oz`);

// Converts one ingredient's amount. factor: the scaler. mode: 'ml' | 'g' | 'us'.
// flipOz: this line's plain "oz" is read the other way. Returns
// { text, changed, oz: 'fl'|'wt'|null, grams } (grams: for baker's %, at this scale).
function convertQty(qty, factor, mode, name, { flipOz = false, egg = false } = {}) {
  const r = read(qty);
  const none = { text: null, changed: false, oz: null, grams: null };
  if (!r) return none;
  const nums = r.nums.map((n) => n * factor);
  const liquid = isLiquid(name);
  const flOz = r.unit === 'floz' || (r.unit === 'oz' && (liquid !== flipOz));
  const unit = r.unit === 'floz' ? 'oz' : r.unit;
  const opt = { flOz };
  const oz = r.unit === 'oz' ? (flOz ? 'fl' : 'wt') : null;
  const grams = unit ? gramsOf(nums[nums.length - 1], unit, name, opt) : (egg ? nums[nums.length - 1] * 50 : null);
  if (!MODES.includes(mode) || !unit) return { ...none, grams, oz };
  const each = (n) => {
    if (mode === 'ml') {
      const ml = mlOf(n, unit, opt);
      if (ml != null) return unit === 'ml' || unit === 'l' ? null : metric(ml, 'ml');
      if (unit !== 'g' && unit !== 'kg') { const g = gramsOf(n, unit, name, opt); if (g != null) return metric(g, 'g'); }
      return null;
    }
    if (mode === 'g') {
      if (unit === 'g' || unit === 'kg') return null;
      const g = gramsOf(n, unit, name, opt);
      if (g != null) return metric(g, 'g');
      const ml = mlOf(n, unit, opt); // a liquid we don't know the weight of: ml at least
      return ml != null && liquid && unit !== 'ml' && unit !== 'l' ? metric(ml, 'ml') : null;
    }
    // us
    if (unit === 'ml' || unit === 'l') return usVolume(mlOf(n, unit, opt));
    if (unit === 'g' || unit === 'kg') {
      const pc = perCup(name);
      return pc ? usVolume((n * G[unit] / pc) * ML.cup) : usWeight(n * G[unit]);
    }
    if (oz === 'fl') return usVolume(n * ML.floz);
    return null;
  };
  const out = nums.map(each);
  if (out.some((o) => o == null)) return { ...none, grams, oz };
  // "2-3 cups" -> "475-710 ml": the unit once, at the end.
  const unitOf = (s) => s.replace(/^[\d¼½¾⅓⅔⅛⅜⅝⅞.\s]+/, '');
  let text = out.length === 2 && unitOf(out[0]) === unitOf(out[1])
    ? `${out[0].slice(0, out[0].length - unitOf(out[0]).length).trim()}${r.joiner === 'to' ? ' to ' : '-'}${out[1]}`
    : out.join(r.joiner === 'to' ? ' to ' : ' - ');
  text = `${r.lead}${text}${r.rest ? ` ${r.rest}` : ''}`.trim();
  return { text, changed: true, oz, grams };
}

// The converter page: n of one unit in another. Volume <-> weight uses the ingredient's weight per
// cup. Returns { value, rule } or { error }.
const PICK_UNITS = ['cup', 'tbsp', 'tsp', 'fl oz', 'ml', 'l', 'g', 'kg', 'oz', 'lb'];
const key = (u) => (u === 'fl oz' ? 'floz' : u);
const INGREDIENTS = [...new Set(PER_CUP.map(([w]) => w))].filter((w) => !['flour', 'oil', 'cream', 'chocolate chip', 'marshmallows', 'confectioners sugar', 'all purpose flour', 'half-and-half', 'bread crumbs', 'grated cheese'].includes(w)).sort();
function convertAmount(n, from, to, ingredient) {
  const f = key(from);
  const t = key(to);
  if (!(n > 0) || !PICK_UNITS.includes(from) || !PICK_UNITS.includes(to)) return { error: 'Enter an amount and pick both units.' };
  const vol = (u) => ML[u] != null;
  if (vol(f) && vol(t)) return { value: (n * ML[f]) / ML[t], rule: 'Volume to volume: no ingredient needed.' };
  if (G[f] != null && G[t] != null) return { value: (n * G[f]) / G[t], rule: 'Weight to weight: no ingredient needed.' };
  const pc = perCup(ingredient);
  if (!pc) return { error: 'Cups and grams need the ingredient: a cup of flour weighs 120 g, a cup of sugar 198 g. Pick one.' };
  const grams = vol(f) ? ((n * ML[f]) / ML.cup) * pc : n * G[f];
  const value = vol(t) ? ((grams / pc) * ML.cup) / ML[t] : grams / G[t];
  return { value, rule: `1 cup ${ingredient} = ${pc} g (King Arthur Baking’s chart).` };
}
const pretty = (v) => (v >= 100 ? String(Math.round(v)) : v >= 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v * 100) / 100));

module.exports = { convertQty, convertAmount, pretty, perCup, isLiquid, isFlour, MODES, PER_CUP, PICK_UNITS, INGREDIENTS };
