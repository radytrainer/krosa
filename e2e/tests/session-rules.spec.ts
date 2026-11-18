/* eslint-disable no-console -- QA evidence: timings and status codes are printed for the report */
import { spawnSync } from 'node:child_process';
import nodePath from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createPrismaClient } from '@ssrs/database';
import { loadRootEnv } from '@ssrs/shared/node';
import { API_URL, E2E, ROOT, WEB_URL, serviceEnv } from '../support/stack.js';
import { testPassword } from '../support/credentials.js';

/**
 * Session rules in the browser (QA): one session per user (Rule A) and the inactivity logout
 * (Rule B), decisions.md SR1-SR5. Saved cookies are also sent straight to the API, so the server,
 * not the browser, is shown to refuse them.
 *
 * Skipped unless the stack runs with short session limits. Run it on its own, from the repo root
 * (PowerShell: set the four variables with `$env:NAME = 'value'` first; build first):
 *
 *   E2E_SESSION_IDLE_TIMEOUT_SECONDS=60 E2E_SESSION_HEARTBEAT_INTERVAL_SECONDS=15 \
 *   E2E_ACCESS_TOKEN_TTL_SECONDS=60 E2E_CHANNEL=msedge \
 *   pnpm --filter @ssrs/e2e exec playwright test session-rules
 *
 * About 8 minutes: the Rule B waits are proportional to the idle limit (2x for the visible tab,
 * limit + 15 s for the others). The data is its own: generation QAS2030 and students QAS-0001..3
 * (made-up IDs and names), created in beforeAll.
 */
const IDLE = Number(process.env['E2E_SESSION_IDLE_TIMEOUT_SECONDS'] ?? 900);
const HEARTBEAT = Number(process.env['E2E_SESSION_HEARTBEAT_INTERVAL_SECONDS'] ?? 300);
test.skip(IDLE > 120, 'needs short session limits: see the header of session-rules.spec.ts');
test.describe.configure({ mode: 'serial' });

const ELSEWHERE =
  'You were signed out because your account was signed in on another browser or device.';
const minutes = Math.round(IDLE / 60);
const IDLE_TEXT = `You were signed out after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} of inactivity.`;

const STUDENTS = ['QAS-0001', 'QAS-0002', 'QAS-0003'].map((id, i) => ({
  id,
  password: testPassword(`qas-student-${i + 1}`),
}));
const [S1, S2, S3] = STUDENTS as [(typeof STUDENTS)[0], (typeof STUDENTS)[0], (typeof STUDENTS)[0]];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- direct API calls with saved cookies ----------

interface Jar {
  at?: string;
  rt?: string;
  csrf?: string;
}
async function jarOf(context: BrowserContext): Promise<Jar> {
  const cookies = await context.cookies();
  const get = (n: string) => cookies.find((c) => c.name === n)?.value;
  return { at: get('ssrs_at'), rt: get('ssrs_rt'), csrf: get('ssrs_csrf') };
}
const cookieHeader = (j: Jar) =>
  [
    j.at ? `ssrs_at=${j.at}` : null,
    j.rt ? `ssrs_rt=${j.rt}` : null,
    j.csrf ? `ssrs_csrf=${j.csrf}` : null,
  ]
    .filter(Boolean)
    .join('; ');

async function call(j: Jar, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: {
      Cookie: cookieHeader(j),
      Origin: WEB_URL,
      ...(j.csrf ? { 'X-CSRF-Token': j.csrf } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let code: string | undefined;
  const setCookie = res.headers.getSetCookie();
  if (res.status !== 200 || !res.headers.get('content-type')?.includes('event-stream')) {
    const text = await res.text();
    try {
      code = JSON.parse(text)?.error?.code;
    } catch {
      code = undefined;
    }
    return { status: res.status, code, setCookie, json: text ? safeJson(text) : null };
  }
  await res.body?.cancel();
  return { status: res.status, code, setCookie, json: null };
}
const safeJson = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
const jarFromSetCookie = (setCookie: string[], prev: Jar = {}): Jar => {
  const val = (n: string) =>
    setCookie
      .find((c) => c.startsWith(`${n}=`))
      ?.split(';')[0]!
      .slice(n.length + 1);
  return {
    at: val('ssrs_at') ?? prev.at,
    rt: val('ssrs_rt') ?? prev.rt,
    csrf: val('ssrs_csrf') ?? prev.csrf,
  };
};

/** Every path with the saved cookies: a normal route, /auth/me, heartbeat, live, refresh. */
async function everyPath(j: Jar, normal: string) {
  const out = {
    normal: await call({ at: j.at, csrf: j.csrf }, 'GET', normal),
    heartbeat: await call(j, 'POST', '/auth/heartbeat'),
    live: await call(j, 'GET', '/auth/live'),
    refresh: await call({ rt: j.rt, csrf: j.csrf }, 'POST', '/auth/refresh'),
  };
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => [k, `${v.status} ${v.code ?? ''}`.trim()]),
  );
}
const expectAll401 = (result: Record<string, string>, code?: string) => {
  for (const [path, value] of Object.entries(result)) {
    expect(value, path).toMatch(code ? new RegExp(`^401 ${code}$`) : /^401/);
  }
};

