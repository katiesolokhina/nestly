// Report a bug or suggest a feature. Everyone can send one and see their own; whoever runs Nestly
// (OWNER_EMAILS in .env) sees every household's, and household admins see their own household's.
// Each new one is emailed to FEEDBACK_EMAIL (or OWNER_EMAILS) when email is set up.
const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const Feedback = require('../models/Feedback');
const Household = require('../models/Household');
const { sendMail, mailOn } = require('../lib/mail');
const { sendToUser } = require('../lib/push');
const { shortDay } = require('../lib/dates');

const router = express.Router();
router.use('/feedback', requireAuth);

const STATUS = { new: 'New', planned: 'Planned', done: 'Done', no: 'Not planned' };
const KINDS = { bug: 'Something’s wrong', idea: 'An idea' };
const listOf = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isOwner = (user) => listOf(process.env.OWNER_EMAILS).includes(String(user.email || '').toLowerCase());
const canReview = (req) => isOwner(req.user) || Boolean(req.member && req.member.role === 'admin');
const scopeFor = (req) => (isOwner(req.user) ? {} : { householdId: req.user.householdId });
const view = (f) => ({ ...f, day: shortDay(f.createdAt.toISOString().slice(0, 10)), statusName: STATUS[f.status], kindName: KINDS[f.kind] });
// Only paths within Nestly are kept as "where it happened".
const pathOf = (v) => { const s = String(v || ''); return /^\/[\w\-/?=&%.#]*$/.test(s) ? s.slice(0, 300) : ''; };

const sendLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: 'That’s a lot of reports in an hour. Try again later.' });

router.get('/feedback', async (req, res, next) => {
  try {
    const mine = (await Feedback.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(20).lean()).map(view);
    const fresh = canReview(req) ? await Feedback.countDocuments({ ...scopeFor(req), status: 'new' }) : 0;
    res.render('feedback', { active: 'settings', mine, KINDS, kind: req.query.kind === 'idea' ? 'idea' : 'bug', from: pathOf(req.query.from), canReview: canReview(req), fresh });
  } catch (err) {
    next(err);
  }
});

router.post('/feedback', sendLimit, async (req, res, next) => {
  try {
    const b = req.body || {};
    const text = String(b.text || '').trim().slice(0, 2000);
    if (!text) { req.session.flash = 'Write what happened, or your idea, first.'; return res.redirect('/feedback'); }
    const f = await Feedback.create({
      householdId: req.user.householdId, userId: req.user._id, byName: req.user.name,
      kind: b.kind === 'idea' ? 'idea' : 'bug', text, page: pathOf(b.page),
      device: b.kind === 'idea' ? '' : String(req.get('User-Agent') || '').slice(0, 300),
    });
    const to = process.env.FEEDBACK_EMAIL || process.env.OWNER_EMAILS;
    if (to && mailOn()) {
      const home = await Household.findById(req.user.householdId, { name: 1 }).lean();
      const origin = (process.env.APP_ORIGIN || '').replace(/\/$/, '');
      sendMail({
        to,
        subject: `Nestly ${f.kind === 'idea' ? 'idea' : 'bug'} from ${f.byName}`,
        text: `${f.text}\n\n${f.byName} (${req.user.email}) · ${home ? home.name : ''}${f.page ? `\nPage: ${f.page}` : ''}${f.device ? `\nDevice: ${f.device}` : ''}\n\n${origin}/feedback/inbox`,
      }).catch((err) => console.error('Feedback email failed:', err.message));
    }
    req.session.flash = f.kind === 'idea' ? 'Thanks! Your idea was sent.' : 'Thanks! Your report was sent.';
    res.redirect('/feedback');
  } catch (err) {
    next(err);
  }
});

router.get('/feedback/inbox', async (req, res, next) => {
  try {
    if (!canReview(req)) return res.status(404).send('Not found');
    const show = Object.keys(STATUS).includes(req.query.status) ? req.query.status : '';
    const filter = { ...scopeFor(req), ...(show ? { status: show } : { status: { $in: ['new', 'planned'] } }) };
    const items = (await Feedback.find(filter).sort({ createdAt: -1 }).limit(200).lean()).map(view);
    const homes = isOwner(req.user) ? new Map((await Household.find({ _id: { $in: [...new Set(items.map((i) => String(i.householdId)))] } }, { name: 1 }).lean()).map((h) => [String(h._id), h.name])) : new Map();
    res.render('feedback-inbox', { active: 'settings', items: items.map((i) => ({ ...i, home: homes.get(String(i.householdId)) || '' })), show, STATUS, owner: isOwner(req.user) });
  } catch (err) {
    next(err);
  }
});

// Status and an optional reply; the person who sent it hears about it.
router.post('/feedback/:id', async (req, res, next) => {
  try {
    if (!canReview(req) || !mongoose.isValidObjectId(req.params.id)) return res.status(404).send('Not found');
    const f = await Feedback.findOne({ _id: req.params.id, ...scopeFor(req) });
    if (!f) return res.status(404).send('Not found');
    const b = req.body || {};
    const before = f.status;
    if (Object.keys(STATUS).includes(b.status)) f.status = b.status;
    if (typeof b.reply === 'string') f.reply = b.reply.trim().slice(0, 1000);
    await f.save();
    if (f.status !== before && String(f.userId) !== String(req.user._id)) {
      sendToUser(f.userId, { title: `Your ${f.kind === 'idea' ? 'idea' : 'report'}: ${STATUS[f.status]}`, body: f.reply || f.text.slice(0, 120), url: '/feedback', tag: `feedback-${f._id}` }).catch(() => {});
    }
    req.session.flash = 'Saved.';
    res.redirect(`/feedback/inbox${typeof b.back === 'string' && /^\?status=\w+$/.test(b.back) ? b.back : ''}#f-${f._id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.isOwner = isOwner;
