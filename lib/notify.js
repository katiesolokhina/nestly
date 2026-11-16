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
const Membership = require('../models/Membership');
const { ensureMemberships, inHome } = require('./members');
const { permsFor } = require('./perms');
const { sendToUser } = require('./push');
const { addDays, diffDays, dayLabel, time12, weekday } = require('./dates');
const { occursOn } = require('./recurrence');
const { lead: leadOf } = require('./alerts');
const Bill = require('../models/Bill');
const Household = require('../models/Household');
const { ensureUpcoming, balances, money } = require('./bills');
const PantryItem = require('../models/PantryItem');
const { expiryText } = require('./pantry');
const InfoItem = require('../models/InfoItem');
const { isWarranty } = require('./info');
const { choresWithDue, assigneeOf, dueText } = require('./chores');

const WINDOW_MIN = 60;
// Buttons on reminder notifications. Android shows them; iPhone ignores them and opens the page.
const ACTIONS = [{ action: 'done', title: 'Done' }, { action: 'snooze', title: 'Snooze 30 min' }];
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


// Notify times for occurrences of an event starting around today (a lead can reach a day ahead).
// Each event sets its own lead time, the same for everyone; only the morning time is personal.
function eventAlerts(e, user, today) {
  const lead = leadOf(e);
  if (lead === null) return [];
  const out = [];
  const ahead = Math.floor(lead / 1440); // a lead of days or weeks looks that far ahead
  for (let i = -1; i <= 2; i += 1) {
    const start = addDays(today, ahead + i);
    const hit = occursOn(e, start);
    if (!hit || hit.start !== start) continue;
    let at;
    if (e.time) {
      const t = toMin(e.time) - lead;
      const shift = Math.floor(t / 1440);
      at = { date: addDays(start, shift), min: t - shift * 1440 };
    } else {
      at = { date: addDays(start, -lead / 1440), min: toMin(morningOf(user)) };
    }
    out.push({ start, lead, at });
  }
  return out;
}

// Who hears about a bill coming due: the people sharing it (or everyone, if it isn't split).
function billRecipients(b, members) {
  if (b.private) return members.filter((m) => String(m._id) === String(b.createdBy));
  if (b.shares && b.shares.length) return members.filter((m) => b.shares.some((s) => String(s.userId) === String(m._id)));
  return members;
}

// Which bill notifications this person wants, and when: at their morning time.
function billAlerts(b, user) {
  const n = user.notify || {};
  const morning = toMin(morningOf(user));
  const out = [];
  if (n.billsBefore !== false) {
    const days = [1, 2, 3, 5, 7, 14].includes(n.billsBeforeDays) ? n.billsBeforeDays : 3;
    out.push({ kind: `before${days}`, at: { date: addDays(b.dueDate, -days), min: morning }, days });
  }
  if (n.billsDue !== false) out.push({ kind: 'due', at: { date: b.dueDate, min: morning } });
  if (n.billsOverdue !== false) out.push({ kind: 'overdue', at: { date: addDays(b.dueDate, 1), min: morning } });
  return out;
}

