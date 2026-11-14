const User = require('../models/User');
const Household = require('../models/Household');
const Activity = require('../models/Activity');
const { bottomBar } = require('../lib/sections');

// Loads the signed-in user and their household, or sends them to /login.
async function requireAuth(req, res, next) {
  if (!req.session.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
    // Something shared to Nestly while signed out picks up where it left off after sign-in.
    if (req.method === 'GET' && req.path === '/share') req.session.returnTo = req.originalUrl.slice(0, 3000);
    return res.redirect('/login');
  }
  try {
    const user = await User.findById(req.session.userId);
    const household = user && (await Household.findById(user.householdId));
    // Deleted or disabled while signed in: end the session.
    if (!user || user.disabled || !household) return req.session.destroy(() => res.redirect('/login'));
    req.user = user;
    req.household = household;
    res.locals.user = user;
    res.locals.household = household;
    res.locals.theme = user.theme && user.theme !== 'system' ? user.theme : '';
    res.locals.nav = (active) => bottomBar(user, household, active);
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
  if (req.user && req.user.role === 'admin') return next();
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
