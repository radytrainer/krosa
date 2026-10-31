/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import { runSourceSync } from '@ssrs/sync';
import { confirmAllTabs } from '@ssrs/sync/testing';
import type { FakeSpreadsheet } from '@ssrs/sheets/testing';
import { api, login, type TestContext } from '../support/test-app.js';
import {
  ADMIN_V1,
  createHarness,
  sheetUrl,
  SHEET_A,
  SHEET_B,
  STUDENT_PASSWORD,
  V1,
  type Api,
  type Harness,
} from './support.js';

/** QA suite, G-15 and G-16: 300 students x 5 subjects. One machine, in-process HTTP. */

const STUDENTS = 300;
const TABS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
const code = (i: number) => `QA2027-${String(i + 1).padStart(4, '0')}`;
const PROFILE = ['STUDENT ID', 'FIRST NAME', 'LAST NAME', 'GENDER', 'CLASS'];
const MARKS = [
  'Quiz 1 10%',
  'Quiz 2 10%',
  'Homework 10%',
  'Participation 10%',
  'MIDTERM 25%',
  'FINAL 35%',
];

function workbook(version: number): FakeSpreadsheet {
  const rows = Array.from({ length: STUDENTS }, (_, i) => [code(i), `F${i}`, `L${i}`, 'F', 'A']);
  const tabs: FakeSpreadsheet['tabs'] = { ALL: [PROFILE, ...rows] };
  TABS.forEach((name, t) => {
    tabs[name] = [
      [...PROFILE, ...MARKS],
      ...rows.map((row, i) => [
        ...row,
        ...MARKS.map((_, c) => (i * 7 + t * 13 + c * 3 + version * 17) % 101),
      ]),
    ];
  });
  return { title: `Perf v${version}`, tabs };
}

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

async function hammer(total: number, concurrency: number, call: (i: number) => Promise<unknown>) {
  const times: number[] = [];
  let next = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) {
        const i = next++;
        const t = performance.now();
        await call(i);
        times.push(performance.now() - t);
      }
    }),
  );
  times.sort((a, b) => a - b);
  return {
    p50: Math.round(percentile(times, 0.5)),
    p99: Math.round(percentile(times, 0.99)),
    rps: Math.round((total / (Date.now() - started)) * 1000),
  };
}

describe('QA G-15 / G-16 performance at 300 x 5', () => {
  let h: Harness;
  let ctx: TestContext;

  beforeAll(async () => {
    h = await createHarness();
    ctx = h.ctx;
    await h.reset();
  }, 60_000);
  afterAll(async () => h.close());

  const timed = async (label: string, fn: () => Promise<unknown>) => {
    const t = Date.now();
    const out = await fn();
    console.log(`[G-16] ${label}: ${Date.now() - t} ms`);
    return out;
  };

  it('sync timings, sheet change, and read latency', async () => {
    h.reader.set(SHEET_A, workbook(1));
    const src = (
      await h.admin
        .post(`${ADMIN_V1}/terms/${h.termId}/sources`, { url: sheetUrl(SHEET_A), label: 'P' })
        .expect(201)
    ).body;
    await confirmAllTabs(ctx.prisma, h.reader, src.id);

    const first = (await timed('first import', () => h.sync(src.id))) as { status: string };
    expect(first.status).toBe('SUCCEEDED');
    expect(await ctx.prisma.assessmentScore.count()).toBe(STUDENTS * TABS.length * MARKS.length);
    await timed('re-sync, nothing changed', () => h.sync(src.id));
    h.reader.set(SHEET_A, workbook(2));
    await timed('re-sync, every mark changed', () => h.sync(src.id));

    h.reader.set(SHEET_B, workbook(3));
    const pending = (
      await h.admin
        .post(`${ADMIN_V1}/terms/${h.termId}/sources/change`, {
          url: sheetUrl(SHEET_B),
          label: 'B',
        })
        .expect(201)
    ).body.id;
    await timed('detect and confirm 5 tabs', () => h.review(pending));
    await timed('preview and confirm', () => h.previewAndConfirm(pending));
    const { jobId } = (
      await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: pending }).expect(202)
    ).body;
    await timed('sheet change (one transaction, every mark changed)', () =>
      runSourceSync({ prisma: ctx.prisma, reader: h.reader }, jobId, {
        attempt: 1,
        maxAttempts: 1,
      }),
    );
    const job = await ctx.prisma.syncJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe('SUCCEEDED');

    await h.admin.post(`${ADMIN_V1}/terms/${h.termId}/release`, { visible: true }).expect(200);
    const sessions: Api[] = [];
    for (let i = 0; i < 8; i++) {
      await h.activate(code(i));
      await ctx.redis.keys('ssrs:v1:rl:*').then((k) => (k.length ? ctx.redis.del(...k) : 0));
      sessions.push(api(await login(ctx, code(i), STUDENT_PASSWORD)));
    }

    const students = await ctx.prisma.student.findMany({ select: { id: true } });
    const cached = await hammer(600, 20, (i) =>
      sessions[i % sessions.length]!.get(`${V1}/student/me/results`).expect(200),
    );
    await ctx.redis.keys('ssrs:v1:results:*').then((k) => (k.length ? ctx.redis.del(...k) : 0));
    const admin = await hammer(300, 20, (i) =>
      h.admin.get(`${ADMIN_V1}/students/${students[i % students.length]!.id}/results`).expect(200),
    );
    const list = await hammer(100, 10, () =>
      h.admin.get(`${ADMIN_V1}/students?pageSize=100`).expect(200),
    );
    console.log('[G-15] student results, cached', JSON.stringify(cached));
    console.log('[G-15] admin results, never cached', JSON.stringify(admin));
    console.log('[G-15] student list, 100 rows', JSON.stringify(list));
    expect(cached.p99).toBeLessThan(1000);
    expect(admin.p99).toBeLessThan(2000);
  }, 300_000);
});
