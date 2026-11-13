import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  LOGIC_COMMENT,
  TERM_FIXTURE_REPLACEMENT_ID,
  TERM_FIXTURE_GEN2028_ID,
  TERM_FIXTURE_SPREADSHEET_ID,
} from '@ssrs/sheets/testing';
import { createPrismaClient } from '@ssrs/database';
import { loadRootEnv } from '@ssrs/shared/node';
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

/** Counts the tab detections (POST .../detect) a page sends from now on. */
function countDetections(page: Page) {
  let n = 0;
  const onRequest = (r: { method(): string; url(): string }) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/detect')) n++;
  };
  page.on('request', onRequest);
  return { count: () => n, stop: () => page.off('request', onRequest) };
}
let detections: ReturnType<typeof countDetections>;

/** After a sheet is connected: its tabs are read once, by themselves, and the result shows. */
async function expectAutoDetected(page: Page) {
  await expect(page.getByText('3 students found in "ALL"')).toBeVisible();
  await expect(page.locator('[data-slot=detection-changes]')).toBeVisible();
  expect(detections.count(), 'one automatic detection').toBe(1);
}

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
  detections = countDetections(admin);
  await admin.getByRole('button', { name: 'Connect workbook' }).first().click();
  const dialog = admin.getByRole('dialog');
  await dialog
    .getByLabel(/Spreadsheet URL/)
    .fill(`https://docs.google.com/spreadsheets/d/${TERM_FIXTURE_SPREADSHEET_ID}/edit`);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(admin.getByRole('heading', { name: /Term 1 scores/ })).toBeVisible();
});

test('4. its tabs are read by themselves, once; the button still works; Logic is confirmed', async () => {
  // A first connection, from the generation page: detected automatically, once.
  await expectAutoDetected(admin);
  const changes = admin.locator('[data-slot=detection-changes]');
  await expect(changes.getByRole('heading', { name: 'Changes detected' })).toBeVisible();
  await expect(changes.getByText('New tab, to review')).toHaveCount(5);
  // Never on a page load.
  await admin.reload();
  await expect(admin.getByRole('heading', { name: 'Subject tabs' })).toBeVisible();
  await expect(admin.getByRole('button', { name: /^Logic/ })).toBeVisible();
  await admin.waitForTimeout(1500);
  expect(detections.count(), 'no detection on reload').toBe(1);
  await expect(admin.getByText('3 students found in "ALL"')).toHaveCount(0);
  // The button reads again, as before; nothing changed since.
  const button = admin.getByRole('button', { name: 'Detect tabs' });
  await button.click();
  await expect(admin.getByText('3 students found in "ALL"')).toBeVisible();
  await expect(changes).toHaveText('No changes since the tabs were last read.');
  expect(detections.count()).toBe(2);
  detections.stop();

  await admin.getByRole('button', { name: /^Logic/ }).click();
  await admin.getByRole('button', { name: 'Confirm tab' }).click();
  await expect(admin.getByText('Confirmed', { exact: true })).toBeVisible();
});

