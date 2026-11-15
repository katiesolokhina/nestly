const User = require('../models/User');
const Household = require('../models/Household');
const Activity = require('../models/Activity');
const Membership = require('../models/Membership');
const { homesOf } = require('../lib/members');
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
    const user = await User.findById(req.session.userId);
    const homes = user ? await homesOf(user._id) : [];
    // Deleted, or turned off in every household, while signed in: end the session.
    if (!user || !homes.length) return req.session.destroy(() => res.redirect('/login'));
    // The household this device is using: the one picked here, else the last one used, else the first.
    const pick = (id) => id && homes.find((h) => String(h.householdId) === String(id));
    const home = pick(req.session.householdId) || pick(user.householdId) || homes[0];
    const [household, member] = await Promise.all([Household.findById(home.householdId), Membership.findById(home._id)]);
    if (!household || !member) return req.session.destroy(() => res.redirect('/login'));
    req.session.householdId = String(household._id);
    // Everything else scopes by req.user.householdId, so it's set to this one for the request.
    if (String(user.householdId) !== String(household._id)) {
      user.householdId = household._id;
      await User.updateOne({ _id: user._id }, { $set: { householdId: household._id } });
    }
    req.user = user;
    req.household = household;
    req.member = member;
    res.locals.user = user;
    res.locals.member = member;
    res.locals.household = household;
    res.locals.homes = homes;
    res.locals.theme = user.theme && user.theme !== 'system' ? user.theme : '';
    res.locals.nav = (active) => bottomBar(member, household, active);
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

// Turned-off sections don't exist as far as anyone's concerned.
const requireSection = (key) => (req, res, next) => {
  if (req.household.features[key] === false) return res.status(404).send('Not found');
  next();
};

// CSRF guard: reject state-changing requests sent from another site.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin || origin === process.env.APP_ORIGIN) return next();
  console.warn(`Blocked origin: "${origin}" (expected "${process.env.APP_ORIGIN}")`);
  return res.status(403).send('Forbidden');
}

module.exports = { requireAuth, requireAdmin, requireSection, sameOrigin };
