import { expect, test, type Browser, type Page } from '@playwright/test';
import { FIXTURE_SPREADSHEET_ID } from '@ssrs/sheets/testing';
import { E2E } from '../support/stack.js';

/**
 * The core journey, end to end through the real web app, API, queue and worker (only the Google
 * transport is replaced by the fixture workbook). Steps share state and run in order.
 *
 * Expected scores are computed by hand from the fixture (packages/sheets/src/testing/fixtures.ts)
 * for student GEN26-0001:
 *   Mathematics I = 8/10·5 + 9/10·5 + 41.5/50·30 + 72/100·40 + 9/10·10 + 10/10·10 = 81.20
 *   English I     = 85/100·30 + 40/50·30 + 45/50·30 + 9/10·10                    = 85.50
 */
test.describe.configure({ mode: 'serial' });

const STUDENT = {
  id: 'GEN26-0001',
  name: 'Example Student A',
  newPassword: 'River-Lantern-Morning-48',
};
let admin: Page;
let student: Page;
let temporaryPassword = '';

async function signIn(page: Page, identifier: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/Username or student ID/).fill(identifier);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });

test.beforeAll(async ({ browser }) => {
  admin = await newPage(browser);
  student = await newPage(browser);
});

test('1. the administrator signs in', async () => {
  await signIn(admin, E2E.adminUser, E2E.adminPassword);
  await expect(admin).toHaveURL(/\/admin$/);
  await expect(admin.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('2. creates a generation with five terms', async () => {
  await nav(admin, 'Generations').click();
  await admin.getByRole('button', { name: 'New generation' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel(/Code/).fill('GEN2026');
  await dialog.getByLabel(/^Name/).fill('Generation 2026');
  await dialog.getByLabel(/Start date/).fill('2026-01-05');
  await dialog.getByRole('button', { name: 'Create generation' }).click();
  await expect(admin.getByRole('heading', { name: /Generation 2026/ })).toBeVisible();
  await expect(admin.getByRole('row')).toHaveCount(6); // header + five terms
});

test('3. connects the generation’s Google Sheet', async () => {
  await admin.getByRole('button', { name: 'Connect sheet' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog
    .getByLabel(/Spreadsheet URL/)
    .fill(`https://docs.google.com/spreadsheets/d/${FIXTURE_SPREADSHEET_ID}/edit`);
  await dialog.getByLabel(/^Label/).fill('Term marks 2026');
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await admin.getByRole('link', { name: 'Term marks 2026' }).click();
  await expect(admin.getByRole('heading', { name: /Term marks 2026/ })).toBeVisible();
});

test('4. previews the spreadsheet without importing anything', async () => {
  await admin.getByRole('button', { name: 'Run preview' }).click();
  await expect(admin.getByText('Ready to sync')).toBeVisible();
  await expect(admin.getByRole('cell', { name: /Mathematics I/ })).toBeVisible();
  await expect(admin.getByRole('cell', { name: /English I/ })).toBeVisible();
});

test('5. synchronizes: the worker imports students, courses and marks', async () => {
  await admin.getByRole('button', { name: 'Sync now' }).click();
  await expect(admin).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  await expect(admin.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(admin.getByRole('heading', { name: 'What changed' })).toBeVisible();
});

test('6. issues a temporary password to a student', async () => {
  await nav(admin, 'Students').click();
  await admin.getByRole('link', { name: STUDENT.name }).click();
  await admin.getByRole('button', { name: 'Issue password' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Issue password' }).click();
  const shown = admin.getByRole('dialog').locator('code');
  await expect(shown).toBeVisible();
  temporaryPassword = (await shown.textContent())?.trim() ?? '';
  expect(temporaryPassword.length).toBeGreaterThanOrEqual(12);
  await admin.getByRole('button', { name: 'Done' }).click();
});

test('7. the student signs in and must replace the temporary password', async () => {
  await signIn(student, STUDENT.id.toLowerCase(), temporaryPassword);
  await expect(student).toHaveURL(/\/change-password$/);
  await student.locator('input[name=currentPassword]').fill(temporaryPassword);
  await student.locator('input[name=newPassword]').fill(STUDENT.newPassword);
  await student.locator('input[name=confirm]').fill(STUDENT.newPassword);
  await student.getByRole('button', { name: 'Save and continue' }).click();
  await expect(student).toHaveURL(/\/student$/);
  await expect(student.getByRole('heading', { name: /Hello, Example/ })).toBeVisible();
});

test('8. sees correctly computed results; hidden courses stay hidden', async () => {
  await nav(student, 'My results').click();
  const math = student.getByRole('button', { name: /Mathematics I/ });
  await expect(math).toContainText('81.20');
  await math.click();
  await expect(student.getByRole('cell', { name: 'Midterm Exam' })).toBeVisible();
  await expect(student.getByRole('cell', { name: '24.90' })).toBeVisible(); // 41.5/50 × 30
  await student.getByRole('tab', { name: /Term 2/ }).click();
  await expect(student.getByText('No results for this term yet')).toBeVisible();
});

test('9. an administrator releases a course and the student sees it at once', async () => {
  await nav(admin, 'Course offerings').click();
  await admin.getByRole('link', { name: 'English I' }).click();
  await admin.getByRole('switch', { name: /Visible to students/ }).click();
  await expect(admin.getByText('Visibility updated.')).toBeVisible();

  await student.reload();
  await student.getByRole('tab', { name: /Term 2/ }).click();
  await expect(student.getByRole('button', { name: /English I/ })).toContainText('85.50');
});

test('10. the student cannot reach admin pages or data, then signs out', async () => {
  await student.goto('/admin/students');
  await expect(student).toHaveURL(/\/student$/);
  const response = await student.request.get('/api/v1/admin/students');
  expect(response.status()).toBe(403);
  await student.getByRole('button', { name: 'Sign out' }).click();
  await expect(student).toHaveURL(/\/login$/);
  expect((await student.request.get('/api/v1/student/me')).status()).toBe(401);
});
