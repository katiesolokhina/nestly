const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const Bill = require('../models/Bill');
const BillSeries = require('../models/BillSeries');
const User = require('../models/User');
const Upload = require('../models/Upload');
const { recordChange, visible } = require('../lib/changes');
const { logActivity } = require('../lib/activity');
const { pick } = require('../lib/lists');
const { currency } = require('../lib/prefs');
const { parseFiles, saveUpload } = require('../lib/uploads');
const { sendToUser } = require('../lib/push');
const Membership = require('../models/Membership');
const { membersOf: householdMembers, inHome } = require('../lib/members');
const { todayIn, addDays, isDate, dayLabel, shortDay } = require('../lib/dates');
const { money, toCents, centsInput, buildShares, nextDue, ensureUpcoming, balances } = require('../lib/bills');

const router = express.Router();
router.use('/s/bills', requireAuth, requireSection('bills'), (req, res, next) => {
  // Amounts in the household's currency.
  req.money = (cents) => money(cents, currency(req.household));
  next();
});
const SECTION = 'Bills';
const REPEATS = ['none', 'weekly', 'monthly', 'yearly'];
const MODES = ['none', 'even', 'amount', 'percent'];
const withReceipt = parseFiles(['receipt']);
const isHttp = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };
const ids = (v) => [].concat(v == null ? [] : v).map(String);
const same = (a, b) => String(a) === String(b);

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Bill.findOne({ _id: req.params.id, ...visible(req.user) });
}

const membersOf = (req) => householdMembers(req.user.householdId, { fields: { notify: 1 } });

// "Due today", "Due tomorrow", "Overdue since Mon, Nov 9", "Paid Nov 2 by Sam".
function status(b, today) {
  if (b.paid) return { text: `Paid ${shortDay(b.paidOn || b.dueDate).replace(/, \d{4}$/, '')}${b.paidByName ? ` by ${b.paidByName}` : ''}`, tone: 'paid' };
  if (b.dueDate < today) return { text: `Overdue since ${dayLabel(b.dueDate, today)}`, tone: 'late' };
  if (b.dueDate === today) return { text: 'Due today', tone: 'soon' };
  return { text: `Due ${dayLabel(b.dueDate, today)}`, tone: b.dueDate <= addDays(today, 7) ? 'soon' : '' };
}

function myShare(b, user) {
  const s = b.shares.find((x) => same(x.userId, user._id));
  return s ? s.cents : null;
}

// ---------- Reading the form ----------
async function readForm(req, { forSeries = true } = {}) {
  const b = req.body || {};
  const members = await membersOf(req);
  const cents = toCents(b.amount);
  const isPrivate = b.private === 'on';
  const repeat = REPEATS.includes(b.repeat) ? b.repeat : 'none';
  let splitMode = MODES.includes(b.splitMode) ? b.splitMode : 'even';
  if (isPrivate) splitMode = 'none'; // only you can see it, so nobody else can share it
  const picked = new Set(ids(b.people));
  const people = members.filter((m) => picked.has(String(m._id)));
  const values = {
    name: String(b.name || '').trim().slice(0, 80),
    category: pick(req.household, 'billCats', b.category),
    cents: cents == null ? 0 : cents,
    dueDate: isDate(b.dueDate) ? b.dueDate : '',
    link: String(b.link || '').trim().slice(0, 1000),
    note: String(b.note || '').trim().slice(0, 500),
    private: isPrivate,
    splitMode,
  };
  const repeatValues = { repeat, interval: Math.min(24, Math.max(1, parseInt(b.interval, 10) || 1)), until: repeat !== 'none' && isDate(b.until) ? b.until : '' };
  let error = req.uploadError || null;
  if (!values.name) error = 'Enter what the bill is for.';
  else if (cents == null) error = 'Enter the amount, like 85.50.';
  else if (!values.dueDate) error = 'Choose the due date.';
  else if (values.link && !isHttp(values.link)) error = 'Enter a full link that starts with https://';
  else if (repeatValues.until && repeatValues.until < values.dueDate) error = 'Repeat until must be on or after the due date.';
  else if (splitMode !== 'none' && !people.length) error = 'Pick who shares this bill, or choose Not split.';
  let shares = [];
  if (!error && splitMode !== 'none') {
    const amounts = {};
    const percents = {};
    for (const p of people) {
      const id = String(p._id);
      if (splitMode === 'amount') {
        const c = toCents(b[`amt_${id}`]);
        if (c == null) { error = `Enter ${p.name}’s amount.`; break; }
        amounts[id] = c;
      } else if (splitMode === 'percent') {
        const pct = Number(String(b[`pct_${id}`] || '').replace('%', ''));
        if (!(pct >= 0 && pct <= 100)) { error = `Enter ${p.name}’s percentage.`; break; }
        percents[id] = pct;
      }
    }
    if (!error) {
      const built = buildShares(values.cents, splitMode, people, { amounts, percents });
      if (built.error) error = built.error;
      else shares = built.shares;
    }
  }
  return { values: { ...values, shares }, repeatValues, error, members, forSeries };
}

