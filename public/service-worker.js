// Minimal service worker — its only job is to exist so the browser
// considers this site "installable" as an app. It doesn't cache anything,
// so the site always loads fresh content (no offline mode, by design,
// since Neniou AI needs a live connection to answer anyway).

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass every request straight through to the network — no caching layer.
  event.respondWith(fetch(event.request));
});