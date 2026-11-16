const mongoose = require('mongoose');
const { titleCase } = require('../lib/titlecase');

const reminderSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    text: { type: String, required: true, trim: true, maxlength: 160, set: titleCase },
    details: { type: String, trim: true, maxlength: 1000, default: '' },
    date: { type: String, default: '' }, // YYYY-MM-DD or empty
    time: { type: String, default: '' }, // HH:MM, or empty to notify at each person's morning time
    // Who gets a notification on the day: everyone, just the person who added it, chosen people, or nobody.
    notify: { type: String, enum: ['all', 'me', 'some', 'none'], default: 'all' },
    notifyTo: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] },
    // Personal snoozes: notify this one person again at `until`. Other people aren't affected.
    snoozes: { type: [{ _id: false, userId: mongoose.Schema.Types.ObjectId, until: Date }], default: [] },
    category: { type: String, default: 'Uncategorized' },
    done: { type: Boolean, default: false },
  },
  { timestamps: true }
);
reminderSchema.index({ householdId: 1, done: 1, date: 1 });

module.exports = mongoose.model('Reminder', reminderSchema);
