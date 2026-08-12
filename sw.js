/* Service worker — Les Géants 300.
 *
 * Trois caches :
 *  - SHELL : les fichiers de l'app (précachés à l'installation, servis en
 *    cache-first avec rafraîchissement en arrière-plan).
 *  - VENDOR : Leaflet depuis unpkg (précaché aussi, mais sans faire échouer
 *    l'installation si le CDN est injoignable).
 *  - TILES  : les tuiles OSM rencontrées pendant la navigation, en cache-first
 *    et plafonné, pour que la carte reste lisible hors réseau en montagne.
 *
 * Bumper VERSION invalide les anciens caches à l'activation.
 */
const VERSION = "v4";
const SHELL = `geants300-shell-${VERSION}`;
const VENDOR = `geants300-vendor-${VERSION}`;
const TILES = "geants300-tiles";
const TILE_LIMIT = 1200;

const SHELL_ASSETS = [
  "./",
  "index.html",
  "style.css",
  "route.js",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png"
];

const VENDOR_ASSETS = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_ASSETS);
    const vendor = await caches.open(VENDOR);
    // Le CDN peut être injoignable : on n'empêche pas l'installation.
    await Promise.all(VENDOR_ASSETS.map((u) => vendor.add(u).catch(() => {})));
    // Les images Leaflet (marker, ombre) ne sont demandées qu'au runtime.
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, VENDOR, TILES]);
    const names = await caches.keys();
    await Promise.all(names.map((n) => (keep.has(n) ? null : caches.delete(n))));
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.disable();
    }
    await self.clients.claim();
  })());
});

/** Cache-first, avec revalidation silencieuse en arrière-plan. */
async function staleWhileRevalidate(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, {ignoreSearch: false});
  const net = fetch(req).then((res) => {
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (hit) return hit;
  const res = await net;
  if (res) return res;
  throw new Error("offline");
}

/** Tuiles : cache-first, sans revalidation (elles ne changent pas), plafonné. */
async function tileFirst(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) {
      await cache.put(req, res.clone());
      trimTiles(cache);
    }
    return res;
  } catch (err) {
    // Pas de réseau et tuile inconnue : réponse vide, Leaflet affiche du vide.
    return new Response("", {status: 504, statusText: "offline"});
  }
}

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    // Les clés sont dans l'ordre d'insertion : on retire les plus anciennes.
    const excess = keys.length - TILE_LIMIT;
    for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
  } finally {
    trimming = false;
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Navigation : on sert l'index du cache, comme les autres fichiers du shell.
  // Servir un index.html frais par-dessus un app.js/style.css encore en cache
  // mélangeait deux versions de l'app et la cassait ; le shell doit basculer
  // d'un bloc, ce que fait le précache d'une nouvelle VERSION.
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = (await cache.match("index.html")) || (await cache.match("./"));
      const net = fetch(req).then((res) => {
        if (res && res.ok) cache.put("index.html", res.clone());
        return res;
      }).catch(() => null);
      if (hit) return hit;
      const res = await net;
      if (res) return res;
      return new Response("Hors ligne", {status: 503, headers: {"Content-Type": "text/plain; charset=utf-8"}});
    })());
    return;
  }

  if (/\.tile\.openstreetmap\.org$|^tile\.openstreetmap\.org$/.test(url.hostname)) {
    e.respondWith(tileFirst(req));
    return;
  }

  if (url.hostname === "unpkg.com") {
    e.respondWith(staleWhileRevalidate(VENDOR, req));
    return;
  }

  if (url.origin === self.location.origin) {
    e.respondWith(staleWhileRevalidate(SHELL, req));
  }
});
