// Every change to shared data goes through here, so each one is logged and can be undone.
const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const ShoppingItem = require('../models/ShoppingItem');
const Reminder = require('../models/Reminder');
const Event = require('../models/Event');
const Recipe = require('../models/Recipe');
const Meal = require('../models/Meal');
const { deleteUploads } = require('./uploads');

const MODELS = { ShoppingItem, Reminder, Event, Recipe, Meal };
const plain = (doc) => (doc.toObject ? doc.toObject({ depopulate: true, versionKey: true }) : doc);

// kind: create | update | delete. "before" is the document's state before the change.
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
  const Model = MODELS[model];
  const scope = { _id: new mongoose.Types.ObjectId(String(docId)), householdId: user.householdId };
  const current = await Model.findOne(scope).lean();

  if (kind === 'delete') {
    if (current) return { ok: false, message: 'That item is already back.' };
    await Model.collection.insertOne(before);
  } else {
    if (!current || new Date(current.updatedAt).getTime() !== new Date(afterAt).getTime()) return { ok: false, message: CHANGED };
    if (kind === 'create') await Model.deleteOne(scope);
    else await Model.collection.replaceOne({ _id: scope._id }, before);
  }

  entry.undoneAt = new Date();
  entry.markModified('undoneAt');
  await entry.save();
  await Activity.create({
    householdId: user.householdId,
    actorId: user._id,
    actorName: user.name,
    section: entry.section,
    text: `${user.name} ${kind === 'delete' ? 'restored' : 'undid a change to'} ${entry.undo.label}`,
    private: entry.private,
  });
  return { ok: true };
}

// Activity shows Restore only for deleted items that are still gone.
async function canRestore(entry) {
  if (!entry.undo || entry.undo.kind !== 'delete' || entry.undoneAt) return false;
  const Model = MODELS[entry.undo.model];
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

module.exports = { recordChange, applyUndo, canRestore, deletePrivateData, visible };
