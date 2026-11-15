// Creates a household and its first admin. Asks for the password so it never lands in shell history.
// Usage: node scripts/create-household.js --household="Our home" --name=Katie --email=you@example.com
require('dotenv').config({ quiet: true });
const readline = require('node:readline/promises');
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Household = require('../models/Household');
const User = require('../models/User');
const Membership = require('../models/Membership');

const arg = (name) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3).trim() : '';
};

(async () => {
  const name = arg('name');
  const email = arg('email').toLowerCase();
  const householdName = arg('household') || 'Our home';
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Pass --name=Katie --email=you@example.com');

  await connectDB(process.env.MONGODB_URI);
  const existing = await User.findOne({ email });
  if (existing) {
    // Already uses Nestly: they become the new household's admin with the same sign-in.
    const household = await Household.create({ name: householdName });
    await Membership.create({ userId: existing._id, householdId: household._id, role: 'admin' });
    console.log(`Created "${householdName}". ${email} already had an account and is its admin; they can switch to it from Households.`);
    return;
  }

  let password = process.env.NESTLY_ADMIN_PASSWORD || '';
  if (!password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question('Password (at least 8 characters): ');
    rl.close();
  }
  if (password.length < 8) throw new Error('Use at least 8 characters.');

  const household = await Household.create({ name: householdName });
  const user = await User.create({ householdId: household._id, email, name, passwordHash: await User.hashPassword(password) });
  await Membership.create({ userId: user._id, householdId: household._id, role: 'admin' });
  console.log(`Created "${householdName}" with admin ${email}.`);
})()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
