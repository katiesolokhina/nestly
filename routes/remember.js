const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const Reminder = require('../models/Reminder');
const { recordChange, visible } = require('../lib/changes');
const { pick } = require('../lib/lists');
const { todayIn, dayLabel, isDate } = require('../lib/dates');

const router = express.Router();
router.use('/s/remember', requireAuth, requireSection('remember'));
const SECTION = 'Remember';

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Reminder.findOne({ _id: req.params.id, ...visible(req.user) });
}

function readForm(req) {
  const b = req.body;
  const text = String(b.text || '').trim().slice(0, 160);
  const date = String(b.date || '');
  const values = {
    text,
    details: String(b.details || '').trim().slice(0, 1000),
    date: isDate(date) ? date : '',
    category: pick(req.household, 'remCats', b.category),
    private: b.private === 'on',
  };
  return { values, error: text ? null : 'Enter what to remember.' };
}

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
        meta: [r.date ? dayLabel(r.date, today) : 'No date', r.category === 'Uncategorized' ? '' : r.category, r.details].filter(Boolean).join(' · '),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/s/remember/new', (req, res) => {
  res.render('remember/form', { active: 'remember', item: { _id: null, text: '', details: '', date: '', category: req.household.remCats[0], private: false }, error: null });
});

router.post('/s/remember', async (req, res, next) => {
  try {
    const { values, error } = readForm(req);
    if (error) return res.status(422).render('remember/form', { active: 'remember', item: { ...values, _id: null }, error });
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
    res.render('remember/form', { active: 'remember', item: item.toObject(), error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/s/remember/:id', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const { values, error } = readForm(req);
    if (error) return res.status(422).render('remember/form', { active: 'remember', item: { ...item.toObject(), ...values }, error });
    const before = item.toObject();
    if (String(item.createdBy) !== req.user.id) values.private = item.private;
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
    const before = item.toObject();
    item.done = true;
    await item.save();
    await recordChange(req, { kind: 'update', model: 'Reminder', doc: item, before, section: SECTION, text: `checked off ${item.text}`, label: item.text });
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
