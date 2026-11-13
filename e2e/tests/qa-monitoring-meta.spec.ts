import { expect, test, type Locator, type Page } from '@playwright/test';
import { applyGradeDefaults, applyTermDefaults, createPrismaClient } from '@ssrs/database';
import { assertTestDatabaseUrl } from '@ssrs/database/testing';
import { TERM_FIXTURE_SPREADSHEET_ID } from '@ssrs/sheets/testing';
import { loadRootEnv } from '@ssrs/shared/node';
import { E2E } from '../support/stack.js';

/**
 * QA, independent of monitoring.spec.ts: the Term picker's status icons for every release state
 * (fully, partly, not released, no subjects, only archived subjects), keyboard use, component
 * headers and sorting on every column, and a blocked workbook connection shown in the dialog and
 * the audit log. Seeds its own generation QAX2027 (made-up students QAX-0001…0004) in ssrs_test;
 * never connects a fixture spreadsheet successfully, so other spec files are unaffected.
 */
test.describe.configure({ mode: 'serial' });

const GEN = { code: 'QAX2027', name: 'QA Picker 2027' };
const code = (i: number) => `QAX-${String(i).padStart(4, '0')}`;
/** Names in the reverse order of IDs, so sorting by name and by ID differ. */
const NAMES = ['QAX Delta', 'QAX Charlie', 'QAX Bravo', 'QAX Alpha'];
const CLASSES = ['A', 'B', 'A', 'B'];
/** Lab /50 · 7.5%, Quiz /100 · 1.25%, Exam /100 · 91.25%. */
const CRITERIA = [
  { name: 'Lab', max: 50, weight: 7.5 },
  { name: 'Quiz', max: 100, weight: 1.25 },
  { name: 'Exam', max: 100, weight: 91.25 },
];
const MARKS = [
  [10, 90, 40],
  [40, 20, 80],
  [25, 60, 60],
  [50, 40, 20],
];

let generationId = '';
let subjectId = '';
let studentId = '';

