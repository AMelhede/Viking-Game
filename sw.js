// SELF-DESTRUCT service worker.
//
// The previous version cached index.html + main.js with a cache-first
// strategy, which meant every user who installed it kept seeing the
// stale build forever even after we pushed fixes. This version
// immediately unregisters itself, deletes every cache, and forces
// every open page to reload from network.
//
// Once every active user has run this once, sw.js itself can be
// deleted from the repo. Until then it's the deactivation routine.

self.addEventListener("install", (event) => {
  // Skip waiting so this SW activates immediately.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Delete every cache, including the old valhalla-v1/v2/v3 ones.
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    // Take control of every open tab so the next fetch is network.
    await self.clients.claim();
    // Tell every controlled client to hard-reload itself.
    const clients = await self.clients.matchAll({ type: "window" });
    for (const c of clients) {
      try { c.navigate(c.url); } catch {}
    }
    // Unregister this SW so future loads bypass it entirely.
    await self.registration.unregister();
  })());
});

// Pass every fetch straight through to the network. No caching at all.
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request).catch(() => Response.error()));
});
