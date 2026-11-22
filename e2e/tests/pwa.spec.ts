import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ROOT } from '../support/stack.js';
import {
  CACHE_PREFIX,
  cacheContents,
  controllerUrl,
  forbiddenEntries,
  putInCache,
  waitForWorker,
} from '../support/pwa.js';

/**
 * Installable app (PWA, phase 1): manifest, icons, the service worker and its caches, the offline
 * page, and a new build taking over on the next visit. Needs no data: runs on the login page.
 * The student sign-in / sign-out check is step 12 of scenario.spec.ts; idle and "signed in
 * elsewhere" are in session-rules.spec.ts.
 */
test.describe.configure({ mode: 'serial' });

/** The build under test (next.config.ts generateBuildId): the worker's cache version. */
const BUILD_ID = readFileSync(path.join(ROOT, 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
const CACHE = CACHE_PREFIX + BUILD_ID;

test('manifest, icons and headers make the app installable', async ({ page, request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  const body = await manifest.json();
  expect(body).toMatchObject({ start_url: '/', scope: '/', display: 'standalone' });
  for (const icon of body.icons as { src: string }[]) {
    expect((await request.get(icon.src)).status(), icon.src).toBe(200);
  }
  expect((await request.get('/apple-icon.png')).status()).toBe(200);

  const login = await page.goto('/login');
  const csp = (await login!.allHeaders())['content-security-policy'] ?? '';
  expect(csp).toContain("worker-src 'self'");
  expect(csp).toContain("manifest-src 'self'");
  await expect(page.locator('link[rel=manifest]')).toHaveAttribute('href', /manifest\.webmanifest/);

  const sw = await request.get(`/sw.js?v=${BUILD_ID}`);
  expect(sw.status()).toBe(200);
  expect(sw.headers()['cache-control']).toContain('no-cache');
});

test('the worker registers with this build id and caches static files only', async ({ page }) => {
  await page.goto('/login');
  await waitForWorker(page);
  expect(new URL(await controllerUrl(page)).searchParams.get('v')).toBe(BUILD_ID);
  await page.reload(); // static files of the page now go through the worker
  await expect
    .poll(async () => (await cacheContents(page))[CACHE] ?? [])
    .toEqual(
      expect.arrayContaining(['/offline.html', expect.stringMatching(/^\/_next\/static\//)]),
    );
  const contents = await cacheContents(page);
  expect(Object.keys(contents)).toEqual([CACHE]);
  expect(forbiddenEntries(contents)).toEqual([]);
});

test('offline, a page load shows the offline page: no scripts, no data', async ({
  page,
  context,
}) => {
  await page.goto('/login');
  await waitForWorker(page);
  await context.setOffline(true);
  try {
    await page.goto('/student');
    await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();
    expect(await page.locator('script').count()).toBe(0);
  } finally {
    await context.setOffline(false);
  }
  // Back online, "Try again" loads the app's home page from the network.
  await page.getByRole('link', { name: 'Try again' }).click();
  await expect(page.getByText('Student Score Record System').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'You are offline' })).toHaveCount(0);
});

test('a new build takes over on the next visit and deletes the old cache, with no manual clear', async ({
  page,
}) => {
  // The previous build: its worker and a cache with one of its static files.
  await page.goto('/login');
  await waitForWorker(page);
  await page.evaluate(
    `navigator.serviceWorker.register('/sw.js?v=e2e-previous-build', { scope: '/', updateViaCache: 'none' }).then(() => undefined)`,
  );
  await expect.poll(() => controllerUrl(page)).toContain('v=e2e-previous-build');
  await putInCache(page, `${CACHE_PREFIX}e2e-previous-build`, '/_next/static/old-build.js');

  // The next visit loads this build's page, which registers this build's worker.
  await page.goto('/login');
  await expect.poll(() => controllerUrl(page)).toContain(`v=${BUILD_ID}`);
  await expect.poll(async () => Object.keys(await cacheContents(page))).toEqual([CACHE]);
});
