const mongoose = require('mongoose');

// The household's change log. Entries are never edited. The name is copied onto each
// entry so history still reads correctly after someone's account is deleted.
const activitySchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorName: { type: String, required: true },
    section: { type: String, required: true },
    text: { type: String, required: true },
    // Private entries are visible only to the person who made them.
    private: { type: Boolean, default: false },
    // What's needed to undo this change: { kind, model, docId, before, afterAt, label }.
    undo: { type: mongoose.Schema.Types.Mixed, default: null },
    undoneAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

activitySchema.index({ householdId: 1, createdAt: -1 });

module.exports = mongoose.model('Activity', activitySchema);
