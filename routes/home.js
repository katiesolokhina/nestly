// Today, More, Activity, and the section pages.
const express = require('express');
const { requireAuth, requirePerm } = require('../middleware/auth');
const mongoose = require('mongoose');
const { moreLinks, sectionByKey, SECTIONS } = require('../lib/sections');
const { buildToday, layoutFor } = require('../lib/today');
const { applyUndo, canRestore } = require('../lib/changes');
const { visibleActivity, logActivity } = require('../lib/activity');
const { todayIn, addDays, weekday, isDate, dayLabel, shortDay, zonedDate } = require('../lib/dates');
const { pruneActivity } = require('../lib/housekeeping');
const Activity = require('../models/Activity');

const router = express.Router();

const SAFE_BACK = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/');

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.render('today', { active: 'today', ...(await buildToday(req.user, req.view, req.member)) });
  } catch (err) {
    next(err);
  }
});

router.get('/customize', requireAuth, (req, res) => {
  res.render('customize', { active: 'today', rows: layoutFor(req.member, req.view) });
});

router.post('/customize', requireAuth, async (req, res, next) => {
  try {
    const rows = layoutFor(req.member, req.view);
    const i = rows.findIndex((r) => r.k === req.body.k);
    if (req.body.action === 'reset') req.member.dashboard = [];
    else if (i >= 0) {
      if (req.body.action === 'toggle') rows[i].on = !rows[i].on;
      const j = req.body.action === 'up' ? i - 1 : req.body.action === 'down' ? i + 1 : -1;
      if (j >= 0 && j < rows.length) [rows[i], rows[j]] = [rows[j], rows[i]];
      // Keep hidden sections' widgets so they return where they were.
      const shown = new Set(rows.map((r) => r.k));
      const kept = (req.member.dashboard || []).filter((d) => !shown.has(d.k)).map((d) => ({ k: d.k, on: d.on }));
      req.member.dashboard = [...rows.map((r) => ({ k: r.k, on: r.on })), ...kept];
    }
    await req.member.save();
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
  res.render('more', { active: 'more', links: moreLinks(req.member, req.view, req.perms) });
});

const ACTIVITY_SECTIONS = ['Settings', ...SECTIONS.map((s) => s.label)];

// Activity, one week at a time. Admins can download it (CSV) or clear a stretch of it.
const weekOf = (household, d) => addDays(d, -((weekday(d) - (household.weekStart === 1 ? 1 : 0) + 7) % 7));
const between = (tz, from, to) => ({ $gte: zonedDate(from, 0, tz), $lt: zonedDate(addDays(to, 1), 0, tz) }); // whole local days

function activityFilter(req) {
  // Changes in sections this person's role hides aren't shown either.
  const hidden = SECTIONS.filter((s) => !req.sees(s.key)).map((s) => s.label);
  const shown = ACTIVITY_SECTIONS.filter((s) => !hidden.includes(s));
  const section = shown.includes(req.query.section) ? req.query.section : '';
  const filter = visibleActivity(req.user);
  if (section) filter.section = section;
  else if (hidden.length) filter.section = { $nin: hidden };
  return { filter, shown, section };
}

router.get('/activity', requireAuth, requirePerm('activity'), async (req, res, next) => {
  try {
    const tz = req.user.timezone;
    const today = todayIn(tz);
    const thisWeek = weekOf(req.household, today);
    const week = isDate(req.query.week) && req.query.week <= today ? weekOf(req.household, req.query.week) : thisWeek;
    const { filter, shown, section } = activityFilter(req);
    filter.createdAt = between(tz, week, addDays(week, 6));
    const entries = await Activity.find(filter).sort({ createdAt: -1 }).limit(1000).lean();
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    const dayOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
    const rows = await Promise.all(entries.map(async (e) => ({ ...e, day: dayOf(e.createdAt), when: fmt.format(e.createdAt), restorable: await canRestore(e) })));
    const days = [...new Set(rows.map((r) => r.day))].map((d) => ({ label: dayLabel(d, today), items: rows.filter((r) => r.day === d) }));
    const oldest = req.member.role === 'admin' ? await Activity.findOne({ householdId: req.user.householdId }, { createdAt: 1 }).sort({ createdAt: 1 }).lean() : null;
    res.render('activity', {
      active: 'activity', section, sections: shown, days, count: rows.length, week,
      weekLabel: week === thisWeek ? 'This week' : week === addDays(thisWeek, -7) ? 'Last week' : `Week of ${shortDay(week)}`,
      range: `${shortDay(week).replace(/, \d{4}$/, '')} – ${shortDay(addDays(week, 6))}`,
      prev: addDays(week, -7), next: week < thisWeek ? addDays(week, 7) : null, today,
      weekEnd: addDays(week, 6) < today ? addDays(week, 6) : today,
      oldest: oldest ? dayOf(oldest.createdAt) : null,
      oldestLabel: oldest ? shortDay(dayOf(oldest.createdAt)) : '',
      keepMonths: req.household.activityKeepMonths || 0,
    });
  } catch (err) {
    next(err);
  }
});

// CSV of a date range (or everything), for admins.
const csvCell = (v) => { const s = String(v == null ? '' : v); return /^[=+\-@]/.test(s) ? `"'${s.replace(/"/g, '""')}"` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

router.get('/activity/download', requireAuth, requirePerm('activity'), async (req, res, next) => {
  try {
    if (req.member.role !== 'admin') return res.status(404).send('Not found');
    const tz = req.user.timezone;
    const from = isDate(req.query.from) ? req.query.from : null;
    const to = isDate(req.query.to) ? req.query.to : todayIn(tz);
    const filter = { householdId: req.user.householdId, $or: [{ private: false }, { actorId: req.user._id }] };
    if (from) filter.createdAt = between(tz, from, to);
    const entries = await Activity.find(filter, { actorName: 1, section: 1, text: 1, createdAt: 1 }).sort({ createdAt: 1 }).lean();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    const lines = [['Date', 'Time', 'Who', 'Section', 'What'], ...entries.map((e) => [date.format(e.createdAt), time.format(e.createdAt), e.actorName, e.section, e.text])];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nestly-activity-${from || 'all'}-to-${to}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(`\ufeff${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`);
  } catch (err) {
    next(err);
  }
});

// Clear a stretch of days (everyone's entries in it), for admins. Nothing else changes, and the
// clearing itself is logged.
router.post('/activity/clear', requireAuth, requirePerm('activity'), async (req, res, next) => {
  try {
    if (req.member.role !== 'admin') return res.status(404).send('Not found');
    const b = req.body || {};
    const tz = req.user.timezone;
    if (!isDate(b.from) || !isDate(b.to) || b.to < b.from) {
      req.session.flash = 'Choose the first and last day to clear.';
      return res.redirect('/activity#tools');
    }
    const { deletedCount } = await Activity.deleteMany({ householdId: req.user.householdId, createdAt: between(tz, b.from, b.to) });
    const span = b.from === b.to ? shortDay(b.from) : `${shortDay(b.from)} to ${shortDay(b.to)}`;
    await logActivity(req.user, { section: 'Settings', text: `${req.user.name} cleared ${deletedCount} activity ${deletedCount === 1 ? 'entry' : 'entries'} from ${span}` });
    req.session.flash = `Cleared ${deletedCount} ${deletedCount === 1 ? 'entry' : 'entries'} from ${span}.`;
    res.redirect(`/activity${isDate(b.back) ? `?week=${b.back}` : ''}`);
  } catch (err) {
    next(err);
  }
});

// Settings → Activity: clear old activity automatically (off unless chosen).
const KEEP = [0, 1, 3, 6, 12, 24];
router.get('/settings/activity', requireAuth, (req, res) => {
  if (req.member.role !== 'admin') return res.status(404).send('Not found');
  res.render('settings/activity', { active: 'settings', keep: req.household.activityKeepMonths || 0, KEEP });
});
router.post('/settings/activity', requireAuth, async (req, res, next) => {
  try {
    if (req.member.role !== 'admin') return res.status(404).send('Not found');
    const n = Number((req.body || {}).keepMonths);
    if (KEEP.includes(n) && n !== (req.household.activityKeepMonths || 0)) {
      req.household.activityKeepMonths = n;
      await req.household.save();
      await logActivity(req.user, { section: 'Settings', text: n ? `${req.user.name} set Activity to clear entries older than ${n} ${n === 1 ? 'month' : 'months'}` : `${req.user.name} turned off clearing old Activity` });
      if (n) await pruneActivity(req.household._id);
    }
    req.session.flash = 'Activity settings saved.';
    res.redirect('/settings/activity');
  } catch (err) {
    next(err);
  }
});

// A section that's turned off doesn't exist as far as anyone's concerned.
router.get('/s/:key', requireAuth, (req, res) => {
  const section = sectionByKey(req.params.key);
  if (!section || !req.sees(section.key)) return res.status(404).send('Not found');
  res.render('section-soon', { active: section.key, section });
});

module.exports = router;
