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
    amount: { type: String, trim: true, maxlength: 40, default: '' }, // "2 cans", "half a bag"
    expires: { type: String, default: '' }, // YYYY-MM-DD use-by date, optional
    autoShop: { type: Boolean, default: true }, // Low or Out puts it on the shopping list
    note: { type: String, trim: true, maxlength: 300, default: '' },
    photoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', default: null }, // what it looks like (the brand you buy)
    statusBy: { type: String, default: '' },
    statusAt: { type: Date, default: null },
  },
  { timestamps: true }
);
pantrySchema.index({ householdId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('PantryItem', pantrySchema);
