// INERT service worker. Does nothing. Exists only so any stale browser
// SW that fetches /sw.js gets a harmless replacement instead of the
// old cache-first router that froze users on stale builds.
//
// Does NOT navigate clients (last version did that, causing an infinite
// reload loop with the page-side register() call). Does NOT cache
// anything. Does NOT intercept fetches.
//
// Future: when we add a properly-versioned offline cache, rewrite this
// file. For now it's the safe no-op.

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Wipe any caches left behind by older SW versions.
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch {}
    await self.clients.claim();
    // Quietly unregister this SW too. After this, the browser will not
    // run a service worker for this origin until a new register() call
    // happens (which the page no longer does).
    try { await self.registration.unregister(); } catch {}
  })());
});
// Pass-through fetch handler. Required for the SW to count as "active"
// but always returns the network response with no caching.
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request).catch(() => Response.error()));
});