function billBody(b, a, user, today, sym = '$') {
  const share = (b.shares || []).find((s) => String(s.userId) === String(user._id));
  const yours = share && b.shares.length > 1 ? ` · Your share ${money(share.cents, sym)}` : '';
  const when = a.kind === 'due' ? 'Due today' : a.kind === 'overdue' ? 'Overdue since yesterday' : `Due ${dayLabel(b.dueDate, today).replace(/^Tomorrow$/, 'tomorrow')}`;
  return `${when} · ${money(b.cents, sym)}${yours}`;
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
  await ensureMemberships(); // accounts from before households could be shared
  const users = await User.find({ _id: { $in: ids } }, { timezone: 1, notify: 1, name: 1 }).lean();
  // Someone in several households hears about each of them.
  const memberships = await Membership.find({ userId: { $in: ids }, disabled: false }, { userId: 1, householdId: 1, role: 1 }).lean();
  const byHome = new Map();
  const homesPer = new Map();
  memberships.forEach((m) => {
    const u = users.find((x) => String(x._id) === String(m.userId));
    if (!u) return;
    // Each household gets its own copy, carrying this person's role there.
    byHome.set(String(m.householdId), [...(byHome.get(String(m.householdId)) || []), { ...u, role: m.role }]);
    homesPer.set(String(u._id), (homesPer.get(String(u._id)) || 0) + 1);
  });
  const homesById = new Map((await Household.find({ _id: { $in: [...byHome.keys()] } }, { name: 1, features: 1, roles: 1 }).lean()).map((h) => [String(h._id), h]));
  const names = new Map([...homesById].map(([id, h]) => [id, h.name]));

  let sent = 0;
  for (const [householdId, everyone] of byHome) {
    // Nobody hears about a section their role hides.
    const home0 = homesById.get(householdId) || { features: {} };
    const seeing = (key) => everyone.filter((u) => permsFor(home0, u).level(key) !== 'hidden');
    const members = everyone;
    // Links open this household first; with more than one household, the title says which.
    const sendHere = (userId, p) => send(userId, {
      ...p,
      url: inHome(householdId, p.url),
      title: homesPer.get(String(userId)) > 1 ? `${names.get(householdId) || 'Nestly'}: ${p.title}` : p.title,
    });
    const anyDay = localNow('UTC', now).today;
    const [reminders, events] = await Promise.all([
      Reminder.find({ householdId, done: false, date: { $gte: addDays(anyDay, -2), $lte: addDays(anyDay, 2) } }).lean(),
      Event.find({ householdId }).lean(),
    ]);

    // Bills: make this month's repeating bills, then send what's due.
    const home = await Household.findById(householdId, { features: 1, currency: 1 }).lean();
    const sym = (home && home.currency) || '$';

    // Home info: a warranty is about to end. Once per item and date, at each person's morning.
    if (home && home.features && home.features.info !== false) {
      const wanting = seeing('info').filter((m) => !m.notify || m.notify.warranty !== false);
      const items = wanting.length ? await InfoItem.find({ householdId, 'fields.kind': 'date' }).lean() : [];
      for (const item of items) {
        const f = item.fields.find(isWarranty);
        if (!f) continue;
        for (const user of wanting) {
          if (item.private && String(item.createdBy) !== String(user._id)) continue;
          const local = localNow(user.timezone, now);
          const days = user.notify && Number.isInteger(user.notify.warrantyDays) ? user.notify.warrantyDays : 30;
          const left = diffDays(local.today, f.value);
          if (left < 0 || left > days) continue;
          if (!isDue({ date: local.today, min: toMin(morningOf(user)) }, local)) continue;
          if (!(await claim(`warranty:${item._id}:${f.value}`, user._id))) continue;
          sent += await sendHere(user._id, { title: `${item.title}: warranty ending`, body: left === 0 ? 'The warranty ends today.' : `The warranty ends in ${left} ${left === 1 ? 'day' : 'days'}.`, url: `/s/info/${item._id}`, tag: `warranty-${item._id}` });
        }
      }
    }

    // Pantry: one morning message listing what's about to expire, each item mentioned once.
    if (home && home.features && home.features.pantry !== false) {
      const wanting = seeing('pantry').filter((m) => !m.notify || m.notify.pantryExpiry !== false);
      if (wanting.length) {
        const soon = await PantryItem.find({ householdId, private: { $ne: true }, status: { $ne: 'out' }, expires: { $ne: '', $lte: addDays(anyDay, 15) } }).sort({ expires: 1 }).lean();
        for (const user of soon.length ? wanting : []) {
          const local = localNow(user.timezone, now);
          if (!isDue({ date: local.today, min: toMin(morningOf(user)) }, local)) continue;
          const days = user.notify && Number.isInteger(user.notify.pantryExpiryDays) ? user.notify.pantryExpiryDays : 2;
          const due = soon.filter((p) => p.expires <= addDays(local.today, days) && p.expires >= addDays(local.today, -1));
          const fresh = [];
          for (const p of due) if (await claim(`pexp:${p._id}:${p.expires}`, user._id)) fresh.push(p);
          if (!fresh.length) continue;
          const list = fresh.slice(0, 5).map((p) => `${p.name} (${expiryText(p.expires, local.today, 99).text.replace(/^Expires /, '').toLowerCase()})`).join(', ');
          sent += await sendHere(user._id, {
            title: fresh.length === 1 ? `${fresh[0].name} is about to expire` : `${fresh.length} things about to expire`,
            body: fresh.length > 5 ? `${list}, and ${fresh.length - 5} more` : list,
            url: '/s/pantry?show=soon',
            tag: 'pantry-expiry',
          });
        }
      }
    }
    if (home && home.features && home.features.bills !== false) {
      await ensureUpcoming(householdId, anyDay);
      const bills = await Bill.find({ householdId, paid: false, dueDate: { $gte: addDays(anyDay, -2), $lte: addDays(anyDay, 15) } }).lean();
      for (const b of bills) {
        for (const user of billRecipients(b, seeing('bills'))) {
          const local = localNow(user.timezone, now);
          for (const a of billAlerts(b, user)) {
            if (!isDue(a.at, local)) continue;
            if (!(await claim(`bill:${b._id}:${a.kind}:${b.dueDate}`, user._id))) continue;
            sent += await sendHere(user._id, { title: b.name, body: billBody(b, a, user, local.today, sym), url: `/s/bills/${b._id}`, tag: `bill-${b._id}` });
          }
        }
      }
      // Sunday at the morning time: what each person who asked still owes.
      const weekly = seeing('bills').filter((m) => m.notify && m.notify.billsWeekly);
      if (weekly.length) {
        let owed = null;
        for (const user of weekly) {
          const local = localNow(user.timezone, now);
          if (weekday(local.today) !== 0 || !isDue({ date: local.today, min: toMin(morningOf(user)) }, local)) continue;
          owed = owed || balances(await Bill.find({ householdId, paid: true, private: false, 'shares.settled': false }).lean());
          const mine = owed.filter((p) => p.from.id === String(user._id));
          if (!mine.length) continue;
          if (!(await claim(`owe:${local.today}`, user._id))) continue;
          sent += await sendHere(user._id, { title: 'What you owe', body: mine.map((p) => `${p.to.name} ${money(p.cents, sym)}`).join(', '), url: '/s/bills/balances', tag: 'bills-weekly' });
        }
      }
    }

    // Chores: on the due day (at the chore's time, or the morning), and the next morning if not done.
    if (home && home.features && home.features.chores !== false) {
      const people = seeing('chores');
      const due = people.length ? (await choresWithDue(householdId)).filter((c) => c.due && c.due >= addDays(anyDay, -2) && c.due <= addDays(anyDay, 1)) : [];
      for (const c of due) {
        const a = assigneeOf(c, people);
        for (const user of a ? [a] : people) {
          const local = localNow(user.timezone, now);
          const n = user.notify || {};
          const alerts = [];
          if (n.chores !== false) alerts.push({ kind: 'due', at: { date: c.due, min: toMin(TIME.test(c.time || '') ? c.time : morningOf(user)) } });
          if (n.choresLate !== false) alerts.push({ kind: 'late', at: { date: addDays(c.due, 1), min: toMin(morningOf(user)) } });
          for (const al of alerts) {
            if (!isDue(al.at, local)) continue;
            if (!(await claim(`chore:${c._id}:${c.due}:${al.kind}`, user._id))) continue;
            sent += await sendHere(user._id, {
              title: c.title,
              body: [dueText(c, local.today), c.room !== 'Anywhere' ? c.room : '', a ? '' : 'Anyone can do it'].filter(Boolean).join(' · '),
              url: '/s/chores?who=me',
              tag: `chore-${c._id}`,
            });
          }
        }
      }
    }

    // Snoozes: back to the one person who snoozed, whatever the reminder's date.
    const snoozed = await Reminder.find({ householdId, done: false, 'snoozes.0': { $exists: true } }).lean();
    for (const r of snoozed) {
      for (const s of r.snoozes) {
        const user = seeing('remember').find((m) => String(m._id) === String(s.userId));
        if (!user || !(s.until <= now && now - s.until < WINDOW_MIN * 60000)) continue;
        if (r.private && String(r.createdBy) !== String(user._id)) continue;
        if (!(await claim(`snz:${r._id}:${s.until.getTime()}`, user._id))) continue;
        sent += await sendHere(user._id, { title: r.text, body: r.details || 'Snoozed reminder', url: `/s/remember/${r._id}`, tag: `rem-${r._id}`, reminderId: String(r._id), actions: ACTIONS });
      }
    }

    for (const r of reminders) {
      for (const user of reminderRecipients(r, seeing('remember'))) {
        if (user.notify && user.notify.reminders === false) continue;
        const at = reminderAt(r, user);
        if (!at || !isDue(at, localNow(user.timezone, now))) continue;
        if (!(await claim(`rem:${r._id}:${at.date}:${at.min}`, user._id))) continue;
        sent += await sendHere(user._id, {
          title: r.text,
          body: r.details || (r.time ? `Reminder for ${time12(r.time)}` : 'Reminder for today'),
          url: `/s/remember/${r._id}`,
          tag: `rem-${r._id}`,
          reminderId: String(r._id),
          actions: ACTIONS,
        });
      }
    }

    for (const e of events) {
      const cal = seeing('calendar');
      const forOnly = (e.forIds || []).map(String);
      const people = (e.private ? cal.filter((m) => String(m._id) === String(e.createdBy)) : cal).filter((m) => !forOnly.length || forOnly.includes(String(m._id)));
      for (const user of people) {
        if (user.notify && user.notify.events === false) continue;
        const local = localNow(user.timezone, now);
        for (const a of eventAlerts(e, user, local.today)) {
          if (!isDue(a.at, local)) continue;
          if (!(await claim(`evt:${e._id}:${a.start}:${e.time || 'allday'}:${a.lead}`, user._id))) continue;
          sent += await sendHere(user._id, {
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
    }
    try {
      await require('./digest').digestTick(); // late require: digest uses this file's helpers
    } catch (err) {
      console.error('Morning email tick failed:', err.message);
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

module.exports = { tick, startNotifications, localNow, isDue, reminderAt, reminderRecipients, eventAlerts, billAlerts, billRecipients };
