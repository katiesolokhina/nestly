// The sections an admin can turn on and off, plus the icons the navigation uses.
const SECTIONS = [
  { key: 'shopping', label: 'Shopping', icon: 'M6 7h12l1 13H5L6 7ZM9 7a3 3 0 0 1 6 0' },
  { key: 'remember', label: 'Remember', icon: 'M6 4h12v17l-6-4-6 4z' },
  { key: 'calendar', label: 'Calendar', icon: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4' },
  { key: 'meals', label: 'Meals', icon: 'M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10M17 3c-2 2-3 5-3 8h3v10' },
  { key: 'recipes', label: 'Recipes', icon: 'M5 4h14v16H5zM9 8h6M9 12h6M9 16h4' },
  { key: 'pantry', label: 'Pantry', icon: 'M5 3h14v18H5zM5 9h14M5 15h14' },
  { key: 'bills', label: 'Bills', icon: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6' },
  { key: 'chores', label: 'Chores', icon: 'M4 12l5 5L20 6' },
  { key: 'lists', label: 'Lists', icon: 'M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11' },
  { key: 'info', label: 'Home info', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.5' },
];
const ICONS = {
  today: 'M3 11l9-8 9 8M5 10v10h14V10',
  more: 'M4 7h16M4 12h16M4 17h16',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  settings: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4M16 4v4M8 10v4M14 16v4',
  spending: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
};
const MAX_PINS = 3;

const sectionByKey = (key) => SECTIONS.find((s) => s.key === key);
const enabledSections = (household) => SECTIONS.filter((s) => household.features[s.key] !== false);

// Today, up to three pinned sections, then More. "active" is the current page's key.
// member: this person's membership in the household (pins are per household).
function bottomBar(member, household, active) {
  const pinned = (member.pins || []).filter((k) => sectionByKey(k) && household.features[k] !== false).slice(0, MAX_PINS);
  const inBar = ['today', ...pinned];
  return [
    { key: 'today', label: 'Today', icon: ICONS.today, href: '/', on: active === 'today' },
    ...pinned.map((k) => ({ ...sectionByKey(k), label: sectionName(household, k), href: `/s/${k}`, on: active === k })),
    { key: 'more', label: 'More', icon: ICONS.more, href: '/more', on: !inBar.includes(active) },
  ];
}

// Everything in More: what isn't pinned, then Activity and Settings.
function moreLinks(member, household, perms) {
  const pins = member.pins || [];
  return [
    ...enabledSections(household).filter((s) => !pins.includes(s.key)).map((s) => ({ ...s, label: sectionName(household, s.key), href: `/s/${s.key}` })),
    ...((household.features.shopping !== false || household.features.bills !== false) && (!perms || perms.page('spending')) ? [{ key: 'spending', label: 'Spending', icon: ICONS.spending, href: '/spending' }] : []),
    ...(perms && !perms.activity ? [] : [{ key: 'activity', label: 'Activity', icon: ICONS.activity, href: '/activity' }]),
    { key: 'settings', label: 'Settings', icon: ICONS.settings, href: '/settings' },
  ];
}

// Late require: prefs reads SECTIONS from here.
function sectionName(household, key) { return require('./prefs').sectionName(household, key); }

module.exports = { SECTIONS, MAX_PINS, sectionByKey, enabledSections, bottomBar, moreLinks };
