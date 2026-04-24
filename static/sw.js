/* ChurnLence service worker — offline shell + network-first for quotes. */
const VERSION = 'churnlence-v2';
const SHELL = [
  '/',
  '/static/app.css',
  '/static/app.js',
  '/static/chart.umd.min.js',
  '/static/manifest.webmanifest',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/static/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== VERSION).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache SSE streams or live quote API — they must go to network.
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.includes('/stream')) return; // bypass SW entirely
    e.respondWith(
      fetch(req).catch(() => caches.match(req) || new Response(
        JSON.stringify({ error: 'offline' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  // App shell / static assets — cache-first with network fallback
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok && url.origin === self.location.origin) {
        const clone = res.clone();
        caches.open(VERSION).then(c => c.put(req, clone));
      }
      return res;
    }).catch(() => caches.match('/')))
  );
});
