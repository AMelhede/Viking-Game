// Valhalla service worker — minimal "app shell" caching so the game
// loads instantly on repeat visits and works offline-ish (game files
// cached; external CDN models still need network).
//
// Cache strategy:
//   * App shell (HTML/CSS/JS modules in this origin): cache-first
//   * Three.js CDN modules: stale-while-revalidate (works offline
//     after first load)
//   * Models / textures: network-first with cache fallback
//
// On every release, bump CACHE_VERSION so old caches get purged.

const CACHE_VERSION = "valhalla-v3";
const APP_SHELL = [
  "/",
  "/index.html",
  "/js/valhalla/main.js",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL.map(u => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
      .catch((e) => console.warn("[SW] install cache failed", e))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Same-origin: cache-first
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE_VERSION).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match("/index.html")))
    );
    return;
  }

  // Cross-origin (threejs CDN, models): stale-while-revalidate
  if (/threejs\.org|jsdelivr\.net|unpkg\.com/.test(url.host)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchP = fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE_VERSION).then(c => c.put(req, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || fetchP;
      })
    );
  }
});
