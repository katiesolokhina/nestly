const mongoose = require('mongoose');

const reminderSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    text: { type: String, required: true, trim: true, maxlength: 160 },
    details: { type: String, trim: true, maxlength: 1000, default: '' },
    date: { type: String, default: '' }, // YYYY-MM-DD or empty
    category: { type: String, default: 'Uncategorized' },
    done: { type: Boolean, default: false },
  },
  { timestamps: true }
);
reminderSchema.index({ householdId: 1, done: 1, date: 1 });

module.exports = mongoose.model('Reminder', reminderSchema);
