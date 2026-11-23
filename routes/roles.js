// Roles and permissions. Admin can do everything; admins set what every other role can do.
const express = require('express');
const crypto = require('node:crypto');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Membership = require('../models/Membership');
const { SECTIONS } = require('../lib/sections');
const { sectionName } = require('../lib/prefs');
const { EXTRA, PAGES, rolesOf, roleOf } = require('../lib/perms');
const { KINDS, PARTS, fullCustom, viewCustom, fillCustom, readCustom, levelFor } = require('../lib/actions');
const { WIDGETS } = require('../lib/today');
const { logActivity } = require('../lib/activity');

const router = express.Router();
router.use('/settings/roles', requireAuth, requireAdmin);

// View as role: act as that role here until Exit (admins only; anything changed meanwhile is real).
router.post('/view-as', requireAuth, (req, res) => {
  const role = String((req.body || {}).role || '');
  if (req.member.role !== 'admin' || req.viewing || !roleOf(req.household, role)) return res.status(404).send('Not found');
  req.session.viewAs = { householdId: String(req.household._id), role };
  req.session.flash = `You’re seeing Nestly as ${roleOf(req.household, role).name}. Changes you make are real. Tap Exit at the top to go back.`;
  res.redirect('/');
});
router.post('/view-as/exit', requireAuth, (req, res) => {
  delete req.session.viewAs;
  req.session.flash = 'Back to Admin.';
  res.redirect('/settings/roles');
});

const roleList = (h) => rolesOf(h).map((r) => (typeof r.toObject === 'function' ? r.toObject() : { ...r, sections: { ...r.sections } }));

router.get('/settings/roles', async (req, res, next) => {
  try {
    const counts = await Membership.aggregate([{ $match: { householdId: req.household._id } }, { $group: { _id: '$role', n: { $sum: 1 } } }]);
    const n = (key) => (counts.find((c) => c._id === key) || {}).n || 0;
    res.render('settings/roles', {
      active: 'settings',
      notice: req.session.flash || null,
      admins: n('admin'),
      roles: roleList(req.household).map((r) => {
        const sees = SECTIONS.filter((s) => req.household.features[s.key] !== false);
        const edit = sees.filter((s) => (r.sections[s.key] || 'edit') === 'edit').map((s) => sectionName(req.household, s.key));
        const view = sees.filter((s) => r.sections[s.key] === 'view').map((s) => sectionName(req.household, s.key));
        const some = sees.filter((s) => r.sections[s.key] === 'custom').map((s) => sectionName(req.household, s.key));
        return { ...r, people: n(r.key), summary: [edit.length ? `Edits ${edit.length === sees.length ? 'everything' : edit.join(', ')}` : '', some.length ? `some of ${some.join(', ')}` : '', view.length ? `views ${view.join(', ')}` : ''].filter(Boolean).join('; ') || 'Sees nothing' };
      }),
    });
    delete req.session.flash;
  } catch (err) {
    next(err);
  }
});

// New role: starts as a copy of the first role, so it's usable right away.
router.post('/settings/roles', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 24);
    const roles = roleList(req.household);
    if (!name) { req.session.flash = 'Give the role a name.'; return res.redirect('/settings/roles'); }
    if (name.toLowerCase() === 'admin' || roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) { req.session.flash = `There’s already a role called ${name}.`; return res.redirect('/settings/roles'); }
    if (roles.length >= 12) { req.session.flash = 'Up to 12 roles.'; return res.redirect('/settings/roles'); }
    const base = roles[0] || { sections: {}, invite: false, settings: false, activity: true, private: true };
    const key = `r${crypto.randomBytes(4).toString('hex')}`;
    req.household.roles = [...roles, { ...base, key, name, sections: { ...base.sections } }];
    await req.household.save();
    await logActivity(req.user, { section: 'Settings', text: `${req.user.name} added the role ${name}` });
    res.redirect(`/settings/roles/${key}`);
  } catch (err) {
    next(err);
  }
});

// What one part's choice counts as, for the short line under each section.
const tally = (kind, v) => (['no', 'hidden'].includes(v) || (kind === 'scope' && v === 'none') || v === false ? 'off' : v === 'view' || (kind === 'main' && v === 'none') ? 'view' : 'on');
const summaryOf = (parts) => {
  const n = { on: 0, view: 0, off: 0 };
  parts.forEach((p) => { n[tally(p.kind, p.value)]++; });
  return [n.on && `${n.on} allowed`, n.view && `${n.view} view only`, n.off && `${n.off} off`].filter(Boolean).join(' · ');
};

