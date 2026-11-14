const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    date: { type: String, required: true }, // YYYY-MM-DD, the first (or only) day
    endDate: { type: String, default: '' }, // YYYY-MM-DD for multi-day events, else empty
    time: { type: String, default: '' }, // start time HH:MM; empty means all day
    endTime: { type: String, default: '' }, // HH:MM or empty
    location: { type: String, trim: true, maxlength: 200, default: '' },
    link: { type: String, trim: true, maxlength: 1000, default: '' },
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', default: null },
    repeat: { type: String, enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'], default: 'none' },
    interval: { type: Number, min: 1, max: 99, default: 1 }, // every N days/weeks/months/years
    days: { type: [Number], default: [] }, // weekly: 0 = Sunday ... 6 = Saturday
    until: { type: String, default: '' }, // last day it can repeat, or empty for forever
    category: { type: String, default: 'Uncategorized' },
    details: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true }
);
eventSchema.index({ householdId: 1, date: 1 });

module.exports = mongoose.model('Event', eventSchema);
