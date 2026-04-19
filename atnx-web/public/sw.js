// ATNX service worker. Minimal shell so the app is installable as a PWA.
// Strategy: network-first for navigation, pass-through for everything else.
// We intentionally do NOT cache API responses — market data must stay live.

const SHELL_CACHE = 'atnx-shell-v1';
const SHELL_URLS = ['/app', '/offline'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigation: network-first, fall back to cached shell so the app opens
  // offline after first install.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match('/app').then((res) => res || new Response('Offline', { status: 503 }))
      )
    );
    return;
  }
});