async function formView(req, item, error, extra = {}) {
  const [members, receipt, series] = await Promise.all([
    membersOf(req),
    item.receiptId ? Upload.findById(item.receiptId).lean() : null,
    item.seriesId ? BillSeries.findOne({ _id: item.seriesId, householdId: req.user.householdId }).lean() : null,
  ]);
  return { active: 'bills', item, error: error || null, members, receipt, series, centsInput, money: req.money, ...extra };
}

const blank = (req, members) => ({
  _id: null, name: '', category: 'Uncategorized', cents: null, dueDate: todayIn(req.user.timezone), link: '', note: '', private: false,
  splitMode: req.household.billSplit === 'none' ? 'none' : 'even',
  shares: req.household.billSplit === 'none' ? [] : members.map((m) => ({ userId: m._id, name: m.name, cents: 0 })), seriesId: null,
  repeat: 'none', interval: 1, until: '',
});

// When someone pays a bill, the people sharing it hear what their part is.
async function tellShares(req, bill) {
  const people = await User.find({ _id: { $in: bill.shares.map((s) => s.userId) }, disabled: { $ne: true } }, { notify: 1 }).lean();
  await Promise.all(bill.shares.filter((s) => !same(s.userId, bill.paidBy) && s.cents && !s.settled).map((s) => {
    const u = people.find((p) => same(p._id, s.userId));
    if (!u || (u.notify && u.notify.billsPaid === false)) return null;
    return sendToUser(s.userId, { title: `${bill.paidByName} paid ${bill.name}`, body: `${req.money(bill.cents)} total. Your share: ${req.money(s.cents)}.`, url: inHome(req.user.householdId, `/s/bills/${bill._id}`), tag: `bill-paid-${bill._id}` });
  }));
}

