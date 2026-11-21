const mongoose = require('mongoose');

// A bug report or feature idea from someone in a household, for whoever runs Nestly.
const feedbackSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    byName: { type: String, required: true },
    kind: { type: String, enum: ['bug', 'idea'], default: 'bug' },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
    page: { type: String, trim: true, maxlength: 300, default: '' }, // where they were when it happened
    device: { type: String, trim: true, maxlength: 300, default: '' }, // browser and phone, for bugs
    status: { type: String, enum: ['new', 'planned', 'done', 'no', 'archived'], default: 'new' },
    // How much it matters to the sender, and the real priority (set by whoever reviews it).
    theirPriority: { type: String, enum: ['', 'nice', 'important', 'blocking'], default: '' },
    priority: { type: String, enum: ['', 'low', 'medium', 'high', 'urgent'], default: '' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' }, // reviewer's own; the sender never sees them
    shots: { type: [mongoose.Schema.Types.ObjectId], ref: 'Upload', default: [] }, // screenshots, up to 3
    reply: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true }
);
feedbackSchema.index({ householdId: 1, createdAt: -1 });

module.exports = mongoose.model('Feedback', feedbackSchema);
