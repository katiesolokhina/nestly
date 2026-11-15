// Calendar feed: a private link per person, their view only, repeating rules, and new links revoke old.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const { fold } = require('../lib/ics');

const PW = 'correct horse';

test('long lines fold without splitting characters', () => {
  const line = `SUMMARY:${'é'.repeat(60)}`;
  const folded = fold(line);
  folded.split('\r\n').forEach((l) => assert.ok(Buffer.byteLength(l) <= 75));
  assert.equal(folded.split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join(''), line);
});

test('calendar feed', async (t) => {
  const today = localToday();
  const app = await startApp({
    name: 'nestly_test_feed',
    port: 3993,
    env: { APP_ORIGIN: 'http://localhost:3993' },
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash, timezone: 'America/Chicago' });
      await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      return {};
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');
  await katie('/s/calendar', { method: 'POST', form: [['title', 'Soccer, practice'], ['date', today], ['time', '17:30'], ['endTime', '18:30'], ['repeat', 'weekly'], ['days', '1'], ['days', '3'], ['location', 'Park']] });
  await katie('/s/calendar', { method: 'POST', form: { title: 'Trip', date: today, endDate: '2099-01-03', allDay: 'on' } });
  await sam('/s/calendar', { method: 'POST', form: { title: 'Sam private', date: today, allDay: 'on', private: 'on' } });
  await katie('/s/remember', { method: 'POST', form: { text: 'Call vet', date: today, time: '09:00' } });
  await katie('/s/chores', { method: 'POST', form: { title: 'Dishes', date: today, repeat: 'daily' } });

  let page = await katie('/settings/calendar');
  assert.match(page.text, /Make my link/);
  let r = await katie('/settings/calendar', { method: 'POST', form: { action: 'new', events: 'on', reminders: 'on', bills: 'on', chores: 'on' } });
  page = await katie('/settings/calendar');
  const link = page.text.match(/http:\/\/localhost:3993(\/cal\/[\w-]+\.ics)/)[1];
  assert.doesNotMatch((await katie('/settings/calendar')).text, /\/cal\//, 'shown once');

  const feed = await client(app.base)(link);
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /text\/calendar/);
  const ics = feed.text;
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /SUMMARY:Soccer\\, practice/);
  assert.match(ics, /DTSTART;TZID=America\/Chicago:\d{8}T173000/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO,WE/);
  assert.match(ics, /DTEND;VALUE=DATE:20990104/, 'all-day end is the day after');
  assert.match(ics, /SUMMARY:Reminder: Call vet/);
  assert.match(ics, /SUMMARY:Chore: Dishes/);
  assert.match(ics, /RRULE:FREQ=DAILY/);
  assert.doesNotMatch(ics, /Sam private/);

  // Leave chores out.
  await katie('/settings/calendar', { method: 'POST', form: { action: 'save', events: 'on' } });
  assert.doesNotMatch((await client(app.base)(link)).text, /Chore: Dishes/);
  // A new link turns the old one off; turning off kills it.
  await katie('/settings/calendar', { method: 'POST', form: { action: 'new', events: 'on' } });
  assert.equal((await client(app.base)(link)).status, 404);
  const link2 = (await katie('/settings/calendar')).text.match(/http:\/\/localhost:3993(\/cal\/[\w-]+\.ics)/)[1];
  assert.equal((await client(app.base)(link2)).status, 200);
  await katie('/settings/calendar', { method: 'POST', form: { action: 'off' } });
  assert.equal((await client(app.base)(link2)).status, 404);
  assert.equal((await client(app.base)('/cal/nope.ics')).status, 404);
  void r;
});