async function apiLogin(identifier: string, password: string): Promise<Jar> {
  const res = await call({}, 'POST', '/auth/login', { identifier, password });
  if (res.status !== 200) throw new Error(`login ${identifier}: ${res.status} ${res.code}`);
  return jarFromSetCookie(res.setCookie);
}

// ---------- browser helpers ----------

async function signIn(page: Page, identifier: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/Username or student ID/).fill(identifier);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
async function studentPage(
  browser: Browser,
  s = S1,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, s.id, s.password);
  await expect(page).toHaveURL(/\/student$/);
  return { context, page };
}

const isLive = (r: { url(): string }) => new URL(r.url()).pathname === '/api/v1/auth/live';

/** Counts requests by "METHOD /path" in a context, and the most live streams open at once. */
function watch(context: BrowserContext) {
  const counts = new Map<string, number>();
  let openLive = 0;
  let maxLive = 0;
  context.on('request', (r) => {
    const key = `${r.method()} ${new URL(r.url()).pathname}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (isLive(r)) maxLive = Math.max(maxLive, ++openLive);
  });
  const done = (r: { url(): string }) => {
    if (isLive(r)) openLive--;
  };
  context.on('requestfinished', done);
  context.on('requestfailed', done);
  return {
    count: (key: string) => counts.get(key) ?? 0,
    maxLive: () => maxLive,
    reset: () => {
      counts.clear();
      maxLive = openLive;
    },
  };
}

/** Navigations of a page to /login (with their query), with the time since `t0`. */
function loginNavigations(page: Page, t0 = Date.now()) {
  const seen: { url: string; ms: number }[] = [];
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame() && new URL(f.url()).pathname === '/login') {
      seen.push({ url: f.url().replace(WEB_URL, ''), ms: Date.now() - t0 });
    }
  });
  return seen;
}

/**
 * Clears the login rate-limit counters (10 sign-ins per minute per address; every browser here
 * shares 127.0.0.1). Lockout keys are kept. Plain Node process: Playwright's loader cannot load
 * ioredis in-process (see global-setup.ts).
 */
function clearLoginLimits(): void {
  const run = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { Redis } = await import('ioredis'); const r = new Redis(process.env.REDIS_URL); const k = await r.keys('ssrs:v1:rl:*'); if (k.length) await r.del(...k); await r.quit();",
    ],
    { cwd: nodePath.join(ROOT, 'e2e'), env: serviceEnv(), encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`clearing rate limits failed: ${run.stderr}`);
}

// ---------- data ----------

let adminJar: Jar;
let prisma: ReturnType<typeof createPrismaClient>;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  loadRootEnv();
  prisma = createPrismaClient({ connectionString: process.env['TEST_DATABASE_URL']!, poolMax: 1 });
  const generation = await prisma.generation.upsert({
    where: { code: 'QAS2030' },
    update: {},
    create: { code: 'QAS2030', name: 'QA sessions 2030', startDate: new Date('2030-01-01') },
  });
  adminJar = await apiLogin(E2E.adminUser, E2E.adminPassword);
  for (const [i, s] of STUDENTS.entries()) {
    const user = await prisma.user.upsert({
      where: { username: s.id },
      update: {},
      create: { username: s.id, role: 'STUDENT', status: 'PENDING', passwordHash: '!' },
    });
    const student = await prisma.student.upsert({
      where: { studentCode: s.id },
      update: {},
      create: {
        studentCode: s.id,
        userId: user.id,
        generationId: generation.id,
        fullName: `Qa Student${i + 1}`,
      },
    });
    const issued = await call(adminJar, 'POST', `/admin/students/${student.id}/reset-password`);
    expect(issued.status, 'issue password').toBe(200);
    const temp = (issued.json as { temporaryPassword: string }).temporaryPassword;
    const jar = await apiLogin(s.id, temp);
    const changed = await call(jar, 'POST', '/auth/change-password', {
      currentPassword: temp,
      newPassword: s.password,
    });
    expect(changed.status, 'change password').toBe(204);
    await call(jar, 'POST', '/auth/logout');
  }
});

test.beforeEach(() => clearLoginLimits());

test.afterAll(async () => {
  await prisma?.$disconnect();
});

// ---------- Rule A ----------

test('A1 student: browser A is signed out with the message, no click, when browser B signs in', async ({
  browser,
}) => {
  const a = await studentPage(browser);
  const saved = await jarOf(a.context);
  expect((await call(saved, 'GET', '/student/me')).status).toBe(200);
  const auditBefore = await prisma.auditLog.count({ where: { action: 'auth.sessions.replaced' } });

  const b = await browser.newContext();
  const bPage = await b.newPage();
  const t0 = Date.now();
  const navs = loginNavigations(a.page, t0);
  await signIn(bPage, S1.id, S1.password);
  await expect(bPage).toHaveURL(/\/student$/);
  await expect(a.page.getByText(ELSEWHERE)).toBeVisible({ timeout: 10_000 });
  await expect(a.page).toHaveURL(/\/login\?reason=elsewhere$/);
  const shownMs = Date.now() - t0;
  console.log(
    `[A1] A on login after ${shownMs} ms of B's sign-in click; navigations`,
    JSON.stringify(navs),
  );
  expect(shownMs).toBeLessThan(8_000);

  const result = await everyPath(saved, '/student/me');
  console.log('[A1] saved cookies of A:', JSON.stringify(result));
  expectAll401(result, 'SESSION_REPLACED');
  // B still works.
  expect((await call(await jarOf(b), 'GET', '/student/me')).status).toBe(200);
  await expect(bPage).toHaveURL(/\/student$/);

  const rows = await prisma.auditLog.findMany({
    where: { action: 'auth.sessions.replaced' },
    orderBy: { createdAt: 'desc' },
  });
  expect(rows.length - auditBefore, 'one audit row for B').toBe(1);
  expect(rows[0]!.metadata).toEqual({ revokedCount: 1 });
  const text = JSON.stringify(rows[0]);
  for (const v of [saved.at, saved.rt, saved.csrf]) expect(text).not.toContain(v!);
  await a.context.close();
  await b.close();
});

