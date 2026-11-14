// Stores, aisles, tags, and categories. Anyone in the household can change them, and every change is logged.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { LISTS, categoryColor, reminderColor, PALETTE, HEX } = require('../lib/lists');
const { logActivity } = require('../lib/activity');

const router = express.Router();
router.use('/settings/lists', requireAuth);
const SECTION = 'Settings';

const available = (household) => Object.keys(LISTS).filter((k) => household.features[LISTS[k].feature] !== false);
const swap = (household, key, from, to) => Promise.all(LISTS[key].apply.map(([Model, field]) => Model.updateMany({ householdId: household._id, [field]: from }, { $set: { [field]: to } })));

router.get('/settings/lists', (req, res) => {
  res.render('lists', { active: 'settings', lists: available(req.household).map((key) => ({ key, ...LISTS[key], values: req.household[key] })), colorOf: (name) => categoryColor(req.household, name), reminderColor: reminderColor(req.household), showReminders: req.household.features.remember !== false, error: null });
});

// Reminders aren't an event category, so their calendar color is set on its own.
router.post('/settings/lists/reminder-color', async (req, res, next) => {
  try {
    const color = String(req.body.color || '');
    if (!HEX.test(color)) { req.session.flash = 'Choose a color.'; return res.redirect('/settings/lists#eventCats'); }
    req.household.reminderColor = color.toLowerCase();
    await req.household.save();
    await logActivity(req.user, { section: SECTION, text: `${req.user.name} changed the color for reminders` });
    res.redirect('/settings/lists#eventCats');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/lists/:key', async (req, res, next) => {
  try {
    const { household, user } = req;
    const { key } = req.params;
    if (!available(household).includes(key)) return res.status(404).send('Not found');
    const list = [...household[key]];
    const cfg = LISTS[key];
    const label = cfg.title.toLowerCase();
    const { action, value } = req.body;
    const name = String(req.body.name || '').trim().slice(0, 40);
    const i = list.indexOf(value);
    const fail = (msg) => { req.session.flash = msg; res.redirect(`/settings/lists#${key}`); };

    // Colors are stored by name, so they follow renames and go away with removals.
    const colors = (household.eventColors || []).map((c) => ({ name: c.name, color: c.color }));
    const setColor = (n, color) => { const c = colors.find((x) => x.name === n); if (c) c.color = color; else colors.push({ name: n, color }); };

    if (action === 'color') {
      if (key !== 'eventCats' || i < 0) return res.status(404).send('Not found');
      const color = String(req.body.color || '');
      if (!HEX.test(color)) return fail('Choose a color.');
      setColor(value, color.toLowerCase());
      household.eventColors = colors;
      await household.save();
      await logActivity(user, { section: SECTION, text: `${user.name} changed the color for ${value}` });
      return res.redirect(`/settings/lists#${key}`);
    }

    if (action === 'add') {
      if (!name) return fail('Enter a name.');
      if (list.some((v) => v.toLowerCase() === name.toLowerCase())) return fail(`${name} is already in ${label}.`);
      list.push(name);
      if (key === 'eventCats') setColor(name, PALETTE[(list.length - 1) % PALETTE.length]);
      await logActivity(user, { section: SECTION, text: `${user.name} added ${name} to ${label}` });
    } else if (i < 0) {
      return fail('That is no longer in the list.');
    } else if (action === 'rename') {
      if (!name) return fail('Enter a name.');
      if (name !== value && list.some((v) => v.toLowerCase() === name.toLowerCase())) return fail(`${name} is already in ${label}.`);
      list[i] = name;
      if (key === 'eventCats') {
        const kept = categoryColor(household, value);
        const at = colors.findIndex((c) => c.name === value);
        if (at >= 0) colors.splice(at, 1);
        setColor(name, kept);
      }
      await swap(household, key, value, name);
      await logActivity(user, { section: SECTION, text: `${user.name} renamed ${value} to ${name}` });
    } else if (action === 'remove') {
      if (list.length === 1) return fail('Keep at least one.');
      list.splice(i, 1);
      if (key === 'eventCats') { const at = colors.findIndex((c) => c.name === value); if (at >= 0) colors.splice(at, 1); }
      await swap(household, key, value, cfg.fallback);
      await logActivity(user, { section: SECTION, text: `${user.name} removed ${value} from ${label}` });
    } else if (action === 'up' || action === 'down') {
      const j = action === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
    }
    // Pin today's colors before the list changes, so reordering never shifts anyone's colors.
    if (key === 'eventCats') {
      household[key].forEach((n) => { if (!colors.some((c) => c.name === n)) colors.push({ name: n, color: categoryColor(household, n) }); });
      household.eventColors = colors.filter((c) => list.includes(c.name));
    }
    household[key] = list;
    await household.save();
    res.redirect(`/settings/lists#${key}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
