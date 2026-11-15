// Admin-only account management, always limited to the admin's own household.
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const User = require('../models/User');
const Membership = require('../models/Membership');
const PushSubscription = require('../models/PushSubscription');
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

// Another person in this household (never yourself) that this admin may manage.
// Returns their account plus their membership here; role and turned-off are per household.
async function member(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  if (req.params.id === req.user.id) return null;
  const m = await Membership.findOne({ userId: req.params.id, householdId: req.user.householdId });
  const user = m && (await User.findById(m.userId));
  if (!user) return null;
  const others = await Membership.countDocuments({ userId: user._id, householdId: { $ne: req.user.householdId } });
  return { m, user, view: { _id: user._id, name: user.name, email: user.email, role: m.role, disabled: m.disabled, otherHomes: others } };
}

// A password reset changes someone's sign-in everywhere, so it's only allowed when this
// admin is also an admin in every other household the person belongs to.
async function canReset(req, userId) {
  const theirs = await Membership.find({ userId }, { householdId: 1 }).lean();
  const mine = await Membership.find({ userId: req.user._id, role: 'admin', disabled: false }, { householdId: 1 }).lean();
  const adminOf = new Set(mine.map((x) => String(x.householdId)));
  return theirs.every((x) => adminOf.has(String(x.householdId)));
}

// Ends sign-in everywhere once someone can't use any household.
async function signOutIfNoHomes(userId) {
  const left = await Membership.countDocuments({ userId, disabled: false });
  if (!left) await Promise.all([deleteUserSessions(userId), AccessToken.deleteMany({ kind: 'reset', userId })]);
}

// ---------- Invites ----------
router.post('/settings/household/invites', async (req, res, next) => {
  try {
    const label = String(req.body.label || '').trim().slice(0, 40);
    const { raw } = await AccessToken.issue({ kind: 'invite', householdId: req.user.householdId, createdBy: req.user._id, label, days: INVITE_DAYS });
    // Shown once on the next page load; only its hash is stored.
    req.session.flashLink = { kind: 'invite', url: linkFor('invite', raw), label, days: `${INVITE_DAYS} days` };
    await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} created an invite link${label ? ` for ${label}` : ''}` });
    res.redirect('/settings/people');
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
    res.redirect('/settings/people?saved=revoked');
  } catch (err) {
    next(err);
  }
});

// ---------- Members ----------
router.get('/settings/household/members/:id', async (req, res, next) => {
  try {
    const t = await member(req);
    if (!t) return res.status(404).send('Account not found');
    res.render('member', { active: 'settings', target: t.view, canReset: await canReset(req, t.user._id) });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/household/members/:id/role', async (req, res, next) => {
  try {
    const t = await member(req);
    if (!t) return res.status(404).send('Account not found');
    if (['admin', 'member'].includes(req.body.role) && t.m.role !== req.body.role) {
      t.m.role = req.body.role;
      await t.m.save();
      await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} made ${t.user.name} ${t.m.role === 'admin' ? 'an admin' : 'a member'}` });
    }
    res.redirect('/settings/people?saved=role');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/household/members/:id/reset', async (req, res, next) => {
  try {
    const t = await member(req);
    if (!t) return res.status(404).send('Account not found');
    const target = t.user;
    if (!(await canReset(req, target._id))) return res.status(403).render('member', { active: 'settings', target: t.view, canReset: false });
    await AccessToken.deleteMany({ kind: 'reset', userId: target._id, usedAt: null }); // only the newest link works
    const { raw } = await AccessToken.issue({ kind: 'reset', householdId: req.user.householdId, createdBy: req.user._id, userId: target._id, days: RESET_DAYS });
    req.session.flashLink = { kind: 'reset', url: linkFor('reset', raw), label: target.name, days: '24 hours' };
    await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} created a password reset link for ${target.name}` });
    res.redirect('/settings/people');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/household/members/:id/disable', async (req, res, next) => {
  try {
    const t = await member(req);
    if (!t) return res.status(404).send('Account not found');
    t.m.disabled = true;
    await t.m.save();
    // Out of this household right away; signed out completely if it was their only one.
    await signOutIfNoHomes(t.user._id);
    await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} turned off ${t.user.name} in this household` });
    res.redirect('/settings/people?saved=disabled');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/household/members/:id/enable', async (req, res, next) => {
  try {
    const t = await member(req);
    if (!t) return res.status(404).send('Account not found');
    t.m.disabled = false;
    await t.m.save();
    await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} turned ${t.user.name} back on in this household` });
    res.redirect('/settings/people?saved=enabled');
  } catch (err) {
    next(err);
  }
});

// ---------- Delete account (permanent) ----------
router.get('/settings/household/members/:id/delete', async (req, res, next) => {
  try {
    const t = await member(req);
    if (!t) return res.status(404).send('Account not found');
    res.render('member-delete', { active: 'settings', target: t.view, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/household/members/:id/delete', async (req, res, next) => {
  try {
    const t = await member(req);
    if (!t) return res.status(404).send('Account not found');
    const target = t.user;
    if (String(req.body.confirmEmail || '').trim().toLowerCase() !== target.email) {
      return res.status(422).render('member-delete', { active: 'settings', target: t.view, error: `Type ${target.email} exactly to confirm.` });
    }
    // Their private items here go with them. Shared items stay with the household.
    await deletePrivateData({ _id: target._id, householdId: req.user.householdId });
    await Membership.deleteOne({ _id: t.m._id });
    // Not in any other household: the account itself is deleted.
    if (!(await Membership.exists({ userId: target._id }))) {
      await Promise.all([AccessToken.deleteMany({ userId: target._id }), deleteUserSessions(target._id), PushSubscription.deleteMany({ userId: target._id })]);
      await User.deleteOne({ _id: target._id });
    }
    await logActivity(req.user, { section: SETTINGS_SECTION, text: `${req.user.name} removed ${target.name} from the household` });
    res.redirect('/settings/people?saved=removed');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
