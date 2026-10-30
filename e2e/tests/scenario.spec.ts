import { expect, test, type Browser, type Page } from '@playwright/test';
import { TERM_FIXTURE_REPLACEMENT_ID, TERM_FIXTURE_SPREADSHEET_ID } from '@ssrs/sheets/testing';
import { E2E } from '../support/stack.js';

/**
 * The core journey, end to end through the real web app, API, queue and worker (only the Google
 * transport is replaced by the fixture workbook). Steps share state and run in order.
 *
 * Expected scores come from the fixture (packages/sheets/src/testing/term-workbook-fixture.ts)
 * for student PNC2027-001:
 *   Logic = 90·.10 + 89·.10 + 90·.10 + 97·.10 + 60·.25 + 78·.35 = 78.90
 */
test.describe.configure({ mode: 'serial' });

const STUDENT = {
  id: 'PNC2027-001',
  name: 'DARA SOK',
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
  await dialog.getByLabel(/Code/).fill('GEN2027');
  await dialog.getByLabel(/^Name/).fill('Generation 2027');
  await dialog.getByLabel(/Start date/).fill('2026-11-02');
  await dialog.getByRole('button', { name: 'Create generation' }).click();
  await expect(admin.getByRole('heading', { name: /Generation 2027/ })).toBeVisible();
  await expect(admin.getByRole('row')).toHaveCount(6); // header + five terms
});

test('3. connects the Term 1 workbook', async () => {
  await admin.getByRole('button', { name: 'Connect workbook' }).first().click();
  const dialog = admin.getByRole('dialog');
  await dialog
    .getByLabel(/Spreadsheet URL/)
    .fill(`https://docs.google.com/spreadsheets/d/${TERM_FIXTURE_SPREADSHEET_ID}/edit`);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(admin.getByRole('heading', { name: /Term 1 scores/ })).toBeVisible();
});

test('4. detects the tabs and confirms Logic', async () => {
  await admin.getByRole('button', { name: 'Detect tabs' }).click();
  await expect(admin.getByText('3 students found in "ALL"')).toBeVisible();
  await admin.getByRole('button', { name: /^Logic/ }).click();
  await admin.getByRole('button', { name: 'Confirm tab' }).click();
  await expect(admin.getByText('Confirmed', { exact: true })).toBeVisible();
});

test('5. synchronizes: the worker imports students and marks', async () => {
  await admin.getByRole('button', { name: 'Sync now' }).click();
  await expect(admin).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  await expect(admin.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(admin.getByRole('heading', { name: 'What changed' })).toBeVisible();
  // Issues saved at the end of the job appear without reloading the page.
  await expect(admin.getByText(/UNMAPPED_TAB/).first()).toBeVisible();
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
  await expect(student.getByRole('heading', { name: /Hello, DARA/ })).toBeVisible();
});

test('8. sees no scores until the term is released', async () => {
  await nav(student, 'My results').click();
  await expect(student.getByText('No results for this term yet')).toBeVisible();
});

test('9. an administrator releases the term and the student sees it at once', async () => {
  await nav(admin, 'Generations').click();
  await admin.getByRole('link', { name: 'GEN2027' }).click();
  await admin.getByRole('button', { name: 'Release scores' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Release scores' }).click();
  await expect(admin.getByText('Released', { exact: true })).toBeVisible();

  await student.reload();
  const logic = student.getByRole('button', { name: /Logic/ });
  await expect(logic).toContainText('78.90');
  await logic.click();
  await expect(student.getByRole('cell', { name: 'Quiz 1' })).toBeVisible();
});

test('10. changing the sheet changes nothing for students until its sync completes', async () => {
  await nav(admin, 'Generations').click();
  await admin.getByRole('link', { name: 'GEN2027' }).click();
  await admin.getByRole('button', { name: 'Edit Term 1' }).click();
  const dialog = admin.getByRole('dialog');
  await expect(
    dialog.getByRole('link', { name: new RegExp(TERM_FIXTURE_SPREADSHEET_ID) }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Replace' }).click();
  await dialog
    .getByLabel(/New spreadsheet URL/)
    .fill(`https://docs.google.com/spreadsheets/d/${TERM_FIXTURE_REPLACEMENT_ID}/edit`);
  await dialog.getByRole('button', { name: 'Check sheet' }).click();
  await expect(dialog.getByText('TERM1- GEN 2027 Scoring (corrected)')).toBeVisible();
  await expect(dialog.getByText('Student scores will not change yet')).toBeVisible();
  await dialog.getByRole('button', { name: 'Connect new sheet' }).click();

  await expect(admin).toHaveURL(/\/admin\/sources\/[0-9a-f-]+$/);
  await expect(admin.getByRole('alert').getByText(/not synced yet/)).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  await student.reload();
  await expect(student.getByRole('button', { name: /Logic/ })).toContainText('78.90');

  await admin.getByRole('button', { name: 'Detect tabs' }).click();
  await admin.getByRole('button', { name: /^Logic/ }).click();
  await expect(admin.getByLabel('Subject name')).toHaveValue('Logic');
  await admin.getByRole('button', { name: 'Confirm tab' }).click();
  await expect(admin.getByRole('button', { name: 'Reopen for review' })).toBeVisible();
  await expect(admin.getByText('Could not load this data')).toHaveCount(0);
  await admin.getByRole('button', { name: 'Run preview' }).click();
  await expect(admin.getByText(/1 changed/)).toBeVisible();
  await admin.getByRole('button', { name: 'Confirm preview' }).click();
  await expect(admin.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  await student.reload();
  await expect(student.getByRole('button', { name: /Logic/ })).toContainText('78.90');

  await admin.getByRole('button', { name: 'Sync now' }).click();
  await expect(admin).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  await expect(admin.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  await student.reload();
  await expect(student.getByRole('button', { name: /Logic/ })).toContainText('75.40');
});

test('11. removing the sheet stops syncing and keeps the student scores', async () => {
  await nav(admin, 'Generations').click();
  await admin.getByRole('link', { name: 'GEN2027' }).click();
  await admin.getByRole('button', { name: 'Edit Term 1' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Remove sheet' }).click();
  await expect(admin.getByRole('dialog').getByText(/No sheet connected/)).toBeVisible();
  await admin.keyboard.press('Escape');
  await expect(admin.getByRole('cell', { name: /No sheet connected/ })).toBeVisible();
  await student.reload();
  await expect(student.getByRole('button', { name: /Logic/ })).toContainText('75.40');
});

test('12. the student cannot reach admin pages or data, then signs out', async () => {
  await student.goto('/admin/students');
  await expect(student).toHaveURL(/\/student$/);
  const response = await student.request.get('/api/v1/admin/students');
  expect(response.status()).toBe(403);
  await student.getByRole('button', { name: 'Sign out' }).click();
  await expect(student).toHaveURL(/\/login$/);
  expect((await student.request.get('/api/v1/student/me')).status()).toBe(401);
});
