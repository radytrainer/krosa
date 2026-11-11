import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  activate,
  apiLogin,
  asAdmin,
  asDemo,
  clearLimits,
  connect,
  confirmAll,
  DEMO_PASSWORD,
  editSheet,
  issueTemp,
  nav,
  newGeneration,
  NEW_PASSWORD,
  noJunk,
  ok,
  remark,
  sheetId,
  sql,
  studentRow,
  synced,
  syncNow,
  uiLogin,
  unique,
  workbook,
  writeSheet,
  type Session,
} from './support.js';

const main = (page: Page) => page.locator('main:visible').last();
test.beforeEach(() => clearLimits());

test.describe('Students', () => {
  test('TC-144 Search and filter students', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const page = admin.page;
    await page.goto('/admin/students');
    const search = page.getByLabel('Search students');
    await search.fill('Sokha');
    await expect(page.getByRole('link', { name: /Sokha Chan/ })).toBeVisible();
    await expect(page).toHaveURL(/q=Sokha/);
    await search.fill('GEN26-0002');
    await expect(page.getByRole('link', { name: /Dara Pich/ })).toBeVisible();
    await search.fill('');
    await page.getByLabel('Generation').last().selectOption({ label: 'GEN2026' });
    await expect(page).toHaveURL(/generationId=/);
    await expect(page.getByRole('link', { name: /Sokha Chan/ })).toBeVisible();
    await page.getByLabel('Class').last().fill('A');
    await expect(page).toHaveURL(/className=A/);
    await page.getByLabel('Class').last().fill('');
    for (const [label, value] of [
      ['Pending', 'PENDING'],
      ['Active', 'ACTIVE'],
      ['Disabled', 'DISABLED'],
    ] as const) {
      await page.getByLabel('Account status').selectOption({ label });
      await expect(page).toHaveURL(new RegExp(`status=${value}`));
    }
  });

  test('TC-145 View a student', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const row = await studentRow(admin, 'GEN26-0001');
    await admin.page.goto(`/admin/students/${row.id}`);
    for (const word of ['Profile', 'Account', 'Results']) {
      await expect(admin.page.getByText(word, { exact: true }).first()).toBeVisible();
    }
    await expect(admin.page.getByText('Hidden from student').first()).toBeVisible();
  });

  async function setup(browser: Parameters<typeof asAdmin>[0]) {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const code = s.students[0];
    const student = await activate(browser, admin, code);
    const row = await studentRow(admin, code);
    return { admin, s, code, student, row };
  }

  test('TC-146 Disable an account', async ({ browser }) => {
    const { admin, code, student, row } = await setup(browser);
    const page = admin.page;
    await page.goto(`/admin/students/${row.id}`);
    await page.getByRole('button', { name: 'Disable account' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /Disable/ })
      .click();
    await expect(page.getByText('Account updated.')).toBeVisible();
    await student.page.goto('/student/results');
    await expect(student.page).toHaveURL(/\/login/);
    await uiLogin(student.page, code, NEW_PASSWORD);
    await expect(student.page.getByText(/disabled/i).first()).toBeVisible();
  });

  test('TC-147 Enable an account', async ({ browser }) => {
    const { admin, code, row } = await setup(browser);
    await ok(admin, 'PATCH', `/admin/students/${row.id}/status`, { status: 'DISABLED' });
    await admin.page.goto(`/admin/students/${row.id}`);
    await admin.page.getByRole('button', { name: 'Enable account' }).click();
    const confirm = admin.page.getByRole('alertdialog').getByRole('button', { name: /Enable/ });
    if (await confirm.count()) await confirm.click();
    await expect(admin.page.getByRole('button', { name: 'Disable account' })).toBeVisible();
    await apiLogin(browser, code, NEW_PASSWORD);
  });

  test('TC-148 Reset a password', async ({ browser }) => {
    const { admin, code, student, row } = await setup(browser);
    const page = admin.page;
    await page.goto(`/admin/students/${row.id}`);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Reset password' }).click();
    const shown = page.getByRole('dialog').locator('code');
    await page.getByRole('dialog').getByRole('button', { name: 'Show password' }).click();
    const temp = (await shown.textContent())!.trim();
    await page.getByRole('button', { name: 'Done' }).click();
    await student.page.goto('/student/results');
    await expect(student.page).toHaveURL(/\/login/);
    clearLimits();
    await uiLogin(student.page, code, NEW_PASSWORD);
    await expect(student.page.getByText(/incorrect/)).toBeVisible();
    await uiLogin(student.page, code, temp);
    await expect(student.page).toHaveURL(/\/change-password$/);
  });

  test('TC-149 Issue a password to one pending student', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const row = await studentRow(admin, 'GEN26-0003');
    const page = admin.page;
    await page.goto(`/admin/students/${row.id}`);
    await page.getByRole('button', { name: 'Issue password' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Issue password' }).click();
    await expect(page.getByRole('dialog').locator('code')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Temporary/).first()).toBeVisible();
    await expect(main(page)).toContainText(/expires|Expires/);
  });

  test('TC-150 Search finds nothing', async ({ browser }) => {
    const admin = await asAdmin(browser);
    await admin.page.goto('/admin/students');
    await admin.page.getByLabel('Search students').fill('matches-nothing-here');
    await expect(admin.page.getByText('No students found')).toBeVisible();
    await expect(admin.page.getByText('Try other filters.')).toBeVisible();
  });

  test('TC-151 Class filter with a special character', async ({ browser }) => {
    const admin = await asAdmin(browser);
    await admin.page.goto('/admin/students');
    await expect(admin.page.getByRole('link', { name: /Sokha Chan/ })).toBeVisible();
    await admin.page.getByLabel('Class').last().fill('%');
    await expect(admin.page.getByRole('link', { name: /Sokha Chan/ })).toHaveCount(0);
    await noJunk(admin.page);
  });

  test('TC-152 Reset on a disabled account', async ({ browser }) => {
    const { admin, row } = await setup(browser);
    await ok(admin, 'PATCH', `/admin/students/${row.id}/status`, { status: 'DISABLED' });
    await admin.page.goto(`/admin/students/${row.id}`);
    await expect(admin.page.getByRole('button', { name: 'Reset password' })).toBeDisabled();
  });

  test('TC-153 Unknown student address', async ({ browser }) => {
    const admin = await asAdmin(browser);
    await admin.page.goto('/admin/students/00000000-0000-7000-8000-000000000000');
    await expect(admin.page.getByText(/Not found|Could not load/).first()).toBeVisible();
    expect(await main(admin.page).innerText()).not.toMatch(/stack|prisma|INTERNAL/i);
  });

  test('TC-154 Temporary password is shown once', async ({ browser }) => {
    const { admin, row } = await setup(browser);
    const page = admin.page;
    await page.goto(`/admin/students/${row.id}`);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Reset password' }).click();
    const dialog = page.getByRole('dialog');
    const temp = (await dialog.locator('code').textContent())!.trim();
    await page.mouse.click(5, 5);
    await page.waitForTimeout(500);
    const openAfterClick = await dialog.isVisible();
    if (openAfterClick) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
    const openAfterEsc = openAfterClick && (await dialog.isVisible());
    remark(
      `Click outside closed it: ${!openAfterClick}. Esc closed it: ${openAfterClick && !openAfterEsc}`,
    );
    expect.soft(openAfterEsc, 'dialog can be closed only with Done').toBe(true);
    if (openAfterEsc) await page.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    await page.goBack();
    await page.reload();
    await page.waitForLoadState('networkidle');
    expect(await page.content()).not.toContain(temp);
  });

  test('QA-021 Fast Tab stays inside every kind of popup', async ({ browser }) => {
    const { admin, row } = await setup(browser);
    const page = admin.page;
    const staysInside = async (popup: string) => {
      await expect(page.locator(popup)).toContainText(/\S/);
      await page.waitForFunction((s) => document.activeElement?.closest(s) !== null, popup);
      for (let i = 0; i < 16; i++) {
        await page.keyboard.press(i < 8 ? 'Tab' : 'Shift+Tab');
        const inside = await page.evaluate(
          (s) =>
            document.activeElement?.closest(s) !== null || document.activeElement === document.body,
          popup,
        );
        expect(inside, `${popup} after key ${i + 1}`).toBe(true);
      }
    };
    await page.goto(`/admin/students/${row.id}`);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await staysInside('[role=alertdialog]');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await staysInside('[role=dialog]');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await staysInside('[role=dialog]');
  });

  test('TC-155 No add or edit student option', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const page = admin.page;
    await page.goto('/admin/students');
    await expect(main(page)).toContainText(/sync/i);
    await expect(page.getByRole('button', { name: /Add student|New student/ })).toHaveCount(0);
    const row = await studentRow(admin, 'GEN26-0001');
    await page.goto(`/admin/students/${row.id}`);
    await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
  });

  test('TC-157 Repeated failed sign-ins notice', async ({ browser }) => {
    const { admin, code, row, student } = await setup(browser);
    const page = student.page;
    await student.context.clearCookies();
    clearLimits(); // the set-up sign-in counts against the 5 per minute for this ID
    await page.goto('/login');
    for (let i = 0; i < 5; i++) {
      await page.getByLabel(/Username or student ID/).fill(code);
      await page.locator('input[name=password]').fill('wrong-password-1');
      const answer = page.waitForResponse((r) => r.url().includes('/auth/login'));
      await page.getByRole('button', { name: 'Sign in' }).click();
      await answer;
      await page.waitForTimeout(150);
    }
    const state = sql(
      `select failed_login_count, locked_until > now() from users where username = '${code}'`,
    );
    remark(`Database after 5 wrong passwords: ${state}`);
    await admin.page.goto(`/admin/students?q=${code}`);
    await expect(admin.page.getByText('Failed sign-ins').first()).toBeVisible();
    await admin.page.goto(`/admin/students/${row.id}`);
    await expect(admin.page.getByText('Repeated failed sign-ins').first()).toBeVisible();
  });
});

