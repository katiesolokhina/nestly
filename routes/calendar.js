const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const Event = require('../models/Event');
const Reminder = require('../models/Reminder');
const { recordChange, visible } = require('../lib/changes');
const { pick } = require('../lib/lists');
const { occursOn } = require('../lib/today');
const { todayIn, isDate, longDay, monthLabel, shiftMonth, monthCells, time12 } = require('../lib/dates');

const router = express.Router();
router.use('/s/calendar', requireAuth, requireSection('calendar'));
const SECTION = 'Calendar';

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Event.findOne({ _id: req.params.id, ...visible(req.user) });
}

function readForm(req) {
  const b = req.body;
  const title = String(b.title || '').trim().slice(0, 120);
  const date = String(b.date || '');
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '') ? b.time : '';
  const values = {
    title, date, time,
    repeat: b.repeat === 'yearly' ? 'yearly' : 'none',
    category: pick(req.household, 'eventCats', b.category),
    details: String(b.details || '').trim().slice(0, 1000),
    private: b.private === 'on',
  };
  let error = null;
  if (!title) error = 'Enter a name for the event.';
  else if (!isDate(date)) error = 'Choose a date.';
  return { values, error };
}

router.get('/s/calendar', async (req, res, next) => {
  try {
    const today = todayIn(req.user.timezone);
    const day = isDate(req.query.day) ? req.query.day : today;
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || '') ? req.query.month : day.slice(0, 7);
    const scope = visible(req.user);
    const [events, reminders] = await Promise.all([
      Event.find(scope).lean(),
      req.household.features.remember !== false ? Reminder.find({ ...scope, done: false, date: { $ne: '' } }).lean() : [],
    ]);
    const { blanks, days } = monthCells(month);
    const has = (d) => events.some((e) => occursOn(e, d)) || reminders.some((r) => r.date === d);
    const agenda = [
      ...events.filter((e) => occursOn(e, day)).sort((a, b) => a.time.localeCompare(b.time)).map((e) => ({
        title: e.title,
        meta: [time12(e.time), e.category === 'Uncategorized' ? '' : e.category, e.repeat === 'yearly' ? 'Every year' : ''].filter(Boolean).join(' · '),
        tag: e.private ? 'Only me' : 'Event', lilac: e.private, href: `/s/calendar/${e._id}/edit`,
      })),
      ...reminders.filter((r) => r.date === day).map((r) => ({ title: r.text, meta: 'Reminder', tag: r.private ? 'Only me' : 'Reminder', lilac: r.private, href: `/s/remember/${r._id}/edit` })),
    ];
    res.render('calendar/month', {
      active: 'calendar', month, day, today, blanks, agenda,
      cells: days.map((d) => ({ date: d, num: Number(d.slice(8)), has: has(d) })),
      label: monthLabel(month), dayTitle: longDay(day), prev: shiftMonth(month, -1), next: shiftMonth(month, 1),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/s/calendar/new', (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : todayIn(req.user.timezone);
  res.render('calendar/form', { active: 'calendar', item: { _id: null, title: '', date, time: '', repeat: 'none', category: req.household.eventCats[0], details: '', private: false }, error: null });
});

router.post('/s/calendar', async (req, res, next) => {
  try {
    const { values, error } = readForm(req);
    if (error) return res.status(422).render('calendar/form', { active: 'calendar', item: { ...values, _id: null }, error });
    const item = await Event.create({ ...values, householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name });
    await recordChange(req, { kind: 'create', model: 'Event', doc: item, section: SECTION, text: `added ${item.title}`, label: item.title });
    res.redirect(`/s/calendar?day=${item.date}`);
  } catch (err) {
    next(err);
  }
});

router.get('/s/calendar/:id/edit', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    res.render('calendar/form', { active: 'calendar', item: item.toObject(), error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/s/calendar/:id', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const { values, error } = readForm(req);
    if (error) return res.status(422).render('calendar/form', { active: 'calendar', item: { ...item.toObject(), ...values }, error });
    const before = item.toObject();
    if (String(item.createdBy) !== req.user.id) values.private = item.private;
    item.set(values);
    await item.save();
    await recordChange(req, { kind: 'update', model: 'Event', doc: item, before, section: SECTION, text: `edited ${item.title}`, label: item.title });
    res.redirect(`/s/calendar?day=${item.date}`);
  } catch (err) {
    next(err);
  }
});

router.post('/s/calendar/:id/delete', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const before = item.toObject();
    await item.deleteOne();
    await recordChange(req, { kind: 'delete', model: 'Event', doc: item, before, section: SECTION, text: `deleted ${item.title}`, label: item.title });
    res.redirect(`/s/calendar?day=${item.date}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
