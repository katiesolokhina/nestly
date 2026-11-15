// A calendar feed (iCalendar, RFC 5545) that Google Calendar, Apple Calendar, and Outlook can
// subscribe to. Repeating things use the same rules as in Nestly, so they repeat there too.
const { addDays } = require('./dates');

const DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const ymd = (d) => d.replace(/-/g, '');
const hms = (t) => `${t.replace(':', '')}00`;
const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Lines longer than 75 bytes are folded, as the format requires.
function fold(line) {
  const out = [];
  let rest = Buffer.from(line, 'utf8');
  let first = true;
  while (rest.length > (first ? 75 : 74)) {
    let cut = first ? 75 : 74;
    while (cut > 0 && (rest[cut] & 0xc0) === 0x80) cut -= 1; // never split a character in two
    out.push((first ? '' : ' ') + rest.subarray(0, cut).toString('utf8'));
    rest = rest.subarray(cut);
    first = false;
  }
  out.push((first ? '' : ' ') + rest.toString('utf8'));
  return out.join('\r\n');
}

function rrule(x, timed) {
  if (!x.repeat || x.repeat === 'none') return null;
  const parts = [`FREQ=${x.repeat.toUpperCase()}`];
  if ((x.interval || 1) > 1) parts.push(`INTERVAL=${x.interval}`);
  if (x.repeat === 'weekly' && x.days && x.days.length) parts.push(`BYDAY=${x.days.map((d) => DAY[d]).join(',')}`);
  if (x.until) parts.push(`UNTIL=${ymd(x.until)}${timed ? 'T235959Z' : ''}`);
  return `RRULE:${parts.join(';')}`;
}

// One calendar entry. item: { uid, title, date, endDate?, time?, endTime?, details?, location?, url?, repeat... }
function vevent(item, tz, now) {
  const lines = ['BEGIN:VEVENT', `UID:${item.uid}`, `DTSTAMP:${stamp(now)}`, `SUMMARY:${esc(item.title)}`];
  const last = item.endDate && item.endDate > item.date ? item.endDate : item.date;
  if (item.time) {
    lines.push(`DTSTART;TZID=${tz}:${ymd(item.date)}T${hms(item.time)}`);
    if (item.endTime) lines.push(`DTEND;TZID=${tz}:${ymd(last)}T${hms(item.endTime)}`);
    else lines.push('DURATION:PT1H');
  } else {
    lines.push(`DTSTART;VALUE=DATE:${ymd(item.date)}`, `DTEND;VALUE=DATE:${ymd(addDays(last, 1))}`);
  }
  const rule = rrule(item, Boolean(item.time));
  if (rule) lines.push(rule);
  if (item.location) lines.push(`LOCATION:${esc(item.location)}`);
  if (item.details) lines.push(`DESCRIPTION:${esc(item.details)}`);
  if (item.url) lines.push(`URL:${item.url}`);
  lines.push('TRANSP:TRANSPARENT', 'END:VEVENT'); // shows as free time, so it doesn't block scheduling
  return lines;
}

function calendar(name, tz, items, now = new Date()) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nestly//Household//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`, `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ...items.flatMap((i) => vevent(i, tz, now)),
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

module.exports = { calendar, fold, esc, rrule };
