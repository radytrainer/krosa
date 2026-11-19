import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { E2E } from '../support/stack.js';

/**
 * Loading states: the top progress bar, skeletons, and the status of background tasks (sync job,
 * preview). Self-contained: the data of the job and the sheet below is mocked in the browser
 * (made-up IDs, nothing is written to the database), and timers are fast-forwarded with
 * Playwright's clock, so the 10-second and 2-minute cases take no real time.
 */
test.describe.configure({ mode: 'serial' });

const JOB = '00000000-0000-4000-8000-00000000a001';
const SOURCE = '00000000-0000-4000-8000-00000000a002';
const GENERATION = { id: '00000000-0000-4000-8000-00000000a003', code: 'QAL2027', name: 'QAL' };
const TERM = { id: '00000000-0000-4000-8000-00000000a004', number: 1, name: 'Term 1' };
const QUEUED_AT = new Date('2030-03-01T08:00:00Z');
const STILL_WORKING = 'Still working. This can take up to a minute for a large workbook.';

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });

let storageState: Awaited<ReturnType<Awaited<ReturnType<Browser['newContext']>>['storageState']>>;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel(/Username or student ID/).fill(E2E.adminUser);
  await page.locator('input[name=password]').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  storageState = await context.storageState();
  await context.close();
});

/** A signed-in admin in a fresh context (so each test can install its own clock). */
async function adminPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState });
  return context.newPage();
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB,
    scope: 'SOURCE',
    status: 'RUNNING',
    phase: null,
    progress: { current: 1, total: 4 },
    counts: null,
    errorCount: 0,
    warningCount: 0,
    failureCode: null,
    failureMessage: null,
    source: {
      id: SOURCE,
      label: 'QAL Term 1',
      spreadsheetId: 'qal',
      generation: GENERATION,
      term: TERM,
    },
    generation: GENERATION,
    termNumber: 1,
    releaseAfterSync: false,
    requestedBy: { id: 'admin', username: 'admin' },
    parentId: null,
    retryOfId: null,
    queuedAt: QUEUED_AT.toISOString(),
    startedAt: QUEUED_AT.toISOString(),
    finishedAt: null,
    children: [],
    ...overrides,
  };
}

const NO_ISSUES = { data: [], meta: { page: 1, pageSize: 5, total: 0 }, tabs: [], notListed: 0 };

const source = {
  id: SOURCE,
  generation: GENERATION,
  term: TERM,
  rosterTab: 'ALL',
  spreadsheetId: 'qal',
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/qal/edit',
  label: 'QAL Term 1',
  spreadsheetTitle: 'QAL Term 1',
  status: 'ACTIVE',
  lastSyncedAt: QUEUED_AT.toISOString(),
  lastSyncJobId: null,
  ownedOfferings: 0,
  createdBy: { id: 'admin', username: 'admin' },
  createdAt: QUEUED_AT.toISOString(),
};

/** Serves the mocked job; `fail` makes its reads fail like an unreachable API. */
async function mockJob(page: Page, state: { job: ReturnType<typeof job>; fail?: boolean }) {
  await page.route(`**/api/v1/admin/sync/${JOB}`, (route) =>
    state.fail
      ? route.fulfill({
          status: 503,
          json: { error: { code: 'UNAVAILABLE', message: 'The service is unreachable.' } },
        })
      : route.fulfill({ json: state.job }),
  );
  await page.route(`**/api/v1/admin/sync/${JOB}/errors*`, (route) =>
    route.fulfill({ json: NO_ISSUES }),
  );
}

