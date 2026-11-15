const mongoose = require('mongoose');

// One time a chore was done. "date" is which due date it counts for, so a missed daily chore
// done today catches up instead of piling up.
const choreDoneSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    choreId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chore', required: true },
    title: { type: String, required: true }, // kept, so the history reads right after a chore is deleted
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    byName: { type: String, required: true },
    date: { type: String, required: true },
    points: { type: Number, default: 0 }, // earned, if points are on and this person's role earns them
  },
  { timestamps: true }
);
choreDoneSchema.index({ householdId: 1, choreId: 1, date: -1 });
choreDoneSchema.index({ householdId: 1, userId: 1 });

module.exports = mongoose.model('ChoreDone', choreDoneSchema);
