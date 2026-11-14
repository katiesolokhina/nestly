// When an event notifies: set on each event, never by a household or personal default.
// Stored on the event as 'none' or a number of minutes before the start ('120' = 2 hours before).
// All-day events notify at each person's morning time, on the day or whole days before.
// Older events saved before this have 'default': 1 hour before, or the morning of for all-day.

const MAX = 4 * 10080; // four weeks
const TIMED = [0, 5, 10, 15, 30, 60, 120, 180, 1440, 2880, 10080];
const ALL_DAY = [0, 1440, 2880, 10080];
const UNITS = { minutes: 1, hours: 60, days: 1440, weeks: 10080 };

function lead(e) {
  const v = e.alert;
  if (v === 'none') return null;
  if (v === undefined || v === '' || v === 'default' || !/^\d+$/.test(String(v))) return e.time ? 60 : 0;
  const n = Math.min(MAX, Number(v));
  return e.time ? n : Math.round(n / 1440) * 1440;
}

function duration(min) {
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (min % 10080 === 0) return plural(min / 10080, 'week');
  if (min % 1440 === 0) return plural(min / 1440, 'day');
  if (min < 60) return plural(min, 'minute');
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h >= 24 && m === 0) return `${plural(Math.floor(h / 24), 'day')} ${plural(h % 24, 'hour')}`;
  return m ? `${plural(h, 'hour')} ${plural(m, 'minute')}` : plural(h, 'hour');
}

// "2 hours before", "At start time", "Morning of", "Morning, 2 days before".
function alertText(e) {
  const n = lead(e);
  if (n === null) return 'No notification';
  if (e.time) return n === 0 ? 'At start time' : `${duration(n)} before`;
  if (n === 0) return 'Morning of';
  return n === 1440 ? 'Morning, the day before' : `Morning, ${duration(n)} before`;
}

// Choices for the event form, each marked for timed events, all-day events, or both.
function choices() {
  return [
    { value: 'none', label: 'No notification', kind: 'both' },
    ...TIMED.map((n) => ({ value: String(n), label: alertText({ time: '09:00', alert: String(n) }), kind: 'timed' })),
    ...ALL_DAY.map((n) => ({ value: String(n), label: alertText({ time: '', alert: String(n) }), kind: 'allday' })),
    { value: 'custom', label: 'Custom…', kind: 'both' },
  ];
}

// What the form shows as picked for an event: a listed choice, or Custom with an amount and unit.
function picked(e) {
  const n = lead(e);
  if (n === null) return { value: 'none', amount: '', unit: 'hours' };
  if ((e.time ? TIMED : ALL_DAY).includes(n)) return { value: String(n), amount: '', unit: 'hours' };
  const unit = ['weeks', 'days', 'hours'].find((u) => n % UNITS[u] === 0) || 'minutes';
  return { value: 'custom', amount: String(n / UNITS[unit]), unit };
}

// Reads the form. Returns { alert } or { error }.
function readAlert(b, allDay) {
  if (b.alert === 'none') return { alert: 'none' };
  let n;
  if (b.alert === 'custom') {
    const amount = Number(b.alertAmount);
    const unit = UNITS[b.alertUnit] || 0;
    if (!Number.isInteger(amount) || amount < 0 || !unit) return { error: 'Enter how long before to notify, as a whole number.' };
    n = amount * unit;
    if (n > MAX) return { error: 'Notifications can be up to 4 weeks before.' };
  } else if (/^\d+$/.test(String(b.alert || ''))) {
    n = Math.min(MAX, Number(b.alert));
  } else {
    n = allDay ? 0 : 60;
  }
  if (allDay) n = Math.round(n / 1440) * 1440;
  return { alert: String(n) };
}

module.exports = { lead, alertText, choices, picked, readAlert, duration };
