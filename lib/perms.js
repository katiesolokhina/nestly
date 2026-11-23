// Roles and what each one can do. Admin can do everything; other roles are set per household.
const { SECTIONS } = require('./sections');
const { PARTS, fullCustom, viewCustom, fillCustom } = require('./actions');

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
      shopping: { edit: 'own', add: true, check: false, shop: false, delete: 'own', bought: 'hidden', saved: 'view' },
      chores: { edit: 'none', add: false, done: true, delete: 'none', rewards: true },
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
    return { admin: true, level: (key) => (off(key) ? 'hidden' : 'edit'), mode: (key) => (off(key) ? 'hidden' : 'edit'), custom: () => null, parts: (key) => (off(key) ? null : fullCustom(key)), can: (key) => !off(key), sees: (key) => !off(key), page: () => true, todayHidden: [], invite: true, settings: true, activity: true, private: true };
  }
  // A role that was deleted, or unknown, falls back to the first role.
  const role = roleOf(household, member.role) || plain(rolesOf(household)[0]);
  const sections = (role && role.sections) || {};
  // mode: hidden, view, edit, or custom. level: the same, with custom counted as edit (it can
  // change some things), for everything that only asks whether someone can change anything.
  const mode = (key) => (off(key) ? 'hidden' : LEVELS.includes(sections[key]) ? sections[key] : 'edit');
  const custom = (key) => (mode(key) === 'custom' ? fillCustom(key, ((role && role.custom) || {})[key]) : null);
  // Every part's choice for a section: what Edit, View or the custom picks give.
  const parts = (key) => {
    const m = mode(key);
    if (m === 'hidden') return null;
    if (m === 'edit') return fullCustom(key);
    if (m === 'view') return viewCustom(key);
    return custom(key);
  };
  const kindOf = (key, a) => ((PARTS[key] || []).find((p) => p[0] === a) || [])[2];
  return {
    admin: false,
    mode,
    level: (key) => (mode(key) === 'custom' ? 'edit' : mode(key)),
    custom,
    parts,
    // For buttons: can they do this here? doc (when given) is checked for "only their own".
    // For parts with levels (saved items, ratings), "can" means the top one: edit, rate.
    can: (key, action, doc) => {
      const c = parts(key);
      if (!c) return false;
      if (action === 'edit' || action === 'delete') return c[action] === 'all' || (c[action] === 'own' && (!doc || String(doc.createdBy) === String(member.userId)));
      const k = kindOf(key, action);
      if (k === 'area') return c[action] === 'edit';
      if (k === 'rate') return c[action] === 'rate';
      if (k === 'see') return c[action] !== 'hidden';
      return Boolean(c[action]);
    },
    // Can they see this part at all (saved items, ratings, who owes whom, passwords)?
    sees: (key, part) => { const c = parts(key); return Boolean(c) && (!part || (c[part] !== undefined ? c[part] !== 'hidden' && c[part] !== false : true)); },
    page: (key) => !role || !role.pages || role.pages[key] !== false,
    todayHidden: (role && role.todayHidden) || [],
    invite: Boolean(role && role.invite),
    settings: Boolean(role && role.settings),
    activity: role ? role.activity !== false : true,
    private: role ? role.private !== false : true,
  };
}

module.exports = { LEVELS, EXTRA, PAGES, STARTER_ROLES, rolesOf, roleOf, roleName, permsFor };
