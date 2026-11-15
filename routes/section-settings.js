// Each section's settings page: its lists and its defaults. Admins only.
const express = require('express');
const { requireAuth, requirePerm } = require('../middleware/auth');
const CatalogItem = require('../models/CatalogItem');
const { LISTS, categoryColor, reminderColor } = require('../lib/lists');
const { logActivity } = require('../lib/activity');
const { sectionName, pantryNames } = require('../lib/prefs');
const { KINDS, TEMPLATES } = require('../lib/info');
const alerts = require('../lib/alerts');
const { rolesOf } = require('../lib/perms');

const router = express.Router();
router.use('/settings/s', requireAuth, requirePerm('settings'));
const KEYS = ['shopping', 'remember', 'calendar', 'meals', 'recipes', 'pantry', 'bills', 'chores', 'info'];
const listsFor = (key) => Object.keys(LISTS).filter((k) => LISTS[k].feature === key);
const pick = (v, options, fallback) => (options.map(String).includes(String(v)) ? v : fallback);

// What a new item of each Home info type starts with: the household's own, else the built-in one.
const templateOf = (household, type) => {
  const own = (household.infoTemplates || []).find((t) => t.type === type);
  if (own) return own.fields.map((f) => ({ label: f.label, kind: f.kind }));
  return (TEMPLATES[type] || []).map(([label, kind]) => ({ label, kind }));
};

// Chore rewards: add one, or remove one. Requests already made keep their name and cost.
router.post('/settings/s/chores/rewards', async (req, res, next) => {
  try {
    if (req.perms.level('chores') !== 'edit') return res.status(404).send('Not found');
    const h = req.household;
    const name = String((req.body || {}).name || '').trim().slice(0, 60);
    const cost = parseInt((req.body || {}).cost, 10);
    if (name && cost >= 1 && cost <= 100000 && (h.rewards || []).length < 50) {
      h.rewards.push({ name, cost });
      await h.save();
      await logActivity(req.user, { section: 'Settings', text: `${req.user.name} added the reward ${name} (${cost} points)` });
    }
    res.redirect('/settings/s/chores#rewards');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/s/chores/rewards/:rid/delete', async (req, res, next) => {
  try {
    if (req.perms.level('chores') !== 'edit') return res.status(404).send('Not found');
    const h = req.household;
    const r = (h.rewards || []).find((x) => String(x._id) === req.params.rid);
    if (r) {
      h.rewards.pull(r._id);
      await h.save();
      await logActivity(req.user, { section: 'Settings', text: `${req.user.name} removed the reward ${r.name}` });
    }
    res.redirect('/settings/s/chores#rewards');
  } catch (err) {
    next(err);
  }
});

router.get('/settings/s/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    if (!KEYS.includes(key) || req.perms.level(key) !== 'edit') return res.status(404).send('Not found');
    const h = req.household;
    const usual = key === 'shopping'
      ? await CatalogItem.find({ householdId: req.user.householdId, usuallyHave: true }, { name: 1, key: 1 }).collation({ locale: 'en' }).sort({ name: 1 }).lean()
      : null;
    res.render('settings/section', {
      active: 'settings',
      key,
      title: sectionName(h, key),
      back: req.query.from === 'section' ? `/s/${key}` : '/settings',
      notice: req.query.saved ? 'Saved.' : null,
      lists: listsFor(key).map((k) => ({ key: k, ...LISTS[k], values: h[k] })),
      colorOf: (name) => categoryColor(h, name),
      reminderColor: reminderColor(h),
      showReminders: h.features.remember !== false,
      usual,
      names: pantryNames(h),
      alertChoices: alerts.choices(),
      templates: key === 'info' ? h.infoTypes.map((t) => ({ type: t, fields: templateOf(h, t) })) : [],
      KINDS,
      roleChoices: [{ key: 'admin', name: 'Admin' }, ...rolesOf(h).map((r) => ({ key: r.key, name: r.name }))],
    });
  } catch (err) {
    next(err);
  }
});

