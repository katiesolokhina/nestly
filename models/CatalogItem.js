const mongoose = require('mongoose');
const { titleCase } = require('../lib/titlecase');

// The household's saved items: every name added to Shopping, a recipe, or the pantry, with its
// usual details. They're the suggestions when typing, and staples are the one-tap ones.
// Managed on Shopping → Saved items.
const catalogSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80, set: titleCase },
    key: { type: String, required: true }, // lowercase name, so "Eggs" and "eggs" are one item
    qty: { type: String, trim: true, maxlength: 30, default: '1' },
    store: { type: String, default: 'Any store' },
    aisle: { type: String, default: 'Unassigned' },
    tag: { type: String, default: 'Unassigned' },
    method: { type: String, default: 'In person' }, // one of the household's purchase methods
    brand: { type: String, trim: true, maxlength: 80, default: '' },
    staple: { type: Boolean, default: false },
    stapleOrder: { type: Number, default: 0 }, // where it sits among staples on the Shopping page
    barcodes: { type: [String], default: [] }, // scanned codes that mean this item
    // Kinds: a brand or flavor of this item, one per barcode, with a name and photo (from the scan
    // when the product is known). Who added it and when are kept, not shown.
    kinds: {
      type: [{ _id: false, code: { type: String, maxlength: 20 }, name: { type: String, trim: true, maxlength: 60, default: '' }, photoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', default: null }, by: { type: String, default: '' }, at: { type: Date, default: Date.now } }],
      default: [],
    },
    // Skipped by default when a meal plan's ingredients go to the shopping list (salt, oil...).
    usuallyHave: { type: Boolean, default: false },
    // Bought → straight into the pantry (no date, no Put away prompt). Listed in Settings → Pantry.
    autoPantry: { type: Boolean, default: false },
  },
  { timestamps: true }
);
catalogSchema.index({ householdId: 1, key: 1 }, { unique: true });
catalogSchema.index({ householdId: 1, barcodes: 1 });

module.exports = mongoose.model('CatalogItem', catalogSchema);
