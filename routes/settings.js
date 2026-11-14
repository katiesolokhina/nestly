const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const User = require('../models/User');
const AccessToken = require('../models/AccessToken');
const { SECTIONS, MAX_PINS, enabledSections } = require('../lib/sections');
const { deleteUserSessions } = require('../lib/sessions');
const { logActivity } = require('../lib/activity');

const router = express.Router();

const NOTICES = {
  password: 'Password changed. Your other devices were signed out.',
  appearance: 'Appearance saved.',
  pins: 'Bottom bar saved.',
  notify: 'Notification settings saved.',
  pinLimit: `The bottom bar holds ${MAX_PINS} sections, so only the first ${MAX_PINS} were saved.`,
  sections: 'Sections saved.',
  revoked: 'Invite canceled.',
  disabled: 'Account turned off. They were signed out everywhere.',
  enabled: 'Account turned back on.',
  role: 'Role saved.',
  removed: 'Account deleted.',
};

router.get('/settings', requireAuth, async (req, res, next) => {
  try {
    const { householdId } = req.user;
    const members = await User.find({ householdId }, { name: 1, email: 1, role: 1, disabled: 1 }).sort({ createdAt: 1 }).lean();
    let invites = [];
    let link = null;
    if (req.user.role === 'admin') {
      invites = await AccessToken.find({ kind: 'invite', householdId, usedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
      link = req.session.flashLink || null;
      delete req.session.flashLink; // a new link is shown exactly once
    }
    res.render('settings', {
      active: 'settings',
      notice: NOTICES[req.query.saved] || null,
      members,
      invites,
      link,
      sections: SECTIONS,
      pinOptions: enabledSections(req.household),
      maxPins: MAX_PINS,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/appearance', requireAuth, async (req, res, next) => {
  try {
    if (['system', 'light', 'dark'].includes(req.body.theme)) {
      req.user.theme = req.body.theme;
      await req.user.save();
    }
    res.redirect('/settings?saved=appearance');
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
    await req.user.save();
    res.redirect('/settings?saved=notify#notifications');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/pins', requireAuth, async (req, res, next) => {
  try {
    const chosen = [].concat(req.body.pins || []).filter((k) => SECTIONS.some((s) => s.key === k));
    req.user.pins = [...new Set(chosen)].slice(0, MAX_PINS);
    await req.user.save();
    res.redirect(`/settings?saved=${new Set(chosen).size > MAX_PINS ? 'pinLimit' : 'pins'}`);
  } catch (err) {
    next(err);
  }
});

// Admin only: household-wide. Turning a section off keeps its data.
router.post('/settings/sections', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const on = new Set([].concat(req.body.sections || []));
    const changes = [];
    SECTIONS.forEach((s) => {
      const value = on.has(s.key);
      if (req.household.features[s.key] !== value) changes.push(`turned ${s.label} ${value ? 'on' : 'off'}`);
      req.household.features[s.key] = value;
    });
    await req.household.save();
    if (changes.length) await logActivity(req.user, { section: 'Settings', text: `${req.user.name} ${changes.join(', ')}` });
    res.redirect('/settings?saved=sections');
  } catch (err) {
    next(err);
  }
});

// ---------- Account ----------
const renderAccount = (res, status, errors = {}) => res.status(status).render('account', { active: 'settings', errors });

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
      req.session.save((err2) => (err2 ? next(err2) : res.redirect('/settings?saved=password')));
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
