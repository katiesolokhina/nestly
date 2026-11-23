// "What can I cook?": the household's recipes ranked by what's in the pantry (and what's about to
// expire), plus recipes found online: Spoonacular when there's a key (SPOONACULAR_KEY), otherwise
// TheMealDB (free, smaller, one ingredient at a time).
const { keyOf } = require('./catalog');
const { itemName, parseIngredient } = require('./ingredients');
const PantryItem = require('../models/PantryItem');
const CatalogItem = require('../models/CatalogItem');
const { visible } = require('./changes');
const { todayIn, addDays } = require('./dates');
const { expiryText, isFood } = require('./pantry');

// What's at home: pantry items that aren't out (one per thing, soonest-expiring first), which of
// them expire by `soonUntil` (default: the household's "expiring soon" days), and "usually have".
async function atHome(req, { soonUntil } = {}) {
  const h = req.household;
  const soonDays = h.pantrySoonDays || 3;
  const today = todayIn(req.user.timezone);
  const until = soonUntil || addDays(today, soonDays);
  const [pantry, usual] = await Promise.all([
    req.sees('pantry') ? PantryItem.find({ ...visible(req.user), status: { $ne: 'out' } }, { name: 1, key: 1, expires: 1, status: 1, spot: 1, food: 1, tags: 1 }).lean().then((all) => all.filter((p) => isFood(h, p))) : [],
    req.sees('shopping') ? CatalogItem.find({ householdId: req.user.householdId, usuallyHave: true }, { key: 1 }).lean() : [],
  ]);
  const byKey = new Map();
  pantry.sort((a, b) => (a.expires || '9999').localeCompare(b.expires || '9999')).forEach((p) => { if (!byKey.has(p.key)) byKey.set(p.key, p); });
  const items = [...byKey.values()].map((p) => {
    const soon = Boolean(p.expires && p.expires <= until);
    return { key: p.key, name: p.name, spot: p.spot, tags: p.tags || [], low: p.status === 'low', expires: p.expires, soon, expText: soon ? expiryText(p.expires, today, Math.max(soonDays, 7)).text : '' };
  });
  return { items, usual: usual.map((c) => c.key) };
}

// ---------- Matching ingredients to what's at home ----------
// "chicken" at home covers "chicken thigh"; "red bell pepper" at home covers "bell pepper".
function covers(haveKey, needKey) {
  if (!haveKey || !needKey) return false;
  if (haveKey === needKey) return true;
  const [short, long] = haveKey.length < needKey.length ? [haveKey, needKey] : [needKey, haveKey];
  if (short.length < 3) return false;
  return new RegExp(`(^|\\s)${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(\\s|$)`).test(long);
}

// recipes: saved recipes. have: keys at home. usual: keys the household "usually has" (salt, oil).
// expiring: [{ key, name, text }]. craving: words to look for in title, tags, category, ingredients.
// cravedKeys: things at home tagged with what's craved ("sweet" → the Sweet ones); recipes using them count.
function rankRecipes(recipes, { have = [], usual = [], expiring = [], craving = '', cravedKeys = [] } = {}) {
  const words = String(craving).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return recipes
    .map((r) => {
      const needs = (r.ingredients || []).map((i) => ({ name: itemName(i), key: keyOf(itemName(i)) })).filter((n) => n.key);
      const missing = [];
      let got = 0;
      const uses = [];
      needs.forEach((n) => {
        if (have.some((h) => covers(h, n.key))) got += 1;
        else if (usual.some((u) => covers(u, n.key))) got += 1;
        else missing.push(n.name);
        const exp = expiring.find((e) => covers(e.key, n.key));
        if (exp && !uses.includes(exp)) uses.push(exp);
      });
      const text = [r.title, r.category, ...(r.tags || []), ...needs.map((n) => n.name)].join(' ').toLowerCase();
      const craved = !words.length || words.some((w) => text.includes(w)) || needs.some((n) => cravedKeys.some((k) => covers(k, n.key)));
      const more = missing.length > 4 ? ` +${missing.length - 4} more` : '';
      return {
        recipe: r, total: needs.length, got, missing, uses, craved, keys: needs.map((n) => n.key), text, score: needs.length ? got / needs.length : 0,
        // "Have 3 of 9 · Missing 6", and on its own line which ones.
        counts: missing.length ? `Have ${got} of ${needs.length} · Missing ${missing.length}` : `Have all ${needs.length}`,
        missingText: missing.length ? `Missing: ${missing.slice(0, 4).join(', ')}${more}` : '',
      };
    })
    .filter((x) => x.craved && x.total)
    .sort((a, b) => b.uses.length - a.uses.length || b.score - a.score || a.missing.length - b.missing.length || a.recipe.title.localeCompare(b.recipe.title));
}

