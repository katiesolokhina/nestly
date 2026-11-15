const mongoose = require('mongoose');

// The household's saved items: every name added to Shopping, a recipe, or the pantry, with its
// usual details. They're the suggestions when typing, and staples are the one-tap ones.
// Managed on Shopping → Saved items.
const catalogSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    key: { type: String, required: true }, // lowercase name, so "Eggs" and "eggs" are one item
    qty: { type: String, trim: true, maxlength: 30, default: '1' },
    store: { type: String, default: 'Any store' },
    aisle: { type: String, default: 'Unassigned' },
    tag: { type: String, default: 'Unassigned' },
    method: { type: String, default: 'In person' }, // one of the household's purchase methods
    brand: { type: String, trim: true, maxlength: 80, default: '' },
    staple: { type: Boolean, default: false },
    stapleOrder: { type: Number, default: 0 }, // where it sits among staples on the Shopping page
    // Skipped by default when a meal plan's ingredients go to the shopping list (salt, oil...).
    usuallyHave: { type: Boolean, default: false },
  },
  { timestamps: true }
);
catalogSchema.index({ householdId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('CatalogItem', catalogSchema);
