'use strict';
// Keeps the app's own files on the phone so DadBuddy opens with no connection.
// Files are served from the phone first and refreshed in the background, so a new version
// arrives the next time the app is opened at home. Entries never pass through here:
// /api/ requests always go to the network (the app keeps its data in IndexedDB).

const CACHE = 'dadbuddy-v6';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/guidance.js',
  '/rules.js',
  '/meds.js',
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

// Reminders sent by the home computer (see reminders.js). Tapping one opens DadBuddy.
self.addEventListener('push', (ev) => {
  let d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch {}
  ev.waitUntil(self.registration.showNotification(d.title || 'DadBuddy', {
    body: d.body || '',
    tag: d.tag || 'dadbuddy',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  ev.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) return open.focus();
    return self.clients.openWindow(ev.notification.data?.url || '/');
  })());
});
