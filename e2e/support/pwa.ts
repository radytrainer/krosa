import { expect, type Page } from '@playwright/test';

/**
 * Helpers for the service worker (apps/web/public/sw.js): what its caches hold, and a marker
 * entry that proves a sign-out cleared them (the worker stores the offline page and icons again
 * afterwards, so "empty" alone cannot be the test). Browser code is passed as strings, like the
 * other specs (this package has no DOM types).
 */
export const CACHE_PREFIX = 'krosa-static-';
export const CACHE_MARKER = '/_next/static/e2e-cache-marker.js';

/** The script URL of the worker controlling the page, or '' (none). */
export function controllerUrl(page: Page): Promise<string> {
  return page.evaluate<string>(`navigator.serviceWorker.controller?.scriptURL ?? ''`);
}

/** Waits until the page is controlled by the app's service worker. */
export async function waitForWorker(page: Page): Promise<void> {
  await page.evaluate(`navigator.serviceWorker.ready.then(() => undefined)`);
  await expect
    .poll(() => controllerUrl(page), { message: 'the service worker controls the page' })
    .toMatch(/\/sw\.js\?v=/);
}

/** Every cache of the origin with the paths it holds. */
export function cacheContents(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate<Record<string, string[]>>(`(async () => {
    const out = {};
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      out[name] = (await cache.keys()).map((r) => {
        const url = new URL(r.url);
        return url.pathname + url.search;
      });
    }
    return out;
  })()`);
}

/** Paths that must never be in a cache: API responses, pages, sign-in and password pages. */
export function forbiddenEntries(contents: Record<string, string[]>): string[] {
  const allowed = [/^\/_next\/static\//, /^\/icons\//, /^\/offline\.html$/];
  return Object.values(contents)
    .flat()
    .filter((path) => !allowed.some((re) => re.test(path)));
}

/** Puts an entry into a cache, as if the worker had stored a static file there. */
export async function putInCache(page: Page, cacheName: string, path: string): Promise<void> {
  await page.evaluate(`(async () => {
    const cache = await caches.open(${JSON.stringify(cacheName)});
    await cache.put(${JSON.stringify(path)}, new Response('/* e2e */', {
      headers: { 'content-type': 'text/javascript' },
    }));
  })()`);
}

/** Puts the marker into the worker's current cache. */
export async function plantCacheMarker(page: Page): Promise<void> {
  const version = new URL(await controllerUrl(page)).searchParams.get('v');
  expect(version, 'the page is controlled by the worker').toBeTruthy();
  await putInCache(page, CACHE_PREFIX + version, CACHE_MARKER);
  expect(Object.values(await cacheContents(page)).flat()).toContain(CACHE_MARKER);
}

/** After a sign-out: the marker is gone and nothing private is cached. */
export async function expectCachesCleared(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        Object.values(await cacheContents(page))
          .flat()
          .includes(CACHE_MARKER),
      {
        message: 'the sign-out cleared the service worker caches',
      },
    )
    .toBe(false);
  expect(forbiddenEntries(await cacheContents(page))).toEqual([]);
}
