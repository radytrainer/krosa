/*
 * Service worker of the Student Score Record System (docs/runbook.md "Service worker").
 *
 * It exists to make the app installable and to show an offline page. It never stores any page,
 * API response or user data:
 *   - cached: only the build's static files (/_next/static/*), the icons (/icons/*) and
 *     /offline.html (the one HTML file: the offline fallback, no scripts, no data);
 *   - never cached: HTML pages, /api/*, /login, /change-password, and any response marked
 *     Cache-Control no-store/private. The path allow-list (STATIC) is what guarantees this:
 *     browsers hide Set-Cookie from service workers, so a header check alone could not;
 *   - page loads always go to the network; offline, /offline.html is shown instead.
 * The cache name carries the build id (registered as /sw.js?v=<build id>, src/lib/pwa.ts). A new
 * build installs a new worker, which takes over at once and deletes every other cache. Signing
 * out (or being signed out) clears the caches from the page (clearAppCaches in src/lib/pwa.ts).
 *
 * Kill switch: replace this file with the one in docs/runbook.md "Service worker".
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE_PREFIX = 'krosa-static-';
const CACHE = CACHE_PREFIX + VERSION.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png'];

/** Paths whose responses are never stored, whatever their headers say. */
const NEVER_CACHE = [/^\/api(\/|$)/, /^\/login(\/|$)/, /^\/change-password(\/|$)/];
/** The only paths that may be stored: build output (content-hashed) and the app icons. */
const STATIC = [/^\/_next\/static\//, /^\/icons\//];

/**
 * True when a response may be stored: a plain 200 that its server allows to be kept. The path
 * allow-list above is the real guard; these header checks are defence in depth (browsers hide
 * Set-Cookie from service workers, so that check can only ever pass).
 */
function storable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  if (response.headers.has('set-cookie')) return false;
  const cacheControl = (response.headers.get('cache-control') || '').toLowerCase();
  return !/no-store|private/.test(cacheControl);
}

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(
    PRECACHE.map(async (url) => {
      const response = await fetch(url, { cache: 'reload', credentials: 'omit' });
      if (storable(response)) await cache.put(url, response);
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

/** A page load: always from the network; offline, the offline page (never a stored page). */
async function navigate(request) {
  try {
    return await fetch(request);
  } catch {
    const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE });
    return offline || Response.error();
  }
}

/** A static build file: from the cache, else from the network (and stored if allowed). */
async function staticFile(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (storable(response)) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }
  // Everything else not listed as static (API calls, the live session stream, page data) is left
  // to the browser: the worker does not touch it.
  if (NEVER_CACHE.some((re) => re.test(url.pathname))) return;
  if (STATIC.some((re) => re.test(url.pathname)) || url.pathname === OFFLINE_URL) {
    event.respondWith(staticFile(request));
  }
});

// Every page load asks; only after a sign-out cleared the caches is anything fetched again.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'precache') return;
  event.waitUntil(
    caches.match(OFFLINE_URL, { cacheName: CACHE }).then((hit) => (hit ? undefined : precache())),
  );
});
