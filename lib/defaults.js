// New-item defaults, all in Settings → Defaults. Each is on (a chosen value) or off (the
// section's usual behavior). Shopping defaults win over what a saved item remembers.
const has = (list, v) => Boolean(v) && (list || []).includes(v);

// What each default is, the section it belongs to, and what "off" means.
const ROWS = [
  { field: 'defaultStore', section: 'shopping', label: 'Store', list: (h) => h.stores, off: 'Any store', offText: 'Any store, or the store an item was last bought at' },
  { field: 'shopTag', section: 'shopping', label: 'Tag', list: (h) => h.tags, off: '', offText: 'The tag an item had last time' },
  { field: 'shopMethod', section: 'shopping', label: 'How it’s bought', list: (h) => h.methods, off: '', offText: 'How an item was bought last time' },
  { field: 'shopPrivate', section: 'shopping', label: 'Start private (only whoever adds it sees it)', bool: true, offText: 'Everyone sees new items' },
  { field: 'eventCat', section: 'calendar', label: 'Event category', list: (h) => h.eventCats, off: 'Uncategorized', offText: 'Uncategorized' },
  { field: 'remCat', section: 'remember', label: 'Reminder category', list: (h) => h.remCats, off: '', offText: 'The first category' },
  { field: 'mealSlot', section: 'meals', label: 'Meal', list: (h) => h.mealSlots, off: '', offText: 'The last meal of the day' },
  { field: 'recipeCat', section: 'recipes', label: 'Recipe category', list: (h) => h.recipeCats, off: '', offText: 'Uncategorized' },
  { field: 'pantryDefaultSpot', section: 'pantry', label: 'Pantry spot', list: (h) => h.pantrySpots, off: '', offText: 'The first spot' },
  { field: 'choreWho', section: 'chores', label: 'Who does it', people: true, off: '', offText: 'Anyone' },
  { field: 'choreRoom', section: 'chores', label: 'Room', list: (h) => h.choreRooms, off: '', offText: 'Anywhere' },
  { field: 'billCat', section: 'bills', label: 'Bill category', list: (h) => h.billCats, off: '', offText: 'Uncategorized' },
];

// The defaults that are on and still valid (a removed category doesn't linger).
function defaultsOf(h) {
  return {
    store: has(h.stores, h.defaultStore) ? h.defaultStore : '',
    tag: has(h.tags, h.shopTag) ? h.shopTag : '',
    method: has(h.methods, h.shopMethod) ? h.shopMethod : '',
    private: Boolean(h.shopPrivate),
    recipeCat: has(h.recipeCats, h.recipeCat) ? h.recipeCat : '',
    choreRoom: has(h.choreRooms, h.choreRoom) ? h.choreRoom : '',
    choreWho: /^[a-f0-9]{24}$/.test(String(h.choreWho || '')) ? String(h.choreWho) : '',
    billCat: has(h.billCats, h.billCat) ? h.billCat : '',
  };
}

module.exports = { ROWS, defaultsOf };
