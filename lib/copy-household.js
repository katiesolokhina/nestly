// Copies a household into a new one, with only the parts someone picks. Only the person copying
// is in the new household (as admin), so things tied to other people are made theirs or
// everyone's: chores for "anyone", events for everyone, bills not split, wishlist claims cleared.
// Others' private items stay behind; your own come along. Photos and files are copied too.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const Household = require('../models/Household');
const Membership = require('../models/Membership');
const Upload = require('../models/Upload');
const { filePath } = require('./uploads');
const { todayIn } = require('./dates');

const M = (name) => require(`../models/${name}`);

// What can be copied, in the order shown. `on`: ticked to start with.
const PARTS = [
  { key: 'settings', label: 'Settings and lists', hint: 'Sections, roles, aisles, stores, spots, categories, tags, defaults', on: true },
  { key: 'saved', label: 'Saved shopping items and staples', hint: 'What shows up as you type, with their usual store, aisle, and tag', on: true, feature: 'shopping' },
  { key: 'shopping', label: 'Shopping list', hint: 'What’s on it now (not what’s bought)', feature: 'shopping' },
  { key: 'pantry', label: 'Pantry', hint: 'Everything in it, with dates and counts', feature: 'pantry' },
  { key: 'recipes', label: 'Recipes', feature: 'recipes' },
  { key: 'meals', label: 'Meal plan', hint: 'Today and later', feature: 'meals' },
  { key: 'chores', label: 'Chores', hint: 'Without who did what', feature: 'chores' },
  { key: 'lists', label: 'Lists', hint: 'Wishlist claims are cleared', feature: 'lists' },
  { key: 'calendar', label: 'Calendar events', hint: 'Today and later, and repeating ones', feature: 'calendar' },
  { key: 'remember', label: 'Reminders', hint: 'Not done yet', feature: 'remember' },
  { key: 'bills', label: 'Bills', hint: 'Unpaid and repeating, not split', feature: 'bills' },
  { key: 'info', label: 'Home info', feature: 'info' },
];

// Household fields that aren't settings (or belong to the old one only).
const NOT_SETTINGS = new Set(['_id', '__v', 'name', 'createdAt', 'updatedAt', 'setupStep']);

async function copyUpload(id, to, user) {
  if (!id) return null;
  const u = await Upload.findById(id).lean();
  if (!u) return null;
  const name = `${crypto.randomBytes(18).toString('hex')}${path.extname(u.file)}`;
  try {
    await fs.copyFile(filePath(u), path.join(path.dirname(filePath(u)), name));
  } catch {
    return null; // the file is gone: leave it off the copy
  }
  const copy = await Upload.create({ householdId: to, createdBy: user._id, private: u.private, file: name, name: u.name, type: u.type, size: u.size });
  return copy._id;
}