// ---------- Online ----------
const cache = new Map(); // url -> { at, data }: an hour, to spare the free plans' daily limits
const HOUR = 3600000;

async function getJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < HOUR) return hit.data;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Nestly/1.0 (household app)' }, signal: AbortSignal.timeout(8000) });
  if (res.status === 402) throw Object.assign(new Error('The recipe search has used up today’s free searches. Try again tomorrow.'), { userFacing: true });
  if (!res.ok) throw Object.assign(new Error('The recipe search didn’t answer. Try again in a bit.'), { userFacing: true });
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}

const spoonKey = () => process.env.SPOONACULAR_KEY || '';
const SPOON = () => (process.env.SPOONACULAR_URL || 'https://api.spoonacular.com').replace(/\/$/, '');
const MEALDB = () => `${(process.env.MEALDB_URL || 'https://www.themealdb.com/api/json/v1').replace(/\/$/, '')}/${process.env.MEALDB_KEY || '1'}`;
const source = () => (spoonKey() ? 'spoonacular' : 'mealdb');

// Up to 12 recipes: { source, id, title, have: [...], missing: [...] }
async function searchOnline({ ingredients = [], craving = '' }) {
  const ings = ingredients.map((i) => String(i).trim()).filter(Boolean).slice(0, 12);
  const q = String(craving || '').trim().slice(0, 60);
  if (source() === 'spoonacular') {
    const p = new URLSearchParams({ apiKey: spoonKey(), number: '12', fillIngredients: 'true', sort: ings.length ? 'max-used-ingredients' : 'popularity', instructionsRequired: 'true' });
    if (q) p.set('query', q);
    if (ings.length) p.set('includeIngredients', ings.join(','));
    // Several ingredients must all be in a recipe for complexSearch to return it, so ask for
    // "any of these" by sorting on how many are used, and fall back to fewer when nothing comes back.
    let data = await getJson(`${SPOON()}/recipes/complexSearch?${p}`);
    if (!(data.results || []).length && ings.length > 1) {
      p.set('includeIngredients', ings.slice(0, 2).join(','));
      data = await getJson(`${SPOON()}/recipes/complexSearch?${p}`);
    }
    return (data.results || []).map((r) => ({
      source: 'spoonacular',
      id: String(r.id),
      title: r.title,
      have: (r.usedIngredients || []).map((i) => i.name),
      missing: (r.missedIngredients || []).map((i) => i.name),
      minutes: r.readyInMinutes || null,
    }));
  }
  // TheMealDB: a craving searches names; ingredients are looked up one at a time and merged.
  const found = new Map();
  if (q) {
    const data = await getJson(`${MEALDB()}/search.php?${new URLSearchParams({ s: q })}`);
    (data.meals || []).forEach((m) => found.set(m.idMeal, { source: 'mealdb', id: m.idMeal, title: m.strMeal, have: [], missing: [], minutes: null }));
  }
  for (const ing of ings.slice(0, 4)) {
    const data = await getJson(`${MEALDB()}/filter.php?${new URLSearchParams({ i: ing.replace(/\s+/g, '_') })}`);
    (data.meals || []).forEach((m) => {
      if (q && !found.has(m.idMeal)) return; // with a craving, ingredients only rank its results
      const hit = found.get(m.idMeal) || { source: 'mealdb', id: m.idMeal, title: m.strMeal, have: [], missing: [], minutes: null };
      hit.have.push(ing);
      found.set(m.idMeal, hit);
    });
  }
  return [...found.values()].sort((a, b) => b.have.length - a.have.length || a.title.localeCompare(b.title)).slice(0, 12);
}

