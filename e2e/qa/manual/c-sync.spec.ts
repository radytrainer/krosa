import { expect, test, type Page } from '@playwright/test';
import {
  activate,
  asAdmin,
  call,
  clearLimits,
  confirmAll,
  confirmBody,
  connect,
  detect,
  editSheet,
  newGeneration,
  ok,
  pendingSheet,
  readSheet,
  remark,
  sheetId,
  sheetUrl,
  sql,
  startSync,
  studentRow,
  synced,
  syncNow,
  waitJob,
  workbook,
  writeSheet,
  type Scenario,
  type Session,
} from './support.js';

const SIM = 'Local file stood in for the Google Sheet';
type Browser = Parameters<typeof asAdmin>[0];
test.beforeEach(() => {
  clearLimits();
  remark(SIM);
});

const sourcePage = (page: Page, id: string) => page.goto(`/admin/sources/${id}`);
const issues = async (a: Session, jobId: string) =>
  (await ok(a, 'GET', `/admin/sync/${jobId}/errors?pageSize=100`)).data as {
    code: string;
    sheetTab: string;
    rowNumber: number;
    severity: string;
  }[];
const openTab = (page: Page, name: RegExp) => page.getByRole('button', { name }).first().click();
const main = (page: Page) => page.locator('main:visible').last();

async function course(s: Session, title: string) {
  const data = await ok(s, 'GET', '/student/me/courses');
  return data.find((c: { title: string }) => c.title === title);
}

async function studentAndScenario(browser: Browser, code = 0) {
  const admin = await asAdmin(browser);
  const s = await synced(admin);
  const student = await activate(browser, admin, s.students[code]!);
  return { admin, s, student };
}

