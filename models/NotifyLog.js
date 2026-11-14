const mongoose = require('mongoose');

// One row per notification sent to one person. The unique index means a reminder or event alert
// goes out once, even if two ticks overlap or the app restarts. Rows clear themselves after 14 days.
const notifyLogSchema = new mongoose.Schema({
  key: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 14 },
});
notifyLogSchema.index({ key: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('NotifyLog', notifyLogSchema);
