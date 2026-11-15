// Morning email: who gets it, what's in it, once a day, and nothing when there's nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startDatabase } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Membership = require('../models/Membership');
const Reminder = require('../models/Reminder');
const Chore = require('../models/Chore');
const RewardClaim = require('../models/RewardClaim');
const PushSubscription = require('../models/PushSubscription');
const NotifyLog = require('../models/NotifyLog');
const { digestTick } = require('../lib/digest');

test('morning email', async (t) => {
  const db = await startDatabase('nestly_test_digest');
  await mongoose.connect(db.uri);
  await mongoose.connection.db.dropDatabase();
  await NotifyLog.createIndexes();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  process.env.APP_ORIGIN = 'https://nestly.test';
  const tz = 'America/Chicago';
  const home = await Household.create({ name: 'Home', chorePoints: true });
  const lake = await Household.create({ name: 'Lake <house>' });
  const hash = await User.hashPassword('correct horse');
  const katie = await User.create({ householdId: home._id, email: 'k@t.dev', name: 'Katie', passwordHash: hash, timezone: tz });
  const sam = await User.create({ householdId: home._id, email: 's@t.dev', name: 'Sam', passwordHash: hash, timezone: tz });
  const mia = await User.create({ householdId: home._id, email: 'm@t.dev', name: 'Mia', passwordHash: hash, timezone: tz, notify: { email: 'off' } });
  await Membership.create({ userId: katie._id, householdId: home._id, role: 'admin' });
  await Membership.create({ userId: katie._id, householdId: lake._id, role: 'admin' });
  await Membership.create({ userId: sam._id, householdId: home._id, role: 'member' });
  await Membership.create({ userId: mia._id, householdId: home._id, role: 'child' });
  // Sam has notifications on a device, so by default no email.
  await PushSubscription.create({ userId: sam._id, endpoint: 'https://push.test/sam', keys: { p256dh: 'p', auth: 'a' } });
  await Reminder.create({ householdId: home._id, createdBy: katie._id, byName: 'Katie', text: 'Call the vet', date: '2026-11-16' });
  await Chore.create({ householdId: lake._id, byName: 'Katie', title: 'Close the shutters', date: '2026-11-14', repeat: 'none' });
  await RewardClaim.create({ householdId: home._id, userId: mia._id, byName: 'Mia', name: 'Pick dinner', cost: 20 });

  const mails = [];
  const send = async (m) => { mails.push(m); };
  // 7 AM: not anyone's morning yet.
  assert.equal(await digestTick(new Date('2026-11-16T07:00:00-06:00'), send), 0);
  // 8 AM: Katie (no device) gets one; Sam has a device; Mia turned it off.
  assert.equal(await digestTick(new Date('2026-11-16T08:00:00-06:00'), send), 1);
  assert.equal(mails.length, 1);
  const m = mails[0];
  assert.equal(m.to, 'k@t.dev');
  assert.equal(m.subject, 'Nestly: 3 things today');
  assert.match(m.text, /Reminder: Call the vet/);
  assert.match(m.text, /Chore: Close the shutters \(Overdue since/);
  assert.match(m.text, /Reward request: Mia wants Pick dinner/);
  assert.match(m.text, /LAKE <HOUSE>/);
  assert.match(m.html, /Lake &lt;house&gt;/, 'escaped in HTML');
  assert.match(m.text, /https:\/\/nestly\.test\/settings\/notifications/);
  // Once a day.
  assert.equal(await digestTick(new Date('2026-11-16T08:10:00-06:00'), send), 0);
  // Sam chooses "every morning".
  await User.updateOne({ _id: sam._id }, { $set: { 'notify.email': 'always' } });
  await NotifyLog.deleteMany({});
  mails.length = 0;
  await digestTick(new Date('2026-11-16T08:00:00-06:00'), send);
  assert.deepEqual(mails.map((x) => x.to).sort(), ['k@t.dev', 's@t.dev']);
  // Nothing to say: no email.
  await Reminder.deleteMany({});
  await Chore.deleteMany({});
  await RewardClaim.deleteMany({});
  await NotifyLog.deleteMany({});
  mails.length = 0;
  assert.equal(await digestTick(new Date('2026-11-16T08:00:00-06:00'), send), 0);
});
