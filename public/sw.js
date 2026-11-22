'use strict';
// Keeps the app's own files on the phone so DadBuddy opens with no connection.
// Files are served from the phone first and refreshed in the background, so a new version
// arrives the next time the app is opened at home. Entries never pass through here:
// /api/ requests always go to the network (the app keeps its data in IndexedDB).

const CACHE = 'dadbuddy-v4';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/guidance.js',
  '/rules.js',
  '/store.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html') ? '/index.html' : url.pathname;
  if (!SHELL.includes(path)) return; // /api/, /setup, the certificate: straight to the network

  ev.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(path);
      const fresh = fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok && !res.redirected) cache.put(path, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        ev.waitUntil(fresh);
        return cached;
      }
      return (await fresh) || new Response('DadBuddy is offline and not cached yet. Open it once at home first.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })
  );
});
