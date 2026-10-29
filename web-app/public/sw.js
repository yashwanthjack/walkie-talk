const CACHE_NAME = 'walkie-talkie-v1';
const PRECACHE_ASSETS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network-first for WebSocket and API calls, cache-first for static assets
  if (event.request.url.includes('/ws/')) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
