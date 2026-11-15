const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const Reminder = require('../models/Reminder');
const { recordChange, visible } = require('../lib/changes');
const { pick } = require('../lib/lists');
const { membersOf: householdMembers, isMember } = require('../lib/members');
const { todayIn, dayLabel, longDay, isDate, time12, addDays, zonedDate, clockIn } = require('../lib/dates');

const router = express.Router();
router.use('/s/remember', requireAuth, requireSection('remember'));
const SECTION = 'Remember';

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Reminder.findOne({ _id: req.params.id, ...visible(req.user) });
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const NOTIFY = ['all', 'me', 'some', 'none'];

const membersOf = (req) => householdMembers(req.user.householdId);

async function readForm(req) {
  const b = req.body;
  const text = String(b.text || '').trim().slice(0, 160);
  const date = String(b.date || '');
  const isPrivate = b.private === 'on';
  let notify = NOTIFY.includes(b.notify) ? b.notify : 'all';
  const ids = new Set([].concat(b.notifyTo || []).map(String));
  const notifyTo = notify === 'some' ? (await membersOf(req)).filter((m) => ids.has(String(m._id))).map((m) => m._id) : [];
  if (notify === 'some' && !notifyTo.length) notify = 'none';
  // A private reminder can only ever notify the person who added it.
  if (isPrivate && notify !== 'none') notify = 'me';
  const values = {
    text,
    details: String(b.details || '').trim().slice(0, 1000),
    date: isDate(date) ? date : '',
    time: isDate(date) && TIME.test(b.time || '') ? b.time : '',
    notify,
    notifyTo,
    category: pick(req.household, 'remCats', b.category),
    private: isPrivate,
  };
  let error = text ? null : 'Enter what to remember.';
  if (!error && TIME.test(b.time || '') && !isDate(date)) error = 'Add a date for the time to work.';
  return { values, error };
}

const formView = async (req, item, error) => ({ active: 'remember', item, error: error || null, members: await membersOf(req) });

