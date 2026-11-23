/**
 * Installable app (PWA): service worker registration and cache clearing. The worker itself is
 * public/sw.js; it stores only static build files, the icons and the offline page, never a page,
 * an API response or user data (docs/runbook.md "Service worker").
 */

/**
 * Kill switch, part 2 (docs/runbook.md "Service worker"): false makes every page unregister the
 * worker and clear its caches instead of registering it.
 */
export const SERVICE_WORKER_ENABLED = true;

/** This build's id (next.config.ts): the worker's cache version. */
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev';
/** Must match CACHE_PREFIX in public/sw.js. */
const CACHE_PREFIX = 'krosa-static-';
/** Sign-out never waits longer than this for the caches to clear. */
const CLEAR_TIMEOUT_MS = 1_500;

function supported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator;
}

async function unregisterAll(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((r) => r.unregister()));
}

/**
 * Registers this build's worker (production builds only). A new build registers a new script URL,
 * so the next visit installs it; the new worker deletes the old build's cache. Never throws.
 */
export async function registerServiceWorker(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' || !supported()) return;
  try {
    if (!SERVICE_WORKER_ENABLED) {
      await unregisterAll();
      await clearAppCaches();
      return;
    }
    await navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(BUILD_ID)}`, {
      scope: '/',
      updateViaCache: 'none',
    });
    // After a sign-out cleared the caches: store the offline page and icons again (static only).
    const ready = await navigator.serviceWorker.ready;
    ready.active?.postMessage({ type: 'precache' });
  } catch {
    // No worker: the app works the same, only without the offline page.
  }
}

/**
 * Deletes every cache of the worker (sign-out, idle sign-out, signed in elsewhere, expired session),
 * so nothing is left on a shared device. Never throws and never waits more than 1.5 s.
 */
export async function clearAppCaches(): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in window)) return;
  const clear = (async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)));
  })().catch(() => undefined);
  await Promise.race([clear, new Promise((resolve) => setTimeout(resolve, CLEAR_TIMEOUT_MS))]);
}
