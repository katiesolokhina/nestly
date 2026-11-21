// Finer permissions for a role set to "Custom" in a section: adding, changing and deleting (only
// their own, or everyone's), and each section's own actions (check off, start shopping, mark paid…).
// Every change request in a section is sorted into one of these here, so the rule holds whatever
// page or button it came from.
const mongoose = require('mongoose');

// What each section offers. "edit" and "delete" are 'none' | 'own' | 'all'; the rest are on or off.
const BASE = [['add', 'Add new']];
const ACTIONS = {
  shopping: [...BASE, ['check', 'Check things off as bought'], ['shop', 'Start shopping'], ['saved', 'Change saved items and staples']],
  remember: [...BASE, ['done', 'Check off and snooze']],
  calendar: [...BASE],
  meals: [['add', 'Plan meals']],
  recipes: [...BASE],
  pantry: [...BASE, ['stock', 'Use up, restock, and put away']],
  bills: [...BASE, ['pay', 'Mark paid and settle up']],
  chores: [...BASE, ['done', 'Mark chores done'], ['rewards', 'Ask for rewards']],
  lists: [['add', 'Make lists and add to them'], ['tick', 'Tick things off'], ['claim', 'Claim wishlist gifts']],
  info: [...BASE],
};
const SCOPES = [['none', 'No'], ['own', 'Only their own'], ['all', 'Everyone’s']];

// "Custom" starts from what Edit allows, so switching to it changes nothing until boxes are unticked.
function fullCustom(key) {
  return { ...Object.fromEntries((ACTIONS[key] || []).map(([a]) => [a, true])), edit: 'all', delete: 'all' };
}

// Reads a role's custom settings for one section from a form (fields c_<section>_<action>).
function readCustom(key, b) {
  const out = {};
  (ACTIONS[key] || []).forEach(([a]) => { out[a] = b[`c_${key}_${a}`] === 'on'; });
  ['edit', 'delete'].forEach((a) => { const v = b[`c_${key}_${a}`]; out[a] = SCOPES.some(([s]) => s === v) ? v : 'none'; });
  return out;
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

// Whether a custom role may do this request. Returns '' when allowed, else what they can't do.
async function check(key, custom, user, req) {
  if (!req) return ''; // not a change this file knows about: allowed, like before
  const c = custom || {};
  const { action } = req;
  if (action === 'edit' || action === 'delete') {
    const scope = c[action] || 'none';
    if (scope === 'all') return '';
    if (scope === 'own' && !req.all && (await isOwn(key, user, req))) return '';
    return action === 'edit' ? (scope === 'own' ? 'change things others added' : 'change things here') : (scope === 'own' ? 'delete things others added' : 'delete things here');
  }
  if (c[action]) return '';
  const label = ((ACTIONS[key] || []).find(([a]) => a === action) || [, action])[1];
  return label.charAt(0).toLowerCase() + label.slice(1);
}

module.exports = { ACTIONS, SCOPES, fullCustom, readCustom, classify, check, MODELS };
