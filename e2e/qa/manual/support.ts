import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { termWorkbookFixture, type FakeSpreadsheet } from '@ssrs/sheets/testing';
import { E2E, ROOT, WEB_URL } from '../../support/stack.js';

export const SHEETS_DIR = path.join(ROOT, 'e2e', 'test-results', 'sheets');
export const V1 = '/api/v1';
export const DEMO_PASSWORD = 'Student-Pass-2026x';
export const NEW_PASSWORD = 'River-Lantern-Morning-48';
const PG = process.env['QA_POSTGRES_CONTAINER'] ?? 'ssrs-qa-postgres-1';
const REDIS = process.env['QA_REDIS_CONTAINER'] ?? 'ssrs-qa-redis-1';
const dbUrl = new URL(process.env['TEST_DATABASE_URL']!);
const redisUrl = new URL(process.env['TEST_REDIS_URL']!);
if (dbUrl.hostname !== 'localhost' || !dbUrl.pathname.endsWith('_test')) {
  throw new Error('test database only');
}

export const remark = (text: string) =>
  test.info().annotations.push({ type: 'remark', description: text });

/** Reads or changes the test database directly, for preconditions the UI cannot set. */
export function sql(query: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      '-e',
      `PGPASSWORD=${decodeURIComponent(dbUrl.password)}`,
      PG,
      'psql',
      '-U',
      'ssrs',
      '-d',
      'ssrs_test',
      '-Atc',
      query,
    ],
    { encoding: 'utf8' },
  ).trim();
}

/** Clears sign-in and sync limits, so one case does not use up the next one's budget. */
export function clearLimits(): void {
  const script =
    "for _,p in ipairs({'ssrs:v1:rl:*','ssrs:v1:auth:login:*'}) do for _,k in ipairs(redis.call('keys',p)) do redis.call('del',k) end end return 1";
  execFileSync(
    'docker',
    [
      'exec',
      '-e',
      `REDISCLI_AUTH=${decodeURIComponent(redisUrl.password)}`,
      REDIS,
      'redis-cli',
      '-n',
      '15',
      'EVAL',
      script,
      '0',
    ],
    { stdio: 'ignore' },
  );
}

export interface Session {
  context: BrowserContext;
  page: Page;
}

export async function apiLogin(
  browser: Browser,
  identifier: string,
  password: string,
): Promise<Session> {
  clearLimits();
  const context = await browser.newContext();
  const res = await context.request.post(`${V1}/auth/login`, {
    headers: { Origin: WEB_URL },
    data: { identifier, password },
  });
  expect(res.status(), `sign in ${identifier}`).toBe(200);
  return { context, page: await context.newPage() };
}

export const asAdmin = (browser: Browser) => apiLogin(browser, E2E.adminUser, E2E.adminPassword);
export const asDemo = (browser: Browser, id = 'GEN26-0001') => apiLogin(browser, id, DEMO_PASSWORD);

export async function call(s: Session, method: string, url: string, data?: object) {
  const cookies = await s.context.cookies();
  const csrf = decodeURIComponent(cookies.find((c) => c.name === 'ssrs_csrf')?.value ?? '');
  return s.context.request.fetch(`${V1}${url}`, {
    method,
    data,
    headers: { Origin: WEB_URL, 'X-CSRF-Token': csrf },
  });
}

export async function ok(s: Session, method: string, url: string, data?: object) {
  const res = await call(s, method, url, data);
  const text = await res.text();
  expect(res.status(), `${method} ${url}: ${text.slice(0, 200)}`).toBeLessThan(400);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function uiLogin(page: Page, identifier: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/Username or student ID/).fill(identifier);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });

export const dropAccessCookie = async (context: BrowserContext) => {
  const keep = (await context.cookies()).filter((c) => c.name !== 'ssrs_at');
  await context.clearCookies();
  await context.addCookies(keep);
};

export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
const sheetFile = (id: string) => path.join(SHEETS_DIR, `${id}.json`);
export type TestSheet = FakeSpreadsheet & { fail?: string; delayMs?: number };
export const writeSheet = (id: string, sheet: object) =>
  writeFileSync(sheetFile(id), JSON.stringify(sheet));
