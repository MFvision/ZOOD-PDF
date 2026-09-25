/* global __ZOOD_SHELL__ */
/* ZOOD PDF service worker: caches the APPLICATION SHELL only (html, js, css, wasm, fonts, icons).
 * Documents never pass through here: they are opened from local files as bytes, and any request that
 * is not part of the shell list goes straight to the network without being stored. */
const VERSION = '__ZOOD_VERSION__';
const SHELL = __ZOOD_SHELL__;
const CACHE = `zood-shell-${VERSION}`;
const SHELL_URLS = new Set(SHELL.map((p) => new URL(p, self.registration.scope).href));
const INDEX = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([...SHELL_URLS]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('zood-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(INDEX)));
    return;
  }
  const clean = url.origin + url.pathname;
  if (!SHELL_URLS.has(clean)) return; // not shell: network only, never cached
  event.respondWith(caches.match(clean).then((hit) => hit || fetch(req)));
});
