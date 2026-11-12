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

test('P1 sign-in: Show / Hide password by mouse and keyboard; hidden again after submit', async () => {
  const secret = 'Not-A-Real-Pass-731';
  const logged: string[] = [];
  admin.on('console', (m) => logged.push(m.text()));
  await admin.goto('/login');
  const field = admin.locator('input[name=password]');
  await expect(field).toHaveAttribute('type', 'password');
  await expect(field).toHaveAttribute('autocomplete', 'current-password');
  await expect(field).toHaveAttribute('name', 'password');
  await field.fill(secret);
  const show = admin.getByRole('button', { name: 'Show password' });
  await expect(show).toHaveAttribute('aria-pressed', 'false');
  // Keyboard: Tab from the field reaches the toggle, with a visible focus ring.
  await field.focus();
  await admin.keyboard.press('Tab');
  await expect(show).toBeFocused();
  const ring = await show.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe('none');
  await admin.keyboard.press('Enter');
  await expect(field).toHaveAttribute('type', 'text');
  await expect(field).toHaveValue(secret);
  const hide = admin.getByRole('button', { name: 'Hide password' });
  await expect(hide).toHaveAttribute('aria-pressed', 'true');
  await expect(field).toHaveAttribute('autocomplete', 'current-password');
  await admin.keyboard.press('Space');
  await expect(field).toHaveAttribute('type', 'password');
  // Shown, then submitted (wrong password): hidden again.
  await show.click();
  await admin.getByLabel(/Username or student ID/).fill('nobody');
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await expect(admin.getByRole('alert').first()).toBeVisible();
  await expect(field).toHaveAttribute('type', 'password');
  // Leaving and coming back: hidden.
  await field.fill(secret);
  await show.click();
  await admin.goto('/login?x=1');
  await expect(admin.locator('input[name=password]')).toHaveAttribute('type', 'password');
  admin.removeAllListeners('console');
  expect(logged.filter((l) => l.includes(secret))).toEqual([]);
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
  const dialog = admin.getByRole('dialog');
  const shown = dialog.locator('code');
  await expect(shown).toBeVisible();
  // Hidden by default: dots only, and the password is not in the page.
  await expect(shown).toHaveText(/^•{12,}$/);
  const toggle = dialog.getByRole('button', { name: 'Show password' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // Copy works while hidden.
  await admin.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await admin.evaluate(() => navigator.clipboard.readText());
  expect(copied).not.toMatch(/•/);
  expect(await admin.content()).not.toContain(copied);
  await toggle.click();
  await expect(dialog.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const temp = (await shown.textContent())!.trim();
  expect(temp).toBe(copied);
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

test('P2 change password: three fields, each with its own toggle', async () => {
  const logged: string[] = [];
  student.on('console', (m) => logged.push(m.text()));
  await student.goto('/student/profile');
  const fields = {
    current: student.locator('input[name=currentPassword]'),
    next: student.locator('input[name=newPassword]'),
    confirm: student.locator('input[name=confirm]'),
  };
  await expect(fields.current).toHaveAttribute('autocomplete', 'current-password');
  await expect(fields.next).toHaveAttribute('autocomplete', 'new-password');
  await expect(fields.confirm).toHaveAttribute('autocomplete', 'new-password');
  const toggles = student.getByRole('button', { name: 'Show password' });
  await expect(toggles).toHaveCount(3);
  for (const f of Object.values(fields)) await expect(f).toHaveAttribute('type', 'password');
  await fields.next.fill('Visible-Only-Here-55');
  // Toggle only the new password: the other two stay hidden.
  await student.locator(`button[aria-controls="${await fields.next.getAttribute('id')}"]`).click();
  await expect(fields.next).toHaveAttribute('type', 'text');
  await expect(fields.current).toHaveAttribute('type', 'password');
  await expect(fields.confirm).toHaveAttribute('type', 'password');
  await student
    .locator(`button[aria-controls="${await fields.confirm.getAttribute('id')}"]`)
    .click();
  await expect(fields.confirm).toHaveAttribute('type', 'text');
  await expect(fields.current).toHaveAttribute('type', 'password');
  // Submitting hides them all again (the current password is wrong, so nothing changes).
  await fields.current.fill('Wrong-Current-Pass-99');
  await fields.confirm.fill('Visible-Only-Here-55');
  await student.getByRole('button', { name: 'Change password' }).click();
  await expect(student.getByText('This is not your current password.')).toBeVisible();
  for (const f of Object.values(fields)) await expect(f).toHaveAttribute('type', 'password');
  student.removeAllListeners('console');
  expect(logged.filter((l) => /Visible-Only-Here-55|Wrong-Current-Pass-99/.test(l))).toEqual([]);
  await student.goto('/student');
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

test('G3 a grade appears only beside a COMPLETE final score', async () => {
  const courses: {
    offeringId: string;
    title: string;
    status: string;
    finalGrade: string | null;
  }[] = await call(student, 'GET', '/student/me/courses');
  const complete = courses.filter((c) => c.status === 'COMPLETE');
  expect(complete.length).toBeGreaterThan(0);
  expect(complete.every((c) => /^[A-F]$/.test(c.finalGrade ?? ''))).toBe(true);
  expect(courses.filter((c) => c.status !== 'COMPLETE').every((c) => c.finalGrade === null)).toBe(
    true,
  );
  const grades = (page: Page) => page.locator('main:visible [data-slot=final-grade]');

  // Student panel: one grade per COMPLETE course card, none in the summary or chart.
  await student.goto('/student');
  await expect(grades(student)).toHaveCount(complete.length);
  for (const text of await grades(student).allInnerTexts()) expect(text).toMatch(/^Grade [A-F]$/);
  // The Overall card's only grade is beside the highest final score (S2).
  const overallCard = student.locator('section', {
    has: student.getByRole('heading', { name: 'Overall' }),
  });
  await expect(overallCard.getByText(/Grade/)).toHaveCount(0);
  await expect(overallCard.locator('[data-slot=highest-grade]')).toHaveCount(1);

  // Results page: Logic (78.90) shows C as text; BCU is in progress and shows none.
  await student.goto('/student/results');
  await expect(student.getByRole('button', { name: /Logic/ })).toContainText('78.90');
  await expect(student.getByRole('button', { name: /Logic/ })).toContainText('Grade C');
  // The term summary's only grade sits beside its Top scoring final score (T3).
  const termSummary = student.locator('main:visible dl', { hasText: 'Top scoring' });
  await expect(termSummary.locator('[data-slot=top-scoring-grade]')).toHaveCount(1);
  await expect(termSummary.locator('[data-slot=top-scoring]')).toContainText(
    /\d+\.\d\d \([A-F]\)$/,
  );
  await expect(termSummary.getByText(/Grade/)).toHaveCount(0);
  const bcu = student.getByRole('button', { name: /BCU/ });
  await expect(bcu.locator('[data-slot=final-grade]')).toHaveCount(0);
  await bcu.click();
  // Component marks and contributions never carry one.
  await expect(student.getByRole('table').getByText(/Grade/)).toHaveCount(0);

  // Subject page.
  const logic = complete.find((c) => /Logic/.test(c.title))!;
  await student.goto(`/student/courses/${logic.offeringId}`);
  await expect(grades(student)).toHaveText(['Grade C']);
  await expect(student.getByRole('table').getByText(/Grade/)).toHaveCount(0);

  // Admin view of the student.
  await admin.goto(`/admin/students/${studentRowId}`);
  await expect(admin.getByRole('button', { name: /Logic/ })).toContainText('Grade C');
  await expect(
    admin.getByRole('button', { name: /BCU/ }).locator('[data-slot=final-grade]'),
  ).toHaveCount(0);
});

test('S1 dashboard Overall: courses complete and the latest term highest, no average', async () => {
  const summary = await call(student, 'GET', '/student/me/summary');
  const highest = summary.latestTermHighest;
  expect(highest).not.toBeNull();
  await student.goto('/student');
  const card = student.locator('section', {
    has: student.getByRole('heading', { name: 'Overall' }),
  });
  await expect(card).toContainText('Courses complete');
  await expect(card).toContainText(
    `${summary.overall.completedCourses} / ${summary.overall.totalCourses}`,
  );
  await expect(card).not.toContainText(/average/i);
  await expect(card).not.toContainText(/credits/i);
  await expect(card).toContainText('Highest final score of the latest term');
  const line = card.locator('[data-slot=highest]');
  await expect(line).toContainText(`${highest.finalScore} (${highest.finalGrade})`);
  for (const s of highest.subjects) await expect(line).toContainText(s.title);
  await expect(line).toContainText(`Term ${highest.termNumber}`);
  await noJunk(student, 'dashboard');
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

test('R1 Sync Center: confirm, then Hide and Release from the per-source list', async () => {
  // The term was released earlier (G-05): the confirmation notes it instead of offering release.
  await admin.goto('/admin/sync');
  await admin
    .getByLabel(/^Generation/)
    .first()
    .selectOption({ label: 'Generation 2027' });
  await admin.getByRole('button', { name: 'Start sync' }).click();
  const confirm = admin.getByRole('dialog');
  await expect(confirm).toContainText('1 workbook will be read');
  await expect(confirm.locator('[data-slot=released-note]')).toContainText(
    'updated scores become visible to students after this sync',
  );
  await expect(confirm.getByLabel('Release scores after sync')).toHaveCount(0);
  await confirm.getByRole('button', { name: 'Start sync' }).click();
  await expect(admin).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  await expect(admin.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  const list = admin.locator('section', {
    has: admin.getByRole('heading', { name: 'Per-source jobs' }),
  });
  await expect(list.getByText('Released', { exact: true })).toBeVisible();
  const expectedStudents = (await call(admin, 'GET', `/admin/sync/plan?scope=ALL`))[0].students;

  // Hide one source: confirmation with the number of students, then the student sees nothing.
  await list.getByRole('button', { name: /^Hide scores/ }).click();
  const hide = admin.getByRole('alertdialog');
  await expect(hide.locator('[data-slot=students-affected]')).toHaveText(
    `${expectedStudents} ${expectedStudents === 1 ? 'student' : 'students'} affected.`,
  );
  await hide.getByRole('button', { name: 'Hide scores' }).click();
  await expect(list.getByText('Hidden', { exact: true })).toBeVisible();
  await student.goto('/student');
  await expect(student.getByText('No results yet')).toBeVisible();
  await expect(student.locator('[data-slot=final-grade]')).toHaveCount(0);
  await student.goto('/student/results');
  await expect(student.getByRole('button', { name: /Logic/ })).toHaveCount(0);

  // Bulk: select by keyboard, Release selected, confirm.
  const box = list.getByRole('checkbox', { name: /^Select Generation 2027/ });
  await box.focus();
  await admin.keyboard.press('Space');
  await expect(box).toBeChecked();
  await list.getByRole('button', { name: 'Release selected' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Release scores' }).click();
  await expect(list.getByText('Released', { exact: true })).toBeVisible();
  await student.goto('/student/results');
  await expect(student.getByRole('button', { name: /Logic/ })).toContainText('78.90');

  const audit = await call(admin, 'GET', '/admin/audit-logs?pageSize=10');
  const actions = (audit.data as { action: string }[]).map((e) => e.action);
  expect(actions).toContain('source.hidden');
  expect(actions).toContain('source.released');
  await noJunk(admin, 'job page with release controls');
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
