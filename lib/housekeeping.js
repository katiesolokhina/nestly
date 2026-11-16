// Clearing old Activity for households that chose it (Settings → Activity).
const Activity = require('../models/Activity');
const Household = require('../models/Household');

const monthsAgo = (n, now = new Date()) => { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - n); return d; };

// One household, or every household that keeps a limited history.
async function pruneActivity(householdId = null, now = new Date()) {
  const homes = householdId
    ? await Household.find({ _id: householdId, activityKeepMonths: { $gt: 0 } }, { activityKeepMonths: 1 }).lean()
    : await Household.find({ activityKeepMonths: { $gt: 0 } }, { activityKeepMonths: 1 }).lean();
  let removed = 0;
  for (const h of homes) {
    const { deletedCount } = await Activity.deleteMany({ householdId: h._id, createdAt: { $lt: monthsAgo(h.activityKeepMonths, now) } });
    removed += deletedCount;
  }
  return removed;
}

// At startup, then every 6 hours.
function startHousekeeping() {
  const run = () => pruneActivity().catch((err) => console.error('Clearing old activity failed:', err.message));
  run();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}

module.exports = { pruneActivity, startHousekeeping, monthsAgo };