export const readSheet = (id: string): TestSheet =>
  JSON.parse(readFileSync(sheetFile(id), 'utf8')) as TestSheet;
export function editSheet(id: string, edit: (s: TestSheet) => void) {
  const sheet = readSheet(id);
  edit(sheet);
  writeSheet(id, sheet);
}

let counter = 0;
export const unique = () =>
  `Q${Date.now().toString(36).toUpperCase().slice(-6)}${(counter++).toString(36).toUpperCase()}`;
export const sheetId = (p: string) => `1QaSheet${p}`.padEnd(40, '0');

/** The synthetic fixture, with student IDs of this case only. */
export function workbook(prefix: string, edit?: (s: TestSheet) => void): TestSheet {
  const sheet = termWorkbookFixture() as TestSheet;
  delete sheet.tabs['_meta'];
  sheet.title = `Test Sheet ${prefix}`;
  for (const grid of Object.values(sheet.tabs)) {
    for (const row of grid) {
      if (typeof row[0] === 'string' && row[0].startsWith('PNC2027-')) {
        row[0] = row[0].replace('PNC2027', prefix);
      }
    }
  }
  edit?.(sheet);
  return sheet;
}

const TYPED_WEIGHTS: Record<string, string> = {
  PARTICIPATIONS: '10',
  'MS WORD': '30',
  'MS POWERPOINT': '30',
  'MS EXCEL': '30',
};

export interface Scenario {
  prefix: string;
  code: string;
  generationId: string;
  terms: { id: string; number: number }[];
  termId: string;
  sheet: string;
  sourceId: string;
  students: [string, string, string];
}

export async function newGeneration(admin: Session, code = unique()) {
  const gen = await ok(admin, 'POST', '/admin/generations', {
    code,
    name: `Generation ${code}`,
    startDate: '2026-11-02',
  });
  const terms = (await ok(admin, 'GET', `/admin/generations/${gen.id}/terms`)) as {
    id: string;
    number: number;
  }[];
  return { id: gen.id as string, code, terms };
}

export async function connect(admin: Session, termId: string, id: string, label = 'Test Sheet A') {
  return ok(admin, 'POST', `/admin/terms/${termId}/sources`, { url: sheetUrl(id), label });
}

export interface Tab {
  id: string;
  tabName: string;
  status: string;
  columns: {
    columnIndex: number;
    headerLabel: string;
    role: string;
    proposedName: string | null;
    proposedWeight: string | null;
  }[];
  carriedFrom?: { subject: string } | null;
}

export async function detect(admin: Session, sourceId: string) {
  await ok(admin, 'POST', `/admin/sources/${sourceId}/detect`);
  return (await ok(admin, 'GET', `/admin/sources/${sourceId}/mappings`)) as Tab[];
}

export const confirmBody = (tab: Tab, subject?: string, weights: Record<string, string> = {}) => ({
  subjectName: subject ?? tab.carriedFrom?.subject ?? tab.tabName,
  columns: tab.columns.map((c) => ({
    columnIndex: c.columnIndex,
    role: c.role,
    ...(c.role === 'CRITERION'
      ? {
          name: c.proposedName ?? c.headerLabel,
          weight: weights[c.headerLabel] ?? c.proposedWeight ?? TYPED_WEIGHTS[c.headerLabel],
        }
      : {}),
  })),
});

export async function confirmAll(admin: Session, sourceId: string) {
  const tabs = await detect(admin, sourceId);
  for (const tab of tabs) {
    await ok(
      admin,
      'POST',
      `/admin/sources/${sourceId}/mappings/${tab.id}/confirm`,
      confirmBody(tab),
    );
  }
  return tabs;
}