test.describe('Detect and Confirm Tabs', () => {
  async function connected(browser: Browser, edit?: Parameters<typeof synced>[1]) {
    const admin = await asAdmin(browser);
    const s = await synced(admin, { confirm: false, ...edit });
    await sourcePage(admin.page, s.sourceId);
    return { admin, s, page: admin.page };
  }
  const detectUi = async (page: Page) => {
    await page.getByRole('button', { name: 'Detect tabs' }).click();
    await expect(page.getByText(/students found in "ALL"/)).toBeVisible();
  };

  test('TC-074 Detect tabs', async ({ browser }) => {
    const { page } = await connected(browser);
    await detectUi(page);
    await expect(page.getByText(/imported/i).first()).toBeVisible();
    await expect(page.getByText('Needs review').first()).toBeVisible();
    expect(await page.getByText('Needs review').count()).toBeGreaterThanOrEqual(5);
  });

  test('TC-075 Confirm a tab', async ({ browser }) => {
    const { page } = await connected(browser);
    await detectUi(page);
    await openTab(page, /^Logic/);
    await expect(page.getByLabel('Subject name')).toHaveValue('Logic');
    await expect(page.getByText(/Total weight/).first()).toContainText('100');
    await page.getByRole('button', { name: 'Confirm tab' }).click();
    await expect(page.getByText(/confirmed/i).first()).toBeVisible();
    await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible();
  });

  test('TC-076 Group weight is split equally', async ({ browser }) => {
    const { admin, s } = await connected(browser);
    const tabs = await detect(admin, s.sourceId);
    const eng = tabs.find((t) => t.tabName === 'ENG')!;
    const pick = (n: string) => eng.columns.find((c) => c.headerLabel === n)?.proposedWeight;
    expect(Number(pick('Role Play'))).toBe(7.5);
    expect(Number(pick('English for IT'))).toBe(7.5);
    await sourcePage(admin.page, s.sourceId);
    await openTab(admin.page, /^ENG/);
    await expect(main(admin.page).locator('input[value="7.5"], input[value="7.500"]')).toHaveCount(
      2,
    );
  });

  test('TC-077 Mark a tab as Not a subject', async ({ browser }) => {
    const { admin, s, page } = await connected(browser, {
      edit: (x) => {
        x.tabs['Helper'] = [
          ['STUDENT ID', 'NOTES 100%'],
          ['X', 1],
        ];
      },
    });
    await detectUi(page);
    await openTab(page, /^Helper/);
    await page.getByRole('button', { name: 'Not a subject' }).click();
    await expect(page.getByText('Ignored', { exact: true }).first()).toBeVisible();
    const tabs = (await ok(admin, 'GET', `/admin/sources/${s.sourceId}/mappings`)) as {
      tabName: string;
      id: string;
      status: string;
    }[];
    expect(tabs.find((t) => t.tabName === 'Helper')!.status).toBe('IGNORED');
    const logic = (await detect(admin, s.sourceId)).find((t) => t.tabName === 'Logic')!;
    await ok(
      admin,
      'POST',
      `/admin/sources/${s.sourceId}/mappings/${logic.id}/confirm`,
      confirmBody(logic),
    );
    const job = await syncNow(admin, s.sourceId);
    const found = await issues(admin, job.id);
    expect(found.filter((i) => i.sheetTab === 'Helper')).toEqual([]);
  });

  test('TC-078 Reopen a confirmed tab', async ({ browser }) => {
    const { admin, s, page } = await connected(browser);
    await confirmAll(admin, s.sourceId);
    await sourcePage(page, s.sourceId);
    await openTab(page, /^Logic/);
    await page.getByRole('button', { name: 'Reopen for review' }).click();
    await expect(
      page.getByText('Reopened. Detect tabs again to refresh its columns.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Detect tabs' }).click();
    await expect(page.getByText('Needs review').first()).toBeVisible();
    const confirm = page.getByRole('button', { name: 'Confirm tab' });
    if (!(await confirm.isVisible())) await openTab(page, /^Logic/);
    await confirm.click();
    await expect(page.getByRole('button', { name: 'Reopen for review' })).toBeVisible();
  });

  test('TC-079 Weights with decimals total 100', async ({ browser }) => {
    const { page } = await connected(browser, {
      edit: (x) => {
        x.tabs['Thirds'] = [['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'A', 'B', 'C']];
      },
    });
    await detectUi(page);
    await openTab(page, /^Thirds/);
    const inputs = main(page).getByRole('spinbutton');
    const weights = main(page).locator('input[inputmode=decimal], input[type=number]');
    const box = (await inputs.count()) ? inputs : weights;
    await box.nth(0).fill('33.333');
    await box.nth(1).fill('33.333');
    await box.nth(2).fill('33.334');
    await expect(page.getByText(/Total weight/).first()).toContainText('100');
    await page.getByRole('button', { name: 'Confirm tab' }).click();
    await expect(page.getByRole('button', { name: 'Reopen for review' })).toBeVisible();
  });

  test('TC-080 Weights total less or more than 100', async ({ browser }) => {
    const { page } = await connected(browser);
    await detectUi(page);
    await openTab(page, /^Logic/);
    const weight = page.getByLabel('Weight of column FINAL 35%');
    for (const value of ['34.999', '35.001']) {
      await weight.fill(value);
      await expect(page.getByText('(must be 100)')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Confirm tab' })).toBeDisabled();
    }
    const red = await page
      .getByText(/Total weight/)
      .first()
      .locator('span')
      .getAttribute('class');
    expect(red).toContain('text-destructive');
  });

  test('TC-081 Empty subject name', async ({ browser }) => {
    const { page } = await connected(browser);
    await detectUi(page);
    await openTab(page, /^Logic/);
    await page.getByLabel('Subject name').fill('');
    await expect(page.getByRole('button', { name: 'Confirm tab' })).toBeDisabled();
  });

  test('TC-082 Invalid weight value', async ({ browser }) => {
    const { admin, s, page } = await connected(browser);
    await detectUi(page);
    await openTab(page, /^Logic/);
    const weight = page.getByLabel('Weight of column FINAL 35%');
    await weight.fill('-5');
    await expect(page.getByRole('button', { name: 'Confirm tab' })).toBeDisabled();
    const tabs = (await ok(admin, 'GET', `/admin/sources/${s.sourceId}/mappings`)) as {
      tabName: string;
      status: string;
    }[];
    expect(tabs.find((t) => t.tabName === 'Logic')!.status).toBe('DRAFT');
  });

  test('TC-083 Workbook without an ALL tab', async ({ browser }) => {
    const { s, page } = await connected(browser);
    editSheet(s.sheet, (x) => delete x.tabs['ALL']);
    await page.getByRole('button', { name: 'Detect tabs' }).click();
    await expect(page.getByText('This workbook cannot be synced yet')).toBeVisible();
    await expect(page.getByText(/ALL/).first()).toBeVisible();
  });

  test('TC-084 Sync with no confirmed tabs', async ({ browser }) => {
    const { admin, s, page } = await connected(browser);
    const button = page.getByRole('button', { name: 'Sync now' });
    if (await button.isEnabled()) {
      await button.click();
      await expect(page.getByText(/Confirm at least one/i).first()).toBeVisible();
    }
    expect(
      sql(
        `select count(*) from assessment_scores s join course_offerings o on o.id=s.offering_id where o.source_id='${s.sourceId}'`,
      ),
    ).toBe('0');
    void admin;
  });

  test('TC-085 Detect tabs imports nothing', async ({ browser }) => {
    const { admin, s, page } = await connected(browser);
    const count = async () =>
      (await ok(admin, 'GET', `/admin/generations/${s.generationId}`)).counts.students;
    expect(await count()).toBe(0);
    await detectUi(page);
    expect(await count()).toBe(0);
  });

  test('TC-086 Helper tabs are not treated as subjects', async ({ browser }) => {
    const { admin, s } = await connected(browser, {
      edit: (x) => {
        x.tabs['_notes'] = [['STUDENT ID', 'x']];
      },
    });
    const names = (await detect(admin, s.sourceId)).map((t) => t.tabName);
    expect(names).not.toContain('_notes');
    expect(names).not.toContain('ALL');
  });

  test('TC-087 Sheet TOTAL and GRADE columns are not marks', async ({ browser }) => {
    const { page } = await connected(browser);
    await detectUi(page);
    await openTab(page, /^ENG/);
    const total = page.getByLabel('Use of column TOTAL');
    expect(await total.evaluate((e: HTMLSelectElement) => e.selectedOptions[0]?.text)).toBe(
      'Sheet total (check only)',
    );
    await expect(page.getByText(/Total weight/).first()).toContainText('100');
    const roles = await main(page)
      .locator('select')
      .evaluateAll((x) => x.map((s) => (s as HTMLSelectElement).selectedOptions[0]?.text));
    expect(roles.filter((r) => /Mark|Criterion/i.test(r ?? '')).length).toBe(16);
  });
});

test.describe('Sync', () => {
  const syncUi = async (page: Page, id: string) => {
    await sourcePage(page, id);
    await page.getByRole('button', { name: 'Sync now' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sync now' }).click();
    await expect(page).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
  };

  test('TC-088 First sync imports students and marks', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin, { sync: false });
    await syncUi(admin.page, s.sourceId);
    await expect(admin.page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(admin.page.getByRole('heading', { name: 'What changed' })).toBeVisible();
    await admin.page.goto(`/admin/students?q=${s.prefix}`);
    await expect(admin.page.getByRole('cell', { name: /Pending/ }).first()).toBeVisible();
    expect(
      (await ok(admin, 'GET', `/admin/students?q=${s.prefix}&status=PENDING`)).meta.total,
    ).toBe(3);
  });

  test('TC-089 Re-sync with no changes', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const job = await syncNow(admin, s.sourceId);
    expect(job.status).toBe('SUCCEEDED');
    expect(job.counts.scores).toMatchObject({ created: 0, updated: 0 });
    expect(job.counts.students).toMatchObject({ created: 0, updated: 0 });
  });

  test('TC-090 Changed mark is updated', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    editSheet(s.sheet, (x) => (x.tabs['Logic']![1]![5] = 55));
    const job = await syncNow(admin, s.sourceId);
    expect(job.counts.scores.updated).toBe(1);
    const row = await studentRow(admin, s.students[0]);
    await admin.page.goto(`/admin/students/${row.id}`);
    await admin.page.getByRole('button', { name: /Logic/ }).click();
    await expect(admin.page.getByText('55').first()).toBeVisible();
  });

  test('TC-091 ABS mark', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    editSheet(s.sheet, (x) => (x.tabs['Logic']![1]![5] = 'ABS'));
    await syncNow(admin, s.sourceId);
    await student.page.goto('/student/results');
    await student.page.getByRole('button', { name: /Logic/ }).click();
    await expect(student.page.getByText('Absent').first()).toBeVisible();
    await expect(student.page.getByText(/Absent\s*\(0\)/).first()).toBeVisible();
    expect((await course(student, 'Logic')).finalScore).toBe('69.90');
  });

  test('TC-092 New student added to the sheet', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const student = await activate(browser, admin, s.students[0]);
    const code = `${s.prefix}-004`;
    editSheet(s.sheet, (x) => {
      x.tabs['ALL']!.push([code, 'NEW', 'PERSON', 'F', 'A']);
      x.tabs['Logic']!.push([code, 'NEW', 'PERSON', 'F', 'A', 50, 50, 50, 50, 50, 50]);
    });
    const job = await syncNow(admin, s.sourceId);
    expect(job.counts.students.created).toBe(1);
    await admin.page.goto(`/admin/students?q=${code}`);
    await expect(admin.page.getByRole('cell', { name: /Pending/ }).first()).toBeVisible();
    await ok(student, 'GET', '/auth/me');
  });

  test('TC-093 Sync from Sync center by Generation and Term', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const page = admin.page;
    await page.goto('/admin/sync');
    await page
      .getByLabel(/^Generation/)
      .first()
      .selectOption({ label: `Generation ${s.code}` });
    const term = page.getByLabel(/^Term/).first();
    expect(await term.locator('option').allTextContents()).toEqual([
      'All terms',
      'Term 1',
      'Term 2',
      'Term 3',
      'Term 4',
      'Term 5',
    ]);
    await term.selectOption({ label: 'Term 1' });
    await page.getByRole('button', { name: 'Start sync' }).click();
    await expect(page).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
    await expect(main(page)).toContainText(/Term 1|Test Sheet A/);
  });

  test('TC-094 Sync all workbooks of a generation', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const second = sheetId(`T2${s.prefix}`);
    writeSheet(second, workbook(s.prefix));
    const source = await connect(admin, s.terms[1]!.id, second, 'Second sheet');
    await confirmAll(admin, source.id);
    const page = admin.page;
    await page.goto(`/admin/generations/${s.generationId}`);
    await page.getByRole('button', { name: 'Sync all workbooks' }).click();
    const confirm = page.getByRole('alertdialog').getByRole('button', { name: /Sync/ });
    if (await confirm.count()) await confirm.click();
    await expect(page).toHaveURL(/\/admin\/sync\/[0-9a-f-]+$/);
    await expect(page.getByText('Per-source jobs')).toBeVisible();
    await expect(page.getByRole('row')).not.toHaveCount(1);
    const id = page.url().split('/').pop()!;
    const job = await waitJob(admin, id);
    expect(job.children).toHaveLength(2);
    await expect(page.getByText(/Succeeded/).first()).toBeVisible({ timeout: 15_000 });
  });

  test('TC-095 Second sync of the same term while one is running', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    await sourcePage(admin.page, s.sourceId);
    await admin.page.getByRole('button', { name: 'Sync now' }).click();
    const button = admin.page.getByRole('dialog').getByRole('button', { name: 'Sync now' });
    await expect(button).toBeEnabled();
    editSheet(s.sheet, (x) => (x.delayMs = 6000));
    await startSync(admin, s.sourceId);
    await button.click();
    await expect(
      admin.page.getByText(/already queued or running|already running/i).first(),
    ).toBeVisible();
    editSheet(s.sheet, (x) => delete x.delayMs);
  });

  test('TC-096 Invalid marks in the sheet', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    editSheet(s.sheet, (x) => {
      const l = x.tabs['Logic']!;
      l[1]![5] = 101;
      l[1]![6] = -1;
      l[2]![5] = 'abc';
      l[2]![6] = '8,5';
      l[1]![7] = 44;
    });
    const job = await syncNow(admin, s.sourceId);
    expect(job.status).toBe('SUCCEEDED_WITH_ERRORS');
    const bad = (await issues(admin, job.id)).filter((i) => i.code === 'INVALID_MARK');
    expect(bad.map((i) => [i.sheetTab, i.rowNumber])).toEqual(
      expect.arrayContaining([
        ['Logic', 2],
        ['Logic', 2],
        ['Logic', 3],
        ['Logic', 3],
      ]),
    );
    expect(bad).toHaveLength(4);
    expect(job.counts.scores.updated).toBe(1);
    await admin.page.goto(`/admin/sync/${job.id}`);
    await expect(admin.page.getByText('Succeeded with errors').first()).toBeVisible();
    await expect(admin.page.getByText('INVALID_MARK').first()).toBeVisible();
  });

  test('TC-097 Student in a subject tab but not in ALL', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    editSheet(s.sheet, (x) => {
      x.tabs['Logic']!.push([`${s.prefix}-999`, 'X', 'Y', 'M', 'A', 1, 1, 1, 1, 1, 1]);
      x.tabs['Logic']![1]![5] = 91;
    });
    const job = await syncNow(admin, s.sourceId);
    expect((await issues(admin, job.id)).map((i) => i.code)).toContain('UNKNOWN_STUDENT');
    expect(job.counts.scores.updated).toBe(1);
  });

  test('TC-098 Same student twice in one tab', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    editSheet(s.sheet, (x) => {
      const logic = x.tabs['Logic']!;
      logic.push([...logic[1]!]);
    });
    const job = await syncNow(admin, s.sourceId);
    const codes = (await issues(admin, job.id)).map((i) => i.code);
    expect(codes.filter((c) => c === 'DUPLICATE_ROW')).toHaveLength(2);
    expect(codes).not.toContain('ENROLLMENT_MISSING_IN_SOURCE');
    expect((await course(student, 'Logic')).finalScore).toBe('78.90');
  });

  test('TC-099 Student removed from a subject tab', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    editSheet(s.sheet, (x) => x.tabs['Logic']!.pop());
    const job = await syncNow(admin, s.sourceId);
    expect((await issues(admin, job.id)).map((i) => i.code)).toContain(
      'ENROLLMENT_MISSING_IN_SOURCE',
    );
    const row = await studentRow(admin, s.students[2]);
    await admin.page.goto(`/admin/students/${row.id}`);
    await expect(admin.page.getByText('Missing from sheet').first()).toBeVisible();
    await expect(admin.page.getByRole('button', { name: /Logic/ })).toContainText('70.00');
  });

  test('TC-100 Column header renamed', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    editSheet(s.sheet, (x) => {
      x.tabs['Logic']![0]![5] = 'Quiz One 10%';
      x.tabs['Logic']![1]![6] = 1;
      x.tabs['PL']![1]![5] = 72;
    });
    const job = await syncNow(admin, s.sourceId);
    expect((await issues(admin, job.id)).find((i) => i.code === 'NEEDS_REMAP')?.sheetTab).toBe(
      'Logic',
    );
    expect(job.counts.scores.updated).toBe(1);
    expect((await course(student, 'Logic')).finalScore).toBe('78.90');
  });

  test('TC-101 Confirmed tab deleted', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    editSheet(s.sheet, (x) => {
      delete x.tabs['Logic'];
      x.tabs['PL']![1]![5] = 72;
    });
    const job = await syncNow(admin, s.sourceId);
    expect((await issues(admin, job.id)).map((i) => i.code)).toContain('WORKSHEET_NOT_FOUND');
    expect(job.counts.scores.updated).toBe(1);
    expect((await course(student, 'Logic')).finalScore).toBe('78.90');
  });

  test('TC-102 New tab not yet confirmed', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    editSheet(s.sheet, (x) => {
      x.tabs['Science'] = [
        ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'Final 100%'],
        [s.students[0], 'DARA', 'SOK', 88],
      ];
    });
    const job = await syncNow(admin, s.sourceId);
    expect((await issues(admin, job.id)).map((i) => i.code)).toContain('UNMAPPED_TAB');
    expect(
      sql(
        `select count(*) from course_offerings where generation_id='${s.generationId}' and title='Science'`,
      ),
    ).toBe('0');
  });

  test('TC-103 Student ID used by another generation', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const a = await synced(admin);
    const b = await synced(admin);
    const before = sql(
      `select full_name, generation_id from students where student_code='${a.students[0]}'`,
    );
    editSheet(b.sheet, (x) => x.tabs['ALL']!.push([a.students[0], 'TAKEN', 'ID', 'M', 'A']));
    const job = await syncNow(admin, b.sourceId);
    expect((await issues(admin, job.id)).map((i) => i.code)).toContain(
      'STUDENT_IN_OTHER_GENERATION',
    );
    expect(
      sql(`select full_name, generation_id from students where student_code='${a.students[0]}'`),
    ).toBe(before);
  });

  test('TC-104 Sheet access removed before sync', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    editSheet(s.sheet, (x) => (x.fail = 'SHEET_NOT_SHARED'));
    const failed = await syncNow(admin, s.sourceId);
    expect(failed).toMatchObject({ status: 'FAILED', failureCode: 'SHEET_NOT_SHARED' });
    expect((await course(student, 'Logic')).finalScore).toBe('78.90');
    editSheet(s.sheet, (x) => delete x.fail);
    const page = admin.page;
    await page.goto(`/admin/sync/${failed.id}`);
    await expect(page.getByText(/shar/i).first()).toBeVisible();
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page).not.toHaveURL(new RegExp(failed.id));
    const next = page.url().split('/').pop()!;
    expect((await waitJob(admin, next)).status).toMatch(/SUCCEEDED/);
  });

  test('TC-105 Too many sync requests', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    clearLimits();
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await call(admin, 'POST', '/admin/sync', {
        scope: 'SOURCE',
        sourceId: s.sourceId,
      });
      if (res.status() === 202) await waitJob(admin, (await res.json()).jobId);
      if (res.status() === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    await sourcePage(admin.page, s.sourceId);
    await admin.page.getByRole('button', { name: 'Sync now' }).click();
    await admin.page.getByRole('dialog').getByRole('button', { name: 'Sync now' }).click();
    await expect(admin.page.getByText(/too many|try again/i).first()).toBeVisible();
    clearLimits();
  });

  test('TC-106 Blank cell is not zero', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin, { edit: (x) => (x.tabs['Logic']![1]![5] = null) });
    const student = await activate(browser, admin, s.students[0]);
    await student.page.goto('/student/results');
    const row = student.page.getByRole('button', { name: /Logic/ });
    await expect(row).toContainText(/In progress/);
    await row.click();
    await expect(student.page.getByText('Not entered').first()).toBeVisible();
    expect((await course(student, 'Logic')).finalScore).toBeNull();
  });

  test('TC-107 Erased mark counts as not entered', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    editSheet(s.sheet, (x) => (x.tabs['Logic']![1]![5] = null));
    const job = await syncNow(admin, s.sourceId);
    expect((await issues(admin, job.id)).map((i) => i.code)).toContain('MARK_CLEARED_IN_SOURCE');
    await student.page.goto('/student/results');
    await expect(student.page.getByRole('button', { name: /Logic/ })).toContainText(/In progress/);
    editSheet(s.sheet, (x) => (x.tabs['Logic']![1]![5] = 90));
    await syncNow(admin, s.sourceId);
    await student.page.reload();
    await expect(student.page.getByRole('button', { name: /Logic/ })).toContainText('78.90');
  });

  test('TC-108 Mark limits', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    editSheet(s.sheet, (x) => {
      x.tabs['Logic']![1]![5] = 0;
      x.tabs['Logic']![1]![6] = 100;
      x.tabs['Logic']![1]![7] = 85.125;
    });
    const job = await syncNow(admin, s.sourceId);
    expect(job.counts.scores.updated).toBe(3);
    expect(job.errorCount).toBe(0);
    expect(job.status).toBe('SUCCEEDED');
  });

  test('TC-109 Students can read during a sync', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    editSheet(s.sheet, (x) => (x.delayMs = 4000));
    const jobId = await startSync(admin, s.sourceId);
    for (let i = 0; i < 4; i++) {
      await student.page.goto('/student/results');
      await expect(student.page.getByRole('button', { name: /Logic/ })).toContainText('78.90');
    }
    editSheet(s.sheet, (x) => delete x.delayMs);
    await waitJob(admin, jobId);
  });

  test('TC-110 Sync never changes student passwords', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    await syncNow(admin, s.sourceId);
    await ok(student, 'GET', '/auth/me');
    const { apiLogin, NEW_PASSWORD } = await import('./support.js');
    await apiLogin(browser, s.students[0], NEW_PASSWORD);
  });
});

