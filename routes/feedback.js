// Report a bug or suggest a feature. Everyone can send one (with up to 3 screenshots and how much
// it matters to them) and see their own; whoever runs Nestly (OWNER_EMAILS in .env) sees every
// household's, and household admins see their own household's. Reviewers filter, sort, set a
// priority, keep private notes, archive, and download or upload the inbox as an Excel file.
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const Feedback = require('../models/Feedback');
const Household = require('../models/Household');
const Upload = require('../models/Upload');
const { sendMail, mailOn } = require('../lib/mail');
const { sendToUser } = require('../lib/push');
const { shortDay } = require('../lib/dates');
const { buildXlsx } = require('../lib/xlsx');
const { readXlsx } = require('../lib/xlsx-read');
const { saveUpload, filePath, deleteUploads } = require('../lib/uploads');

const router = express.Router();
router.use('/feedback', requireAuth);

const STATUS = { new: 'New', planned: 'Planned', done: 'Done', no: 'Not planned', archived: 'Archived' };
const KINDS = { bug: 'Something’s wrong', idea: 'An idea' };
const PRIORITY = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
const THEIRS = { blocking: 'Blocking me', important: 'Important', nice: 'Nice to have' };
const RANK = { urgent: 0, high: 1, medium: 2, low: 3, '': 4 };
const THEIR_RANK = { blocking: 0, important: 1, nice: 2, '': 3 };
const SHOW = { open: 'Open', all: 'All', ...STATUS };
const SORTS = { new: 'Newest', old: 'Oldest', priority: 'Priority', theirs: 'Their priority' };
const MAX_SHOTS = 3;

const listOf = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isOwner = (user) => listOf(process.env.OWNER_EMAILS).includes(String(user.email || '').toLowerCase());
const canReview = (req) => isOwner(req.user) || Boolean(req.member && req.member.role === 'admin');
const scopeFor = (req) => (isOwner(req.user) ? {} : { householdId: req.user.householdId });
const view = (f) => ({ ...f, day: shortDay(f.createdAt.toISOString().slice(0, 10)), statusName: STATUS[f.status], kindName: KINDS[f.kind], priorityName: PRIORITY[f.priority] || '', theirName: THEIRS[f.theirPriority] || '' });
// Only paths within Nestly are kept as "where it happened".
const pathOf = (v) => { const s = String(v || ''); return /^\/[\w\-/?=&%.#]*$/.test(s) ? s.slice(0, 300) : ''; };

const sendLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: 'That’s a lot of reports in an hour. Try again later.' });

// Screenshots (up to 3, 10 MB each) and the Excel upload (one file).
const shotParser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: MAX_SHOTS } }).array('shots', MAX_SHOTS);
const fileParser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file');
const parsed = (parser) => (req, res, next) => parser(req, res, (err) => {
  if (err instanceof multer.MulterError) {
    req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'Choose files under the size limit.' : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `Up to ${MAX_SHOTS} screenshots.` : 'That file could not be uploaded.';
    req.body = req.body || {};
    return next();
  }
  return next(err);
});

// The inbox's filter and sort, from the query (the same for the page and the Excel download).
function inboxQuery(req) {
  const q = req.query;
  const show = Object.keys(SHOW).includes(q.status) ? q.status : 'open';
  const kind = Object.keys(KINDS).includes(q.kind) ? q.kind : '';
  const who = mongoose.isValidObjectId(q.who) ? String(q.who) : '';
  const home = isOwner(req.user) && mongoose.isValidObjectId(q.home) ? String(q.home) : '';
  const sort = Object.keys(SORTS).includes(q.sort) ? q.sort : 'new';
  const filter = {
    ...scopeFor(req),
    ...(show === 'open' ? { status: { $in: ['new', 'planned'] } } : show === 'all' ? { status: { $ne: 'archived' } } : { status: show }),
    ...(kind ? { kind } : {}),
    ...(who ? { userId: who } : {}),
    ...(home ? { householdId: home } : {}),
  };
  return { show, kind, who, home, sort, filter };
}
const sorter = (sort) => (a, b) => {
  if (sort === 'old') return a.createdAt - b.createdAt;
  if (sort === 'priority') return RANK[a.priority || ''] - RANK[b.priority || ''] || THEIR_RANK[a.theirPriority || ''] - THEIR_RANK[b.theirPriority || ''] || b.createdAt - a.createdAt;
  if (sort === 'theirs') return THEIR_RANK[a.theirPriority || ''] - THEIR_RANK[b.theirPriority || ''] || RANK[a.priority || ''] - RANK[b.priority || ''] || b.createdAt - a.createdAt;
  return b.createdAt - a.createdAt;
};
const queryString = (o) => new URLSearchParams(Object.entries(o).filter(([k, v]) => v && !(k === 'status' && v === 'open') && !(k === 'sort' && v === 'new'))).toString();

