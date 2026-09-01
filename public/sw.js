// Minimal service worker — exists only so browsers consider this app installable (Chrome/Edge
// require an active service worker with a fetch handler before showing the install prompt).
// It deliberately does NO caching: this app's data changes constantly, and a caching service
// worker risks serving stale screens or stale login state. Every request passes straight
// through to the network, unchanged.
self.addEventListener('install', ()=>self.skipWaiting());
self.addEventListener('activate', (e)=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e)=>{ e.respondWith(fetch(e.request)); });
