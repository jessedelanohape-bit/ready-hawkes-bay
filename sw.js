// Keeps the app and the last-loaded tsunami zone available offline.
const CACHE = 'ready-hb-v9';
const SHELL = ['./', 'index.html', 'route.js?v=9', 'icon.svg', 'manifest.webmanifest',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isZone = url.host === 'services1.arcgis.com';
  const isShell = url.origin === location.origin || url.host === 'cdnjs.cloudflare.com' || url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com';
  if (!isZone && !isShell) return; // search, routing and map tiles always go to the network
  // network first, fall back to the cached copy when offline
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
