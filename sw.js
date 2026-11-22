/* ══════════════════════════════════════════════════════════
   Welds Wine Wisdoms — Service Worker
   Strategy:
   - API/auth calls: never touched, always straight to the network
   - Pages (HTML): network-first, saved copy only when offline
   - This site's own files (images, icons, manifest): show the saved copy
     straight away for speed, but fetch a fresh copy in the background,
     so an updated image appears on the next visit
   - Fonts and libraries from other sites: cache-first (they never change)
══════════════════════════════════════════════════════════ */
// Bump this number whenever you want every visitor's saved copies cleared
const CACHE_NAME = 'www-v3';
// Static assets to cache on install
const PRECACHE = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,500;0,600;1,500&family=Inter:wght@400;500;600&display=swap',
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
  // Auth/API calls: don't touch them at all, let the browser send them directly.
  // (Passing them through the service worker added nothing, and if the browser
  // stopped the service worker mid-request, every request in progress failed at once.)
  if (NETWORK_ONLY.some(d => url.includes(d))) return;
  // Only GET requests can be cached; anything else goes straight to the network
  if (event.request.method !== 'GET') return;
  // Network-first for navigation (always get fresh HTML)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
        // Offline: show the saved copy of this page if there is one, otherwise the cellar
        .catch(() => caches.match(event.request).then(saved => saved || caches.match('/index.html')))
    );
    return;
  }
  // This site's own files: answer from the saved copy if there is one (fast),
  // and always fetch a fresh copy in the background to replace it.
  if (new URL(url).origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(event.request).then(cached => {
          const fresh = fetch(event.request).then(res => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          }).catch(() => cached);
          // Keep the service worker awake until the background refresh has finished
          event.waitUntil(fresh.then(() => {}, () => {}));
          return cached || fresh;
        })
      )
    );
    return;
  }
  // Fonts and libraries from other sites: cache-first
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
      // Rich parts (all optional — anything missing is simply left out):
      //   icon  = the wine's label photo, shown as a thumbnail (falls back to the app icon)
      //   image = the estate/region photo, shown large when expanded (Android)
      //   actions = up to two buttons under the notification
      icon:      data.icon  || '/icon-192.png',
      image:     data.image || undefined,
      actions:   Array.isArray(data.actions) ? data.actions.slice(0, 2) : [],
      timestamp: data.timestamp || Date.now(),
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
  // "Later" button: just dismiss, don't open the app
  if (event.action === 'later') return;
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