// Today, More, Activity, and the section pages.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const mongoose = require('mongoose');
const { moreLinks, sectionByKey, SECTIONS } = require('../lib/sections');
const { buildToday, layoutFor } = require('../lib/today');
const { applyUndo, canRestore } = require('../lib/changes');
const { visibleActivity } = require('../lib/activity');
const Activity = require('../models/Activity');

const router = express.Router();

const SAFE_BACK = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/');

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.render('today', { active: 'today', ...(await buildToday(req.user, req.household)) });
  } catch (err) {
    next(err);
  }
});

router.get('/customize', requireAuth, (req, res) => {
  res.render('customize', { active: 'today', rows: layoutFor(req.user, req.household) });
});

router.post('/customize', requireAuth, async (req, res, next) => {
  try {
    const rows = layoutFor(req.user, req.household);
    const i = rows.findIndex((r) => r.k === req.body.k);
    if (req.body.action === 'reset') req.user.dashboard = [];
    else if (i >= 0) {
      if (req.body.action === 'toggle') rows[i].on = !rows[i].on;
      const j = req.body.action === 'up' ? i - 1 : req.body.action === 'down' ? i + 1 : -1;
      if (j >= 0 && j < rows.length) [rows[i], rows[j]] = [rows[j], rows[i]];
      // Keep hidden sections' widgets so they return where they were.
      const shown = new Set(rows.map((r) => r.k));
      const kept = (req.user.dashboard || []).filter((d) => !shown.has(d.k)).map((d) => ({ k: d.k, on: d.on }));
      req.user.dashboard = [...rows.map((r) => ({ k: r.k, on: r.on })), ...kept];
    }
    await req.user.save();
    res.redirect('/customize');
  } catch (err) {
    next(err);
  }
});

// Undo from the message after a change, or Restore from Activity.
router.post('/activity/:id/undo', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).send('Not found');
    const entry = await Activity.findOne({ _id: req.params.id, ...visibleActivity(req.user) });
    if (!entry || !entry.undo) return res.status(404).send('Not found');
    const result = await applyUndo(req.user, entry);
    if (!result.ok) req.session.flash = result.message;
    res.redirect(SAFE_BACK(req.body.back));
  } catch (err) {
    next(err);
  }
});

router.get('/more', requireAuth, (req, res) => {
  res.render('more', { active: 'more', links: moreLinks(req.user, req.household) });
});

const ACTIVITY_SECTIONS = ['Settings', ...SECTIONS.map((s) => s.label)];

router.get('/activity', requireAuth, async (req, res, next) => {
  try {
    const section = ACTIVITY_SECTIONS.includes(req.query.section) ? req.query.section : '';
    const filter = visibleActivity(req.user);
    if (section) filter.section = section;
    const entries = await Activity.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: req.user.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const rows = await Promise.all(entries.map(async (e) => ({ ...e, when: fmt.format(e.createdAt), restorable: await canRestore(e) })));
    res.render('activity', { active: 'activity', section, sections: ACTIVITY_SECTIONS, entries: rows });
  } catch (err) {
    next(err);
  }
});

// A section that's turned off doesn't exist as far as anyone's concerned.
router.get('/s/:key', requireAuth, (req, res) => {
  const section = sectionByKey(req.params.key);
  if (!section || req.household.features[section.key] === false) return res.status(404).send('Not found');
  res.render('section-soon', { active: section.key, section });
});

module.exports = router;
