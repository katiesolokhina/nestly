const express = require('express');
const { requireAuth } = require('../middleware/auth');
const PushSubscription = require('../models/PushSubscription');
const { sendToUser, isPushConfigured } = require('../lib/push');

const router = express.Router();
router.use('/api/push', requireAuth);

// Public key the browser needs to turn notifications on.
router.get('/api/push/key', (req, res) => {
  if (!isPushConfigured()) return res.status(503).json({ error: 'Notifications are not set up on the server' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Saves this device. The same device again just updates, and moves to whoever is signed in.
router.post('/api/push/subscribe', async (req, res, next) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > 1000 || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    await PushSubscription.updateOne(
      { endpoint },
      { $set: { userId: req.user._id, keys: { p256dh: String(keys.p256dh).slice(0, 200), auth: String(keys.auth).slice(0, 100) }, userAgent: String(req.get('user-agent') || '').slice(0, 200) } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/api/push/unsubscribe', async (req, res, next) => {
  try {
    await PushSubscription.deleteOne({ endpoint: String((req.body || {}).endpoint || ''), userId: req.user._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// "Send a test" proves the whole chain works on this device.
router.post('/api/push/test', async (req, res, next) => {
  try {
    const sent = await sendToUser(req.user._id, { title: 'Nestly', body: 'Notifications are working.', url: '/settings#notifications', tag: 'nestly-test' });
    res.json({ sent });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
