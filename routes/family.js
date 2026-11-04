// Admin-only account management, always limited to the admin's own household.
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const User = require('../models/User');
const AccessToken = require('../models/AccessToken');
const { deleteUserSessions } = require('../lib/sessions');
const { logActivity } = require('../lib/activity');
const { deletePrivateData } = require('../lib/changes');

const router = express.Router();
router.use('/settings/household', requireAuth, requireAdmin);

const INVITE_DAYS = 7;
const RESET_DAYS = 1;
const SETTINGS_SECTION = 'Settings';

const linkFor = (kind, raw) => `${process.env.APP_ORIGIN}/${kind}/${raw}`;

// Another account in this household (never yourself) that this admin may manage.
function member(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  if (req.params.id === req.user.id) return null;
  return User.findOne({ _id: req.params.id, householdId: req.user.householdId });
}

// ---------- Invites ----------
router.post('/settings/household/invites', async (req, res, next) => {
  try {
    const label = String(req.body.label || '').trim().slice(0, 40);
    const { raw } = await AccessToken.issue({ kind: 'invite', householdId: req.user.householdId, createdBy: req.user._id, label, days: INVITE_DAYS });
    // Shown once on the next page load; only its hash is stored.
    req.session.flashLink = { kind: 'invite', url: linkFor('invite', raw), label, days: `${INVITE_DAYS} days` };
    await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} created an invite link${label ? ` for ${label}` : ''}` });
    res.redirect('/settings#household');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/household/invites/:id/revoke', async (req, res, next) => {
  try {
    if (mongoose.isValidObjectId(req.params.id)) {
      const { deletedCount } = await AccessToken.deleteOne({ _id: req.params.id, kind: 'invite', householdId: req.user.householdId, usedAt: null });
      if (deletedCount) await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} canceled an invite` });
    }
    res.redirect('/settings?saved=revoked#household');
  } catch (err) {
    next(err);
  }
});

// ---------- Members ----------
router.get('/settings/household/members/:id', async (req, res, next) => {
  try {
    const target = await member(req);
    if (!target) return res.status(404).send('Account not found');
    res.render('member', { active: 'settings', target });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/household/members/:id/role', async (req, res, next) => {
  try {
    const target = await member(req);
    if (!target) return res.status(404).send('Account not found');
    if (['admin', 'member'].includes(req.body.role) && target.role !== req.body.role) {
      target.role = req.body.role;
      await target.save();
      await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} made ${target.name} ${target.role === 'admin' ? 'an admin' : 'a member'}` });
    }
    res.redirect('/settings?saved=role#household');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/household/members/:id/reset', async (req, res, next) => {
  try {
    const target = await member(req);
    if (!target) return res.status(404).send('Account not found');
    await AccessToken.deleteMany({ kind: 'reset', userId: target._id, usedAt: null }); // only the newest link works
    const { raw } = await AccessToken.issue({ kind: 'reset', householdId: req.user.householdId, createdBy: req.user._id, userId: target._id, days: RESET_DAYS });
    req.session.flashLink = { kind: 'reset', url: linkFor('reset', raw), label: target.name, days: '24 hours' };
    await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} created a password reset link for ${target.name}` });
    res.redirect('/settings#household');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/household/members/:id/disable', async (req, res, next) => {
  try {
    const target = await member(req);
    if (!target) return res.status(404).send('Account not found');
    target.disabled = true;
    await target.save();
    await deleteUserSessions(target._id); // signed out on every device right away
    await AccessToken.deleteMany({ kind: 'reset', userId: target._id });
    await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} turned off ${target.name}'s account` });
    res.redirect('/settings?saved=disabled#household');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/household/members/:id/enable', async (req, res, next) => {
  try {
    const target = await member(req);
    if (!target) return res.status(404).send('Account not found');
    target.disabled = false;
    await target.save();
    await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} turned ${target.name}'s account back on` });
    res.redirect('/settings?saved=enabled#household');
  } catch (err) {
    next(err);
  }
});

// ---------- Delete account (permanent) ----------
router.get('/settings/household/members/:id/delete', async (req, res, next) => {
  try {
    const target = await member(req);
    if (!target) return res.status(404).send('Account not found');
    res.render('member-delete', { active: 'settings', target, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/household/members/:id/delete', async (req, res, next) => {
  try {
    const target = await member(req);
    if (!target) return res.status(404).send('Account not found');
    if (String(req.body.confirmEmail || '').trim().toLowerCase() !== target.email) {
      return res.status(422).render('member-delete', { active: 'settings', target, error: `Type ${target.email} exactly to confirm.` });
    }
    // Private items go with the account. Shared items stay with the household.
    await deletePrivateData(target);
    await Promise.all([AccessToken.deleteMany({ userId: target._id }), deleteUserSessions(target._id)]);
    await User.deleteOne({ _id: target._id });
    await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} deleted ${target.name}'s account` });
    res.redirect('/settings?saved=removed#household');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