test('5. synchronizes: the worker imports students and marks', async () => {
  await admin.getByRole('button', { name: 'Sync now' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Sync now' }).click();
  await expect(admin).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  await expect(admin.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(admin.getByRole('heading', { name: 'What changed' })).toBeVisible();
  // Issues saved at the end of the job appear without reloading the page.
  await expect(admin.getByText(/UNMAPPED_TAB/).first()).toBeVisible();
  // Five issues or fewer: a count, and no page controls.
  await expect(admin.getByText(/^[1-5] issues?$/)).toBeVisible();
  await expect(admin.getByRole('navigation', { name: 'Pagination' })).toHaveCount(0);
});

test('5b. a long issue list is paged 5 at a time', async () => {
  // The fixture gives only a few issues: add warnings to this job until it has 23.
  const jobId = new URL(admin.url()).pathname.split('/').pop()!;
  loadRootEnv();
  const prisma = createPrismaClient({
    connectionString: process.env['TEST_DATABASE_URL']!,
    poolMax: 1,
  });
  try {
    const existing = await prisma.syncError.count({ where: { jobId } });
    await prisma.syncError.createMany({
      data: Array.from({ length: 23 - existing }, (_, i) => ({
        jobId,
        severity: 'WARNING' as const,
        code: 'PROFILE_MISMATCH',
        message: `Added warning ${i + 1}`,
        sheetTab: 'Logic',
        rowNumber: 100 + i,
      })),
    });
  } finally {
    await prisma.$disconnect();
  }
  await admin.reload();
  await expect(admin.getByText('1–5 of 23')).toBeVisible();
  const issues = admin.locator('section', {
    has: admin.getByRole('heading', { name: 'Issues', exact: true }),
  });
  await expect(issues.locator('tbody tr')).toHaveCount(5);
  await admin.getByRole('button', { name: 'Next page' }).click();
  await expect(admin.getByText('6–10 of 23')).toBeVisible();
  // A filter change goes back to page 1.
  await admin.getByLabel('Tab', { exact: true }).selectOption('Logic');
  await expect(admin.getByText(/^1–5 of \d+$/)).toBeVisible();
});

/**
 * Counts the admin API requests a page makes while it sits still for `ms`: none means nothing
 * polls. (Requests already started before the window are not counted.)
 */
async function requestsWhileIdle(page: Page, ms: number): Promise<string[]> {
  const seenUrls: string[] = [];
  const onRequest = (r: { url(): string }) => {
    if (r.url().includes('/api/v1/admin/')) seenUrls.push(new URL(r.url()).pathname);
  };
  page.on('request', onRequest);
  await page.waitForTimeout(ms);
  page.off('request', onRequest);
  return seenUrls;
}

test('5c. a first sheet: after its sync, no page says it was never synced, without a flash', async () => {
  // A first sheet is live at once (no review), so it never shows "New sheet connected, not synced
  // yet"; before its first sync the pages say "Not synced", "Never synchronized", "Last sync —".
  await expect(admin).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  await expect(admin.getByText('Succeeded', { exact: true }).first()).toBeVisible();
  // (Terms 2–5 rightly keep "Not synced": Term 1's row is checked on its own below.)
  await watchFor(admin, ['Never synchronized', 'Last sync —']);

  await nav(admin, 'Sync center').click();
  await expect(admin.getByRole('heading', { name: 'Workbooks by term' })).toBeVisible();
  const sheet = admin.getByRole('link', { name: /Term 1 scores/ }).first();
  await expect(sheet).toContainText('Last sync');
  // Nothing runs, so nothing polls.
  expect(await requestsWhileIdle(admin, 8_000)).toEqual([]);
  await sheet.click();
  await expect(admin).toHaveURL(/\/admin\/sources\/[0-9a-f-]+$/);
  await expect(admin.getByRole('heading', { name: 'Sync history' })).toBeVisible();
  await expect(admin.locator('main:visible tbody tr').first()).toBeVisible();
  await nav(admin, 'Generations').click();
  await admin.getByRole('link', { name: 'GEN2027' }).click();
  const term1 = admin.getByRole('row', { name: /Term 1/ });
  await expect(term1.getByText('Hidden', { exact: true })).toBeVisible();
  await expect(term1.getByText('Not synced')).toHaveCount(0);
  // Browser Back to the sheet's page, the Sync Center and the job.
  await admin.goBack();
  await admin.goBack();
  await expect(admin.getByRole('heading', { name: 'Sync history' })).toBeVisible();
  await admin.goBack();
  await expect(admin.getByRole('heading', { name: 'Workbooks by term' })).toBeVisible();
  await admin.goBack();
  await expect(admin).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  expect(await seenOn(admin), 'a "never synced" text showed, even briefly').toBe(false);

  // Full refresh of each page.
  const jobPage = admin.url();
  for (const path of ['/admin/sync', '/admin/generations']) {
    await admin.goto(path);
    await expect(admin.locator('main:visible')).toBeVisible();
  }
  await admin.getByRole('link', { name: 'GEN2027' }).click();
  await expect(term1.getByText('Hidden', { exact: true })).toBeVisible();
  await expect(term1.getByText('Not synced')).toHaveCount(0);
  await admin.goto(jobPage); // where the next step expects the admin
});

/** The admin's top-level sync jobs, as the Sync Center counts them. */
async function jobCount(): Promise<number> {
  const res = await admin.request.get('/api/v1/admin/sync?pageSize=1');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { meta: { total: number } }).meta.total;
}

const startDialog = () => admin.getByRole('dialog', { name: 'Start this sync?' });

/** Sync Center: Generation 2027, Term 1, Start sync. Returns the open dialog. */
async function openStartDialog() {
  await nav(admin, 'Sync center').click();
  // The form's own fields (the jobs filter below also has a "Generation" select).
  const card = admin.locator('[data-slot=card]', { hasText: 'Start a synchronization' });
  await card.getByLabel(/^Generation/).selectOption({ label: 'Generation 2027' });
  await card.getByLabel(/^Term/).selectOption({ label: 'Term 1' });
  await card.getByRole('button', { name: 'Start sync' }).click();
  await expect(startDialog()).toBeVisible();
  // The workbook it reads, with its subject and student counts.
  await expect(startDialog()).toContainText(/Generation 2027, Term 1: \d+ subjects?, \d+ students/);
  return startDialog();
}

/** Sync Center as shown now: loaded, and no confirm dialog (it may only open from a click). */
async function expectNoStartDialog(page = admin) {
  await expect(page.getByRole('heading', { name: 'Workbooks by term' })).toBeVisible();
  await page.waitForTimeout(500); // a dialog restored from an earlier visit appears at once
  await expect(page.getByRole('dialog', { name: 'Start this sync?' })).toHaveCount(0);
}

test('5d. the "Start this sync?" dialog opens only from a click on this visit', async () => {
  // Confirm (with a double-click): one job, then the job page.
  const before = await jobCount();
  const dialog = await openStartDialog();
  await dialog.getByRole('button', { name: 'Start sync' }).dblclick();
  await expect(admin).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  await expect(admin.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  expect(await jobCount()).toBe(before + 1);

  // Back to the Sync Center through the sidebar, from another page.
  await nav(admin, 'Dashboard').click();
  await expect(admin).toHaveURL(/\/admin$/);
  await nav(admin, 'Sync center').click();
  await expectNoStartDialog();

  // Browser Back from the job page.
  const again = await openStartDialog();
  await again.getByRole('button', { name: 'Start sync' }).click();
  await expect(admin).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  await expect(admin.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  await admin.goBack();
  await expect(admin).toHaveURL(/\/admin\/sync$/);
  await expectNoStartDialog();

  // A refresh, and a new tab.
  await admin.reload();
  await expectNoStartDialog();
  const tab = await admin.context().newPage();
  await tab.goto('/admin/sync');
  await expectNoStartDialog(tab);
  await tab.close();

  // Switching to another browser tab and back is not leaving the page: the dialog stays open.
  const kept = await openStartDialog();
  const other = await admin.context().newPage();
  await other.goto('/admin');
  await other.bringToFront();
  await admin.evaluate(`(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  })()`);
  await admin.bringToFront();
  await admin.evaluate(`(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  })()`);
  await other.close();
  await admin.waitForTimeout(500);
  await expect(kept).toBeVisible();
  await expect(kept).toContainText(/Generation 2027, Term 1: \d+ subjects?, \d+ students/);
  await kept.getByRole('button', { name: 'Cancel' }).click();

  // Cancel, leave, return.
  const cancelled = await openStartDialog();
  await cancelled.getByRole('button', { name: 'Cancel' }).click();
  await expect(startDialog()).toHaveCount(0);
  await nav(admin, 'Dashboard').click();
  await nav(admin, 'Sync center').click();
  await expectNoStartDialog();
  expect(await jobCount()).toBe(before + 2);
});

test('6. issues a temporary password to a student', async () => {
  await nav(admin, 'Students').click();
  await admin.getByRole('link', { name: STUDENT.name }).click();
  await admin.getByRole('button', { name: 'Issue password' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Issue password' }).click();
  const shown = admin.getByRole('dialog').locator('code');
  await expect(shown).toBeVisible();
  // Hidden by default (Item 1): show it to read it.
  await admin.getByRole('dialog').getByRole('button', { name: 'Show password' }).click();
  temporaryPassword = (await shown.textContent())?.trim() ?? '';
  expect(temporaryPassword.length).toBeGreaterThanOrEqual(12);
  await admin.getByRole('button', { name: 'Done' }).click();

  // The admin's view of this student's results: Courses complete and Top scoring per term, with
  // the subject marked as hidden (the term is not released yet). No average, no credits.
  const top = admin.locator('[data-slot="top-scoring"]');
  await expect(top).toContainText('Logic');
  await expect(top).toContainText('Hidden from student');
  await expect(top).toContainText('78.90 (B)');
  await expect(admin.getByRole('tab', { name: /Term 1/ })).toContainText('1 course');
  await expect(admin.locator('main:visible')).not.toContainText(
    /average|Credits complete|Provisional/i,
  );
  await expect(admin.getByText('Courses complete')).toBeVisible();
  // Terms without a COMPLETE subject: an empty state, never a zero.
  await admin.getByRole('tab', { name: /Term 2/ }).click();
  await expect(admin.getByText('No results for this term yet')).toBeVisible();
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
  // Top scoring for the student: released subjects only, never a hidden label.
  const top = student.locator('[data-slot="top-scoring"]');
  await expect(top).toHaveText('Logic: 78.90 (B)');
  await expect(student.locator('main:visible')).not.toContainText(
    /average|Credits complete|Provisional|Hidden from student/i,
  );
  const logic = student.getByRole('button', { name: /Logic/ });
  await expect(logic).toContainText('78.90');
  await logic.click();
  await expect(student.getByRole('cell', { name: 'Quiz 1' })).toBeVisible();
  // The teacher's comment, shown as plain text: the markup is not rendered.
  await expect(student.getByText(LOGIC_COMMENT, { exact: true })).toBeVisible();
  await expect(student.locator('blockquote b')).toHaveCount(0);
});

/**
 * Measures, in the browser, the text colour of each element matching `selector` against the
 * colour actually behind it (its own and its ancestors' backgrounds, composited on a canvas), and
 * returns the WCAG contrast ratio with the element's text. CSS colours in any syntax (oklch,
 * color-mix) are resolved by the canvas.
 */
const CONTRAST = (selector: string) => `(() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pixel = (fills) => {
    ctx.clearRect(0, 0, 1, 1);
    for (const f of fills) { ctx.fillStyle = f; ctx.fillRect(0, 0, 1, 1); }
    return ctx.getImageData(0, 0, 1, 1).data;
  };
  const lum = ([r, g, b]) => {
    const c = [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  return [...document.querySelectorAll(${JSON.stringify(selector)})]
    .filter((el) => el.checkVisibility())
    .map((el) => {
      const backgrounds = [];
      for (let n = el; n; n = n.parentElement) backgrounds.unshift(getComputedStyle(n).backgroundColor);
      const bg = pixel(['#fff', ...backgrounds]);
      const fg = pixel(['rgb(' + bg[0] + ',' + bg[1] + ',' + bg[2] + ')', getComputedStyle(el).color]);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return { tone: el.dataset.gradeTone ?? null, text: el.textContent.trim(), ratio: (hi + 0.05) / (lo + 0.05),
               color: 'rgb(' + fg[0] + ',' + fg[1] + ',' + fg[2] + ')' };
    });
})()`;

type Measured = { tone: string | null; text: string; ratio: number; color: string };

/** Every visible final score and grade on the page: the expected tone, the letter, 4.5:1 or more. */
async function expectToned(page: Page, tone: string, letter: string, score: string) {
  const all = (await page.evaluate(
    CONTRAST(
      '[data-slot=final-score], [data-slot=final-grade], [data-slot=top-scoring-score], [data-slot=top-scoring-grade], [data-slot=highest-score], [data-slot=highest-grade]',
    ),
  )) as Measured[];
  expect(all.length, 'final scores and grades on the page').toBeGreaterThan(0);
  for (const m of all) {
    expect(m.tone, m.text).toBe(tone);
    expect(m.ratio, `${m.text} contrast`).toBeGreaterThanOrEqual(4.5);
  }
  // The letter is always there as text, never colour alone; the score is the same colour.
  const texts = all.map((m) => m.text);
  expect(texts.some((t) => t === `Grade ${letter}` || t === `(${letter})`)).toBe(true);
  expect(texts).toContain(score);
  return all;
}

/** Sets every Logic mark of the student to `mark` in the test database (final score = mark). */
async function setLogicMarks(mark: number | null, restore?: { id: string; mark: unknown }[]) {
  loadRootEnv();
  const prisma = createPrismaClient({
    connectionString: process.env['TEST_DATABASE_URL']!,
    poolMax: 1,
  });
  try {
    const where = {
      enrollment: { student: { studentCode: STUDENT.id }, offering: { title: 'Logic' } },
    };
    const before = await prisma.assessmentScore.findMany({
      where,
      select: { id: true, mark: true },
    });
    if (restore) {
      for (const r of restore) {
        await prisma.assessmentScore.update({
          where: { id: r.id },
          data: { mark: r.mark as never },
        });
      }
    } else {
      await prisma.assessmentScore.updateMany({ where, data: { mark: mark! } });
    }
    // Cached student results carry the grade: make them stale, as a sync would.
    await prisma.generation.updateMany({ data: { cacheVersion: { increment: 1 } } });
    return before;
  } finally {
    await prisma.$disconnect();
  }
}

test('9a. final scores and grades are coloured by tone, readable in light and dark', async ({}, info) => {
  await nav(admin, 'Students').click();
  await admin.getByRole('link', { name: STUDENT.name }).click();
  await expect(admin.getByRole('heading', { name: STUDENT.name })).toBeVisible();
  const adminStudentPage = admin.url();

  const cases = [
    { mark: null, tone: 'good', letter: 'B', score: '78.90' }, // as synced
    { mark: 64, tone: 'caution', letter: 'C', score: '64.00' },
    { mark: 40, tone: 'fail', letter: 'E', score: '40.00' },
  ] as const;
  let original: { id: string; mark: unknown }[] = [];
  try {
    for (const c of cases) {
      if (c.mark !== null) {
        const before = await setLogicMarks(c.mark);
        if (original.length === 0) original = before;
      }
      for (const theme of ['light', 'dark'] as const) {
        const dark = theme === 'dark';
        const setTheme = (page: Page) =>
          page.evaluate(`document.documentElement.classList.toggle('dark', ${dark})`);
        // Student: results (course card, Top scoring), course page, dashboard (card, highest).
        await student.goto('/student/results');
        await setTheme(student);
        await student.getByRole('button', { name: /Logic/ }).click();
        await expectToned(student, c.tone, c.letter, c.score);
        await student.screenshot({
          path: info.outputPath(`student-results-${c.tone}-${theme}.png`),
        });
        await student.goto('/student');
        await setTheme(student);
        await expect(student.getByRole('heading', { name: /Hello, DARA/ })).toBeVisible();
        await expectToned(student, c.tone, c.letter, c.score);
        await student.getByRole('link', { name: /Logic/ }).click();
        await expect(student).toHaveURL(/\/student\/courses\//);
        await expect(student.getByRole('heading', { name: 'Logic' })).toBeVisible();
        await expectToned(student, c.tone, c.letter, c.score);
        // Admin: the student page (course card, Top scoring).
        await admin.goto(adminStudentPage);
        await setTheme(admin);
        await admin.getByRole('button', { name: /Logic/ }).click();
        await expectToned(admin, c.tone, c.letter, c.score);
        await admin.screenshot({ path: info.outputPath(`admin-student-${c.tone}-${theme}.png`) });
      }
    }
  } finally {
    if (original.length) await setLogicMarks(null, original);
    for (const page of [student, admin]) {
      await page.evaluate(`document.documentElement.classList.remove('dark')`);
    }
  }
  // Back as synced, where the next step expects the student.
  await student.goto('/student/results');
  await expect(student.getByRole('button', { name: /Logic/ })).toContainText('78.90');
});

test('9b. term classes for the admin, term history for the student', async () => {
  await nav(admin, 'Generations').click();
  await admin.getByRole('link', { name: 'GEN2027' }).click();
  await admin.getByRole('link', { name: 'Classes and students' }).first().click();
  await expect(admin.getByRole('heading', { name: 'Term 1: classes and students' })).toBeVisible();
  await expect(admin.getByRole('cell', { name: /^GENERAL/ })).toBeVisible();
  await expect(admin.getByText('Nothing to settle')).toBeVisible();

  await student.goto('/student/profile');
  await expect(student.getByText('Term 1: General, class A')).toBeVisible();
  await nav(student, 'My results').click(); // where the next step expects the student
  await expect(student.getByRole('button', { name: /Logic/ })).toBeVisible();
});

/** Term 1's Hide / Release button on the generation page, through its confirmation. */
async function setTerm1Visible(visible: boolean) {
  const label = visible ? 'Release scores' : 'Hide scores';
  await nav(admin, 'Generations').click();
  await admin.getByRole('link', { name: 'GEN2027' }).click();
  await admin.getByRole('button', { name: label }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: label }).click();
  await expect(admin.getByRole('alertdialog')).toHaveCount(0);
  // The button flips once the change is saved (a second Release button can appear elsewhere).
  await expect(
    admin.getByRole('button', { name: visible ? 'Hide scores' : 'Release scores' }).first(),
  ).toBeVisible();
}

/** What the browser fires when the student comes back to the tab. */
// Browsers fire it at the document, bubbling, as here.
const RETURN_TO_TAB = "document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))";

const UNAVAILABLE = 'This course is no longer available.';

/** Opens the Logic course page from the dashboard (in-app navigation) and returns its path. */
async function openLogicCourse(): Promise<string> {
  await nav(student, 'Overview').click();
  await student.getByRole('link', { name: /Logic/ }).click();
  await expect(student).toHaveURL(/\/student\/courses\/[0-9a-f-]+$/);
  await expect(student.getByRole('heading', { name: 'Logic' })).toBeVisible();
  return new URL(student.url()).pathname;
}

/** On the dashboard, with the notice shown exactly once and its code gone from the URL. */
async function expectRedirectedWithNotice() {
  await expect(student).toHaveURL(/\/student$/);
  await expect(student.getByText(UNAVAILABLE)).toHaveCount(1);
  await expect(student.getByRole('heading', { name: /Hello, DARA/ })).toBeVisible();
}

test('9c. a course that cannot be shown sends the student to the dashboard with a notice', async () => {
  // Reload after the admin hides the course.
  const coursePath = await openLogicCourse();
  await setTerm1Visible(false);
  await student.reload();
  await expectRedirectedWithNotice();
  // The toast is announced politely and closes by itself after about 6 seconds.
  await expect(student.locator('[aria-live="polite"]').getByText(UNAVAILABLE)).toBeVisible();
  await expect(student.getByText(UNAVAILABLE)).toHaveCount(0, { timeout: 12_000 });
  // Shown once: a reload of the dashboard shows nothing.
  await student.reload();
  await expect(student.getByRole('heading', { name: /Hello, DARA/ })).toBeVisible();
  await expect(student.getByText(UNAVAILABLE)).toHaveCount(0);

  // A saved link to the hidden course, an unknown id and a malformed id: the same.
  for (const path of [
    coursePath,
    '/student/courses/00000000-0000-4000-8000-000000000000',
    '/student/courses/not-a-course',
  ]) {
    await student.goto(path);
    await expectRedirectedWithNotice();
    await student.reload(); // clears the toast before the next case
  }
  // A notice code that is not on the list shows nothing and is dropped from the URL.
  await student.goto('/student?notice=https://example.com');
  await expect(student).toHaveURL(/\/student$/);
  await expect(student.getByRole('heading', { name: /Hello, DARA/ })).toBeVisible();
  await expect(student.getByText(/example\.com|no longer available/)).toHaveCount(0);

  // In-app: back to a course page that was open before the hide, never its cached copy.
  await setTerm1Visible(true);
  await student.reload(); // the dashboard keeps its own lists for 30 s
  await openLogicCourse();
  await setTerm1Visible(false);
  await nav(student, 'Overview').click();
  await expect(student.getByRole('heading', { name: /Hello, DARA/ })).toBeVisible();
  await student.goBack();
  await expectRedirectedWithNotice();
  await expect(student.getByRole('heading', { name: 'Logic' })).toHaveCount(0);

  // An open page re-checks when the student returns to the browser tab.
  await setTerm1Visible(true);
  await student.reload();
  await openLogicCourse();
  await setTerm1Visible(false);
  await student.evaluate(RETURN_TO_TAB);
  await expectRedirectedWithNotice();
  await setTerm1Visible(true);
});

test('9d. an expired session on a course page goes to sign-in, not the notice', async () => {
  await student.reload();
  const coursePath = await openLogicCourse();
  // The session cookies are gone (expired), the CSRF cookie is still there: the proxy lets the
  // request through and the API answers 401.
  await student.context().clearCookies({ name: /^ssrs_(at|rt)$/ });
  await student.evaluate(RETURN_TO_TAB);
  await expect(student).toHaveURL(/\/login\?next=%2Fstudent%2Fcourses%2F/);
  await expect(student.getByText(UNAVAILABLE)).toHaveCount(0);
  // Same on a full load of the course page.
  await student.goto(coursePath);
  await expect(student).toHaveURL(/\/login/);
  await expect(student.getByText(UNAVAILABLE)).toHaveCount(0);

  await signIn(student, STUDENT.id, STUDENT.newPassword);
  await expect(student).toHaveURL(/\/student/);
  await nav(student, 'My results').click(); // where the next step expects the student
  await expect(student.getByRole('button', { name: /Logic/ })).toBeVisible();
});

/**
 * Watches a page for any moment its visible main area contains `text`, however brief: every DOM
 * change is checked as it happens. Survives in-app navigation and Back (same document); a full
 * reload ends it. Next.js keeps earlier pages mounted but hidden: only what is on screen counts.
 */
async function watchFor(page: Page, text: string | string[]) {
  await page.evaluate(`(() => {
    const w = window;
    const texts = ${JSON.stringify([text].flat())};
    w.__seen = false;
    const check = () => {
      for (const main of document.querySelectorAll('main')) {
        if (main.checkVisibility() && texts.some((t) => main.textContent.includes(t))) {
          w.__seen = true;
        }
      }
    };
    check();
    new MutationObserver(check).observe(document.body, {
      subtree: true, childList: true, characterData: true,
    });
  })()`);
}
const seenOn = (page: Page) => page.evaluate<boolean>('window.__seen === true');
const seen = () => seenOn(student);

test('9e. after a hide, the student lists never show the course, not even for a moment', async () => {
  // Both lists seen while released, so a copy could be kept from this visit.
  await nav(student, 'Overview').click();
  await expect(student.getByRole('link', { name: /Logic/ })).toBeVisible();
  await nav(student, 'My results').click();
  await expect(student.getByRole('button', { name: /Logic/ })).toBeVisible();
  // The watcher does see the course when it is on screen.
  await watchFor(student, 'Logic');
  expect(await seen()).toBe(true);
  await nav(student, 'Profile').click();
  await expect(student.getByText('Term 1: General, class A')).toBeVisible();

  await setTerm1Visible(false);
  await watchFor(student, 'Logic');
  expect(await seen()).toBe(false);

  // Browser Back: to My results, then to the dashboard.
  await student.goBack();
  await expect(student).toHaveURL(/\/student\/results/);
  await expect(student.getByText('No results for this term yet')).toBeVisible();
  await student.goBack();
  await expect(student).toHaveURL(/\/student$/);
  // Next.js keeps the My results page mounted but hidden (its tabs also say "No results yet").
  await expect(
    student.locator('main:visible').getByText('No results yet', { exact: true }),
  ).toBeVisible();
  // In-app links.
  await nav(student, 'My results').click();
  await expect(student.getByText('No results for this term yet')).toBeVisible();
  await nav(student, 'Overview').click();
  await expect(
    student.locator('main:visible').getByText('No results yet', { exact: true }),
  ).toBeVisible();
  expect(await seen()).toBe(false);

  // The neutral empty state: no subject name, no count, no score.
  const main = student.locator('main:visible');
  await expect(main).not.toContainText(/Courses complete|Highest|\d+\.\d\d/);
  await expect(
    main.getByText('Your results appear here as soon as your courses are released'),
  ).toBeVisible();

  await setTerm1Visible(true);
  await nav(student, 'My results').click(); // where the next step expects the student
  await expect(student.getByRole('button', { name: /Logic/ })).toBeVisible();
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
  detections = countDetections(admin);
  await dialog.getByRole('button', { name: 'Connect new sheet' }).click();

  await expect(admin).toHaveURL(/\/admin\/sources\/[0-9a-f-]+$/);
  await expect(admin.getByRole('alert').getByText(/not synced yet/)).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  await student.reload();
  await expect(student.getByRole('button', { name: /Logic/ })).toContainText('78.90');

  // A replacement sheet: its tabs are read once, by themselves.
  await expectAutoDetected(admin);
  detections.stop();
  await admin.getByRole('button', { name: /^Logic/ }).click();
  await expect(admin.getByLabel('Subject name')).toHaveValue('Logic');
  await admin.getByRole('button', { name: 'Confirm tab' }).click();
  await expect(admin.getByRole('button', { name: 'Reopen for review' })).toBeVisible();
  await expect(admin.getByText('Could not load this data')).toHaveCount(0);
  // Every subject tab of a new sheet needs a decision before its preview can be confirmed.
  for (const tab of ['ENG', 'PL', 'BCU', 'MsOffice']) {
    await admin.getByRole('button', { name: new RegExp(`^${tab}`) }).click();
    await admin.getByRole('button', { name: 'Not a subject' }).click();
    await expect(admin.getByRole('button', { name: 'Not a subject' })).toHaveCount(0);
  }
  await admin.getByRole('button', { name: 'Run preview' }).click();
  await expect(admin.getByText(/1 changed/)).toBeVisible();
  await admin.getByRole('button', { name: 'Confirm preview' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(admin.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  await student.reload();
  await expect(student.getByRole('button', { name: /Logic/ })).toContainText('78.90');

  await admin.getByRole('button', { name: 'Sync now' }).click();
  // The pending sheet's sync has its own confirmation, with "Release scores after sync".
  await admin.getByRole('dialog').getByRole('button', { name: 'Sync now' }).click();
  await expect(admin).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  await expect(admin.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  await student.reload();
  await expect(student.getByRole('button', { name: /Logic/ })).toContainText('75.40');
});

const NOT_SYNCED = 'New sheet connected, not synced yet';

test('10b. after the sync, the "not synced yet" notice is gone everywhere, without a flash', async () => {
  // The admin is on the finished job's page. From here on, record any moment the notice shows.
  await watchFor(admin, NOT_SYNCED);

  // In-app link to the Sync Center.
  await nav(admin, 'Sync center').click();
  await expect(admin.getByRole('heading', { name: 'Workbooks by term' })).toBeVisible();
  await expect(admin.getByRole('link', { name: /Scoring \(corrected\)/ })).toBeVisible();
  // The sync is over, so every poll has stopped.
  expect(await requestsWhileIdle(admin, 8_000)).toEqual([]);
  // The generation page and the sheet's own page.
  await nav(admin, 'Generations').click();
  await admin.getByRole('link', { name: 'GEN2027' }).click();
  await expect(admin.getByRole('cell', { name: /Scoring \(corrected\)/ })).toBeVisible();
  // Browser Back through the Sync Center to the job page, then the sheet's page before it.
  await admin.goBack();
  await admin.goBack();
  await expect(admin.getByRole('heading', { name: 'Workbooks by term' })).toBeVisible();
  await admin.goBack();
  await expect(admin).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  await admin.goBack();
  await expect(admin).toHaveURL(/\/admin\/sources\/[0-9a-f-]+$/);
  await expect(admin.getByRole('heading', { name: 'Subject tabs' })).toBeVisible();
  expect(await seenOn(admin), 'the notice showed, even briefly').toBe(false);

  // A full refresh of each page.
  for (const path of ['/admin/sync', admin.url()]) {
    await admin.goto(path);
    await expect(admin.locator('main:visible')).toBeVisible();
    await expect(admin.getByText(NOT_SYNCED)).toHaveCount(0);
  }
});

test('10c. a failed sync of a new sheet keeps the notice', async () => {
  // Go back to the first sheet through review, as a new sheet.
  await nav(admin, 'Generations').click();
  await admin.getByRole('link', { name: 'GEN2027' }).click();
  await admin.getByRole('button', { name: 'Edit Term 1' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Replace' }).click();
  await dialog
    .getByLabel(/New spreadsheet URL/)
    .fill(`https://docs.google.com/spreadsheets/d/${TERM_FIXTURE_SPREADSHEET_ID}/edit`);
  await dialog.getByRole('button', { name: 'Check sheet' }).click();
  // Reading the tabs fails this time (Google unreachable): the connection must still work.
  await admin.route('**/api/v1/admin/sources/*/detect', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'GOOGLE_UNAVAILABLE', message: 'Google Sheets is not reachable right now.' },
      }),
    }),
  );
  await dialog.getByRole('button', { name: 'Connect new sheet' }).click();
  await expect(admin).toHaveURL(/\/admin\/sources\/[0-9a-f-]+$/);
  const sourcePath = new URL(admin.url()).pathname;
  const sourceId = sourcePath.split('/').pop()!;
  const failure = admin.getByRole('alert').filter({ hasText: 'The tabs could not be read' });
  await expect(failure).toContainText('Google Sheets is not reachable right now.');
  await expect(failure).toContainText('The sheet is still connected');
  await expect(admin.getByRole('alert').getByText(NOT_SYNCED)).toBeVisible();
  await admin.unroute('**/api/v1/admin/sources/*/detect');
  await failure.getByRole('button', { name: 'Try again' }).click();
  await expect(admin.getByText('3 students found in "ALL"')).toBeVisible();
  await expect(failure).toHaveCount(0);

  await admin.getByRole('button', { name: /^Logic/ }).click();
  await admin.getByRole('button', { name: 'Confirm tab' }).click();
  await expect(admin.getByRole('button', { name: 'Reopen for review' })).toBeVisible();
  for (const tab of ['ENG', 'PL', 'BCU', 'MsOffice']) {
    await admin.getByRole('button', { name: new RegExp(`^${tab}`) }).click();
    await admin.getByRole('button', { name: 'Not a subject' }).click();
    await expect(admin.getByRole('button', { name: 'Not a subject' })).toHaveCount(0);
  }
  await admin.getByRole('button', { name: 'Run preview' }).click();
  await admin.getByRole('button', { name: 'Confirm preview' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(admin.getByRole('button', { name: 'Sync now' })).toBeEnabled();

  // Make the real sync fail: the confirmed preview no longer matches the sheet's content, as if
  // a teacher edited it after the preview, so the worker refuses it (PREVIEW_STALE).
  loadRootEnv();
  const prisma = createPrismaClient({
    connectionString: process.env['TEST_DATABASE_URL']!,
    poolMax: 1,
  });
  try {
    const n = await prisma.sheetPreview.updateMany({
      where: { sourceId, invalidatedAt: null },
      data: { fingerprint: 'edited-after-the-preview' },
    });
    expect(n.count).toBe(1);
  } finally {
    await prisma.$disconnect();
  }
  await admin.getByRole('button', { name: 'Sync now' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Sync now' }).click();
  await expect(admin).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  await expect(admin.getByText('Failed', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });

  // The notice stays: in-app, Back and full refresh.
  await nav(admin, 'Sync center').click();
  await expect(admin.getByText(NOT_SYNCED)).toBeVisible();
  await admin.goBack();
  await admin.goBack();
  await expect(admin).toHaveURL(new RegExp(`${sourcePath}$`));
  await expect(admin.getByRole('alert').getByText(NOT_SYNCED)).toBeVisible();
  await admin.reload();
  await expect(admin.getByRole('alert').getByText(NOT_SYNCED)).toBeVisible();
  await admin.goto('/admin/sync');
  await expect(admin.getByText(NOT_SYNCED)).toBeVisible();

  // Discard it, so the active sheet can be removed next.
  await admin.goto(sourcePath);
  await admin.getByRole('button', { name: 'Discard new sheet' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
  await expect(
    admin.getByText('New sheet discarded. The current sheet stays active.'),
  ).toBeVisible();
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

test('13. a first sheet connected from the Edit term form is read once, by itself', async () => {
  await nav(admin, 'Generations').click();
  await admin.getByRole('button', { name: 'New generation' }).click();
  const create = admin.getByRole('dialog');
  await create.getByLabel(/Code/).fill('GEN2028');
  await create.getByLabel(/^Name/).fill('Generation 2028');
  await create.getByLabel(/Start date/).fill('2027-11-01');
  await create.getByRole('button', { name: 'Create generation' }).click();
  await expect(admin.getByRole('heading', { name: /Generation 2028/ })).toBeVisible();

  await admin.getByRole('button', { name: 'Edit Term 1' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog
    .getByLabel(/Spreadsheet URL/)
    .fill(`https://docs.google.com/spreadsheets/d/${TERM_FIXTURE_GEN2028_ID}/edit`);
  await dialog.getByRole('button', { name: 'Check sheet' }).click();
  detections = countDetections(admin);
  await dialog.getByRole('button', { name: 'Connect sheet' }).click();
  await expect(admin).toHaveURL(/\/admin\/sources\/[0-9a-f-]+$/);
  await expectAutoDetected(admin);
  // Back and forward do not start it again either.
  await admin.goBack();
  await admin.goForward();
  await expect(admin.getByRole('heading', { name: 'Subject tabs' })).toBeVisible();
  await admin.waitForTimeout(1500);
  expect(detections.count()).toBe(1);
  // The button still reads again on demand (a second run at the same time is refused by the
  // server's lock; see term-workbooks.integration-spec.ts).
  const button = admin.getByRole('button', { name: 'Detect tabs' });
  await button.click();
  await expect(admin.getByText('3 students found in "ALL"')).toBeVisible();
  expect(detections.count()).toBe(2);
  detections.stop();
});

test('14. a column missing from the sheet stays flagged, and confirming lists what is dropped', async () => {
  // Step 13 left the admin on the new sheet's page. Confirm Logic, then reopen it.
  const sourceId = new URL(admin.url()).pathname.split('/').pop()!;
  await admin.getByRole('button', { name: /^Logic/ }).click();
  await admin.getByRole('button', { name: 'Confirm tab' }).click();
  await admin.getByRole('button', { name: 'Reopen for review' }).click();
  await expect(admin.getByRole('button', { name: 'Confirm tab' })).toBeVisible();

  // What re-detection leaves when the teacher deleted a column (the detection itself is covered
  // in term-workbooks.integration-spec.ts; the fixture workbook cannot change during this run).
  loadRootEnv();
  const prisma = createPrismaClient({
    connectionString: process.env['TEST_DATABASE_URL']!,
    poolMax: 1,
  });
  try {
    const tab = await prisma.sheetTabMapping.findFirstOrThrow({
      where: { sourceId, tabName: 'Logic' },
    });
    expect(tab.status).toBe('DRAFT');
    await prisma.sheetColumnMapping.create({
      data: {
        tabMappingId: tab.id,
        columnIndex: null,
        missingFromSheet: true,
        headerLabel: 'Quiz 3 10%',
        role: 'CRITERION',
        proposedName: 'Quiz 3',
        proposedWeight: '10',
      },
    });
  } finally {
    await prisma.$disconnect();
  }

  // The flag survives a reload; the row is shown, read-only, and not counted.
  await admin.reload();
  await admin.getByRole('button', { name: /^Logic/ }).click();
  const flagged = admin.locator('[data-slot=missing-column]');
  await expect(flagged).toHaveCount(1);
  await expect(flagged).toContainText('Quiz 3 10%');
  await expect(flagged).toContainText('Missing from the sheet');
  await expect(admin.getByText('Columns missing from the sheet are not counted.')).toBeVisible();
  await expect(admin.getByText('Total weight: 100%')).toBeVisible();

  // Confirming first lists exactly what is dropped, and the total that remains.
  await admin.getByRole('button', { name: 'Confirm tab' }).click();
  const dialog = admin.getByRole('alertdialog');
  await expect(
    dialog.getByRole('heading', { name: 'Drop 1 missing column and confirm?' }),
  ).toBeVisible();
  const dropped = dialog.locator('[data-slot=dropped-columns] li');
  await expect(dropped).toHaveCount(1);
  await expect(dropped).toContainText('Quiz 3');
  await expect(dropped).toContainText('Marks · 10%');
  await expect(dialog).toContainText('Weight total after dropping them: 100%');
  await expect(dialog).toContainText('Their marks and criteria are kept.');
  await dialog.getByRole('button', { name: 'Drop and confirm' }).click();
  await expect(admin.getByText('Confirmed "Logic".')).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Reopen for review' })).toBeVisible();
  await admin.reload();
  await admin.getByRole('button', { name: /^Logic/ }).click();
  await expect(admin.locator('[data-slot=missing-column]')).toHaveCount(0);
});
