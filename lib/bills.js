// Money, splits, repeating bills, and who owes whom.
const Bill = require('../models/Bill');
const BillSeries = require('../models/BillSeries');
const { addDays, isDate } = require('./dates');

const AHEAD_DAYS = 31; // repeating bills appear this far before they're due

// "$1,234.50"
const money = (cents, symbol = '$') => `${symbol}${(Math.round(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// "12", "12.5", "$1,200.50" -> cents, or null if it isn't an amount.
function toCents(v) {
  const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  if (!/^\d{1,7}(\.\d{0,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
const centsInput = (cents) => (cents == null ? '' : (cents / 100).toFixed(2));

// Splits cents into n parts that add up exactly; leftover pennies go to the first people.
function evenly(cents, n) {
  if (!n) return [];
  const base = Math.floor(cents / n);
  return Array.from({ length: n }, (_, i) => base + (i < cents - base * n ? 1 : 0));
}

// Builds shares for a bill. people: [{ _id, name }], picked in order.
// mode 'even': even split; 'amount': amounts[id] in cents; 'percent': percents[id].
function buildShares(total, mode, people, { amounts = {}, percents = {} } = {}) {
  if (mode === 'none' || !people.length) return { shares: [] };
  if (mode === 'amount') {
    const shares = people.map((p) => ({ userId: p._id, name: p.name, cents: amounts[String(p._id)] ?? 0, percent: null }));
    const sum = shares.reduce((n, s) => n + s.cents, 0);
    if (sum !== total) return { error: `The amounts add up to ${money(sum)}, not ${money(total)}.` };
    return { shares };
  }
  if (mode === 'percent') {
    const pcts = people.map((p) => Number(percents[String(p._id)] || 0));
    const sum = Math.round(pcts.reduce((n, x) => n + x, 0) * 100) / 100;
    if (sum !== 100) return { error: `The percentages add up to ${sum}%, not 100%.` };
    // Round each share down, then hand out the leftover pennies, largest share first.
    const raw = pcts.map((p) => (total * p) / 100);
    const cents = raw.map(Math.floor);
    let left = total - cents.reduce((n, x) => n + x, 0);
    raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { cents[i] += 1; left -= 1; } });
    return { shares: people.map((p, i) => ({ userId: p._id, name: p.name, cents: cents[i], percent: pcts[i] })) };
  }
  const parts = evenly(total, people.length);
  return { shares: people.map((p, i) => ({ userId: p._id, name: p.name, cents: parts[i], percent: null })) };
}

// The due date after d. Monthly and yearly keep the original day, using the month's last day
// when it's shorter (rent due the 31st is due Feb 28).
function nextDue(series, d) {
  const n = series.interval || 1;
  if (series.repeat === 'weekly') return addDays(d, 7 * n);
  const day = Number(series.startDate.slice(8));
  const [y, m] = d.split('-').map(Number);
  const months = series.repeat === 'yearly' ? 12 * n : n;
  const total = (m - 1) + months;
  const ny = y + Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

// Shares for a new bill in a series: its saved split, applied to its current amount.
function seriesShares(series) {
  const people = series.plan.map((p) => ({ _id: p.userId, name: p.name }));
  if (series.splitMode === 'amount') {
    // Exact amounts only fit the amount they were set for; otherwise fall back to an even split.
    const sum = series.plan.reduce((n, p) => n + (p.cents || 0), 0);
    if (sum === series.cents) return buildShares(series.cents, 'amount', people, { amounts: Object.fromEntries(series.plan.map((p) => [String(p.userId), p.cents])) }).shares;
    return buildShares(series.cents, 'even', people).shares;
  }
  if (series.splitMode === 'percent') return buildShares(series.cents, 'percent', people, { percents: Object.fromEntries(series.plan.map((p) => [String(p.userId), p.percent])) }).shares || [];
  return buildShares(series.cents, series.splitMode, people).shares || [];
}

function billFromSeries(series, dueDate) {
  return {
    householdId: series.householdId, createdBy: series.createdBy, byName: series.byName, private: series.private,
    name: series.name, category: series.category, cents: series.cents, link: series.link, note: series.note,
    dueDate, splitMode: series.splitMode, shares: seriesShares(series), seriesId: series._id,
  };
}

// Makes the bills for repeating series that are due within the next month. Safe to run often.
async function ensureUpcoming(householdId, today) {
  // How far ahead is the household's choice (Settings, Bills); about a month by default.
  const home = await require('../models/Household').findById(householdId, { billAheadDays: 1 }).lean();
  const horizon = addDays(today, (home && home.billAheadDays) || AHEAD_DAYS);
  const series = await BillSeries.find({ householdId, active: true, next: { $lte: horizon } });
  for (const s of series) {
    let next = s.next;
    let guard = 0;
    while (next <= horizon && (!s.until || next <= s.until) && guard < 60) {
      try {
        await Bill.create(billFromSeries(s, next));
      } catch (err) {
        if (err.code !== 11000) throw err; // already made
      }
      next = nextDue(s, next);
      guard += 1;
    }
    // Only move forward from where this run found it, so two runs can't skip a bill.
    await BillSeries.updateOne({ _id: s._id, next: s.next }, { $set: { next, ...(s.until && next > s.until ? { active: false } : {}) } });
  }
}

// Who owes whom, from paid bills' unsettled shares. Returns pairs netted out:
// [{ from: {id,name}, to: {id,name}, cents, bills: [{ billId, name, cents, dir }] }]
function balances(bills) {
  const pairs = new Map();
  bills.filter((b) => b.paid && b.paidBy).forEach((b) => {
    b.shares.forEach((s) => {
      if (s.settled || !s.cents || String(s.userId) === String(b.paidBy)) return;
      const a = String(s.userId);
      const c = String(b.paidBy);
      const key = [a, c].sort().join(':');
      const p = pairs.get(key) || { ids: [a, c].sort(), names: {}, net: 0, bills: [] };
      p.names[a] = s.name;
      p.names[c] = b.paidByName;
      const sign = a === p.ids[0] ? 1 : -1; // positive: ids[0] owes ids[1]
      p.net += sign * s.cents;
      p.bills.push({ billId: b._id, name: b.name, dueDate: b.dueDate, cents: s.cents, from: a, to: c });
      pairs.set(key, p);
    });
  });
  return [...pairs.values()].filter((p) => p.net !== 0 || p.bills.length).map((p) => {
    const [x, y] = p.ids;
    const fromId = p.net >= 0 ? x : y;
    const toId = p.net >= 0 ? y : x;
    return { from: { id: fromId, name: p.names[fromId] }, to: { id: toId, name: p.names[toId] }, cents: Math.abs(p.net), bills: p.bills };
  }).filter((p) => p.cents > 0 || p.bills.length);
}

module.exports = { money, toCents, centsInput, evenly, buildShares, nextDue, ensureUpcoming, billFromSeries, balances, isDate, AHEAD_DAYS };
