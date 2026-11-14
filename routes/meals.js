const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const Meal = require('../models/Meal');
const Recipe = require('../models/Recipe');
const { recordChange, visible } = require('../lib/changes');
const { logActivity } = require('../lib/activity');
const { todayIn, addDays, isDate, weekday, shortDay } = require('../lib/dates');
const { titled } = require('../lib/meals');

const router = express.Router();
router.use('/s/meals', requireAuth, requireSection('meals'));
const SECTION = 'Meals';

// Weeks run Sunday to Saturday, like the calendar.
const weekOf = (d) => addDays(d, -weekday(d));
const fmtDay = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${d}T00:00:00Z`));

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Meal.findOne({ _id: req.params.id, ...visible(req.user) });
}

const recipesOn = (req) => req.household.features.recipes !== false;

async function recipesFor(req) {
  if (!recipesOn(req)) return [];
  return Recipe.find(visible(req.user), { title: 1, category: 1 }).collation({ locale: 'en' }).sort({ title: 1 }).lean();
}

const slotsFor = (household, meals) => {
  const slots = [...household.mealSlots];
  if (meals.some((m) => !slots.includes(m.slot))) slots.push('Other');
  return slots;
};

router.get('/s/meals', async (req, res, next) => {
  try {
    const today = todayIn(req.user.timezone);
    const start = weekOf(isDate(req.query.week) ? req.query.week : today);
    const end = addDays(start, 6);
    const raw = await Meal.find({ ...visible(req.user), date: { $gte: start, $lte: end } }).sort({ createdAt: 1 }).lean();
    const ids = raw.filter((m) => m.recipeId).map((m) => m.recipeId);
    const recipes = ids.length ? await Recipe.find({ _id: { $in: ids }, ...visible(req.user) }, { title: 1 }).lean() : [];
    const meals = titled(raw, recipes);
    const slots = slotsFor(req.household, meals);
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(start, i);
      return {
        date,
        label: fmtDay(date),
        today: date === today,
        past: date < today,
        slots: slots.map((slot) => ({ slot, meals: meals.filter((m) => m.date === date && (m.slot === slot || (slot === 'Other' && !req.household.mealSlots.includes(m.slot)))) }))
          .filter((s) => s.slot !== 'Other' || s.meals.length),
      };
    });
    const lastWeekCount = await Meal.countDocuments({ ...visible(req.user), date: { $gte: addDays(start, -7), $lte: addDays(start, -1) } });
    res.render('meals/week', {
      active: 'meals',
      start,
      days,
      count: meals.length,
      withRecipes: meals.filter((m) => m.hasRecipe).length,
      title: start === weekOf(today) ? 'This week' : start === weekOf(addDays(today, 7)) ? 'Next week' : start === weekOf(addDays(today, -7)) ? 'Last week' : `Week of ${shortDay(start)}`,
      range: `${fmtDay(start)} – ${fmtDay(end)}`,
      prev: addDays(start, -7),
      next: addDays(start, 7),
      isThisWeek: start === weekOf(today),
      lastWeekCount,
      shoppingOn: req.household.features.shopping !== false,
    });
  } catch (err) {
    next(err);
  }
});

function readForm(req, recipes) {
  const b = req.body || {};
  const recipe = recipes.find((r) => String(r._id) === String(b.recipeId || ''));
  const slots = req.household.mealSlots;
  const values = {
    date: isDate(b.date) ? b.date : '',
    slot: slots.includes(b.slot) ? b.slot : slots[0] || 'Other',
    recipeId: recipe ? recipe._id : null,
    title: recipe ? recipe.title : String(b.title || '').trim().slice(0, 120),
    note: String(b.note || '').trim().slice(0, 300),
  };
  let error = null;
  if (!values.date) error = 'Choose a day.';
  else if (!values.title) error = recipes.length ? 'Pick a recipe or type what you’re having.' : 'Type what you’re having.';
  return { values, error };
}

const formView = (req, item, recipes, error) => ({ active: 'meals', item, recipes, error: error || null, recipesOn: recipesOn(req) });
const describe = (m) => `${m.title} for ${m.slot.toLowerCase()} on ${shortDay(m.date).replace(/, \d{4}$/, '')}`;

router.get('/s/meals/new', async (req, res, next) => {
  try {
    const recipes = await recipesFor(req);
    const today = todayIn(req.user.timezone);
    const picked = recipes.find((r) => String(r._id) === String(req.query.recipe || ''));
    const item = {
      _id: null,
      date: isDate(req.query.date) ? req.query.date : today,
      slot: req.household.mealSlots.includes(req.query.slot) ? req.query.slot : req.household.mealSlots[req.household.mealSlots.length - 1] || 'Other',
      recipeId: picked ? picked._id : null,
      title: '',
      note: '',
    };
    res.render('meals/form', formView(req, item, recipes));
  } catch (err) {
    next(err);
  }
});

router.post('/s/meals', async (req, res, next) => {
  try {
    const recipes = await recipesFor(req);
    const { values, error } = readForm(req, recipes);
    if (error) return res.status(422).render('meals/form', formView(req, { ...values, _id: null }, recipes, error));
    const item = await Meal.create({ ...values, householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name });
    await recordChange(req, { kind: 'create', model: 'Meal', doc: item, section: SECTION, text: `planned ${describe(item)}`, label: item.title });
    res.redirect(`/s/meals?week=${weekOf(item.date)}#d-${item.date}`);
  } catch (err) {
    next(err);
  }
});

