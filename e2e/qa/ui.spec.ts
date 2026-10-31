import { expect, test, type Browser, type Page } from '@playwright/test';
import { TERM_FIXTURE_SPREADSHEET_ID } from '@ssrs/sheets/testing';
import { E2E, WEB_URL } from '../support/stack.js';

/** QA suite, area H, plus the browser parts of B-18, C-17, E-01, F-06 and G-05. Serial. */
test.describe.configure({ mode: 'serial' });

const STUDENT = { id: 'PNC2027-001', name: 'DARA SOK', password: 'River-Lantern-Morning-48' };
const V1 = '/api/v1';
const PHONE = { width: 390, height: 844 };

let admin: Page;
let student: Page;
let generationId = '';
let termId = '';
let sourceId = '';
let studentRowId = '';
let jobId = '';
const consoleProblems: string[] = [];

async function signIn(page: Page, identifier: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/Username or student ID/).fill(identifier);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function open(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) {
      consoleProblems.push(`${name}: ${m.text().slice(0, 200)}`);
    }
  });
  page.on('pageerror', (e) => consoleProblems.push(`${name}: ${e.message.slice(0, 200)}`));
  return page;
}

/** Calls the API from the page's own session, as the web app does. */
async function call(page: Page, method: string, path: string, data?: object) {
  const cookies = await page.context().cookies();
  const csrf = decodeURIComponent(cookies.find((c) => c.name === 'ssrs_csrf')?.value ?? '');
  const res = await page.request.fetch(`${V1}${path}`, {
    method,
    data,
    headers: { Origin: WEB_URL, 'X-CSRF-Token': csrf },
  });
  expect(res.status(), `${method} ${path}: ${await res.text()}`).toBeLessThan(400);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });

const noJunk = async (page: Page, label: string) => {
  const text = await page.locator('main:visible').last().innerText();
  expect(text, label).not.toMatch(/\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/);
};

test.beforeAll(async ({ browser }) => {
  admin = await open(browser, 'admin');
  student = await open(browser, 'student');
});

test('H-01 sign-in: empty form and wrong password give clear messages', async () => {
  await admin.goto('/login');
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await expect(admin).toHaveURL(/\/login/);
  await admin.getByLabel(/Username or student ID/).fill('nobody');
  await admin.locator('input[name=password]').fill('wrong-password');
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await expect(admin.getByRole('alert').first()).toContainText(/invalid|incorrect|wrong/i);
  await expect(admin.locator('input[name=password]')).toHaveValue('');
});

