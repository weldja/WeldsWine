/* ══════════════════════════════════════════════════════════
   Welds Wine Wisdoms — Service Worker
   Strategy: network-first for API/auth, cache-first for assets
══════════════════════════════════════════════════════════ */
const CACHE_NAME = 'www-v1';
// Static assets to cache on install
const PRECACHE = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,500;0,600;1,500&family=Inter:wght@400;500&600&display=swap',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];
// Never cache these — always go to network
const NETWORK_ONLY = [
  'supabase.co',
  'bigdatacloud.net',
  'anthropic.com',
  'workers.dev'
];
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        PRECACHE.map(url => cache.add(url).catch(() => {}))
      );
    })
  );
});
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', event => {
  const url = event.request.url;
  // Always network for auth/API calls
  if (NETWORK_ONLY.some(d => url.includes(d))) {
    event.respondWith(fetch(event.request));
    return;
  }
  // Network-first for navigation (always get fresh HTML)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }
  // Cache-first for everything else (fonts, CSS, JS)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res.ok && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
/* ══════════════════════════════════════════════════════════
   Push notifications
══════════════════════════════════════════════════════════ */
self.addEventListener('push', event => {
  let data = { title: '🍷 Welds Wine Wisdoms', body: 'A new wine was added to the cellar', url: '/' };
  try {
    if (event.data) data = { ...data, ...JSON.parse(event.data.text()) };
  } catch(e) {
    // malformed payload — use defaults
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:  data.body,
      icon:  '/icon-192.png',
      badge: '/badge-96.png',
      // Grouping: repeat comments on one wine collapse into a single
      // notification that re-alerts, instead of stacking up.
      tag:      data.tag || undefined,
      renotify: !!data.renotify,
      vibrate:  [80, 40, 80],
      data:     { url: data.url || '/', wineId: data.wineId || null }
    })
  );
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const d      = event.notification.data || {};
  const target = d.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          // App already open: focus it and tell the page which wine to show
          // (postMessage avoids a full reload, unlike client.navigate).
          if (d.wineId) {
            client.postMessage({ type: 'open-wine', wineId: d.wineId });
            return client.focus();
          }
          client.navigate(target);
          return client.focus();
        }
      }
      // App closed: open at /?open=<wineId> — the page handles the rest.
      return clients.openWindow(target);
    })
  );
});