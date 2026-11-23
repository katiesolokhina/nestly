// Ratings: each person says Buy again, It's okay, Never again (or the household's own choices)
// about a product, and everyone sees everyone's. A product is its saved-item key (keyOf(name)).
const crypto = require('node:crypto');
const Rating = require('../models/Rating');

const COLORS = { green: 'Green', yellow: 'Yellow', red: 'Red', blue: 'Blue', purple: 'Purple', gray: 'Gray' };
const STARTER = [
  { id: 'again', name: 'Buy again', color: 'green', warn: false },
  { id: 'okay', name: 'It’s okay', color: 'yellow', warn: false },
  { id: 'never', name: 'Never again', color: 'red', warn: true },
];
const plain = (c) => (c && typeof c.toObject === 'function' ? c.toObject() : c);
const choicesOf = (household) => ((household && household.ratingChoices && household.ratingChoices.length ? household.ratingChoices : STARTER).map(plain));
const newId = () => `r${crypto.randomBytes(3).toString('hex')}`;

// Everyone's ratings for these keys: Map key -> [{ userId, userName, value, name, color, warn }],
// leaving out ratings whose choice was deleted.
async function ratingsFor(household, keys) {
  const list = [...new Set(keys.filter(Boolean))];
  const out = new Map(list.map((k) => [k, []]));
  if (!list.length) return out;
  const choices = new Map(choicesOf(household).map((c) => [c.id, c]));
  const rows = await Rating.find({ householdId: household._id, key: { $in: list } }).sort({ updatedAt: 1 }).lean();
  rows.forEach((r) => {
    const c = choices.get(r.value);
    if (c) out.get(r.key).push({ userId: String(r.userId), userName: r.userName, value: r.value, name: c.name, color: c.color, warn: c.warn });
  });
  return out;
}

// "Naum: Never again" lines for the warning choices.
const warnings = (list) => (list || []).filter((r) => r.warn).map((r) => `${r.userName}: ${r.name}`);

// Saves (or, with an empty value, removes) this person's rating.
async function rate(user, household, { key, name, value }) {
  if (!key) return false;
  if (!value) { await Rating.deleteOne({ householdId: household._id, key, userId: user._id }); return true; }
  if (!choicesOf(household).some((c) => c.id === value)) return false;
  await Rating.updateOne(
    { householdId: household._id, key, userId: user._id },
    { $set: { value, itemName: String(name || '').slice(0, 80), userName: user.name } },
    { upsert: true },
  );
  return true;
}

// The "Buy again?" prompt: a short queue in the session of things just put away, bought or used up.
const canRate = (req) => Boolean(req.perms && req.perms.can('pantry', 'ratings'));
function askLater(req, items) {
  if (!canRate(req) || req.household.ratingPrompt === false) return;
  const q = (req.session.rateQueue || []).filter((x) => !items.some((i) => i.key === x.key));
  items.forEach((i) => { if (i && i.key) q.push({ key: i.key, name: String(i.name || '').slice(0, 80) }); });
  req.session.rateQueue = q.slice(-20);
}
// The next thing to ask about that this person hasn't rated yet (rated ones drop off).
async function nextPrompt(req) {
  const q = req.session.rateQueue || [];
  if (!q.length || !canRate(req) || req.household.ratingPrompt === false) return null;
  const mine = await Rating.find({ householdId: req.household._id, userId: req.user._id, key: { $in: q.map((x) => x.key) } }, { key: 1 }).lean();
  const done = new Set(mine.map((r) => r.key));
  const left = q.filter((x) => !done.has(x.key));
  req.session.rateQueue = left;
  return left.length ? { ...left[0], left: left.length } : null;
}

module.exports = { COLORS, STARTER, choicesOf, newId, ratingsFor, warnings, rate, canRate, askLater, nextPrompt };