test('H-07 admin empty states on an empty system', async () => {
  await signIn(admin, E2E.adminUser, E2E.adminPassword);
  await expect(admin.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(admin.getByText('No synchronizations yet')).toBeVisible();
  await noJunk(admin, 'dashboard');
  await nav(admin, 'Generations').click();
  await expect(admin.getByText('No generations yet')).toBeVisible();
  await nav(admin, 'Students').click();
  await expect(admin.getByText('No students found')).toBeVisible();
  await noJunk(admin, 'students');
  await admin.goto('/admin/sync');
  await expect(admin.getByRole('heading', { name: 'Sync center' })).toBeVisible();
  await noJunk(admin, 'sync');
  await admin.goto('/admin/audit');
  await noJunk(admin, 'audit');
});

test('H-08 connect dialog: a bad URL shows a message, nothing is created', async () => {
  const gen = await call(admin, 'POST', '/admin/generations', {
    code: 'GEN2027',
    name: 'Generation 2027',
    startDate: '2026-11-02',
  });
  generationId = gen.id;
  termId = (await call(admin, 'GET', `/admin/generations/${gen.id}/terms`))[0].id;
  await admin.goto(`/admin/generations/${gen.id}`);
  await admin.getByRole('button', { name: 'Connect workbook' }).first().click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel(/Spreadsheet URL/).fill('https://example.com/not-a-sheet');
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(
    dialog.getByText(/docs\.google|address bar|spreadsheet url|google/i).first(),
  ).toBeVisible();
  await dialog
    .getByLabel(/Spreadsheet URL/)
    .fill(`https://docs.google.com/spreadsheets/d/${TERM_FIXTURE_SPREADSHEET_ID}/edit`);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(admin.getByRole('heading', { name: /Term 1 scores/ })).toBeVisible();
  sourceId = admin.url().split('/').pop()!;
});

test('H-08b confirm tab: weights not totalling 100 cannot be confirmed', async () => {
  await admin.getByRole('button', { name: 'Detect tabs' }).click();
  await expect(admin.getByText('3 students found in "ALL"')).toBeVisible();
  await admin.getByRole('button', { name: /^MsOffice/ }).click();
  await expect(admin.getByRole('button', { name: 'Confirm tab' })).toBeDisabled();
});

test('setup: confirm all tabs, sync, issue a password', async () => {
  const mappings = await call(admin, 'GET', `/admin/sources/${sourceId}/mappings`);
  const weights: Record<string, string> = {
    PARTICIPATIONS: '10',
    'MS WORD': '30',
    'MS POWERPOINT': '30',
    'MS EXCEL': '30',
  };
  for (const tab of mappings) {
    await call(admin, 'POST', `/admin/sources/${sourceId}/mappings/${tab.id}/confirm`, {
      subjectName: tab.tabName,
      columns: tab.columns.map((c: Record<string, string>) => ({
        columnIndex: c['columnIndex'],
        role: c['role'],
        ...(c['role'] === 'CRITERION'
          ? {
              name: c['proposedName'] ?? c['headerLabel'],
              weight: c['proposedWeight'] ?? weights[c['headerLabel']!],
            }
          : {}),
      })),
    });
  }
  jobId = (await call(admin, 'POST', '/admin/sync', { scope: 'SOURCE', sourceId })).jobId;
  await expect
    .poll(async () => (await call(admin, 'GET', `/admin/sync/${jobId}`)).status, {
      timeout: 30_000,
    })
    .toMatch(/SUCCEEDED/);
  const list = await call(admin, 'GET', `/admin/students?q=${STUDENT.id}`);
  studentRowId = list.data[0].id;
});

test('H-11 temporary password: shown once, gone after close and on Back', async () => {
  await admin.goto(`/admin/students/${studentRowId}`);
  await admin.getByRole('button', { name: 'Issue password' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Issue password' }).click();
  const shown = admin.getByRole('dialog').locator('code');
  await expect(shown).toBeVisible();
  const temp = (await shown.textContent())!.trim();
  await admin.getByRole('button', { name: 'Done' }).click();
  await expect(admin.getByText(temp)).toHaveCount(0);
  expect(await admin.content()).not.toContain(temp);
  await admin.goto('/admin/students');
  await admin.goBack();
  await expect(admin.getByRole('button', { name: 'Reset password' })).toBeVisible();
  expect(await admin.content()).not.toContain(temp);
  (globalThis as Record<string, unknown>)['qaTemp'] = temp;
});

test('H-02 forced change: cannot skip by URL; weak password shows the reason', async () => {
  const temp = (globalThis as Record<string, unknown>)['qaTemp'] as string;
  await signIn(student, STUDENT.id.toLowerCase(), temp);
  await expect(student).toHaveURL(/\/change-password$/);
  for (const path of ['/student', '/student/results', '/student/profile']) {
    await student.goto(path);
    await expect(student, path).toHaveURL(/\/change-password$/);
  }
  await student.locator('input[name=currentPassword]').fill(temp);
  await student.locator('input[name=newPassword]').fill(`${STUDENT.id}-password`);
  await student.locator('input[name=confirm]').fill(`${STUDENT.id}-password`);
  await student.getByRole('button', { name: 'Save and continue' }).click();
  await expect(student.getByText(/student ID|username/i).first()).toBeVisible();
  await expect(student).toHaveURL(/\/change-password$/);
  await student.locator('input[name=newPassword]').fill(STUDENT.password);
  await student.locator('input[name=confirm]').fill('Different-Value-Here-11');
  await student.getByRole('button', { name: 'Save and continue' }).click();
  await expect(student).toHaveURL(/\/change-password$/);
  await student.locator('input[name=confirm]').fill(STUDENT.password);
  await student.getByRole('button', { name: 'Save and continue' }).click();
  await expect(student).toHaveURL(/\/student$/);
});

test('H-03 student empty state before release', async () => {
  await nav(student, 'My results').click();
  await expect(student.getByText('No results for this term yet')).toBeVisible();
  await student.goto('/student');
  await noJunk(student, 'overview before release');
});

test('G-05 a script stored in a term name does not run', async () => {
  await call(admin, 'PATCH', `/admin/terms/${termId}`, {
    name: '<img src=x onerror="window.__xss=1">Term 1',
  });
  await call(admin, 'POST', `/admin/terms/${termId}/release`, { visible: true });
  for (const page of [student, admin]) {
    await page.goto(page === student ? '/student/results' : `/admin/generations/${generationId}`);
    await page.waitForLoadState('networkidle');
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    await expect(page.getByText('<img src=x', { exact: false }).first()).toBeVisible();
  }
  await call(admin, 'PATCH', `/admin/terms/${termId}`, { name: 'Term 1' });
});

test('H-06 / C-17 / F-06 results: totals match the API; a blank is not a zero', async () => {
  await student.goto('/student/results');
  const logic = student.getByRole('button', { name: /Logic/ });
  await expect(logic).toContainText('78.90');
  const bcu = student.getByRole('button', { name: /BCU/ });
  await expect(bcu).toContainText(/In progress/i);
  await bcu.click();
  await expect(student.getByText('Not entered').first()).toBeVisible();
  const row = student.getByRole('row', { name: /Quiz 1/ }).first();
  expect(await row.innerText()).not.toMatch(/\b0\.00\b/);
  await noJunk(student, 'results');
});

test('H-04 student error states: 500, 503, offline', async () => {
  for (const status of [500, 503]) {
    await student.route('**/api/v1/student/me/results*', (r) =>
      r.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
        }),
      }),
    );
    await student.goto('/student/results');
    await expect(student.getByText('Could not load this data'), `status ${status}`).toBeVisible({
      timeout: 30_000,
    });
    await student.unroute('**/api/v1/student/me/results*');
  }
  await student.route('**/api/v1/student/me/results*', (r) => r.abort());
  await student.goto('/student/results');
  await expect(student.getByText('Could not load this data')).toBeVisible({ timeout: 30_000 });
  await student.unroute('**/api/v1/student/me/results*');
});