// Saves the defaults on a section's page (lists save on their own).
router.post('/settings/s/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const h = req.household;
    const b = req.body || {};
    if (!KEYS.includes(key) || req.perms.level(key) !== 'edit') return res.status(404).send('Not found');
    if (key === 'shopping') {
      h.defaultStore = pick(b.defaultStore, ['Any store', ...h.stores], 'Any store');
      h.tripAlerts = b.tripAlerts === 'on';
      h.tripGapMin = Number(pick(b.tripGapMin, [15, 30, 60, 120], h.tripGapMin));
    } else if (key === 'remember') {
      h.remNotify = pick(b.remNotify, ['all', 'me', 'none'], 'all');
      h.remCat = pick(b.remCat, ['', ...h.remCats], '');
    } else if (key === 'calendar' || key === 'meals') {
      h.weekStart = Number(pick(b.weekStart, [0, 1], h.weekStart));
      if (key === 'calendar') {
        h.eventAlert = pick(b.eventAlert, ['none', '0', '5', '10', '15', '30', '60', '120', '180', '1440', '2880', '10080'], '60');
        h.eventAlertAllDay = pick(b.eventAlertAllDay, ['none', '0', '1440', '2880', '10080'], '0');
        h.eventCat = pick(b.eventCat, ['Uncategorized', ...h.eventCats], 'Uncategorized');
      } else {
        h.mealSlot = pick(b.mealSlot, ['', ...h.mealSlots], '');
      }
    } else if (key === 'pantry') {
      const name = (v, d) => String(v || '').trim().slice(0, 16) || d;
      h.pantryNames = { have: name(b.nameHave, 'Have'), low: name(b.nameLow, 'Low'), out: name(b.nameOut, 'Out') };
      h.pantryShop = pick(b.pantryShop, ['both', 'out', 'never'], 'both');
      h.pantrySoonDays = Number(pick(b.pantrySoonDays, [1, 2, 3, 5, 7, 14], 3));
      h.pantryDefaultSpot = pick(b.pantryDefaultSpot, ['', ...h.pantrySpots], '');
    } else if (key === 'bills') {
      h.billSplit = pick(b.billSplit, ['even', 'none'], 'even');
      h.currency = String(b.currency || '').trim().slice(0, 4) || '$';
      h.billAheadDays = Number(pick(b.billAheadDays, [7, 14, 31, 60], 31));
    } else if (key === 'chores') {
      h.chorePoints = b.chorePoints === 'on';
      const keys = ['admin', ...rolesOf(h).map((r) => r.key)];
      h.choreEarners = [...new Set([].concat(b.choreEarners || []).map(String))].filter((k) => keys.includes(k));
    } else if (key === 'info') {
      // One type's starting fields.
      const type = String(b.type || '');
      if (!h.infoTypes.includes(type)) return res.redirect('/settings/s/info');
      const labels = [].concat(b.fLabel || []).map(String);
      const kinds = [].concat(b.fKind || []).map(String);
      const fields = labels.map((l, i) => ({ label: l.trim().slice(0, 40), kind: Object.keys(KINDS).includes(kinds[i]) ? kinds[i] : 'text' })).filter((f) => f.label).slice(0, 20);
      h.infoTemplates = [...(h.infoTemplates || []).filter((t) => t.type !== type), { type, fields }];
    }
    await h.save();
    await logActivity(req.user, { section: 'Settings', text: `${req.user.name} changed ${sectionName(h, key)} settings` });
    res.redirect(`/settings/s/${key}?saved=1${req.query.from === 'section' ? '&from=section' : ''}${key === 'info' ? `#tpl-${encodeURIComponent(String(b.type || ''))}` : ''}`);
  } catch (err) {
    next(err);
  }
});

module.exports = { router, templateOf };
