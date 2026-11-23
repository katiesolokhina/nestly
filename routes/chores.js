const express = require('express');
const { defaultsOf } = require('../lib/defaults');
const mongoose = require('mongoose');
const { requireAuth, requireSection } = require('../middleware/auth');
const Chore = require('../models/Chore');
const ChoreDone = require('../models/ChoreDone');
const RewardClaim = require('../models/RewardClaim');
const { recordChange } = require('../lib/changes');
const { logActivity } = require('../lib/activity');
const { pick } = require('../lib/lists');
const { permsFor, roleName } = require('../lib/perms');
const { membersOf, inHome } = require('../lib/members');
const { sendToUser } = require('../lib/push');
const { isQuick, takeUndo } = require('../lib/quick');
const { todayIn, addDays, isDate, weekday, dayLabel, shortDay } = require('../lib/dates');
const { repeatText, DAY_NAMES } = require('../lib/recurrence');
const { choresWithDue, lastDoneMap, doneFor, dueOf, assigneeOf, isFor, dueText, pointsOn, earns, balances } = require('../lib/chores');

const router = express.Router();
router.use('/s/chores', requireAuth, requireSection('chores'));
const SECTION = 'Chores';
const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const body = (req) => req.body || {};

async function find(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Chore.findOne({ _id: req.params.id, householdId: req.user.householdId });
}

// People a chore can go to: everyone whose role can see Chores.
async function doers(req) {
  return (await membersOf(req.user.householdId)).filter((m) => permsFor(req.household, m).level('chores') !== 'hidden');
}