// ---------- Lists ----------
router.get('/s/bills', async (req, res, next) => {
  try {
    const today = todayIn(req.user.timezone);
    await ensureUpcoming(req.user.householdId, today);
    const tab = req.query.tab === 'paid' ? 'paid' : 'upcoming';
    const category = [...req.household.billCats, 'Uncategorized'].includes(req.query.category) ? req.query.category : '';
    const scope = { ...visible(req.user), ...(category ? { category } : {}) };
    const rows = tab === 'paid'
      ? await Bill.find({ ...scope, paid: true }).sort({ paidOn: -1, dueDate: -1 }).limit(200).lean()
      : await Bill.find({ ...scope, paid: false }).sort({ dueDate: 1 }).lean();
    const owed = balances(await Bill.find({ ...visible(req.user), paid: true, 'shares.settled': false }).lean());
    const me = req.user.id;
    const mine = owed.filter((p) => p.from.id === me || p.to.id === me);
    const dueSoon = rows.filter((b) => !b.paid && b.dueDate <= addDays(today, 30));
    res.render('bills/list', {
      active: 'bills', tab, category, money: req.money,
      items: rows.map((b) => ({ ...b, status: status(b, today), mine: myShare(b, req.user), repeats: Boolean(b.seriesId) })),
      dueTotal: req.money(dueSoon.reduce((n, b) => n + b.cents, 0)),
      dueCount: dueSoon.length,
      mine: mine.map((p) => ({ text: p.from.id === me ? `You owe ${p.to.name} ${req.money(p.cents)}` : `${p.from.name} owes you ${req.money(p.cents)}`, owe: p.from.id === me })),
      othersOwing: owed.length - mine.length,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/s/bills/balances', async (req, res, next) => {
  try {
    const owed = balances(await Bill.find({ ...visible(req.user), paid: true, 'shares.settled': false }).lean());
    const me = req.user.id;
    const today = todayIn(req.user.timezone);
    res.render('bills/balances', {
      active: 'bills', money: req.money,
      pairs: owed.map((p) => ({
        ...p,
        text: p.from.id === me ? `You owe ${p.to.name}` : p.to.id === me ? `${p.from.name} owes you` : `${p.from.name} owes ${p.to.name}`,
        other: p.from.id === me ? p.to : p.from.id === me || p.to.id === me ? p.from : null,
        canSettle: p.from.id === me || p.to.id === me || req.member.role === 'admin',
        bills: p.bills.map((b) => ({ ...b, line: `${b.name}, ${shortDay(b.dueDate).replace(/, \d{4}$/, '')}`, dir: b.from === p.from.id ? 'owes' : 'credit' })),
      })).sort((a, b) => (b.canSettle - a.canSettle) || b.cents - a.cents),
      today,
    });
  } catch (err) {
    next(err);
  }
});

// Settle up: marks every unsettled share between two people as paid back.
router.post('/s/bills/settle', async (req, res, next) => {
  try {
    const a = String(req.body.from || '');
    const c = String(req.body.to || '');
    if (!mongoose.isValidObjectId(a) || !mongoose.isValidObjectId(c)) return res.redirect('/s/bills/balances');
    if (![a, c].includes(req.user.id) && req.member.role !== 'admin') return res.status(404).send('Not found');
    if ((await Membership.countDocuments({ userId: { $in: [a, c] }, householdId: req.user.householdId })) !== 2) return res.status(404).send('Not found');
    const bills = await Bill.find({ ...visible(req.user), paid: true, 'shares.settled': false, paidBy: { $in: [a, c] } });
    let cents = 0;
    let count = 0;
    const now = new Date();
    for (const b of bills) {
      let changed = false;
      b.shares.forEach((s) => {
        const between = (same(s.userId, a) && same(b.paidBy, c)) || (same(s.userId, c) && same(b.paidBy, a));
        if (between && !s.settled) { s.settled = true; s.settledAt = now; cents += same(s.userId, a) ? s.cents : -s.cents; changed = true; }
      });
      if (changed) { await b.save(); count += 1; }
    }
    if (count) {
      const names = Object.fromEntries((await User.find({ _id: { $in: [a, c] } }, { name: 1 }).lean()).map((u) => [String(u._id), u.name]));
      const [payer, payee] = cents >= 0 ? [a, c] : [c, a];
      await logActivity(req.user, { section: SECTION, text: `${req.user.name} settled up: ${names[payer]} paid ${names[payee]} ${req.money(Math.abs(cents))} (${count} ${count === 1 ? 'bill' : 'bills'})` });
      const other = payer === req.user.id ? payee : payer;
      const u = await User.findById(other, { notify: 1 }).lean();
      if (u && other !== req.user.id && !(u.notify && u.notify.billsPaidBack === false)) {
        await sendToUser(other, { title: 'Settled up', body: `${req.user.name} marked it settled: ${names[payer]} paid ${names[payee]} back ${req.money(Math.abs(cents))}.`, url: inHome(req.user.householdId, '/s/bills/balances'), tag: 'bills-settled' });
      }
      req.session.flash = `Settled up: ${req.money(Math.abs(cents))}.`;
    }
    res.redirect('/s/bills/balances');
  } catch (err) {
    next(err);
  }
});

// ---------- Add ----------
router.get('/s/bills/new', async (req, res, next) => {
  try {
    const members = await membersOf(req);
    res.render('bills/form', await formView(req, blank(req, members)));
  } catch (err) {
    next(err);
  }
});

router.post('/s/bills', withReceipt, async (req, res, next) => {
  try {
    const { values, repeatValues, error } = await readForm(req);
    if (error) return res.status(422).render('bills/form', await formView(req, { ...values, ...repeatValues, _id: null, seriesId: null }, error));
    const bill = new Bill({ ...values, householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name });
    if (repeatValues.repeat !== 'none') {
      const series = await BillSeries.create({
        householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name, private: values.private,
        name: values.name, category: values.category, cents: values.cents, link: values.link, note: values.note,
        repeat: repeatValues.repeat, interval: repeatValues.interval, until: repeatValues.until, startDate: values.dueDate,
        splitMode: values.splitMode, plan: values.shares.map((s) => ({ userId: s.userId, name: s.name, cents: s.cents, percent: s.percent })),
        next: '0000-00-00',
      });
      series.next = nextDue(series, values.dueDate);
      await series.save();
      bill.seriesId = series._id;
    }
    const f = (req.files || {}).receipt;
    if (f) {
      try {
        bill.receiptId = (await saveUpload(req.user, f[0], { isPrivate: bill.private }))._id;
      } catch (e) {
        if (!e.userFacing) throw e;
        return res.status(422).render('bills/form', await formView(req, { ...values, ...repeatValues, _id: null, seriesId: null }, e.message));
      }
    }
    await bill.save();
    await recordChange(req, { kind: 'create', model: 'Bill', doc: bill, section: SECTION, text: `added the bill ${bill.name} (${req.money(bill.cents)}, due ${shortDay(bill.dueDate).replace(/, \d{4}$/, '')})`, label: bill.name });
    res.redirect(`/s/bills/${bill._id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- One bill ----------
router.get('/s/bills/:id', async (req, res, next) => {
  try {
    const bill = await find(req);
    if (!bill) return res.status(404).send('Not found');
    const today = todayIn(req.user.timezone);
    const [members, receipt, series] = await Promise.all([
      membersOf(req),
      bill.receiptId ? Upload.findById(bill.receiptId).lean() : null,
      bill.seriesId ? BillSeries.findOne({ _id: bill.seriesId, householdId: req.user.householdId }).lean() : null,
    ]);
    const history = series ? await Bill.find({ ...visible(req.user), seriesId: series._id, _id: { $ne: bill._id } }).sort({ dueDate: -1 }).limit(12).lean() : [];
    const repeatText = series && series.active ? `Repeats ${series.interval > 1 ? `every ${series.interval} ` : ''}${{ weekly: series.interval > 1 ? 'weeks' : 'weekly', monthly: series.interval > 1 ? 'months' : 'monthly', yearly: series.interval > 1 ? 'years' : 'yearly' }[series.repeat]}${series.until ? ` until ${shortDay(series.until)}` : ''}` : '';
    res.render('bills/show', {
      active: 'bills', bill, members, receipt, series, history, repeatText, today, money: req.money,
      status: status(bill, today),
      historyRows: history.map((h) => ({ ...h, status: status(h, today) })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/s/bills/:id/edit', async (req, res, next) => {
  try {
    const bill = await find(req);
    if (!bill) return res.status(404).send('Not found');
    const series = bill.seriesId ? await BillSeries.findById(bill.seriesId).lean() : null;
    res.render('bills/form', await formView(req, { ...bill.toObject(), repeat: series && series.active ? series.repeat : 'none', interval: series ? series.interval : 1, until: series ? series.until : '' }));
  } catch (err) {
    next(err);
  }
});

router.post('/s/bills/:id', withReceipt, async (req, res, next) => {
  try {
    const bill = await find(req);
    if (!bill) return res.status(404).send('Not found');
    const { values, repeatValues, error } = await readForm(req);
    if (error) return res.status(422).render('bills/form', await formView(req, { ...bill.toObject(), ...values, ...repeatValues }, error));
    const before = bill.toObject();
    if (!same(bill.createdBy, req.user._id)) values.private = bill.private;
    // Keep who has already paid back when the split stays the same.
    values.shares = values.shares.map((s) => {
      const old = bill.shares.find((o) => same(o.userId, s.userId));
      return old && old.cents === s.cents ? { ...s, settled: old.settled, settledAt: old.settledAt } : { ...s, settled: bill.paid && same(s.userId, bill.paidBy), settledAt: null };
    });
    bill.set(values);
    if ((req.body || {}).removeReceipt === 'on') bill.receiptId = null;
    const f = (req.files || {}).receipt;
    if (f) {
      try {
        bill.receiptId = (await saveUpload(req.user, f[0], { isPrivate: bill.private }))._id;
      } catch (e) {
        if (!e.userFacing) throw e;
        return res.status(422).render('bills/form', await formView(req, { ...before, ...values, ...repeatValues }, e.message));
      }
    }
    // Repeating: changes can carry to the bills still to come.
    if (bill.seriesId) {
      const series = await BillSeries.findOne({ _id: bill.seriesId, householdId: req.user.householdId });
      if (series && req.body.applyFuture === 'on') {
        series.set({
          name: values.name, category: values.category, cents: values.cents, link: values.link, note: values.note, private: values.private,
          splitMode: values.splitMode, plan: values.shares.map((s) => ({ userId: s.userId, name: s.name, cents: s.cents, percent: s.percent })),
        });
        if (repeatValues.repeat === 'none') series.active = false;
        else series.set({ repeat: repeatValues.repeat, interval: repeatValues.interval, until: repeatValues.until });
        await series.save();
      }
    } else if (repeatValues.repeat !== 'none') {
      const series = await BillSeries.create({
        householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name, private: values.private,
        name: values.name, category: values.category, cents: values.cents, link: values.link, note: values.note,
        repeat: repeatValues.repeat, interval: repeatValues.interval, until: repeatValues.until, startDate: values.dueDate,
        splitMode: values.splitMode, plan: values.shares.map((s) => ({ userId: s.userId, name: s.name, cents: s.cents, percent: s.percent })), next: '0000-00-00',
      });
      series.next = nextDue(series, values.dueDate);
      await series.save();
      bill.seriesId = series._id;
    }
    await bill.save();
    await recordChange(req, { kind: 'update', model: 'Bill', doc: bill, before, section: SECTION, text: `edited the bill ${bill.name}`, label: bill.name });
    res.redirect(`/s/bills/${bill._id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/s/bills/:id/paid', withReceipt, async (req, res, next) => {
  try {
    const bill = await find(req);
    if (!bill) return res.status(404).send('Not found');
    const members = await membersOf(req);
    const payer = members.find((m) => same(m._id, req.body.paidBy)) || members.find((m) => same(m._id, req.user._id));
    const before = bill.toObject();
    bill.paid = true;
    bill.paidOn = isDate(req.body.paidOn) ? req.body.paidOn : todayIn(req.user.timezone);
    bill.paidBy = payer._id;
    bill.paidByName = payer.name;
    // Whoever paid doesn't owe themselves.
    bill.shares.forEach((s) => { if (same(s.userId, payer._id)) { s.settled = true; s.settledAt = new Date(); } });
    const f = (req.files || {}).receipt;
    if (f) {
      try {
        bill.receiptId = (await saveUpload(req.user, f[0], { isPrivate: bill.private }))._id;
      } catch (e) {
        if (!e.userFacing) throw e;
        req.session.flash = e.message;
        return res.redirect(`/s/bills/${bill._id}`);
      }
    }
    await bill.save();
    // Next time this repeating bill comes, it starts from this amount.
    if (bill.seriesId) await BillSeries.updateOne({ _id: bill.seriesId, householdId: req.user.householdId }, { $set: { cents: bill.cents } });
    await recordChange(req, { kind: 'update', model: 'Bill', doc: bill, before, section: SECTION, text: `marked ${bill.name} (${req.money(bill.cents)}) paid${same(payer._id, req.user._id) ? '' : ` by ${payer.name}`}`, label: bill.name });
    await tellShares(req, bill);
    res.redirect(`/s/bills/${bill._id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/s/bills/:id/unpaid', async (req, res, next) => {
  try {
    const bill = await find(req);
    if (!bill) return res.status(404).send('Not found');
    const before = bill.toObject();
    bill.set({ paid: false, paidOn: '', paidBy: null, paidByName: '' });
    bill.shares.forEach((s) => { s.settled = false; s.settledAt = null; });
    await bill.save();
    await recordChange(req, { kind: 'update', model: 'Bill', doc: bill, before, section: SECTION, text: `marked ${bill.name} not paid`, label: bill.name });
    res.redirect(`/s/bills/${bill._id}`);
  } catch (err) {
    next(err);
  }
});

// One person's share: paid back, or not yet.
router.post('/s/bills/:id/share', async (req, res, next) => {
  try {
    const bill = await find(req);
    if (!bill) return res.status(404).send('Not found');
    const share = bill.shares.find((s) => same(s.userId, req.body.userId));
    if (!share || !bill.paid || same(share.userId, bill.paidBy)) return res.redirect(`/s/bills/${bill._id}`);
    const before = bill.toObject();
    share.settled = req.body.settled === '1';
    share.settledAt = share.settled ? new Date() : null;
    await bill.save();
    const text = share.settled ? `marked ${share.name}’s ${req.money(share.cents)} for ${bill.name} as paid back` : `marked ${share.name}’s ${req.money(share.cents)} for ${bill.name} as not paid back`;
    await recordChange(req, { kind: 'update', model: 'Bill', doc: bill, before, section: SECTION, text, label: bill.name });
    if (share.settled) {
      // Tell the other person: the payer if the person who owed marked it, and the other way round.
      const other = same(req.user._id, share.userId) ? bill.paidBy : same(req.user._id, bill.paidBy) ? share.userId : null;
      const u = other ? await User.findById(other, { notify: 1 }).lean() : null;
      if (u && !(u.notify && u.notify.billsPaidBack === false)) {
        const body = same(other, bill.paidBy) ? `${share.name} paid you back ${req.money(share.cents)} for ${bill.name}.` : `${req.user.name} marked your ${req.money(share.cents)} for ${bill.name} as paid back.`;
        await sendToUser(other, { title: 'Paid back', body, url: inHome(req.user.householdId, `/s/bills/${bill._id}`), tag: `bill-back-${bill._id}` });
      }
    }
    res.redirect(`/s/bills/${bill._id}`);
  } catch (err) {
    next(err);
  }
});

// Stop a repeating bill. Bills already made stay; future unpaid ones go.
router.post('/s/bills/:id/stop', async (req, res, next) => {
  try {
    const bill = await find(req);
    if (!bill || !bill.seriesId) return res.status(404).send('Not found');
    const today = todayIn(req.user.timezone);
    await BillSeries.updateOne({ _id: bill.seriesId, householdId: req.user.householdId }, { $set: { active: false } });
    const removed = await Bill.deleteMany({ householdId: req.user.householdId, seriesId: bill.seriesId, paid: false, dueDate: { $gt: bill.dueDate > today ? bill.dueDate : today }, _id: { $ne: bill._id } });
    await logActivity(req.user, { section: SECTION, text: `${req.user.name} stopped ${bill.name} from repeating` });
    req.session.flash = `${bill.name} won’t repeat anymore.${removed.deletedCount ? ` Removed ${removed.deletedCount} upcoming ${removed.deletedCount === 1 ? 'bill' : 'bills'}.` : ''}`;
    res.redirect(`/s/bills/${bill._id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/s/bills/:id/delete', async (req, res, next) => {
  try {
    const bill = await find(req);
    if (!bill) return res.status(404).send('Not found');
    const before = bill.toObject();
    await bill.deleteOne();
    // A deleted bill from a series isn't made again: the series has already moved past its date.
    await recordChange(req, { kind: 'delete', model: 'Bill', doc: bill, before, section: SECTION, text: `deleted the bill ${bill.name} (${req.money(bill.cents)})`, label: bill.name });
    res.redirect('/s/bills');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