test.describe('Issue Credentials', () => {
  const dialog = async (page: Page) => {
    await page.goto('/admin/students');
    await page.getByRole('button', { name: 'Issue credentials' }).click();
    return page.getByRole('dialog');
  };
  const issue = async (page: Page) => {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Issue and download CSV' }).click();
    return (await download).path().then((p) => readFileSync(p, 'utf8'));
  };

  test('TC-158 Issue by generation', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const d = await dialog(admin.page);
    await d.getByLabel(/Generation/).selectOption({ label: s.code });
    await expect(
      d.getByRole('checkbox', { name: /Only accounts still awaiting credentials/ }),
    ).toBeChecked();
    const csv = await issue(admin.page);
    expect(csv.trim().split(/\r?\n/)).toHaveLength(4);
    await expect(admin.page.getByText('Issued 3 temporary passwords').first()).toBeVisible();
    expect(
      sql(`select count(*) from users where username like '${s.prefix}-%' and status='ACTIVE'`),
    ).toBe('3');
  });

  test('TC-159 Issue to selected students', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const page = admin.page;
    await page.goto(`/admin/students?q=${s.prefix}`);
    const boxes = page.getByRole('checkbox', { name: /^Select [A-Z]/ });
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await page.getByRole('button', { name: 'Issue credentials' }).click();
    const d = page.getByRole('dialog');
    await d.getByText(/Selected on this page \(2\)/).click();
    const csv = await issue(page);
    expect(csv.trim().split(/\r?\n/)).toHaveLength(3);
  });

  test('TC-160 Issue by class', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const d = await dialog(admin.page);
    await d.getByLabel(/Generation/).selectOption({ label: s.code });
    await d.getByLabel(/Class/).fill('B');
    const csv = await issue(admin.page);
    const rows = csv.trim().split(/\r?\n/);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(s.students[2]);
  });

  test('TC-161 Nobody needs credentials', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    await ok(admin, 'POST', '/admin/students/issue-credentials', { generationId: s.generationId });
    const before = sql(
      `select string_agg(password_hash, ',' order by username) from users where username like '${s.prefix}-%'`,
    );
    clearLimits();
    const d = await dialog(admin.page);
    await d.getByLabel(/Generation/).selectOption({ label: s.code });
    await admin.page.getByRole('button', { name: 'Issue and download CSV' }).click();
    await expect(admin.page.getByText('No file was issued').first()).toBeVisible();
    await expect(
      admin.page.getByText('No matching students needed credentials. Nothing was issued.').first(),
    ).toBeVisible();
    expect(
      sql(
        `select string_agg(password_hash, ',' order by username) from users where username like '${s.prefix}-%'`,
      ),
    ).toBe(before);
  });

  test('TC-162 More than 500 students', async ({ browser }) => {
    test.setTimeout(120_000);
    const admin = await asAdmin(browser);
    const prefix = unique();
    const g = await newGeneration(admin, prefix);
    const sheet = sheetId(prefix);
    const rows = Array.from({ length: 501 }, (_, i) => [
      `${prefix}-${String(i).padStart(3, '0')}`,
      `F${i}`,
      `L${i}`,
      'F',
      'A',
    ]);
    const header = ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER', 'CLASS'];
    writeSheet(sheet, {
      title: 'Large',
      tabs: {
        ALL: [header, ...rows],
        Only: [[...header, 'Final 100%'], ...rows.map((r) => [...r, 50])],
      },
    });
    const source = await connect(admin, g.terms[0]!.id, sheet);
    await confirmAll(admin, source.id);
    expect((await syncNow(admin, source.id)).status).toBe('SUCCEEDED');
    const d = await dialog(admin.page);
    await d.getByLabel(/Generation/).selectOption({ label: prefix });
    await admin.page.getByRole('button', { name: 'Issue and download CSV' }).click();
    await expect(
      admin.page
        .getByText('At most 500 students per file. Narrow the selection (for example by class).')
        .first(),
    ).toBeVisible();
    remark('Local file stood in for the Google Sheet');
  });

  test('TC-163 Unticked box signs out active students', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const student = await activate(browser, admin, s.students[0]);
    const d = await dialog(admin.page);
    await d.getByLabel(/Generation/).selectOption({ label: s.code });
    await d.getByRole('checkbox', { name: /Only accounts still awaiting credentials/ }).uncheck();
    await issue(admin.page);
    await student.page.goto('/student/results');
    await expect(student.page).toHaveURL(/\/login/);
    clearLimits();
    await uiLogin(student.page, s.students[0], NEW_PASSWORD);
    await expect(student.page.getByText(/incorrect/)).toBeVisible();
  });

  test('TC-164 CSV opens safely', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin, {
      edit: (x) => {
        x.tabs['ALL']![3]![1] = 'សុខា';
        x.tabs['ALL']![4]![1] = 'Élodie';
        x.tabs['ALL']![5]![1] = '=1+1';
      },
    });
    const d = await dialog(admin.page);
    await d.getByLabel(/Generation/).selectOption({ label: s.code });
    const download = admin.page.waitForEvent('download');
    await admin.page.getByRole('button', { name: 'Issue and download CSV' }).click();
    const bytes = readFileSync(await (await download).path());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    expect(text).toContain('សុខា');
    expect(text).toContain('Élodie');
    expect(text).toContain("'=1+1");
    remark(
      'File bytes checked: UTF-8 BOM, Khmer and accented names, formula escaped. Not opened in Excel',
    );
  });
});