// ---------- Sending ----------
router.get('/feedback', async (req, res, next) => {
  try {
    const mine = (await Feedback.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(20).lean()).map(view);
    const fresh = canReview(req) ? await Feedback.countDocuments({ ...scopeFor(req), status: 'new' }) : 0;
    res.render('feedback', { active: 'settings', mine, KINDS, THEIRS, MAX_SHOTS, kind: req.query.kind === 'idea' ? 'idea' : 'bug', from: pathOf(req.query.from), canReview: canReview(req), fresh, error: null, text: '' });
  } catch (err) {
    next(err);
  }
});

router.post('/feedback', sendLimit, parsed(shotParser), async (req, res, next) => {
  try {
    const b = req.body || {};
    const text = String(b.text || '').trim().slice(0, 2000);
    const kind = b.kind === 'idea' ? 'idea' : 'bug';
    const again = async (error) => {
      const mine = (await Feedback.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(20).lean()).map(view);
      return res.status(422).render('feedback', { active: 'settings', mine, KINDS, THEIRS, MAX_SHOTS, kind, from: pathOf(b.page), canReview: canReview(req), fresh: 0, error, text });
    };
    if (req.uploadError) return again(req.uploadError);
    if (!text) return again('Write what happened, or your idea, first.');
    // Screenshots are kept private to whoever sent them; reviewers see them through the inbox.
    const shots = [];
    try {
      for (const file of (req.files || []).slice(0, MAX_SHOTS)) shots.push((await saveUpload(req.user, file, { isPrivate: true, imagesOnly: true }))._id);
    } catch (err) {
      if (err.userFacing) { await deleteUploads({ _id: { $in: shots } }); return again(err.message); }
      throw err;
    }
    const f = await Feedback.create({
      householdId: req.user.householdId, userId: req.user._id, byName: req.user.name,
      kind, text, page: pathOf(b.page), shots,
      theirPriority: Object.keys(THEIRS).includes(b.theirPriority) ? b.theirPriority : '',
      device: kind === 'idea' ? '' : String(req.get('User-Agent') || '').slice(0, 300),
    });
    const to = process.env.FEEDBACK_EMAIL || process.env.OWNER_EMAILS;
    if (to && mailOn()) {
      const home = await Household.findById(req.user.householdId, { name: 1 }).lean();
      const origin = (process.env.APP_ORIGIN || '').replace(/\/$/, '');
      sendMail({
        to,
        subject: `Nestly ${f.kind === 'idea' ? 'idea' : 'bug'} from ${f.byName}${f.theirPriority ? ` (${THEIRS[f.theirPriority]})` : ''}`,
        text: `${f.text}\n\n${f.byName} (${req.user.email}) · ${home ? home.name : ''}${f.page ? `\nPage: ${f.page}` : ''}${f.device ? `\nDevice: ${f.device}` : ''}${shots.length ? `\nScreenshots: ${shots.length}` : ''}\n\n${origin}/feedback/inbox#f-${f._id}`,
      }).catch((err) => console.error('Feedback email failed:', err.message));
    }
    req.session.flash = f.kind === 'idea' ? 'Thanks! Your idea was sent.' : 'Thanks! Your report was sent.';
    res.redirect('/feedback');
  } catch (err) {
    next(err);
  }
});

