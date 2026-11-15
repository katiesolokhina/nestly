// Calendar feed: each person's private link that Google Calendar, Apple Calendar, or Outlook
// subscribes to. It shows what they'd see in Nestly (their role, their private items), and
// a new link turns the old one off.
const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const Membership = require('../models/Membership');
const User = require('../models/User');
const Household = require('../models/Household');
const Event = require('../models/Event');
const Reminder = require('../models/Reminder');
const Bill = require('../models/Bill');
const { permsFor } = require('../lib/perms');
const { membersOf, inHome } = require('../lib/members');
const { choresWithDue, isFor } = require('../lib/chores');
const { money } = require('../lib/bills');
const { calendar } = require('../lib/ics');
const { addDays, todayIn } = require('../lib/dates');

const router = express.Router();
const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const KINDS = ['events', 'reminders', 'bills', 'chores'];
const base = () => (process.env.APP_ORIGIN || '').replace(/\/$/, '');

// ---------- Settings → Calendar feed ----------
router.get('/settings/calendar', requireAuth, (req, res) => {
  const link = req.session.feedLink || null; // shown once, right after it's made
  delete req.session.feedLink;
  res.render('settings/calendar', { active: 'settings', link, on: Boolean(req.member.feedHash), feed: req.member.feed || {}, kinds: KINDS.filter((k) => req.sees({ events: 'calendar', reminders: 'remember', bills: 'bills', chores: 'chores' }[k])) });
});

router.post('/settings/calendar', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const m = req.member;
    if (b.action === 'off') {
      m.feedHash = null;
    } else {
      KINDS.forEach((k) => { m.feed[k] = b[k] === 'on'; });
      if (b.action === 'new' || !m.feedHash) {
        const raw = crypto.randomBytes(24).toString('base64url');
        m.feedHash = hash(raw);
        req.session.feedLink = `${base()}/cal/${raw}.ics`;
      }
    }
    await m.save();
    res.redirect('/settings/calendar');
  } catch (err) {
    next(err);
  }
});

// ---------- The feed itself ----------
const feedLimit = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

router.get('/cal/:token.ics', feedLimit, async (req, res, next) => {
  try {
    const raw = String(req.params.token || '');
    if (!/^[\w-]{20,64}$/.test(raw)) return res.status(404).send('Not found');
    const m = await Membership.findOne({ feedHash: hash(raw), disabled: false }).lean();
    if (!m) return res.status(404).send('Not found');
    const [user, household] = await Promise.all([User.findById(m.userId).lean(), Household.findById(m.householdId).lean()]);
    if (!user || !household) return res.status(404).send('Not found');
    const perms = permsFor(household, m);
    const sees = (key) => perms.level(key) !== 'hidden';
    const want = { ...{ events: true, reminders: true, bills: true, chores: true }, ...(m.feed || {}) };
    const scope = { householdId: household._id, $or: [{ private: false }, { createdBy: user._id }] };
    const tz = user.timezone || 'America/Chicago';
    const today = todayIn(tz);
    const url = (p) => (base() ? `${base()}${inHome(household._id, p)}` : '');
    const sym = household.currency || '$';

    const [events, reminders, bills, chores] = await Promise.all([
      want.events && sees('calendar') ? Event.find(scope).lean() : [],
      want.reminders && sees('remember') ? Reminder.find({ ...scope, done: false, date: { $ne: '' } }).lean() : [],
      want.bills && sees('bills') ? Bill.find({ ...scope, paid: false, dueDate: { $gte: addDays(today, -60) } }).lean() : [],
      want.chores && sees('chores')
        ? Promise.all([choresWithDue(household._id), membersOf(household._id)]).then(([all, members]) => all.filter((c) => c.due && isFor(c, user._id, members)))
        : [],
    ]);

    const items = [
      ...events.map((e) => ({ uid: `event-${e._id}@nestly`, title: e.title, date: e.date, endDate: e.endDate, time: e.time, endTime: e.endTime, location: e.location, details: e.details, repeat: e.repeat, interval: e.interval, days: e.days, until: e.until, url: url(`/s/calendar/${e._id}`) })),
      ...reminders.map((r) => ({ uid: `reminder-${r._id}@nestly`, title: `Reminder: ${r.text}`, date: r.date, time: r.time, details: r.details, url: url(`/s/remember/${r._id}`) })),
      ...bills.map((b) => ({ uid: `bill-${b._id}@nestly`, title: `Bill due: ${b.name} ${money(b.cents, sym)}`, date: b.dueDate, details: b.note, url: url(`/s/bills/${b._id}`) })),
      // A chore shows from when it's next due, repeating as it does in Nestly.
      ...chores.map((c) => ({ uid: `chore-${c._id}@nestly`, title: `Chore: ${c.title}`, date: c.due, time: c.time, details: [c.room !== 'Anywhere' ? c.room : '', c.details].filter(Boolean).join('\n'), repeat: c.repeat, interval: c.interval, days: c.days, until: c.until, url: url('/s/chores') })),
    ];
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(calendar(`Nestly: ${household.name}`, tz, items));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
