const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const InfoItem = require('../models/InfoItem');
const Upload = require('../models/Upload');
const { recordChange, visible } = require('../lib/changes');
const { pick } = require('../lib/lists');
const { parseFiles, saveUpload } = require('../lib/uploads');
const { KINDS, template, hrefFor, smsFor, isWarranty, wifiQr, summary } = require('../lib/info');
const { todayIn, diffDays, shortDay } = require('../lib/dates');

const router = express.Router();
router.use('/s/info', requireAuth, requireSection('info'));
const SECTION = 'Home info';
const withFile = parseFiles(['file']);
const list = (v) => [].concat(v == null ? [] : v).map(String);
const MAX_FILES = 6;

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return InfoItem.findOne({ _id: req.params.id, ...visible(req.user) });
}

function warrantyNote(item, today) {
  const f = item.fields.find(isWarranty);
  if (!f) return null;
  const d = diffDays(today, f.value);
  if (d < 0) return { text: `Warranty ended ${shortDay(f.value)}`, tone: '' };
  if (d <= 60) return { text: `Warranty ends in ${d} ${d === 1 ? 'day' : 'days'}`, tone: 'late' };
  return { text: `Warranty until ${shortDay(f.value)}`, tone: '' };
}

router.get('/s/info', async (req, res, next) => {
  try {
    const today = todayIn(req.user.timezone);
    const types = [...req.household.infoTypes];
    const type = [...types, 'Other'].includes(req.query.type) ? req.query.type : '';
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
    let items = await InfoItem.find({ ...visible(req.user), ...(type ? { type } : {}) }).collation({ locale: 'en' }).sort({ title: 1 }).lean();
    // Search titles, notes, and fields, but never hidden values.
    if (q) items = items.filter((i) => [i.title, i.notes, ...i.fields.filter((f) => f.kind !== 'secret').map((f) => `${f.label} ${f.value}`)].join(' ').toLowerCase().includes(q));
    const rows = items.map((i) => ({ ...i, summary: summary(i), warranty: warrantyNote(i, today) }));
    const groups = [...types, 'Other']
      .map((name) => ({ name, items: rows.filter((r) => r.type === name || (name === 'Other' && !types.includes(r.type))) }))
      .filter((g) => g.items.length);
    res.render('info/list', { active: 'info', groups, type, q, count: items.length });
  } catch (err) {
    next(err);
  }
});

function readForm(req) {
  const b = req.body || {};
  const labels = list(b.fLabel);
  const values = list(b.fValue);
  const kinds = list(b.fKind);
  const fields = labels
    .map((label, i) => ({ label: label.trim().slice(0, 40), value: String(values[i] || '').trim().slice(0, 500), kind: Object.keys(KINDS).includes(kinds[i]) ? kinds[i] : 'text' }))
    .filter((f) => f.label || f.value)
    .map((f) => ({ ...f, label: f.label || 'Note' }))
    .slice(0, 30);
  const out = {
    title: String(b.title || '').trim().slice(0, 80),
    type: pick(req.household, 'infoTypes', b.type),
    fields,
    notes: String(b.notes || '').trim().slice(0, 5000),
    private: b.private === 'on',
  };
  let error = req.uploadError || null;
  if (!out.title) error = 'Enter a name for this.';
  const badDate = fields.find((f) => f.kind === 'date' && f.value && !/^\d{4}-\d{2}-\d{2}$/.test(f.value));
  if (!error && badDate) error = `Choose a date for ${badDate.label}.`;
  return { values: out, error };
}

async function formView(req, item, error) {
  const files = item.fileIds && item.fileIds.length ? await Upload.find({ _id: { $in: item.fileIds }, householdId: req.user.householdId }).lean() : [];
  return { active: 'info', item, error: error || null, files, KINDS };
}