// A screenshot: for whoever sent it, and whoever can review it.
router.get('/feedback/:id/shots/:n', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).send('Not found');
    const f = await Feedback.findById(req.params.id, { userId: 1, householdId: 1, shots: 1 }).lean();
    const allowed = f && (String(f.userId) === String(req.user._id) || (canReview(req) && (isOwner(req.user) || String(f.householdId) === String(req.user.householdId))));
    const id = allowed && f.shots[Number(req.params.n)];
    const upload = id && (await Upload.findById(id).lean());
    if (!upload) return res.status(404).send('Not found');
    res.set({ 'Content-Type': upload.type, 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline' });
    res.sendFile(filePath(upload), (err) => { if (err && !res.headersSent) res.status(404).send('Not found'); });
  } catch (err) {
    next(err);
  }
});

// ---------- Inbox ----------
router.get('/feedback/inbox', async (req, res, next) => {
  try {
    if (!canReview(req)) return res.status(404).send('Not found');
    const q = inboxQuery(req);
    const items = (await Feedback.find(q.filter).limit(1000).lean()).sort(sorter(q.sort)).slice(0, 300).map(view);
    const scope = scopeFor(req);
    // Who has sent anything (for the person filter), and households (for the owner).
    const senders = await Feedback.aggregate([{ $match: scope }, { $group: { _id: '$userId', name: { $last: '$byName' } } }, { $sort: { name: 1 } }]);
    const homeIds = isOwner(req.user) ? await Feedback.distinct('householdId', scope) : [];
    const homes = new Map((await Household.find({ _id: { $in: [...homeIds, ...items.map((i) => i.householdId)] } }, { name: 1 }).lean()).map((h) => [String(h._id), h.name]));
    const counts = Object.fromEntries((await Feedback.aggregate([{ $match: scope }, { $group: { _id: '$status', n: { $sum: 1 } } }])).map((c) => [c._id, c.n]));
    counts.open = (counts.new || 0) + (counts.planned || 0);
    counts.all = Object.entries(counts).filter(([k]) => STATUS[k] && k !== 'archived').reduce((n, [, v]) => n + v, 0);
    res.render('feedback-inbox', {
      active: 'settings', q, items: items.map((i) => ({ ...i, home: homes.get(String(i.householdId)) || '' })),
      STATUS, SHOW, SORTS, KINDS, PRIORITY, counts, owner: isOwner(req.user),
      senders: senders.map((s) => ({ id: String(s._id), name: s.name })),
      homes: homeIds.map((id) => ({ id: String(id), name: homes.get(String(id)) || 'Household' })),
      qs: (extra) => queryString({ status: q.show, kind: q.kind, who: q.who, home: q.home, sort: q.sort, ...extra }),
      back: queryString({ status: q.show, kind: q.kind, who: q.who, home: q.home, sort: q.sort }),
      importResult: req.session.feedbackImport && req.session.feedbackImport.done ? req.session.feedbackImport : null,
    });
    if (req.session.feedbackImport && req.session.feedbackImport.done) delete req.session.feedbackImport;
  } catch (err) {
    next(err);
  }
});

// Excel download of what the inbox is showing (same filters and sort).
router.get('/feedback/inbox/export', async (req, res, next) => {
  try {
    if (!canReview(req)) return res.status(404).send('Not found');
    const q = inboxQuery(req);
    const items = (await Feedback.find(q.filter).limit(5000).lean()).sort(sorter(q.sort));
    const homes = new Map((await Household.find({ _id: { $in: [...new Set(items.map((i) => String(i.householdId)))] } }, { name: 1 }).lean()).map((h) => [String(h._id), h.name]));
    const tz = req.user.timezone || 'America/Chicago';
    const when = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(',', '');
    const origin = (process.env.APP_ORIGIN || '').replace(/\/$/, '');
    const file = buildXlsx({
      sheetName: 'Feedback',
      columns: [
        { title: 'ID', width: 26 }, { title: 'Date', width: 17 }, { title: 'Type', width: 8 }, { title: 'Status', width: 12 },
        { title: 'Priority', width: 10 }, { title: 'Their priority', width: 14 },
        { title: 'Feedback', width: 60, wrap: true }, { title: 'From', width: 14 }, { title: 'Household', width: 16 },
        { title: 'Page', width: 24 }, { title: 'Device', width: 40, wrap: true }, { title: 'Screenshots', width: 12 },
        { title: 'Reply', width: 40, wrap: true }, { title: 'Notes', width: 40, wrap: true },
      ],
      rows: items.map((f) => [
        String(f._id), when(f.createdAt), f.kind === 'idea' ? 'Idea' : 'Bug', STATUS[f.status], PRIORITY[f.priority] || '', THEIRS[f.theirPriority] || '',
        f.text, f.byName, homes.get(String(f.householdId)) || '', f.page, f.device, (f.shots || []).length ? `${f.shots.length} (${origin}/feedback/inbox#f-${f._id})` : '',
        f.reply, f.notes,
      ]),
    });
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="nestly-feedback-${q.show}-${day}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file);
  } catch (err) {
    next(err);
  }
});