test.beforeAll(async () => {
  loadRootEnv();
  const prisma = createPrismaClient({
    connectionString: assertTestDatabaseUrl(process.env['TEST_DATABASE_URL']),
    poolMax: 1,
  });
  try {
    const gen = await prisma.generation.create({
      data: {
        ...GEN,
        startDate: new Date('2031-01-06'),
        terms: { create: [1, 2, 3, 4, 5].map((n) => ({ number: n, name: `Term ${n}` })) },
      },
      include: { terms: { orderBy: { number: 'asc' } } },
    });
    generationId = gen.id;
    await applyTermDefaults(prisma, gen.id);
    await applyGradeDefaults(prisma, gen.id);
    const [t1, t2, t3, , t5] = gen.terms;
    const general = await prisma.program.findUniqueOrThrow({ where: { code: 'GENERAL' } });
    const classes = await prisma.termClass.findMany({ where: { termId: t1!.id } });
    const registrar = await prisma.user.findUniqueOrThrow({ where: { username: E2E.adminUser } });
    for (const [n, term] of [t1!, t2!].entries()) {
      await prisma.googleSheetSource.create({
        data: {
          generationId: gen.id,
          termId: term.id,
          spreadsheetId: `1QaPickerE2eSheetT${n + 1}000000000000000000000`.slice(0, 40),
          label: `QA picker T${n + 1}`,
          createdById: registrar.id,
          lastSyncedAt: new Date(),
        },
      });
    }

    const students = [];
    for (let i = 1; i <= 4; i++) {
      const user = await prisma.user.create({
        data: { username: code(i), role: 'STUDENT', status: 'PENDING', passwordHash: '!locked:qa' },
      });
      const cls = CLASSES[i - 1]!;
      const s = await prisma.student.create({
        data: {
          studentCode: code(i),
          userId: user.id,
          generationId: gen.id,
          fullName: NAMES[i - 1]!,
          className: cls,
          programId: general.id,
        },
      });
      await prisma.studentTerm.create({
        data: {
          studentId: s.id,
          termId: t1!.id,
          generationId: gen.id,
          programId: general.id,
          classId: classes.find((c) => c.name === cls)!.id,
          programSource: 'ADMIN',
        },
      });
      students.push(s.id);
    }
    studentId = students[0]!;

    const offering = async (
      termId: string,
      key: string,
      visibility: 'VISIBLE' | 'HIDDEN',
      status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
    ) => {
      const course = await prisma.course.create({ data: { code: key, name: key } });
      const o = await prisma.courseOffering.create({
        data: {
          termId,
          generationId: gen.id,
          courseId: course.id,
          externalKey: `${key}-ext`,
          title: key.replaceAll('_', ' '),
          visibility,
          status,
        },
      });
      return { course, offering: o };
    };

    // Term 1: two subjects, both released. The first has marks.
    const main = await offering(t1!.id, 'QAX_WEIGHTS', 'VISIBLE');
    subjectId = main.course.id;
    await offering(t1!.id, 'QAX_SECOND', 'VISIBLE');
    const items = [];
    const criterionIds = [];
    for (const [n, c] of CRITERIA.entries()) {
      const criterion = await prisma.assessmentCriterion.create({
        data: {
          offeringId: main.offering.id,
          key: `C${n + 1}`,
          name: c.name,
          displayOrder: n + 1,
        },
      });
      criterionIds.push(criterion.id);
      items.push({ criterionId: criterion.id, maxMark: c.max, weight: c.weight });
    }
    const scheme = await prisma.gradingScheme.create({
      data: {
        offeringId: main.offering.id,
        version: 1,
        status: 'DRAFT',
        origin: 'ADMIN',
        totalWeight: 100,
        items: { create: items },
      },
    });
    await prisma.gradingScheme.update({
      where: { id: scheme.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    for (const [k, sid] of students.entries()) {
      const enrollment = await prisma.enrollment.create({
        data: { studentId: sid, offeringId: main.offering.id },
      });
      for (const [n, criterionId] of criterionIds.entries()) {
        await prisma.assessmentScore.create({
          data: {
            enrollmentId: enrollment.id,
            offeringId: main.offering.id,
            criterionId,
            status: 'RECORDED',
            mark: MARKS[k]![n]!,
          },
        });
      }
    }

    // Term 2: partly released. Term 3: subjects, none released. Term 4: none.
    // Term 5: only an archived subject (counts as no subjects).
    await offering(t2!.id, 'QAX_T2_SHOWN', 'VISIBLE');
    await offering(t2!.id, 'QAX_T2_HIDDEN', 'HIDDEN');
    await offering(t3!.id, 'QAX_T3_HIDDEN', 'HIDDEN');
    await offering(t5!.id, 'QAX_T5_ARCHIVED', 'VISIBLE', 'ARCHIVED');
  } finally {
    await prisma.$disconnect();
  }
});

let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await (await browser.newContext()).newPage();
  await admin.goto('/login');
  await admin.getByLabel(/Username or student ID/).fill(E2E.adminUser);
  await admin.locator('input[name=password]').fill(E2E.adminPassword);
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await expect(admin).toHaveURL(/\/admin$/);
});

const termPicker = (page: Page) => page.getByRole('combobox', { name: 'Term' });
const tooltip = (page: Page) => page.locator('[data-slot=tooltip-content][data-open]');
const pageUrl = (term: number) => `/admin/monitoring?generation=${generationId}&term=${term}`;
/** Status icons inside an element (the check mark of the selected option is not one). */
const statusIcons = (el: Locator) => el.locator('[data-term-status]');
/** Text a sighted user sees: without screen-reader-only text. */
async function visibleText(el: Locator): Promise<string> {
  let text = (await el.textContent()) ?? '';
  for (const hidden of await el.locator('.sr-only').allTextContents()) {
    text = text.replace(hidden, '');
  }
  return text.trim();
}

const EXPECTED = [
  { name: 'Term 1', status: null, badge: 'Released to students' },
  { name: 'Term 2', status: 'Not released to students', badge: 'Partly released to students' },
  { name: 'Term 3', status: 'Not released to students', badge: 'Not released to students' },
  { name: 'Term 4', status: 'No subjects', badge: 'Nothing synced · not released' },
  { name: 'Term 5', status: 'No subjects', badge: 'Nothing synced · not released' },
] as const;

test('QA-P01 every option: name, at most one icon of the right kind, accessible label, no status text', async () => {
  await admin.goto(pageUrl(1));
  const term = termPicker(admin);
  await expect(term).toHaveText('Term 1');
  await expect(statusIcons(term)).toHaveCount(0);
  await term.click();
  const options = admin.getByRole('listbox').getByRole('option');
  await expect(options).toHaveCount(5);
  for (const [i, e] of EXPECTED.entries()) {
    const option = options.nth(i);
    await expect(option).toHaveAccessibleName(e.status ? `${e.name}, ${e.status}` : e.name);
    await expect(statusIcons(option)).toHaveCount(e.status ? 1 : 0);
    if (e.status) {
      await expect(statusIcons(option)).toHaveAttribute('data-term-status', e.status);
      // One svg for the status icon (plus the check mark only on the selected option).
      const svgs = await option.locator('svg').count();
      expect(svgs, e.name).toBeLessThanOrEqual(i === 0 ? 2 : 1);
    }
    // Visible text is the name only: no status words outside the screen-reader text.
    expect(await visibleText(option), e.name).toBe(e.name);
  }
  // Correct icon per kind: CircleSlash for no subjects, EyeOff for not released.
  await expect(options.nth(3).locator('svg.lucide-circle-slash')).toHaveCount(1);
  await expect(options.nth(4).locator('svg.lucide-circle-slash')).toHaveCount(1);
  for (const i of [1, 2]) await expect(options.nth(i).locator('svg.lucide-eye-off')).toHaveCount(1);
  // Tooltips on hover.
  for (const i of [1, 4]) {
    await statusIcons(options.nth(i)).hover();
    await expect(tooltip(admin)).toHaveText(EXPECTED[i]!.status!);
  }
  await admin.keyboard.press('Escape');
  await expect(admin.getByRole('listbox')).toHaveCount(0);
});

test('QA-P02 each term: closed trigger shows name + its icon, URL keeps the term, page badge unchanged', async () => {
  for (const [i, e] of EXPECTED.entries()) {
    await admin.goto(pageUrl(i + 1));
    const term = termPicker(admin);
    await expect(term).toContainText(e.name);
    expect(await visibleText(term)).toBe(e.name);
    await expect(statusIcons(term)).toHaveCount(e.status ? 1 : 0);
    if (e.status) {
      await statusIcons(term).hover();
      await expect(tooltip(admin)).toHaveText(e.status);
    }
    await expect(admin.getByText(e.badge, { exact: true }).first()).toBeVisible();
    await expect(admin).toHaveURL(new RegExp(`term=${i + 1}(&|$)`));
  }
});

test('QA-P03 keyboard: Home/End, arrows, Enter selects; Escape keeps the term; type-to-select', async () => {
  await admin.goto(pageUrl(1));
  const term = termPicker(admin);
  await term.focus();
  await admin.keyboard.press('Enter');
  const list = admin.getByRole('listbox');
  await expect(list).toBeVisible();
  await admin.keyboard.press('End');
  await admin.keyboard.press('Enter');
  await expect(admin).toHaveURL(/term=5(&|$)/);
  await expect(term).toBeFocused();

  await admin.keyboard.press('ArrowDown');
  await expect(list).toBeVisible();
  await admin.keyboard.press('Home');
  await admin.keyboard.press('ArrowDown');
  await admin.keyboard.press('ArrowDown');
  await admin.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(admin).toHaveURL(/term=5(&|$)/);

  await admin.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await admin.keyboard.type('Term 3');
  await admin.keyboard.press('Enter');
  await expect(admin).toHaveURL(/term=3(&|$)/);
  await expect(statusIcons(term)).toHaveAttribute('data-term-status', 'Not released to students');

  // Back restores the earlier term, the trigger follows.
  await admin.goBack();
  await expect(admin).toHaveURL(/term=5(&|$)/);
  await expect(termPicker(admin)).toContainText('Term 5');
});

test('QA-P04 visible focus ring on the trigger', async () => {
  await admin.goto(pageUrl(1));
  const term = termPicker(admin);
  await term.focus();
  await admin.keyboard.press('Shift+Tab');
  await admin.keyboard.press('Tab');
  await expect(term).toBeFocused();
  const shadow = await term.evaluate(
    (node) =>
      (
        globalThis as unknown as { getComputedStyle(e: unknown): { boxShadow: string } }
      ).getComputedStyle(node).boxShadow,
  );
  expect(shadow).not.toBe('none');
});

test('QA-P05 phone width: picker fits, closed trigger shows the icon, options selectable', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 320, height: 640 },
    storageState: await admin.context().storageState(),
  });
  const phone = await ctx.newPage();
  try {
    await phone.goto(pageUrl(2));
    const term = termPicker(phone);
    await expect(statusIcons(term)).toHaveCount(1);
    const tb = (await term.boundingBox())!;
    expect(tb.x + tb.width).toBeLessThanOrEqual(320);
    await term.click();
    const list = phone.getByRole('listbox');
    const box = (await list.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(
      await phone.evaluate<boolean>(
        'document.documentElement.scrollWidth > document.documentElement.clientWidth',
      ),
    ).toBe(false);
    await list.getByRole('option', { name: /^Term 4/ }).click();
    await expect(phone).toHaveURL(/term=4(&|$)/);
  } finally {
    await ctx.close();
  }
});