test.describe('Sync Job Details', () => {
  test('TC-111 Job progress updates by itself', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    editSheet(s.sheet, (x) => (x.delayMs = 3000));
    const jobId = await startSync(admin, s.sourceId);
    await admin.page.goto(`/admin/sync/${jobId}`);
    await expect(admin.page.getByText(/Running|Queued/).first()).toBeVisible();
    await expect(admin.page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });
    editSheet(s.sheet, (x) => delete x.delayMs);
  });

  async function jobWithIssues(admin: Session, s: Scenario) {
    editSheet(s.sheet, (x) => {
      x.tabs['Logic']![1]![5] = 'bad';
      x.tabs['PL']![1]![5] = null;
      x.tabs['Logic']![2]![5] = 'bad2';
    });
    return syncNow(admin, s.sourceId);
  }

  test('TC-112 Issues list and filters', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const job = await jobWithIssues(admin, s);
    const page = admin.page;
    await page.goto(`/admin/sync/${job.id}`);
    await expect(page.getByText('INVALID_MARK').first()).toBeVisible();
    await expect(main(page)).toContainText('Logic');
    await expect(main(page)).toContainText('bad');
    await page.getByLabel('Severity').selectOption({ label: 'Errors only' });
    await expect(page.getByText('MARK_CLEARED_IN_SOURCE')).toHaveCount(0);
    await page.getByLabel('Severity').selectOption({ label: 'Warnings only' });
    await expect(page.getByText('INVALID_MARK')).toHaveCount(0);
    await expect(page.getByText('MARK_CLEARED_IN_SOURCE').first()).toBeVisible();
    await page.getByLabel('Severity').selectOption({ label: 'Errors and warnings' });
    await page.getByLabel('Tab', { exact: true }).selectOption({ label: 'PL' });
    await expect(page.getByText('INVALID_MARK')).toHaveCount(0);
    remark(`${SIM}. Too few issues for a next page here; paging is in TC-196`);
  });

  test('TC-113 Parent job shows all workbook issues', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const second = sheetId(`T2${s.prefix}`);
    writeSheet(
      second,
      workbook(s.prefix, (x) => (x.tabs['Logic']![1]![5] = 'bad-two')),
    );
    const source = await connect(admin, s.terms[1]!.id, second, 'Second sheet');
    await confirmAll(admin, source.id);
    editSheet(s.sheet, (x) => (x.tabs['Logic']![1]![5] = 'bad-one'));
    clearLimits();
    const { jobId } = await ok(admin, 'POST', '/admin/sync', {
      scope: 'GENERATION',
      generationId: s.generationId,
    });
    const job = await waitJob(admin, jobId);
    await new Promise((r) => setTimeout(r, 500));
    const page = admin.page;
    await page.goto(`/admin/sync/${jobId}`);
    await expect(main(page)).toContainText('bad-one');
    await expect(main(page)).toContainText('bad-two');
    await page.getByLabel('Workbook').selectOption({ value: source.id });
    await expect(page.getByText('bad-one')).toHaveCount(0);
    const child = job.children.find((c: { source: { id: string } }) => c.source.id === source.id);
    await page.goto(`/admin/sync/${child.id}`);
    await expect(main(page)).toContainText('bad-two');
    await expect(page.getByText('bad-one')).toHaveCount(0);
  });

  test('TC-114 Retry a failed job', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    editSheet(s.sheet, (x) => (x.fail = 'SHEET_NOT_SHARED'));
    const failed = await syncNow(admin, s.sourceId);
    editSheet(s.sheet, (x) => delete x.fail);
    const page = admin.page;
    await page.goto(`/admin/sync/${failed.id}`);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByText('Retry queued.')).toBeVisible();
    await expect(page).not.toHaveURL(new RegExp(failed.id));
    await expect(
      page.getByRole('link', { name: /earlier|previous|retry of|original/i }).first(),
    ).toBeVisible();
  });

  test('TC-115 Sync center job filters', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const page = admin.page;
    await page.goto('/admin/sync');
    const statusFilter = page.getByLabel('Status').last();
    await statusFilter.selectOption({ label: 'Succeeded' });
    await expect(page).toHaveURL(/status=SUCCEEDED/);
    const genFilter = page.getByLabel('Generation').last();
    await genFilter.selectOption({ label: s.code });
    await expect(page).toHaveURL(/generationId=/);
    await page.getByRole('checkbox', { name: /Show per-source child jobs/ }).click();
    await expect(page).toHaveURL(/includeChildren=/);
    await page.reload();
    await expect(page).toHaveURL(/status=SUCCEEDED.*/);
    await expect(page.getByLabel('Status').last()).toHaveValue('SUCCEEDED');
    await expect(page.getByRole('checkbox', { name: /Show per-source child jobs/ })).toBeChecked();
  });

  test('TC-116 Unknown job address', async ({ browser }) => {
    const admin = await asAdmin(browser);
    await admin.page.goto('/admin/sync/00000000-0000-7000-8000-000000000000');
    await expect(admin.page.getByText(/Not found|Could not load/).first()).toBeVisible();
    expect(await main(admin.page).innerText()).not.toMatch(/stack|prisma|at \w+\.|INTERNAL/i);
  });

  test('TC-117 Retry button on a successful job', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const job = await syncNow(admin, s.sourceId);
    await admin.page.goto(`/admin/sync/${job.id}`);
    await expect(admin.page.getByText('Succeeded', { exact: true }).first()).toBeVisible();
    await expect(admin.page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  });

  test('TC-119 Job with no issues', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const prefix = await synced(admin, {
      edit: (x) => {
        for (const t of ['ENG', 'PL', 'BCU', 'MsOffice']) delete x.tabs[t];
      },
    });
    const job = await syncNow(admin, prefix.sourceId);
    await admin.page.goto(`/admin/sync/${job.id}`);
    await expect(admin.page.getByText('No issues').first()).toBeVisible();
    await expect(main(admin.page)).toContainText(/0 errors\s*·\s*0 warnings/);
  });
});

