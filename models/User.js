const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    // The household this person last used. Which households they're in, and their role in each,
    // live in Membership.
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true, index: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    passwordHash: { type: String, required: true },
    // IANA zone; "today" is always computed in this zone, never in server time.
    timezone: { type: String, default: 'America/Chicago' },
    // Appearance: 'system' follows the device; 'light'/'dark' override it everywhere.
    theme: { type: String, enum: ['system', 'light', 'dark'], default: 'system' },
    // Before households could be shared these lived here. Now they're per household, in Membership;
    // these are only read once, to set up memberships for older accounts.
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    disabled: { type: Boolean, default: false },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    pins: { type: [String], default: ['shopping', 'calendar'] },
    dashboard: { type: [{ _id: false, k: String, on: Boolean }], default: [] },
    // What this person gets notified about. Turning notifications on happens per device.
    notify: {
      morning: { type: String, default: '08:00' }, // for reminders without a time and all-day events
      reminders: { type: Boolean, default: true },
      events: { type: Boolean, default: true },
      shopping: { type: Boolean, default: true }, // "Katie is shopping at Costco"
      // Bills: each person picks which of these they want.
      billsBefore: { type: Boolean, default: true },
      billsBeforeDays: { type: Number, min: 1, max: 14, default: 3 },
      billsDue: { type: Boolean, default: true },
      billsOverdue: { type: Boolean, default: true },
      billsPaid: { type: Boolean, default: true }, // someone paid a bill I share: here's my part
      billsPaidBack: { type: Boolean, default: true },
      billsWeekly: { type: Boolean, default: false }, // Sunday: what I still owe
      pantryExpiry: { type: Boolean, default: true },
      warranty: { type: Boolean, default: true },
      warrantyDays: { type: Number, min: 1, max: 120, default: 30 },
      pantryExpiryDays: { type: Number, min: 0, max: 14, default: 2 },
      // Morning email: 'off', 'nopush' (only with no device set up for notifications), or 'always'.
      email: { type: String, enum: ['off', 'nopush', 'always'], default: 'nopush' },
      chores: { type: Boolean, default: true }, // a chore of mine (or anyone's) is due today
      choresLate: { type: Boolean, default: true }, // the next morning, if it still isn't done
    },
    lastTripAlertAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.statics.hashPassword = function (plain) {
  return bcrypt.hash(plain, 12);
};

module.exports = mongoose.model('User', userSchema);
