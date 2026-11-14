// When events happen. Dates are YYYY-MM-DD strings; see lib/dates.js.
const { addDays, diffDays, weekday, shortDay, time12 } = require('./dates');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_SPAN = 366;

const parts = (d) => d.split('-').map(Number);
const span = (e) => (e.endDate && e.endDate > e.date ? Math.min(diffDays(e.date, e.endDate), MAX_SPAN) : 0);
const daysOf = (e) => (e.days && e.days.length ? e.days : [weekday(e.date)]);

// Does an occurrence of this event begin on day s?
function startsOn(e, s) {
  if (s < e.date || (e.until && s > e.until)) return false;
  const n = e.interval || 1;
  const [y0, m0] = parts(e.date);
  const [y, m] = parts(s);
  switch (e.repeat || 'none') {
    case 'daily':
      return diffDays(e.date, s) % n === 0;
    case 'weekly': {
      if (!daysOf(e).includes(weekday(s))) return false;
      const weeks = diffDays(addDays(e.date, -weekday(e.date)), addDays(s, -weekday(s))) / 7;
      return weeks % n === 0;
    }
    case 'monthly': // months without that day (like the 31st) are skipped
      return s.slice(8) === e.date.slice(8) && ((y - y0) * 12 + (m - m0)) % n === 0;
    case 'yearly':
      return s.slice(5) === e.date.slice(5) && (y - y0) % n === 0;
    default:
      return s === e.date;
  }
}

// Returns which day of an occurrence `day` is, or null if the event isn't on that day.
function occursOn(e, day) {
  const len = span(e);
  for (let k = 0; k <= len; k += 1) {
    const start = addDays(day, -k);
    if (startsOn(e, start)) return { start, dayIndex: k, span: len };
  }
  return null;
}

// "4:30 PM – 6:00 PM", "All day", or for multi-day events which part of it this day is.
function timeText(e, day) {
  const hit = (day && occursOn(e, day)) || { dayIndex: 0, span: span(e) };
  const range = e.time ? time12(e.time) + (e.endTime ? ` – ${time12(e.endTime)}` : '') : 'All day';
  if (!hit.span) return range;
  const of = `Day ${hit.dayIndex + 1} of ${hit.span + 1}`;
  if (!e.time) return `All day · ${of}`;
  if (hit.dayIndex === 0) return `Starts ${time12(e.time)} · ${of}`;
  if (hit.dayIndex === hit.span) return `${e.endTime ? `Ends ${time12(e.endTime)}` : 'All day'} · ${of}`;
  return `All day · ${of}`;
}

// Sorts timed events by start, and all-day events first.
const sortKey = (e, day) => {
  const hit = occursOn(e, day);
  return hit && hit.dayIndex === 0 && e.time ? e.time : '';
};

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

function repeatText(e) {
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[e.repeat];
  if (!unit) return '';
  const n = e.interval || 1;
  let text = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (e.repeat === 'weekly') {
    const days = [...daysOf(e)].sort();
    const weekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
    text += weekdays ? ' on weekdays' : days.length === 7 ? ', every day' : ` on ${days.map((d) => DAY_NAMES[d]).join(', ')}`;
  }
  if (e.repeat === 'monthly') text += ` on the ${ordinal(Number(e.date.slice(8)))}`;
  if (e.until) text += `, until ${shortDay(e.until)}`;
  return text;
}

module.exports = { occursOn, timeText, sortKey, repeatText, DAY_NAMES };
