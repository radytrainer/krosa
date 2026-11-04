import { expect, test } from '@playwright/test';
import { asAdmin, nav, noJunk, remark, seedDemo } from './support.js';

/** These need an empty database, so they run first. The last test loads the demo data. */
test('TC-044 Dashboard with no sync history', async ({ browser }) => {
  const admin = await asAdmin(browser);
  await admin.page.goto('/admin');
  await expect(admin.page.getByText('No synchronizations yet')).toBeVisible();
  await noJunk(admin.page);
  const main = await admin.page.locator('main:visible').last().innerText();
  expect(main).not.toMatch(/could not load|error/i);
  expect(main).toMatch(/Connect|workbook|sheet|generation/i);
});

test('TC-156 Empty list text names the right tab', async ({ browser }) => {
  const admin = await asAdmin(browser);
  await admin.page.goto('/admin');
  await nav(admin.page, 'Students').click();
  await expect(admin.page.getByText('No students found')).toBeVisible();
  await expect(admin.page.locator('main:visible').last()).toContainText('ALL');
});

test('setup: load demo data', () => {
  seedDemo();
  remark('Setup');
});
