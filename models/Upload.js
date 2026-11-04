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
  },
  { timestamps: true }
);

module.exports = mongoose.model('Upload', uploadSchema);