test.describe('Student Portal', () => {
  test('TC-165 Overview page', async ({ browser }) => {
    const u = await asDemo(browser);
    await u.page.goto('/student');
    await expect(u.page.getByRole('heading', { name: /Hello, Sokha/ })).toBeVisible();
    await expect(main(u.page)).toContainText('GEN26-0001');
    await expect(main(u.page)).toContainText(/Generation 2026|GEN2026/);
    await expect(main(u.page)).toContainText('Overall');
    await expect(main(u.page)).toContainText('Averages by term');
  });

  test('TC-166 View results by term', async ({ browser }) => {
    const u = await asDemo(browser);
    const page = u.page;
    await page.goto('/student/results');
    await page.getByRole('tab', { name: /Term 1/ }).click();
    await expect(main(page)).toContainText('MATH101');
    await expect(main(page)).not.toContainText('MATH102');
    await page.getByRole('tab', { name: /Term 2/ }).click();
    await expect(main(page)).toContainText('MATH102');
    await page.getByRole('button', { name: /MATH102/ }).click();
    for (const h of ['Criterion', 'Mark', 'Weight', 'Contribution']) {
      await expect(page.getByRole('columnheader', { name: h }).first()).toBeVisible();
    }
  });

  test('TC-167 View a course page', async ({ browser }) => {
    const u = await asDemo(browser);
    const page = u.page;
    await page.goto('/student/results');
    await page.getByRole('tab', { name: /Term 2/ }).click();
    await page.getByRole('button', { name: /MATH102/ }).click();
    await page.getByRole('link', { name: 'Open course page' }).click();
    await expect(page).toHaveURL(/\/student\/courses\//);
    await expect(page.getByText('How your score is calculated')).toBeVisible();
    await page.getByRole('link', { name: 'My results' }).last().click();
    await expect(page).toHaveURL(/term=2/);
  });

  test('TC-168 View profile', async ({ browser }) => {
    const u = await asDemo(browser);
    await u.page.goto('/student/profile');
    const m = main(u.page);
    for (const text of ['Sokha Chan', 'GEN26-0001']) await expect(m).toContainText(text);
    await expect(m).toContainText(/Generation 2026/);
    await expect(m).toContainText(/Class/);
    await expect(m).toContainText(/Gender/);
  });

  test('TC-169 Student with no released results', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin, { release: false });
    const u = await activate(browser, admin, s.students[0]);
    await u.page.goto('/student');
    await expect(u.page.getByText('No results yet').first()).toBeVisible();
    await u.page.goto('/student/results');
    await expect(u.page.getByText('Could not load this data')).toHaveCount(0);
    await expect(u.page.getByText(/No results/).first()).toBeVisible();
  });

  test('TC-170 Invalid term in the address', async ({ browser }) => {
    const u = await asDemo(browser);
    await u.page.goto('/student/results?term=99');
    await expect(u.page.getByRole('tab', { selected: true })).toBeVisible();
    await expect(u.page.getByText('Could not load this data')).toHaveCount(0);
  });

  test('TC-171 Invalid course address', async ({ browser }) => {
    const u = await asDemo(browser);
    await u.page.goto('/student/courses/abc');
    await expect(u.page.getByText(/Not found|Could not load/).first()).toBeVisible();
    expect(await main(u.page).innerText()).not.toMatch(/stack|prisma|INTERNAL/i);
    await u.page
      .getByRole('link', { name: /My results/ })
      .last()
      .click();
    await expect(u.page).toHaveURL(/\/student\/results/);
  });

  test('TC-172 Hidden subject is not shown', async ({ browser }) => {
    const u = await asDemo(browser);
    await u.page.goto('/student/results');
    await u.page.getByRole('tab', { name: /Term 1/ }).click();
    await expect(main(u.page)).not.toContainText('PHY101');
    const body = JSON.stringify(await ok(u, 'GET', '/student/me/results'));
    expect(body).not.toContain('PHY101');
    expect(JSON.stringify(await ok(u, 'GET', '/student/me/summary'))).not.toContain('Physics');
  });

  test('TC-173 Phone layout', async ({ browser }) => {
    const u = await asDemo(browser);
    const page = u.page;
    await page.setViewportSize({ width: 390, height: 844 });
    const { offeringId } = (await ok(u, 'GET', '/student/me/courses'))[0];
    for (const path of [
      '/student',
      '/student/results',
      `/student/courses/${offeringId}`,
      '/student/profile',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(over, path).toBeLessThanOrEqual(0);
    }
    await page.goto(`/student/courses/${offeringId}`);
    await expect(page.getByRole('table')).toBeHidden();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'My results' }).click();
    await expect(page).toHaveURL(/\/student\/results/);
  });

  test('TC-174 Status is not shown by color alone', async ({ browser }) => {
    const u = await asDemo(browser);
    await u.page.goto('/student/results');
    await u.page.getByRole('tab', { name: /Term 1/ }).click();
    const badge = main(u.page).getByText('In progress').first();
    await expect(badge).toBeVisible();
    const icon = await badge.evaluate((e) => {
      const box = e.closest('span, div');
      return Boolean(box?.querySelector('svg') ?? box?.parentElement?.querySelector('svg'));
    });
    expect(icon).toBe(true);
  });
});

