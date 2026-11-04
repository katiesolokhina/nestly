const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    date: { type: String, required: true }, // YYYY-MM-DD
    time: { type: String, default: '' }, // HH:MM or empty for all day
    repeat: { type: String, enum: ['none', 'yearly'], default: 'none' },
    category: { type: String, default: 'Uncategorized' },
    details: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true }
);
eventSchema.index({ householdId: 1, date: 1 });

module.exports = mongoose.model('Event', eventSchema);
