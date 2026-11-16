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
    status: { type: String, enum: ['new', 'planned', 'done', 'no'], default: 'new' },
    reply: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true }
);
feedbackSchema.index({ householdId: 1, createdAt: -1 });

module.exports = mongoose.model('Feedback', feedbackSchema);