test('QA-P06 Sync Center still uses its own controls (no Term picker combobox)', async () => {
  await admin.goto('/admin/sync');
  await expect(admin.getByText(/Application error|Unhandled Runtime Error/)).toHaveCount(0);
  await expect(admin.locator('[data-slot=select-trigger]')).toHaveCount(0);
  await expect(admin.locator('[data-term-status]')).toHaveCount(0);
});

const subjectUrl = (extra = '') =>
  `/admin/monitoring/${generationId}/1/${subjectId}${extra ? `?${extra}` : ''}`;
const headers = (page: Page) =>
  page
    .getByRole('table')
    .last()
    .locator('thead th')
    .filter({ has: page.getByRole('button', { name: /^Sort by / }) });
const rows = (page: Page) => page.getByRole('table').last().locator('tbody tr');

async function column(page: Page, index: number): Promise<string[]> {
  return rows(page).evaluateAll<string[], number>(
    (trs, i) =>
      trs.map((tr) => ((tr as unknown as { cells: { innerText: string }[] }).cells[i]?.innerText ?? '').trim()),
    index,
  );
}

test('QA-H01 headers: "name · weight%", decimals, max only when not 100; tooltips with weight and max', async () => {
  await admin.goto(subjectUrl());
  await expect(rows(admin)).toHaveCount(4);
  await expect(headers(admin)).toHaveText([
    'Student ID',
    'Name',
    'Program',
    'Class',
    'Lab · 7.5% · /50',
    'Quiz · 1.25%',
    'Exam · 91.25%',
    'Total',
    'Grade',
    'Level',
  ]);
  const thead = admin.getByRole('table').last().locator('thead');
  await expect(thead).not.toContainText('/ 100');
  await expect(thead).not.toContainText('/100');
  for (const [name, detail] of [
    ['Lab', 'Lab: weight 7.5%, out of 50'],
    ['Quiz', 'Quiz: weight 1.25%, out of 100'],
    ['Exam', 'Exam: weight 91.25%, out of 100'],
  ] as const) {
    const button = admin.getByRole('button', { name: `Sort by ${name}`, exact: true });
    // One line.
    const box = (await button.boundingBox())!;
    expect(box.height, name).toBeLessThan(32);
    await button.hover();
    await expect(tooltip(admin)).toHaveText(detail);
  }
  // Non-component headers have no tooltip and no suffix.
  await admin.getByRole('button', { name: 'Sort by Total', exact: true }).hover();
  await admin.waitForTimeout(800);
  await expect(tooltip(admin).filter({ hasText: 'Total' })).toHaveCount(0);
});

