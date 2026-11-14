const mongoose = require('mongoose');

const recipeSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, default: 'Uncategorized' },
    servings: { type: String, trim: true, maxlength: 40, default: '' },
    time: { type: String, trim: true, maxlength: 40, default: '' }, // "45 min"
    // Each ingredient: an amount ("2 cups") and a name ("flour, sifted"). The name before a comma
    // is what goes on the shopping list.
    ingredients: { type: [{ _id: false, qty: { type: String, maxlength: 40 }, name: { type: String, maxlength: 120 } }], default: [] },
    steps: { type: [{ type: String, maxlength: 2000 }], default: [] },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    link: { type: String, trim: true, maxlength: 1000, default: '' },
    photoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', default: null },
  },
  { timestamps: true }
);
recipeSchema.index({ householdId: 1, title: 1 });

module.exports = mongoose.model('Recipe', recipeSchema);
