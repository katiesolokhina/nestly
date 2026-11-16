const mongoose = require('mongoose');
const { titleCase } = require('../lib/titlecase');

// A chore: once, or repeating on a schedule (the same repeat options as Calendar events).
// Whether it's done comes from ChoreDone, so undoing a "done" puts it straight back.
const choreSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    // Chores are always shared. The field exists so "delete someone's private items" never matches one.
    private: { type: Boolean, default: false },
    title: { type: String, required: true, trim: true, maxlength: 120, set: titleCase },
    details: { type: String, trim: true, maxlength: 1000, default: '' },
    room: { type: String, default: 'Anywhere' },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null: anyone
    date: { type: String, required: true }, // YYYY-MM-DD: due date, or the first time it's due
    time: { type: String, default: '' }, // HH:MM to be reminded, or empty for the morning time
    repeat: { type: String, enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'], default: 'none' },
    interval: { type: Number, min: 1, max: 99, default: 1 },
    days: { type: [Number], default: [] }, // weekly: 0 = Sunday ... 6 = Saturday
    until: { type: String, default: '' },
    points: { type: Number, min: 0, max: 1000, default: 0 }, // only used when the household turns points on
  },
  { timestamps: true }
);
choreSchema.index({ householdId: 1 });

module.exports = mongoose.model('Chore', choreSchema);
