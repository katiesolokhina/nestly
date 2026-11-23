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
    eventCats: { type: [String], default: ['Appointments', 'Birthdays', 'Holidays', 'Family', 'Home'] },
    mealSlots: { type: [String], default: ['Breakfast', 'Lunch', 'Dinner'] },
    billCats: { type: [String], default: ['Housing', 'Utilities', 'Internet & phone', 'Subscriptions', 'Insurance', 'Car'] },
    pantrySpots: { type: [String], default: ['Pantry', 'Fridge', 'Freezer', 'Spices', 'Bathroom', 'Cleaning'] },
    // Spots whose things aren't food, so recipes and "use soon" leave them out.
    // Where to watch (Lists → To watch); editable in Settings → Lists.
    watchServices: { type: [String], default: ['Netflix', 'Hulu', 'Disney+', 'Max', 'Prime Video', 'Apple TV+', 'Peacock', 'Paramount+', 'YouTube', 'Theater'] },
    nonFoodSpots: { type: [String], default: ['Cleaning', 'Bathroom', 'Laundry', 'Medicine cabinet', 'Pet supplies', 'Bulk storage', 'Under sink'] },
    // Where things bought from each shopping aisle are kept: [{ aisle, spot }]. Unset aisles are guessed.
    aisleSpots: { type: [{ _id: false, aisle: String, spot: String }], default: [] },
    infoTypes: { type: [String], default: ['Wi-Fi & codes', 'Contacts', 'Appliances', 'Documents & how-tos'] },
    recipeCats: { type: [String], default: ['Breakfast', 'Mains', 'Sides', 'Soups', 'Desserts', 'Snacks'] },
    recipeTags: { type: [String], default: ['Homemade', 'Online recipe', 'To try', 'Family recipes'] },
    recipeMoods: { type: [String], default: ['Quick', 'Use it up', 'Sweet', 'Spicy', 'Soup', 'Pasta', 'Comfort'] },
    pantryTags: { type: [String], default: ['Snacks', 'Sweet', 'Salty', 'Spicy', 'Fruity', 'Chocolatey', 'Baking', 'Kids'] },
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
        sections: Object.fromEntries(SECTIONS.map((s) => [s.key, { type: String, enum: ['hidden', 'view', 'edit', 'custom'], default: 'edit' }])),
        // For sections set to custom: { shopping: { add: true, check: false, edit: 'own', ... } } (lib/actions)
        custom: { type: mongoose.Schema.Types.Mixed, default: {} },
        // App pages this role can't open (lib/perms PAGES): { spending: false }
        pages: { type: mongoose.Schema.Types.Mixed, default: {} },
        todayHidden: { type: [String], default: [] }, // Today cards this role doesn't get
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
    // On Today, pantry things past their date: show | week (for a week after) | hide. Each person
    // can choose their own in Today → Customize; this is for everyone who hasn't.
    todayExpired: { type: String, enum: ['show', 'week', 'hide'], default: 'week' },
    // Ratings (Buy again / Never again…): the choices, in order. warn: shows as a warning on
    // scans and Shopping. Empty means the starting three.
    ratingChoices: {
      type: [{ _id: false, id: { type: String, maxlength: 24 }, name: { type: String, maxlength: 24 }, color: { type: String, maxlength: 12 }, warn: { type: Boolean, default: false } }],
      default: [],
    },
    ratingPrompt: { type: Boolean, default: true }, // ask "Buy again?" after putting away or buying
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
    // Activity older than this many months is cleared each day; 0 keeps everything.
    activityKeepMonths: { type: Number, enum: [0, 1, 3, 6, 12, 24], default: 0 },
    // New-item defaults (Settings → Defaults); '' / false means off.
    shopTag: { type: String, default: '' },
    eventFor: { type: Boolean, default: false }, // new events are for whoever adds them
    shopMethod: { type: String, default: '' },
    shopPrivate: { type: Boolean, default: false },
    recipeCat: { type: String, default: '' },
    choreWho: { type: String, default: '' },
    choreRoom: { type: String, default: '' },
    billCat: { type: String, default: '' },
    // First-run guide for a new household: which step the admin is on. 0 means done (or skipped).
    setupStep: { type: Number, default: 0 },
    infoTemplates: { type: [{ _id: false, type: { type: String }, fields: [{ _id: false, label: String, kind: String }] }], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Household', householdSchema);
