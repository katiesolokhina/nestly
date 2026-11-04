// Dates are local calendar strings (YYYY-MM-DD) in each person's time zone. Arithmetic runs on
// UTC midnights, so daylight-saving changes can never skip or repeat a day.
const toUtc = (d) => { const [y, m, n] = d.split('-').map(Number); return Date.UTC(y, m - 1, n); };
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const addDays = (d, n) => fromUtc(toUtc(d) + n * 86400000);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && fromUtc(toUtc(v)) === v;

const fmt = (d, options) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(toUtc(d));

function dayLabel(d, today) {
  if (d === today) return 'Today';
  if (d === addDays(today, 1)) return 'Tomorrow';
  if (d === addDays(today, -1)) return 'Yesterday';
  return fmt(d, { weekday: 'short', month: 'short', day: 'numeric' });
}
const longDay = (d) => fmt(d, { weekday: 'long', month: 'long', day: 'numeric' });
const monthLabel = (ym) => fmt(`${ym}-01`, { month: 'long', year: 'numeric' });

function shiftMonth(ym, by) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

// Blank cells before the 1st, then every day of the month.
function monthCells(ym) {
  const [y, m] = ym.split('-').map(Number);
  const blanks = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { blanks, days: Array.from({ length: days }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`) };
}

function time12(t) {
  if (!t) return 'All day';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

module.exports = { todayIn, addDays, isDate, dayLabel, longDay, monthLabel, shiftMonth, monthCells, time12 };