async function applyFiles(req, item) {
  const remove = new Set(list((req.body || {}).removeFile));
  item.fileIds = (item.fileIds || []).filter((id) => !remove.has(String(id)));
  const f = (req.files || {}).file;
  if (f) {
    if (item.fileIds.length >= MAX_FILES) {
      const e = new Error(`Up to ${MAX_FILES} files per item. Remove one first.`);
      e.userFacing = true;
      throw e;
    }
    item.fileIds.push((await saveUpload(req.user, f[0], { isPrivate: item.private }))._id);
  }
  if (item.fileIds.length) await Upload.updateMany({ _id: { $in: item.fileIds }, householdId: req.user.householdId }, { $set: { private: item.private } });
}

// New: pick a type first, so the form starts with the right fields.
router.get('/s/info/new', async (req, res, next) => {
  try {
    const types = req.household.infoTypes;
    if (!types.includes(req.query.type)) return res.render('info/pick', { active: 'info', types });
    const item = { _id: null, title: '', type: req.query.type, fields: template(req.query.type, req.household), notes: '', private: false, fileIds: [] };
    if (!item.fields.length) item.fields = [{ label: '', value: '', kind: 'text' }];
    res.render('info/form', await formView(req, item));
  } catch (err) {
    next(err);
  }
});

router.post('/s/info', withFile, async (req, res, next) => {
  try {
    const { values, error } = readForm(req);
    if (error) return res.status(422).render('info/form', await formView(req, { ...values, _id: null, fileIds: [] }, error));
    const item = new InfoItem({ ...values, householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name });
    try {
      await applyFiles(req, item);
    } catch (e) {
      if (!e.userFacing) throw e;
      return res.status(422).render('info/form', await formView(req, { ...values, _id: null, fileIds: [] }, e.message));
    }
    await item.save();
    await recordChange(req, { kind: 'create', model: 'InfoItem', doc: item, section: SECTION, text: `added ${item.title} to Home info`, label: item.title });
    res.redirect(`/s/info/${item._id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/s/info/:id', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const today = todayIn(req.user.timezone);
    const files = item.fileIds.length ? await Upload.find({ _id: { $in: item.fileIds }, householdId: req.user.householdId }).lean() : [];
    res.render('info/show', {
      active: 'info',
      item,
      files,
      qr: await wifiQr(item),
      warranty: warrantyNote(item, today),
      fields: item.fields.map((f) => ({ ...f.toObject(), href: hrefFor(f), sms: smsFor(f), display: f.kind === 'date' && f.value ? shortDay(f.value) : f.value })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/s/info/:id/edit', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const obj = item.toObject();
    if (!obj.fields.length) obj.fields = [{ label: '', value: '', kind: 'text' }];
    res.render('info/form', await formView(req, obj));
  } catch (err) {
    next(err);
  }
});

router.post('/s/info/:id', withFile, async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const { values, error } = readForm(req);
    if (error) return res.status(422).render('info/form', await formView(req, { ...item.toObject(), ...values }, error));
    const before = item.toObject();
    if (String(item.createdBy) !== req.user.id) values.private = item.private;
    item.set(values);
    try {
      await applyFiles(req, item);
    } catch (e) {
      if (!e.userFacing) throw e;
      return res.status(422).render('info/form', await formView(req, { ...before, ...values }, e.message));
    }
    await item.save();
    // The log names what changed, never the values, so passwords don't end up in Activity text.
    await recordChange(req, { kind: 'update', model: 'InfoItem', doc: item, before, section: SECTION, text: `edited ${item.title} in Home info`, label: item.title });
    res.redirect(`/s/info/${item._id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/s/info/:id/delete', async (req, res, next) => {
  try {
    const item = await find(req);
    if (!item) return res.status(404).send('Not found');
    const before = item.toObject();
    await item.deleteOne();
    await recordChange(req, { kind: 'delete', model: 'InfoItem', doc: item, before, section: SECTION, text: `deleted ${item.title} from Home info`, label: item.title });
    res.redirect('/s/info');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
