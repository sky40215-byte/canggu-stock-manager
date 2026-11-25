const CACHE_NAME = 'canggu-app-shell-v20';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css?v=20261126b',
  '/app.js?v=20261126a',
  '/holding-import-dialog.js?v=20261126a',
  '/holding-image-import.js?v=20261125f',
  '/portfolio-math.js?v=20261125d',
  '/scenario-compare.js?v=20261125d',
  '/portfolio-stress.js?v=20261125d',
  '/quick-search.js?v=20261125d',
  '/demo.html',
  '/demo.js?v=20261125e',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('canggu-app-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/vendor/ocr/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname === '/demo.html' ? '/demo.html' : '/index.html', response.clone()));
      return response;
    }).catch(async () => (await caches.match(url.pathname === '/demo.html' ? '/demo.html' : '/index.html')) || Response.error()));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => {
    const refresh = fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      return response;
    });
    if (!cached) return refresh;
    void refresh.catch(() => {});
    return cached;
  }));
});
