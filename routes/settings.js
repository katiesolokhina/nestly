const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const User = require('../models/User');
const AccessToken = require('../models/AccessToken');
const { SECTIONS, MAX_PINS, enabledSections } = require('../lib/sections');
const { deleteUserSessions } = require('../lib/sessions');
const { logActivity } = require('../lib/activity');
const { sectionName } = require('../lib/prefs');
const { rolesOf } = require('../lib/perms');
const { membersOf } = require('../lib/members');

const router = express.Router();

const NOTICES = {
  password: 'Password changed. Your other devices were signed out.',
  appearance: 'Appearance saved.',
  pins: 'Bottom bar saved.',
  notify: 'Notification settings saved.',
  pinLimit: `The bottom bar holds ${MAX_PINS} sections, so only the first ${MAX_PINS} were saved.`,
  sections: 'Sections saved.',
  revoked: 'Invite canceled.',
  disabled: 'Turned off. They can’t use this household until it’s turned back on.',
  enabled: 'Account turned back on.',
  role: 'Role saved.',
  removed: 'Removed from the household.',
  left: 'You left that household.',
};

// The menu: You, Household, and each section's own page.
router.get('/settings', requireAuth, (req, res) => {
  res.render('settings', {
    active: 'settings',
    notice: NOTICES[req.query.saved] || null,
    sectionRows: enabledSections(req.view).filter((s) => s.key !== 'chores' && req.perms.level(s.key) === 'edit'),
  });
});

const page = (view, extra = {}) => (req, res) => res.render(view, { active: 'settings', notice: NOTICES[req.query.saved] || null, ...extra });
router.get('/settings/appearance', requireAuth, page('settings/appearance'));
router.get('/settings/notifications', requireAuth, page('settings/notifications'));
router.get('/settings/bottom-bar', requireAuth, (req, res) => page('settings/bottom-bar', { pinOptions: enabledSections(req.view).map((s) => ({ ...s, label: sectionName(req.household, s.key) })), maxPins: MAX_PINS })(req, res));

