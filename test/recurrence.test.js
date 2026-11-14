// Repeat rules, multi-day events, and how times read. No database needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { occursOn, timeText, repeatText } = require('../lib/recurrence');

const ev = (x) => ({ date: '2026-11-02', endDate: '', time: '', endTime: '', repeat: 'none', interval: 1, days: [], until: '', ...x });
const on = (e, d) => !!occursOn(e, d);

test('one-off events happen only on their day', () => {
  const e = ev({});
  assert.ok(on(e, '2026-11-02'));
  assert.ok(!on(e, '2026-11-03'));
});

test('daily, every N days, and repeat until', () => {
  const e = ev({ repeat: 'daily', interval: 2, until: '2026-11-08' });
  assert.deepEqual(['02', '03', '04', '05', '06', '07', '08', '09', '10'].map((d) => on(e, `2026-11-${d}`)), [true, false, true, false, true, false, true, false, false]);
  assert.ok(!on(e, '2026-11-01'), 'never before it starts');
});

test('weekly on chosen days, and every other week', () => {
  // 2026-11-02 is a Monday.
  const mw = ev({ repeat: 'weekly', days: [1, 3] });
  assert.ok(on(mw, '2026-11-04'));
  assert.ok(on(mw, '2026-11-09'));
  assert.ok(!on(mw, '2026-11-05'));
  const biweekly = ev({ repeat: 'weekly', interval: 2, days: [2] });
  assert.ok(on(biweekly, '2026-11-03'));
  assert.ok(!on(biweekly, '2026-11-10'));
  assert.ok(on(biweekly, '2026-11-17'));
  assert.equal(repeatText(mw), 'Every week on Mon, Wed');
  assert.equal(repeatText(ev({ repeat: 'weekly', days: [1, 2, 3, 4, 5] })), 'Every week on weekdays');
  assert.equal(repeatText(biweekly), 'Every 2 weeks on Tue');
});

test('monthly keeps the day of the month and skips months without it', () => {
  const e = ev({ date: '2026-01-31', repeat: 'monthly' });
  assert.ok(!on(e, '2026-02-28'));
  assert.ok(on(e, '2026-03-31'));
  assert.ok(!on(e, '2026-04-30'));
  assert.equal(repeatText(ev({ date: '2026-11-22', repeat: 'monthly', interval: 3 })), 'Every 3 months on the 22nd');
  assert.ok(on(ev({ date: '2026-11-22', repeat: 'monthly', interval: 3 }), '2027-02-22'));
  assert.ok(!on(ev({ date: '2026-11-22', repeat: 'monthly', interval: 3 }), '2026-12-22'));
});

test('yearly, including the old "Every year" text', () => {
  const e = ev({ date: '2020-06-15', repeat: 'yearly' });
  assert.ok(on(e, '2026-06-15'));
  assert.equal(repeatText(e), 'Every year');
  assert.equal(repeatText(ev({ repeat: 'yearly', until: '2030-11-02' })), 'Every year, until Nov 2, 2030');
});

test('multi-day events cover every day, and repeats carry the length', () => {
  const trip = ev({ date: '2026-11-20', endDate: '2026-11-22', time: '09:00', endTime: '17:00' });
  assert.ok(on(trip, '2026-11-21'));
  assert.ok(!on(trip, '2026-11-23'));
  assert.equal(timeText(trip, '2026-11-20'), 'Starts 9:00 AM · Day 1 of 3');
  assert.equal(timeText(trip, '2026-11-21'), 'All day · Day 2 of 3');
  assert.equal(timeText(trip, '2026-11-22'), 'Ends 5:00 PM · Day 3 of 3');
  const weekend = ev({ date: '2026-11-07', endDate: '2026-11-08', repeat: 'weekly', days: [6] });
  assert.ok(on(weekend, '2026-11-15'), 'the Sunday after a repeat Saturday');
});

test('times read naturally', () => {
  assert.equal(timeText(ev({ time: '16:30', endTime: '18:00' }), '2026-11-02'), '4:30 PM – 6:00 PM');
  assert.equal(timeText(ev({ time: '16:30' }), '2026-11-02'), '4:30 PM');
  assert.equal(timeText(ev({}), '2026-11-02'), 'All day');
});
