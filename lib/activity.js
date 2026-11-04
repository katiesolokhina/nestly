const Activity = require('../models/Activity');

// Records a change. Later sections send every create, edit, and delete through this.
function logActivity(user, { section, text, private: isPrivate = false }) {
  return Activity.create({
    householdId: user.householdId,
    actorId: user._id,
    actorName: user.name,
    section,
    text,
    private: isPrivate,
  });
}

// Other people's private entries never leave the database.
function visibleActivity(user) {
  return {
    householdId: user.householdId,
    $or: [{ private: false }, { actorId: user._id }],
  };
}

module.exports = { logActivity, visibleActivity };