router.get('/s/remember', async (req, res, next) => {
  try {
    const today = todayIn(req.user.timezone);
    const category = req.household.remCats.includes(req.query.category) ? req.query.category : '';
    const filter = { ...visible(req.user), done: false };
    if (category) filter.category = category;
    const rows = await Reminder.find(filter).lean();
    rows.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
    res.render('remember/list', {
      active: 'remember',
      category,
      items: rows.map((r) => ({
        ...r,
        late: r.date && r.date < today,
        meta: [r.date ? dayLabel(r.date, today) + (r.time ? ` at ${time12(r.time)}` : '') : 'No date', r.category === 'Uncategorized' ? '' : r.category, r.details].filter(Boolean).join(' · '),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/s/remember/new', async (req, res, next) => {
  try {
    const item = { _id: null, text: '', details: '', date: '', time: '', notify: 'all', notifyTo: [], category: req.household.remCats[0], private: false };
    res.render('remember/form', await formView(req, item));
  } catch (err) {
    next(err);
  }
});

router.post('/s/remember', async (req, res, next) => {
  try {
    const { values, error } = await readForm(req);
    if (error) return res.status(422).render('remember/form', await formView(req, { ...values, _id: null }, error));
    const item = await Reminder.create({ ...values, householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name });
    await recordChange(req, { kind: 'create', model: 'Reminder', doc: item, section: SECTION, text: `added ${item.text}`, label: item.text });
    res.redirect('/s/remember');
  } catch (err) {
    next(err);
  }
});

router.get('/s/remember/:id/edit', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    res.render('remember/form', await formView(req, item.toObject()));
  } catch (err) {
    next(err);
  }
});

// What a notification opens: the reminder, with Done and Snooze.
router.get('/s/remember/:id', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const tz = req.user.timezone;
    const today = todayIn(tz);
    const members = await membersOf(req);
    const names = (ids) => members.filter((m) => ids.some((id) => String(id) === String(m._id))).map((m) => (String(m._id) === req.user.id ? 'You' : m.name));
    const notifies = !item.date ? 'Nobody (add a date to get notified)'
      : item.notify === 'none' ? 'Nobody'
      : item.notify === 'me' || item.private ? (String(item.createdBy) === req.user.id ? 'Just you' : `Just ${item.byName}`)
      : item.notify === 'some' ? names(item.notifyTo).join(', ') || 'Nobody'
      : 'Everyone';
    const mine = (item.snoozes || []).filter((s) => String(s.userId) === req.user.id && s.until > new Date()).sort((a, b) => a.until - b.until)[0];
    res.render('remember/show', {
      active: 'remember',
      item,
      when: item.date ? `${['Today', 'Tomorrow', 'Yesterday'].includes(dayLabel(item.date, today)) ? `${dayLabel(item.date, today)}, ` : ''}${longDay(item.date)}${item.time ? ` at ${time12(item.time)}` : ''}` : 'No date',
      notifies,
      snoozedText: mine ? `Snoozed until ${clockIn(mine.until, tz, today)}. You’ll get it again then.` : '',
      morning: time12((req.user.notify && req.user.notify.morning) || '08:00'),
    });
  } catch (err) {
    next(err);
  }
});

// Snooze is personal: it notifies only the person who tapped it, and isn't a change to the reminder.
async function snooze(req, item, minutesValue) {
  const tz = req.user.timezone;
  let until;
  if (minutesValue === 'morning') {
    const [h, m] = ((req.user.notify && req.user.notify.morning) || '08:00').split(':').map(Number);
    until = zonedDate(addDays(todayIn(tz), 1), h * 60 + m, tz);
  } else {
    const minutes = parseInt(minutesValue, 10);
    if (!(minutes >= 1 && minutes <= 1440)) return false;
    until = new Date(Date.now() + minutes * 60000);
  }
  const keep = (item.snoozes || []).filter((s) => String(s.userId) !== req.user.id && s.until > new Date(Date.now() - 86400000));
  // No timestamp change, so snoozing never blocks someone's undo.
  await Reminder.updateOne({ _id: item._id }, { $set: { snoozes: [...keep, { userId: req.user._id, until }] } }, { timestamps: false });
  return true;
}

async function markDone(req, item) {
  if (item.done) return;
  const before = item.toObject();
  item.done = true;
  await item.save();
  await recordChange(req, { kind: 'update', model: 'Reminder', doc: item, before, section: SECTION, text: `checked off ${item.text}`, label: item.text });
}

router.post('/s/remember/:id/snooze', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    await snooze(req, item, req.body.minutes);
    res.redirect(`/s/remember/${item._id}`);
  } catch (err) {
    next(err);
  }
});

// The Done and Snooze buttons on a notification (Android) call these without opening the app.
router.use('/api/remember', requireAuth, requireSection('remember'));
router.post('/api/remember/:id/:action', async (req, res, next) => {
  try {
    // The notification may be from another of this person's households.
    if (mongoose.isValidObjectId(req.params.id)) {
      const r = await Reminder.findById(req.params.id, { householdId: 1 }).lean();
      if (r && String(r.householdId) !== String(req.user.householdId) && (await isMember(req.user._id, r.householdId))) req.user.householdId = r.householdId;
    }
    const item = await find(req);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (req.params.action === 'done') await markDone(req, item);
    else if (req.params.action === 'snooze') await snooze(req, item, '30');
    else return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/s/remember/:id', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const { values, error } = await readForm(req);
    if (error) return res.status(422).render('remember/form', await formView(req, { ...item.toObject(), ...values }, error));
    const before = item.toObject();
    if (String(item.createdBy) !== req.user.id) values.private = item.private;
    if (values.private && values.notify !== 'none') values.notify = 'me';
    item.set(values);
    await item.save();
    await recordChange(req, { kind: 'update', model: 'Reminder', doc: item, before, section: SECTION, text: `edited ${item.text}`, label: item.text });
    res.redirect('/s/remember');
  } catch (err) {
    next(err);
  }
});

router.post('/s/remember/:id/done', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    await markDone(req, item);
    res.redirect(req.body.from === 'today' ? '/' : '/s/remember');
  } catch (err) {
    next(err);
  }
});

router.post('/s/remember/:id/delete', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const before = item.toObject();
    await item.deleteOne();
    await recordChange(req, { kind: 'delete', model: 'Reminder', doc: item, before, section: SECTION, text: `deleted ${item.text}`, label: item.text });
    res.redirect('/s/remember');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
