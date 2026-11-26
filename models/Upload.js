const mongoose = require('mongoose');

// A receipt or photo stored on the server's disk, outside public/.
const uploadSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    private: { type: Boolean, default: false },
    file: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, required: true },
    size: { type: Number, required: true },
    hash: { type: String, default: '' }, // sha256 of the file: the same picture saved twice is found and reused
  },
  { timestamps: true }
);
uploadSchema.index({ householdId: 1, hash: 1 });

module.exports = mongoose.model('Upload', uploadSchema);
