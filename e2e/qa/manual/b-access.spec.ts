import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../../support/stack.js';
import {
  activate,
  apiLogin,
  asAdmin,
  asDemo,
  call,
  clearLimits,
  connect,
  DEMO_PASSWORD,
  dropAccessCookie,
  issueTemp,
  nav,
  newGeneration,
  NEW_PASSWORD,
  noJunk,
  ok,
  remark,
  sheetId,
  sheetUrl,
  sql,
  studentRow,
  synced,
  uiLogin,
  unique,
  workbook,
  writeSheet,
} from './support.js';

const WRONG = 'The username / student ID or password is incorrect.';
const LOCKED = 'Too many sign-in attempts. Please wait a moment and try again.';
const password = (p: Page) => p.locator('input[name=password]');
const id = (p: Page) => p.getByLabel(/Username or student ID/);
const signInBtn = (p: Page) => p.getByRole('button', { name: 'Sign in' });

async function wrongLogin(p: Page, user: string, pw = 'wrong-password-1') {
  await id(p).fill(user);
  await password(p).fill(pw);
  await signInBtn(p).click();
}

async function forcedPage(page: Page, code: string, temp: string) {
  await uiLogin(page, code, temp);
  await expect(page).toHaveURL(/\/change-password$/);
}

async function forcedFill(page: Page, current: string, next: string, confirm = next) {
  await page.locator('input[name=currentPassword]').fill(current);
  await page.locator('input[name=newPassword]').fill(next);
  await page.locator('input[name=confirm]').fill(confirm);
  await page.getByRole('button', { name: 'Save and continue' }).click();
}

async function profileFill(page: Page, current: string, next: string, confirm = next) {
  await page.locator('input[name=currentPassword]').fill(current);
  await page.locator('input[name=newPassword]').fill(next);
  await page.locator('input[name=confirm]').fill(confirm);
  await page.getByRole('button', { name: 'Change password' }).click();
}

test.beforeEach(() => clearLimits());

