// Stores, aisles, tags, and categories. Admins change them from each section's settings page; every change is logged.
const express = require('express');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { LISTS, categoryColor, reminderColor, PALETTE, HEX } = require('../lib/lists');
const { logActivity } = require('../lib/activity');
const CatalogItem = require('../models/CatalogItem');
const { keyOf, addToCatalog } = require('../lib/catalog');

const router = express.Router();
router.use('/settings/lists', requireAuth, requirePerm('settings'));
const SECTION = 'Settings';

const available = (household) => Object.keys(LISTS).filter((k) => household.features[LISTS[k].feature] !== false);
const swap = (household, key, from, to) => Promise.all(LISTS[key].apply.map(([Model, field]) => {
  const filter = { householdId: household._id, [field]: from };
  if (!LISTS[key].array) return Model.updateMany(filter, { $set: { [field]: to } });
  // A list field: rename it where it appears, or take it out.
  return to == null ? Model.updateMany(filter, { $pull: { [field]: from } }) : Model.updateMany(filter, { $set: { [`${field}.$`]: to } });
}));

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
    if (req.perms.level('shopping') !== 'edit') return res.status(404).send('Not found');
    const item = await CatalogItem.findOneAndUpdate({ householdId: req.user.householdId, key: String(req.body.key || ''), usuallyHave: true }, { $set: { usuallyHave: false } });
    if (item) await logActivity(req.user, { section: SECTION, text: `${req.user.name} stopped marking ${item.name} as usually have` });
    res.redirect('/settings/s/shopping#usual');
  } catch (err) {
    next(err);
  }
});

// Settings → Pantry: saved items that go straight into the pantry when bought.
router.post('/settings/lists/auto-pantry', async (req, res, next) => {
  try {
    if (req.perms.level('pantry') !== 'edit') return res.status(404).send('Not found');
    const b = req.body || {};
    if (b.action === 'add') {
      const name = String(b.name || '').trim().slice(0, 80);
      if (name) {
        await addToCatalog(req.user, req.household, [name]);
        const item = await CatalogItem.findOneAndUpdate({ householdId: req.user.householdId, key: keyOf(name) }, { $set: { autoPantry: true } }, { returnDocument: 'after' });
        if (item) await logActivity(req.user, { section: 'Pantry', text: `${req.user.name} set ${item.name} to go straight into the pantry when bought` });
      }
    } else {
      const item = await CatalogItem.findOneAndUpdate({ householdId: req.user.householdId, key: String(b.key || ''), autoPantry: true }, { $set: { autoPantry: false } });
      if (item) await logActivity(req.user, { section: 'Pantry', text: `${req.user.name} set ${item.name} to wait in Put away again` });
    }
    res.redirect('/settings/s/pantry#auto');
  } catch (err) {
    next(err);
  }
});