test.describe('Score Calculation', () => {
  const open = async (u: Session, term: number, code: string) => {
    await u.page.goto('/student/results');
    await u.page.getByRole('tab', { name: new RegExp(`Term ${term}`) }).click();
    const row = u.page.getByRole('button', { name: new RegExp(code) });
    await row.click();
    return main(u.page);
  };

  test('TC-175 Complete course final score', async ({ browser }) => {
    const u = await asDemo(browser);
    const m = await open(u, 2, 'MATH102');
    for (const value of ['10', '14.25', '26.4', '39.6']) {
      await expect(m.getByRole('cell', { name: value, exact: false }).first()).toBeVisible();
    }
    await expect(m).toContainText(/90\.25/);
    await expect(m).toContainText('Complete');
  });

  test('TC-176 Absent mark counts as 0', async ({ browser }) => {
    const u = await asDemo(browser);
    const m = await open(u, 1, 'MATH101');
    await expect(m).toContainText(/Absent\s*\(0\)/);
    await expect(m).toContainText(/46\.60/);
  });

  test('TC-177 Mark of 0 is complete', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin, { edit: (x) => (x.tabs['Logic']![1]![5] = null) });
    const u = await activate(browser, admin, s.students[0]);
    editSheet(s.sheet, (x) => (x.tabs['Logic']![1]![5] = 0));
    await syncNow(admin, s.sourceId);
    await u.page.goto('/student/results');
    await expect(u.page.getByRole('button', { name: /Logic/ })).toContainText('69.90');
    await expect(u.page.getByRole('button', { name: /Logic/ })).toContainText(/Complete/);
    remark('Local file stood in for the Google Sheet');
  });

  test('TC-178 Course with missing marks', async ({ browser }) => {
    const u = await asDemo(browser);
    const m = await open(u, 1, 'ENG101');
    await expect(m).toContainText('In progress');
    await expect(m).toContainText('Not entered');
    await expect(m).toContainText(/of 25 so far/);
    const course = (await ok(u, 'GET', '/student/me/courses')).find(
      (c: { courseCode: string }) => c.courseCode === 'ENG101',
    );
    expect(course.finalScore).toBeNull();
  });

  test('TC-179 Course with no published weights', async ({ browser }) => {
    const u = await asDemo(browser);
    const m = await open(u, 2, 'ART101');
    await expect(m).toContainText('Not graded yet');
    await expect(m).toContainText('The grading scheme for this course has not been published yet.');
  });

  test('TC-180 Sheet total does not decide the score', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const u = await activate(browser, admin, s.students[0]);
    editSheet(s.sheet, (x) => (x.tabs['Logic']![1]![11] = 1));
    await syncNow(admin, s.sourceId);
    await u.page.goto('/student/results');
    await expect(u.page.getByRole('button', { name: /Logic/ })).toContainText('78.90');
    remark('Local file stood in for the Google Sheet');
  });

  test('TC-181 Rounding to 2 decimals', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const prefix = unique();
    const g = await newGeneration(admin, prefix);
    const sheet = sheetId(prefix);
    const header = ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER', 'CLASS'];
    const row = [`${prefix}-001`, 'A', 'B', 'F', 'A'];
    writeSheet(sheet, {
      title: 'Rounding',
      tabs: {
        ALL: [header, row],
        Only: [
          [...header, 'Final 100%'],
          [...row, 85.125],
        ],
      },
    });
    const source = await connect(admin, g.terms[0]!.id, sheet);
    await confirmAll(admin, source.id);
    await syncNow(admin, source.id);
    await ok(admin, 'POST', `/admin/terms/${g.terms[0]!.id}/release`, { visible: true });
    const u = await activate(browser, admin, `${prefix}-001`);
    await u.page.goto('/student/results');
    await expect(u.page.getByRole('button', { name: /Only/ })).toContainText('85.13');
    remark('Local file stood in for the Google Sheet');
  });

  test('TC-182 Weight change keeps history', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const u = await activate(browser, admin, s.students[0]);
    const mappings = (await ok(admin, 'GET', `/admin/sources/${s.sourceId}/mappings`)) as {
      id: string;
      tabName: string;
    }[];
    const logic = mappings.find((t) => t.tabName === 'Logic')!;
    await ok(admin, 'POST', `/admin/sources/${s.sourceId}/mappings/${logic.id}/reopen`);
    const { detect, confirmBody } = await import('./support.js');
    const tab = (await detect(admin, s.sourceId)).find((t) => t.tabName === 'Logic')!;
    await ok(
      admin,
      'POST',
      `/admin/sources/${s.sourceId}/mappings/${tab.id}/confirm`,
      confirmBody(tab, 'Logic', { 'MIDTERM 25%': '35', 'FINAL 35%': '25' }),
    );
    await syncNow(admin, s.sourceId);
    const results = await ok(u, 'GET', '/student/me/results');
    const c = results.terms[0].courses.find((x: { title: string }) => x.title === 'Logic');
    expect(c.finalScore).toBe('77.10');
    expect(c.schemeVersion).toBe(2);
    remark('Local file stood in for the Google Sheet');
  });

  test('TC-183 Term average', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const prefix = unique();
    const g = await newGeneration(admin, prefix);
    const sheet = sheetId(prefix);
    const header = ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER', 'CLASS'];
    const row = [`${prefix}-001`, 'A', 'B', 'F', 'A'];
    writeSheet(sheet, {
      title: 'Average',
      tabs: {
        ALL: [header, row],
        One: [
          [...header, 'Final 100%'],
          [...row, 80],
        ],
        Two: [
          [...header, 'Final 100%'],
          [...row, 71],
        ],
        Three: [
          [...header, 'Quiz 50%', 'Exam 50%'],
          [...row, 60],
        ],
      },
    });
    const source = await connect(admin, g.terms[0]!.id, sheet);
    await confirmAll(admin, source.id);
    await syncNow(admin, source.id);
    await ok(admin, 'POST', `/admin/terms/${g.terms[0]!.id}/release`, { visible: true });
    const u = await activate(browser, admin, `${prefix}-001`);
    await u.page.goto('/student/results');
    await expect(main(u.page)).toContainText(/Provisional/);
    await expect(main(u.page)).toContainText('75.50');
    editSheet(sheet, (x) => x.tabs['Three']![1]!.push(60));
    await syncNow(admin, source.id);
    await u.page.reload();
    await expect(main(u.page)).toContainText('70.33');
    await expect(main(u.page)).not.toContainText(/Provisional/);
    remark('Equal credits (1 each). (80 + 71 + 60) / 3 = 70.33 worked by hand');
  });

  test('TC-184 Spot check against the sheet', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const row = await studentRow(admin, s.students[0]);
    const results = await ok(admin, 'GET', `/admin/students/${row.id}/results`);
    const scores = Object.fromEntries(
      results.terms[0].courses.map((c: { title: string; finalScore: string; status: string }) => [
        c.title,
        c.finalScore,
      ]),
    );
    expect(scores).toMatchObject({
      Logic: '78.90',
      MsOffice: '93.00',
      ENG: '80.00',
      PL: '76.80',
      BCU: null,
    });
    remark('Synthetic fixture only: 3 students, not 5. BCU differs because its marks are blank');
  });
});

