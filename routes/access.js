// Public pages opened from one-time links: accept a household invite, or reset a password.
const express = require('express');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const AccessToken = require('../models/AccessToken');
const Household = require('../models/Household');
const Membership = require('../models/Membership');
const { homesOf } = require('../lib/members');
const { deleteUserSessions } = require('../lib/sessions');
const { logActivity } = require('../lib/activity');

const router = express.Router();

const linkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).render('link-invalid', { reason: 'Too many attempts. Try again in 15 minutes.' }),
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function signIn(req, res, next, userId) {
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = userId.toString();
    req.session.save((err2) => (err2 ? next(err2) : res.redirect('/')));
  });
}

const INVALID = 'This link has expired or was already used. Ask for a new one.';

// ---------- Invite ----------
const homeName = async (invite) => ((await Household.findById(invite.householdId, { name: 1 }).lean()) || {}).name || 'your household';
const inviteView = async (invite, token, extra) => ({ token, home: await homeName(invite), me: null, already: false, values: { name: invite.label || '', email: '' }, errors: {}, ...extra });

router.get('/invite/:token', async (req, res, next) => {
  try {
    const invite = await AccessToken.peek('invite', req.params.token);
    if (!invite) return res.status(410).render('link-invalid', { reason: INVALID });
    // Already signed in: join with this account, no new password needed.
    const me = req.session.userId ? await User.findById(req.session.userId, { name: 1, email: 1 }).lean() : null;
    const already = me ? Boolean(await Membership.exists({ userId: me._id, householdId: invite.householdId })) : false;
    res.render('invite', await inviteView(invite, req.params.token, { me, already }));
  } catch (err) {
    next(err);
  }
});

// Has an account but isn't signed in: sign in first, then come back to this link.
router.get('/invite/:token/signin', (req, res) => {
  if (/^[\w-]{20,}$/.test(req.params.token)) req.session.returnTo = `/invite/${req.params.token}`;
  res.redirect('/login');
});

// Joins with the account that's signed in.
router.post('/invite/:token/join', linkLimiter, async (req, res, next) => {
  try {
    const me = req.session.userId ? await User.findById(req.session.userId) : null;
    if (!me) return res.redirect(`/invite/${req.params.token}/signin`);
    const pending = await AccessToken.peek('invite', req.params.token);
    if (!pending) return res.status(410).render('link-invalid', { reason: INVALID });
    if (await Membership.exists({ userId: me._id, householdId: pending.householdId })) {
      req.session.householdId = String(pending.householdId);
      return res.redirect('/');
    }
    const invite = await AccessToken.claim('invite', req.params.token);
    if (!invite) return res.status(410).render('link-invalid', { reason: INVALID });
    await Membership.create({ userId: me._id, householdId: invite.householdId, role: 'member', invitedBy: invite.createdBy });
    req.session.householdId = String(invite.householdId);
    await logActivity({ ...me.toObject(), householdId: invite.householdId }, { section: 'Settings', text: `${me.name} joined the household` });
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/invite/:token', linkLimiter, async (req, res, next) => {
  try {
    const { token } = req.params;
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const confirm = String(req.body.confirmPassword || '');
    const timezone = validTimezone(req.body.timezone) ? req.body.timezone : 'America/Chicago';

    const errors = {};
    if (!name || name.length > 40) errors.name = 'Enter your name (up to 40 characters).';
    if (!EMAIL.test(email)) errors.email = 'Enter a valid email.';
    else if (await User.exists({ email })) errors.email = 'That email already has a Nestly account. Sign in to join with it.';
    if (password.length < 8) errors.password = 'Use at least 8 characters.';
    else if (password !== confirm) errors.confirmPassword = 'Passwords don’t match.';
    if (Object.keys(errors).length) {
      if (!(await AccessToken.peek('invite', token))) return res.status(410).render('link-invalid', { reason: INVALID });
      const peeked = await AccessToken.peek('invite', token);
      return res.status(422).render('invite', await inviteView(peeked, token, { values: { name, email }, errors }));
    }

    // Claim the link first: if two people submit it at once, only one wins.
    const invite = await AccessToken.claim('invite', token);
    if (!invite) return res.status(410).render('link-invalid', { reason: INVALID });

    let user;
    try {
      user = await User.create({
        email, name, timezone, householdId: invite.householdId, invitedBy: invite.createdBy,
        passwordHash: await User.hashPassword(password),
      });
      await Membership.create({ userId: user._id, householdId: invite.householdId, role: 'member', invitedBy: invite.createdBy });
    } catch (err) {
      await AccessToken.updateOne({ _id: invite._id }, { $set: { usedAt: null } }); // give the link back
      if (err.code === 11000) {
        return res.status(422).render('invite', await inviteView(invite, token, { values: { name, email }, errors: { email: 'That email already has a Nestly account. Sign in to join with it.' } }));
      }
      throw err;
    }
    await logActivity(user, { section: 'Settings', text: `${user.name} joined the household` });
    signIn(req, res, next, user._id);
  } catch (err) {
    next(err);
  }
});

// ---------- Password reset ----------
router.get('/reset/:token', async (req, res, next) => {
  try {
    const reset = await AccessToken.peek('reset', req.params.token);
    const user = reset && (await User.findById(reset.userId));
    if (!user || !(await homesOf(user._id)).length) return res.status(410).render('link-invalid', { reason: INVALID });
    res.render('reset', { token: req.params.token, email: user.email, errors: {} });
  } catch (err) {
    next(err);
  }
});

router.post('/reset/:token', linkLimiter, async (req, res, next) => {
  try {
    const { token } = req.params;
    const password = String(req.body.password || '');
    const confirm = String(req.body.confirmPassword || '');

    const pending = await AccessToken.peek('reset', token);
    const target = pending && (await User.findById(pending.userId));
    if (!target || !(await homesOf(target._id)).length) return res.status(410).render('link-invalid', { reason: INVALID });

    const errors = {};
    if (password.length < 8) errors.password = 'Use at least 8 characters.';
    else if (password !== confirm) errors.confirmPassword = 'Passwords don’t match.';
    if (Object.keys(errors).length) return res.status(422).render('reset', { token, email: target.email, errors });

    const reset = await AccessToken.claim('reset', token);
    if (!reset) return res.status(410).render('link-invalid', { reason: INVALID });

    target.passwordHash = await User.hashPassword(password);
    await target.save();
    await deleteUserSessions(target._id); // sign out everywhere, then sign in fresh here
    signIn(req, res, next, target._id);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
