// Ignores a form sent twice (a double tap that got past the locked button, a flaky connection
// retrying): each form carries a one-time _once token. The first request runs; a repeat with the
// same token is sent where the first one went, without doing anything again.
const SEEN = new Map(); // `${userId}:${token}` -> { at, location }
const TTL = 10 * 60 * 1000;

function sweep(now) {
  if (SEEN.size < 2000) return;
  for (const [k, v] of SEEN) if (now - v.at > TTL) SEEN.delete(k);
}

function once(req, res, next) {
  const token = req.method === 'POST' && req.body && typeof req.body._once === 'string' ? req.body._once.slice(0, 80) : '';
  const who = req.session && req.session.userId;
  if (req.body) delete req.body._once;
  if (!token || !who) return next();
  const key = `${who}:${token}`;
  const started = Date.now();
  sweep(started);

  const run = () => {
    SEEN.set(key, { at: Date.now(), location: '' });
    const redirect = res.redirect.bind(res);
    res.redirect = (...args) => {
      const entry = SEEN.get(key);
      if (entry) entry.location = typeof args[0] === 'number' ? args[1] : args[0];
      return redirect(...args);
    };
    // A page shown instead of a redirect (a form with an error) lets the same token try again.
    res.on('finish', () => { const entry = SEEN.get(key); if (entry && !entry.location) SEEN.delete(key); });
    return next();
  };
  const check = () => {
    const hit = SEEN.get(key);
    if (!hit || Date.now() - hit.at > TTL) return run(); // first time, or the first one didn't save
    if (hit.location) return res.redirect(303, hit.location); // done: go where it went
    if (Date.now() - started > 8000) return res.redirect(303, req.get('Referer') || '/');
    return setTimeout(check, 100); // still saving
  };
  return check();
}

module.exports = { once };