// Reminders aren't an event category, so their calendar color is set on its own.
router.post('/settings/lists/reminder-color', async (req, res, next) => {
  try {
    if (req.perms.level('calendar') !== 'edit') return res.status(404).send('Not found');
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

// Splits "Bakery, Deli" or a pasted list (one per line) into entries.
const splitNames = (v) => String(v || '').split(/[,\n\r;]+/).map((n) => n.trim().slice(0, 40)).filter(Boolean);

router.post('/settings/lists/:key', async (req, res, next) => {
  try {
    const { household, user } = req;
    const { key } = req.params;
    // Settings permission covers the sections this person can edit.
    if (!available(household).includes(key) || req.perms.level(LISTS[key].feature) !== 'edit') return res.status(404).send('Not found');
    const list = [...household[key]];
    const cfg = LISTS[key];
    const label = cfg.title.toLowerCase();
    const b = req.body || {};
    const { action, value } = b;
    const name = String(b.name || '').trim().slice(0, 40);
    const i = list.indexOf(value);
    const quick = req.get('X-Requested-With') === 'fetch';
    const fail = (msg, back = pageFor(key)) => { if (quick) return res.status(422).json({ error: msg }); req.session.flash = msg; return res.redirect(back); };
    const same = (x, y) => x.toLowerCase() === y.toLowerCase();

    // Colors are stored by name, so they follow renames and go away with removals.
    const colors = (household.eventColors || []).map((c) => ({ name: c.name, color: c.color }));
    const setColor = (n, color) => { const c = colors.find((x) => x.name === n); if (c) c.color = color; else colors.push({ name: n, color }); };
    const dropColor = (n) => { const at = colors.findIndex((c) => c.name === n); if (at >= 0) colors.splice(at, 1); };
    // Renames and removals reach every item that uses the entry.
    const rename = async (from, to) => {
      if (key === 'eventCats') { const kept = (colors.find((c) => c.name === from) || {}).color || categoryColor(household, from); dropColor(from); setColor(to, kept); }
      await swap(household, key, from, to);
      follow(household, key, from, to);
    };
    const remove = async (v) => {
      if (key === 'eventCats') dropColor(v);
      await swap(household, key, v, cfg.fallback);
      follow(household, key, v, null);
    };

    if (action === 'color') {
      if (key !== 'eventCats' || i < 0) return res.status(404).send('Not found');
      const color = String(b.color || '');
      if (!HEX.test(color)) return fail('Choose a color.');
      setColor(value, color.toLowerCase());
      household.eventColors = colors;
      await household.save();
      await logActivity(user, { section: SECTION, text: `${user.name} changed the color for ${value}` });
      return res.redirect(pageFor(key));
    }

    let done = '';
    if (action === 'add') {
      // One or many: "Bakery, Deli, Snacks", or one per line. Ones already there are skipped.
      const names = [];
      splitNames(b.name).forEach((n) => { if (!list.some((v) => same(v, n)) && !names.some((v) => same(v, n))) names.push(n); });
      if (!names.length) return fail(splitNames(b.name).length ? `${splitNames(b.name).join(', ')} ${splitNames(b.name).length === 1 ? 'is' : 'are'} already in ${label}.` : 'Enter a name.');
      if (list.length + names.length > 100) return fail(`That’s more than 100 ${label}.`);
      names.forEach((n) => { list.push(n); if (key === 'eventCats') setColor(n, PALETTE[(list.length - 1) % PALETTE.length]); });
      const skipped = splitNames(b.name).length - names.length;
      done = `Added ${names.join(', ')}.${skipped ? ` Skipped ${skipped} already there.` : ''}`;
      await logActivity(user, { section: SECTION, text: `${user.name} added ${names.join(', ')} to ${label}` });
    } else if (action === 'order') {
      // Drag to rearrange: the whole list in its new order.
      const order = [].concat(b.value || []).map(String);
      if (order.length !== list.length || !list.every((v) => order.includes(v))) return fail('The list changed. Reload and try again.');
      list.splice(0, list.length, ...order);
    } else if (action === 'sort') {
      list.sort((x, y) => x.localeCompare(y, 'en', { sensitivity: 'base', numeric: true }));
      done = `Sorted ${label} A–Z.`;
      await logActivity(user, { section: SECTION, text: `${user.name} sorted ${label} A–Z` });
    } else if (action === 'edit') {
      // Edit mode: every entry's name, which to remove, and (categories) colors, saved at once.
      const back = `${pageFor(key).replace('#', `?edit=${key}#`)}`;
      const orig = [].concat(b.orig || []).map(String);
      const names = [].concat(b.names || []).map((n) => String(n).trim().slice(0, 40));
      const gone = new Set([].concat(b.remove || []).map(String));
      const cols = [].concat(b.colors || []).map(String);
      if (orig.length !== list.length || !list.every((v) => orig.includes(v))) return fail('The list changed. Reload and try again.', back);
      const rows = orig.map((o, n) => ({ from: o, to: names[n] || '', drop: gone.has(o), color: cols[n] }));
      const kept = rows.filter((r) => !r.drop);
      if (!kept.length) return fail('Keep at least one.', back);
      if (kept.some((r) => !r.to)) return fail('Every name needs something in it (or tick Remove).', back);
      const dup = kept.find((r, n) => kept.some((x, m) => m < n && same(x.to, r.to)));
      if (dup) return fail(`${dup.to} is in the list twice.`, back);
      const changes = [];
      for (const r of rows.filter((x) => x.drop)) { await remove(r.from); changes.push(`removed ${r.from}`); }
      // Renames go through placeholders first, so swapping two names doesn't merge them.
      const moving = kept.filter((r) => r.to !== r.from);
      for (const [n, r] of moving.entries()) await rename(r.from, `\u0000${n}`);
      for (const [n, r] of moving.entries()) { await rename(`\u0000${n}`, r.to); changes.push(`renamed ${r.from} to ${r.to}`); }
      if (key === 'eventCats') kept.forEach((r) => { if (HEX.test(r.color || '') && r.color.toLowerCase() !== categoryColor(household, r.from).toLowerCase()) { setColor(r.to, r.color.toLowerCase()); changes.push(`changed the color for ${r.to}`); } });
      list.splice(0, list.length, ...kept.map((r) => r.to));
      done = changes.length ? `Saved ${label}.` : 'Nothing changed.';
      if (changes.length) await logActivity(user, { section: SECTION, text: `${user.name} ${changes.join(', ')} in ${label}` });
    } else if (i < 0) {
      return fail('That is no longer in the list.');
    } else if (action === 'rename') {
      if (!name) return fail('Enter a name.');
      if (name !== value && list.some((v) => same(v, name))) return fail(`${name} is already in ${label}.`);
      list[i] = name;
      await rename(value, name);
      await logActivity(user, { section: SECTION, text: `${user.name} renamed ${value} to ${name}` });
    } else if (action === 'remove') {
      if (list.length === 1) return fail('Keep at least one.');
      list.splice(i, 1);
      await remove(value);
      await logActivity(user, { section: SECTION, text: `${user.name} removed ${value} from ${label}` });
    } else if (action === 'up' || action === 'down') {
      const j = action === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
    }
    // Pin today's colors before the list changes, so reordering never shifts anyone's colors.
    if (key === 'eventCats') {
      household[key].forEach((n) => { if (!colors.some((c) => c.name === n) && !n.startsWith('\u0000')) colors.push({ name: n, color: categoryColor(household, n) }); });
      household.eventColors = colors.filter((c) => list.includes(c.name));
    }
    household[key] = list;
    await household.save();
    if (quick) return res.status(204).end();
    if (done) req.session.flash = done;
    res.redirect(pageFor(key));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
