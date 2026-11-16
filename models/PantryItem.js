const mongoose = require('mongoose');

// Something the household keeps at home, and whether there's enough of it.
const pantrySchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    key: { type: String, required: true }, // same as the shopping list's, so the two stay linked
    status: { type: String, enum: ['have', 'low', 'out'], default: 'have' },
    spot: { type: String, default: 'Other' }, // Pantry, Fridge, Freezer...
    count: { type: Number, min: 0, max: 999, default: 1 }, // how many (2 milks); −1 as they're used
    amount: { type: String, trim: true, maxlength: 40, default: '' }, // each one: "1 gallon"
    expires: { type: String, default: '' }, // YYYY-MM-DD use-by date, optional
    autoShop: { type: Boolean, default: true }, // Low or Out puts it on the shopping list
    note: { type: String, trim: true, maxlength: 300, default: '' },
    photoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', default: null }, // what it looks like (the brand you buy)
    statusBy: { type: String, default: '' },
    statusAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// Not unique: the same thing can be kept as separate items (two milks with different dates).
pantrySchema.index({ householdId: 1, key: 1 });

module.exports = mongoose.model('PantryItem', pantrySchema);
