// Rating things (Buy again / Never again…), the "Buy again?" prompt, and the choices in Settings.
const express = require('express');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { keyOf } = require('../lib/catalog');
const { COLORS, choicesOf, newId, rate, canRate } = require('../lib/ratings');
const { logActivity } = require('../lib/activity');

const router = express.Router();
// Only ever back to a page in Nestly.
const backTo = (v) => (typeof v === 'string' && /^\/(?!\/)[^\s\\]*$/.test(v) ? v : '/s/pantry');

router.post('/ratings', requireAuth, async (req, res, next) => {
  try {
    if (!canRate(req)) return res.status(404).send('Not found');
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    const key = name ? keyOf(name) : '';
    const value = String(b.value || '');
    const q = req.session.rateQueue || [];
    if (b.from === 'prompt') {
      if (value === 'stop') req.session.rateQueue = [];
      else req.session.rateQueue = q.filter((x) => x.key !== key);
    }
    if (key && !['skip', 'stop'].includes(value)) await rate(req.user, req.household, { key, name, value: value === 'clear' ? '' : value });
    if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true });
    res.redirect(303, backTo(b.back));
  } catch (err) {
    next(err);
  }
});

// Settings → Pantry → Ratings: names, colors, order, which ones warn; and the prompt on or off.
router.get('/settings/ratings', requireAuth, requirePerm('settings'), (req, res) => {
  res.render('settings/ratings', { active: 'settings', choices: choicesOf(req.household), COLORS, prompt: req.household.ratingPrompt !== false });
});

router.post('/settings/ratings', requireAuth, requirePerm('settings'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const list = (k) => [].concat(b[k] == null ? [] : b[k]).map(String);
    const ids = list('id');
    const names = list('name');
    const colors = list('color');
    const warn = new Set(list('warn'));
    const gone = new Set(list('remove'));
    const choices = [];
    ids.forEach((id, i) => {
      const name = (names[i] || '').trim().slice(0, 24);
      if (!name || gone.has(id || `new${i}`)) return;
      if (choices.some((c) => c.name.toLowerCase() === name.toLowerCase())) return;
      choices.push({ id: /^[\w-]{1,24}$/.test(id) && !id.startsWith('new') ? id : newId(), name, color: COLORS[colors[i]] ? colors[i] : 'gray', warn: warn.has(id) });
    });
    // Moving one up or down.
    const move = String(b.move || '').match(/^(up|down):(\d+)$/);
    if (move) {
      const i = +move[2];
      const j = move[1] === 'up' ? i - 1 : i + 1;
      if (choices[i] && choices[j]) [choices[i], choices[j]] = [choices[j], choices[i]];
    }
    if (!choices.length) {
      req.session.flash = 'Keep at least one rating.';
      return res.redirect('/settings/ratings');
    }
    req.household.ratingChoices = choices.slice(0, 8);
    req.household.ratingPrompt = b.prompt === 'on';
    await req.household.save();
    if (!move) await logActivity(req.user, { section: 'Settings', text: `${req.user.name} changed the rating choices` });
    req.session.flash = move ? null : 'Ratings saved.';
    res.redirect(move ? '/settings/ratings#choices' : '/settings/s/pantry');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