test('A2 admin: browser A is signed out with the message, no click, when browser B signs in', async ({
  browser,
}) => {
  const a = await browser.newContext();
  const aPage = await a.newPage();
  await signIn(aPage, E2E.adminUser, E2E.adminPassword);
  await expect(aPage).toHaveURL(/\/admin$/);
  const saved = await jarOf(a);
  const b = await browser.newContext();
  const bPage = await b.newPage();
  const t0 = Date.now();
  await signIn(bPage, E2E.adminUser, E2E.adminPassword);
  await expect(bPage).toHaveURL(/\/admin$/);
  await expect(aPage.getByText(ELSEWHERE)).toBeVisible({ timeout: 10_000 });
  console.log(`[A2] admin A on login after ${Date.now() - t0} ms`);
  const result = await everyPath(saved, '/admin/generations');
  console.log('[A2] saved cookies of admin A:', JSON.stringify(result));
  expectAll401(result, 'SESSION_REPLACED');
  expect((await call(await jarOf(b), 'GET', '/admin/generations')).status).toBe(200);
  await a.close();
  await b.close();
});

test('A3 two tabs of one browser stay signed in together; signing in again there never says "another browser"', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const tab1 = await context.newPage();
  const tab2 = await context.newPage();
  // Tab 2 shows the sign-in form before tab 1 signs in (so it can sign in again later).
  await tab2.goto('/login');
  await signIn(tab1, S2.id, S2.password);
  await expect(tab1).toHaveURL(/\/student$/);
  const tab3 = await context.newPage();
  await tab3.goto('/student');
  await expect(tab3).toHaveURL(/\/student$/);
  await tab1.waitForTimeout(3_000);
  await expect(tab1).toHaveURL(/\/student$/);
  await expect(tab3).toHaveURL(/\/student$/);

  const navs = [loginNavigations(tab1), loginNavigations(tab3)];
  const first = await jarOf(context);
  // Sign in again in the same browser, from the form tab 2 still shows.
  await tab2.getByLabel(/Username or student ID/).fill(S2.id);
  await tab2.locator('input[name=password]').fill(S2.password);
  await tab2.getByRole('button', { name: 'Sign in' }).click();
  await expect(tab2).toHaveURL(/\/student$/);
  await tab1.waitForTimeout(5_000);
  console.log('[A3] login navigations of tab1/tab3 after re-sign-in', JSON.stringify(navs));
  for (const tab of [tab1, tab2, tab3]) {
    await expect(tab.getByText(ELSEWHERE)).toHaveCount(0);
  }
  expect(navs.flat().filter((n) => n.url.includes('reason=elsewhere'))).toEqual([]);
  // The old session is gone server-side; the browser's current cookies work.
  expect((await call(first, 'GET', '/student/me')).status).toBe(401);
  expect((await call(await jarOf(context), 'GET', '/student/me')).status).toBe(200);
  await tab1.reload();
  await expect(tab1).toHaveURL(/\/student$/);
  await context.close();
});

