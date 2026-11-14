// Settings → Notifications: turn this device on or off, and send a test.
// If the browser can't do push at all, the card stays hidden and a short note says why.
(function () {
  const card = document.getElementById('push-card');
  if (!card) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  const note = document.querySelector('[data-push-unsupported]');

  function show(next) {
    if (note) note.hidden = true;
    card.hidden = false;
    card.querySelectorAll('[data-state]').forEach((el) => { el.hidden = el.dataset.state !== next; });
  }
  function say(text) {
    const status = card.querySelector('[data-status]');
    if (status) status.textContent = text;
  }
  function keyToBytes(base64) {
    const pad = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
  }

  async function refresh() {
    if (Notification.permission === 'denied') return show('blocked');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post('/api/push/subscribe', sub.toJSON()); // re-sync in case the server lost it, or someone else signed in
      return show('on');
    }
    show('off');
  }

  async function enable() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { await refresh(); return false; }
    const keyRes = await fetch('/api/push/key', { credentials: 'same-origin' });
    if (!keyRes.ok) throw new Error('no key');
    const { publicKey } = await keyRes.json();
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
    await post('/api/push/subscribe', sub.toJSON());
    show('on');
    return true;
  }

  async function disable() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    show('off');
  }

  const on = (action, fn) => {
    const btn = card.querySelector(`[data-action="${action}"]`);
    if (btn) btn.addEventListener('click', fn);
  };
  on('enable', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (await enable()) say('Notifications are on for this device.');
    } catch (err) {
      console.warn(err);
      say('Couldn’t turn on notifications. Try again.');
    } finally {
      btn.disabled = false;
    }
  });
  on('test', async () => {
    try {
      const { sent } = await post('/api/push/test');
      say(sent ? 'Test sent. It should arrive in a few seconds.' : 'No devices found. Turn notifications on again.');
    } catch {
      say('The test didn’t send. Check the server log.');
    }
  });
  on('disable', async () => {
    await disable();
    say('Notifications are off on this device.');
  });

  (async () => {
    const probe = await fetch('/api/push/key', { credentials: 'same-origin' });
    if (probe.status === 503) {
      card.hidden = false;
      if (note) note.hidden = true;
      say('Notifications aren’t set up on the server yet.');
      return;
    }
    await refresh();
  })().catch((err) => console.warn('Notification setup failed:', err));
})();
