// The kinds of list in the Lists section, and what each calls things.
const TYPES = {
  places: { label: 'Places to go', one: 'place', add: 'Add a place', done: 'Been there', undone: 'To go', icon: 'pin' },
  projects: { label: 'Projects', one: 'project', add: 'Add a project', done: 'Finished', undone: 'To make', icon: 'tool' },
  watch: { label: 'To watch', one: 'show or movie', add: 'Add a show or movie', done: 'Watched', undone: 'To watch', icon: 'play' },
  wishlist: { label: 'Wishlist', one: 'wish', add: 'Add something', done: 'Got it', undone: 'Wanted', icon: 'gift' },
  packing: { label: 'Packing', one: 'thing to pack', add: 'Add things to pack', done: 'Packed', undone: 'To pack', icon: 'bag' },
  checklist: { label: 'Checklist', one: 'item', add: 'Add items', done: 'Done', undone: 'To do', icon: 'check' },
  note: { label: 'Note', one: 'note', add: '', done: '', undone: '', icon: 'note' },
};
const TYPE_KEYS = Object.keys(TYPES);

const ICONS = {
  pin: 'M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  tool: 'M14 6l4 4M4 20l7-7M13 4l7 7-3 3-7-7z',
  play: 'M5 4h14v16H5zM10 9l5 3-5 3z',
  gift: 'M4 10h16v10H4zM3 7h18v3H3zM12 7v13M12 7c-2-4-6-3-6 0M12 7c2-4 6-3 6 0',
  bag: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  check: 'M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11',
  note: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5',
};

// How a list's items can be ordered. "added" is the order they were added.
const SORTS = {
  added: 'Order added', az: 'A–Z', newest: 'Newest first',
  soonest: 'Ending soonest', // places
  release: 'Release date', // watch
};
const sortsFor = (type) => ['added', 'az', 'newest', ...(type === 'places' ? ['soonest'] : []), ...(type === 'watch' ? ['release'] : [])];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Where a place stands today: { when: 'now' | 'soon' | 'later' | 'over', text, ends }.
//  - seasonal: in season during its months (dates, if any, are this season's); otherwise "Back in Nov"
//  - dates: "Starts Dec 1", "Ends in 3 days", "Ended Jan 3"
function placeStatus(i, today, { shortDay, diffDays }) {
  const month = Number(today.slice(5, 7));
  const range = i.startDate || i.endDate ? [i.startDate && shortDay(i.startDate), i.endDate && shortDay(i.endDate)].filter(Boolean).join(' – ') : '';
  if (i.seasonal && (i.months || []).length) {
    if (!i.months.includes(month)) {
      const next = [...Array(12)].map((_, k) => ((month - 1 + k + 1) % 12) + 1).find((m) => i.months.includes(m));
      return { when: 'later', text: `Back in ${MONTHS[next - 1]}`, sortKey: '9' };
    }
  }
  if (i.startDate && i.startDate > today) return { when: 'soon', text: `Starts ${shortDay(i.startDate)}${i.endDate ? ` · until ${shortDay(i.endDate)}` : ''}`, sortKey: `2${i.startDate}` };
  if (i.endDate && i.endDate < today) {
    if (i.seasonal) return { when: 'later', text: `Back next season${range ? ` (${range})` : ''}`, sortKey: '9' };
    return { when: 'over', text: `Ended ${shortDay(i.endDate)}`, sortKey: '9' };
  }
  if (i.endDate) {
    const d = diffDays(today, i.endDate);
    return { when: 'now', text: d === 0 ? 'Ends today' : d <= 14 ? `Ends in ${d} day${d === 1 ? '' : 's'}` : `Until ${shortDay(i.endDate)}`, ending: d <= 7, sortKey: `1${i.endDate}` };
  }
  return { when: 'now', text: i.seasonal && (i.months || []).length ? `In season (${i.months.map((m) => MONTHS[m - 1].slice(0, 3)).join(', ')})` : range, sortKey: '5' };
}

// A wishlist's owner doesn't see who's getting what; everyone else does.
const seesClaims = (list, user) => list.type === 'wishlist' && String(list.ownerId || list.createdBy) !== String(user._id);

// Lists this person can open: shared ones, and their own private ones.
module.exports = { TYPES, TYPE_KEYS, ICONS, SORTS, sortsFor, MONTHS, placeStatus, seesClaims };