router.get('/settings/roles/:key', (req, res) => {
  const role = roleOf(req.household, req.params.key);
  if (!role) return res.status(404).send('Not found');
  const levels = role.sections || {};
  res.render('settings/role', {
    active: 'settings',
    role: { ...role, pages: role.pages || {}, todayHidden: role.todayHidden || [] },
    sections: SECTIONS.filter((s) => req.household.features[s.key] !== false).map((s) => {
      const lvl = levels[s.key] || 'edit';
      // A hidden section shows the choices it had before (or Edit's), for when it's shown again.
      const c = lvl === 'view' ? viewCustom(s.key) : lvl === 'custom' || lvl === 'hidden' ? fillCustom(s.key, (role.custom || {})[s.key]) : fullCustom(s.key);
      const parts = (PARTS[s.key] || []).map(([a, label, kind]) => ({ a, label, kind, options: KINDS[kind], value: kind === 'action' ? (c[a] ? 'yes' : 'no') : c[a] }));
      return { key: s.key, label: sectionName(req.household, s.key), shown: lvl !== 'hidden', parts, summary: summaryOf(parts) };
    }),
    EXTRA, PAGES,
    cards: WIDGETS.filter((w) => !w.feature || req.household.features[w.feature] !== false),
    error: null,
  });
});

router.post('/settings/roles/:key', async (req, res, next) => {
  try {
    const roles = roleList(req.household);
    const i = roles.findIndex((r) => r.key === req.params.key);
    if (i < 0) return res.status(404).send('Not found');
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 24) || roles[i].name;
    if (name.toLowerCase() === 'admin' || roles.some((r, j) => j !== i && r.name.toLowerCase() === name.toLowerCase())) {
      req.session.flash = `There’s already a role called ${name}.`;
      return res.redirect(`/settings/roles/${roles[i].key}`);
    }
    // Sections that are turned off keep whatever they had, for when they come back on.
    // Each shown section: one choice per part, stored as edit/view when it matches those exactly.
    const sections = { ...roles[i].sections };
    const custom = { ...(roles[i].custom || {}) };
    SECTIONS.forEach((s) => {
      if (req.household.features[s.key] === false) return;
      // A plain level (hidden, view, edit) still works, as the older form sent it.
      if (!b[`c_${s.key}_edit`]) { if (['hidden', 'view', 'edit'].includes(b[`s_${s.key}`])) sections[s.key] = b[`s_${s.key}`]; return; }
      const c = readCustom(s.key, b);
      custom[s.key] = c; // kept while hidden too, for when it's shown again
      sections[s.key] = b[`show_${s.key}`] === 'on' ? levelFor(s.key, c) : 'hidden';
    });
    const pages = Object.fromEntries(Object.keys(PAGES).map((k) => [k, b[`p_${k}`] === 'on']));
    const shown = new Set([].concat(b.cards || []).map(String));
    const todayHidden = WIDGETS.filter((w) => !w.feature || req.household.features[w.feature] !== false).map((w) => w.k).filter((k) => !shown.has(k));
    roles[i] = { ...roles[i], name, sections, custom, pages, todayHidden, ...Object.fromEntries(Object.keys(EXTRA).map((k) => [k, b[k] === 'on'])) };
    req.household.roles = roles;
    await req.household.save();
    await logActivity(req.user, { section: 'Settings', text: `${req.user.name} changed what ${name} can do` });
    req.session.flash = `${name} saved.`;
    res.redirect('/settings/roles');
  } catch (err) {
    next(err);
  }
});

// A role can be deleted once nobody has it (and one role always stays).
router.post('/settings/roles/:key/delete', async (req, res, next) => {
  try {
    const roles = roleList(req.household);
    const role = roles.find((r) => r.key === req.params.key);
    if (!role) return res.status(404).send('Not found');
    const people = await Membership.countDocuments({ householdId: req.household._id, role: role.key });
    if (people) req.session.flash = `${people} ${people === 1 ? 'person has' : 'people have'} the ${role.name} role. Give them another role first.`;
    else if (roles.length === 1) req.session.flash = 'Keep at least one role besides Admin.';
    else {
      req.household.roles = roles.filter((r) => r.key !== role.key);
      await req.household.save();
      await logActivity(req.user, { section: 'Settings', text: `${req.user.name} deleted the role ${role.name}` });
      req.session.flash = `${role.name} deleted.`;
    }
    res.redirect('/settings/roles');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