test.describe('Replace Sheet', () => {
  const editTerm = async (page: Page, generationId: string) => {
    await page.goto(`/admin/generations/${generationId}`);
    await page.getByRole('button', { name: 'Edit Term 1' }).click();
    return page.getByRole('dialog');
  };

  test('TC-120 Connect a new sheet', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const id = sheetId(`B${s.prefix}`);
    writeSheet(id, { ...workbook(s.prefix), title: 'Test Sheet B' });
    const page = admin.page;
    const d = await editTerm(page, s.generationId);
    await d.getByRole('button', { name: 'Replace' }).click();
    await d.getByLabel(/New spreadsheet URL/).fill(sheetUrl(id));
    await d.getByRole('button', { name: 'Check sheet' }).click();
    await expect(d.getByText('Test Sheet B')).toBeVisible();
    await expect(d.getByText('Student scores will not change yet')).toBeVisible();
    await d.getByRole('button', { name: 'Connect new sheet' }).click();
    await expect(page).toHaveURL(/\/admin\/sources\//);
    await expect(page.getByText('Pending').first()).toBeVisible();
    await expect(page.getByText('New sheet connected, not synced yet').first()).toBeVisible();
    await page.goto(`/admin/generations/${s.generationId}`);
    await expect(page.getByText('New sheet connected, not synced yet').first()).toBeVisible();
  });

  test('TC-121 Full replace with preview', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const b = await pendingSheet(admin, s, (x) => (x.tabs['Logic']![1]![5] = 55), false);
    const page = admin.page;
    await sourcePage(page, b.sourceId);
    await page.getByRole('button', { name: 'Detect tabs' }).click();
    await expect(page.getByText(/students found/).first()).toBeVisible();
    const tabs = (await ok(admin, 'GET', `/admin/sources/${b.sourceId}/mappings`)) as Parameters<
      typeof confirmBody
    >[0][];
    for (const tab of tabs) {
      await ok(
        admin,
        'POST',
        `/admin/sources/${b.sourceId}/mappings/${tab.id}/confirm`,
        confirmBody(tab),
      );
    }
    await page.reload();
    await page.getByRole('button', { name: 'Run preview' }).click();
    await expect(page.getByText(/1 changed/).first()).toBeVisible();
    for (const word of ['Changed', 'Unchanged', 'Invalid']) {
      await expect(page.getByRole('columnheader', { name: word }).first()).toBeVisible();
    }
    await page.getByRole('button', { name: 'Confirm preview' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(page).toHaveURL(/\/admin\/sync\//);
    await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });
    const status = (id: string) => sql(`select status from google_sheet_sources where id='${id}'`);
    expect(status(b.sourceId)).toBe('ACTIVE');
    expect(status(s.sourceId)).toBe('DISABLED');
  });

  test('TC-122 Students see nothing new until the sync', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    const before = await ok(student, 'GET', '/student/me/results');
    const b = await pendingSheet(admin, s, (x) => (x.tabs['Logic']![1]![5] = 55), false);
    const tabs = await detect(admin, b.sourceId);
    for (const tab of tabs) {
      const body = confirmBody(tab);
      if (tab.tabName === 'PL') body.subjectName = 'Personal Learning';
      body.columns = body.columns.map((c) =>
        (c as { name?: string }).name === 'Quiz 1' ? { ...c, name: 'First quiz' } : c,
      );
      await ok(admin, 'POST', `/admin/sources/${b.sourceId}/mappings/${tab.id}/confirm`, body);
    }
    const preview = await ok(admin, 'POST', `/admin/sources/${b.sourceId}/preview`);
    await ok(admin, 'POST', `/admin/sources/${b.sourceId}/preview/${preview.id}/confirm`);
    sql('select 1');
    expect(await ok(student, 'GET', '/student/me/results')).toEqual(before);
    const job = await syncNow(admin, b.sourceId);
    expect(job.status).toBe('SUCCEEDED');
    const after = JSON.stringify(await ok(student, 'GET', '/student/me/results'));
    expect(after).toContain('First quiz');
    expect(after).toContain('Personal Learning');
    expect((await course(student, 'Logic')).finalScore).toBe('75.40');
  });

  test('TC-123 Discard a new sheet', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    const before = await ok(student, 'GET', '/student/me/results');
    const b = await pendingSheet(admin, s, (x) => (x.tabs['Logic']![1]![5] = 55));
    const page = admin.page;
    await sourcePage(page, b.sourceId);
    await page.getByRole('button', { name: 'Discard new sheet' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByText(/discarded/i).first()).toBeVisible();
    expect(sql(`select status from google_sheet_sources where id='${s.sourceId}'`)).toBe('ACTIVE');
    expect(await ok(student, 'GET', '/student/me/results')).toEqual(before);
  });

  test('TC-124 Go back to an earlier sheet', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const b = await pendingSheet(admin, s);
    await syncNow(admin, b.sourceId);
    const back = await ok(admin, 'POST', `/admin/terms/${s.termId}/sources/change`, {
      url: sheetUrl(s.sheet),
      label: 'Back again',
    });
    expect(back.id).toBe(s.sourceId);
    const tabs = await detect(admin, back.id);
    for (const tab of tabs) {
      await ok(
        admin,
        'POST',
        `/admin/sources/${back.id}/mappings/${tab.id}/confirm`,
        confirmBody(tab),
      );
    }
    const preview = await ok(admin, 'POST', `/admin/sources/${back.id}/preview`);
    await ok(admin, 'POST', `/admin/sources/${back.id}/preview/${preview.id}/confirm`);
    await syncNow(admin, back.id);
    expect(sql(`select status from google_sheet_sources where id='${s.sourceId}'`)).toBe('ACTIVE');
  });

  test('TC-125 New subject on a released term is visible at once', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    const b = await pendingSheet(admin, s, (x) => {
      x.tabs['Science'] = [
        ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'Final 100%'],
        [s.students[0], 'DARA', 'SOK', 88],
      ];
    });
    expect((await syncNow(admin, b.sourceId)).status).toBe('SUCCEEDED');
    await admin.page.goto(`/admin/generations/${s.generationId}`);
    await expect(main(admin.page)).toContainText('Released');
    expect(await course(student, 'Science')).toBeDefined();
    await ok(admin, 'POST', `/admin/terms/${s.termId}/release`, { visible: true });
    expect((await course(student, 'Science')).finalScore).toBe('88.00');
  });

  test('TC-126 Same sheet as the active one', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const d = await editTerm(admin.page, s.generationId);
    await d.getByRole('button', { name: 'Replace' }).click();
    await d.getByLabel(/New spreadsheet URL/).fill(sheetUrl(s.sheet));
    await d.getByRole('button', { name: 'Check sheet' }).click();
    await expect(admin.page.getByText(/already.*active sheet/i).first()).toBeVisible();
    await expect(d.getByRole('button', { name: 'Connect new sheet' })).toHaveCount(0);
  });

  test('TC-127 Sync before the preview is confirmed', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const b = await pendingSheet(admin, s, undefined, false);
    await sourcePage(admin.page, b.sourceId);
    await expect(admin.page.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  });

  test('TC-128 Sheet edited after the preview', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    const before = await ok(student, 'GET', '/student/me/results');
    const b = await pendingSheet(admin, s);
    editSheet(b.id, (x) => (x.tabs['Logic']![1]![5] = 33));
    const job = await syncNow(admin, b.sourceId);
    expect(job).toMatchObject({ status: 'FAILED', failureCode: 'PREVIEW_STALE' });
    expect(sql(`select status from google_sheet_sources where id='${s.sourceId}'`)).toBe('ACTIVE');
    expect(await ok(student, 'GET', '/student/me/results')).toEqual(before);
  });

  test('TC-129 New sheet has a bad mark', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const b = await pendingSheet(admin, s, (x) => (x.tabs['Logic']![1]![5] = 'abc'), false);
    const tabs = await detect(admin, b.sourceId);
    for (const tab of tabs) {
      await ok(
        admin,
        'POST',
        `/admin/sources/${b.sourceId}/mappings/${tab.id}/confirm`,
        confirmBody(tab),
      );
    }
    await sourcePage(admin.page, b.sourceId);
    await admin.page.getByRole('button', { name: 'Run preview' }).click();
    await expect(admin.page.getByText('This sheet cannot be synced yet')).toBeVisible();
    await expect(admin.page.getByRole('button', { name: 'Confirm preview' })).toHaveCount(0);
  });

  test('TC-130 Replace during a running sync', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    editSheet(s.sheet, (x) => (x.delayMs = 6000));
    const jobId = await startSync(admin, s.sourceId);
    const d = await editTerm(admin.page, s.generationId);
    await expect(d.getByRole('button', { name: 'Replace' })).toBeDisabled();
    await expect(d.getByRole('button', { name: 'Remove' })).toBeDisabled();
    await expect(d.getByText(/sync of this term is running/i)).toBeVisible();
    editSheet(s.sheet, (x) => delete x.delayMs);
    await waitJob(admin, jobId);
  });

  test('TC-131 Archived generation with a pending sheet', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const b = await pendingSheet(admin, s, undefined, true);
    await ok(admin, 'POST', `/admin/generations/${s.generationId}/archive`);
    const page = admin.page;
    await sourcePage(page, b.sourceId);
    const preview = await call(admin, 'POST', `/admin/sources/${b.sourceId}/preview`);
    const discard = await call(admin, 'POST', `/admin/sources/${b.sourceId}/discard`);
    expect([preview.status(), discard.status()]).toEqual([409, 409]);
    const run = page.getByRole('button', { name: /Run preview|Run again/ }).first();
    if (await run.isEnabled().catch(() => false)) {
      await run.click();
      await expect(page.getByText(/archived/i).first()).toBeVisible();
    } else {
      await expect(page.getByText(/archived/i).first()).toBeVisible();
    }
  });

  test('TC-132 Blank cells are counted before they clear marks', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const b = await pendingSheet(admin, s, (x) => (x.tabs['Logic']![1]![5] = null), false);
    const tabs = await detect(admin, b.sourceId);
    for (const tab of tabs) {
      await ok(
        admin,
        'POST',
        `/admin/sources/${b.sourceId}/mappings/${tab.id}/confirm`,
        confirmBody(tab),
      );
    }
    await sourcePage(admin.page, b.sourceId);
    await admin.page.getByRole('button', { name: 'Run preview' }).click();
    await expect(
      admin.page.getByText(/1 blank cells? clears? a stored mark/).first(),
    ).toBeVisible();
  });

  test('TC-133 Missing students keep their scores', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const b = await pendingSheet(
      admin,
      s,
      (x) => {
        for (const g of Object.values(x.tabs)) {
          for (let i = g.length - 1; i >= 0; i--) if (g[i]![0] === s.students[2]) g.splice(i, 1);
        }
      },
      false,
    );
    const tabs = await detect(admin, b.sourceId);
    for (const tab of tabs) {
      await ok(
        admin,
        'POST',
        `/admin/sources/${b.sourceId}/mappings/${tab.id}/confirm`,
        confirmBody(tab),
      );
    }
    const page = admin.page;
    await sourcePage(page, b.sourceId);
    await page.getByRole('button', { name: 'Run preview' }).click();
    await expect(main(page)).toContainText(s.students[2]);
    await page.getByRole('button', { name: 'Confirm preview' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(page).toHaveURL(/\/admin\/sync\//);
    await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });
    const row = await studentRow(admin, s.students[2]);
    await page.goto(`/admin/students/${row.id}`);
    await expect(page.getByRole('button', { name: /Logic/ })).toContainText('70.00');
  });

  test('TC-134 Workbooks by term shows the review state', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const b = await pendingSheet(admin, s, undefined, false);
    const page = admin.page;
    const check = async (text: string) => {
      await page.goto('/admin/sync');
      await expect(page.getByText(text).first()).toBeVisible();
    };
    await check('Not previewed');
    const tabs = await detect(admin, b.sourceId);
    for (const tab of tabs) {
      await ok(
        admin,
        'POST',
        `/admin/sources/${b.sourceId}/mappings/${tab.id}/confirm`,
        confirmBody(tab),
      );
    }
    const preview = await ok(admin, 'POST', `/admin/sources/${b.sourceId}/preview`);
    await check('Preview not confirmed');
    await ok(admin, 'POST', `/admin/sources/${b.sourceId}/preview/${preview.id}/confirm`);
    await check('Preview confirmed, ready to sync');
  });
});

