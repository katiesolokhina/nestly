const mongoose = require('mongoose');
const { titleCase } = require('../lib/titlecase');

// One meal on the plan: a recipe, or just a name ("Leftovers", "Pizza night").
const mealSchema = new mongoose.Schema(
  {
    householdId: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, required: true },
    private: { type: Boolean, default: false },
    date: { type: String, required: true }, // YYYY-MM-DD
    slot: { type: String, required: true },
    recipeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe', default: null },
    title: { type: String, trim: true, maxlength: 120, default: '', set: titleCase }, // the recipe's name when planned, or what was typed
    note: { type: String, trim: true, maxlength: 300, default: '' },
    servings: { type: Number, min: 1, max: 200, default: null }, // planned servings; the week's shopping scales the recipe to it
  },
  { timestamps: true }
);
mealSchema.index({ householdId: 1, date: 1 });

module.exports = mongoose.model('Meal', mealSchema);
