// Spending: shopping prices by month and store, paid bills by category, and privacy.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb, localToday } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const ShoppingItem = require('../models/ShoppingItem');
const Bill = require('../models/Bill');

const PW = 'correct horse';

test('spending', async (t) => {
  const today = localToday();
  const month = today.slice(0, 7);
  const app = await startApp({
    name: 'nestly_test_spending',
    port: 3997,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const hash = await User.hashPassword(PW);
      const k = await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      const s = await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      const now = new Date();
      const item = (name, price, store, by, extra = {}) => ({ householdId: home._id, createdBy: by._id, byName: by.name, name, key: name.toLowerCase(), price, store, bought: true, boughtAt: now, ...extra });
      await ShoppingItem.insertMany([
        item('Milk', 4.5, 'Costco', k),
        item('Eggs', 7.49, 'Costco', k),
        item('Lamp', 30, 'Target', k, { tag: 'Home' }),
        item('Gift', 50, 'Target', s, { private: true }),
        item('No price', null, 'Target', k),
      ]);
      await Bill.create({ householdId: home._id, createdBy: k._id, byName: 'Katie', name: 'Electric', category: 'Utilities', cents: 12000, dueDate: today, paid: true, paidOn: today });
      await Bill.create({ householdId: home._id, createdBy: k._id, byName: 'Katie', name: 'Rent', category: 'Housing', cents: 150000, dueDate: today, paid: false });
      const last = new Date(); last.setUTCDate(1); last.setUTCDate(0); const lastDay = last.toISOString().slice(0, 10);
      await Bill.create({ householdId: home._id, createdBy: k._id, byName: 'Katie', name: 'Water', category: 'Utilities', cents: 5000, dueDate: lastDay, paid: true, paidOn: lastDay });
      return {};
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const katie = await signIn('katie@test.dev');
  const sam = await signIn('sam@test.dev');

  assert.match((await katie('/more')).text, /href="\/spending"/);
  const page = await katie('/spending');
  assert.equal(page.status, 200);
  assert.match(page.text, /\$161\.99/, '41.99 shopping + 120 bills');
  assert.match(page.text, /\$41\.99 shopping/);
  assert.match(page.text, /\$120\.00 bills/);
  assert.match(page.text, /\$111\.99 more than/);
  assert.match(page.text, /Costco[\s\S]*\$11\.99/);
  assert.match(page.text, /Utilities/);
  assert.doesNotMatch(page.text, /Housing/, 'unpaid bills don’t count');
  assert.doesNotMatch(page.text, /Gift/);
  assert.match((await sam('/spending')).text, /Gift/, 'your own private items count for you');
  // Another month, and no future months.
  assert.match((await katie('/spending?month=2020-01')).text, /No prices yet this month/);
  assert.match((await katie('/spending?month=2999-01')).text, new RegExp(month === today.slice(0, 7) ? '\\$161\\.99' : ''));
  void withDb;
});
