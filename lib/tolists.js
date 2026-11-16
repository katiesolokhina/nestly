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

// A wishlist's owner doesn't see who's getting what; everyone else does.
const seesClaims = (list, user) => list.type === 'wishlist' && String(list.ownerId || list.createdBy) !== String(user._id);

// Lists this person can open: shared ones, and their own private ones.
module.exports = { TYPES, TYPE_KEYS, ICONS, seesClaims };
