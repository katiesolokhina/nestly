// Stores, aisles, tags, and categories. Admins change them from each section's settings page; every change is logged.
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { LISTS, categoryColor, reminderColor, PALETTE, HEX } = require('../lib/lists');
const { logActivity } = require('../lib/activity');
const CatalogItem = require('../models/CatalogItem');

const router = express.Router();
router.use('/settings/lists', requireAuth, requireAdmin);
const SECTION = 'Settings';

const available = (household) => Object.keys(LISTS).filter((k) => household.features[LISTS[k].feature] !== false);
const swap = (household, key, from, to) => Promise.all(LISTS[key].apply.map(([Model, field]) => Model.updateMany({ householdId: household._id, [field]: from }, { $set: { [field]: to } })));

// Lists live on each section's settings page now.
router.get('/settings/lists', (req, res) => res.redirect('/settings'));
const pageFor = (key) => `/settings/s/${LISTS[key].feature}#${key}`;

// Household settings that point at a list entry follow it when it's renamed or removed.
const LINKED = { stores: ['defaultStore', 'Any store'], pantrySpots: ['pantryDefaultSpot', ''], eventCats: ['eventCat', 'Uncategorized'], remCats: ['remCat', ''], mealSlots: ['mealSlot', ''] };
function follow(household, key, from, to) {
  const link = LINKED[key];
  if (link && household[link[0]] === from) household[link[0]] = to == null ? link[1] : to;
  if (key === 'infoTypes') {
    const tpl = (household.infoTemplates || []).find((t) => t.type === from);
    if (tpl) {
      if (to == null) household.infoTemplates = household.infoTemplates.filter((t) => t.type !== from);
      else tpl.type = to;
    }
  }
}

// "Usually have": things skipped when meal ingredients go to the shopping list.
router.post('/settings/lists/usually-have', async (req, res, next) => {
  try {
    const item = await CatalogItem.findOneAndUpdate({ householdId: req.user.householdId, key: String(req.body.key || ''), usuallyHave: true }, { $set: { usuallyHave: false } });
    if (item) await logActivity(req.user, { section: SECTION, text: `${req.user.name} stopped marking ${item.name} as usually have` });
    res.redirect('/settings/s/shopping#usual');
  } catch (err) {
    next(err);
  }
});

// Reminders aren't an event category, so their calendar color is set on its own.
router.post('/settings/lists/reminder-color', async (req, res, next) => {
  try {
    const color = String(req.body.color || '');
    if (!HEX.test(color)) { req.session.flash = 'Choose a color.'; return res.redirect('/settings/s/calendar#eventCats'); }
    req.household.reminderColor = color.toLowerCase();
    await req.household.save();
    await logActivity(req.user, { section: SECTION, text: `${req.user.name} changed the color for reminders` });
    res.redirect('/settings/s/calendar#eventCats');
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
    const fail = (msg) => { req.session.flash = msg; res.redirect(pageFor(key)); };

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
      return res.redirect(pageFor(key));
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
      follow(household, key, value, name);
      await logActivity(user, { section: SECTION, text: `${user.name} renamed ${value} to ${name}` });
    } else if (action === 'remove') {
      if (list.length === 1) return fail('Keep at least one.');
      list.splice(i, 1);
      if (key === 'eventCats') { const at = colors.findIndex((c) => c.name === value); if (at >= 0) colors.splice(at, 1); }
      await swap(household, key, value, cfg.fallback);
      follow(household, key, value, null);
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
    res.redirect(pageFor(key));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
