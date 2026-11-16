const mongoose = require('mongoose');
const { SECTIONS } = require('../lib/sections');
const { STARTER_ROLES } = require('../lib/perms');

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
    billCats: { type: [String], default: ['Housing', 'Utilities', 'Internet & phone', 'Subscriptions', 'Insurance', 'Car'] },
    pantrySpots: { type: [String], default: ['Pantry', 'Fridge', 'Freezer', 'Spices', 'Bathroom', 'Cleaning'] },
    infoTypes: { type: [String], default: ['Wi-Fi & codes', 'Contacts', 'Appliances', 'Documents & how-tos'] },
    recipeCats: { type: [String], default: ['Breakfast', 'Mains', 'Sides', 'Soups', 'Desserts', 'Snacks'] },
    recipeTags: { type: [String], default: ['Homemade', 'Online recipe', 'To try', 'Family recipes'] },
    prepStyles: { type: [String], default: ['chopped', 'diced', 'sliced', 'minced', 'grated', 'shredded', 'cubed', 'julienned', 'crushed', 'peeled', 'melted', 'softened'] },
    choreRooms: { type: [String], default: ['Kitchen', 'Bathroom', 'Bedrooms', 'Living room', 'Laundry', 'Yard'] },
    // Colors for event categories. Categories without one get a color from the palette.
    reminderColor: { type: String, default: '#A77BC9' },
    eventColors: { type: [{ _id: false, name: String, color: String }], default: [] },

    // Roles besides Admin, and what each can do. See lib/perms.js.
    roles: {
      type: [{
        _id: false,
        key: { type: String, required: true },
        name: { type: String, trim: true, maxlength: 24, required: true },
        sections: Object.fromEntries(SECTIONS.map((s) => [s.key, { type: String, enum: ['hidden', 'view', 'edit'], default: 'edit' }])),
        invite: { type: Boolean, default: false },
        settings: { type: Boolean, default: false },
        activity: { type: Boolean, default: true },
        private: { type: Boolean, default: true },
      }],
      default: () => STARTER_ROLES.map((r) => ({ ...r, sections: { ...r.sections } })),
    },

    // ---------- Household settings (admins change these in Settings) ----------
    // Section names as the household calls them ("Remember" -> "Reminders"). Missing means the default.
    sectionNames: { type: [{ _id: false, key: String, label: String }], default: [] },
    weekStart: { type: Number, enum: [0, 1], default: 0 }, // 0 Sunday, 1 Monday: Calendar and Meals
    // Shopping
    methods: { type: [String], default: ['In person', 'Online'] },
    defaultStore: { type: String, default: 'Any store' },
    tripAlerts: { type: Boolean, default: true }, // "Katie is shopping at Costco"
    tripGapMin: { type: Number, min: 5, max: 240, default: 30 },
    // Pantry
    pantryNames: { have: { type: String, default: 'Have' }, low: { type: String, default: 'Low' }, out: { type: String, default: 'Out' } },
    pantryShop: { type: String, enum: ['both', 'out', 'never'], default: 'both' }, // which statuses add to Shopping
    pantrySoonDays: { type: Number, min: 1, max: 30, default: 3 },
    pantryDefaultSpot: { type: String, default: '' },
    // Calendar, Remember, Meals
    eventAlert: { type: String, default: '60' }, // minutes before, or 'none'
    eventAlertAllDay: { type: String, default: '0' }, // '0' morning of, '1440' day before, 'none'
    eventCat: { type: String, default: 'Uncategorized' },
    remNotify: { type: String, enum: ['all', 'me', 'none'], default: 'all' },
    remCat: { type: String, default: '' }, // empty: the first category
    mealSlot: { type: String, default: '' }, // empty: the last slot
    // Bills
    billSplit: { type: String, enum: ['even', 'none'], default: 'even' },
    currency: { type: String, default: '$' },
    billAheadDays: { type: Number, min: 3, max: 90, default: 31 },
    // Home info: the fields a new item of each type starts with. Missing types use the built-in ones.
    // Chores: points are off unless turned on; then the chosen roles earn them and spend them on rewards.
    chorePoints: { type: Boolean, default: false },
    choreEarners: { type: [String], default: ['child', 'teen'] },
    rewards: { type: [{ name: { type: String, trim: true, maxlength: 60 }, cost: { type: Number, min: 1, max: 100000 } }], default: [] },
    // First-run guide for a new household: which step the admin is on. 0 means done (or skipped).
    setupStep: { type: Number, default: 0 },
    infoTemplates: { type: [{ _id: false, type: { type: String }, fields: [{ _id: false, label: String, kind: String }] }], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Household', householdSchema);
