// Scaling recipe amounts: "1 1/2 cups" × 2 = "3 cups", "½ tsp" × 3 = "1 ½ tsp", "2-3 cloves" × 2 = "4-6 cloves".
// Amounts with no number ("a pinch", "to taste") stay as they are.
const FRACTIONS = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };
const NICE = [[0, ''], [0.125, '⅛'], [0.25, '¼'], [1 / 3, '⅓'], [0.375, '⅜'], [0.5, '½'], [0.625, '⅝'], [2 / 3, '⅔'], [0.75, '¾'], [0.875, '⅞'], [1, '']];

// One number at the start: "1 1/2", "1/2", "1½", "1 ½", "1.5", "½". Returns its value and length.
const U = '[¼½¾⅓⅔⅛⅜⅝⅞]';
const NUM = new RegExp(`^(?:(\\d+)\\s+(\\d+)\\s*/\\s*(\\d+)|(\\d+)\\s*/\\s*(\\d+)|(\\d+(?:\\.\\d+)?)\\s*(${U})|(\\d+(?:\\.\\d+)?)|(${U}))`);

function readNumber(s) {
  const m = s.match(NUM);
  if (!m) return null;
  let value;
  if (m[1]) value = Number(m[1]) + Number(m[2]) / Number(m[3]);
  else if (m[4]) value = Number(m[4]) / Number(m[5]);
  else if (m[6]) value = Number(m[6]) + FRACTIONS[m[7]];
  else if (m[8]) value = Number(m[8]);
  else value = FRACTIONS[m[9]];
  return Number.isFinite(value) ? { value, length: m[0].length } : null;
}

// Nice to read: whole numbers, kitchen fractions, or one decimal for big numbers.
function format(n) {
  if (n >= 10) return String(Math.round(n * 10) / 10).replace(/\.0$/, '');
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  const [near, sign] = NICE.reduce((best, cur) => (Math.abs(cur[0] - frac) < Math.abs(best[0] - frac) ? cur : best));
  if (Math.abs(near - frac) > 0.06) return String(Math.round(n * 100) / 100); // not a kitchen fraction: 0.4
  if (near === 1) return String(whole + 1);
  if (!sign) return String(whole || 0);
  return whole ? `${whole} ${sign}` : sign;
}

// Units that change with the amount: "1 cup", "2 cups".
const UNITS = ['cup', 'tablespoon', 'teaspoon', 'pound', 'ounce', 'clove', 'can', 'jar', 'slice', 'stick', 'package', 'bag', 'bunch', 'head', 'sprig', 'stalk', 'pinch', 'dash', 'piece', 'handful', 'quart', 'pint', 'gallon', 'liter', 'litre', 'gram', 'kilogram'];
const plural = (u) => (/(ch|sh)$/.test(u) ? `${u}es` : `${u}s`);
function fitUnit(after, n) {
  return after.replace(/^(\s*)([a-z]+)\b/i, (m, sp, word) => {
    const lower = word.toLowerCase();
    const single = UNITS.find((u) => lower === u || lower === plural(u));
    if (!single) return m;
    const want = n > 1 ? plural(single) : single;
    return sp + (word[0] === word[0].toUpperCase() ? want[0].toUpperCase() + want.slice(1) : want);
  });
}

function scaleQty(qty, factor) {
  const text = String(qty || '').trim();
  if (!text || factor === 1) return text;
  const lead = text.match(/^(about\s+)?/i)[0];
  const rest = text.slice(lead.length);
  const a = readNumber(rest);
  if (!a || !a.value) return text;
  let after = rest.slice(a.length);
  let out = format(a.value * factor);
  let top = a.value * factor; // the amount the unit is read with ("1-1 ½ cups": 1 ½)
  // A range: "2-3", "2 to 3"
  const range = after.match(/^\s*(-|–|to)\s*/);
  if (range) {
    const b = readNumber(after.slice(range[0].length));
    if (b && b.value) {
      out += `${range[1] === 'to' ? ' to ' : '-'}${format(b.value * factor)}`;
      after = after.slice(range[0].length + b.length);
      top = b.value * factor;
    }
  }
  return `${lead}${out}${fitUnit(after, top)}`.replace(/\s+/g, ' ').trim();
}

// "4", "4-6", "Serves 6", "makes 12 cookies" -> 4, 4, 6, 12; nothing usable -> null.
function servingsNum(servings) {
  const m = String(servings || '').match(/\d+(?:\.\d+)?/);
  const n = m ? parseFloat(m[0]) : NaN;
  return n > 0 && n < 1000 ? n : null;
}

module.exports = { scaleQty, servingsNum, format, readNumber };
