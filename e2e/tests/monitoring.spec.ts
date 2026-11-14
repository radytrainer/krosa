import { expect, test, type Page } from '@playwright/test';
import { applyGradeDefaults, applyTermDefaults, createPrismaClient } from '@ssrs/database';
import { assertTestDatabaseUrl } from '@ssrs/database/testing';
import { loadRootEnv } from '@ssrs/shared/node';
import { E2E } from '../support/stack.js';

/**
 * Admin subject monitoring through the real web app and API (docs/decisions.md M1–M8).
 * Self-contained: seeds its own generation (QAM2027, made-up students QAM-0001…0030) directly in
 * ssrs_test, so it does not depend on the order of the other spec files and does not touch their
 * GEN2027 data. Checks that selections survive refresh, bookmark and Back (AC11) and that a
 * teacher comment containing markup is shown as plain text (AC16).
 */
test.describe.configure({ mode: 'serial' });

const GEN = { code: 'QAM2027', name: 'QA Monitoring 2027' };
const STUDENTS = 30;
const code = (i: number) => `QAM-${String(i).padStart(4, '0')}`;
const COMMENT = '<b>Bold?</b> & <i>no</i>\nLine two';

const SHEET_ID = '1QaMonitoringE2eSheet0000000000000000000';
let generationId = '';
let subjectId = '';
let sourceId = '';
let failSubjectId = '';
const headerSubjectIds: Record<string, string> = {};

/** Logic's components in packages/sheets/src/testing/term-workbook-fixture.ts, then odd ones. */
const HEADER_SUBJECTS = [
  {
    code: 'QAM_SHEET_LOGIC',
    title: 'QA Sheet Logic',
    criteria: [
      { name: 'Quiz 1', max: 100, weight: 10 },
      { name: 'Quiz 2', max: 100, weight: 10 },
      { name: 'Homework', max: 100, weight: 10 },
      { name: 'Participation', max: 100, weight: 10 },
      { name: 'MIDTERM', max: 100, weight: 25 },
      { name: 'FINAL', max: 100, weight: 35 },
    ],
  },
  {
    code: 'QAM_ODD',
    title: 'QA Odd Weights',
    criteria: [
      { name: 'Lab', max: 50, weight: 7.5 },
      { name: 'Short quiz', max: 100, weight: 1.25 },
      { name: 'Exam', max: 100, weight: 91.25 },
    ],
  },
] as const;