export async function waitJob(admin: Session, jobId: string, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const job = await ok(admin, 'GET', `/admin/sync/${jobId}`);
    if (!['QUEUED', 'RUNNING'].includes(job.status)) return job;
    if (Date.now() - started > timeoutMs) throw new Error(`job still ${job.status}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function startSync(admin: Session, sourceId: string) {
  clearLimits();
  return (await ok(admin, 'POST', '/admin/sync', { scope: 'SOURCE', sourceId })).jobId as string;
}

export const syncNow = async (admin: Session, sourceId: string) =>
  waitJob(admin, await startSync(admin, sourceId));

/** A generation with Test Sheet A connected to Term 1, tabs confirmed, one successful sync. */
export async function synced(
  admin: Session,
  options: {
    release?: boolean;
    sync?: boolean;
    confirm?: boolean;
    edit?: (s: TestSheet) => void;
  } = {},
): Promise<Scenario> {
  const { release = true, sync = true, confirm = true, edit } = options;
  const prefix = unique();
  const gen = await newGeneration(admin, prefix);
  const sheet = sheetId(prefix);
  writeSheet(sheet, workbook(prefix, edit));
  const termId = gen.terms[0]!.id;
  const source = await connect(admin, termId, sheet);
  if (confirm) await confirmAll(admin, source.id);
  if (confirm && sync) {
    const job = await syncNow(admin, source.id);
    expect(job.status).toMatch(/SUCCEEDED/);
    if (release) await ok(admin, 'POST', `/admin/terms/${termId}/release`, { visible: true });
  }
  return {
    prefix,
    code: prefix,
    generationId: gen.id,
    terms: gen.terms,
    termId,
    sheet,
    sourceId: source.id,
    students: [`${prefix}-001`, `${prefix}-002`, `${prefix}-003`],
  };
}

export const studentRow = (admin: Session, code: string) =>
  ok(admin, 'GET', `/admin/students?q=${code}`).then(
    (r) => r.data[0] as { id: string; fullName: string },
  );

export async function issueTemp(admin: Session, code: string): Promise<string> {
  clearLimits();
  const row = await studentRow(admin, code);
  return (await ok(admin, 'POST', `/admin/students/${row.id}/reset-password`)).temporaryPassword;
}

/** Signs a student in with a chosen password, as after first sign-in. */
export async function activate(
  browser: Browser,
  admin: Session,
  code: string,
  password = NEW_PASSWORD,
) {
  const temp = await issueTemp(admin, code);
  const s = await apiLogin(browser, code, temp);
  await ok(s, 'POST', '/auth/change-password', { currentPassword: temp, newPassword: password });
  return s;
}

/** Connects a replacement sheet; with `previewed`, also reviews and confirms its preview. */
export async function pendingSheet(
  admin: Session,
  s: Scenario,
  edit?: (x: TestSheet) => void,
  previewed = true,
) {
  const id = sheetId(`B${s.prefix}`);
  writeSheet(id, { ...workbook(s.prefix, edit), title: 'Test Sheet B' });
  const source = await ok(admin, 'POST', `/admin/terms/${s.termId}/sources/change`, {
    url: sheetUrl(id),
    label: 'Test Sheet B',
  });
  if (previewed) {
    const tabs = await detect(admin, source.id);
    for (const tab of tabs) {
      await ok(
        admin,
        'POST',
        `/admin/sources/${source.id}/mappings/${tab.id}/confirm`,
        confirmBody(tab),
      );
    }
    const preview = await ok(admin, 'POST', `/admin/sources/${source.id}/preview`);
    await ok(admin, 'POST', `/admin/sources/${source.id}/preview/${preview.id}/confirm`, {
      acknowledgeRemovals: true,
    });
  }
  return { id, sourceId: source.id as string };
}

export const noJunk = async (page: Page) => {
  const text = await page.locator('main:visible').last().innerText();
  expect(text).not.toMatch(/\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/);
};

export function seedDemo() {
  const res = spawnSync(process.execPath, ['apps/api/dist/cli/seed-demo.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: process.env['TEST_DATABASE_URL'],
      REDIS_URL: process.env['TEST_REDIS_URL'],
    },
    encoding: 'utf8',
  });
  expect(res.status, res.stderr || res.stdout).toBe(0);
}
