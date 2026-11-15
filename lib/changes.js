// Every change to shared data goes through here, so each one is logged and can be undone.
const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const ShoppingItem = require('../models/ShoppingItem');
const Reminder = require('../models/Reminder');
const Event = require('../models/Event');
const Recipe = require('../models/Recipe');
const Meal = require('../models/Meal');
const Bill = require('../models/Bill');
const PantryItem = require('../models/PantryItem');
const InfoItem = require('../models/InfoItem');
const CatalogItem = require('../models/CatalogItem');
const Chore = require('../models/Chore');
const ChoreDone = require('../models/ChoreDone');
const { deleteUploads } = require('./uploads');

const MODELS = { ShoppingItem, Reminder, Event, Recipe, Meal, Bill, PantryItem, InfoItem, Chore };
// Saved items and chore check-offs can be undone too, but they have no owner or private flag, so
// they stay out of MODELS: deletePrivateData's filter would otherwise match all of them.
const UNDOABLE = { ...MODELS, CatalogItem, ChoreDone };
const plain = (doc) => (doc.toObject ? doc.toObject({ depopulate: true, versionKey: true }) : doc);

// kind: create | update | delete. "before" is the document's state before the change.
// Several items deleted at once: one log entry, and one Undo that brings them all back.
async function recordDeleteMany(req, { model, docs, section, text, label }) {
  const entry = await Activity.create({
    householdId: req.user.householdId,
    actorId: req.user._id,
    actorName: req.user.name,
    section,
    text: `${req.user.name} ${text}`,
    private: docs.every((d) => d.private),
    undo: { kind: 'deleteMany', model, docId: null, before: docs.map(plain), afterAt: null, label },
  });
  req.session.undoId = entry.id;
  return entry;
}

async function recordChange(req, { kind, model, doc, before, section, text, label }) {
  const entry = await Activity.create({
    householdId: req.user.householdId,
    actorId: req.user._id,
    actorName: req.user.name,
    section,
    text: `${req.user.name} ${text}`,
    private: !!doc.private,
    undo: {
      kind,
      model,
      docId: doc._id,
      before: before ? plain(before) : null,
      afterAt: kind === 'delete' ? null : doc.updatedAt,
      label,
    },
  });
  req.session.undoId = entry.id;
  return entry;
}

const CHANGED = 'That changed again since then, so it wasn’t undone. See Activity for what happened.';

// Undo never overwrites a newer change: it only applies if the document is exactly as this change left it.
async function applyUndo(user, entry) {
  if (entry.undoneAt) return { ok: false, message: 'That was already undone.' };
  const { kind, model, docId, before, afterAt } = entry.undo;
  const Model = UNDOABLE[model];
  if (kind === 'deleteMany') {
    // Puts back whichever of the deleted items are still gone.
    const ids = before.map((d) => d._id);
    const back = new Set((await Model.find({ _id: { $in: ids } }, { _id: 1 }).lean()).map((d) => String(d._id)));
    const missing = before.filter((d) => !back.has(String(d._id)) && String(d.householdId) === String(user.householdId));
    if (!missing.length) return { ok: false, message: 'Those items are already back.' };
    await Model.collection.insertMany(missing);
    return finishUndo(user, entry, 'restored');
  }
  const scope = { _id: new mongoose.Types.ObjectId(String(docId)), householdId: user.householdId };
  const current = await Model.findOne(scope).lean();

  if (kind === 'delete') {
    if (current) return { ok: false, message: 'That item is already back.' };
    try {
      await Model.collection.insertOne(before);
    } catch (err) {
      if (err.code !== 11000) throw err;
      return { ok: false, message: 'Someone added it again since then, so it’s already back.' };
    }
  } else {
    if (!current || new Date(current.updatedAt).getTime() !== new Date(afterAt).getTime()) return { ok: false, message: CHANGED };
    if (kind === 'create') await Model.deleteOne(scope);
    else await Model.collection.replaceOne({ _id: scope._id }, before);
  }

  return finishUndo(user, entry, kind === 'delete' ? 'restored' : 'undid a change to');
}

async function finishUndo(user, entry, verb) {
  entry.undoneAt = new Date();
  entry.markModified('undoneAt');
  await entry.save();
  await Activity.create({
    householdId: user.householdId,
    actorId: user._id,
    actorName: user.name,
    section: entry.section,
    text: `${user.name} ${verb} ${entry.undo.label}`,
    private: entry.private,
  });
  return { ok: true };
}

// Activity shows Restore only for deleted items that are still gone.
async function canRestore(entry) {
  if (!entry.undo || entry.undoneAt) return false;
  const Model = UNDOABLE[entry.undo.model];
  if (entry.undo.kind === 'deleteMany') {
    const ids = (entry.undo.before || []).map((d) => d._id);
    return (await Model.countDocuments({ _id: { $in: ids } })) < ids.length;
  }
  if (entry.undo.kind !== 'delete') return false;
  return !(await Model.exists({ _id: entry.undo.docId }));
}

// Deleting an account removes that person's private items. Shared items stay.
async function deletePrivateData(target) {
  const filter = { householdId: target.householdId, createdBy: target._id, private: true };
  await Promise.all([
    ...Object.values(MODELS).map((M) => M.deleteMany(filter)),
    deleteUploads(filter),
    // Private log entries hold copies of those items for undo, so they go too.
    Activity.deleteMany({ householdId: target.householdId, actorId: target._id, private: true }),
  ]);
}

// Only the signed-in person's private records are visible to them.
const visible = (user) => ({ householdId: user.householdId, $or: [{ private: false }, { createdBy: user._id }] });

module.exports = { recordDeleteMany, recordChange, applyUndo, canRestore, deletePrivateData, visible };