test.describe('Remove Sheet', () => {
  const removeDialog = async (page: Page, generationId: string) => {
    await page.goto(`/admin/generations/${generationId}`);
    await page.getByRole('button', { name: 'Edit Term 1' }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('button', { name: 'Remove' }).click();
    return page.getByRole('alertdialog');
  };

  test('TC-135 Remove a synced sheet', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    const a = await removeDialog(admin.page, s.generationId);
    await a.getByRole('button', { name: 'Remove sheet' }).click();
    await expect(
      admin.page.getByText('Sheet removed. Existing scores stay as they are.'),
    ).toBeVisible();
    await expect(admin.page.getByText(/No sheet connected/).first()).toBeVisible();
    expect((await course(student, 'Logic')).finalScore).toBe('78.90');
  });

  test('TC-136 Remove a sheet that never synced', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin, { confirm: false });
    const a = await removeDialog(admin.page, s.generationId);
    await a.getByRole('button', { name: 'Remove sheet' }).click();
    await expect(admin.page.getByText(/No sheet connected/).first()).toBeVisible();
    await ok(admin, 'POST', `/admin/terms/${s.termId}/sources`, {
      url: sheetUrl(s.sheet),
      label: 'Again',
    });
  });

  test('TC-137 Remove while a new sheet is waiting', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    await pendingSheet(admin, s, undefined, false);
    await admin.page.goto(`/admin/generations/${s.generationId}`);
    await admin.page.getByRole('button', { name: 'Edit Term 1' }).click();
    const d = admin.page.getByRole('dialog');
    await expect(d.getByRole('button', { name: 'Discard new sheet' })).toBeVisible();
    await expect(d.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  });

  test('TC-138 Removal asks for confirmation', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin);
    const a = await removeDialog(admin.page, s.generationId);
    await expect(a).toContainText(/stop|sync/i);
    await expect(a).toContainText(/keep/i);
    await admin.page.keyboard.press('Escape');
    await expect(a).toHaveCount(0);
    expect(sql(`select status from google_sheet_sources where id='${s.sourceId}'`)).toBe('ACTIVE');
  });
});