test.describe('Login', () => {
  test('TC-001 Login with correct data', async ({ page }) => {
    await uiLogin(page, E2E.adminUser, E2E.adminPassword);
    await expect(page).toHaveURL(/\/admin$/);
  });

  test('TC-002 Admin signs in with username', async ({ page }) => {
    await uiLogin(page, E2E.adminUser, E2E.adminPassword);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    for (const item of ['Dashboard', 'Generations', 'Students', 'Sync center', 'Audit log']) {
      await expect(nav(page, item)).toBeVisible();
    }
    await expect(page.getByRole('link', { name: 'Account', exact: true })).toBeVisible();
  });

  test('TC-003 Student signs in with student ID', async ({ page }) => {
    await uiLogin(page, 'GEN26-0001', DEMO_PASSWORD);
    await expect(page.getByRole('heading', { name: /Hello, Sokha/ })).toBeVisible();
    for (const item of ['Overview', 'My results']) await expect(nav(page, item)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
  });

  test('TC-004 Username is not case sensitive and spaces are trimmed', async ({ page }) => {
    await uiLogin(page, `  ${E2E.adminUser.toUpperCase()}  `, E2E.adminPassword);
    await expect(page).toHaveURL(/\/admin$/);
  });

  test('TC-005 Failed attempts reset after a correct sign-in', async ({ page }) => {
    await page.goto('/login');
    for (let i = 0; i < 3; i++) {
      await wrongLogin(page, 'GEN26-0002');
      await expect(page.getByText(WRONG)).toBeVisible();
    }
    await uiLogin(page, 'GEN26-0002', DEMO_PASSWORD);
    await expect(page).toHaveURL(/\/student$/);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await wrongLogin(page, 'GEN26-0002');
    await expect(page.getByText(WRONG)).toBeVisible();
  });

  test('TC-006 Wrong password', async ({ page }) => {
    await page.goto('/login');
    await wrongLogin(page, 'GEN26-0001');
    await expect(page.getByText(WRONG)).toBeVisible();
    await expect(password(page)).toHaveValue('');
    await expect(page).toHaveURL(/\/login/);
  });

  test('TC-007 Unknown username or student ID', async ({ page }) => {
    await page.goto('/login');
    await wrongLogin(page, `NOBODY-${unique()}`);
    await expect(page.getByText(WRONG)).toBeVisible();
  });

  test('TC-008 Empty fields', async ({ page }) => {
    await page.goto('/login');
    let posts = 0;
    page.on('request', (r) => {
      if (r.url().includes('/auth/login')) posts++;
    });
    await signInBtn(page).click();
    expect(await id(page).evaluate((e: HTMLInputElement) => e.validity.valueMissing)).toBe(true);
    await id(page).fill('GEN26-0001');
    await signInBtn(page).click();
    expect(await password(page).evaluate((e: HTMLInputElement) => e.validity.valueMissing)).toBe(
      true,
    );
    await page.waitForTimeout(300);
    expect(posts).toBe(0);
    await expect(page).toHaveURL(/\/login/);
  });

  test('TC-009 Lockout after 5 wrong passwords', async ({ page }) => {
    test.setTimeout(120_000);
    const code = 'GEN26-0002';
    await page.goto('/login');
    for (let i = 0; i < 5; i++) {
      await wrongLogin(page, code);
      await page.waitForTimeout(250);
    }
    await wrongLogin(page, code, DEMO_PASSWORD);
    await expect(page.getByText(LOCKED)).toBeVisible();
    await page.waitForTimeout(61_000);
    await uiLogin(page, code, DEMO_PASSWORD);
    await expect(page).toHaveURL(/\/student$/);
    remark('Waited 1 minute in real time');
  });

  test('TC-010 Lockout message is the same for a made-up ID', async ({ page }) => {
    await page.goto('/login');
    const ghost = `GHOST-${unique()}`;
    for (let i = 0; i < 6; i++) {
      await wrongLogin(page, ghost);
      await page.waitForTimeout(250);
    }
    await expect(page.getByText(LOCKED)).toBeVisible();
  });

  test('TC-011 Disabled account', async ({ page, browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const code = s.students[0];
    await activate(browser, admin, code);
    const row = await studentRow(admin, code);
    await ok(admin, 'PATCH', `/admin/students/${row.id}/status`, { status: 'DISABLED' });
    await uiLogin(page, code, NEW_PASSWORD);
    await expect(page.getByText('This account is disabled. Contact the registrar.')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('TC-012 Pending account has no usable password', async ({ page }) => {
    await uiLogin(page, 'GEN26-0003', 'any-password-here');
    await expect(page.getByText(WRONG)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('TC-013 Expired temporary password', async ({ page, browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const temp = await issueTemp(admin, s.students[0]);
    sql(
      `update users set password_expires_at = now() - interval '1 day' where username = '${s.students[0]}'`,
    );
    await uiLogin(page, s.students[0], temp);
    await expect(
      page.getByText('Your temporary password has expired. Ask the registrar to issue a new one.'),
    ).toBeVisible();
    remark('Expiry set in the past on the test database, as the case allows');
  });

  test('TC-014 SQL and script text in the fields', async ({ page }) => {
    let alerted = false;
    page.on('dialog', async (d) => {
      alerted = true;
      await d.dismiss();
    });
    let serverError = false;
    page.on('response', (r) => {
      if (r.status() >= 500) serverError = true;
    });
    await page.goto('/login');
    await wrongLogin(page, "' OR 1=1 --");
    await expect(page.getByText(WRONG)).toBeVisible();
    await wrongLogin(page, '<script>alert(1)</script>');
    await expect(page.getByText(WRONG)).toBeVisible();
    expect(alerted).toBe(false);
    expect(serverError).toBe(false);
  });

  test('TC-015 Sign-in page layout and field limits', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('Username or student ID')).toBeVisible();
    await expect(page.locator('label', { hasText: 'Password' })).toBeVisible();
    await expect(id(page)).toHaveJSProperty('required', true);
    await expect(password(page)).toHaveJSProperty('required', true);
    await expect(id(page)).toBeFocused();
    await id(page).pressSequentially('x'.repeat(70));
    expect((await id(page).inputValue()).length).toBe(64);
    await password(page).click();
    await password(page).fill('');
    await password(page).pressSequentially('y'.repeat(135));
    expect((await password(page).inputValue()).length).toBe(128);
    await expect(password(page)).toHaveAttribute('type', 'password');
  });

  test('TC-016 Keyboard-only sign-in', async ({ page }) => {
    await page.goto('/login');
    await expect(id(page)).toBeFocused();
    await page.keyboard.type('GEN26-0001');
    await page.keyboard.press('Tab');
    await expect(password(page)).toBeFocused();
    const outline = await password(page).evaluate((e) => {
      const s = getComputedStyle(e);
      return `${s.outlineStyle}/${s.outlineWidth}/${s.boxShadow}`;
    });
    expect(outline).not.toBe('none/0px/none');
    await page.keyboard.type(DEMO_PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/student$/);
  });
});

test.describe('Forced Password Change', () => {
  test('TC-017 Student changes the temporary password at first sign-in', async ({
    page,
    browser,
  }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const temp = await issueTemp(admin, s.students[0]);
    await forcedPage(page, s.students[0], temp);
    await forcedFill(page, temp, NEW_PASSWORD);
    await expect(page.getByText('Password changed.').first()).toBeVisible();
    await expect(page).toHaveURL(/\/student$/);
    clearLimits();
    const other = await browser.newPage();
    await uiLogin(other, s.students[0], temp);
    await expect(other.getByText(WRONG)).toBeVisible();
    await uiLogin(other, s.students[0], NEW_PASSWORD);
    await expect(other).toHaveURL(/\/student$/);
  });

  test('TC-018 Sign out instead of changing the password', async ({ page, browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const temp = await issueTemp(admin, s.students[0]);
    await forcedPage(page, s.students[0], temp);
    await page.getByRole('button', { name: /Sign out/ }).click();
    await expect(page).toHaveURL(/\/login/);
    await forcedPage(page, s.students[0], temp);
  });

  test('TC-019 Other pages are blocked until the password is changed', async ({
    page,
    browser,
  }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const temp = await issueTemp(admin, s.students[0]);
    await forcedPage(page, s.students[0], temp);
    for (const path of ['/student/results', '/student/profile']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/change-password$/);
    }
    await page.goBack();
    await expect(page).toHaveURL(/\/change-password$/);
    await expect(page.getByText('78.90')).toHaveCount(0);
  });

  test('TC-020 New passwords do not match', async ({ page, browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const temp = await issueTemp(admin, s.students[0]);
    await forcedPage(page, s.students[0], temp);
    await forcedFill(page, temp, NEW_PASSWORD, 'Different-Value-Here-11');
    await expect(page.getByText('The passwords do not match.')).toBeVisible();
    clearLimits();
    const other = await browser.newPage();
    await uiLogin(other, s.students[0], temp);
    await expect(other).toHaveURL(/\/change-password$/);
  });

  test('TC-021 Wrong temporary password', async ({ page, browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const temp = await issueTemp(admin, s.students[0]);
    await forcedPage(page, s.students[0], temp);
    await forcedFill(page, 'not-the-temp-password', NEW_PASSWORD);
    await expect(page.getByText('This is not your current password.')).toBeVisible();
  });

  test('TC-022 Forced change screen explains what to do', async ({ page, browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const temp = await issueTemp(admin, s.students[0]);
    await forcedPage(page, s.students[0], temp);
    await expect(page.getByText(/Signed in as/)).toBeVisible();
    await expect(page.getByText(s.students[0]).first()).toBeVisible();
    await expect(page.getByText(/temporary password/i).first()).toBeVisible();
    await expect(page.getByText(/10.128 characters/)).toBeVisible();
  });
});

test.describe('Change Password', () => {
  async function student(browser: Parameters<typeof asAdmin>[0]) {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const session = await activate(browser, admin, s.students[0]);
    await session.page.goto('/student/profile');
    await expect(session.page.getByRole('button', { name: 'Change password' })).toBeVisible();
    return { ...session, code: s.students[0], admin };
  }

  test('TC-023 Student changes password from Profile', async ({ browser }) => {
    const u = await student(browser);
    const next = 'Another-Long-Phrase-2026';
    await profileFill(u.page, NEW_PASSWORD, next);
    await expect(u.page.getByText('Password changed.').first()).toBeVisible();
    await expect(u.page).toHaveURL(/\/student\/profile$/);
    clearLimits();
    const other = await browser.newPage();
    await uiLogin(other, u.code, NEW_PASSWORD);
    await expect(other.getByText(WRONG)).toBeVisible();
  });

  test('TC-024 Admin changes password from Account', async ({ browser }) => {
    const username = `qa${unique().toLowerCase()}`;
    const { spawnSync } = await import('node:child_process');
    const { ROOT } = await import('../../support/stack.js');
    const made = spawnSync(
      process.execPath,
      ['apps/api/dist/cli/create-admin.js', '--username', username, '--display-name', 'QA Two'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: process.env['TEST_DATABASE_URL'],
          REDIS_URL: process.env['TEST_REDIS_URL'],
        },
        input: 'Second-Admin-Pass-2026',
        encoding: 'utf8',
      },
    );
    expect(made.status, made.stderr).toBe(0);
    const second = await apiLogin(browser, username, 'Second-Admin-Pass-2026');
    await second.page.goto('/admin/account');
    await profileFill(second.page, 'Second-Admin-Pass-2026', 'Second-Admin-Pass-2027');
    await expect(
      second.page.getByText('Password changed. Other sessions were signed out.').first(),
    ).toBeVisible();
    remark('Used a second QA admin, so the main test admin keeps its password');
  });

  test('TC-025 Other devices are signed out', async ({ browser }) => {
    const u = await student(browser);
    const two = await apiLogin(browser, u.code, NEW_PASSWORD);
    await two.page.goto('/student/results');
    await expect(two.page).toHaveURL(/\/student\/results$/);
    await profileFill(u.page, NEW_PASSWORD, 'Another-Long-Phrase-2026');
    await expect(u.page.getByText('Password changed.').first()).toBeVisible();
    await two.page.goto('/student/results');
    await expect(two.page).toHaveURL(/\/login/);
    await u.page.goto('/student/results');
    await expect(u.page).toHaveURL(/\/student\/results$/);
  });

  test('TC-026 Boundary: 10 and 128 character passwords', async ({ browser }) => {
    const u = await student(browser);
    const ten = 'Kv7-pLm2Qz';
    await profileFill(u.page, NEW_PASSWORD, ten);
    await expect(u.page.getByText('Password changed.').first()).toBeVisible();
    await u.page.reload();
    const long = 'Rt5-'.repeat(32);
    expect(long.length).toBe(128);
    clearLimits();
    await profileFill(u.page, ten, long);
    await expect(u.page.getByText('Password changed.').first()).toBeVisible();
    await ok(u, 'GET', '/auth/me');
  });

  test('TC-027 Password of 9 characters', async ({ browser }) => {
    const u = await student(browser);
    await profileFill(u.page, NEW_PASSWORD, 'Kv7-pLm2Q');
    await expect(u.page.getByText(/at least 10|10.*characters|minimum/i).first()).toBeVisible();
    clearLimits();
    await apiLogin(browser, u.code, NEW_PASSWORD);
  });

  test('TC-028 Password contains the username or student ID', async ({ browser }) => {
    const u = await student(browser);
    await profileFill(u.page, NEW_PASSWORD, `x-${u.code}-pass`);
    await expect(
      u.page.getByText('Password must not contain your username or student ID.'),
    ).toBeVisible();
  });

  test('TC-029 Common password', async ({ browser }) => {
    const u = await student(browser);
    const message = 'This password is too common. Choose something less predictable.';
    await profileFill(u.page, NEW_PASSWORD, 'password123');
    await expect(u.page.getByText(message)).toBeVisible();
    await profileFill(u.page, NEW_PASSWORD, 'PASSWORD123');
    await expect(u.page.getByText(message)).toBeVisible();
  });

  test('TC-030 Single repeated character', async ({ browser }) => {
    const u = await student(browser);
    await profileFill(u.page, NEW_PASSWORD, 'aaaaaaaaaaaa');
    await expect(
      u.page.getByText('Password must not be a single repeated character.'),
    ).toBeVisible();
  });

  test('TC-031 Wrong current password', async ({ browser }) => {
    const u = await student(browser);
    await profileFill(u.page, 'not-my-password-1', 'Another-Long-Phrase-2026');
    await expect(u.page.getByText('This is not your current password.')).toBeVisible();
  });

  test('TC-032 Password rule hint', async ({ browser }) => {
    const u = await student(browser);
    const hint = u.page.getByText(/10.128 characters/);
    await expect(hint).toContainText(/username or student ID/);
    await expect(hint).toContainText(/common/);
    expect(await hint.innerText()).not.toMatch(/capital|uppercase|symbol/i);
    await profileFill(u.page, NEW_PASSWORD, 'lowercase words only here');
    await expect(u.page.getByText('Password changed.').first()).toBeVisible();
  });
});

test.describe('Session and Access', () => {
  test('TC-033 Sign out', async ({ page }) => {
    await uiLogin(page, 'GEN26-0002', DEMO_PASSWORD);
    await expect(page).toHaveURL(/\/student$/);
    await page.goto('/student/results');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.waitForLoadState('networkidle');
    await page.goBack();
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(/\/login/);
    expect(await page.locator('body').innerText()).not.toMatch(/Dara Pich|Hello/);
  });

  test('TC-034 Session continues after 15 idle minutes', async ({ browser }) => {
    const u = await asDemo(browser);
    await u.page.goto('/student');
    await dropAccessCookie(u.context);
    await u.page.reload();
    await expect(u.page.getByRole('heading', { name: /Hello, Sokha/ })).toBeVisible();
    await expect(u.page).toHaveURL(/\/student$/);
    remark('16 idle minutes simulated by removing the expired access cookie, as the browser does');
  });

  test('TC-035 Two tabs stay signed in', async ({ browser }) => {
    const u = await asDemo(browser);
    const a = u.page;
    const b = await u.context.newPage();
    await a.goto('/student');
    await b.goto('/student/results');
    await dropAccessCookie(u.context);
    await Promise.all([a.reload(), b.reload()]);
    await a.waitForTimeout(1500);
    await expect(a).toHaveURL(/\/student$/);
    await expect(b).toHaveURL(/\/student\/results$/);
    const c = await u.context.newPage();
    await c.goto('/student');
    await expect(c.getByRole('heading', { name: /Hello, Sokha/ })).toBeVisible();
    remark('16 idle minutes simulated by removing the expired access cookie');
  });

  test('TC-036 Signed-out user opens a protected page', async ({ page }) => {
    for (const path of ['/admin', '/student/results']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('TC-037 Student opens an admin page', async ({ browser }) => {
    const u = await asDemo(browser);
    for (const path of ['/admin', '/admin/students', '/admin/audit']) {
      await u.page.goto(path);
      await expect(u.page, path).toHaveURL(/\/student/);
    }
    expect((await call(u, 'GET', '/admin/students')).status()).toBe(403);
  });

  test('TC-038 Admin opens a student page', async ({ browser }) => {
    const admin = await asAdmin(browser);
    await admin.page.goto('/student/results');
    await expect(admin.page).toHaveURL(/\/admin/);
  });

  test('TC-039 Student opens another student course', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const a = await activate(browser, admin, s.students[2]);
    const b = await activate(browser, admin, s.students[0]);
    const courses = await ok(b, 'GET', '/student/me/courses');
    const eng = courses.find((c: { title: string }) => c.title === 'ENG');
    await a.page.goto(`/student/courses/${eng.offeringId}`);
    await expect(a.page.getByText(/Not found|Could not load/).first()).toBeVisible();
    await expect(a.page.getByText('80.00')).toHaveCount(0);
  });

  test('TC-040 Sign-in page rejects an outside redirect', async ({ page }) => {
    await page.goto('/login?next=//example.com');
    await page.getByLabel(/Username or student ID/).fill('GEN26-0001');
    await password(page).fill(DEMO_PASSWORD);
    await signInBtn(page).click();
    await expect(page).toHaveURL(/localhost:\d+\/student$/);
  });

  test('TC-041 Signed-in user opens the Sign in page', async ({ browser }) => {
    const u = await asDemo(browser);
    await u.page.goto('/login');
    await expect(u.page).toHaveURL(/\/student$/);
  });
});

test.describe('Dashboard', () => {
  test('TC-042 Dashboard shows current counts', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const data = await ok(admin, 'GET', '/admin/dashboard');
    const students = await ok(admin, 'GET', '/admin/students?pageSize=1');
    expect(data.students.total).toBe(students.meta.total);
    await admin.page.goto('/admin');
    const main = admin.page.locator('main:visible').last();
    await expect(main).toContainText(String(data.students.total));
    await expect(main).toContainText(/Failed syncs/i);
    await expect(main).toContainText(/Recent synchronizations/i);
    await main.getByRole('link').first().click();
    await expect(admin.page).not.toHaveURL(/\/admin$/);
  });

  test('TC-043 Failed sync appears on Dashboard', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const { editSheet, syncNow } = await import('./support.js');
    editSheet(s.sheet, (x) => (x.fail = 'SHEET_NOT_SHARED'));
    await syncNow(admin, s.sourceId);
    const before = await ok(admin, 'GET', '/admin/dashboard');
    expect(before.jobs.failedRecently).toBeGreaterThan(0);
    await admin.page.goto('/admin');
    const main = admin.page.locator('main:visible').last();
    await expect(main).toContainText(String(before.jobs.failedRecently));
    await expect(main.getByText(/Failed/).first()).toBeVisible();
    await expect(main).toContainText(`Generation ${s.code}`);
  });
});

test.describe('Generation', () => {
  const openNew = async (page: Page) => {
    await page.goto('/admin/generations');
    await page.getByRole('button', { name: 'New generation' }).click();
    return page.getByRole('dialog');
  };

  test('TC-045 Create a generation', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const d = await openNew(admin.page);
    await d.getByLabel(/Code/).fill('GEN2099');
    await d.getByLabel(/^Name/).fill('Generation 2099');
    await d.getByLabel(/Start date/).fill('2099-01-05');
    await d.getByRole('button', { name: 'Create generation' }).click();
    await expect(admin.page.getByText('Generation GEN2099 created with five terms.')).toBeVisible();
    await expect(admin.page.getByRole('row')).toHaveCount(6);
  });

  test('TC-046 Edit a generation', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    await admin.page.goto(`/admin/generations/${g.id}`);
    await admin.page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const d = admin.page.getByRole('dialog');
    expect(await d.getByLabel(/Code/).count()).toBe(0);
    await d.getByLabel(/^Name/).fill('Renamed generation');
    await d.getByLabel(/End date/).fill('2031-06-30');
    await d.getByRole('button', { name: 'Save changes' }).click();
    await expect(admin.page.getByText('Generation updated.')).toBeVisible();
    await expect(admin.page.getByRole('heading', { name: /Renamed generation/ })).toBeVisible();
    await expect(admin.page.locator('main:visible').last()).toContainText(/2031/);
  });

  test('TC-047 Search and filter generations', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const a = await newGeneration(admin);
    const b = await newGeneration(admin);
    await ok(admin, 'POST', `/admin/generations/${b.id}/archive`);
    const page = admin.page;
    await page.goto('/admin/generations');
    const search = page.getByLabel('Search generations');
    await search.fill(a.code.slice(0, 6));
    await expect(page.getByRole('link', { name: a.code })).toBeVisible();
    await search.fill(`Generation ${a.code}`);
    await expect(page.getByRole('link', { name: a.code })).toBeVisible();
    await search.fill('');
    await page.getByLabel('Status').selectOption({ label: 'Archived' });
    await expect(page.getByRole('link', { name: b.code })).toBeVisible();
    await expect(page.getByRole('link', { name: a.code })).toHaveCount(0);
    await page.getByLabel('Status').selectOption({ label: 'Active' });
    await expect(page.getByRole('link', { name: b.code })).toHaveCount(0);
  });

  test('TC-048 Archive and activate', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const page = admin.page;
    await page.goto(`/admin/generations/${g.id}`);
    await page.getByRole('button', { name: 'Archive' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archive generation' }).click();
    await expect(page.getByText(/This generation is archived/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit', exact: true }).first()).toBeDisabled();
    await page.getByRole('button', { name: 'Activate' }).click();
    const confirm = page.getByRole('alertdialog').getByRole('button', { name: /Activate/ });
    if (await confirm.count()) await confirm.click();
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit', exact: true }).first()).toBeEnabled();
  });

  test('TC-049 Duplicate code', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const d = await openNew(admin.page);
    await d.getByLabel(/Code/).fill(g.code);
    await d.getByLabel(/^Name/).fill('Duplicate');
    await d.getByLabel(/Start date/).fill('2030-01-07');
    await d.getByRole('button', { name: 'Create generation' }).click();
    await expect(admin.page.getByText('This code is already used.')).toBeVisible();
    const list = await ok(admin, 'GET', `/admin/generations?q=${g.code}`);
    expect(list.meta.total).toBe(1);
  });

  test('TC-050 Invalid code', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const before = (await ok(admin, 'GET', '/admin/generations')).meta.total;
    const d = await openNew(admin.page);
    await d.getByLabel(/^Name/).fill('Bad code');
    await d.getByLabel(/Start date/).fill('2030-01-07');
    for (const code of ['BAD CODE', 'BAD#CODE', 'X']) {
      await d.getByLabel(/Code/).fill(code);
      await d.getByRole('button', { name: 'Create generation' }).click();
      await expect(d).toBeVisible();
      await admin.page.waitForTimeout(200);
    }
    expect((await ok(admin, 'GET', '/admin/generations')).meta.total).toBe(before);
  });

  test('TC-051 End date before start date', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const d = await openNew(admin.page);
    await d.getByLabel(/Code/).fill(unique());
    await d.getByLabel(/^Name/).fill('Dates');
    await d.getByLabel(/Start date/).fill('2030-06-01');
    await d.getByLabel(/End date/).fill('2030-01-01');
    await d.getByRole('button', { name: 'Create generation' }).click();
    await expect(admin.page.getByText('Must be on or after the start date.')).toBeVisible();
  });

  test('TC-052 Required fields empty', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const d = await openNew(admin.page);
    await d.getByRole('button', { name: 'Create generation' }).click();
    const missing = await d
      .getByLabel(/Code/)
      .evaluate((e: HTMLInputElement) => e.validity.valueMissing);
    expect(missing).toBe(true);
    await expect(d).toBeVisible();
  });

  test('TC-053 Archived generation is read-only', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin, { release: false });
    await ok(admin, 'POST', `/admin/generations/${s.generationId}/archive`);
    const page = admin.page;
    await page.goto(`/admin/generations/${s.generationId}`);
    await expect(page.getByText(/This generation is archived/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit', exact: true }).first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Sync all workbooks' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Connect workbook' }).first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Release scores' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Edit Term 1' })).toBeDisabled();
  });

  test('TC-054 Archived generation keeps student access', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const u = await activate(browser, admin, s.students[0]);
    await ok(admin, 'POST', `/admin/generations/${s.generationId}/archive`);
    await u.page.goto('/student/results');
    await expect(u.page.getByRole('button', { name: /Logic/ })).toContainText('78.90');
  });

  test('TC-055 Generation has no delete option', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    await admin.page.goto(`/admin/generations/${g.id}`);
    await expect(admin.page.getByRole('button', { name: 'Archive' })).toBeVisible();
    await expect(admin.page.getByRole('button', { name: /Delete/ })).toHaveCount(0);
  });

  test('TC-056 Empty search result', async ({ browser }) => {
    const admin = await asAdmin(browser);
    await admin.page.goto('/admin/generations');
    await admin.page.getByLabel('Search generations').fill('matches-nothing-here');
    await expect(admin.page.getByText('No generations match')).toBeVisible();
    await expect(admin.page.getByText('Try a different search or status.')).toBeVisible();
  });
});

test.describe('Term', () => {
  const editTerm = async (page: Page, id_: string) => {
    await page.goto(`/admin/generations/${id_}`);
    await page.getByRole('button', { name: 'Edit Term 1' }).click();
    return page.getByRole('dialog');
  };

  test('TC-057 Edit term name and dates', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const d = await editTerm(admin.page, g.id);
    await d.getByLabel(/^Name/).fill('Autumn term');
    await d.getByLabel(/Start date/).fill('2026-11-02');
    await d.getByLabel(/End date/).fill('2027-02-26');
    await d.getByRole('button', { name: 'Save term' }).click();
    await expect(admin.page.getByText(/Term.*(updated|saved)/i).first()).toBeVisible();
    const table = admin.page.getByRole('table');
    await expect(table).toContainText('Autumn term');
    await expect(table).toContainText(/2026/);
  });

  test('TC-058 Edit term shows the sheet URL', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const d = await editTerm(admin.page, s.generationId);
    await expect(d).toContainText('Test Sheet A');
    await expect(d).toContainText(/Last sync/);
    const link = d.getByRole('link', { name: new RegExp(s.sheet) });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(d.getByRole('button', { name: 'Replace' })).toBeVisible();
    await expect(d.getByRole('button', { name: 'Remove' })).toBeVisible();
  });

  test('TC-059 Term end date before start date', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const d = await editTerm(admin.page, g.id);
    await d.getByLabel(/Start date/).fill('2027-06-01');
    await d.getByLabel(/End date/).fill('2027-01-01');
    await d.getByRole('button', { name: 'Save term' }).click();
    await expect(admin.page.getByText('Must be on or after the start date.')).toBeVisible();
    const terms = await ok(admin, 'GET', `/admin/generations/${g.id}/terms`);
    expect(terms[0].startDate ?? null).toBeNull();
  });

  test('TC-060 Term name left empty', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const d = await editTerm(admin.page, g.id);
    await d.getByLabel(/^Name/).fill('');
    await d.getByRole('button', { name: 'Save term' }).click();
    const missing = await d
      .getByLabel(/^Name/)
      .evaluate((e: HTMLInputElement) => e.validity.valueMissing);
    expect(missing).toBe(true);
    const terms = await ok(admin, 'GET', `/admin/generations/${g.id}/terms`);
    expect(terms[0].name).toBe('Term 1');
  });

  test('TC-061 Each generation has exactly 5 terms', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    await admin.page.goto(`/admin/generations/${g.id}`);
    await expect(admin.page.getByRole('row')).toHaveCount(6);
    for (let n = 1; n <= 5; n++) {
      await expect(
        admin.page.getByRole('cell', { name: new RegExp(`Term ${n}`) }).first(),
      ).toBeVisible();
    }
    await expect(admin.page.getByRole('button', { name: /(Add|Delete|Remove) term/i })).toHaveCount(
      0,
    );
  });
});