test('A4 a failed sign-in on B (wrong password, then a locked account) leaves A signed in', async ({
  browser,
}) => {
  const a = await studentPage(browser, S3);
  const navs = loginNavigations(a.page);
  const b = await browser.newContext();
  const bPage = await b.newPage();
  const errors: string[] = [];
  for (let i = 0; i < 6; i++) {
    const res = bPage.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login'));
    await signIn(bPage, S3.id, testPassword(`qas-wrong-${i}`));
    errors.push(String((await res).status()));
  }
  // Now the right password while locked out.
  const res = bPage.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login'));
  await signIn(bPage, S3.id, S3.password);
  const lockedStatus = (await res).status();
  console.log('[A4] wrong:', errors.join(','), 'correct while locked:', lockedStatus);
  expect(errors).toContain('401');
  expect(lockedStatus).toBe(429);
  await expect(bPage).toHaveURL(/\/login/);
  await a.page.waitForTimeout(3_000);
  await expect(a.page).toHaveURL(/\/student$/);
  expect(navs).toEqual([]);
  expect((await call(await jarOf(a.context), 'GET', '/student/me')).status).toBe(200);
  await a.context.close();
  await b.close();
});

test("A5 B signs in while A's token refresh is in flight: A ends signed out, B stays signed in", async ({
  browser,
}) => {
  const a = await studentPage(browser, S1);
  const before = await jarOf(a.context);
  // Make A's next request need a refresh, and hold the refresh until B's sign-in is on its way.
  const keep = (await a.context.cookies()).filter((c) => c.name !== 'ssrs_at');
  await a.context.clearCookies();
  await a.context.addCookies(keep);
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let refreshHeld!: () => void;
  const held = new Promise<void>((r) => (refreshHeld = r));
  let refreshStatus = 0;
  await a.page.route('**/api/v1/auth/refresh', async (route) => {
    refreshHeld();
    await released;
    const response = await route.fetch();
    refreshStatus = response.status();
    await route.fulfill({ response });
  });
  const reload = a.page.reload();
  await held;
  const b = await browser.newContext();
  const bPage = await b.newPage();
  await bPage.goto('/login');
  await bPage.getByLabel(/Username or student ID/).fill(S1.id);
  await bPage.locator('input[name=password]').fill(S1.password);
  const bLogin = bPage.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login'));
  await bPage.getByRole('button', { name: 'Sign in' }).click();
  release(); // A's refresh goes out while B's sign-in is in flight
  expect((await bLogin).status()).toBe(200);
  await reload.catch(() => undefined);
  // A lands on the login page WITH the "another browser" message, not a plain /login?next=.
  await expect(a.page).toHaveURL(/\/login\?reason=elsewhere$/, { timeout: 15_000 });
  await expect(
    a.page.getByText(
      'You were signed out because your account was signed in on another browser or device.',
    ),
  ).toBeVisible();
  console.log('[A5] A refresh status', refreshStatus, 'A url', a.page.url().replace(WEB_URL, ''));
  await expect(bPage).toHaveURL(/\/student$/);
  await bPage.waitForTimeout(3_000);
  await expect(bPage).toHaveURL(/\/student$/);
  // Whatever cookies A holds now (rotated or not) are refused; B's work.
  const now = await jarOf(a.context);
  expect((await call(now, 'GET', '/student/me')).status).toBe(401);
  expect((await call({ rt: now.rt, csrf: now.csrf }, 'POST', '/auth/refresh')).status).toBe(401);
  expect((await call(before, 'GET', '/student/me')).status).toBe(401);
  expect((await call(await jarOf(b), 'GET', '/student/me')).status).toBe(200);
  expect(
    await prisma.authSession.count({
      where: { user: { username: S1.id }, revokedAt: null },
    }),
  ).toBe(1);
  await a.context.close();
  await b.close();
});