// ---------- The list ----------
router.get('/s/chores', async (req, res, next) => {
  try {
    const h = req.household;
    const today = todayIn(req.user.timezone);
    const who = req.query.who === 'me' ? 'me' : 'all';
    const room = [...h.choreRooms, 'Anywhere'].includes(req.query.room) ? req.query.room : '';
    const group = req.query.group === 'room' ? 'room' : 'day';
    const [members, withDue, recent] = await Promise.all([
      doers(req),
      choresWithDue(req.user.householdId, room ? { room } : {}),
      // Done in the last week, newest first.
      ChoreDone.find({ householdId: req.user.householdId, createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } }).sort({ createdAt: -1 }).limit(15).lean(),
    ]);
    let chores = withDue.filter((c) => c.due);
    if (who === 'me') chores = chores.filter((c) => isFor(c, req.user._id, members));
    chores.sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99') || a.title.localeCompare(b.title));
    const showPoints = pointsOn(h) && req.perms.can('chores', 'rewards');
    const rows = chores.map((c) => {
      const a = assigneeOf(c, members);
      return {
        ...c,
        late: c.due < today,
        meta: [dueText(c, today), group === 'day' && c.room !== 'Anywhere' ? c.room : '', a ? (String(a._id) === req.user.id ? 'You' : a.name) : 'Anyone', repeatText(c)].filter(Boolean).join(' · '),
        pts: showPoints && c.points ? c.points : 0,
      };
    });
    let groups;
    if (group === 'room') {
      groups = [...h.choreRooms, 'Anywhere'].map((r) => ({ name: r, items: rows.filter((c) => c.room === r || (r === 'Anywhere' && !h.choreRooms.includes(c.room))) }));
    } else {
      const week = addDays(today, 6);
      groups = [
        { name: 'Overdue', items: rows.filter((c) => c.due < today) },
        { name: 'Today', items: rows.filter((c) => c.due === today) },
        { name: 'This week', items: rows.filter((c) => c.due > today && c.due <= week) },
        { name: 'Later', items: rows.filter((c) => c.due > week) },
      ];
    }
    groups = groups.filter((g) => g.items.length);
    const query = new URLSearchParams(Object.entries({ who: who === 'me' ? 'me' : '', room, group: group === 'room' ? 'room' : '' }).filter(([, v]) => v)).toString();
    res.render('chores/list', {
      active: 'chores', groups, who, room, group, query, showPoints,
      count: rows.filter((c) => c.due <= today).length,
      recent: recent.map((d) => ({ ...d, meta: [d.byName, dayLabel(d.createdAt.toISOString().slice(0, 10), today), showPoints && d.points ? `+${d.points} points` : ''].filter(Boolean).join(' · ') })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Add and edit ----------
function readForm(req, members) {
  const b = body(req);
  const h = req.household;
  const date = String(b.date || '');
  const repeat = REPEATS.includes(b.repeat) ? b.repeat : 'none';
  const picked = [...new Set([].concat(b.days || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const assignee = members.find((m) => String(m._id) === String(b.assignee));
  const values = {
    title: String(b.title || '').trim().slice(0, 120),
    details: String(b.details || '').trim().slice(0, 1000),
    room: [...h.choreRooms, 'Anywhere'].includes(b.room) ? b.room : 'Anywhere',
    assignee: assignee ? assignee._id : null,
    date: isDate(date) ? date : '',
    time: TIME.test(b.time || '') ? b.time : '',
    repeat,
    interval: repeat === 'none' ? 1 : Math.min(99, Math.max(1, parseInt(b.interval, 10) || 1)),
    days: repeat === 'weekly' ? (picked.length ? picked : isDate(date) ? [weekday(date)] : []) : [],
    until: repeat !== 'none' && isDate(b.until) ? b.until : '',
  };
  if (pointsOn(h)) values.points = Math.min(1000, Math.max(0, parseInt(b.points, 10) || 0));
  let error = null;
  if (!values.title) error = 'Enter the chore.';
  else if (!values.date) error = 'Choose when it’s due.';
  else if (values.until && values.until < values.date) error = 'Repeat until must be on or after the first due date.';
  return { values, error };
}

async function formView(req, item, error, members) {
  const history = item._id ? await ChoreDone.find({ choreId: item._id, householdId: req.user.householdId }).sort({ createdAt: -1 }).limit(5).lean() : [];
  return { active: 'chores', item, error: error || null, members: members || (await doers(req)), dayNames: DAY_NAMES, showPoints: pointsOn(req.household), history: history.map((d) => ({ ...d, day: shortDay(d.date) })) };
}

router.get('/s/chores/new', async (req, res, next) => {
  try {
    const d = defaultsOf(req.household);
    const item = { _id: null, title: '', details: '', room: req.household.choreRooms.includes(req.query.room) ? req.query.room : d.choreRoom || 'Anywhere', assignee: d.choreWho || null, date: todayIn(req.user.timezone), time: '', repeat: 'none', interval: 1, days: [], until: '', points: 1 };
    res.render('chores/form', await formView(req, item));
  } catch (err) {
    next(err);
  }
});

router.post('/s/chores', async (req, res, next) => {
  try {
    const members = await doers(req);
    const { values, error } = readForm(req, members);
    if (error) return res.status(422).render('chores/form', await formView(req, { ...values, _id: null }, error, members));
    const chore = await Chore.create({ ...values, householdId: req.user.householdId, createdBy: req.user._id, byName: req.user.name });
    await recordChange(req, { kind: 'create', model: 'Chore', doc: chore, section: SECTION, text: `added the chore ${chore.title}`, label: chore.title });
    res.redirect('/s/chores');
  } catch (err) {
    next(err);
  }
});

// ---------- Points and rewards (only when turned on in settings) ----------
router.get('/s/chores/points', async (req, res, next) => {
  try {
    const h = req.household;
    if (!pointsOn(h)) return res.redirect('/s/chores');
    const [members, bal, claims] = await Promise.all([
      membersOf(req.user.householdId),
      balances(req.user.householdId),
      RewardClaim.find({ householdId: req.user.householdId }).sort({ createdAt: -1 }).limit(30).lean(),
    ]);
    const earners = members.filter((m) => earns(h, m.role)).map((m) => {
      const b = bal.get(String(m._id)) || { earned: 0, spent: 0 };
      return { _id: m._id, name: m.name, role: roleName(h, m.role), points: b.earned - b.spent, earned: b.earned };
    }).sort((a, b) => b.points - a.points);
    const me = earners.find((e) => String(e._id) === req.user.id) || null;
    res.render('chores/points', {
      active: 'chores',
      earners,
      me,
      rewards: h.rewards || [],
      canDecide: req.perms.settings,
      asked: claims.filter((c) => c.status === 'asked'),
      past: claims.filter((c) => c.status !== 'asked').slice(0, 10),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/s/chores/rewards/:rid/claim', async (req, res, next) => {
  try {
    const h = req.household;
    const reward = (h.rewards || []).find((r) => String(r._id) === req.params.rid);
    if (!pointsOn(h) || !reward || !earns(h, req.member.role)) return res.redirect('/s/chores/points');
    const b = (await balances(req.user.householdId)).get(req.user.id) || { earned: 0, spent: 0 };
    if (b.earned - b.spent < reward.cost) {
      req.session.flash = `${reward.name} needs ${reward.cost} points. You have ${b.earned - b.spent}.`;
      return res.redirect('/s/chores/points');
    }
    await RewardClaim.create({ householdId: h._id, userId: req.user._id, byName: req.user.name, name: reward.name, cost: reward.cost });
    await logActivity(req.user, { section: SECTION, text: `${req.user.name} asked for ${reward.name} (${reward.cost} points)` });
    // Tell whoever can say yes.
    const deciders = (await membersOf(h._id)).filter((m) => permsFor(h, m).settings && String(m._id) !== req.user.id);
    await Promise.all(deciders.map((m) => sendToUser(m._id, { title: `${req.user.name} wants a reward`, body: `${reward.name} · ${reward.cost} points`, url: inHome(h._id, '/s/chores/points'), tag: 'reward' }).catch(() => 0)));
    req.session.flash = `Asked for ${reward.name}. Your points are set aside until someone says yes or no.`;
    res.redirect('/s/chores/points');
  } catch (err) {
    next(err);
  }
});

router.post('/s/chores/claims/:id/:decision', async (req, res, next) => {
  try {
    const { decision } = req.params;
    if (!req.perms.settings || !['give', 'decline'].includes(decision) || !mongoose.isValidObjectId(req.params.id)) return res.status(404).send('Not found');
    const claim = await RewardClaim.findOne({ _id: req.params.id, householdId: req.user.householdId, status: 'asked' });
    if (!claim) return res.redirect('/s/chores/points');
    claim.status = decision === 'give' ? 'given' : 'declined';
    claim.decidedBy = req.user.name;
    await claim.save();
    await logActivity(req.user, { section: SECTION, text: decision === 'give' ? `${req.user.name} gave ${claim.byName} ${claim.name}` : `${req.user.name} said no to ${claim.name} for ${claim.byName}; the points went back` });
    await sendToUser(claim.userId, { title: decision === 'give' ? `Yes: ${claim.name}` : `Not this time: ${claim.name}`, body: decision === 'give' ? `${req.user.name} said yes.` : `${req.user.name} said no, and your ${claim.cost} points are back.`, url: inHome(req.user.householdId, '/s/chores/points'), tag: `claim-${claim._id}` }).catch(() => 0);
    res.redirect('/s/chores/points');
  } catch (err) {
    next(err);
  }
});

// ---------- One chore ----------
router.get('/s/chores/:id/edit', async (req, res, next) => {
  try {
    const chore = await find(req);
    if (!chore) return res.status(404).send('Not found');
    res.render('chores/form', await formView(req, chore.toObject()));
  } catch (err) {
    next(err);
  }
});

router.post('/s/chores/:id', async (req, res, next) => {
  try {
    const chore = await find(req);
    if (!chore) return res.status(404).send('Not found');
    const members = await doers(req);
    const { values, error } = readForm(req, members);
    if (error) return res.status(422).render('chores/form', await formView(req, { ...chore.toObject(), ...values }, error, members));
    const before = chore.toObject();
    chore.set(values);
    await chore.save();
    await recordChange(req, { kind: 'update', model: 'Chore', doc: chore, before, section: SECTION, text: `edited the chore ${chore.title}`, label: chore.title });
    res.redirect('/s/chores');
  } catch (err) {
    next(err);
  }
});

router.post('/s/chores/:id/delete', async (req, res, next) => {
  try {
    const chore = await find(req);
    if (!chore) return res.redirect('/s/chores');
    const before = chore.toObject();
    await chore.deleteOne();
    await recordChange(req, { kind: 'delete', model: 'Chore', doc: chore, before, section: SECTION, text: `deleted the chore ${chore.title}`, label: chore.title });
    res.redirect('/s/chores');
  } catch (err) {
    next(err);
  }
});

// Done: counts for today's (or the most recent missed) due day, or the next one if done early.
router.post('/s/chores/:id/done', async (req, res, next) => {
  try {
    const back = body(req).from === 'today' ? '/' : `/s/chores${/^[\w%+=&.\-]*$/.test(String(body(req).query || '')) && body(req).query ? `?${body(req).query}` : ''}`;
    const chore = await find(req);
    const today = todayIn(req.user.timezone);
    const last = chore ? (await lastDoneMap(req.user.householdId, [chore._id])).get(String(chore._id)) : null;
    const date = chore && doneFor(chore, last, today);
    // Already done (a double tap, or someone else got there first): nothing more to do.
    if (!date || (body(req).due && body(req).due !== dueOf(chore, last))) {
      if (isQuick(req)) return res.json({ ok: true, already: true });
      if (chore) req.session.flash = `${chore.title} is already done.`;
      return res.redirect(back);
    }
    const points = earns(req.household, req.member.role) ? chore.points || 0 : 0;
    const done = await ChoreDone.create({ householdId: req.user.householdId, choreId: chore._id, title: chore.title, userId: req.user._id, byName: req.user.name, date, points });
    await recordChange(req, { kind: 'create', model: 'ChoreDone', doc: done, section: SECTION, text: `did ${chore.title}${points ? ` (+${points} points)` : ''}`, label: `${chore.title} as done` });
    if (isQuick(req)) return res.json({ ok: true, undo: await takeUndo(req) });
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