// ---------- Excel upload: preview, then apply ----------
// Reads the words people type in Excel ("done", "Not planned", "3 Medium"...).
const STATUS_WORDS = [['archived', /archiv|duplicate/], ['no', /not planned|won.?t|wont|no\b|rejected|declined/], ['done', /done|fixed|complete|closed|shipped/], ['planned', /planned|plan|later|soon|in progress|working/], ['new', /new|open/]];
const PRIORITY_WORDS = [['urgent', /urgent|critical|asap/], ['high', /high/], ['medium', /medium|med\b|normal/], ['low', /low|later/]];
const pickWord = (v, words) => { const s = String(v || '').trim().toLowerCase(); if (!s) return ''; const hit = words.find(([, re]) => re.test(s)); return hit ? hit[0] : null; };

router.post('/feedback/inbox/import', parsed(fileParser), async (req, res, next) => {
  try {
    if (!canReview(req)) return res.status(404).send('Not found');
    const fail = (msg) => { req.session.flash = msg; return res.redirect('/feedback/inbox#import'); };
    if (req.uploadError) return fail('Choose an Excel file under 5 MB.');
    if (!req.file) return fail('Choose the Excel file to upload.');
    let sheets;
    try { sheets = readXlsx(req.file.buffer); } catch { return fail('That isn’t an Excel (.xlsx) file Nestly can read. Save it as .xlsx and try again.'); }
    // The sheet with an ID column (the one Nestly made), wherever it is in the workbook.
    const sheet = sheets.find((s) => (s.rows[0] || []).some((h) => String(h).trim().toLowerCase() === 'id'));
    if (!sheet) return fail('No sheet with an ID column. Upload a file downloaded from this inbox.');
    const head = sheet.rows[0].map((h) => String(h).trim().toLowerCase());
    const col = (name) => head.indexOf(name);
    const at = { id: col('id'), status: col('status'), priority: col('priority'), reply: col('reply'), notes: col('notes') };
    const rows = sheet.rows.slice(1).filter((r) => /^[a-f0-9]{24}$/.test(String(r[at.id] || '').trim()));
    if (!rows.length) return fail('No rows with an ID were found.');
    const found = new Map((await Feedback.find({ _id: { $in: rows.map((r) => String(r[at.id]).trim()) }, ...scopeFor(req) }).lean()).map((f) => [String(f._id), f]));
    const changes = [];
    const skipped = [];
    let unknown = 0;
    for (const r of rows) {
      const id = String(r[at.id]).trim();
      const f = found.get(id);
      if (!f) { unknown += 1; continue; }
      const set = {};
      if (at.status >= 0) {
        const s = pickWord(r[at.status], STATUS_WORDS);
        if (s === null) skipped.push(`${f.text.slice(0, 40)}: status “${r[at.status]}” not understood`);
        else if (s && s !== f.status) set.status = s;
      }
      if (at.priority >= 0) {
        const p = pickWord(r[at.priority], PRIORITY_WORDS);
        if (p === null) skipped.push(`${f.text.slice(0, 40)}: priority “${r[at.priority]}” not understood`);
        else if (p !== (f.priority || '')) set.priority = p;
      }
      if (at.reply >= 0) { const v = String(r[at.reply] || '').trim().slice(0, 1000); if (v !== (f.reply || '')) set.reply = v; }
      if (at.notes >= 0) { const v = String(r[at.notes] || '').trim().slice(0, 2000); if (v !== (f.notes || '')) set.notes = v; }
      if (Object.keys(set).length) changes.push({ id, text: f.text.slice(0, 90), byName: f.byName, set, before: { status: f.status, priority: f.priority || '', reply: f.reply || '', notes: f.notes || '' } });
    }
    req.session.feedbackImport = { changes: changes.slice(0, 500), skipped: skipped.slice(0, 50), unknown, rows: rows.length };
    res.redirect('/feedback/inbox/import');
  } catch (err) {
    next(err);
  }
});

