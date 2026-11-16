const mongoose = require('mongoose');
const { titleCase } = require('../lib/titlecase');

// A list in the Lists section: places to go, projects, things to watch, a wishlist, a packing
// list, a note, or a plain checklist. Its items live inside it (lists stay small).
const itemSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 160, set: titleCase },
    done: { type: Boolean, default: false }, // been there, watched, packed, finished, got it
    doneAt: { type: String, default: '' }, // YYYY-MM-DD
    doneBy: { type: String, default: '' },
    note: { type: String, trim: true, maxlength: 500, default: '' },
    link: { type: String, trim: true, maxlength: 1000, default: '' },
    address: { type: String, trim: true, maxlength: 200, default: '' }, // places
    kind: { type: String, enum: ['', 'movie', 'show'], default: '' }, // watch
    where: { type: String, trim: true, maxlength: 60, default: '' }, // watch: Netflix, Max...
    watching: { type: Boolean, default: false }, // watch: started it
    wantIds: { type: [mongoose.Schema.Types.ObjectId], default: [] }, // watch: who wants to see it
    price: { type: String, trim: true, maxlength: 20, default: '' }, // wishlist
    qty: { type: String, trim: true, maxlength: 20, default: '' }, // packing
    // Wishlist surprise: someone is getting it. The list's owner never sees this.
    claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    claimedName: { type: String, default: '' },
    addedBy: { type: String, default: '' },
  },
  { timestamps: true }
);

const listSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    type: { type: String, enum: ['places', 'projects', 'watch', 'wishlist', 'packing', 'note', 'checklist'], default: 'checklist' },
    title: { type: String, required: true, trim: true, maxlength: 80, set: titleCase },
    body: { type: String, trim: true, maxlength: 10000, default: '' }, // notes
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // wishlist: whose it is
    ownerName: { type: String, default: '' },
    date: { type: String, default: '' }, // packing: the trip, YYYY-MM-DD
    endDate: { type: String, default: '' },
    pinned: { type: Boolean, default: false },
    items: { type: [itemSchema], default: [] },
  },
  { timestamps: true }
);
listSchema.index({ householdId: 1, type: 1, updatedAt: -1 });

module.exports = mongoose.model('List', listSchema);