/** Marks per student (Quiz, Final), both out of 100 and 50% each. Student 2: Final blank. */
function marks(i: number, subject: 'logic' | 'bcu'): [number | null, number | null] {
  if (subject === 'bcu') return i % 3 === 0 ? [90, 90] : [20, 30];
  if (i === 2) return [80, null];
  return [50 + ((i * 7) % 50), 55 + ((i * 3) % 45)];
}

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
        startDate: new Date('2030-01-07'),
        terms: { create: [1, 2, 3, 4, 5].map((n) => ({ number: n, name: `Term ${n}` })) },
      },
      include: { terms: { orderBy: { number: 'asc' } } },
    });
    generationId = gen.id;
    await applyTermDefaults(prisma, gen.id);
    await applyGradeDefaults(prisma, gen.id);
    const term = gen.terms[0]!;
    const general = await prisma.program.findUniqueOrThrow({ where: { code: 'GENERAL' } });
    const classes = await prisma.termClass.findMany({ where: { termId: term.id } });
    const classOf = (name: string) => classes.find((c) => c.name === name)!;
    // As after a sync: the term's active sheet, synced.
    const registrar = await prisma.user.findUniqueOrThrow({ where: { username: E2E.adminUser } });
    sourceId = (
      await prisma.googleSheetSource.create({
        data: {
          generationId: gen.id,
          termId: term.id,
          spreadsheetId: SHEET_ID,
          label: 'QA monitoring',
          createdById: registrar.id,
          lastSyncedAt: new Date(),
        },
      })
    ).id;

    const students = [];
    for (let i = 1; i <= STUDENTS; i++) {
      const user = await prisma.user.create({
        data: { username: code(i), role: 'STUDENT', status: 'PENDING', passwordHash: '!locked:qa' },
      });
      const cls = i <= 15 ? 'A' : 'B';
      const s = await prisma.student.create({
        data: {
          studentCode: code(i),
          userId: user.id,
          generationId: gen.id,
          fullName: `QAM Student ${String(i).padStart(3, '0')}`,
          className: cls,
          programId: general.id,
        },
      });
      await prisma.studentTerm.create({
        data: {
          studentId: s.id,
          termId: term.id,
          generationId: gen.id,
          programId: general.id,
          classId: classOf(cls).id,
          programSource: 'ADMIN',
        },
      });
      students.push({ i, id: s.id });
    }

    for (const [key, title] of [
      ['logic', 'QA Logic'],
      ['bcu', 'QA BCU'],
    ] as const) {
      const course = await prisma.course.create({
        data: { code: `QAM_${key.toUpperCase()}`, name: title },
      });
      if (key === 'logic') subjectId = course.id;
      else failSubjectId = course.id;
      const offering = await prisma.courseOffering.create({
        data: {
          termId: term.id,
          generationId: gen.id,
          courseId: course.id,
          externalKey: `QAM-T1-${key}`,
          title,
          visibility: 'VISIBLE',
        },
      });
      const quiz = await prisma.assessmentCriterion.create({
        data: { offeringId: offering.id, key: 'QUIZ', name: 'Quiz', displayOrder: 1 },
      });
      const final = await prisma.assessmentCriterion.create({
        data: { offeringId: offering.id, key: 'FINAL', name: 'Final', displayOrder: 2 },
      });
      // Items can be written only while the scheme is a draft; then it is published.
      const scheme = await prisma.gradingScheme.create({
        data: {
          offeringId: offering.id,
          version: 1,
          status: 'DRAFT',
          origin: 'ADMIN',
          totalWeight: 100,
          items: {
            create: [
              { criterionId: quiz.id, maxMark: 100, weight: 50 },
              { criterionId: final.id, maxMark: 100, weight: 50 },
            ],
          },
        },
      });
      await prisma.gradingScheme.update({
        where: { id: scheme.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      for (const s of students) {
        const enrollment = await prisma.enrollment.create({
          data: {
            studentId: s.id,
            offeringId: offering.id,
            teacherComment: key === 'logic' && s.i === 1 ? COMMENT : null,
          },
        });
        const [q, f] = marks(s.i, key);
        const scores = [
          [quiz.id, q],
          [final.id, f],
        ] as const;
        for (const [criterionId, mark] of scores) {
          if (mark === null) continue;
          await prisma.assessmentScore.create({
            data: {
              enrollmentId: enrollment.id,
              offeringId: offering.id,
              criterionId,
              status: 'RECORDED',
              mark,
            },
          });
        }
      }
    }

    // Header checks: the Logic components of the sheets fixture (term-workbook-fixture.ts, all
    // out of 100), and odd weights / a max that is not 100. A few students each, no marks.
    for (const extra of HEADER_SUBJECTS) {
      const course = await prisma.course.create({ data: { code: extra.code, name: extra.title } });
      headerSubjectIds[extra.code] = course.id;
      const offering = await prisma.courseOffering.create({
        data: {
          termId: term.id,
          generationId: gen.id,
          courseId: course.id,
          externalKey: `QAM-T1-${extra.code}`,
          title: extra.title,
          visibility: 'VISIBLE',
        },
      });
      const items = [];
      for (const [n, c] of extra.criteria.entries()) {
        const criterion = await prisma.assessmentCriterion.create({
          data: { offeringId: offering.id, key: `C${n + 1}`, name: c.name, displayOrder: n + 1 },
        });
        items.push({ criterionId: criterion.id, maxMark: c.max, weight: c.weight });
      }
      const scheme = await prisma.gradingScheme.create({
        data: {
          offeringId: offering.id,
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
      for (const s of students.slice(0, 3)) {
        await prisma.enrollment.create({ data: { studentId: s.id, offeringId: offering.id } });
      }
    }

    // Term 2 has one subject, not released to students (Term 3–5 have none).
    const hiddenCourse = await prisma.course.create({
      data: { code: 'QAM_HIDDEN', name: 'QA Hidden' },
    });
    await prisma.courseOffering.create({
      data: {
        termId: gen.terms[1]!.id,
        generationId: gen.id,
        courseId: hiddenCourse.id,
        externalKey: 'QAM-T2-hidden',
        title: 'QA Hidden',
        visibility: 'HIDDEN',
      },
    });
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

const page1Url = () => `/admin/monitoring?generation=${generationId}&term=1`;
const studentRows = (page: Page) => page.getByRole('table').last().locator('tbody tr');

test('1. page 1 lists the term subjects; sort by Fail persists across refresh', async () => {
  await admin.goto(page1Url());
  await expect(admin.getByRole('heading', { name: 'Subject monitoring' })).toBeVisible();
  await expect(admin.getByRole('link', { name: 'QA Logic' }).first()).toBeVisible();
  await expect(admin.getByRole('link', { name: 'QA BCU' }).first()).toBeVisible();

  await admin.getByRole('combobox', { name: 'Sort subjects' }).selectOption('fail');
  await expect(admin).toHaveURL(/sort=fail/);
  await admin.reload();
  await expect(admin.getByRole('combobox', { name: 'Sort subjects' })).toHaveValue('fail');
  // BCU has the most Fails: first row of the subject table.
  const first = admin.getByRole('table').first().locator('tbody tr').first();
  await expect(first).toContainText('QA BCU');
  await expect(first.getByRole('link', { name: 'QA BCU' })).toHaveAttribute(
    'href',
    new RegExp(failSubjectId),
  );
});

test('2. page 2: level and search filters go to the URL and survive refresh', async () => {
  await admin.getByRole('link', { name: 'QA Logic' }).first().click();
  await expect(admin).toHaveURL(new RegExp(`/admin/monitoring/${generationId}/1/${subjectId}`));
  await expect(admin.getByRole('heading', { name: /QA Logic/ }).first()).toBeVisible();
  await expect(studentRows(admin)).toHaveCount(25); // default page size

  await admin.getByRole('combobox', { name: 'Level', exact: true }).selectOption('INCOMPLETE');
  await expect(admin).toHaveURL(/level=INCOMPLETE/);
  await expect(studentRows(admin)).toHaveCount(1);
  await expect(studentRows(admin).first()).toContainText(code(2));

  await admin.getByRole('combobox', { name: 'Level', exact: true }).selectOption('');
  await admin.getByPlaceholder('Student ID or name').fill('qam-001');
  await expect(admin).toHaveURL(/search=qam-001/);
  // QAM-0010 … QAM-0019.
  await expect(studentRows(admin)).toHaveCount(10);

  await admin.reload();
  await expect(admin.getByPlaceholder('Student ID or name')).toHaveValue('qam-001');
  await expect(studentRows(admin)).toHaveCount(10);
});

test('3. a bookmarked URL restores every selection, and Back returns to page 1 as it was', async () => {
  const bookmark = admin.url();
  const fresh = await admin.context().newPage();
  await fresh.goto(bookmark);
  await expect(fresh.getByPlaceholder('Student ID or name')).toHaveValue('qam-001');
  await expect(studentRows(fresh)).toHaveCount(10);
  await fresh.close();

  await admin.goBack();
  await expect(admin).toHaveURL(/\/admin\/monitoring\?/);
  await expect(admin).toHaveURL(/sort=fail/);
  await expect(admin.getByRole('combobox', { name: 'Sort subjects' })).toHaveValue('fail');
  await admin.goForward();
  await expect(admin).toHaveURL(/search=qam-001/);
  await expect(admin.getByPlaceholder('Student ID or name')).toHaveValue('qam-001');
});

test('4. a teacher comment with markup is shown as plain text, line break kept', async () => {
  await admin.goto(`/admin/monitoring/${generationId}/1/${subjectId}?search=${code(1)}`);
  await expect(studentRows(admin).first()).toContainText(code(1));
  await admin.getByRole('button', { name: `Show teacher comment for ${code(1)}` }).click();
  const quote = admin.locator('blockquote').first();
  await expect(quote).toBeVisible();
  expect(await quote.innerText()).toBe(COMMENT);
  await expect(admin.locator('blockquote b, blockquote i')).toHaveCount(0);
  await expect(quote).toHaveCSS('white-space', 'pre-wrap');
});

test('4b. a student name opens the admin student page preselected on the same term (?term=1)', async () => {
  await admin.goto(`/admin/monitoring/${generationId}/1/${subjectId}?search=${code(3)}`);
  const link = studentRows(admin).first().getByRole('link');
  await expect(link).toHaveAttribute('href', /\/admin\/students\/[0-9a-f-]{36}\?term=1$/);
  await link.click();
  await expect(admin).toHaveURL(/\/admin\/students\/[0-9a-f-]{36}\?term=1$/);
  await expect(admin.getByText(code(3)).first()).toBeVisible();
});

test('5. invalid URL parameters show a usable state, never a crash', async () => {
  await admin.goto(`/admin/monitoring/${generationId}/9/${subjectId}`);
  await expect(admin.getByText(/Application error|Unhandled Runtime Error/)).toHaveCount(0);
  await admin.goto(`/admin/monitoring/${generationId}/1/${subjectId}?page=99`);
  await expect(admin.getByText('This page is past the end of the list')).toBeVisible();
});

/**
 * Defect check: when the term has no active sheet any more (for example it was disabled), page 1
 * still lists the subject with its counts; page 2 must still show the students it counts.
 */
test('6. page 2 shows its students when the term has no active sheet (page 1 does)', async () => {
  loadRootEnv();
  const prisma = createPrismaClient({
    connectionString: assertTestDatabaseUrl(process.env['TEST_DATABASE_URL']),
    poolMax: 1,
  });
  try {
    await prisma.googleSheetSource.update({
      where: { id: sourceId },
      data: { status: 'DISABLED' },
    });
    await admin.goto(page1Url());
    await expect(admin.getByRole('link', { name: 'QA Logic' }).first()).toBeVisible();
    await admin.goto(`/admin/monitoring/${generationId}/1/${subjectId}`);
    await expect(admin.getByRole('heading', { name: /QA Logic/ }).first()).toBeVisible();
    await expect(studentRows(admin)).toHaveCount(25);
  } finally {
    await prisma.googleSheetSource.update({ where: { id: sourceId }, data: { status: 'ACTIVE' } });
    await prisma.$disconnect();
  }
});

const termPicker = (page: Page) => page.getByRole('combobox', { name: 'Term' });
const tooltip = (page: Page) => page.locator('[data-slot=tooltip-content][data-open]');

test('7. the Term picker shows each term name with at most one status icon', async () => {
  await admin.goto(page1Url());
  const term = termPicker(admin);
  await expect(term).toBeVisible();
  // Loading the page never opens the list.
  await expect(admin.getByRole('listbox')).toHaveCount(0);
  // Released Term 1: the name only, no icon, no status text.
  await expect(term).toHaveText('Term 1');
  await expect(term.locator('[data-term-status]')).toHaveCount(0);

  await term.click();
  const options = admin.getByRole('listbox').getByRole('option');
  await expect(options).toHaveCount(5);
  const names = [
    'Term 1',
    'Term 2, Not released to students',
    'Term 3, No subjects',
    'Term 4, No subjects',
    'Term 5, No subjects',
  ];
  for (const [i, name] of names.entries()) await expect(options.nth(i)).toHaveAccessibleName(name);
  // One icon at most: never two status texts on one option.
  for (let i = 0; i < 5; i++) {
    await expect(options.nth(i).locator('[data-term-status]')).toHaveCount(i === 0 ? 0 : 1);
  }
  await expect(admin.getByRole('listbox')).not.toContainText('(not released)');
  await expect(admin.getByRole('listbox')).not.toContainText('(no subjects)');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');

  // Hover tooltips on the icons.
  await options.nth(2).locator('[data-term-status]').hover();
  await expect(tooltip(admin)).toHaveText('No subjects');
  await options.nth(1).locator('[data-term-status]').hover();
  await expect(tooltip(admin)).toHaveText('Not released to students');

  // Escape closes without changing anything.
  await admin.keyboard.press('Escape');
  await expect(admin.getByRole('listbox')).toHaveCount(0);
  await expect(admin).toHaveURL(/term=1(&|$)/);
  await expect(term).toBeFocused();

  // Keyboard: open, arrow down, Enter. A term with an icon is selectable; the URL follows.
  await admin.keyboard.press('ArrowDown');
  await expect(admin.getByRole('listbox')).toBeVisible();
  await admin.keyboard.press('ArrowDown');
  await admin.keyboard.press('Enter');
  await expect(admin).toHaveURL(/term=2(&|$)/);
  await expect(term).toHaveAccessibleName('Term');
  await expect(term).toContainText('Term 2');
  await expect(term.locator('[data-term-status="Not released to students"]')).toHaveCount(1);
  await term.locator('[data-term-status]').hover();
  await expect(tooltip(admin)).toHaveText('Not released to students');

  // Type-to-select.
  await term.focus();
  await admin.keyboard.press('Enter');
  await expect(admin.getByRole('listbox')).toBeVisible();
  await admin.keyboard.type('Term 4');
  await admin.keyboard.press('Enter');
  await expect(admin).toHaveURL(/term=4(&|$)/);
  await expect(term.locator('[data-term-status="No subjects"]')).toHaveCount(1);

  // The term is in the URL: it survives a refresh.
  await admin.reload();
  await expect(termPicker(admin)).toContainText('Term 4');
});

test('7b. the Term picker at phone width: the list fits, no sideways scroll', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 },
    storageState: await admin.context().storageState(),
  });
  const phone = await ctx.newPage();
  try {
    await phone.goto(page1Url());
    const term = termPicker(phone);
    await expect(term).toHaveText('Term 1');
    await term.click();
    const list = phone.getByRole('listbox');
    await expect(list).toBeVisible();
    const box = (await list.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    // A string expression: the e2e tsconfig has no DOM types.
    const sideways = await phone.evaluate<boolean>(
      'document.documentElement.scrollWidth > document.documentElement.clientWidth',
    );
    expect(sideways).toBe(false);
    await list.getByRole('option', { name: /^Term 3/ }).click();
    await expect(phone).toHaveURL(/term=3(&|$)/);
  } finally {
    await ctx.close();
  }
});

const criterionHeaders = (page: Page) =>
  page
    .getByRole('table')
    .last()
    .locator('thead th')
    .filter({ has: page.getByRole('button', { name: /^Sort by / }) });

test('8. component headers read "name · weight%", the max only when not 100', async () => {
  const logic = `/admin/monitoring/${generationId}/1/${headerSubjectIds['QAM_SHEET_LOGIC']}`;
  await admin.goto(logic);
  await expect(admin.getByRole('heading', { name: /QA Sheet Logic/ }).first()).toBeVisible();
  await expect(criterionHeaders(admin)).toHaveText([
    'Student ID',
    'Name',
    'Program',
    'Class',
    'Quiz 1 · 10%',
    'Quiz 2 · 10%',
    'Homework · 10%',
    'Participation · 10%',
    'MIDTERM · 25%',
    'FINAL · 35%',
    'Total',
    'Grade',
    'Level',
  ]);
  const thead = admin.getByRole('table').last().locator('thead');
  await expect(thead).not.toContainText('/ 100');
  await expect(thead).not.toContainText('/100');

  // One line, a hover tooltip with the full detail, sorting unchanged.
  const quiz = admin.getByRole('button', { name: 'Sort by Quiz 1', exact: true });
  await expect(quiz).toHaveCSS('white-space', 'nowrap');
  await quiz.hover();
  await expect(tooltip(admin)).toHaveText('Quiz 1: weight 10%, out of 100');
  await quiz.click();
  await expect(admin).toHaveURL(/sortKey=criterion/);
  await expect(admin.getByRole('button', { name: 'Sort by Quiz 1, ascending' })).toBeVisible();
  await expect(criterionHeaders(admin).filter({ hasText: 'Quiz 1' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await admin.getByRole('button', { name: 'Sort by Quiz 1, ascending' }).click();
  await expect(criterionHeaders(admin).filter({ hasText: 'Quiz 1' })).toHaveAttribute(
    'aria-sort',
    'descending',
  );

  await admin.goto(`/admin/monitoring/${generationId}/1/${headerSubjectIds['QAM_ODD']}`);
  await expect(admin.getByRole('heading', { name: /QA Odd Weights/ }).first()).toBeVisible();
  await expect(criterionHeaders(admin).filter({ hasText: /Lab|quiz|Exam/ })).toHaveText([
    'Lab · 7.5% · /50',
    'Short quiz · 1.25%',
    'Exam · 91.25%',
  ]);
  await admin.getByRole('button', { name: 'Sort by Lab', exact: true }).hover();
  await expect(tooltip(admin)).toHaveText('Lab: weight 7.5%, out of 50');
});
