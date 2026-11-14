const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const Event = require('../models/Event');
const Reminder = require('../models/Reminder');
const Upload = require('../models/Upload');
const { recordChange, visible } = require('../lib/changes');
const { pick, categoryColor, reminderColor } = require('../lib/lists');
const { parseFiles, saveUpload } = require('../lib/uploads');
const { occursOn, timeText, sortKey, repeatText, DAY_NAMES } = require('../lib/recurrence');
const { todayIn, isDate, weekday, longDay, monthLabel, shiftMonth, monthCells } = require('../lib/dates');

const router = express.Router();
router.use('/s/calendar', requireAuth, requireSection('calendar'));
const SECTION = 'Calendar';
const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isHttp = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };
const withFile = parseFiles(['file']);

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Event.findOne({ _id: req.params.id, ...visible(req.user) });
}

function readForm(req) {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 120);
  const date = String(b.date || '');
  const endDate = isDate(b.endDate) && b.endDate !== date ? b.endDate : '';
  // No start time means all day, so older events and quick entries still work.
  const allDay = b.allDay === 'on';
  const time = !allDay && TIME.test(b.time || '') ? b.time : '';
  const endTime = !allDay && TIME.test(b.endTime || '') ? b.endTime : '';
  const repeat = REPEATS.includes(b.repeat) ? b.repeat : 'none';
  const interval = Math.min(99, Math.max(1, parseInt(b.interval, 10) || 1));
  const picked = [...new Set([].concat(b.days || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const until = repeat !== 'none' && isDate(b.until) ? b.until : '';
  const link = String(b.link || '').trim();
  const values = {
    title, date, endDate, time, endTime,
    location: String(b.location || '').trim().slice(0, 200),
    link,
    repeat,
    interval: repeat === 'none' ? 1 : interval,
    days: repeat === 'weekly' ? (picked.length ? picked : isDate(date) ? [weekday(date)] : []) : [],
    until,
    category: pick(req.household, 'eventCats', b.category),
    details: String(b.details || '').trim().slice(0, 1000),
    private: b.private === 'on',
  };
  let error = req.uploadError || null;
  if (!title) error = 'Enter a name for the event.';
  else if (!isDate(date)) error = 'Choose a date.';
  else if (isDate(b.endDate) && b.endDate < date) error = 'The end date can’t be before the start date.';
  else if (endTime && !time) error = 'Add a start time too, or mark it all day.';
  else if (!endDate && time && endTime && endTime <= time) error = 'The end time must be after the start time.';
  else if (until && until < date) error = 'Repeat until must be on or after the start date.';
  else if (link && !isHttp(link)) error = 'Enter a full link that starts with https://';
  return { values, error };
}

async function formView(req, item, error) {
  const file = item.fileId ? await Upload.findById(item.fileId).lean() : null;
  return { active: 'calendar', item, error: error || null, file, dayNames: DAY_NAMES };
}

// Attaches, replaces, or removes the event's file, and keeps its privacy in step with the event.
async function applyFile(req, item) {
  if ((req.body || {}).removeFile === 'on') item.fileId = null;
  const f = (req.files || {}).file;
  if (f) item.fileId = (await saveUpload(req.user, f[0], { isPrivate: item.private }))._id;
  if (item.fileId) await Upload.updateOne({ _id: item.fileId, householdId: req.user.householdId }, { $set: { private: item.private } });
}

router.get('/s/calendar', async (req, res, next) => {
  try {
    const today = todayIn(req.user.timezone);
    const day = isDate(req.query.day) ? req.query.day : today;
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || '') ? req.query.month : day.slice(0, 7);
    const scope = visible(req.user);
    // Filtering by a category shows only those events; reminders have no event category, so they hide.
    // "Reminders" is its own filter, kept apart from event categories so a category can share its name.
    const remindersOn = req.household.features.remember !== false;
    const cats = ['Uncategorized', ...req.household.eventCats];
    const onlyReminders = remindersOn && req.query.show === 'reminders';
    const cat = !onlyReminders && cats.includes(req.query.cat) ? req.query.cat : '';
    const [events, reminders] = await Promise.all([
      onlyReminders ? [] : Event.find(cat ? { ...scope, category: cat } : scope).lean(),
      remindersOn && !cat ? Reminder.find({ ...scope, done: false, date: { $ne: '' } }).lean() : [],
    ]);
    const remColor = reminderColor(req.household);
    const { blanks, days } = monthCells(month);
    const color = (e) => categoryColor(req.household, e.category);
    // Up to three dots per day: one per event color, then one for reminders.
    const dots = (d) => {
      const colors = [...new Set(events.filter((e) => occursOn(e, d)).map(color))];
      if (reminders.some((r) => r.date === d)) colors.push(remColor);
      return colors.slice(0, 3);
    };
    const agenda = [
      ...events.filter((e) => occursOn(e, day)).sort((a, b) => sortKey(a, day).localeCompare(sortKey(b, day))).map((e) => ({
        title: e.title,
        meta: [timeText(e, day), e.location, e.category === 'Uncategorized' ? '' : e.category, repeatText(e)].filter(Boolean).join(' · '),
        tag: e.private ? 'Only me' : 'Event', lilac: e.private, href: `/s/calendar/${e._id}?day=${day}`, color: color(e),
      })),
      ...reminders.filter((r) => r.date === day).map((r) => ({ title: r.text, meta: 'Reminder', tag: r.private ? 'Only me' : 'Reminder', lilac: r.private, href: `/s/remember/${r._id}/edit`, color: remColor })),
    ];
    res.render('calendar/month', {
      active: 'calendar', month, day, today, blanks, agenda, cat,
      filterLabel: onlyReminders ? 'reminders' : cat ? `${cat} events` : '',
      catQuery: onlyReminders ? '&show=reminders' : cat ? `&cat=${encodeURIComponent(cat)}` : '',
      catChips: [
        { name: 'All', query: '', on: !cat && !onlyReminders, color: '' },
        ...[...req.household.eventCats, 'Uncategorized'].map((c) => ({ name: c, query: `&cat=${encodeURIComponent(c)}`, on: cat === c, color: categoryColor(req.household, c) })),
        ...(remindersOn ? [{ name: 'Reminders', query: '&show=reminders', on: onlyReminders, color: remColor }] : []),
      ],
      cells: days.map((d) => { const ds = dots(d); return { date: d, num: Number(d.slice(8)), has: ds.length > 0, dots: ds }; }),
      label: monthLabel(month), dayTitle: longDay(day), prev: shiftMonth(month, -1), next: shiftMonth(month, 1),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/s/calendar/new', async (req, res, next) => {
  try {
    const date = isDate(req.query.date) ? req.query.date : todayIn(req.user.timezone);
    // Adding from a filtered calendar starts in that category.
    const category = req.household.eventCats.includes(req.query.category) ? req.query.category : 'Uncategorized';
    const item = { _id: null, title: '', date, endDate: '', time: '', endTime: '', location: '', link: '', fileId: null, repeat: 'none', interval: 1, days: [], until: '', category, details: '', private: false };
    res.render('calendar/form', await formView(req, item));
  } catch (err) {
    next(err);
  }
});

router.post('/s/calendar', withFile, async (req, res, next) => {
  try {
    const { values, error } = readForm(req);
    if (error) return res.status(422).render('calendar/form', await formView(req, { ...values, _id: null }, error));
    const item = new Event({ ...values, householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name });
    try {
      await applyFile(req, item);
    } catch (e) {
      if (!e.userFacing) throw e;
      return res.status(422).render('calendar/form', await formView(req, { ...values, _id: null }, e.message));
    }
    await item.save();
    await recordChange(req, { kind: 'create', model: 'Event', doc: item, section: SECTION, text: `added ${item.title}`, label: item.title });
    res.redirect(`/s/calendar?day=${item.date}`);
  } catch (err) {
    next(err);
  }
});

// Details: what you need on the day, like the address, tickets, or RSVP link.
router.get('/s/calendar/:id', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const day = isDate(req.query.day) && occursOn(item, req.query.day) ? req.query.day : item.date;
    const file = item.fileId ? await Upload.findById(item.fileId).lean() : null;
    res.render('calendar/event', {
      active: 'calendar', item, day, file,
      when: longDay(day), time: timeText(item, day), repeat: repeatText(item), color: categoryColor(req.household, item.category),
      maps: item.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location)}` : '',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/s/calendar/:id/edit', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    res.render('calendar/form', await formView(req, item.toObject()));
  } catch (err) {
    next(err);
  }
});

router.post('/s/calendar/:id', withFile, async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const { values, error } = readForm(req);
    if (error) return res.status(422).render('calendar/form', await formView(req, { ...item.toObject(), ...values }, error));
    const before = item.toObject();
    if (String(item.createdBy) !== req.user.id) values.private = item.private;
    item.set(values);
    try {
      await applyFile(req, item);
    } catch (e) {
      if (!e.userFacing) throw e;
      return res.status(422).render('calendar/form', await formView(req, { ...before, ...values }, e.message));
    }
    await item.save();
    await recordChange(req, { kind: 'update', model: 'Event', doc: item, before, section: SECTION, text: `edited ${item.title}`, label: item.title });
    res.redirect(`/s/calendar/${item._id}`);
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
