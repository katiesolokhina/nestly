const mongoose = require('mongoose');

// A repeating bill (rent, internet). Each time it's due, a bill is made from the latest details,
// including the last amount, which can then be changed for that time (like a utility bill).
const seriesSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    category: { type: String, default: 'Uncategorized' },
    cents: { type: Number, required: true, min: 0 },
    link: { type: String, default: '' },
    note: { type: String, default: '' },
    repeat: { type: String, enum: ['weekly', 'monthly', 'yearly'], required: true },
    interval: { type: Number, min: 1, max: 24, default: 1 },
    startDate: { type: String, required: true }, // first due date; sets the day of the month
    until: { type: String, default: '' },
    next: { type: String, required: true }, // the next due date not yet made into a bill
    splitMode: { type: String, enum: ['none', 'even', 'amount', 'percent'], default: 'even' },
    plan: { type: [{ _id: false, userId: mongoose.Schema.Types.ObjectId, name: String, cents: Number, percent: Number }], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
seriesSchema.index({ householdId: 1, active: 1 });

module.exports = mongoose.model('BillSeries', seriesSchema);