// One online recipe, ready for the recipe form: { title, servings, time, ingredients, steps, link, photoUrl, notes }.
async function fetchOnline(src, id) {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  if (src === 'spoonacular' && spoonKey()) {
    const r = await getJson(`${SPOON()}/recipes/${id}/information?${new URLSearchParams({ apiKey: spoonKey(), includeNutrition: 'false' })}`);
    const steps = ((r.analyzedInstructions || [])[0] || {}).steps || [];
    return {
      title: String(r.title || '').slice(0, 120),
      servings: r.servings ? String(r.servings) : '',
      time: r.readyInMinutes ? `${r.readyInMinutes} min` : '',
      ingredients: (r.extendedIngredients || []).map((i) => parseIngredient(i.original || i.name)).filter(Boolean).slice(0, 80),
      steps: steps.length ? steps.map((s) => s.step).slice(0, 60) : String(r.instructions || '').replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 60),
      link: r.sourceUrl || r.spoonacularSourceUrl || '',
      photoUrl: r.image || '',
      notes: r.sourceName ? `From ${r.sourceName}, found with Spoonacular.` : 'Found with Spoonacular.',
    };
  }
  if (src === 'mealdb') {
    const m = ((await getJson(`${MEALDB()}/lookup.php?${new URLSearchParams({ i: String(id) })}`)).meals || [])[0];
    if (!m) return null;
    const ingredients = [];
    for (let n = 1; n <= 20; n += 1) {
      const name = String(m[`strIngredient${n}`] || '').trim();
      if (name) ingredients.push({ qty: String(m[`strMeasure${n}`] || '').trim().slice(0, 40), name: name.slice(0, 120) });
    }
    return {
      title: String(m.strMeal || '').slice(0, 120),
      servings: '',
      time: '',
      ingredients,
      steps: String(m.strInstructions || '').split(/\r?\n+/).map((s) => s.replace(/^\s*(step\s*)?\d+[.):]?\s*/i, '').trim()).filter((s) => s.length > 2).slice(0, 60),
      link: m.strSource || `https://www.themealdb.com/meal/${m.idMeal}`,
      photoUrl: m.strMealThumb || '',
      notes: 'Found with TheMealDB.',
    };
  }
  return null;
}


// Minutes in a recipe's time ("45 min", "1 hr 15 min", "1:30"); 0 when it doesn't say.
function minutesOf(time) {
  const t = String(time || '').toLowerCase();
  const hm = t.match(/(\d+)\s*:\s*(\d{2})/);
  if (hm) return +hm[1] * 60 + +hm[2];
  const h = t.match(/(\d+(?:\.\d+)?)\s*(h|hr|hour)/);
  const m = t.match(/(\d+)\s*(m|min)/);
  const total = (h ? Math.round(parseFloat(h[1]) * 60) : 0) + (m ? +m[1] : 0);
  return total || (/^\d+$/.test(t.trim()) ? +t.trim() : 0);
}

// Does a ranked recipe fit a mood? "Quick": 30 minutes or less. "Use it up": uses something about
// to expire. Anything else: in its name, category, tags or ingredients, or it uses something at
// home whose pantry tag the mood names ("Sweet" → the Sweet things).
function fitsMood(x, mood, { pantryTags = [], items = [] } = {}) {
  const m = String(mood).toLowerCase().trim();
  if (m === 'quick') { const n = minutesOf(x.recipe.time); return n > 0 && n <= 30; }
  if (m === 'use it up') return x.uses.length > 0;
  if (x.text.includes(m)) return true;
  const tags = tagsIn(mood, pantryTags);
  if (!tags.length) return false;
  const keys = items.filter((i) => tags.every((t) => (i.tags || []).includes(t))).map((i) => i.key);
  return x.keys.some((k) => keys.some((h) => covers(h, k)));
}

// Pantry tags a craving names: "something sweet and salty" → Sweet, Salty.
const tagsIn = (craving, tags) => { const words = String(craving).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3); return (tags || []).filter((t) => words.some((w) => t.toLowerCase() === w || t.toLowerCase().startsWith(w))); };

module.exports = { minutesOf, fitsMood, tagsIn, covers, rankRecipes, searchOnline, fetchOnline, source, atHome };