async function copyHousehold(user, from, { name, parts }) {
  const want = (k) => parts.includes(k);
  const me = user._id;
  const today = todayIn(user.timezone);
  const settings = want('settings') ? Object.fromEntries(Object.entries(from.toObject()).filter(([k]) => !NOT_SETTINGS.has(k))) : {};
  if (settings.choreWho && String(settings.choreWho) !== String(me)) settings.choreWho = '';
  // Without the settings, the new one starts with the setup guide like any new household.
  const home = await Household.create({ ...settings, name, setupStep: want('settings') ? 0 : 1 });
  await Membership.create({ userId: me, householdId: home._id, role: 'admin' });

  // Shared items, and your own private ones.
  const scope = { householdId: from._id, $or: [{ private: { $ne: true } }, { createdBy: me }] };
  const base = (d) => {
    const { _id, __v, createdAt, updatedAt, ...rest } = d;
    return { ...rest, householdId: home._id };
  };
  const counts = {};
  const add = async (model, docs) => {
    if (!docs.length) return [];
    const made = await M(model).insertMany(docs, { ordered: false });
    counts[model] = (counts[model] || 0) + made.length;
    return made;
  };
  const files = async (doc, fields) => {
    for (const f of fields) {
      if (Array.isArray(doc[f])) doc[f] = (await Promise.all(doc[f].map((id) => copyUpload(id, home._id, user)))).filter(Boolean);
      else if (doc[f]) doc[f] = await copyUpload(doc[f], home._id, user);
    }
    return doc;
  };

  // Kinds keep their names and codes; their photos stay with the old household.
  if (want('saved')) await add('CatalogItem', (await M('CatalogItem').find({ householdId: from._id }).lean()).map((d) => ({ ...base(d), kinds: (d.kinds || []).map((k) => ({ ...k, photoId: null })) })));
  if (want('shopping')) {
    const items = await M('ShoppingItem').find({ ...scope, bought: false, clearedAt: null }).lean();
    await add('ShoppingItem', await Promise.all(items.map((d) => files({ ...base(d), receiptId: null }, ['photoId']))));
  }
  if (want('pantry')) {
    const items = await M('PantryItem').find(scope).lean();
    await add('PantryItem', await Promise.all(items.map((d) => files(base(d), ['photoId']))));
  }
  const recipeIds = new Map();
  if (want('recipes')) {
    const items = await M('Recipe').find(scope).lean();
    const made = await add('Recipe', await Promise.all(items.map((d) => files(base(d), ['photoId']))));
    items.forEach((d, i) => recipeIds.set(String(d._id), made[i] && made[i]._id));
  }
  if (want('meals')) {
    const items = await M('Meal').find({ ...scope, date: { $gte: today } }).lean();
    await add('Meal', items.map((d) => ({ ...base(d), recipeId: d.recipeId ? recipeIds.get(String(d.recipeId)) || null : null })));
  }
  if (want('chores')) {
    const items = await M('Chore').find(scope).lean();
    await add('Chore', items.map((d) => ({ ...base(d), assignee: d.assignee && String(d.assignee) === String(me) ? me : null })));
  }
  if (want('lists')) {
    const items = await M('List').find(scope).lean();
    await add('List', items.map((d) => ({
      ...base(d),
      ownerId: d.ownerId && String(d.ownerId) === String(me) ? me : null,
      items: (d.items || []).map(({ _id, claimedBy, claimedName, wantIds, ...i }) => ({ ...i, claimedBy: null, claimedName: '', wantIds: (wantIds || []).filter((id) => String(id) === String(me)) })),
    })));
  }
  if (want('calendar')) {
    const items = await M('Event').find({ ...scope, $and: [{ $or: [{ date: { $gte: today } }, { endDate: { $gte: today } }, { repeat: { $ne: 'none' } }] }] }).lean();
    await add('Event', await Promise.all(items.map((d) => files({ ...base(d), forIds: [] }, ['fileId']))));
  }
  if (want('remember')) {
    const items = await M('Reminder').find({ ...scope, done: { $ne: true } }).lean();
    await add('Reminder', items.map((d) => ({ ...base(d), notifyTo: (d.notifyTo || []).filter((id) => String(id) === String(me)), snoozes: [] })));
  }
  if (want('bills')) {
    const series = await M('BillSeries').find({ ...scope, active: true }).lean();
    const made = await add('BillSeries', series.map((d) => ({ ...base(d), splitMode: 'none', plan: [] })));
    const seriesIds = new Map(series.map((d, i) => [String(d._id), made[i] && made[i]._id]));
    const bills = await M('Bill').find({ ...scope, paid: false }).lean();
    await add('Bill', bills.map((d) => ({ ...base(d), splitMode: 'none', shares: [], receiptId: null, seriesId: d.seriesId ? seriesIds.get(String(d.seriesId)) || null : null })));
  }
  if (want('info')) {
    const items = await M('InfoItem').find(scope).lean();
    await add('InfoItem', await Promise.all(items.map((d) => files(base(d), ['fileIds']))));
  }
  return { home, counts };
}

module.exports = { PARTS, copyHousehold };