test.describe('Connect Workbook', () => {
  const SIM = 'Local file stood in for Google. Real Google not used';
  const openConnect = async (page: Page, generationId: string) => {
    await page.goto(`/admin/generations/${generationId}`);
    await page.getByRole('button', { name: 'Connect workbook' }).first().click();
    return page.getByRole('dialog');
  };
  const tryUrl = async (d: ReturnType<Page['getByRole']>, url: string) => {
    await d.getByLabel(/Spreadsheet URL/).fill(url);
    await d.getByRole('button', { name: 'Connect' }).click();
  };

  test('TC-062 Connect a Google Sheet to a term', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const id_ = sheetId(g.code);
    writeSheet(id_, workbook(g.code));
    const d = await openConnect(admin.page, g.id);
    await tryUrl(d, sheetUrl(id_));
    await expect(admin.page.getByText(/Connected ".*"\. Detect its tabs next\./)).toBeVisible();
    await expect(admin.page).toHaveURL(/\/admin\/sources\//);
    remark(SIM);
  });

  test('TC-063 Rename the sheet label', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin, { confirm: false });
    const page = admin.page;
    await page.goto(`/admin/sources/${s.sourceId}`);
    await page.getByRole('button', { name: 'Rename' }).click();
    await page.getByRole('dialog').getByLabel(/Label/).fill('New label');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Label updated.')).toBeVisible();
    await expect(page.getByRole('heading', { name: /New label/ })).toBeVisible();
    await page.goto(`/admin/generations/${s.generationId}`);
    await expect(page.locator('main:visible').last()).toContainText('New label');
  });

  test('TC-064 Sheet with a matching _meta tab', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const id_ = sheetId(g.code);
    writeSheet(id_, {
      ...workbook(g.code),
      tabs: {
        _meta: [
          ['key', 'value'],
          ['generation_code', g.code],
          ['education_term', 1],
        ],
        ...workbook(g.code).tabs,
      },
    });
    const d = await openConnect(admin.page, g.id);
    await tryUrl(d, sheetUrl(id_));
    await expect(admin.page).toHaveURL(/\/admin\/sources\//);
    remark(SIM);
  });

  test('TC-065 URL that is not a link', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const d = await openConnect(admin.page, g.id);
    await tryUrl(d, 'abc');
    await expect(d).toBeVisible();
    const input = d.getByLabel(/Spreadsheet URL/);
    expect(await input.evaluate((e: HTMLInputElement) => e.validity.typeMismatch)).toBe(true);
    expect(await input.evaluate((e: HTMLInputElement) => e.validationMessage)).toMatch(/URL/);
    remark('The browser shows the URL message');
  });

  test('TC-066 Link from another website', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const d = await openConnect(admin.page, g.id);
    await tryUrl(d, 'https://example.com/spreadsheets/d/abc');
    await expect(
      admin.page.getByText('Only docs.google.com spreadsheet links are supported.').first(),
    ).toBeVisible();
  });

  test('TC-067 Google link that is not a spreadsheet', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const d = await openConnect(admin.page, g.id);
    await tryUrl(d, 'https://docs.google.com/document/d/abcdefghijklmnopqrstuvwxyz/edit');
    await expect(
      admin.page.getByText('This link is not a Google Sheets spreadsheet.').first(),
    ).toBeVisible();
  });

  test('TC-068 Sheet not shared with the service account', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const id_ = sheetId(g.code);
    writeSheet(id_, { ...workbook(g.code), fail: 'SHEET_NOT_SHARED' });
    const d = await openConnect(admin.page, g.id);
    await tryUrl(d, sheetUrl(id_));
    await expect(
      admin.page
        .getByText('The spreadsheet is not shared with the service account (Viewer access).')
        .first(),
    ).toBeVisible();
    remark(`${SIM}. The sharing failure was simulated`);
  });

  test('TC-069 Deleted or wrong spreadsheet ID', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const d = await openConnect(admin.page, g.id);
    await tryUrl(d, sheetUrl(sheetId(`NOPE${g.code}`)));
    await expect(
      admin.page.getByText('The spreadsheet does not exist or was deleted.').first(),
    ).toBeVisible();
    remark(SIM);
  });

  test('TC-070 Same spreadsheet connected twice', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin, { confirm: false });
    await admin.page.goto(`/admin/generations/${s.generationId}`);
    await admin.page.getByRole('button', { name: 'Connect workbook' }).first().click();
    const d = admin.page.getByRole('dialog');
    await tryUrl(d, sheetUrl(s.sheet));
    await expect(
      admin.page.getByText('This spreadsheet is already connected.').first(),
    ).toBeVisible();
  });

  for (const [tc, title, edit, pattern] of [
    ['071', '_meta tab names another term', 'term', /This workbook is for .*, Term 2\./],
    ['072', '_meta tab names another generation', 'generation', /This workbook is for GEN1999/],
  ] as const) {
    test(`TC-${tc} ${title}`, async ({ browser }) => {
      const admin = await asAdmin(browser);
      const g = await newGeneration(admin);
      const id_ = sheetId(g.code);
      writeSheet(id_, {
        ...workbook(g.code),
        tabs: {
          ...workbook(g.code).tabs,
          _meta: [
            ['key', 'value'],
            ['generation_code', edit === 'generation' ? 'GEN1999' : g.code],
            ['education_term', edit === 'term' ? 2 : 1],
          ],
        },
      });
      const d = await openConnect(admin.page, g.id);
      await tryUrl(d, sheetUrl(id_));
      await expect(d).toBeVisible();
      await expect(admin.page.getByText(pattern).first()).toBeVisible();
      await expect(admin.page).toHaveURL(/\/admin\/generations\//);
      remark(SIM);
    });
  }

  test('TC-073 Dialog shows the sharing instruction', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    const d = await openConnect(admin.page, g.id);
    await expect(d.getByText(/Share the file first/)).toBeVisible();
    await expect(d).toContainText('@example-project.iam.gserviceaccount.com');
    await expect(d).toContainText(/Viewer/);
    expect(await d.innerText()).not.toMatch(/PRIVATE KEY/);
    remark('Service account email is the QA stand-in');
  });
});

void noJunk;
void clearLimits;
void connect;
void asDemo;
