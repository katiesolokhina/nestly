// "What can I cook?": saved recipes ranked by what's in the pantry, and recipes found online.
// Mounted before Recipes, whose /s/recipes/:id would catch /s/recipes/cook.
const express = require('express');
const { requireAuth, requireSection } = require('../middleware/auth');
const Recipe = require('../models/Recipe');
const { visible } = require('../lib/changes');
const { keyOf } = require('../lib/catalog');
const { rankRecipes, searchOnline, fetchOnline, source, atHome, tagsIn } = require('../lib/cook');

const router = express.Router();
router.use('/s/recipes/cook', requireAuth, requireSection('recipes'));
const list = (v) => [].concat(v == null ? [] : v).map(String);

router.get('/s/recipes/cook', async (req, res, next) => {
  try {
    const q = req.query;
    const craving = String(q.craving || '').trim().slice(0, 60);
    const also = String(q.also || '').split(',').map((s) => s.trim().slice(0, 40)).filter(Boolean).slice(0, 10);
    const { items, usual } = await atHome(req);
    // Until the form is used, everything at home counts.
    const picked = q.go ? new Set(list(q.use)) : new Set(items.map((i) => i.key));
    const using = items.filter((i) => picked.has(i.key));
    const have = [...using.map((i) => i.key), ...also.map(keyOf)];
    const expiring = using.filter((i) => i.soon).map((i) => ({ key: i.key, name: i.name, text: i.expText }));
    const recipes = await Recipe.find(visible(req.user), { title: 1, category: 1, tags: 1, ingredients: 1, time: 1, servings: 1 }).lean();
    // A craving that names pantry tags: what's at home with those tags, and recipes that use it.
    const cravedTags = tagsIn(craving, req.household.pantryTags);
    const tagged = cravedTags.length ? items.filter((i) => cravedTags.every((t) => i.tags.includes(t))) : [];
    const mine = rankRecipes(recipes, { have, usual, expiring, craving, cravedKeys: tagged.map((i) => i.key) }).slice(0, 20);

    let online = null;
    let onlineError = null;
    if (q.online === '1') {
      try {
        // Expiring things first, so they're the ones searched for when only a few fit.
        const names = [...using.filter((i) => i.soon), ...using.filter((i) => !i.soon)].map((i) => i.name);
        online = await searchOnline({ ingredients: [...names, ...also], craving });
      } catch (err) {
        if (!err.userFacing) console.error('Recipe search failed:', err.message);
        onlineError = err.userFacing ? err.message : 'The recipe search didn’t answer. Try again in a bit.';
      }
    }
    const query = new URLSearchParams([['go', '1'], ...(craving ? [['craving', craving]] : []), ...(also.length ? [['also', also.join(', ')]] : []), ...[...picked].map((k) => ['use', k])]).toString();
    res.render('recipes/cook', {
      active: 'recipes', cravedTags, tagged, craving, also: also.join(', '), items, picked, mine, online, onlineError, query,
      source: source(), mealsOn: req.perms.can('meals', 'add'), canAdd: req.perms.can('recipes', 'add'),
    });
  } catch (err) {
    next(err);
  }
});

// An online recipe, onto the recipe form to check before saving (with its photo).
router.post('/s/recipes/cook/save', async (req, res, next) => {
  try {
    if (req.perms.level('recipes') !== 'edit') return res.status(404).send('Not found');
    const b = req.body || {};
    let found = null;
    try {
      found = await fetchOnline(String(b.source || ''), String(b.id || ''));
    } catch (err) {
      req.session.flash = err.userFacing ? err.message : 'That recipe couldn’t be loaded. Try again in a bit.';
      return res.redirect(`/s/recipes/cook?${String(b.query || '').replace(/[^\w%+=&.\-]/g, '')}`);
    }
    if (!found || !found.title) return res.status(404).send('Not found');
    await require('./recipes').reviewImported(req, res, found);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
