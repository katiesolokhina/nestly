// Finer permissions for a role set to "Custom" in a section: adding, changing and deleting (only
// their own, or everyone's), and each section's own actions (check off, start shopping, mark paid…).
// Every change request in a section is sorted into one of these here, so the rule holds whatever
// page or button it came from.
const mongoose = require('mongoose');

// Each section's parts, and the choices each one has. A role either hides a section or shows it,
// and then picks one choice per part. Kinds:
//   main   – the section's things: View / Edit their own / Edit everyone's (stored as edit: none|own|all)
//   action – Hidden / Allowed (stored as true|false)
//   scope  – deleting: No / Their own / Everyone's (none|own|all)
//   see    – an extra page or detail: Hidden / View
//   area   – an extra list: Hidden / View / Edit
//   rate   – ratings: Hidden / See them / Rate
const KINDS = {
  main: [['none', 'View'], ['own', 'Edit their own'], ['all', 'Edit everyone’s']],
  action: [['no', 'Hidden'], ['yes', 'Allowed']],
  scope: [['none', 'No'], ['own', 'Their own'], ['all', 'Everyone’s']],
  see: [['hidden', 'Hidden'], ['view', 'View']],
  area: [['hidden', 'Hidden'], ['view', 'View'], ['edit', 'Edit']],
  rate: [['hidden', 'Hidden'], ['view', 'See them'], ['rate', 'Rate']],
};
const PARTS = {
  shopping: [['edit', 'Items on the list', 'main'], ['add', 'Add items', 'action'], ['check', 'Check off as bought', 'action'], ['shop', 'Start shopping', 'action'], ['delete', 'Delete items', 'scope'], ['bought', 'Bought list and receipts', 'see'], ['saved', 'Saved items and staples', 'area']],
  remember: [['edit', 'Reminders', 'main'], ['add', 'Add', 'action'], ['done', 'Check off and snooze', 'action'], ['delete', 'Delete', 'scope']],
  calendar: [['edit', 'Events', 'main'], ['add', 'Add', 'action'], ['delete', 'Delete', 'scope']],
  meals: [['edit', 'Planned meals', 'main'], ['add', 'Plan meals', 'action'], ['delete', 'Delete', 'scope']],
  recipes: [['edit', 'Recipes', 'main'], ['add', 'Add', 'action'], ['delete', 'Delete', 'scope'], ['cook', 'What can I cook', 'action']],
  pantry: [['edit', 'Items', 'main'], ['add', 'Add', 'action'], ['stock', 'Use up, restock and put away', 'action'], ['delete', 'Delete', 'scope'], ['ratings', 'Ratings', 'rate']],
  bills: [['edit', 'Bills', 'main'], ['add', 'Add', 'action'], ['pay', 'Mark paid and settle up', 'action'], ['delete', 'Delete', 'scope'], ['owes', 'Who owes whom', 'see']],
  chores: [['edit', 'Chores', 'main'], ['add', 'Add', 'action'], ['done', 'Mark done', 'action'], ['delete', 'Delete', 'scope'], ['rewards', 'Points and rewards', 'action']],
  lists: [['edit', 'Lists', 'main'], ['add', 'Make lists and add to them', 'action'], ['tick', 'Tick off', 'action'], ['claim', 'Claim wishlist gifts', 'action'], ['delete', 'Delete', 'scope']],
  info: [['edit', 'Items', 'main'], ['add', 'Add', 'action'], ['delete', 'Delete', 'scope'], ['passwords', 'See passwords', 'see']],
};
// The on/off actions, for older code that lists them.
const ACTIONS = Object.fromEntries(Object.entries(PARTS).map(([k, ps]) => [k, ps.filter((p) => p[2] === 'action').map(([a, l]) => [a, l])]));
const SCOPES = KINDS.scope;
const TOP = { main: 'all', action: true, scope: 'all', see: 'view', area: 'edit', rate: 'rate' };
const LOOK = { main: 'none', action: false, scope: 'none', see: 'view', area: 'view', rate: 'view' };

// Everything allowed: what "Edit" gives.
function fullCustom(key) { return Object.fromEntries((PARTS[key] || []).map(([a, , k]) => [a, TOP[k]])); }
// Look only: what "View" gives.
// Look-only things that still come with View: finding recipes to cook doesn't change anything.
const WITH_VIEW = { recipes: { cook: true } };
function viewCustom(key) { return { ...Object.fromEntries((PARTS[key] || []).map(([a, , k]) => [a, LOOK[k]])), ...(WITH_VIEW[key] || {}) }; }

// A role's saved choices for one section, with anything missing (older roles, new parts) filled in
// as allowed, so nothing changes until an admin changes it.
function fillCustom(key, c) {
  const out = fullCustom(key);
  const has = c || {};
  (PARTS[key] || []).forEach(([a, , k]) => {
    let v = has[a];
    if (v === undefined) return;
    if (k === 'action') v = Boolean(v);
    else if (k === 'area' && typeof v === 'boolean') v = v ? 'edit' : 'view'; // older "change saved items" box
    else if (!KINDS[k].some(([o]) => o === v)) return;
    out[a] = v;
  });
  return out;
}

