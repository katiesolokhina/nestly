// Report a bug or suggest a feature: sending, the inbox, and who sees what.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, withDb } = require('./helpers');
const Household = require('../models/Household');
const User = require('../models/User');
const Feedback = require('../models/Feedback');

const PW = 'correct horse';

test('feedback', async (t) => {
  process.env.OWNER_EMAILS = 'owner@test.dev';
  t.after(() => { delete process.env.OWNER_EMAILS; });
  const app = await startApp({
    name: 'nestly_test_feedback',
    port: 4007,
    async seed() {
      const home = await Household.create({ name: 'Home' });
      const lake = await Household.create({ name: 'Lake' });
      const hash = await User.hashPassword(PW);
      await User.create({ householdId: home._id, email: 'katie@test.dev', name: 'Katie', role: 'admin', passwordHash: hash });
      await User.create({ householdId: home._id, email: 'sam@test.dev', name: 'Sam', passwordHash: hash });
      await User.create({ householdId: lake._id, email: 'lee@test.dev', name: 'Lee', role: 'admin', passwordHash: hash });
      await User.create({ householdId: lake._id, email: 'owner@test.dev', name: 'Owner', passwordHash: hash });
    },
  });
  t.after(() => app.stop());
  const signIn = async (email) => { const c = client(app.base); await c('/login', { method: 'POST', form: { email, password: PW } }); return c; };
  const [katie, sam, lee, owner] = await Promise.all(['katie', 'sam', 'lee', 'owner'].map((n) => signIn(`${n}@test.dev`)));

  assert.match((await sam('/settings')).text, /href="\/feedback"/);
  let page = await sam('/feedback?from=%2Fs%2Fpantry');
  assert.match(page.text, /value="\/s\/pantry"/);
  assert.doesNotMatch(page.text, /Feedback inbox/, 'members don’t review');
  await sam('/feedback', { method: 'POST', form: { kind: 'bug', text: 'Pantry crashes when I scan', page: '/s/pantry' } });
  await lee('/feedback', { method: 'POST', form: { kind: 'idea', text: 'Dark mode for the lake house' } });
  assert.match((await sam('/feedback')).text, /Pantry crashes when I scan[\s\S]*New/);
  assert.equal((await sam('/feedback/inbox')).status, 404);

  // A household admin sees their own household's; the owner sees all.
  page = await katie('/feedback/inbox');
  assert.match(page.text, /Pantry crashes/);
  assert.doesNotMatch(page.text, /Dark mode/);
  page = await owner('/feedback/inbox');
  assert.match(page.text, /Pantry crashes/);
  assert.match(page.text, /Dark mode/);
  assert.match(page.text, /Home ·/);

  const id = await withDb(app.uri, async () => String((await Feedback.findOne({ kind: 'bug' }))._id));
  assert.equal((await lee(`/feedback/${id}`, { method: 'POST', form: { status: 'done' } })).status, 404, 'another household’s admin can’t');
  await katie(`/feedback/${id}`, { method: 'POST', form: { status: 'done', reply: 'Fixed in the next update' } });
  assert.match((await sam('/feedback')).text, /Reply: Fixed in the next update[\s\S]*Done/);
  assert.doesNotMatch((await katie('/feedback/inbox')).text, /Pantry crashes/, 'done leaves the open list');
  assert.match((await katie('/feedback/inbox?status=done')).text, /Pantry crashes/);
  await withDb(app.uri, async () => assert.match((await Feedback.findById(id).lean()).device, /node|undici|\w/i));

  // Excel: follows the inbox filter; members can't.
  assert.match((await owner('/feedback/inbox')).text, /href="\/feedback\/inbox\/export" download>Download 1 as Excel/);
  const fs = require('node:fs');
  const res = await owner('/feedback/inbox/export?status=done', { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  assert.match(res.headers.get('content-disposition'), /nestly-feedback-done-\d{4}-\d{2}-\d{2}\.xlsx/);
  assert.equal(res.buffer.subarray(0, 2).toString(), 'PK');
  if (process.env.XLSX_OUT) fs.writeFileSync(process.env.XLSX_OUT, res.buffer);
  assert.equal((await sam('/feedback/inbox/export')).status, 404);
});