test.describe('Audit Log', () => {
  test('TC-185 Actions are recorded', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    await activate(browser, admin, s.students[0]);
    await issueTemp(admin, s.students[0]);
    const page = admin.page;
    await page.goto('/admin/audit');
    for (const h of ['When', 'Action', 'Actor', 'Entity', 'Details']) {
      await expect(page.getByRole('columnheader', { name: h })).toBeVisible();
    }
    const logs = await ok(admin, 'GET', '/admin/audit-logs?pageSize=100');
    const actions = logs.data.map((l: { action: string }) => l.action);
    for (const a of ['generation.created', 'student.password.reset', 'sync.requested']) {
      expect(actions, a).toContain(a);
    }
    await expect(main(page)).toContainText('student.password.reset');
  });

  test('TC-186 Filter the log', async ({ browser }) => {
    const admin = await asAdmin(browser);
    await synced(admin, { confirm: false });
    const page = admin.page;
    await page.goto('/admin/audit');
    await page.getByLabel('Action').selectOption({ label: 'Generations' });
    await expect(page).toHaveURL(/action=generation/);
    await expect(main(page)).toContainText('generation.created');
    await page.getByLabel('Action').selectOption({ label: 'All actions' });
    const today = new Date().toISOString().slice(0, 10);
    await page.getByLabel('From date').fill(today);
    await page.getByLabel('To date').fill(today);
    await expect(page).toHaveURL(/from=/);
    await expect(main(page)).toContainText('auth.login.success');
    await page.getByLabel('From date').fill('');
    await page.getByLabel('To date').fill('');
    const entity = main(page)
      .getByRole('button', { name: /[0-9a-f]{8}/ })
      .first();
    await entity.click();
    await expect(page).toHaveURL(/entityId=/);
  });

  test('TC-187 From date after To date', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const page = admin.page;
    await page.goto('/admin/audit');
    await page.getByLabel('From date').fill('2030-01-02');
    await page.getByLabel('To date').fill('2030-01-01');
    await expect(page.getByText(/No .*entries|must be/i).first()).toBeVisible();
  });

  test('TC-188 Student opens the audit log', async ({ browser }) => {
    const u = await asDemo(browser);
    await u.page.goto('/admin/audit');
    await expect(u.page).toHaveURL(/\/student/);
    expect(await u.page.locator('body').innerText()).not.toMatch(/auth\.login/);
  });

  test('TC-189 No secrets in the log', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const temp = await issueTemp(admin, s.students[0]);
    const csv = await ok(admin, 'POST', '/admin/students/issue-credentials', {
      generationId: s.generationId,
    });
    const tempFromCsv = String(csv).trim().split(/\r?\n/)[1]?.split(',')[3] ?? 'none';
    await admin.page.goto('/admin/audit');
    await admin.page.waitForLoadState('networkidle');
    const all = JSON.stringify(await ok(admin, 'GET', '/admin/audit-logs?pageSize=100'));
    const shown = await admin.page.content();
    for (const secret of [temp, tempFromCsv, DEMO_PASSWORD]) {
      expect(all).not.toContain(secret);
      expect(shown).not.toContain(secret);
    }
    expect(all).not.toMatch(/\$argon2|passwordHash/);
  });

  test('TC-190 Log cannot be edited', async ({ browser }) => {
    const admin = await asAdmin(browser);
    await admin.page.goto('/admin/audit');
    await admin.page.waitForLoadState('networkidle');
    await expect(main(admin.page).getByRole('button', { name: /Edit|Delete/ })).toHaveCount(0);
  });
});

