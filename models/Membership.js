const mongoose = require('mongoose');

// One person in one household. A person can belong to several households with one login;
// their role, whether they're turned off, and their layout are separate in each.
const membershipSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    role: { type: String, default: 'member' }, // 'admin', or the key of one of the household's roles
    disabled: { type: Boolean, default: false }, // turned off by an admin of this household
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Sections pinned to this person's bottom bar here (up to 3).
    pins: { type: [String], default: ['shopping', 'calendar'] },
    // This person's Today layout here, in order. Empty means the default.
    dashboard: { type: [{ _id: false, k: String, on: Boolean }], default: [] },
    // On Today (Needs attention, Use soon): pantry things past their date. show | week (only the
    // last 7 days) | hide. Dates on packages are often "best by", so some people hide old ones.
    todayExpired: { type: String, enum: ['show', 'week', 'hide'], default: 'show' },
    // Calendar feed: a private link for Google/Apple Calendar. Only a hash of it is kept.
    feedHash: { type: String, default: null },
    feed: {
      events: { type: Boolean, default: true },
      reminders: { type: Boolean, default: true },
      bills: { type: Boolean, default: true },
      chores: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);
membershipSchema.index({ userId: 1, householdId: 1 }, { unique: true });
membershipSchema.index({ householdId: 1 });
membershipSchema.index({ feedHash: 1 }, { sparse: true });

module.exports = mongoose.model('Membership', membershipSchema);
