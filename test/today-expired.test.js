// Today: each person chooses whether pantry things past their date show (always, for a week, never).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const PantryItem = require('../models/PantryItem');
const { addDays } = require('../lib/dates');

const PW = 'correct horse';

test('expired pantry things on Today', async (t) => {
  const app = await startApp({
    name: 'nestly_test_today_expired',
    port: 4051,
    async seed() {
      const today = localToday();
      const home = await Household.create({ name: 'Home', setupStep: 0, pantrySpots: ['Pantry'] });
      const katie = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: await User.hashPassword(PW) });
      const b = { householdId: home._id, createdBy: katie._id, byName: 'Katie', spot: 'Pantry', status: 'have' };
      await PantryItem.create([
        { ...b, name: 'Old Gelatin', key: 'old gelatin', batches: [{ count: 1, expires: addDays(today, -120) }] },
        { ...b, name: 'Recent Yogurt', key: 'recent yogurt', batches: [{ count: 1, expires: addDays(today, -3) }] },
        { ...b, name: 'Fresh Milk', key: 'fresh milk', batches: [{ count: 1, expires: addDays(today, 1) }] },
      ]);
      return {};
    },
  });
  t.after(() => app.stop());
  const katie = client(app.base);
  await katie('/login', { method: 'POST', form: { email: 'katie@test.dev', password: PW } });

  // The household starts at "for a week after the date".
  let page = await katie('/');
  assert.doesNotMatch(page.text, /Old Gelatin/);
  assert.match(page.text, /Recent Yogurt/);
  assert.match(page.text, /Fresh Milk/);
  assert.match((await katie('/customize')).text, /value="" selected>Household setting \(only for a week after the date\)/);
  assert.match((await katie('/settings/s/pantry')).text, /name="todayExpired"/);

  // Katie picks "Show them" for herself.
  await katie('/customize', { method: 'POST', form: { action: 'expired', expired: 'show' } });
  page = await katie('/');
  for (const n of ['Old Gelatin', 'Recent Yogurt', 'Fresh Milk']) assert.match(page.text, new RegExp(n));

  // Back to the household's, then the household hides them for everyone.
  await katie('/customize', { method: 'POST', form: { action: 'expired', expired: '' } });
  await katie('/settings/s/pantry', { method: 'POST', form: { pantrySoonDays: '3', todayExpired: 'hide' } });
  page = await katie('/');
  assert.doesNotMatch(page.text, /Old Gelatin|Recent Yogurt/);
  assert.match(page.text, /Fresh Milk/);

  await katie('/customize', { method: 'POST', form: { action: 'expired', expired: 'hide' } });
  page = await katie('/');
  assert.doesNotMatch(page.text, /Old Gelatin|Recent Yogurt/);
  assert.match(page.text, /Fresh Milk/);
  assert.match((await katie('/customize')).text, /value="hide" selected/);
  // Still in the Pantry.
  assert.match((await katie('/s/pantry')).text, /Old Gelatin/);
});
