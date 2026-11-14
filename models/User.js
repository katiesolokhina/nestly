const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true, index: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    passwordHash: { type: String, required: true },
    // IANA zone; "today" is always computed in this zone, never in server time.
    timezone: { type: String, default: 'America/Chicago' },
    // Appearance: 'system' follows the device; 'light'/'dark' override it everywhere.
    theme: { type: String, enum: ['system', 'light', 'dark'], default: 'system' },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    // Disabled accounts can't sign in; their data is kept until deleted.
    disabled: { type: Boolean, default: false },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Sections pinned to this person's bottom bar (up to 3).
    pins: { type: [String], default: ['shopping', 'calendar'] },
    // This person's Today layout, in order. Empty means the default.
    dashboard: { type: [{ _id: false, k: String, on: Boolean }], default: [] },
    // What this person gets notified about. Turning notifications on happens per device.
    notify: {
      morning: { type: String, default: '08:00' }, // for reminders without a time and all-day events
      reminders: { type: Boolean, default: true },
      events: { type: Boolean, default: true },
      shopping: { type: Boolean, default: true }, // "Katie is shopping at Costco"
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
