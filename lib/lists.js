// Lists a household can customize, and where each list's values are stored on records.
const ShoppingItem = require('../models/ShoppingItem');
const CatalogItem = require('../models/CatalogItem');
const Reminder = require('../models/Reminder');
const Event = require('../models/Event');

const LISTS = {
  stores: { title: 'Stores', one: 'store', group: 'Shopping', feature: 'shopping', fallback: 'Any store', apply: [[ShoppingItem, 'store'], [CatalogItem, 'store']] },
  aisles: { title: 'Aisles', one: 'aisle', group: 'Shopping', feature: 'shopping', fallback: 'Unassigned', apply: [[ShoppingItem, 'aisle'], [CatalogItem, 'aisle']] },
  tags: { title: 'Item tags', one: 'tag', group: 'Shopping', feature: 'shopping', fallback: 'Unassigned', apply: [[ShoppingItem, 'tag'], [CatalogItem, 'tag']] },
  remCats: { title: 'Reminder categories', one: 'category', group: 'Remember', feature: 'remember', fallback: 'Uncategorized', apply: [[Reminder, 'category']] },
  eventCats: { title: 'Event categories', one: 'category', group: 'Calendar', feature: 'calendar', fallback: 'Uncategorized', apply: [[Event, 'category']] },
};

// Accepts a value only if it's in the household's list; anything else becomes the fallback.
const pick = (household, key, value) => (household[key].includes(value) ? value : LISTS[key].fallback);

module.exports = { LISTS, pick };
