// Switching between households, starting a new one, and leaving one.
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Household = require('../models/Household');
const Membership = require('../models/Membership');
const User = require('../models/User');
const { logActivity } = require('../lib/activity');
const { deletePrivateData } = require('../lib/changes');

const router = express.Router();

// Only ever redirect within Nestly.
const safeNext = (v) => (typeof v === 'string' && /^\/(?!\/)[^\s\\]*$/.test(v) ? v : '/');

async function switchTo(req, householdId) {
  if (!mongoose.isValidObjectId(householdId)) return false;
  const m = await Membership.findOne({ userId: req.user._id, householdId, disabled: false }).lean();
  if (!m) return false;
  req.session.householdId = String(householdId);
  await User.updateOne({ _id: req.user._id }, { $set: { householdId } }); // also the default next sign-in
  return true;
}

router.get('/households', requireAuth, async (req, res, next) => {
  try {
    const counts = await Membership.aggregate([
      { $match: { householdId: { $in: res.locals.homes.map((h) => h.householdId) }, disabled: false } },
      { $group: { _id: '$householdId', n: { $sum: 1 } } },
    ]);
    const admins = await Membership.aggregate([
      { $match: { householdId: { $in: res.locals.homes.map((h) => h.householdId) }, disabled: false, role: 'admin' } },
      { $group: { _id: '$householdId', n: { $sum: 1 } } },
    ]);
    const n = (list, id) => (list.find((c) => String(c._id) === String(id)) || {}).n || 0;
    res.render('households', {
      active: 'settings',
      error: null,
      rows: res.locals.homes.map((h) => ({
        ...h,
        current: String(h.householdId) === String(req.household._id),
        people: n(counts, h.householdId),
        // Leaving is blocked when you're the only person, or the only admin with others still there.
        canLeave: res.locals.homes.length > 1 && n(counts, h.householdId) > 1 && !(h.role === 'admin' && n(admins, h.householdId) === 1),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/households/switch', requireAuth, async (req, res, next) => {
  try {
    if (!(await switchTo(req, req.body.id))) return res.status(404).send('Not found');
    res.redirect(safeNext(req.body.next));
  } catch (err) {
    next(err);
  }
});

// Links in notifications: open the household the notification is about, then the page.
router.get('/h/:id', requireAuth, async (req, res, next) => {
  try {
    await switchTo(req, req.params.id);
    res.redirect(safeNext(req.query.next));
  } catch (err) {
    next(err);
  }
});

// Start a new household. The person starting it is its first admin.
router.post('/households', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) {
      req.session.flash = 'Give the new household a name.';
      return res.redirect('/households');
    }
    if (res.locals.homes.length >= 10) {
      req.session.flash = 'You can be in up to 10 households.';
      return res.redirect('/households');
    }
    const home = await Household.create({ name });
    await Membership.create({ userId: req.user._id, householdId: home._id, role: 'admin' });
    await switchTo(req, home._id);
    await logActivity({ ...req.user.toObject(), householdId: home._id }, { section: 'Settings', text: `${req.user.name} started ${name}` });
    req.session.flash = `Welcome to ${name}. Invite people from Settings.`;
    res.redirect('/settings#household');
  } catch (err) {
    next(err);
  }
});

router.post('/households/:id/leave', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).send('Not found');
    const m = await Membership.findOne({ userId: req.user._id, householdId: req.params.id });
    if (!m) return res.status(404).send('Not found');
    const [others, admins, mine] = await Promise.all([
      Membership.countDocuments({ householdId: m.householdId, disabled: false, userId: { $ne: req.user._id } }),
      Membership.countDocuments({ householdId: m.householdId, disabled: false, role: 'admin', userId: { $ne: req.user._id } }),
      Membership.countDocuments({ userId: req.user._id, disabled: false }),
    ]);
    if (mine < 2) req.session.flash = 'You can’t leave your only household.';
    else if (!others) req.session.flash = 'You’re the only person there, so it can’t be left.';
    else if (m.role === 'admin' && !admins) req.session.flash = 'Make someone else an admin there first.';
    else {
      await deletePrivateData({ _id: req.user._id, householdId: m.householdId });
      await m.deleteOne();
      await logActivity({ ...req.user.toObject(), householdId: m.householdId }, { section: 'Settings', text: `${req.user.name} left the household` });
      if (String(req.session.householdId) === String(m.householdId)) delete req.session.householdId;
      return res.redirect('/settings?saved=left');
    }
    res.redirect('/households');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
