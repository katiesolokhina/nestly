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
    tags: { type: [String], default: [] }, // from the household's recipe tags: Homemade, To try...
    // Each ingredient: an amount ("1"), a type ("red"), the item ("bell pepper"), and how it's
    // prepared ("diced"). Type and item go on the shopping list ("red bell pepper"); prep doesn't.
    // Older recipes may have notes after a comma in the name ("onion, diced"); those stay off the list too.
    ingredients: {
      type: [{
        _id: false,
        qty: { type: String, maxlength: 40 },
        type: { type: String, maxlength: 40, default: '' },
        name: { type: String, maxlength: 120 },
        prep: { type: String, maxlength: 60, default: '' },
      }],
      default: [],
    },
    steps: { type: [{ type: String, maxlength: 2000 }], default: [] },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    link: { type: String, trim: true, maxlength: 1000, default: '' },
    photoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', default: null },
  },
  { timestamps: true }
);
recipeSchema.index({ householdId: 1, title: 1 });

module.exports = mongoose.model('Recipe', recipeSchema);