test('H-05 loading state appears on a slow response', async () => {
  await student.route('**/api/v1/student/me/results*', async (r) => {
    await new Promise((x) => setTimeout(x, 2500));
    await r.continue().catch(() => undefined);
  });
  await student.goto('/student/results', { waitUntil: 'commit' });
  await expect(student.locator('[data-slot=skeleton]').first()).toBeVisible();
  await expect(student.getByRole('button', { name: /Logic/ })).toBeVisible();
  await student.unrouteAll({ behavior: 'ignoreErrors' });
});

test('H-09 / E-01 Sync Center: Term follows Generation; job page, issues table', async () => {
  await call(admin, 'POST', '/admin/generations', {
    code: 'GEN2028',
    name: 'Generation 2028',
    startDate: '2027-11-01',
  });
  await admin.goto('/admin/sync');
  const generation = admin.getByLabel(/^Generation/).first();
  const term = admin.getByLabel(/^Term/).first();
  await expect(generation).toBeVisible();
  await generation.selectOption({ label: 'Generation 2027' });
  const options = await term.locator('option').allTextContents();
  expect(options[0]).toBe('All terms');
  expect(options).toHaveLength(6);
  await term.selectOption({ index: 2 });
  await generation.selectOption({ label: 'Generation 2028' });
  await expect(term).toHaveValue(
    (await term.locator('option').first().getAttribute('value')) ?? '',
  );
  await admin.goto(`/admin/sync/${jobId}`);
  await expect(admin.getByRole('heading', { name: 'What changed' })).toBeVisible();
  await noJunk(admin, 'job page');
});

