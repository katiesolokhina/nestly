const mongoose = require('mongoose');

// The household's shared list of things it buys. Shopping and staples use it now; recipes and
// the pantry will use the same list, so a new ingredient is immediately available everywhere.
const catalogSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    key: { type: String, required: true }, // lowercase name, so "Eggs" and "eggs" are one item
    qty: { type: String, trim: true, maxlength: 30, default: '1' },
    store: { type: String, default: 'Any store' },
    aisle: { type: String, default: 'Unassigned' },
    tag: { type: String, default: 'Unassigned' },
    method: { type: String, enum: ['In person', 'Online'], default: 'In person' },
    brand: { type: String, trim: true, maxlength: 80, default: '' },
    staple: { type: Boolean, default: false },
    // Skipped by default when a meal plan's ingredients go to the shopping list (salt, oil...).
    usuallyHave: { type: Boolean, default: false },
  },
  { timestamps: true }
);
catalogSchema.index({ householdId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('CatalogItem', catalogSchema);
