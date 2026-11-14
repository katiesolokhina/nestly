const mongoose = require('mongoose');

// One row per phone or browser that turned on notifications.
const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: String,
  },
  { timestamps: true }
);

pushSubscriptionSchema.methods.toWebPush = function () {
  return { endpoint: this.endpoint, keys: { p256dh: this.keys.p256dh, auth: this.keys.auth } };
};

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