test.describe('Release Scores', () => {
  test('TC-139 Release a term', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin, { release: false });
    const student = await activate(browser, admin, s.students[0]);
    const page = admin.page;
    await page.goto(`/admin/generations/${s.generationId}`);
    await page.getByRole('button', { name: 'Release scores' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Release scores' }).click();
    await expect(page.getByText(/released/i).first()).toBeVisible();
    await expect(page.getByText('Released', { exact: true })).toBeVisible();
    expect((await course(student, 'Logic')).finalScore).toBe('78.90');
  });

  test('TC-140 Hide a term', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    const page = admin.page;
    await page.goto(`/admin/generations/${s.generationId}`);
    await page.getByRole('button', { name: 'Hide scores' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: /Hide/ }).click();
    await expect(page.getByText(/hidden/i).first()).toBeVisible();
    await student.page.goto('/student/results');
    await expect(student.page.getByText('No results for this term yet')).toBeVisible();
  });

  test('TC-141 No release button on a term with no subjects', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const g = await newGeneration(admin);
    await admin.page.goto(`/admin/generations/${g.id}`);
    await expect(admin.page.getByText('Not synced').first()).toBeVisible();
    await expect(admin.page.getByRole('button', { name: 'Release scores' })).toHaveCount(0);
  });

  test('TC-142 Hidden term by direct address', async ({ browser }) => {
    const { admin, s, student } = await studentAndScenario(browser);
    const logic = await course(student, 'Logic');
    await student.page.goto(`/student/courses/${logic.offeringId}`);
    await expect(student.page.getByText('78.90').first()).toBeVisible();
    await ok(admin, 'POST', `/admin/terms/${s.termId}/release`, { visible: false });
    await student.page.reload();
    await expect(student.page.getByText(/Not found|Could not load/).first()).toBeVisible();
    await expect(student.page.getByText('78.90')).toHaveCount(0);
  });

  test('TC-143 New sync does not release scores', async ({ browser }) => {
    const admin = await asAdmin(browser);
    const s = await synced(admin, { release: false });
    const student = await activate(browser, admin, s.students[0]);
    await syncNow(admin, s.sourceId);
    expect(await ok(student, 'GET', '/student/me/courses')).toEqual([]);
  });
});

void readSheet;