test('A6 logout: the saved access and refresh tokens are refused at once on every path', async ({
  browser,
}) => {
  const a = await studentPage(browser, S2);
  const saved = await jarOf(a.context);
  await a.page
    .getByRole('button', { name: /sign out/i })
    .first()
    .click();
  await expect(a.page).toHaveURL(/\/login$/);
  const result = await everyPath(saved, '/student/me');
  console.log('[A6] after logout:', JSON.stringify(result));
  expectAll401(result, 'SESSION_REVOKED');
  await a.context.close();
});

// ---------- live connection limits (direct API, through the web proxy) ----------

test('L1 live: 3 per session, a closed connection frees its slot; ready arrives through the web proxy', async () => {
  const jar = await apiLogin(S2.id, S2.password);
  const open: AbortController[] = [];
  const statuses: number[] = [];
  const openOne = async () => {
    const controller = new AbortController();
    const res = await fetch(`${WEB_URL}/api/v1/auth/live`, {
      headers: { Cookie: cookieHeader(jar), 'X-CSRF-Token': jar.csrf! },
      signal: controller.signal,
    });
    statuses.push(res.status);
    if (res.status !== 200) {
      const body = (await res.json()) as { error: { code: string } };
      return { res, code: body.error.code, controller };
    }
    open.push(controller);
    return { res, code: undefined, controller };
  };
  const first = await openOne();
  const t0 = Date.now();
  const reader = first.res.body!.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  console.log(
    `[L1] first chunk through :${E2E.webPort} after ${Date.now() - t0} ms:`,
    JSON.stringify(chunk),
  );
  expect(chunk).toContain('event: ready');
  await openOne();
  await openOne();
  const extra = await openOne();
  expect(extra.res.status).toBe(429);
  expect(extra.code).toBe('TOO_MANY_LIVE_CONNECTIONS');
  open[0]!.abort();
  let again = 0;
  for (let i = 0; i < 40 && again !== 200; i++) {
    await sleep(100);
    const r = await openOne();
    again = r.res.status;
  }
  console.log('[L1] statuses', statuses.join(','));
  expect(again).toBe(200);
  for (const c of open) c.abort();
  await call(jar, 'POST', '/auth/logout');
});

// ---------- Rule B ----------

test('B1 visible tabs: 2x the idle limit with no clicks stays signed in; two tabs send no more heartbeats and keep one live connection', async ({
  browser,
}) => {
  test.setTimeout((2 * IDLE + 90) * 1000);
  const one = await browser.newContext();
  const two = await browser.newContext();
  const w1 = watch(one);
  const w2 = watch(two);
  const p1 = await one.newPage();
  await signIn(p1, S1.id, S1.password);
  await expect(p1).toHaveURL(/\/student$/);
  const q1 = await two.newPage();
  await signIn(q1, S2.id, S2.password);
  await expect(q1).toHaveURL(/\/student$/);
  const q2 = await two.newPage();
  await q2.goto('/student');
  await expect(q2).toHaveURL(/\/student$/);
  const vis = await Promise.all([p1, q1, q2].map((p) => p.evaluate('document.visibilityState')));
  expect(vis).toEqual(['visible', 'visible', 'visible']);
  w1.reset();
  w2.reset();
  const windowMs = (2 * IDLE + 10) * 1000;
  await sleep(windowMs);
  const hb1 = w1.count('POST /api/v1/auth/heartbeat');
  const hb2 = w2.count('POST /api/v1/auth/heartbeat');
  console.log(
    `[B1] window ${windowMs / 1000}s heartbeats one-tab=${hb1} two-tabs=${hb2};`,
    `live requests one-tab=${w1.count('GET /api/v1/auth/live')} two-tabs=${w2.count('GET /api/v1/auth/live')};`,
    `max live open at once one-tab=${w1.maxLive()} two-tabs=${w2.maxLive()}`,
  );
  const maxForOne = Math.floor(windowMs / 1000 / HEARTBEAT) + 1;
  expect(hb1).toBeGreaterThanOrEqual(2);
  expect(hb2).toBeLessThanOrEqual(maxForOne);
  expect(hb2).toBeLessThanOrEqual(hb1 + 1);
  expect(w2.maxLive(), 'one live connection for the browser').toBe(1);
  // Still signed in: the pages, and the browsers' current cookies at the API.
  for (const p of [p1, q1, q2]) await expect(p).toHaveURL(/\/student$/);
  expect((await call(await jarOf(one), 'GET', '/student/me')).status).toBe(200);
  expect((await call(await jarOf(two), 'GET', '/student/me')).status).toBe(200);
  await q2.reload();
  await expect(q2).toHaveURL(/\/student$/);
  await one.close();
  await two.close();
});

