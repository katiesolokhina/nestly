const mongoose = require('mongoose');
const { titleCase } = require('../lib/titlecase');

// Something the household keeps at home, and whether there's enough of it.
const pantrySchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    name: { type: String, required: true, trim: true, maxlength: 80, set: titleCase },
    key: { type: String, required: true }, // same as the shopping list's, so the two stay linked
    status: { type: String, enum: ['have', 'low', 'out'], default: 'have' },
    spot: { type: String, default: 'Other' }, // Pantry, Fridge, Freezer...
    // How many there are, by use-by date: [{ count: 2, expires: '2026-11-25' }, { count: 1, expires: '' }].
    // count and expires below follow from these (total, and the soonest date), for lists and alerts.
    // bought: when that batch was bought (YYYY-MM-DD), filled in from Shopping or the day it was added.
    batches: { type: [{ count: { type: Number, min: 1, max: 999 }, expires: { type: String, default: '' }, bought: { type: String, default: '' } }], default: undefined },
    count: { type: Number, min: 0, max: 999, default: 1 }, // how many (2 milks); −1 as they're used
    amount: { type: String, trim: true, maxlength: 40, default: '' }, // each one: "1 gallon"
    expires: { type: String, default: '' }, // YYYY-MM-DD use-by date, optional
    autoShop: { type: Boolean, default: true }, // Low or Out puts it on the shopping list
    // Food (used for recipes)? null: decided by its spot (Settings → Pantry → Not food).
    food: { type: Boolean, default: null },
    note: { type: String, trim: true, maxlength: 300, default: '' },
    tags: { type: [String], default: [] }, // from the household's pantry tags (Snacks, Spicy…)
    photoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', default: null }, // what it looks like (the brand you buy)
    statusBy: { type: String, default: '' },
    statusAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// Keeps count and expires in step with the batches, and turns older items (just a count and a
// date) into one batch the first time they're saved.
pantrySchema.methods.syncBatches = function syncBatches() {
  if (!this.batches) this.batches = this.status !== 'out' && this.count > 0 ? [{ count: this.count, expires: this.expires || '' }] : [];
  this.batches = this.batches.filter((b) => b.count > 0);
  this.count = this.batches.reduce((n, b) => n + b.count, 0);
  const dates = this.batches.map((b) => b.expires).filter(Boolean).sort();
  this.expires = dates[0] || '';
  if (this.count === 0) this.status = 'out';
  else if (this.status === 'out') this.status = 'have';
};
pantrySchema.pre('validate', function () { this.syncBatches(); });

// Not unique: the same thing can be kept as separate items (two milks with different dates).
pantrySchema.index({ householdId: 1, key: 1 });

module.exports = mongoose.model('PantryItem', pantrySchema);