test('H-10 Edit term: an invalid replacement shows a message and changes nothing', async () => {
  await admin.goto(`/admin/generations/${generationId}`);
  await admin.getByRole('button', { name: 'Edit Term 1' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Replace' }).click();
  await dialog.getByLabel(/New spreadsheet URL/).fill('not a url');
  await dialog.getByRole('button', { name: 'Check sheet' }).click();
  await expect(dialog.getByRole('alert').first()).toBeVisible();
  await expect(dialog.getByText(/not a url|valid|address bar|URL/i).first()).toBeVisible();
  await admin.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('H-14 keyboard: dialog closes on Escape and returns focus; fields are labelled', async () => {
  await admin.goto(`/admin/generations/${generationId}`);
  const edit = admin.getByRole('button', { name: 'Edit Term 1' });
  await edit.focus();
  await admin.keyboard.press('Enter');
  const dialog = admin.getByRole('dialog');
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await admin.keyboard.press('Tab');
    // Invisible focus guards around the dialog are fine; a control behind it is not.
    const escaped = await admin.evaluate(() => {
      const el = document.activeElement;
      if (!el || el.closest('[role=dialog]')) return null;
      return el.matches('a, button, input, select, textarea') ? el.outerHTML.slice(0, 100) : null;
    });
    expect(escaped, `Tab ${i} stays in the dialog`).toBeNull();
  }
  await admin.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
  const unlabeled = await admin.evaluate(() =>
    [...document.querySelectorAll('input, select, textarea')]
      .filter((e) => !e.getAttribute('aria-label') && !(e as HTMLInputElement).labels?.length)
      .map((e) => e.outerHTML.slice(0, 80)),
  );
  expect(unlabeled).toEqual([]);
});

test('H-13 phone width: no sideways scroll on any page', async () => {
  const studentPaths = ['/student', '/student/results', '/student/profile'];
  const adminPaths = [
    '/admin',
    '/admin/generations',
    `/admin/generations/${generationId}`,
    `/admin/sources/${sourceId}`,
    '/admin/students',
    `/admin/students/${studentRowId}`,
    '/admin/sync',
    `/admin/sync/${jobId}`,
    '/admin/audit',
    '/admin/account',
  ];
  const overflow = async (page: Page, paths: string[]) => {
    await page.setViewportSize(PHONE);
    const bad: string[] = [];
    for (const path of paths) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (over > 0) bad.push(`${path}: ${over}px`);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    return bad;
  };
  const offering = (await call(student, 'GET', '/student/me/courses'))[0].offeringId;
  expect(await overflow(student, [...studentPaths, `/student/courses/${offering}`])).toEqual([]);
  expect(await overflow(admin, adminPaths)).toEqual([]);
});

test('H-13b phone: the menu opens and navigates', async () => {
  await student.setViewportSize(PHONE);
  await student.goto('/student');
  await student
    .getByRole('button', { name: /menu|navigation/i })
    .first()
    .click({ timeout: 10_000 });
  await student
    .getByRole('dialog')
    .getByRole('link', { name: 'My results' })
    .click({ timeout: 10_000 });
  await expect(student).toHaveURL(/\/student\/results$/);
  await student.setViewportSize({ width: 1280, height: 720 });
});

test('B-18 a student opening admin pages gets no admin content', async () => {
  for (const path of ['/admin', '/admin/students', `/admin/students/${studentRowId}`]) {
    await student.goto(path);
    await expect(student, path).toHaveURL(/\/student/);
  }
});

test('H-12 after sign-out, Back shows no data', async () => {
  await student.goto('/student/results');
  await expect(student.getByRole('button', { name: /Logic/ })).toBeVisible();
  await student.getByRole('button', { name: 'Sign out' }).click();
  await expect(student).toHaveURL(/\/login/);
  await student.goBack();
  await student.waitForLoadState('networkidle');
  await student.waitForTimeout(1500);
  const text = await student.locator('body').innerText();
  expect(text).not.toContain('78.90');
  expect(text).not.toContain(STUDENT.name);
});

test('H-01b sign-in: next cannot send a user to another site', async () => {
  await student.goto('/login?next=https://evil.example/');
  await student.getByLabel(/Username or student ID/).fill(STUDENT.id);
  await student.locator('input[name=password]').fill(STUDENT.password);
  await student.getByRole('button', { name: 'Sign in' }).click();
  await expect(student).toHaveURL(/localhost/);
  await student.getByRole('button', { name: 'Sign out' }).click();
  await expect(student).toHaveURL(/\/login/); // sign-out ends with a full page load
  await student.waitForLoadState('networkidle');
  for (const next of ['//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
    await student.goto(`/login?next=${encodeURIComponent(next)}`);
    expect(new URL(student.url()).hostname).toBe('localhost');
  }
});

test('H-01c too many attempts shows the wait, not a raw error', async ({ browser }) => {
  const page = await open(browser, 'limit');
  await page.goto('/login');
  for (let i = 0; i < 12; i++) {
    await page.getByLabel(/Username or student ID/).fill('nobody-limit');
    await page.locator('input[name=password]').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForTimeout(300);
    if (await page.getByText(/too many/i).count()) break;
  }
  await expect(page.getByText(/too many/i).first()).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(/undefined|INTERNAL|stack/);
});

test('H-15 no console errors or CSP violations through the run', async () => {
  expect(consoleProblems.filter((p) => !/Failed to load resource/.test(p))).toEqual([]);
});
