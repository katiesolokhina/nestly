// First-run guide for a new household, for its admin: sections, people, staples, chores.
// Every step can be skipped, and it can be finished later from Today.
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Chore = require('../models/Chore');
const { SECTIONS } = require('../lib/sections');
const { addToCatalog, setStaple, keyOf } = require('../lib/catalog');
const { logActivity } = require('../lib/activity');
const { todayIn, weekday } = require('../lib/dates');

const router = express.Router();
router.use('/setup', requireAuth, requireAdmin);

const STEPS = ['sections', 'people', 'staples', 'chores'];
const STARTER_CHORES = [
  ['Dishes', 'Kitchen', 'daily'],
  ['Take out the trash', 'Kitchen', 'weekly'],
  ['Laundry', 'Laundry', 'weekly'],
  ['Vacuum', 'Living room', 'weekly'],
  ['Clean the bathroom', 'Bathroom', 'weekly'],
  ['Change the sheets', 'Bedrooms', 'weekly'],
  ['Water the plants', 'Anywhere', 'weekly'],
  ['Mow the lawn', 'Yard', 'weekly'],
];

// Steps for sections that are off are skipped.
function stepsFor(h) {
  return STEPS.filter((s) => (s === 'staples' ? h.features.shopping !== false : s === 'chores' ? h.features.chores !== false : true));
}

async function goTo(req, res, next) {
  const h = req.household;
  const steps = stepsFor(h);
  const i = steps.indexOf(next);
  if (i < 0) {
    h.setupStep = 0;
    await h.save();
    req.session.flash = `${h.name} is ready.`;
    return res.redirect('/');
  }
  h.setupStep = STEPS.indexOf(next) + 1;
  await h.save();
  res.redirect('/setup');
}
const after = (h, step) => { const steps = stepsFor(h); return steps[steps.indexOf(step) + 1] || 'done'; };

router.get('/setup', (req, res) => {
  const h = req.household;
  const steps = stepsFor(h);
  const step = STEPS[(h.setupStep || 1) - 1] && steps.includes(STEPS[(h.setupStep || 1) - 1]) ? STEPS[h.setupStep - 1] : steps[0];
  res.render('setup', { active: 'today', step, n: steps.indexOf(step) + 1, of: steps.length, SECTIONS, STARTER_CHORES });
});

router.post('/setup/skip', async (req, res, next) => {
  try {
    req.household.setupStep = 0;
    await req.household.save();
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/setup/:step', async (req, res, next) => {
  try {
    const h = req.household;
    const b = req.body || {};
    const { step } = req.params;
    if (!STEPS.includes(step)) return res.status(404).send('Not found');
    if (b.skip !== '1') {
      if (step === 'sections') {
        const on = new Set([].concat(b.sections || []));
        SECTIONS.forEach((s) => { h.features[s.key] = on.has(s.key); });
        await h.save();
        await logActivity(req.user, { section: 'Settings', text: `${req.user.name} chose ${h.name}’s sections` });
      } else if (step === 'staples') {
        const typed = String(b.staples || '').split(/[\n,]/).map((x) => x.trim().slice(0, 80)).filter(Boolean);
        const names = typed.filter((n, i) => typed.findIndex((x) => keyOf(x) === keyOf(n)) === i).slice(0, 30); // first spelling wins
        await addToCatalog(req.user, h, names);
        for (const n of names) await setStaple(h._id, keyOf(n), true);
        if (names.length) await logActivity(req.user, { section: 'Shopping', text: `${req.user.name} added ${names.length} staples` });
      } else if (step === 'chores') {
        const picked = new Set([].concat(b.chores || []).map(String));
        const today = todayIn(req.user.timezone);
        const rows = STARTER_CHORES.filter(([t]) => picked.has(t)).map(([title, room, repeat]) => ({
          householdId: h._id, createdBy: req.user._id, byName: req.user.name, title,
          room: [...h.choreRooms, 'Anywhere'].includes(room) ? room : 'Anywhere',
          date: today, repeat, days: repeat === 'weekly' ? [weekday(today)] : [],
        }));
        if (rows.length) {
          await Chore.insertMany(rows);
          await logActivity(req.user, { section: 'Chores', text: `${req.user.name} added ${rows.length} chores` });
        }
      }
    }
    await goTo(req, res, after(h, step));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
