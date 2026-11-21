// Roles and what each one can do. Admin can do everything; other roles are set per household.
const { SECTIONS } = require('./sections');

const LEVELS = ['hidden', 'view', 'edit', 'custom'];
const EXTRA = {
  invite: 'Invite people',
  settings: 'Change section settings, lists, and defaults',
  activity: 'See Activity',
  private: 'Use “Only me” (private items)',
};

// App pages that aren't sections. A role can be kept off any of them.
const PAGES = {
  spending: 'Spending',
  search: 'Search',
  feedback: 'Report a bug or suggest a feature',
  households: 'Start or copy households',
};

// What a household starts with. Admins can rename, change, add, and delete these.
const all = (level) => Object.fromEntries(SECTIONS.map((s) => [s.key, level]));
const STARTER_ROLES = [
  { key: 'member', name: 'Member', sections: all('edit'), invite: false, settings: false, activity: true, private: true },
  { key: 'teen', name: 'Teen', sections: { ...all('edit'), bills: 'view', info: 'view' }, invite: false, settings: false, activity: true, private: true },
  {
    key: 'child', name: 'Child',
    sections: { ...all('view'), shopping: 'custom', remember: 'edit', chores: 'custom', lists: 'edit', bills: 'hidden', info: 'hidden' },
    // Children add to the list, but don't check things off or start shopping; they mark their chores done.
    custom: {
      shopping: { add: true, check: false, shop: false, saved: false, edit: 'own', delete: 'own' },
      chores: { add: false, done: true, rewards: true, edit: 'none', delete: 'none' },
    },
    pages: { spending: false, households: false },
    invite: false, settings: false, activity: false, private: false,
  },
];

const rolesOf = (household) => (household && household.roles && household.roles.length ? household.roles : STARTER_ROLES);
const plain = (r) => (r && typeof r.toObject === 'function' ? r.toObject() : r);
const roleOf = (household, key) => plain(rolesOf(household).find((r) => r.key === key)) || null;
const roleName = (household, key) => (key === 'admin' ? 'Admin' : (roleOf(household, key) || { name: 'Member' }).name);

// Everything one person can do in one household.
function permsFor(household, member) {
  const off = (key) => household.features && household.features[key] === false;
  if (!member || member.role === 'admin') {
    return { admin: true, level: (key) => (off(key) ? 'hidden' : 'edit'), mode: (key) => (off(key) ? 'hidden' : 'edit'), custom: () => null, can: (key) => !off(key), page: () => true, todayHidden: [], invite: true, settings: true, activity: true, private: true };
  }
  // A role that was deleted, or unknown, falls back to the first role.
  const role = roleOf(household, member.role) || plain(rolesOf(household)[0]);
  const sections = (role && role.sections) || {};
  // mode: hidden, view, edit, or custom. level: the same, with custom counted as edit (it can
  // change some things), for everything that only asks whether someone can change anything.
  const mode = (key) => (off(key) ? 'hidden' : LEVELS.includes(sections[key]) ? sections[key] : 'edit');
  const custom = (key) => (mode(key) === 'custom' ? ((role && role.custom) || {})[key] || {} : null);
  return {
    admin: false,
    mode,
    level: (key) => (mode(key) === 'custom' ? 'edit' : mode(key)),
    custom,
    // For buttons: can they do this here? doc (when given) is checked for "only their own".
    can: (key, action, doc) => {
      const m = mode(key);
      if (m === 'edit') return true;
      if (m !== 'custom') return false;
      const c = custom(key);
      if (action === 'edit' || action === 'delete') return c[action] === 'all' || (c[action] === 'own' && (!doc || String(doc.createdBy) === String(member.userId)));
      return Boolean(c[action]);
    },
    page: (key) => !role || !role.pages || role.pages[key] !== false,
    todayHidden: (role && role.todayHidden) || [],
    invite: Boolean(role && role.invite),
    settings: Boolean(role && role.settings),
    activity: role ? role.activity !== false : true,
    private: role ? role.private !== false : true,
  };
}

module.exports = { LEVELS, EXTRA, PAGES, STARTER_ROLES, rolesOf, roleOf, roleName, permsFor };