test('a sidebar click shows the top progress bar until the new page renders', async ({
  browser,
}) => {
  const page = await adminPage(browser);
  // Slow down the Audit log page's own code (its prefetch and its navigation).
  await page.route(/\/admin\/audit\?_rsc=/, async (route) => {
    await delay(2_000);
    await route.continue();
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await nav(page, 'Audit log').click();
  const bar = page.getByTestId('route-progress');
  await expect(bar).toHaveCSS('opacity', '1');
  await expect(page.getByRole('progressbar', { name: 'Loading page' })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/audit$/);
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(bar).toHaveCount(0);
  await page.context().close();
});

test('a slow page shows skeletons, then its content', async ({ browser }) => {
  const page = await adminPage(browser);
  await page.route('**/api/v1/admin/dashboard', async (route) => {
    await delay(1_500);
    await route.continue();
  });
  await page.goto('/admin');
  const loading = page.locator('[aria-busy="true"]').filter({ hasText: 'Loading dashboard' });
  await expect(loading).toHaveAttribute('role', 'status');
  await expect(loading.getByTestId('skeleton')).toHaveCSS('opacity', '1');
  await expect(page.getByText('Failed syncs')).toBeVisible();
  await expect(loading).toHaveCount(0);
  await page.context().close();
});

test('a fast load shows no loading indicator at all', async ({ browser }) => {
  const page = await adminPage(browser);
  await page.route('**/api/v1/admin/generations?*', (route) =>
    route.fulfill({ json: { data: [], meta: { page: 1, pageSize: 25, total: 0 } } }),
  );
  await page.goto('/admin');
  await expect(page.getByText('Failed syncs')).toBeVisible();
  // From now on, note any loading indicator that becomes visible, even for one frame.
  // (A string: this package has no DOM types.)
  await page.evaluate(`(() => {
    window.__flicker = false;
    const check = () => {
      for (const el of document.querySelectorAll('.loading-delayed')) {
        if (getComputedStyle(el).opacity !== '0') window.__flicker = true;
      }
      requestAnimationFrame(check);
    };
    check();
  })()`);
  await nav(page, 'Generations').click();
  await expect(page.getByText('No generations yet')).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.evaluate('window.__flicker'), 'a loading indicator flashed').toBe(false);
  await page.context().close();
});

test('a running sync updates by itself, says "Still working" after 10 s, and a failed read offers Reload status', async ({
  browser,
}) => {
  const page = await adminPage(browser);
  await page.clock.install({ time: QUEUED_AT });
  const state = { job: job(), fail: false };
  await mockJob(page, state);
  await page.goto(`/admin/sync/${JOB}`);
  await expect(page.getByText('1 of 4 steps')).toBeVisible();
  await expect(page.getByText(STILL_WORKING)).toHaveCount(0);

  // The job moves on: the page follows without a reload, and says it is still working.
  state.job = job({ progress: { current: 2, total: 4 } });
  await page.clock.fastForward(11_000);
  await expect(page.getByText('2 of 4 steps')).toBeVisible();
  await expect(page.getByText(STILL_WORKING)).toBeVisible();

  // Reading the status fails: the job stays on screen with the error and Reload status, no endless spinner.
  state.fail = true;
  const failed = page.getByRole('alert').filter({ hasText: 'Could not read the latest status' });
  await expect(async () => {
    await page.clock.fastForward(2_000);
    await expect(failed).toBeVisible({ timeout: 500 });
  }).toPass();
  await expect(page.getByText('2 of 4 steps')).toBeVisible();
  state.fail = false;
  await failed.getByRole('button', { name: 'Reload status' }).click();
  await expect(failed).toHaveCount(0);

  // The sidebar stays usable while the sync runs.
  await nav(page, 'Students').click();
  await expect(page).toHaveURL(/\/admin\/students$/);
  await expect(page.getByRole('heading', { name: 'Students' })).toBeVisible();
  await page.context().close();
});

test('a job queued for over a minute says no worker has picked it up, with Refresh', async ({
  browser,
}) => {
  const page = await adminPage(browser);
  await page.clock.install({ time: QUEUED_AT });
  await mockJob(page, {
    job: job({ status: 'QUEUED', startedAt: null, progress: { current: 0, total: 0 } }),
  });
  await page.goto(`/admin/sync/${JOB}`);
  await expect(page.getByText('Waiting for a worker')).toBeVisible();
  const notice = page.getByText('No worker has picked this up yet');
  await expect(notice).toHaveCount(0);
  await page.clock.fastForward(61_000);
  await expect(notice).toBeVisible();
  const read = page.waitForRequest((r) => r.url().endsWith(`/admin/sync/${JOB}`));
  await page.getByRole('button', { name: 'Refresh' }).click();
  await read;
  await page.context().close();
});

test('a sheet being synced cannot be synced twice; a stuck or failed preview shows Retry', async ({
  browser,
}) => {
  const page = await adminPage(browser);
  await page.clock.install({ time: QUEUED_AT });
  const state: { runningJobId: string | null; preview: 'hang' | 'fail'; hung: Route[] } = {
    runningJobId: JOB,
    preview: 'hang',
    hung: [],
  };
  await page.route(`**/api/v1/admin/sources/${SOURCE}`, (route) => route.fulfill({ json: source }));
  await page.route('**/api/v1/admin/term-workbooks', (route) =>
    route.fulfill({
      json: [
        {
          generation: GENERATION,
          term: TERM,
          active: source,
          pending: null,
          history: [],
          runningJobId: state.runningJobId,
        },
      ],
    }),
  );
  await page.route(`**/api/v1/admin/sources/${SOURCE}/preview`, (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: null });
    if (state.preview === 'hang') {
      state.hung.push(route);
      return undefined;
    }
    return route.fulfill({
      status: 503,
      json: {
        error: { code: 'GOOGLE_UNAVAILABLE', message: 'Google Sheets is not reachable right now.' },
      },
    });
  });
  await page.goto(`/admin/sources/${SOURCE}`);

  // While its sync runs: a disabled "Syncing…" button and an inline status with the job.
  await expect(page.getByRole('button', { name: 'Syncing…' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'View the job' })).toHaveAttribute(
    'href',
    `/admin/sync/${JOB}`,
  );
  // The sync ends: the next poll (every 3 s) brings the button back.
  state.runningJobId = null;
  await page.clock.fastForward(3_500);
  const syncNow = page.getByRole('button', { name: 'Sync now' });
  await expect(syncNow).toBeEnabled();

  // The preview takes long: "Still working" after 10 s, then stopped with Retry after 2 minutes.
  await syncNow.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Building preview…').first()).toBeVisible();
  await page.clock.fastForward(11_000);
  await expect(dialog.getByText(STILL_WORKING)).toBeVisible();
  await page.clock.fastForward(110_000);
  const failed = dialog.getByRole('alert').filter({ hasText: 'The preview did not finish' });
  await expect(failed).toContainText('No answer after 2 minutes');
  await expect(dialog.getByText('Building preview…')).toHaveCount(0);

  // Retry: this time it fails at once, with the error and Retry again.
  state.preview = 'fail';
  await failed.getByRole('button', { name: 'Retry' }).click();
  await expect(failed).toContainText('Google Sheets is not reachable right now.');
  await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();
  for (const route of state.hung) await route.abort().catch(() => undefined);
  await page.context().close();
});