// Reads a section's choices from the role form (fields c_<section>_<part>).
function readCustom(key, b) {
  const out = {};
  (PARTS[key] || []).forEach(([a, , k]) => {
    const v = b[`c_${key}_${a}`];
    if (k === 'action') out[a] = v === 'yes' || v === 'on';
    else out[a] = KINDS[k].some(([o]) => o === v) ? v : LOOK[k];
  });
  return out;
}

// The simplest way to store choices: all-allowed is "edit", look-only is "view".
function levelFor(key, c) {
  const same = (x) => (PARTS[key] || []).every(([a]) => c[a] === x[a]);
  if (same(fullCustom(key))) return 'edit';
  if (same(viewCustom(key))) return 'view';
  return 'custom';
}

// The record a request is about, for "only their own" (and which model it's in).
const MODELS = { shopping: 'ShoppingItem', remember: 'Reminder', calendar: 'Event', meals: 'Meal', recipes: 'Recipe', pantry: 'PantryItem', bills: 'Bill', chores: 'Chore', lists: 'List', info: 'InfoItem' };

// Sorts a change request: { action, id } where id is the record it changes (for own/all), or
// { action, all: true } for bulk changes, which need "Everyone's".
function classify(key, method, path, body = {}) {
  if (method !== 'POST') return null;
  const p = path.replace(/\/+$/, '');
  const id = (p.match(/^\/(?:s|api)\/[\w-]+\/([a-f0-9]{24})/) || [])[1] || null;
  const tail = id ? p.slice(p.indexOf(id) + 24) : '';
  const rules = {
    shopping: () => {
      if (/^\/s\/shopping\/saved\b/.test(p)) return { action: 'saved' };
      if (/^\/s\/shopping\/(quick|ingredients)(\/|$)/.test(p) || p === '/s/shopping') return { action: 'add' };
      if (p === '/s/shopping/scan') return { action: body.action === 'add' || !body.action ? 'add' : 'check' };
      if (p === '/s/shopping/start') return { action: 'shop' };
      if (p === '/s/shopping/delete-many' || p === '/s/shopping/clear') return { action: 'delete', all: true };
      if (tail === '/toggle') return { action: 'check' };
      if (tail === '/delete') return { action: 'delete', id };
      if (id && !tail) return { action: 'edit', id };
      return null;
    },
    remember: () => {
      if (p === '/s/remember') return { action: 'add' };
      if (/^\/(snooze|done)$/.test(tail) || p.startsWith('/api/remember/')) return { action: 'done' };
      if (tail === '/delete') return { action: 'delete', id };
      if (id && !tail) return { action: 'edit', id };
      return null;
    },
    calendar: () => (p === '/s/calendar' ? { action: 'add' } : tail === '/delete' ? { action: 'delete', id } : id && !tail ? { action: 'edit', id } : null),
    meals: () => (p === '/s/meals' || p === '/s/meals/copy-week' ? { action: 'add' } : tail === '/delete' ? { action: 'delete', id } : id && !tail ? { action: 'edit', id } : null),
    recipes: () => {
      if (['/s/recipes', '/s/recipes/import', '/s/recipes/cook/save'].includes(p) || tail === '/copy') return { action: 'add' };
      if (tail === '/delete') return { action: 'delete', id };
      if (id && !tail) return { action: 'edit', id };
      return null;
    },
    pantry: () => {
      if (p === '/s/pantry/bulk') return String(body.do || '').startsWith('delete') ? { action: 'delete', all: true } : String(body.do || '').startsWith('status') ? { action: 'stock' } : { action: 'edit', all: true };
      if (['/s/pantry', '/s/pantry/add', '/s/pantry/quick'].includes(p)) return { action: 'add' };
      if (p.startsWith('/s/pantry/putaway/') || tail === '/status' || tail === '/use') return { action: 'stock' };
      if (tail === '/delete') return { action: 'delete', id };
      if (id && !tail) return { action: 'edit', id };
      return null;
    },
    bills: () => {
      if (p === '/s/bills') return { action: 'add' };
      if (p === '/s/bills/settle' || ['/paid', '/unpaid', '/share'].includes(tail)) return { action: 'pay' };
      if (tail === '/delete') return { action: 'delete', id };
      if (id && (!tail || tail === '/stop')) return { action: 'edit', id };
      return null;
    },
    chores: () => {
      if (p === '/s/chores') return { action: 'add' };
      if (/^\/s\/chores\/rewards\/[\w-]+\/claim$/.test(p)) return { action: 'rewards' };
      if (p.startsWith('/s/chores/claims/')) return { action: 'edit', all: true }; // saying yes or no to a reward
      if (tail === '/done') return { action: 'done' };
      if (tail === '/delete') return { action: 'delete', id };
      if (id && !tail) return { action: 'edit', id };
      return null;
    },
    lists: () => {
      if (p === '/s/lists' || tail === '/copy' || tail === '/items') return { action: 'add' };
      if (/^\/items\/[a-f0-9]{24}\/(toggle|watching)$/.test(tail) || tail === '/reset') return { action: 'tick' };
      if (/^\/items\/[a-f0-9]{24}\/claim$/.test(tail)) return { action: 'claim' };
      if (tail === '/clear-done') return { action: 'delete', id };
      if (/^\/items\/[a-f0-9]{24}\/delete$/.test(tail)) return { action: 'delete', id, item: tail.split('/')[2] };
      if (/^\/items\/[a-f0-9]{24}$/.test(tail)) return { action: 'edit', id, item: tail.split('/')[2] };
      if (tail === '/delete') return { action: 'delete', id };
      if (id && (!tail || tail === '/sort')) return { action: 'edit', id };
      return null;
    },
    info: () => (p === '/s/info' ? { action: 'add' } : tail === '/delete' ? { action: 'delete', id } : id && !tail ? { action: 'edit', id } : null),
  };
  return rules[key] ? rules[key]() : null;
}