// People: everyone can see who's in the household; admins invite and manage.
router.get('/settings/people', requireAuth, async (req, res, next) => {
  try {
    const { householdId } = req.user;
    const members = await membersOf(householdId, { fields: { email: 1 }, includeDisabled: true });
    let invites = [];
    let link = null;
    if (req.perms.invite) {
      invites = await AccessToken.find({ kind: 'invite', householdId, usedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
      link = req.session.flashLink || null;
      delete req.session.flashLink; // a new link is shown exactly once
    }
    const roles = rolesOf(req.household);
    const roleNames = { admin: 'Admin', ...Object.fromEntries(roles.map((r) => [r.key, r.name])) };
    res.render('settings/people', { active: 'settings', notice: NOTICES[req.query.saved] || null, members, invites, link, roles, roleNames });
  } catch (err) {
    next(err);
  }
});

router.get('/settings/sections', requireAuth, requireAdmin, (req, res) => {
  res.render('settings/sections', { active: 'settings', notice: NOTICES[req.query.saved] || null, sections: SECTIONS, nameOf: (k) => sectionName(req.household, k) });
});

router.post('/settings/appearance', requireAuth, async (req, res, next) => {
  try {
    if (['system', 'light', 'dark'].includes(req.body.theme)) {
      req.user.theme = req.body.theme;
      await req.user.save();
    }
    res.redirect('/settings/appearance?saved=appearance');
  } catch (err) {
    next(err);
  }
});

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
router.post('/settings/notifications', requireAuth, async (req, res, next) => {
  try {
    const b = req.body;
    const n = req.user.notify;
    if (TIME.test(b.morning || '')) n.morning = b.morning;
    n.reminders = b.reminders === 'on';
    n.events = b.events === 'on';
    n.shopping = b.shopping === 'on';
    if (b.infoForm === '1') {
      n.warranty = b.warranty === 'on';
      const wd = parseInt(b.warrantyDays, 10);
      if ([7, 14, 30, 60, 90].includes(wd)) n.warrantyDays = wd;
    }
    if (b.pantryForm === '1') {
      n.pantryExpiry = b.pantryExpiry === 'on';
      const pd = parseInt(b.pantryExpiryDays, 10);
      if ([0, 1, 2, 3, 5, 7].includes(pd)) n.pantryExpiryDays = pd;
    }
    if (b.billsForm === '1') {
      n.billsBefore = b.billsBefore === 'on';
      const days = parseInt(b.billsBeforeDays, 10);
      if ([1, 2, 3, 5, 7, 14].includes(days)) n.billsBeforeDays = days;
      n.billsDue = b.billsDue === 'on';
      n.billsOverdue = b.billsOverdue === 'on';
      n.billsPaid = b.billsPaid === 'on';
      n.billsPaidBack = b.billsPaidBack === 'on';
      n.billsWeekly = b.billsWeekly === 'on';
    }
    await req.user.save();
    res.redirect('/settings/notifications?saved=notify');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/pins', requireAuth, async (req, res, next) => {
  try {
    const chosen = [].concat(req.body.pins || []).filter((k) => SECTIONS.some((s) => s.key === k));
    req.member.pins = [...new Set(chosen)].slice(0, MAX_PINS);
    await req.member.save();
    res.redirect(`/settings/bottom-bar?saved=${new Set(chosen).size > MAX_PINS ? 'pinLimit' : 'pins'}`);
  } catch (err) {
    next(err);
  }
});

// Admin only: household-wide. Turning a section off keeps its data. Names are optional.
router.post('/settings/sections', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const on = new Set([].concat(req.body.sections || []));
    const changes = [];
    const names = [];
    SECTIONS.forEach((s) => {
      const value = on.has(s.key);
      if (req.household.features[s.key] !== value) changes.push(`turned ${sectionName(req.household, s.key)} ${value ? 'on' : 'off'}`);
      req.household.features[s.key] = value;
      if (typeof req.body[`name_${s.key}`] === 'string') {
        const label = req.body[`name_${s.key}`].trim().slice(0, 24);
        if (label && label !== s.label) names.push({ key: s.key, label });
      } else {
        const kept = (req.household.sectionNames || []).find((n) => n.key === s.key);
        if (kept) names.push({ key: kept.key, label: kept.label });
      }
    });
    const before = JSON.stringify((req.household.sectionNames || []).map((n) => [n.key, n.label]));
    if (JSON.stringify(names.map((n) => [n.key, n.label])) !== before) changes.push('renamed sections');
    req.household.sectionNames = names;
    await req.household.save();
    if (changes.length) await logActivity(req.user, { section: 'Settings', text: `${req.user.name} ${changes.join(', ')}` });
    res.redirect('/settings/sections?saved=sections');
  } catch (err) {
    next(err);
  }
});

// ---------- Account ----------
const renderAccount = (res, status, errors = {}) => res.status(status).render('account', { active: 'settings', errors, notice: NOTICES[res.req.query.saved] || null });

router.get('/settings/account', requireAuth, (req, res) => renderAccount(res, 200));

const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => renderAccount(res, 429, { form: 'Too many attempts. Try again in 15 minutes.' }),
});

router.post('/settings/password', requireAuth, passwordLimiter, async (req, res, next) => {
  try {
    const current = String(req.body.currentPassword || '');
    const next1 = String(req.body.newPassword || '');
    const next2 = String(req.body.confirmPassword || '');
    const errors = {};
    if (!(await req.user.verifyPassword(current))) errors.currentPassword = 'That isn’t your current password.';
    if (next1.length < 8) errors.newPassword = 'Use at least 8 characters.';
    else if (next1 === current) errors.newPassword = 'Pick a password different from your current one.';
    if (!errors.newPassword && next1 !== next2) errors.confirmPassword = 'Passwords don’t match.';
    if (Object.keys(errors).length) return renderAccount(res, 422, errors);

    req.user.passwordHash = await User.hashPassword(next1);
    await req.user.save();
    await deleteUserSessions(req.user._id, req.sessionID); // signs out every other device

    // Fresh session id for this device too.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = req.user._id.toString();
      req.session.save((err2) => (err2 ? next(err2) : res.redirect('/settings/account?saved=password')));
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/signout-all', requireAuth, async (req, res, next) => {
  try {
    await deleteUserSessions(req.user._id);
    res.clearCookie('nestly.sid');
    res.redirect('/login');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