router.get('/feedback/inbox/import', (req, res) => {
  if (!canReview(req)) return res.status(404).send('Not found');
  const pending = req.session.feedbackImport;
  if (!pending || pending.done) return res.redirect('/feedback/inbox');
  res.render('feedback-import', { active: 'settings', pending, STATUS, PRIORITY });
});

router.post('/feedback/inbox/import/apply', async (req, res, next) => {
  try {
    if (!canReview(req)) return res.status(404).send('Not found');
    const pending = req.session.feedbackImport;
    if (!pending || pending.done) return res.redirect('/feedback/inbox');
    if ((req.body || {}).action === 'cancel') { delete req.session.feedbackImport; req.session.flash = 'Nothing was changed.'; return res.redirect('/feedback/inbox'); }
    let applied = 0;
    for (const c of pending.changes) {
      const f = await Feedback.findOne({ _id: c.id, ...scopeFor(req) });
      if (!f) continue;
      const before = f.status;
      f.set(c.set);
      await f.save();
      applied += 1;
      if (f.status !== before && String(f.userId) !== String(req.user._id) && f.status !== 'archived') {
        sendToUser(f.userId, { title: `Your ${f.kind === 'idea' ? 'idea' : 'report'}: ${STATUS[f.status]}`, body: f.reply || f.text.slice(0, 120), url: '/feedback', tag: `feedback-${f._id}` }).catch(() => {});
      }
    }
    req.session.feedbackImport = { done: true, applied };
    req.session.flash = `Updated ${applied} from the Excel file.`;
    res.redirect('/feedback/inbox');
  } catch (err) {
    next(err);
  }
});

// ---------- One item: status, priority, reply, notes; archive ----------
router.post('/feedback/:id', async (req, res, next) => {
  try {
    if (!canReview(req) || !mongoose.isValidObjectId(req.params.id)) return res.status(404).send('Not found');
    const f = await Feedback.findOne({ _id: req.params.id, ...scopeFor(req) });
    if (!f) return res.status(404).send('Not found');
    const b = req.body || {};
    const before = f.status;
    if (b.action === 'archive') f.status = 'archived';
    else if (b.action === 'unarchive') f.status = 'new';
    else {
      if (Object.keys(STATUS).includes(b.status)) f.status = b.status;
      if (typeof b.priority === 'string') f.priority = PRIORITY[b.priority] ? b.priority : '';
      if (typeof b.reply === 'string') f.reply = b.reply.trim().slice(0, 1000);
      if (typeof b.notes === 'string') f.notes = b.notes.trim().slice(0, 2000);
    }
    await f.save();
    if (f.status !== before && f.status !== 'archived' && String(f.userId) !== String(req.user._id)) {
      sendToUser(f.userId, { title: `Your ${f.kind === 'idea' ? 'idea' : 'report'}: ${STATUS[f.status]}`, body: f.reply || f.text.slice(0, 120), url: '/feedback', tag: `feedback-${f._id}` }).catch(() => {});
    }
    req.session.flash = b.action === 'archive' ? 'Archived.' : b.action === 'unarchive' ? 'Back in the inbox.' : 'Saved.';
    const back = typeof b.back === 'string' && /^[\w=&%.-]*$/.test(b.back) ? b.back : '';
    res.redirect(`/feedback/inbox${back ? `?${back}` : ''}${b.action === 'archive' ? '' : `#f-${f._id}`}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.isOwner = isOwner;