const SORTS = [
  { label: 'Student ID', col: 0, numeric: false },
  { label: 'Name', col: 1, numeric: false },
  { label: 'Program', col: 2, numeric: false },
  { label: 'Class', col: 3, numeric: false },
  { label: 'Lab', col: 4, numeric: true },
  { label: 'Quiz', col: 5, numeric: true },
  { label: 'Exam', col: 6, numeric: true },
  { label: 'Total', col: 7, numeric: true },
  { label: 'Grade', col: 8, numeric: false },
  { label: 'Level', col: 9, numeric: false },
];

const sortButton = (page: Page, label: string) =>
  page.getByRole('button', { name: new RegExp(`^Sort by ${label}(, (ascending|descending))?$`) });

for (const s of SORTS) {
  test(`QA-H02 sorting by ${s.label}: ascending then descending`, async () => {
    await admin.goto(subjectUrl());
    await expect(rows(admin)).toHaveCount(4);
    const th = headers(admin).nth(SORTS.indexOf(s));
    // Student ID is the default (ascending): click until ascending.
    for (let i = 0; i < 2 && (await th.getAttribute('aria-sort')) !== 'ascending'; i++) {
      await sortButton(admin, s.label).click();
      await expect(th).toHaveAttribute('aria-sort', /ascending|descending/);
    }
    await expect(th).toHaveAttribute('aria-sort', 'ascending');
    await expect(rows(admin)).toHaveCount(4);
    const asc = await column(admin, s.col);
    if (s.numeric) {
      const n = asc.map(Number);
      expect(n, `${s.label} asc ${asc}`).toEqual(n.toSorted((a, b) => a - b));
    } else if (s.col <= 1) {
      expect(asc, `${s.label} asc`).toEqual(asc.toSorted((a, b) => a.localeCompare(b)));
    }
    await sortButton(admin, s.label).click();
    await expect(th).toHaveAttribute('aria-sort', 'descending');
    await expect(admin).toHaveURL(/order=desc/);
    await expect
      .poll(async () => (await column(admin, s.col)).join('|'))
      .not.toBe(s.numeric || s.col <= 1 ? asc.join('|') : '__never__');
    const desc = await column(admin, s.col);
    if (s.numeric) {
      const n = desc.map(Number);
      expect(n, `${s.label} desc ${desc}`).toEqual(n.toSorted((a, b) => b - a));
    } else if (s.col <= 1) {
      expect(desc, `${s.label} desc`).toEqual(desc.toSorted((a, b) => b.localeCompare(a)));
    }
    // A refresh keeps the order.
    await admin.reload();
    await expect(headers(admin).nth(SORTS.indexOf(s))).toHaveAttribute('aria-sort', 'descending');
    await expect.poll(async () => (await column(admin, s.col)).join('|')).toBe(desc.join('|'));
  });
}

