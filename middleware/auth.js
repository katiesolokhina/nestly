const User = require('../models/User');
const Household = require('../models/Household');
const Activity = require('../models/Activity');
const Membership = require('../models/Membership');
const { homesOf } = require('../lib/members');
const { sectionName } = require('../lib/prefs');
const { permsFor, roleName, roleOf } = require('../lib/perms');
const { SECTIONS } = require('../lib/sections');
const { classify, classifyGet, check } = require('../lib/actions');
const { choicesOf } = require('../lib/ratings');
const { bottomBar } = require('../lib/sections');

// Loads the signed-in user and their household, or sends them to /login.
async function requireAuth(req, res, next) {
  if (!req.session.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
    // Something shared to Nestly while signed out picks up where it left off after sign-in.
    if (req.method === 'GET' && (req.path === '/share' || req.path.startsWith('/h/'))) req.session.returnTo = req.originalUrl.slice(0, 3000);
    return res.redirect('/login');
  }
  try {
    // Three trips to the database at most: the person and their memberships together, then their households.
    const [user, memberships] = await Promise.all([
      User.findById(req.session.userId),
      Membership.find({ userId: req.session.userId, disabled: false }).sort({ createdAt: 1 }).lean(),
    ]);
    const full = user ? await homesOf(user._id, { full: true, memberships: memberships.length ? memberships : null }) : [];
    const homes = full.map(({ doc, ...h }) => h);
    // Deleted, or turned off in every household, while signed in: end the session.
    if (!user || !homes.length) return req.session.destroy(() => res.redirect('/login'));
    // The household this device is using: the one picked here, else the last one used, else the first.
    const pick = (id) => id && homes.find((h) => String(h.householdId) === String(id));
    const home = pick(req.session.householdId) || pick(user.householdId) || homes[0];
    const chosen = full.find((h) => String(h._id) === String(home._id));
    // Real documents (not plain objects), so settings pages can change and save them.
    const household = Household.hydrate(chosen.doc);
    const member = Membership.hydrate(Object.fromEntries(Object.entries(chosen).filter(([k]) => !['doc', 'name'].includes(k))));
    req.session.householdId = String(household._id);
    // Everything else scopes by req.user.householdId, so it's set to this one for the request.
    if (String(user.householdId) !== String(household._id)) {
      user.householdId = household._id;
      await User.updateOne({ _id: user._id }, { $set: { householdId: household._id } });
    }
    // "View as role": an admin acting as another role in this household, to see (and do) exactly
    // what that role can. Only for admins; the real role comes back with Exit.
    const viewAs = req.session.viewAs;
    let viewing = null;
    if (viewAs && member.role === 'admin' && String(viewAs.householdId) === String(household._id) && viewAs.role !== 'admin' && roleOf(household, viewAs.role)) {
      viewing = { role: viewAs.role, name: roleName(household, viewAs.role) };
      member.role = viewAs.role;
      member.unmarkModified('role'); // saving pins or the Today layout must never save this role
      // The Households page sees EVERY household with the viewed role, so nothing there shows
      // admin options (deleting or copying another household) while looking through it.
      homes.forEach((h) => { h.role = viewAs.role; h.roleLabel = viewing.name; });
    }
    req.user = user;
    req.household = household;
    req.member = member;
    req.viewing = viewing;
    res.locals.viewing = viewing;
    // What this person's role lets them do here. Pages see the household with sections
    // they can't see turned off, so menus, Today, and links leave them out.
    const perms = permsFor(household, member);
    req.perms = perms;
    req.sees = (key) => perms.level(key) !== 'hidden';
    const view = household.toObject();
    view.features = Object.fromEntries(SECTIONS.map((s) => [s.key, req.sees(s.key)]));
    req.view = view;
    res.locals.user = user;
    res.locals.member = member;
    res.locals.household = view;
    res.locals.perms = perms;
    res.locals.sees = req.sees;
    res.locals.canEdit = (key) => perms.level(key) === 'edit';
    res.locals.can = (key, action, doc) => perms.can(key, action, doc);
    res.locals.canPage = (key) => perms.page(key);
    // Ratings: the choices, and whether this person sees and can give them.
    res.locals.rateChoices = choicesOf(household);
    res.locals.seesRatings = perms.sees('pantry', 'ratings');
    res.locals.canRate = perms.can('pantry', 'ratings');
    res.locals.roleLabel = roleName(household, member.role);
    res.locals.homes = homes;
    res.locals.secName = (key) => sectionName(household, key);
    res.locals.isAdmin = member.role === 'admin';
    res.locals.canSettings = perms.settings;
    res.locals.theme = user.theme && user.theme !== 'system' ? user.theme : '';
    res.locals.nav = (active) => bottomBar(member, view, active);
    res.locals.path = req.originalUrl;
    // One-time messages left by the previous request.
    res.locals.flash = req.session.flash || null;
    res.locals.undoEntry = null;
    delete req.session.flash;
    if (req.session.undoId) {
      res.locals.undoEntry = await Activity.findOne({ _id: req.session.undoId, actorId: user._id, undoneAt: null }, { text: 1 }).lean();
      delete req.session.undoId;
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Use after requireAuth.
function requireAdmin(req, res, next) {
  if (req.member && req.member.role === 'admin') return next();
  return res.status(404).send('Not found'); // don't reveal admin pages exist
}

// Turned-off sections, and sections someone's role hides, don't exist for them.
// View-only roles can look but not change anything.
const requireSection = (key) => (req, res, next) => {
  const level = req.perms ? req.perms.level(key) : req.household.features[key] === false ? 'hidden' : 'edit';
  if (level === 'hidden') return res.status(404).send('Not found');
  if (level === 'view' && !['GET', 'HEAD'].includes(req.method)) {
    if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) return res.status(403).json({ error: 'View only' });
    req.session.flash = `Your role can look at ${sectionName(req.household, key)} but not change it.`;
    return res.redirect(`/s/${key}`);
  }
  // What this request is (open an edit form, add, check off, delete someone else's…) and whether
  // the role's choices allow it. Forms they can't save, and parts they can't see, don't open.
  const isGet = ['GET', 'HEAD'].includes(req.method);
  if (req.perms && !req.perms.admin && (isGet || req.perms.mode(key) === 'custom')) {
    const what = isGet ? classifyGet(key, req.baseUrl + req.path) : classify(key, req.method, req.baseUrl + req.path, req.body || {});
    if (!what) return next();
    return check(key, req.perms.parts(key), req.user, what).then((cant) => {
      if (!cant) return next();
      const msg = `Your role can’t ${cant} in ${sectionName(req.household, key)}.`;
      if (req.get('X-Requested-With') === 'fetch' || req.originalUrl.startsWith('/api/')) return res.status(403).json({ error: msg });
      req.session.flash = msg;
      return res.redirect(303, `/s/${key}`);
    }, next);
  }
  next();
};

// An app page a role can be kept off (Spending, Search...). Use after requireAuth.
const requirePage = (key) => (req, res, next) => (req.perms && req.perms.page(key) ? next() : res.status(404).send('Not found'));

// A permission from someone's role (Admin has them all): invite, settings, activity, private.
const requirePerm = (name) => (req, res, next) => (req.perms && req.perms[name] ? next() : res.status(404).send('Not found'));

// CSRF guard: reject state-changing requests sent from another site.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin || origin === process.env.APP_ORIGIN) return next();
  console.warn(`Blocked origin: "${origin}" (expected "${process.env.APP_ORIGIN}")`);
  return res.status(403).send('Forbidden');
}

module.exports = { requireAuth, requireAdmin, requireSection, requirePerm, requirePage, sameOrigin };
