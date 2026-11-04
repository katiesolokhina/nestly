// Prints a one-time password reset link. This is the way back in when the only admin is locked out.
// Usage: node scripts/reset-link.js --email=you@example.com
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const AccessToken = require('../models/AccessToken');

const found = process.argv.find((a) => a.startsWith('--email='));
const email = found ? found.slice(8).trim().toLowerCase() : '';

(async () => {
  if (!email) throw new Error('Pass --email=you@example.com');
  await connectDB(process.env.MONGODB_URI);
  const user = await User.findOne({ email });
  if (!user) throw new Error(`No account with email ${email}`);
  await AccessToken.deleteMany({ kind: 'reset', userId: user._id, usedAt: null });
  const { raw } = await AccessToken.issue({ kind: 'reset', householdId: user.householdId, userId: user._id, days: 1 });
  console.log(`${process.env.APP_ORIGIN}/reset/${raw}`);
  console.log('Works once, for 24 hours.');
})()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
