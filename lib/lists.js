// Lists a household can customize, and where each list's values are stored on records.
const ShoppingItem = require('../models/ShoppingItem');
const CatalogItem = require('../models/CatalogItem');
const Reminder = require('../models/Reminder');
const Event = require('../models/Event');
const Recipe = require('../models/Recipe');
const Meal = require('../models/Meal');
const Bill = require('../models/Bill');
const BillSeries = require('../models/BillSeries');
const PantryItem = require('../models/PantryItem');
const InfoItem = require('../models/InfoItem');
const Chore = require('../models/Chore');

const LISTS = {
  methods: { title: 'Purchase methods', one: 'method', group: 'Shopping', feature: 'shopping', fallback: 'In person', apply: [[ShoppingItem, 'method'], [CatalogItem, 'method']] },
  stores: { title: 'Stores', one: 'store', group: 'Shopping', feature: 'shopping', fallback: 'Any store', apply: [[ShoppingItem, 'store'], [CatalogItem, 'store']] },
  aisles: { title: 'Aisles', one: 'aisle', group: 'Shopping', feature: 'shopping', fallback: 'Unassigned', apply: [[ShoppingItem, 'aisle'], [CatalogItem, 'aisle']] },
  tags: { title: 'Item tags', one: 'tag', group: 'Shopping', feature: 'shopping', fallback: 'Unassigned', apply: [[ShoppingItem, 'tag'], [CatalogItem, 'tag']] },
  remCats: { title: 'Reminder categories', one: 'category', group: 'Remember', feature: 'remember', fallback: 'Uncategorized', apply: [[Reminder, 'category']] },
  eventCats: { title: 'Event categories', one: 'category', group: 'Calendar', feature: 'calendar', fallback: 'Uncategorized', apply: [[Event, 'category']] },
  mealSlots: { title: 'Meal slots', one: 'meal slot', group: 'Meals', feature: 'meals', fallback: 'Other', apply: [[Meal, 'slot']] },
  billCats: { title: 'Bill categories', one: 'category', group: 'Bills', feature: 'bills', fallback: 'Uncategorized', apply: [[Bill, 'category'], [BillSeries, 'category']] },
  pantrySpots: { title: 'Pantry spots', one: 'spot', group: 'Pantry', feature: 'pantry', fallback: 'Other', apply: [[PantryItem, 'spot']] },
  infoTypes: { title: 'Home info types', one: 'type', group: 'Home info', feature: 'info', fallback: 'Other', apply: [[InfoItem, 'type']] },
  choreRooms: { title: 'Rooms and areas', one: 'room', group: 'Chores', feature: 'chores', fallback: 'Anywhere', apply: [[Chore, 'room']] },
  recipeCats: { title: 'Recipe categories', one: 'category', group: 'Recipes', feature: 'recipes', fallback: 'Uncategorized', apply: [[Recipe, 'category']] },
};

// Colors that read well on both the light and dark backgrounds.
const PALETTE = ['#1D6FA3', '#B4236B', '#3F7D5A', '#C2410C', '#6B4C8F', '#0F766E', '#8A6D1F', '#7C3AED'];
const NO_CATEGORY_COLOR = '#8E889C';
const HEX = /^#[0-9a-f]{6}$/i;

const REMINDER_COLOR = '#A77BC9';
const reminderColor = (household) => (HEX.test(household.reminderColor || '') ? household.reminderColor : REMINDER_COLOR);

function categoryColor(household, name) {
  const saved = (household.eventColors || []).find((c) => c.name === name);
  if (saved && HEX.test(saved.color)) return saved.color;
  const i = (household.eventCats || []).indexOf(name);
  return i < 0 ? NO_CATEGORY_COLOR : PALETTE[i % PALETTE.length];
}

// Accepts a value only if it's in the household's list; anything else becomes the fallback.
const pick = (household, key, value) => (household[key].includes(value) ? value : LISTS[key].fallback);

module.exports = { LISTS, pick, categoryColor, reminderColor, PALETTE, HEX, NO_CATEGORY_COLOR };
