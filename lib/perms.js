// Roles and what each one can do. Admin can do everything; other roles are set per household.
const { SECTIONS } = require('./sections');

const LEVELS = ['hidden', 'view', 'edit'];
const EXTRA = {
  invite: 'Invite people',
  settings: 'Change section settings and lists',
  activity: 'See Activity',
  private: 'Use “Only me” (private items)',
};

// What a household starts with. Admins can rename, change, add, and delete these.
const all = (level) => Object.fromEntries(SECTIONS.map((s) => [s.key, level]));
const STARTER_ROLES = [
  { key: 'member', name: 'Member', sections: all('edit'), invite: false, settings: false, activity: true, private: true },
  { key: 'teen', name: 'Teen', sections: { ...all('edit'), bills: 'view', info: 'view' }, invite: false, settings: false, activity: true, private: true },
  { key: 'child', name: 'Child', sections: { ...all('view'), shopping: 'edit', remember: 'edit', chores: 'edit', bills: 'hidden', info: 'hidden' }, invite: false, settings: false, activity: false, private: false },
];

const rolesOf = (household) => (household && household.roles && household.roles.length ? household.roles : STARTER_ROLES);
const plain = (r) => (r && typeof r.toObject === 'function' ? r.toObject() : r);
const roleOf = (household, key) => plain(rolesOf(household).find((r) => r.key === key)) || null;
const roleName = (household, key) => (key === 'admin' ? 'Admin' : (roleOf(household, key) || { name: 'Member' }).name);

// Everything one person can do in one household.
function permsFor(household, member) {
  const off = (key) => household.features && household.features[key] === false;
  if (!member || member.role === 'admin') {
    return { admin: true, level: (key) => (off(key) ? 'hidden' : 'edit'), invite: true, settings: true, activity: true, private: true };
  }
  // A role that was deleted, or unknown, falls back to the first role.
  const role = roleOf(household, member.role) || plain(rolesOf(household)[0]);
  const sections = (role && role.sections) || {};
  return {
    admin: false,
    level: (key) => (off(key) ? 'hidden' : LEVELS.includes(sections[key]) ? sections[key] : 'edit'),
    invite: Boolean(role && role.invite),
    settings: Boolean(role && role.settings),
    activity: role ? role.activity !== false : true,
    private: role ? role.private !== false : true,
  };
}

module.exports = { LEVELS, EXTRA, STARTER_ROLES, rolesOf, roleOf, roleName, permsFor };
