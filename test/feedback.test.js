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
  assert.match((await owner('/feedback/inbox')).text, /href="\/feedback\/inbox\/export\?" download>Download 1 as Excel/);
  const fs = require('node:fs');
  const res = await owner('/feedback/inbox/export?status=done', { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  assert.match(res.headers.get('content-disposition'), /nestly-feedback-done-\d{4}-\d{2}-\d{2}\.xlsx/);
  assert.equal(res.buffer.subarray(0, 2).toString(), 'PK');
  if (process.env.XLSX_OUT) fs.writeFileSync(process.env.XLSX_OUT, res.buffer);
  assert.equal((await sam('/feedback/inbox/export')).status, 404);

  // Sending with how much it matters and a screenshot (multipart).
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const fd = new FormData();
  fd.append('kind', 'bug'); fd.append('text', 'Calendar shows the wrong day'); fd.append('theirPriority', 'blocking');
  fd.append('shots', new Blob([png], { type: 'image/png' }), 'shot.png');
  await sam('/feedback', { method: 'POST', formData: fd });
  const cal = await withDb(app.uri, () => Feedback.findOne({ text: /wrong day/ }).lean());
  assert.equal(cal.theirPriority, 'blocking');
  assert.equal(cal.shots.length, 1);
  assert.equal((await sam(`/feedback/${cal._id}/shots/0`, { raw: true })).status, 200, 'the sender sees it');
  assert.equal((await katie(`/feedback/${cal._id}/shots/0`, { raw: true })).status, 200, 'their admin too');
  assert.equal((await lee(`/feedback/${cal._id}/shots/0`, { raw: true })).status, 404, 'another household’s admin can’t');
  // Too many screenshots are refused with a message.
  const many = new FormData();
  many.append('kind', 'bug'); many.append('text', 'four shots');
  for (let i = 0; i < 4; i += 1) many.append('shots', new Blob([png], { type: 'image/png' }), `s${i}.png`);
  assert.match((await sam('/feedback', { method: 'POST', formData: many })).text, /Up to 3 screenshots/);

  // Priority, notes, sorting, filters, archive.
  await katie(`/feedback/${cal._id}`, { method: 'POST', form: { status: 'planned', priority: 'urgent', notes: 'timezone bug', reply: '' } });
  let inbox = await katie('/feedback/inbox?sort=priority');
  assert.match(inbox.text, /prio-urgent" data-prio-tag>Urgent/);
  assert.match(inbox.text, /Them: Blocking me/);
  assert.match(inbox.text, /timezone bug/);
  assert.doesNotMatch((await sam('/feedback')).text, /timezone bug/, 'notes stay private');
  assert.doesNotMatch((await katie('/feedback/inbox?kind=idea')).text, /wrong day/);
  assert.match((await katie(`/feedback/inbox?who=${cal.userId}`)).text, /wrong day/);
  await katie(`/feedback/${cal._id}`, { method: 'POST', form: { action: 'archive' } });
  assert.doesNotMatch((await katie('/feedback/inbox?status=all')).text, /wrong day/);
  assert.match((await katie('/feedback/inbox?status=archived')).text, /wrong day/);
  assert.match((await sam('/feedback')).text, /Closed/);
  await katie(`/feedback/${cal._id}`, { method: 'POST', form: { action: 'unarchive' } });

  // Excel round trip: download, edit (status, priority, reply, notes), upload, preview, apply.
  const { readXlsx } = require('../lib/xlsx-read');
  const { buildXlsx } = require('../lib/xlsx');
  const dl = await katie('/feedback/inbox/export?status=all', { raw: true });
  const sheet = readXlsx(dl.buffer)[0].rows;
  const head = sheet[0];
  assert.deepEqual(head.slice(0, 6), ['ID', 'Date', 'Type', 'Status', 'Priority', 'Their priority']);
  const row = sheet.find((r) => r[6] === 'Calendar shows the wrong day');
  row[head.indexOf('Status')] = 'done';
  row[head.indexOf('Priority')] = '2 High';
  row[head.indexOf('Reply')] = 'Fixed it';
  const other = sheet.find((r) => r[6] === 'Pantry crashes when I scan');
  if (other) other[head.indexOf('Priority')] = 'whenever';
  const edited = buildXlsx({ sheetName: 'Feedback', columns: head.map((title) => ({ title })), rows: sheet.slice(1) });
  const up = new FormData();
  up.append('file', new Blob([edited]), 'edited.xlsx');
  assert.match((await katie('/feedback/inbox/import', { method: 'POST', formData: up })).location, /\/feedback\/inbox\/import$/);
  const preview = await katie('/feedback/inbox/import');
  assert.match(preview.text, /1 to update/);
  assert.match(preview.text, /Status:<\/strong> New → Done/);
  assert.match(preview.text, /Priority:<\/strong> Urgent → High/);
  assert.match(preview.text, /priority “whenever” not understood/);
  await withDb(app.uri, async () => assert.equal((await Feedback.findById(cal._id).lean()).status, 'new', 'nothing saved before Apply'));
  await katie('/feedback/inbox/import/apply', { method: 'POST', form: { action: 'apply' } });
  await withDb(app.uri, async () => {
    const after = await Feedback.findById(cal._id).lean();
    assert.deepEqual([after.status, after.priority, after.reply], ['done', 'high', 'Fixed it']);
  });
  assert.equal((await sam('/feedback/inbox/import', { method: 'POST', formData: up })).status, 404);

  // Autosave: one field at a time, answered with JSON (no page reload).
  const saved = await katie(`/feedback/${cal._id}`, { method: 'POST', form: { priority: 'low' }, headers: { 'X-Requested-With': 'fetch' } });
  assert.match(saved.headers.get('content-type'), /json/);
  assert.match(saved.text, /"priorityName":"Low"/);
  await withDb(app.uri, async () => assert.equal((await Feedback.findById(cal._id).lean()).priority, 'low'));
  // Delete for good, with its screenshots (reviewers only).
  assert.equal((await sam(`/feedback/${cal._id}/delete`, { method: 'POST' })).status, 404);
  assert.match((await katie('/feedback/inbox?status=all')).text, /Delete for good/);
  await katie(`/feedback/${cal._id}/delete`, { method: 'POST' });
  await withDb(app.uri, async () => {
    assert.equal(await Feedback.countDocuments({ _id: cal._id }), 0);
    assert.equal(await require('../models/Upload').countDocuments({ _id: { $in: cal.shots } }), 0);
  });
});
