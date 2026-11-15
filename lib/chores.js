// When chores are due, and chore points.
const mongoose = require('mongoose');
const Chore = require('../models/Chore');
const ChoreDone = require('../models/ChoreDone');
const RewardClaim = require('../models/RewardClaim');
const { occursOn } = require('./recurrence');
const { addDays, dayLabel, time12 } = require('./dates');

// Aggregations don't convert ids the way find() does, and the notifier passes them as strings.
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const LOOK = 400; // a little over a year, enough for yearly chores

// The first day on or after `from` that the chore is due, or null if it never is again.
function nextDue(c, from) {
  let d = from < c.date ? c.date : from;
  for (let i = 0; i < LOOK; i += 1) {
    if (c.until && d > c.until) return null;
    if (occursOn(c, d)) return d;
    if (c.repeat === 'none') return null;
    d = addDays(d, 1);
  }
  return null;
}

// The last day on or before `day` that the chore was due.
function lastDue(c, day) {
  let d = c.until && day > c.until ? c.until : day;
  for (let i = 0; i < LOOK && d >= c.date; i += 1) {
    if (occursOn(c, d)) return d;
    d = addDays(d, -1);
  }
  return null;
}

// What's due now: the first due day after the last time it was done.
const dueOf = (c, lastDone) => nextDue(c, lastDone ? addDays(lastDone, 1) : c.date);

// Which due day a "done" right now counts for. Late: the latest one (missed ones don't pile up).
// Early: the next one.
function doneFor(c, lastDone, today) {
  const due = dueOf(c, lastDone);
  if (!due) return null;
  return due <= today ? lastDue(c, today) || due : due;
}

// The last done day for each chore.
async function lastDoneMap(householdId, choreIds) {
  const rows = await ChoreDone.aggregate([
    { $match: { householdId: oid(householdId), ...(choreIds ? { choreId: { $in: choreIds.map(oid) } } : {}) } },
    { $group: { _id: '$choreId', last: { $max: '$date' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.last]));
}

// Every chore with its due day (null when there's nothing left to do).
async function choresWithDue(householdId, filter = {}) {
  const chores = await Chore.find({ householdId, ...filter }).lean();
  const last = await lastDoneMap(householdId, chores.map((c) => c._id));
  return chores.map((c) => ({ ...c, lastDone: last.get(String(c._id)) || null, due: dueOf(c, last.get(String(c._id))) }));
}

// Assigned to someone who isn't in the household anymore means anyone can do it.
const assigneeOf = (c, members) => (c.assignee && members.find((m) => String(m._id) === String(c.assignee))) || null;
const isFor = (c, userId, members) => { const a = assigneeOf(c, members); return !a || String(a._id) === String(userId); };

function dueText(c, today) {
  if (!c.due) return 'Done';
  if (c.due < today) return `Overdue since ${dayLabel(c.due, today).replace(/^Yesterday$/, 'yesterday')}`;
  if (c.due === today) return c.time ? `Due today by ${time12(c.time)}` : 'Due today';
  return `Due ${dayLabel(c.due, today).replace(/^Tomorrow$/, 'tomorrow')}`;
}

// ---------- Points ----------
const pointsOn = (h) => Boolean(h.chorePoints);
const earns = (h, role) => pointsOn(h) && (h.choreEarners || []).includes(role);

// Points each person has: earned, minus what's been spent (declined requests give them back).
async function balances(householdId) {
  const [earned, spent] = await Promise.all([
    ChoreDone.aggregate([{ $match: { householdId: oid(householdId), points: { $gt: 0 } } }, { $group: { _id: '$userId', n: { $sum: '$points' } } }]),
    RewardClaim.aggregate([{ $match: { householdId: oid(householdId), status: { $ne: 'declined' } } }, { $group: { _id: '$userId', n: { $sum: '$cost' } } }]),
  ]);
  const out = new Map();
  earned.forEach((r) => out.set(String(r._id), { earned: r.n, spent: 0 }));
  spent.forEach((r) => out.set(String(r._id), { earned: 0, ...(out.get(String(r._id)) || {}), spent: r.n }));
  return out;
}

module.exports = { nextDue, lastDue, dueOf, doneFor, lastDoneMap, choresWithDue, assigneeOf, isFor, dueText, pointsOn, earns, balances };