// Copies last week's meals into this week, day for day. Meals already there aren't doubled.
router.post('/s/meals/copy-week', async (req, res, next) => {
  try {
    const start = weekOf(isDate(req.body.week) ? req.body.week : todayIn(req.user.timezone));
    const [from, already] = await Promise.all([
      Meal.find({ ...visible(req.user), date: { $gte: addDays(start, -7), $lte: addDays(start, -1) } }).lean(),
      Meal.find({ ...visible(req.user), date: { $gte: start, $lte: addDays(start, 6) } }).lean(),
    ]);
    const same = (a, b) => a.date === b.date && a.slot === b.slot && a.title === b.title && String(a.recipeId || '') === String(b.recipeId || '');
    const copies = from
      .map((m) => ({ householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name, private: m.private, date: addDays(m.date, 7), slot: m.slot, recipeId: m.recipeId, title: m.title, note: m.note }))
      .filter((c) => !already.some((a) => same(a, c)));
    if (copies.length) {
      await Meal.insertMany(copies);
      await logActivity(req.user, { section: SECTION, text: `${req.user.name} copied ${copies.length} ${copies.length === 1 ? 'meal' : 'meals'} from the week before into the week of ${shortDay(start)}` });
      req.session.flash = `Copied ${copies.length} ${copies.length === 1 ? 'meal' : 'meals'} from the week before.`;
    } else {
      req.session.flash = 'Nothing new to copy from the week before.';
    }
    res.redirect(`/s/meals?week=${start}`);
  } catch (err) {
    next(err);
  }
});

router.get('/s/meals/:id/edit', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    res.render('meals/form', formView(req, item.toObject(), await recipesFor(req)));
  } catch (err) {
    next(err);
  }
});

router.post('/s/meals/:id', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const recipes = await recipesFor(req);
    const { values, error } = readForm(req, recipes);
    if (error) return res.status(422).render('meals/form', formView(req, { ...item.toObject(), ...values }, recipes, error));
    const before = item.toObject();
    item.set(values);
    await item.save();
    await recordChange(req, { kind: 'update', model: 'Meal', doc: item, before, section: SECTION, text: `changed the plan to ${describe(item)}`, label: item.title });
    res.redirect(`/s/meals?week=${weekOf(item.date)}#d-${item.date}`);
  } catch (err) {
    next(err);
  }
});

router.post('/s/meals/:id/delete', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const before = item.toObject();
    await item.deleteOne();
    await recordChange(req, { kind: 'delete', model: 'Meal', doc: item, before, section: SECTION, text: `removed ${describe(item)}`, label: item.title });
    res.redirect(`/s/meals?week=${weekOf(item.date)}#d-${item.date}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
