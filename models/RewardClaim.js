const mongoose = require('mongoose');

// Someone spending chore points on a reward. Points come off when they ask; a declined
// request gives them back.
const rewardClaimSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    byName: { type: String, required: true },
    name: { type: String, required: true },
    cost: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['asked', 'given', 'declined'], default: 'asked' },
    decidedBy: { type: String, default: '' },
  },
  { timestamps: true }
);
rewardClaimSchema.index({ householdId: 1, status: 1 });

module.exports = mongoose.model('RewardClaim', rewardClaimSchema);
