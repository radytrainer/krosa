/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import { confirmAllTabs } from '@ssrs/sync/testing';
import { termMetaTab, type FakeSpreadsheet } from '@ssrs/sheets/testing';
import { installQueryCounter, type QueryCounter } from '../support/query-counter.js';
import { ADMIN_V1, createHarness, sheetUrl, SHEET_A, type Harness } from './support.js';

/**
 * Subject monitoring: a fixed number of queries whatever the number of students (no N+1), and
 * response times at 300 students x 5 subjects. One machine, in-process HTTP, ssrs_test.
 * Expected query counts (backend report): generations 1, page 1 4, summary 5, students 4.
 */

const TABS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
const PROFILE = ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER', 'CLASS'];
const MARKS = ['Quiz 1 20%', 'Homework 20%', 'MIDTERM 25%', 'FINAL 35%', 'COMMENTS'];
const code = (i: number) => `QM2027-${String(i + 1).padStart(4, '0')}`;
const CLASSES = ['A', 'B', 'C', 'D'];

function workbook(students: number): FakeSpreadsheet {
  const rows = Array.from({ length: students }, (_, i) => [
    code(i),
    `F${i}`,
    `L${i}`,
    'F',
    CLASSES[i % 4]!,
  ]);
  const tabs: FakeSpreadsheet['tabs'] = {
    _meta: termMetaTab('GEN2027', 1),
    ALL: [PROFILE, ...rows],
  };
  TABS.forEach((name, t) => {
    tabs[name] = [
      [...PROFILE, ...MARKS],
      ...rows.map((row, i) => [
        ...row,
        // Every 9th student has a blank FINAL: a mix of COMPLETE and INCOMPLETE.
        ...[0, 1, 2, 3].map((c) =>
          c === 3 && i % 9 === 0 ? null : (i * 7 + t * 13 + c * 3) % 101,
        ),
        i % 4 === 0 ? `Comment ${i}` : null,
      ]),
    ];
  });
  return { title: `Monitoring ${students}`, tabs };
}

interface Measured {
  generations: number;
  page1: number;
  summary: number;
  students: number;
  studentsFiltered: number;
  times: Record<string, number>;
}

describe('QA monitoring: no N+1, and timings at 300 students', () => {
  let h: Harness;
  let counter: QueryCounter;

  beforeAll(async () => {
    h = await createHarness();
    counter = installQueryCounter(h.ctx.app);
  }, 60_000);
  afterAll(async () => h.close());

  async function seed(students: number) {
    await h.reset();
    h.reader.set(SHEET_A, workbook(students));
    const src = (
      await h.admin
        .post(`${ADMIN_V1}/terms/${h.termId}/sources`, { url: sheetUrl(SHEET_A), label: 'M' })
        .expect(201)
    ).body;
    await confirmAllTabs(h.ctx.prisma, h.reader, src.id);
    const job = await h.sync(src.id);
    expect(job.status).toBe('SUCCEEDED');
    expect(await h.ctx.prisma.enrollment.count()).toBe(students * TABS.length);
  }

  async function measure(students: number): Promise<Measured> {
    await seed(students);
    const subject = await h.ctx.prisma.courseOffering.findFirstOrThrow({
      where: { title: 'Alpha' },
    });
    const base = `generationId=${h.generationId}&termNumber=1&subjectId=${subject.courseId}`;
    const urls = {
      generations: `${ADMIN_V1}/monitoring/generations`,
      page1: `${ADMIN_V1}/monitoring/terms/${h.generationId}/1/subjects?sort=fail`,
      summary: `${ADMIN_V1}/monitoring/subjects/summary?${base}`,
      students: `${ADMIN_V1}/monitoring/subjects/students?${base}&pageSize=100&sort=total&order=desc`,
      studentsFiltered: `${ADMIN_V1}/monitoring/subjects/students?${base}&level=INCOMPLETE&search=QM&className=A&page=1`,
    };
    // Warm up once (query compiler, JIT), then measure.
    for (const url of Object.values(urls)) await h.admin.get(url).expect(200);
    const out = { times: {} as Record<string, number> } as Measured;
    for (const [key, url] of Object.entries(urls) as [keyof typeof urls, string][]) {
      const t = performance.now();
      const { queries, ops, result } = await counter.measure(() => h.admin.get(url).expect(200));
      out.times[key] = Math.round(performance.now() - t);
      out[key] = queries;
      if (key === 'students') expect(result.body.meta.total).toBe(students);
      console.log(
        `[monitoring ${students}] ${key}: ${queries} queries, ${out.times[key]} ms  (${ops.join(', ')})`,
      );
    }
    return out;
  }

  it('query counts are identical for 10 and 300 students, and match the reported counts', async () => {
    const small = await measure(10);
    const large = await measure(300);
    const counts = (m: Measured) => [
      m.generations,
      m.page1,
      m.summary,
      m.students,
      m.studentsFiltered,
    ];
    expect(counts(large)).toEqual(counts(small));
    expect({
      generations: large.generations,
      page1: large.page1,
      summary: large.summary,
      students: large.students,
    }).toEqual({
      generations: 1,
      page1: 4,
      summary: 5,
      students: 4,
    });

    // AC14: page 1 for the full term (5 subjects x 300) and page 2 for 300 students, each < 1 s.
    console.log(`[AC14] timings at 300 x 5: ${JSON.stringify(large.times)}`);
    expect(large.times['page1']).toBeLessThan(1000);
    expect(large.times['summary']).toBeLessThan(1000);
    expect(large.times['students']).toBeLessThan(1000);
  }, 300_000);

  it('repeated loads of page 1 and page 2 at 300 students stay under 1 s (median of 5)', async () => {
    const subject = await h.ctx.prisma.courseOffering.findFirstOrThrow({
      where: { title: 'Charlie' },
    });
    const base = `generationId=${h.generationId}&termNumber=1&subjectId=${subject.courseId}`;
    const median = async (url: string) => {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await h.admin.get(url).expect(200);
        times.push(performance.now() - t);
      }
      return Math.round(times.toSorted((a, b) => a - b)[2]!);
    };
    const p1 = await median(`${ADMIN_V1}/monitoring/terms/${h.generationId}/1/subjects`);
    const sum = await median(`${ADMIN_V1}/monitoring/subjects/summary?${base}`);
    const st = await median(
      `${ADMIN_V1}/monitoring/subjects/students?${base}&pageSize=100&sort=name`,
    );
    console.log(`[AC14] medians at 300 x 5: page1 ${p1} ms, summary ${sum} ms, students ${st} ms`);
    expect(Math.max(p1, sum, st)).toBeLessThan(1000);
  }, 120_000);
});
