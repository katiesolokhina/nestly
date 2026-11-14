// Builds the Today dashboard from each person's saved layout.
const ShoppingItem = require('../models/ShoppingItem');
const Reminder = require('../models/Reminder');
const Event = require('../models/Event');
const { visible } = require('./changes');
const { todayIn, addDays, dayLabel, longDay, time12 } = require('./dates');
const { occursOn, timeText, sortKey } = require('./recurrence');
const { categoryColor, reminderColor } = require('./lists');

// Later sections add their cards and tiles here.
const WIDGETS = [
  { k: 'attention', name: 'Needs attention', kind: 'Card', on: true },
  { k: 'shopping', name: 'Shopping list', kind: 'Tile', on: true, feature: 'shopping' },
  { k: 'remember', name: 'To remember', kind: 'Tile', on: true, feature: 'remember' },
  { k: 'upcoming', name: 'Coming up', kind: 'Card', on: true },
  { k: 'events', name: 'Events, next 7 days', kind: 'Tile', on: false, feature: 'calendar' },
];

// Saved order first, then anything new, without widgets for sections that are turned off.
function layoutFor(user, household) {
  const saved = (user.dashboard || []).map((d) => ({ k: d.k, on: d.on }));
  const all = [...saved, ...WIDGETS.filter((w) => !saved.some((s) => s.k === w.k)).map((w) => ({ k: w.k, on: w.on }))];
  return all
    .map((r) => ({ ...WIDGETS.find((w) => w.k === r.k), on: r.on }))
    .filter((w) => w.k && (!w.feature || household.features[w.feature] !== false));
}


function greeting(tz) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (hour < 12) return 'Good morning';
  return hour < 18 ? 'Good afternoon' : 'Good evening';
}

async function buildToday(user, household) {
  const f = household.features;
  const today = todayIn(user.timezone);
  const scope = visible(user);
  const [reminders, events, shoppingCount] = await Promise.all([
    f.remember !== false ? Reminder.find({ ...scope, done: false }).lean() : [],
    f.calendar !== false ? Event.find(scope).lean() : [],
    f.shopping !== false ? ShoppingItem.countDocuments({ ...scope, bought: false, clearedAt: null }) : 0,
  ]);

  const attention = [
    ...events.filter((e) => occursOn(e, today)).sort((a, b) => sortKey(a, today).localeCompare(sortKey(b, today))).map((e) => ({
      title: e.title, meta: [timeText(e, today), e.location].filter(Boolean).join(' · '), type: 'Event', href: `/s/calendar/${e._id}?day=${today}`, color: categoryColor(household, e.category),
    })),
    ...reminders.filter((r) => r.date && r.date <= today).sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({
      title: r.text,
      meta: r.date < today ? `Overdue since ${dayLabel(r.date, today).toLowerCase()}` : r.time ? `Due today at ${time12(r.time)}` : 'Due today',
      late: r.date < today,
      type: 'Reminder',
      color: reminderColor(household),
      href: `/s/remember/${r._id}`,
      checkAction: `/s/remember/${r._id}/done`,
      checkLabel: `Check off ${r.text}`,
    })),
  ];

  const upcoming = [];
  for (let i = 1; i <= 14 && upcoming.length < 5; i += 1) {
    const day = addDays(today, i);
    const label = dayLabel(day, today);
    events.filter((e) => occursOn(e, day)).forEach((e) => upcoming.push({ title: e.title, color: categoryColor(household, e.category), meta: `${label} · ${timeText(e, day)}`, tag: e.private ? 'Only me' : 'Event', lilac: e.private }));
    reminders.filter((r) => r.date === day).forEach((r) => upcoming.push({ title: r.text, color: reminderColor(household), meta: r.time ? `${label} · ${time12(r.time)}` : label, tag: r.private ? 'Only me' : 'Reminder', lilac: r.private }));
  }

  const weekEvents = events.filter((e) => [0, 1, 2, 3, 4, 5, 6].some((i) => occursOn(e, addDays(today, i)))).length;
  const tiles = {
    shopping: { num: shoppingCount, label: 'on the shopping list', href: '/s/shopping' },
    remember: { num: reminders.length, label: 'to remember', href: '/s/remember' },
    events: { num: weekEvents, label: 'events, next 7 days', href: '/s/calendar' },
  };
  const late = attention.filter((a) => a.late).length;
  return {
    date: longDay(today),
    greeting: `${greeting(user.timezone)}, ${user.name}`,
    summary: attention.length ? `${attention.length} ${attention.length === 1 ? 'thing' : 'things'} today${late ? `, ${late} overdue` : ''}` : 'Nothing needs you today.',
    attention,
    upcoming: upcoming.slice(0, 5),
    tiles,
    widgets: layoutFor(user, household).filter((w) => w.on),
  };
}

module.exports = { WIDGETS, layoutFor, buildToday, occursOn };
