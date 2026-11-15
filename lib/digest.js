// Morning email: what needs each person today, across every household they're in. Goes to
// people who chose it, by default only those with no device set up for notifications.
const User = require('../models/User');
const Household = require('../models/Household');
const Membership = require('../models/Membership');
const PushSubscription = require('../models/PushSubscription');
const RewardClaim = require('../models/RewardClaim');
const NotifyLog = require('../models/NotifyLog');
const { permsFor } = require('./perms');
const { SECTIONS } = require('./sections');
const { buildToday } = require('./today');
const { mailOn, sendMail } = require('./mail');
const { localNow, isDue } = require('./notify');

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// What one person should hear about in one household today.
async function sectionFor(user, household, member, today) {
  const perms = permsFor(household, member);
  const view = { ...household, features: Object.fromEntries(SECTIONS.map((s) => [s.key, perms.level(s.key) !== 'hidden'])) };
  const t = await buildToday({ ...user, householdId: household._id }, view, member, { today });
  const lines = t.attention.map((a) => `${a.type}: ${a.title} (${a.meta})`);
  if (perms.settings && view.features.chores) {
    const asked = await RewardClaim.find({ householdId: household._id, status: 'asked' }).lean();
    asked.forEach((c) => lines.push(`Reward request: ${c.byName} wants ${c.name} (${c.cost} points)`));
  }
  const soon = t.upcoming.slice(0, 3).map((u) => `${u.title} (${u.meta})`);
  return { name: household.name, id: String(household._id), lines, soon };
}

async function claim(key, userId) {
  try { await NotifyLog.create({ key, userId }); return true; } catch (err) { if (err.code === 11000) return false; throw err; }
}

// Builds and sends one person's email. Returns false when there's nothing worth sending.
async function digestFor(user, { send = sendMail, force = false, today } = {}) {
  const ms = await Membership.find({ userId: user._id, disabled: false }).lean();
  const homes = await Household.find({ _id: { $in: ms.map((m) => m.householdId) } }).lean();
  const parts = [];
  for (const h of homes) parts.push(await sectionFor(user, h, ms.find((m) => String(m.householdId) === String(h._id)), today));
  const withItems = parts.filter((p) => p.lines.length);
  if (!withItems.length && !force) return false;
  const base = (process.env.APP_ORIGIN || '').replace(/\/$/, '');
  const count = withItems.reduce((n, p) => n + p.lines.length, 0);
  const subject = count ? `Nestly: ${count} ${count === 1 ? 'thing' : 'things'} today` : 'Nestly: nothing needs you today';
  const many = parts.length > 1;
  const text = [
    `Good morning, ${user.name}.`, '',
    ...parts.flatMap((p) => [
      ...(many ? [p.name.toUpperCase()] : []),
      ...(p.lines.length ? p.lines.map((l) => `- ${l}`) : ['Nothing today.']),
      ...(p.soon.length ? ['Coming up:', ...p.soon.map((l) => `  ${l}`)] : []),
      '',
    ]),
    base ? `Open Nestly: ${base}/` : '',
    base ? `Change or stop these emails: ${base}/settings/notifications` : 'Change or stop these emails in Nestly: Settings → Notifications.',
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#211d2b;max-width:560px">
<p>Good morning, ${esc(user.name)}.</p>
${parts.map((p) => `${many ? `<h3 style="margin:18px 0 4px">${esc(p.name)}</h3>` : ''}
${p.lines.length ? `<ul style="padding-left:20px;margin:4px 0">${p.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p style="color:#6b6577;margin:4px 0">Nothing today.</p>'}
${p.soon.length ? `<p style="color:#6b6577;margin:8px 0 0">Coming up: ${p.soon.map(esc).join('; ')}</p>` : ''}`).join('\n')}
${base ? `<p style="margin-top:20px"><a href="${base}/" style="color:#6b4c8f">Open Nestly</a></p>
<p style="color:#6b6577;font-size:13px">You get this because of your email setting in Nestly. <a href="${base}/settings/notifications" style="color:#6b6577">Change or stop these emails</a>.</p>` : ''}
</div>`;
  await send({ to: user.email, subject, text, html });
  return true;
}

// Once a minute, from the notification ticker: whoever's morning time it is.
async function digestTick(now = new Date(), send = sendMail) {
  if (!mailOn() && send === sendMail) return 0;
  const users = await User.find({ 'notify.email': { $ne: 'off' }, disabled: { $ne: true } }, { name: 1, email: 1, timezone: 1, notify: 1 }).lean();
  if (!users.length) return 0;
  const withPush = new Set((await PushSubscription.distinct('userId', { userId: { $in: users.map((u) => u._id) } })).map(String));
  let sent = 0;
  for (const u of users) {
    const mode = (u.notify && u.notify.email) || 'nopush';
    if (mode === 'nopush' && withPush.has(String(u._id))) continue;
    const tz = u.timezone || 'America/Chicago';
    const local = localNow(tz, now);
    const morning = u.notify && TIME.test(u.notify.morning) ? u.notify.morning : '08:00';
    if (!isDue({ date: local.today, min: toMin(morning) }, local)) continue;
    if (!(await claim(`digest:${local.today}`, u._id))) continue;
    try {
      if (await digestFor({ ...u, timezone: tz }, { send, today: local.today })) sent += 1;
    } catch (err) {
      console.error(`Morning email to ${u._id} failed: ${err.message}`);
    }
  }
  return sent;
}

module.exports = { digestTick, digestFor };
