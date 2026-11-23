// "What can I cook?": saved recipes ranked by what's in the pantry, and recipes found online.
// Mounted before Recipes, whose /s/recipes/:id would catch /s/recipes/cook.
const express = require('express');
const { requireAuth, requireSection } = require('../middleware/auth');
const Recipe = require('../models/Recipe');
const { visible } = require('../lib/changes');
const { keyOf } = require('../lib/catalog');
const { rankRecipes, searchOnline, fetchOnline, source, atHome, tagsIn, fitsMood } = require('../lib/cook');

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
    // Moods (Quick, Use it up, Sweet…): every picked one must fit. Then how much is missing.
    const allMoods = req.household.recipeMoods || [];
    const moods = [...new Set(list(q.mood))].filter((m) => allMoods.includes(m));
    const show = ['have', 'close', 'all'].includes(q.show) ? q.show : 'close';
    const tab = [].concat(q.tab || []).pop() === 'online' || q.online === '1' ? 'online' : 'mine'; // the tab button pressed wins over the remembered one
    const ranked = rankRecipes(recipes, { have, usual, expiring, craving, cravedKeys: tagged.map((i) => i.key) })
      .filter((x) => moods.every((m) => fitsMood(x, m, { pantryTags: req.household.pantryTags, items })));
    const counts = { have: ranked.filter((x) => !x.missing.length).length, close: ranked.filter((x) => x.missing.length <= 2).length, all: ranked.length };
    const mine = ranked.filter((x) => (show === 'have' ? !x.missing.length : show === 'close' ? x.missing.length <= 2 : true))
      .sort((a, b) => b.uses.length - a.uses.length || a.missing.length - b.missing.length || a.recipe.title.localeCompare(b.recipe.title))
      .slice(0, 30);

    let online = null;
    let onlineError = null;
    if (tab === 'online') {
      try {
        // Expiring things first, so they're the ones searched for when only a few fit.
        const names = [...using.filter((i) => i.soon), ...using.filter((i) => !i.soon)].map((i) => i.name);
        online = await searchOnline({ ingredients: [...names, ...also], craving: [craving, ...moods.filter((m) => !['quick', 'use it up'].includes(m.toLowerCase()))].filter(Boolean).join(' ') });
      } catch (err) {
        if (!err.userFacing) console.error('Recipe search failed:', err.message);
        onlineError = err.userFacing ? err.message : 'The recipe search didn’t answer. Try again in a bit.';
      }
    }
    const query = new URLSearchParams([['go', '1'], ...(craving ? [['craving', craving]] : []), ...moods.map((m) => ['mood', m]), ['show', show], ['tab', tab], ...(also.length ? [['also', also.join(', ')]] : []), ...[...picked].map((k) => ['use', k])]).toString();
    res.render('recipes/cook', {
      active: 'recipes', cravedTags, tagged, craving, allMoods, moods, show, tab, counts,
      spots: [...new Set([...req.household.pantrySpots, ...items.map((i) => i.spot)])].map((sp) => ({ name: sp, items: items.filter((i) => i.spot === sp) })).filter((g) => g.items.length), also: also.join(', '), items, picked, mine, online, onlineError, query,
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