// Did this person add it? (A list item counts as theirs if they added it, or made the list.)
async function isOwn(key, user, req) {
  if (!req.id || !mongoose.isValidObjectId(req.id)) return false;
  const doc = await mongoose.model(MODELS[key]).findOne({ _id: req.id, householdId: user.householdId }, { createdBy: 1, items: 1 }).lean();
  if (!doc) return true; // not there: let the route say "not found"
  if (String(doc.createdBy) === String(user._id)) return true;
  if (req.item) { const it = (doc.items || []).find((i) => String(i._id) === req.item); return Boolean(it && it.addedBy === user.name); }
  return false;
}

// Pages that open a form or an extra page, sorted the same way, so a role never gets a form it
// can't save (or a page it can't see). Returns null for pages anyone in the section can open.
function classifyGet(key, path) {
  const p = path.replace(/\/+$/, '');
  const id = (p.match(/^\/s\/[\w-]+\/([a-f0-9]{24})/) || [])[1] || null;
  const tail = id ? p.slice(p.indexOf(id) + 24) : '';
  if (p === `/s/${key}/new` || ['/s/pantry/add', '/s/recipes/import', '/s/shopping/ingredients'].includes(p)) return { action: 'add' };
  if (key === 'shopping' && /^\/s\/shopping\/saved\/[a-f0-9]{24}$/.test(p)) return { action: 'saved' };
  if (key === 'shopping' && /^\/s\/shopping\/saved\b/.test(p)) return { part: 'saved' };
  if (key === 'recipes' && p === '/s/recipes/cook') return { action: 'cook' };
  if (key === 'chores' && p === '/s/chores/points') return { action: 'rewards' };
  if (key === 'bills' && p === '/s/bills/balances') return { part: 'owes' };
  if (key === 'pantry' && tail === '/use') return { action: 'stock' };
  if (key === 'lists' && /^\/items\/[a-f0-9]{24}$/.test(tail)) return { action: 'edit', id, item: tail.split('/')[2] };
  if (tail === '/edit') return { action: 'edit', id };
  return null;
}

// Whether a role may do this request. Returns '' when allowed, else what they can't do.
async function check(key, custom, user, req) {
  if (!req) return ''; // not a change this file knows about: allowed, like before
  const c = custom || {};
  if (req.part) return c[req.part] && c[req.part] !== 'hidden' ? '' : `see ${(((PARTS[key] || []).find(([a]) => a === req.part) || [, 'that'])[1]).toLowerCase()}`;
  const { action } = req;
  if (action === 'edit' || action === 'delete') {
    const scope = c[action] || 'none';
    if (scope === 'all') return '';
    if (scope === 'own' && !req.all && (await isOwn(key, user, req))) return '';
    return action === 'edit' ? (scope === 'own' ? 'change things others added' : 'change things here') : (scope === 'own' ? 'delete things others added' : 'delete things here');
  }
  const kind = ((PARTS[key] || []).find(([a]) => a === action) || [])[2];
  if (kind === 'area' ? c[action] === 'edit' : kind === 'rate' ? c[action] === 'rate' : c[action]) return '';
  const label = ({ saved: 'Change saved items and staples', ratings: 'rate things' })[action] || ((PARTS[key] || []).find(([a]) => a === action) || [, action])[1];
  return label.charAt(0).toLowerCase() + label.slice(1);
}

module.exports = { KINDS, PARTS, ACTIONS, SCOPES, fullCustom, viewCustom, fillCustom, readCustom, levelFor, classify, classifyGet, check, MODELS };
