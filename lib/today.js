// Builds the Today dashboard from each person's saved layout.
const ShoppingItem = require('../models/ShoppingItem');
const Reminder = require('../models/Reminder');
const Event = require('../models/Event');
const Meal = require('../models/Meal');
const { titled } = require('./meals');
const Recipe = require('../models/Recipe');
const Bill = require('../models/Bill');
const { ensureUpcoming, money } = require('./bills');
const PantryItem = require('../models/PantryItem');
const { expiryText } = require('./pantry');
const { currency } = require('./prefs');
const { visible } = require('./changes');
const { todayIn, addDays, dayLabel, longDay, time12 } = require('./dates');
const { occursOn, timeText, sortKey } = require('./recurrence');
const { categoryColor, reminderColor } = require('./lists');
const { choresWithDue, isFor, dueText } = require('./chores');
const { membersOf } = require('./members');

// Later sections add their cards and tiles here.
const WIDGETS = [
  { k: 'attention', name: 'Needs attention', kind: 'Card', on: true },
  { k: 'shopping', name: 'Shopping list', kind: 'Tile', on: true, feature: 'shopping' },
  { k: 'remember', name: 'To remember', kind: 'Tile', on: true, feature: 'remember' },
  { k: 'meals', name: 'Today’s meals', kind: 'Card', on: true, feature: 'meals' },
  { k: 'upcoming', name: 'Coming up', kind: 'Card', on: true },
  { k: 'events', name: 'Events, next 7 days', kind: 'Tile', on: false, feature: 'calendar' },
  { k: 'bills', name: 'Bills due this week', kind: 'Tile', on: true, feature: 'bills' },
  { k: 'pantry', name: 'Pantry low or out', kind: 'Tile', on: true, feature: 'pantry' },
  { k: 'chores', name: 'Chores today', kind: 'Tile', on: true, feature: 'chores' },
];

// Saved order first, then anything new, without widgets for sections that are turned off.
// member: this person's membership in the household (layouts are per household).
function layoutFor(member, household) {
  const saved = (member.dashboard || []).map((d) => ({ k: d.k, on: d.on }));
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

// today: a YYYY-MM-DD to build it for (the morning email passes its own); default is now.
async function buildToday(user, household, member, { today: day } = {}) {
  const f = household.features;
  const today = day || todayIn(user.timezone);
  const scope = visible(user);
  // Every section loads at the same time; each one waits only for its own steps.
  const bills$ = f.bills !== false
    ? ensureUpcoming(user.householdId, today).then(() => Bill.find({ ...scope, paid: false, dueDate: { $lte: addDays(today, 6) } }).sort({ dueDate: 1 }).lean())
    : [];
  const meals$ = f.meals !== false
    ? Meal.find({ ...scope, date: today }).lean().then(async (raw) => [
      raw,
      raw.some((m) => m.recipeId) && f.recipes !== false ? await Recipe.find({ _id: { $in: raw.map((m) => m.recipeId).filter(Boolean) }, ...scope }, { title: 1 }).lean() : [],
    ])
    : [[], []];
  // Chores for this person (theirs, or anyone's) that are due today or late.
  const chores$ = f.chores !== false
    ? Promise.all([choresWithDue(user.householdId), membersOf(user.householdId)]).then(([all, members]) => all
      .filter((c) => c.due && c.due <= today && isFor(c, user._id, members))
      .sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99')))
    : [];
  const [reminders, events, shoppingCount, bills, pantryLow, expiring, [mealsRaw, mealRecipes], chores, toPutAway] = await Promise.all([
    f.remember !== false ? Reminder.find({ ...scope, done: false }).lean() : [],
    f.calendar !== false ? Event.find(scope).lean() : [],
    f.shopping !== false ? ShoppingItem.countDocuments({ ...scope, bought: false, clearedAt: null }) : 0,
    bills$,
    f.pantry !== false ? PantryItem.countDocuments({ ...scope, status: { $in: ['low', 'out'] } }) : 0,
    f.pantry !== false ? PantryItem.find({ ...scope, expires: { $ne: '', $lte: addDays(today, 1) }, status: { $ne: 'out' } }).sort({ expires: 1 }).limit(10).lean() : [],
    meals$,
    chores$,
    // Bought on Shopping, waiting to go into the pantry.
    f.pantry !== false && f.shopping !== false ? ShoppingItem.countDocuments({ ...scope, bought: true, putAway: 'pending', boughtAt: { $gte: new Date(Date.now() - 14 * 86400000) } }) : 0,
  ]);
  const slotOrder = (s) => { const i = household.mealSlots.indexOf(s); return i < 0 ? 99 : i; };
  const meals = titled(mealsRaw, mealRecipes).sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot))
    .map((m) => ({ slot: m.slot, title: m.name, note: m.note, href: m.hasRecipe ? `/s/recipes/${m.recipeId}` : `/s/meals/${m._id}/edit` }));

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
      section: 'remember',
    })),
    ...bills.filter((b) => b.dueDate <= today).map((b) => ({
      title: b.name,
      meta: `${b.dueDate < today ? `Overdue since ${dayLabel(b.dueDate, today).toLowerCase()}` : 'Due today'} · ${money(b.cents, currency(household))}`,
      late: b.dueDate < today,
      type: 'Bill',
      href: `/s/bills/${b._id}`,
    })),
    ...(toPutAway ? [{ title: `Put away ${toPutAway} ${toPutAway === 1 ? 'thing' : 'things'} from shopping`, meta: 'Add use-by dates and counts in the pantry', type: 'Pantry', href: '/s/pantry#putaway' }] : []),
    ...chores.map((c) => ({
      title: c.title,
      meta: [dueText(c, today), c.room !== 'Anywhere' ? c.room : ''].filter(Boolean).join(' · '),
      late: c.due < today,
      type: 'Chore',
      href: `/s/chores/${c._id}/edit`,
      checkAction: `/s/chores/${c._id}/done`,
      checkLabel: `Mark ${c.title} done`,
      section: 'chores',
    })),
    ...expiring.map((p) => ({ title: p.name, meta: expiryText(p.expires, today).text, late: p.expires < today, type: 'Pantry', href: `/s/pantry#p-${p._id}` })),
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
    chores: { num: chores.length, label: chores.length === 1 ? 'chore to do today' : 'chores to do today', href: '/s/chores?who=me' },
    pantry: { num: pantryLow, label: 'low or out in the pantry', href: '/s/pantry?show=low' },
    bills: { num: bills.length, label: bills.length ? `bills due this week · ${money(bills.reduce((n, b) => n + b.cents, 0), currency(household))}` : 'bills due this week', href: '/s/bills' },
  };
  const late = attention.filter((a) => a.late).length;
  return {
    date: longDay(today),
    greeting: `${greeting(user.timezone)}, ${user.name}`,
    summary: attention.length ? `${attention.length} ${attention.length === 1 ? 'thing' : 'things'} today${late ? `, ${late} overdue` : ''}` : 'Nothing needs you today.',
    attention,
    meals,
    upcoming: upcoming.slice(0, 5),
    tiles,
    widgets: layoutFor(member || user, household).filter((w) => w.on),
  };
}

module.exports = { WIDGETS, layoutFor, buildToday, occursOn };
