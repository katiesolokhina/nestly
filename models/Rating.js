// One person's rating of one product (Buy again, Never again…). A product is its saved-item key,
// so a scanned barcode (remembered on its saved item) and a typed name share the same ratings.
const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true, index: true },
    key: { type: String, required: true, maxlength: 120 },
    itemName: { type: String, default: '', maxlength: 80 },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, default: '', maxlength: 60 },
    value: { type: String, required: true, maxlength: 24 },
  },
  { timestamps: true },
);
ratingSchema.index({ householdId: 1, key: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('Rating', ratingSchema);
