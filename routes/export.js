// Admins can download everything in their household as one JSON file: a copy they keep,
// separate from the server's nightly backups.
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { visible } = require('../lib/changes');
const { membersOf } = require('../lib/members');
const { logActivity } = require('../lib/activity');
const { roleName } = require('../lib/perms');

const router = express.Router();
router.use('/settings/export', requireAuth, requireAdmin);

// Models with private items: only what the person downloading can see goes in the file.
const SECTIONS = [
  ['shopping', 'ShoppingItem', true],
  ['savedItems', 'CatalogItem', false],
  ['reminders', 'Reminder', true],
  ['events', 'Event', true],
  ['recipes', 'Recipe', true],
  ['meals', 'Meal', true],
  ['bills', 'Bill', true],
  ['repeatingBills', 'BillSeries', true],
  ['pantry', 'PantryItem', true],
  ['homeInfo', 'InfoItem', true],
  ['lists', 'List', true],
  ['chores', 'Chore', false],
  ['choresDone', 'ChoreDone', false],
  ['rewardRequests', 'RewardClaim', false],
  ['files', 'Upload', true],
];
const tidy = (doc) => { const { __v, householdId, ...rest } = doc; return rest; };
// Your own wishlist comes without who's getting what.
const surprise = (l, user) => (l.type === 'wishlist' && String(l.ownerId || l.createdBy) === String(user._id) ? { ...l, items: (l.items || []).map(({ claimedBy, claimedName, ...i }) => i) } : l);

router.get('/settings/export', (req, res) => {
  res.render('settings/export', { active: 'settings' });
});

router.get('/settings/export/download', async (req, res, next) => {
  try {
    const h = req.household.toObject();
    const scope = visible(req.user);
    const own = { householdId: req.user.householdId };
    const [people, ...lists] = await Promise.all([
      membersOf(req.user.householdId, { fields: { email: 1 } }),
      ...SECTIONS.map(([, name, priv]) => require(`../models/${name}`).find(priv ? scope : own).lean()),
    ]);
    const activity = await require('../models/Activity').find({ ...own, $or: [{ private: false }, { actorId: req.user._id }] }, { actorName: 1, section: 1, text: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(2000).lean();
    const out = {
      nestlyExport: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: req.user.name,
      household: tidy({ ...h, _id: h._id }),
      people: people.map((p) => ({ name: p.name, email: p.email, role: roleName(req.household, p.role), memberSince: p.memberSince, turnedOff: Boolean(p.disabled) })),
      ...Object.fromEntries(SECTIONS.map(([key], i) => [key, lists[i].map(tidy).map((d) => (key === 'lists' ? surprise(d, req.user) : d))])),
      activity: activity.map(({ _id, ...a }) => a),
    };
    const day = new Date().toISOString().slice(0, 10);
    const slug = String(h.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'household';
    await logActivity(req.user, { section: 'Settings', text: `${req.user.name} downloaded the household’s data` });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nestly-${slug}-${day}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(out, null, 2));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
