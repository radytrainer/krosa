import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../support/stack.js';

/**
 * QA A-33 / A-34: a valid session after the 15-minute access cookie has gone. The browser drops
 * that cookie at its Max-Age, so a reload after 15 idle minutes looks exactly like this.
 */
async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/Username or student ID/).fill(E2E.adminUser);
  await page.locator('input[name=password]').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function dropAccessCookie(page: Page) {
  const context = page.context();
  const keep = (await context.cookies()).filter((c) => c.name !== 'ssrs_at');
  await context.clearCookies();
  await context.addCookies(keep);
}

function watchRefresh(page: Page, seen: string[]) {
  page.on('response', (r) => {
    if (r.url().includes('/auth/')) seen.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
}

test('A-34 one tab: a reload after the access cookie expires keeps the session', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  await dropAccessCookie(page);
  const seen: string[] = [];
  watchRefresh(page, seen);
  await page.goto('/admin/students');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  console.log('[A-34] calls', JSON.stringify(seen), 'url', page.url());
  await expect(page).toHaveURL(/\/admin\/students$/);
  await context.close();
});

test('A-34b one tab: an API call in an open page after expiry refreshes silently', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Students' })
    .click();
  await expect(page).toHaveURL(/\/admin\/students$/);
  await dropAccessCookie(page);
  const seen: string[] = [];
  watchRefresh(page, seen);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Audit log' })
    .click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  console.log('[A-34b] calls', JSON.stringify(seen), 'url', page.url());
  await expect(page).toHaveURL(/\/admin\/audit$/);
  await context.close();
});

test('A-33 two tabs in a page that is open: simultaneous refresh keeps the session', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const one = await context.newPage();
  await signIn(one);
  const two = await context.newPage();
  await two.goto('/admin');
  await expect(two.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await dropAccessCookie(one);
  const seen: string[] = [];
  watchRefresh(one, seen);
  watchRefresh(two, seen);
  // The same request from both tabs, at once, through the app's own client path.
  const nav = (p: Page) =>
    p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' }).click();
  await Promise.all([nav(one), nav(two)]);
  await one.waitForLoadState('networkidle');
  await one.waitForTimeout(1500);
  console.log('[A-33] calls', JSON.stringify(seen));
  const three = await context.newPage();
  await three.goto('/admin/students');
  await three.waitForLoadState('networkidle');
  await three.waitForTimeout(1000);
  await expect(three).toHaveURL(/\/admin\/students$/);
  await context.close();
});
