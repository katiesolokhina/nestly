// Nestly service worker. Nestly is online-only: pages are always fetched live, nothing is
// queued, and an offline page shows without a connection.
const CACHE = 'nestly-v20';
const PRECACHE = ['/offline.html', '/css/app.css', '/icons/icon-192.png', '/brand/nestly-mark.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }

  if (/^\/(css|js|icons|brand)\//.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});

// ---------- Notifications ----------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Nestly', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      tag: data.tag, // a newer notification about the same thing replaces the old one
      renotify: Boolean(data.tag),
      data: { url: data.url || '/', reminderId: data.reminderId || '' },
      actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : [],
    })
  );
});

function openPage(path) {
  const url = new URL(path || '/', self.location.origin);
  if (url.origin !== self.location.origin) return Promise.resolve();
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => w.url.startsWith(self.location.origin));
    if (win) return win.navigate(url.href).then((w) => (w || win).focus());
    return self.clients.openWindow(url.href);
  });
}

// Done / Snooze buttons (Android) act without opening the app. If that fails, for example
// because the person was signed out, the reminder page opens instead. A plain tap opens the page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, reminderId } = event.notification.data || {};
  if (reminderId && (event.action === 'done' || event.action === 'snooze') && /^[a-f0-9]{24}$/.test(reminderId)) {
    event.waitUntil(
      fetch(`/api/remember/${reminderId}/${event.action}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then((res) => { if (!res.ok || res.redirected) throw new Error(String(res.status)); })
        .catch(() => openPage(url))
    );
    return;
  }
  event.waitUntil(openPage(url));
});
