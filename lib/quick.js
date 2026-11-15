// Taps that change one row (tick, delete) are sent by public/js/quick.js without reloading
// the page. Those requests get JSON back; everything else gets the usual redirect.
const Activity = require('../models/Activity');

const isQuick = (req) => req.get('X-Requested-With') === 'fetch';

// The Undo bar for the change just made, then cleared so the next page doesn't show it again.
async function takeUndo(req) {
  const id = req.session.undoId;
  delete req.session.undoId;
  if (!id) return null;
  const entry = await Activity.findById(id, { text: 1 }).lean();
  return entry ? { id: String(entry._id), text: entry.text } : null;
}

module.exports = { isQuick, takeUndo };