test('QA-H03 the admin student page does not use the monitoring header format', async () => {
  await admin.goto(`/admin/students/${studentId}?term=1`);
  await expect(admin.getByText(code(1)).first()).toBeVisible();
  await expect(admin.getByText('QAX WEIGHTS').first()).toBeVisible();
  await expect(admin.getByText('Lab · 7.5% · /50')).toHaveCount(0);
});

test('QA-A01 a blocked connection: the dialog shows found and selected values; the audit log lists it', async () => {
  await admin.goto(`/admin/generations/${generationId}`);
  const connectButtons = admin.getByRole('button', { name: 'Connect workbook' });
  await expect(connectButtons.first()).toBeVisible();
  await connectButtons.first().click();
  const dialog = admin.getByRole('dialog');
  const title = await dialog.getByRole('heading').first().innerText();
  const termNumber = Number(/Term (\d+)/.exec(title)?.[1]);
  expect(termNumber).toBeGreaterThan(2);
  await dialog
    .getByLabel(/Spreadsheet URL/)
    .fill(`https://docs.google.com/spreadsheets/d/${TERM_FIXTURE_SPREADSHEET_ID}/edit`);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(
    dialog.getByText(
      `This workbook is for GEN2027, Term 1. You selected ${GEN.code}, Term ${termNumber}. Choose the matching term or check the workbook.`,
    ),
  ).toBeVisible();
  await expect(admin).toHaveURL(new RegExp(`/admin/generations/${generationId}`));

  await admin.goto('/admin/audit?action=source.');
  const row = admin.getByRole('row').filter({ hasText: 'source.connect.blocked' }).first();
  await expect(row).toBeVisible();
  await expect(row).not.toContainText('docs.google.com');
});
