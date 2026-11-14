const mongoose = require('mongoose');
const { SECTIONS } = require('../lib/sections');

// Everything shared belongs to a household, so one person's data can never reach another home.
const featureDefaults = Object.fromEntries(SECTIONS.map((s) => [s.key, { type: Boolean, default: true }]));

const householdSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // Admin-controlled. Off hides a section for everyone and keeps its data.
    features: featureDefaults,
    // Lists each household can add to, rename, reorder, and remove from.
    stores: { type: [String], default: ['Kroger', 'H-E-B', 'Costco', 'Target'] },
    aisles: { type: [String], default: ['Produce', 'Dairy & eggs', 'Meat & seafood', 'Frozen', 'Pantry', 'Household'] },
    tags: { type: [String], default: ['Groceries', 'Home', 'Gift', 'School'] },
    remCats: { type: [String], default: ['Errands', 'Car', 'Home', 'Family'] },
    eventCats: { type: [String], default: ['Appointments', 'Birthdays', 'Family', 'Home'] },
    mealSlots: { type: [String], default: ['Breakfast', 'Lunch', 'Dinner'] },
    recipeCats: { type: [String], default: ['Breakfast', 'Mains', 'Sides', 'Soups', 'Desserts', 'Snacks'] },
    // Colors for event categories. Categories without one get a color from the palette.
    reminderColor: { type: String, default: '#A77BC9' },
    eventColors: { type: [{ _id: false, name: String, color: String }], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Household', householdSchema);
