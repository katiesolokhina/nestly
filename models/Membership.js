const mongoose = require('mongoose');

// One person in one household. A person can belong to several households with one login;
// their role, whether they're turned off, and their layout are separate in each.
const membershipSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    disabled: { type: Boolean, default: false }, // turned off by an admin of this household
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Sections pinned to this person's bottom bar here (up to 3).
    pins: { type: [String], default: ['shopping', 'calendar'] },
    // This person's Today layout here, in order. Empty means the default.
    dashboard: { type: [{ _id: false, k: String, on: Boolean }], default: [] },
  },
  { timestamps: true }
);
membershipSchema.index({ userId: 1, householdId: 1 }, { unique: true });
membershipSchema.index({ householdId: 1 });

module.exports = mongoose.model('Membership', membershipSchema);
