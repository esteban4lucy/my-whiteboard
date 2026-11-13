// Service worker: makes the whole app available offline (app shell precache)
// and caches pictures from other websites so boards still show them offline.
// Bump VERSION whenever you change any app file, so devices pick up the update.
const VERSION = 'v1.0.6';
const SHELL = `wb-shell-${VERSION}`;
const IMG = 'wb-img-v1';
const FILES = [
  './', './index.html', './config.js', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/db.js', './js/render.js', './js/sync.js', './js/drive.js', './js/mockdrive.js',
  './js/export.js', './js/templates.js', './js/ui.js', './js/ink.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('wb-shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache Google APIs / sign-in (auth & live Drive data).
  if (/(^|\.)googleapis\.com$|accounts\.google\.com$|(^|\.)google\.com$/.test(url.hostname)) return;

  if (url.origin === self.location.origin) {
    // App shell: cache first (instant + offline), navigation falls back to index.html.
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch (err) {
        if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
        throw err;
      }
    })());
    return;
  }
  if (req.destination === 'image') {
    // External pictures: cache first, refresh in background.
    e.respondWith((async () => {
      const cache = await caches.open(IMG);
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
  }
});
