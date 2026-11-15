// Who belongs to which household.
const Membership = require('../models/Membership');
const User = require('../models/User');
const Household = require('../models/Household');

// Accounts made before households could be shared kept their role and layout on the account.
// This copies them into a membership once. Safe to run any number of times.
async function ensureMemberships() {
  const missing = await User.aggregate([
    { $lookup: { from: 'memberships', let: { u: '$_id', h: '$householdId' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$userId', '$$u'] }, { $eq: ['$householdId', '$$h'] }] } } }, { $limit: 1 }], as: 'm' } },
    { $match: { m: { $size: 0 }, householdId: { $ne: null } } },
    { $project: { householdId: 1, role: 1, disabled: 1, pins: 1, dashboard: 1, invitedBy: 1 } },
  ]);
  if (!missing.length) return 0;
  await Membership.bulkWrite(missing.map((u) => ({
    updateOne: {
      filter: { userId: u._id, householdId: u.householdId },
      update: {
        $setOnInsert: {
          role: u.role === 'admin' ? 'admin' : 'member',
          disabled: Boolean(u.disabled),
          invitedBy: u.invitedBy || null,
          pins: Array.isArray(u.pins) ? u.pins : ['shopping', 'calendar'],
          dashboard: Array.isArray(u.dashboard) ? u.dashboard : [],
        },
      },
      upsert: true,
    },
  })));
  return missing.length;
}

// Households this person can use, oldest first, with their names.
async function homesOf(userId) {
  let ms = await Membership.find({ userId, disabled: false }).sort({ createdAt: 1 }).lean();
  // No memberships at all: maybe an older account (say, from a restored backup). Set it up and look again.
  if (!ms.length && !(await Membership.exists({ userId }))) {
    await ensureMemberships();
    ms = await Membership.find({ userId, disabled: false }).sort({ createdAt: 1 }).lean();
  }
  const homes = await Household.find({ _id: { $in: ms.map((m) => m.householdId) } }, { name: 1 }).lean();
  return ms.map((m) => ({ ...m, name: (homes.find((h) => String(h._id) === String(m.householdId)) || {}).name })).filter((m) => m.name);
}

// People in a household who aren't turned off, in the order they joined, with their role.
// fields: which User fields to include (always _id and name).
async function membersOf(householdId, { fields = {}, includeDisabled = false } = {}) {
  const ms = await Membership.find({ householdId, ...(includeDisabled ? {} : { disabled: false }) }).sort({ createdAt: 1 }).lean();
  const users = await User.find({ _id: { $in: ms.map((m) => m.userId) } }, { name: 1, ...fields }).lean();
  return ms
    .map((m) => {
      const u = users.find((x) => String(x._id) === String(m.userId));
      return u && { ...u, role: m.role, disabled: m.disabled, memberSince: m.createdAt };
    })
    .filter(Boolean);
}

const isMember = (userId, householdId) => Membership.exists({ userId, householdId, disabled: false });

// A notification's link that first switches to the household it's about.
const inHome = (householdId, url) => `/h/${householdId}?next=${encodeURIComponent(url || '/')}`;

module.exports = { ensureMemberships, homesOf, membersOf, isMember, inHome };
