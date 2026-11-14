// Sends a recipe's or a week's ingredients to the shopping list, after a review.
// Things already on the list, and things the household marked "usually have", start unticked.
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const Recipe = require('../models/Recipe');
const Meal = require('../models/Meal');
const ShoppingItem = require('../models/ShoppingItem');
const CatalogItem = require('../models/CatalogItem');
const PantryItem = require('../models/PantryItem');
const { visible } = require('../lib/changes');
const { logActivity } = require('../lib/activity');
const { keyOf, fromCatalog, addToCatalog } = require('../lib/catalog');
const { combine } = require('../lib/ingredients');
const { todayIn, addDays, isDate, weekday, shortDay } = require('../lib/dates');

const router = express.Router();
router.use('/s/shopping/ingredients', requireAuth, requireSection('shopping'));
const list = (v) => [].concat(v == null ? [] : v).map(String);

// What to shop for: one recipe, or the recipes planned for a week (from today on, for this week).
async function source(req) {
  const q = { ...req.query, ...req.body };
  if (q.recipe && mongoose.isValidObjectId(q.recipe) && req.household.features.recipes !== false) {
    const r = await Recipe.findOne({ _id: q.recipe, ...visible(req.user) }).lean();
    if (!r) return null;
    return { kind: 'recipe', title: r.title, back: `/s/recipes/${r._id}`, hidden: { recipe: String(r._id) }, recipes: [r], note: '' };
  }
  if (isDate(q.week) && req.household.features.meals !== false) {
    const today = todayIn(req.user.timezone);
    const start = addDays(q.week, -weekday(q.week));
    const end = addDays(start, 6);
    const from = today > start && today <= end ? today : start;
    const meals = await Meal.find({ ...visible(req.user), date: { $gte: from, $lte: end }, recipeId: { $ne: null } }).lean();
    const ids = [...new Set(meals.map((m) => String(m.recipeId)))];
    const recipes = ids.length ? await Recipe.find({ _id: { $in: ids }, ...visible(req.user) }).lean() : [];
    // A recipe planned twice counts twice.
    const planned = meals.map((m) => recipes.find((r) => String(r._id) === String(m.recipeId))).filter(Boolean);
    return {
      kind: 'week',
      title: `Meals, ${shortDay(from).replace(/, \d{4}$/, '')} – ${shortDay(end).replace(/, \d{4}$/, '')}`,
      back: `/s/meals?week=${start}`,
      hidden: { week: start },
      recipes: planned,
      note: from > start ? 'Starts from today, since earlier meals this week are past.' : '',
    };
  }
  return null;
}

async function review(req, src) {
  const rows = combine(src.recipes.flatMap((r) => r.ingredients.map((i) => ({ qty: i.qty, name: i.name, from: r.title }))));
  const keys = rows.map((r) => r.key);
  const [onList, usual, pantry] = await Promise.all([
    ShoppingItem.find({ ...visible(req.user), key: { $in: keys }, bought: false, clearedAt: null }, { key: 1 }).lean(),
    CatalogItem.find({ householdId: req.user.householdId, key: { $in: keys }, usuallyHave: true }, { key: 1 }).lean(),
    req.household.features.pantry !== false ? PantryItem.find({ householdId: req.user.householdId, key: { $in: keys }, status: 'have' }, { key: 1, amount: 1 }).lean() : [],
  ]);
  const listed = new Set(onList.map((x) => x.key));
  const have = new Set(usual.map((x) => x.key));
  const stocked = new Map(pantry.map((x) => [x.key, x]));
  return rows.map((r) => ({
    ...r,
    onList: listed.has(r.key),
    usuallyHave: have.has(r.key),
    inPantry: stocked.has(r.key),
    pantryAmount: stocked.has(r.key) ? stocked.get(r.key).amount : '',
    checked: !listed.has(r.key) && !have.has(r.key) && !stocked.has(r.key),
  }));
}

router.get('/s/shopping/ingredients', async (req, res, next) => {
  try {
    const src = await source(req);
    if (!src) return res.status(404).send('Not found');
    res.render('shopping/ingredients', { active: 'shopping', src, rows: await review(req, src) });
  } catch (err) {
    next(err);
  }
});

// Stops skipping one item that was marked "usually have", then shows the review again.
router.post('/s/shopping/ingredients/usual', async (req, res, next) => {
  try {
    const src = await source(req);
    if (!src) return res.status(404).send('Not found');
    const key = String(req.body.unmark || '');
    const item = await CatalogItem.findOneAndUpdate({ householdId: req.user.householdId, key, usuallyHave: true }, { $set: { usuallyHave: false } });
    if (item) {
      await logActivity(req.user, { section: 'Shopping', text: `${req.user.name} stopped marking ${item.name} as usually have` });
      req.session.flash = `${item.name} will start ticked from now on.`;
    }
    res.redirect(`/s/shopping/ingredients?${new URLSearchParams(src.hidden)}`);
  } catch (err) {
    next(err);
  }
});

router.post('/s/shopping/ingredients', async (req, res, next) => {
  try {
    const src = await source(req);
    if (!src) return res.status(404).send('Not found');
    const rows = await review(req, src); // rebuilt on the server: only what the plan really holds
    const ticked = new Set(list(req.body.add));
    const adding = rows.filter((r) => ticked.has(r.key) && !r.onList);
    const catalog = await CatalogItem.find({ householdId: req.user.householdId, key: { $in: adding.map((r) => r.key) } }).lean();
    const items = adding.map((r) => ({
      ...fromCatalog(req.user, r.name, catalog.find((c) => c.key === r.key), req.household),
      qty: r.qty || (catalog.find((c) => c.key === r.key) || {}).qty || '1',
      note: `For ${r.from.join(', ')}`.slice(0, 300),
    }));
    if (items.length) await ShoppingItem.insertMany(items);
    await addToCatalog(req.user, req.household, adding.map((r) => r.name));

    // "Remember what I skip": unticked items become "usually have"; ticked ones stop being.
    if (req.body.remember === 'on') {
      const skip = rows.filter((r) => !ticked.has(r.key) && !r.onList);
      const keep = rows.filter((r) => ticked.has(r.key));
      await addToCatalog(req.user, req.household, skip.map((r) => r.name));
      await Promise.all([
        skip.length && CatalogItem.updateMany({ householdId: req.user.householdId, key: { $in: skip.map((r) => keyOf(r.name)) } }, { $set: { usuallyHave: true } }),
        keep.length && CatalogItem.updateMany({ householdId: req.user.householdId, key: { $in: keep.map((r) => keyOf(r.name)) } }, { $set: { usuallyHave: false } }),
      ]);
    }
    if (items.length) {
      await logActivity(req.user, { section: 'Shopping', text: `${req.user.name} added ${items.length} ${items.length === 1 ? 'ingredient' : 'ingredients'} for ${src.kind === 'recipe' ? src.title : 'the meal plan'} to Shopping` });
    }
    req.session.flash = items.length ? `Added ${items.length} ${items.length === 1 ? 'item' : 'items'} to the shopping list.` : 'Nothing was added.';
    res.redirect('/s/shopping');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
