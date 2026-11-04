import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PIDS_FILE } from '../../global-setup.js';
import { API_URL, start, stop, waitForUrl } from '../../support/stack.js';
import { API_ARGS, manualEnv } from './global-setup.js';
import {
  asAdmin,
  clearLimits,
  DEMO_PASSWORD,
  remark,
  sql,
  synced,
  syncNow,
  uiLogin,
  waitJob,
} from './support.js';

/**
 * These restart real services. Run last: a process started from a test ends with its test worker,
 * and the worker is replaced after any failure, so later cases would lose the service.
 */
const main = (page: Page) => page.locator('main:visible').last();
test.beforeEach(() => clearLimits());

test('TC-118 Failed job message is honest', async ({ browser }) => {
  test.setTimeout(90_000);
  const admin = await asAdmin(browser);
  const s = await synced(admin);
  const job = await syncNow(admin, s.sourceId);
  // As a crashed worker leaves it: unfinished, past the first subjects, nothing live in the queue.
  sql(
    `update sync_jobs set status='RUNNING', phase='APPLY', finished_at=null, failure_code=null, failure_message=null, progress_current=3, lease_token=null, lease_expires_at=null where id='${job.id}'`,
  );
  const pids = JSON.parse(readFileSync(PIDS_FILE, 'utf8')) as number[];
  stop(pids[1]);
  const worker = start('worker', ['apps/worker/test/qa/manual-worker.mjs'], manualEnv());
  pids[1] = worker.pid!;
  writeFileSync(PIDS_FILE, JSON.stringify(pids));
  await waitJob(admin, job.id, 40_000);
  await admin.page.goto(`/admin/sync/${job.id}`);
  await expect(admin.page.getByText('Failed', { exact: true }).first()).toBeVisible();
  await expect(main(admin.page)).toContainText('Some subjects were already saved.');
  remark('Crash state set on the test database, then the real worker recovery ran');
});

test('TC-191 Service down message', async ({ browser }) => {
  test.setTimeout(90_000);
  const admin = await asAdmin(browser);
  const page = admin.page;
  await page.goto('/admin');
  const pids = JSON.parse(readFileSync(PIDS_FILE, 'utf8')) as number[];
  stop(pids[0]);
  await new Promise((r) => setTimeout(r, 1000));
  await page.goto('/admin/students');
  await page.waitForTimeout(3000);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/ECONNREFUSED|Internal Server Error|stack|at \w+\.\w+ \(/i);
  const fresh = await browser.newPage();
  await uiLogin(fresh, 'GEN26-0001', DEMO_PASSWORD);
  await expect(fresh.getByText('The service is unreachable. Please try again.')).toBeVisible();
  const api = start('api', API_ARGS, manualEnv());
  pids[0] = api.pid!;
  writeFileSync(PIDS_FILE, JSON.stringify(pids));
  await waitForUrl(`${API_URL}/api/v1/health/ready`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Students' })).toBeVisible();
  remark('Real API process stopped and restarted');
});
