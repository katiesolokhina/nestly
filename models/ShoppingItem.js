const mongoose = require('mongoose');

const shoppingSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    key: { type: String, required: true },
    qty: { type: String, trim: true, maxlength: 30, default: '1' },
    price: { type: Number, min: 0, default: null },
    method: { type: String, default: 'In person' }, // one of the household's purchase methods
    store: { type: String, default: 'Any store' },
    aisle: { type: String, default: 'Unassigned' },
    tag: { type: String, default: 'Unassigned' },
    brand: { type: String, trim: true, maxlength: 80, default: '' },
    ref: { type: String, trim: true, maxlength: 160, default: '' },
    link: { type: String, trim: true, maxlength: 1000, default: '' },
    note: { type: String, trim: true, maxlength: 300, default: '' },
    receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', default: null },
    photoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', default: null },
    bought: { type: Boolean, default: false },
    boughtAt: { type: Date, default: null },
    boughtByName: { type: String, default: '' },
    // Cleared items leave the list but stay as price history.
    clearedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
shoppingSchema.index({ householdId: 1, bought: 1, clearedAt: 1 });
shoppingSchema.index({ householdId: 1, key: 1, boughtAt: -1 });

module.exports = mongoose.model('ShoppingItem', shoppingSchema);