test.describe('General UI', () => {
  test('TC-192 Script text in a sheet shows as plain text', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const script = '<script>alert(1)</script>';
    editSheet(s.sheet, (x) => (x.tabs['ALL']![3]![1] = script));
    await syncNow(admin, s.sourceId);
    const page = admin.page;
    let alerted = false;
    page.on('dialog', async (d) => {
      alerted = true;
      await d.dismiss();
    });
    await page.goto(`/admin/students?q=${s.prefix}`);
    await expect(page.getByText(script).first()).toBeVisible();
    const row = await studentRow(admin, s.students[0]);
    await page.goto(`/admin/students/${row.id}`);
    await expect(page.getByText(script).first()).toBeVisible();
    expect(alerted).toBe(false);
    remark('Local file stood in for the Google Sheet');
  });

  test('TC-193 Dialogs work by keyboard', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const page = admin.page;
    await page.goto('/admin/generations');
    await page.getByRole('button', { name: 'New generation' }).click();
    const d = page.getByRole('dialog');
    await expect(d).toBeVisible();
    // Fast, with no wait between keys: that is what used to get past the dialog's focus guard.
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press(i < 12 ? 'Tab' : 'Shift+Tab');
      const escaped = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el.closest('[role=dialog]')) return null;
        return el.matches('a, button, input, select, textarea') ? el.outerHTML.slice(0, 80) : null;
      });
      if (escaped) remark(`Tab ${i + 1} reached ${escaped.slice(0, 40)} behind the dialog`);
      expect.soft(escaped).toBeNull();
    }
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
  });

  test('TC-194 Admin pages on a phone', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const page = admin.page;
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of [
      '/admin',
      '/admin/generations',
      '/admin/students',
      '/admin/sync',
      '/admin/audit',
      '/admin/account',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(over, path).toBeLessThanOrEqual(0);
    }
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Students' }).click();
    await expect(page).toHaveURL(/\/admin\/students/);
  });

  test('TC-195 No console errors', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !/status of 401/.test(m.text()))
        problems.push(m.text().slice(0, 160));
    });
    page.on('pageerror', (e) => problems.push(e.message.slice(0, 160)));
    await uiLogin(page, 'GEN26-0001', DEMO_PASSWORD);
    await expect(page).toHaveURL(/\/student$/);
    await nav(page, 'My results').click();
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.waitForLoadState('networkidle');
    expect(problems).toEqual([]);
  });

  test('TC-196 Pagination', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const page = admin.page;
    const total = (await ok(admin, 'GET', '/admin/students?pageSize=1')).meta.total as number;
    expect(total).toBeGreaterThan(25);
    await page.goto('/admin/students');
    const first = await page.getByRole('link').allTextContents();
    await page.getByRole('button', { name: /Next/ }).click();
    await expect(page).toHaveURL(/page=2/);
    await page.waitForLoadState('networkidle');
    expect(await page.getByRole('link').allTextContents()).not.toEqual(first);
    const last = Math.ceil(total / 25);
    await page.goto(`/admin/students?page=${last}`);
    await expect(page.getByRole('button', { name: /Next/ })).toBeDisabled();
    await expect(main(page)).toContainText(String(total));
    await page.getByRole('button', { name: /Previous/ }).click();
    await expect(page).toHaveURL(new RegExp(`page=${last - 1}`));
  });
});

void workbook;
void asDemo;
void newGeneration;
