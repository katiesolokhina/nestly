// One search across every section this person can see. Hidden Home info values are never
// searched, and other people's "Only me" items never show up.
const express = require('express');
const { requireAuth, requirePage } = require('../middleware/auth');
const { visible } = require('../lib/changes');
const { todayIn, dayLabel, shortDay } = require('../lib/dates');
const { money } = require('../lib/bills');
const { currency } = require('../lib/prefs');
const { dueOf, lastDoneMap } = require('../lib/chores');

const router = express.Router();
const M = (name) => require(`../models/${name}`);
const LIMIT = 8;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/search', requireAuth, requirePage('search'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return res.render('search', { active: 'search', q, groups: [], total: 0 });
    const re = new RegExp(escapeRe(q), 'i');
    const scope = visible(req.user);
    const own = { householdId: req.user.householdId };
    const today = todayIn(req.user.timezone);
    const cur = currency(req.household);
    // Matches go in $and, so they never replace the $or in `scope` that keeps private items private.
    const any = (...fields) => ({ $and: [{ $or: fields.map((f) => ({ [f]: re })) }] });

    // Each section: [key, title, query (or null when hidden), how a match is shown]
    const sections = [
      ['shopping', 'Shopping', () => M('ShoppingItem').find({ ...scope, clearedAt: null, ...any('name', 'brand', 'note', 'store') }).sort({ bought: 1, boughtAt: -1 }).limit(50).lean()
        // Bought several times: once, as the most recent.
        .then((rows) => rows.filter((r, i) => rows.findIndex((x) => x.key === r.key) === i).slice(0, LIMIT)),
        (i) => ({ title: i.name, meta: [i.bought ? 'Bought' : 'On the list', i.store !== 'Any store' ? i.store : '', i.brand].filter(Boolean).join(' · '), href: `/s/shopping/${i._id}/edit` })],
      ['shopping', 'Saved items', () => M('CatalogItem').find({ ...own, ...any('name', 'brand') }).limit(LIMIT).lean(),
        (i) => ({ title: i.name, meta: ['Saved item', i.staple ? 'Staple' : ''].filter(Boolean).join(' · '), href: `/s/shopping/saved/${i._id}` })],
      ['remember', 'Remember', () => M('Reminder').find({ ...scope, done: false, ...any('text', 'details') }).limit(LIMIT).lean(),
        (r) => ({ title: r.text, meta: r.date ? dayLabel(r.date, today) : 'No date', href: `/s/remember/${r._id}` })],
      ['calendar', 'Calendar', () => M('Event').find({ ...scope, ...any('title', 'location', 'details') }).sort({ date: -1 }).limit(LIMIT).lean(),
        (e) => ({ title: e.title, meta: [shortDay(e.date), e.location].filter(Boolean).join(' · '), href: `/s/calendar/${e._id}` })],
      ['recipes', 'Recipes', () => M('Recipe').find({ ...scope, ...any('title', 'ingredients.name', 'notes') }).limit(LIMIT).lean(),
        (r) => {
          const ing = (r.ingredients || []).find((x) => re.test(x.name || ''));
          return { title: r.title, meta: ing && !re.test(r.title) ? `Uses ${ing.name}` : r.category, href: `/s/recipes/${r._id}` };
        }],
      ['meals', 'Meals', () => M('Meal').find({ ...scope, ...any('title', 'note') }).sort({ date: -1 }).limit(LIMIT).lean(),
        (m) => ({ title: m.title || m.note, meta: `${m.slot} · ${shortDay(m.date)}`, href: `/s/meals?week=${m.date}` })],
      ['pantry', 'Pantry', () => M('PantryItem').find({ ...scope, ...any('name', 'note', 'amount') }).limit(LIMIT).lean(),
        (p) => ({ title: p.name, meta: [p.spot, { have: 'Have', low: 'Low', out: 'Out' }[p.status]].join(' · '), href: `/s/pantry#p-${p._id}` })],
      ['bills', 'Bills', () => M('Bill').find({ ...scope, ...any('name', 'note', 'category') }).sort({ dueDate: -1 }).limit(LIMIT).lean(),
        (b) => ({ title: b.name, meta: `${money(b.cents, cur)} · ${b.paid ? 'Paid' : `Due ${shortDay(b.dueDate)}`}`, href: `/s/bills/${b._id}` })],
      ['chores', 'Chores', () => M('Chore').find({ ...own, ...any('title', 'details', 'room') }).limit(LIMIT).lean(),
        (c) => ({ title: c.title, meta: c.room, href: `/s/chores/${c._id}/edit` })],
      ['lists', 'Lists', () => M('List').find({ ...scope, ...any('title', 'body', 'items.text', 'items.note') }).limit(LIMIT).lean(),
        (l) => {
          const hit = (l.items || []).find((x) => re.test(x.text) || re.test(x.note || ''));
          return { title: l.title, meta: hit && !re.test(l.title) ? `Has ${hit.text}` : l.type === 'note' ? 'Note' : `${(l.items || []).length} on the list`, href: `/s/lists/${l._id}` };
        }],
      ['info', 'Home info', () => M('InfoItem').find({
        ...scope,
        $and: [{ $or: [{ title: re }, { notes: re }, { type: re }, { fields: { $elemMatch: { kind: { $ne: 'secret' }, $or: [{ label: re }, { value: re }] } } }] }],
      }).limit(LIMIT).lean(),
        (i) => {
          const f = (i.fields || []).find((x) => x.kind !== 'secret' && (re.test(x.label) || re.test(x.value)));
          return { title: i.title, meta: f && !re.test(i.title) ? `${f.label}: ${f.value}`.slice(0, 80) : i.type, href: `/s/info/${i._id}` };
        }],
    ].filter(([key]) => req.sees(key));

    const found = await Promise.all(sections.map(([, , run]) => run()));
    // Chores also say when they're next due.
    const choreIdx = sections.findIndex(([, title]) => title === 'Chores');
    if (choreIdx >= 0 && found[choreIdx].length) {
      const last = await lastDoneMap(req.user.householdId, found[choreIdx].map((c) => c._id));
      found[choreIdx] = found[choreIdx].map((c) => ({ ...c, nextDue: dueOf(c, last.get(String(c._id))) }));
    }
    const groups = sections.map(([key, title, , show], i) => ({
      key,
      title: title === 'Saved items' || title === 'Home info' ? title : res.locals.secName(key),
      items: found[i].map((x) => {
        const row = show(x);
        if (key === 'chores') row.meta = [x.room !== 'Anywhere' ? x.room : '', x.nextDue ? `Next: ${dayLabel(x.nextDue, today)}` : 'Done'].filter(Boolean).join(' · ');
        return row;
      }),
    })).filter((g) => g.items.length);
    res.render('search', { active: 'search', q, groups, total: groups.reduce((n, g) => n + g.items.length, 0) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
