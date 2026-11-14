const mongoose = require('mongoose');

// Money is stored in cents, so splits always add up exactly.
const shareSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    cents: { type: Number, required: true, min: 0 },
    percent: { type: Number, default: null }, // kept when split by percent, so edits show it
    settled: { type: Boolean, default: false }, // paid back to whoever paid the bill
    settledAt: { type: Date, default: null },
  },
  { _id: false }
);

const billSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    category: { type: String, default: 'Uncategorized' },
    cents: { type: Number, required: true, min: 0 },
    dueDate: { type: String, required: true }, // YYYY-MM-DD
    link: { type: String, trim: true, maxlength: 1000, default: '' }, // where to pay
    note: { type: String, trim: true, maxlength: 500, default: '' },
    // How it's split: evenly, exact amounts, or percentages. No shares means not split.
    splitMode: { type: String, enum: ['none', 'even', 'amount', 'percent'], default: 'even' },
    shares: { type: [shareSchema], default: [] },
    paid: { type: Boolean, default: false },
    paidOn: { type: String, default: '' }, // YYYY-MM-DD
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    paidByName: { type: String, default: '' },
    receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', default: null },
    seriesId: { type: mongoose.Schema.Types.ObjectId, ref: 'BillSeries', default: null },
  },
  { timestamps: true }
);
billSchema.index({ householdId: 1, paid: 1, dueDate: 1 });
// One bill per due date in a repeating series, even if two requests create it at once.
billSchema.index({ seriesId: 1, dueDate: 1 }, { unique: true, partialFilterExpression: { seriesId: { $type: 'objectId' } } });

module.exports = mongoose.model('Bill', billSchema);
