// Once a minute: sends reminder and event notifications that are due.
//
// - Times are worked out in each person's own time zone and with their own morning time.
// - "Due" means the notify time passed within the last hour. That covers a restart or a missed
//   tick without sending a 9 AM reminder at 4 PM.
// - NotifyLog's unique index means each notification reaches each person once.
// - Editing a reminder's date or time, or an event's time or alert, makes a new notification.

const User = require('../models/User');
const Reminder = require('../models/Reminder');
const Event = require('../models/Event');
const PushSubscription = require('../models/PushSubscription');
const NotifyLog = require('../models/NotifyLog');
const { sendToUser } = require('./push');
const { addDays, diffDays, dayLabel, time12 } = require('./dates');
const { occursOn } = require('./recurrence');

const WINDOW_MIN = 60;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Today's date and the minutes since midnight, in a time zone.
function localNow(timeZone, now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((x) => [x.type, x.value])
  );
  return { today: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

const morningOf = (user) => (user.notify && TIME.test(user.notify.morning) ? user.notify.morning : '08:00');

// Is a notify time ({date, min}) due right now? Minutes are counted from today's midnight.
function isDue(at, now) {
  const t = diffDays(now.today, at.date) * 1440 + at.min;
  return t <= now.min && now.min < t + WINDOW_MIN;
}

// When a reminder notifies this person: its time on its date, or their morning time.
function reminderAt(r, user) {
  if (!r.date) return null;
  return { date: r.date, min: toMin(TIME.test(r.time || '') ? r.time : morningOf(user)) };
}

function reminderRecipients(r, members) {
  const mine = members.filter((m) => String(m._id) === String(r.createdBy));
  if (r.private) return r.notify === 'none' ? [] : mine;
  if (r.notify === 'none') return [];
  if (r.notify === 'me') return mine;
  if (r.notify === 'some') return members.filter((m) => (r.notifyTo || []).some((id) => String(id) === String(m._id)));
  return members;
}

// The lead time this person gets for an event, in minutes, or null for none.
function leadFor(e, user) {
  const n = user.notify || {};
  let v = e.alert || 'default';
  if (v === 'default') v = e.time ? n.eventTimed || '60' : n.eventAllDay || '0';
  if (v === 'none') return null;
  const lead = Number(v);
  if (!e.time) return lead >= 1440 ? 1440 : 0; // all day: morning of, or the morning before
  return lead;
}

// Notify times for occurrences of an event starting around today (a lead can reach a day ahead).
function eventAlerts(e, user, today) {
  const lead = leadFor(e, user);
  if (lead === null) return [];
  const out = [];
  for (let i = -1; i <= 2; i += 1) {
    const start = addDays(today, i);
    const hit = occursOn(e, start);
    if (!hit || hit.start !== start) continue;
    let at;
    if (e.time) {
      const t = toMin(e.time) - lead;
      const shift = Math.floor(t / 1440);
      at = { date: addDays(start, shift), min: t - shift * 1440 };
    } else {
      at = { date: lead ? addDays(start, -1) : start, min: toMin(morningOf(user)) };
    }
    out.push({ start, lead, at });
  }
  return out;
}

function eventBody(e, start, today) {
  const day = dayLabel(start, today);
  const when = e.time ? `${day} at ${time12(e.time)}` : `${day}, all day`;
  return [when, e.location].filter(Boolean).join(' · ');
}

// Claims one notification for one person; false if it was already sent.
async function claim(key, userId) {
  try {
    await NotifyLog.create({ key, userId });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
}

async function tick(now = new Date(), send = sendToUser) {
  // Only people with a device turned on, so households nobody gets notified in cost nothing.
  const ids = await PushSubscription.distinct('userId');
  if (!ids.length) return 0;
  const users = await User.find({ _id: { $in: ids }, disabled: { $ne: true } }, { householdId: 1, timezone: 1, notify: 1, name: 1 }).lean();
  const byHome = new Map();
  users.forEach((u) => byHome.set(String(u.householdId), [...(byHome.get(String(u.householdId)) || []), u]));

  let sent = 0;
  for (const [householdId, members] of byHome) {
    const anyDay = localNow('UTC', now).today;
    const [reminders, events] = await Promise.all([
      Reminder.find({ householdId, done: false, date: { $gte: addDays(anyDay, -2), $lte: addDays(anyDay, 2) } }).lean(),
      Event.find({ householdId }).lean(),
    ]);

    for (const r of reminders) {
      for (const user of reminderRecipients(r, members)) {
        if (user.notify && user.notify.reminders === false) continue;
        const at = reminderAt(r, user);
        if (!at || !isDue(at, localNow(user.timezone, now))) continue;
        if (!(await claim(`rem:${r._id}:${at.date}:${at.min}`, user._id))) continue;
        sent += await send(user._id, {
          title: r.text,
          body: r.details || (r.time ? `Reminder for ${time12(r.time)}` : 'Reminder for today'),
          url: `/s/remember/${r._id}/edit`,
          tag: `rem-${r._id}`,
        });
      }
    }

    for (const e of events) {
      const people = e.private ? members.filter((m) => String(m._id) === String(e.createdBy)) : members;
      for (const user of people) {
        if (user.notify && user.notify.events === false) continue;
        const local = localNow(user.timezone, now);
        for (const a of eventAlerts(e, user, local.today)) {
          if (!isDue(a.at, local)) continue;
          if (!(await claim(`evt:${e._id}:${a.start}:${e.time || 'allday'}:${a.lead}`, user._id))) continue;
          sent += await send(user._id, {
            title: e.title,
            body: eventBody(e, a.start, local.today),
            url: `/s/calendar/${e._id}?day=${a.start}`,
            tag: `evt-${e._id}-${a.start}`,
          });
        }
      }
    }
  }
  return sent;
}

function startNotifications() {
  let running = false;
  const run = async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error('Notification tick failed:', err.message);
    } finally {
      running = false;
    }
  };
  // Line up with the start of each minute so a 9:00 reminder arrives at 9:00.
  setTimeout(() => {
    run();
    setInterval(run, 60 * 1000);
  }, (60 - new Date().getSeconds()) * 1000);
}

module.exports = { tick, startNotifications, localNow, isDue, reminderAt, reminderRecipients, leadFor, eventAlerts };