test('B2 all tabs closed past the limit: the next visit shows the login page with the inactivity message', async ({
  browser,
}) => {
  test.setTimeout((IDLE + 90) * 1000);
  const a = await studentPage(browser, S1);
  await a.page.waitForTimeout(1_000);
  const state = await a.context.storageState();
  const saved = await jarOf(a.context);
  await a.context.close();
  await sleep((IDLE + 15) * 1000);
  const next = await browser.newContext({ storageState: state });
  const page = await next.newPage();
  await page.goto('/student');
  await expect(page.getByText(IDLE_TEXT)).toBeVisible();
  await expect(page).toHaveURL(/\/login\?reason=idle$/);
  console.log('[B2] message:', IDLE_TEXT, 'url', page.url().replace(WEB_URL, ''));
  const result = await everyPath(saved, '/student/me');
  console.log('[B2] saved cookies:', JSON.stringify(result));
  expectAll401(result);
  await next.close();
});

test('B3 the only tab hidden past the limit: no heartbeat while hidden, and coming back shows the login page', async ({
  browser,
}) => {
  test.setTimeout((IDLE + 90) * 1000);
  const a = await studentPage(browser, S2);
  const saved = await jarOf(a.context);
  const w = watch(a.context);
  const t0 = Date.now();
  const navs = loginNavigations(a.page, t0);
  await a.page.evaluate(`(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
  w.reset();
  await sleep((IDLE + 15) * 1000);
  const hidden = w.count('POST /api/v1/auth/heartbeat');
  // Come back: visible again (a no-op if the tab already left for the login page).
  await a.page
    .evaluate(
      `(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  })()`,
    )
    .catch(() => undefined);
  await expect(a.page.getByText(IDLE_TEXT)).toBeVisible();
  await expect(a.page).toHaveURL(/\/login\?reason=idle$/);
  console.log(`[B3] heartbeats while hidden=${hidden}; login navigations`, JSON.stringify(navs));
  // Heartbeats sent while hidden before the session ended (any after the sign-out are irrelevant).
  expect(hidden).toBe(0);
  const result = await everyPath(saved, '/student/me');
  console.log('[B3] saved cookies:', JSON.stringify(result));
  expectAll401(result);
  await a.context.close();
});

test('B4 laptop sleep (clock paused, offline) past the limit: on wake the tab is signed out with the message', async ({
  browser,
}) => {
  test.setTimeout((IDLE + 90) * 1000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.clock.install();
  await signIn(page, S1.id, S1.password);
  await expect(page).toHaveURL(/\/student$/);
  await page.waitForTimeout(2_000);
  const saved = await jarOf(context);
  const sleepStart = Date.now();
  const navs = loginNavigations(page, sleepStart);
  await page.clock.pauseAt(new Date(Date.now() + 500));
  await context.setOffline(true);
  const sleepMs = (IDLE + 15) * 1000;
  await sleep(sleepMs);
  const navsDuringSleep = navs.length;
  // Wake: network back, wall clock jumps, timers run again.
  await context.setOffline(false);
  await page.clock.fastForward(sleepMs);
  await page.clock.resume();
  await expect(page.getByText(IDLE_TEXT)).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/login\?reason=idle$/);
  console.log(
    `[B4] navigations during sleep=${navsDuringSleep}; after wake`,
    JSON.stringify(navs),
    `(ms from sleep start; wake at ${sleepMs})`,
  );
  const result = await everyPath(saved, '/student/me');
  console.log('[B4] saved cookies:', JSON.stringify(result));
  expectAll401(result);
  await context.close();
});
