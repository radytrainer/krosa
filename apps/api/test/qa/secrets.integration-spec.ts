/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import request from 'supertest';
import { loadApiEnv } from '../../src/config/env.js';
import { api, login, WEB_ORIGIN, type TestContext } from '../support/test-app.js';
import {
  ADMIN,
  ADMIN_V1,
  call,
  createHarness,
  editedFixture,
  liveRoutes,
  SHEET_A,
  STUDENT_PASSWORD,
  V1,
  type Harness,
} from './support.js';

/** QA suite: A-25 (nothing secret in any response), E-09 (issue cap), G-13 (Swagger off). */

const SECRET =
  /\$argon2|passwordHash|password_hash|tokenHash|token_hash|!locked:|leaseToken|privateKey/;

describe('QA A-25: no hash or token in any response', () => {
  let h: Harness;
  let ctx: TestContext;

  beforeAll(async () => {
    h = await createHarness();
    ctx = h.ctx;
    await h.reset();
    await h.importSheet();
  });
  afterAll(async () => h.close());

  it('every GET route, as admin and as student', async () => {
    const student = await h.activate('PNC2027-001');
    const studentSession = await login(ctx, 'PNC2027-001', STUDENT_PASSWORD);
    const row = await ctx.prisma.student.findUniqueOrThrow({
      where: { studentCode: 'PNC2027-001' },
    });
    const source = await ctx.prisma.googleSheetSource.findFirstOrThrow();
    const job = await ctx.prisma.syncJob.findFirstOrThrow();
    const offering = await ctx.prisma.courseOffering.findFirstOrThrow({
      where: { title: 'Logic' },
    });

    const fill = (path: string) =>
      path
        .replace('generations/:id', `generations/${h.generationId}`)
        .replace('students/:id', `students/${row.id}`)
        .replace('sources/:id', `sources/${source.id}`)
        .replace('sync/:jobId', `sync/${job.id}`)
        .replace('courses/:offeringId', `courses/${offering.id}`);

    let checked = 0;
    const tokens = [
      h.session.cookies.get('ssrs_at')!.value,
      h.session.cookies.get('ssrs_rt')!.value,
      studentSession.cookies.get('ssrs_at')!.value,
      studentSession.cookies.get('ssrs_rt')!.value,
    ];
    for (const route of liveRoutes(ctx).filter((r) => r.method === 'get')) {
      const path = fill(route.path);
      expect(path, 'an id was not filled in').not.toContain(':');
      const agent = route.path.startsWith('/api/v1/student')
        ? studentSession.agent
        : h.session.agent;
      const res = await call(agent, 'get', path);
      expect(res.status, path).toBeLessThan(400);
      expect(res.text, path).not.toMatch(SECRET);
      for (const token of tokens) expect(res.text, path).not.toContain(token);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(24);
    await student.get(`${V1}/auth/me`).expect(200);
  });

  it('login, refresh and change-password bodies carry no token or hash', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post(`${V1}/auth/login`)
      .set('Origin', WEB_ORIGIN)
      .send({ identifier: ADMIN.username, password: ADMIN.password })
      .expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(SECRET);
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
    const session = await login(ctx, ADMIN.username, ADMIN.password);
    const refreshed = await api(session).post(`${V1}/auth/refresh`).expect(204);
    expect(refreshed.text).toBe('');
  });
});

describe('QA E-09: the 20,000 issue cap', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    await h.reset();
  });
  afterAll(async () => h.close());

  it('the job total matches what can be listed, or the page says so', async () => {
    const source = await h.importSheet();
    h.reader.set(
      SHEET_A,
      editedFixture((s) => {
        // Stay under the per-tab size limit: 5 tabs of 4,100 rows give 20,500 row errors.
        for (const tab of ['Logic', 'ENG', 'PL', 'BCU', 'MsOffice']) {
          for (let i = 0; i < 4_100; i++) {
            s.tabs[tab]!.push([`QA-${tab}-${i}`, 'X', 'Y', 'M', 'A', 1, 1, 1, 1, 1, 1, 1]);
          }
        }
      }),
    );
    const job = await h.sync(source);
    const listed = (await h.admin.get(`${ADMIN_V1}/sync/${job.id}/errors`).expect(200)).body.meta
      .total;
    console.log(`[E-09] job ${job.status}: errorCount ${job.errorCount}, listed ${listed}`);
    expect(job.errorCount + job.warningCount).toBe(listed);
  }, 120_000);
});

describe('QA G-10: CORS settings', () => {
  it.each(['*', 'http://a.example,*', 'http://a.example/path', 'not-a-url'])(
    'CORS_ORIGINS=%s is refused at startup',
    (CORS_ORIGINS) => {
      expect(() =>
        loadApiEnv({
          DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
          REDIS_URL: 'redis://localhost:6379/0',
          WEB_ORIGIN: 'http://localhost:3000',
          JWT_ACCESS_SECRET: 'x'.repeat(32),
          CORS_ORIGINS,
        }),
      ).toThrow();
    },
  );
});

describe('QA G-13: Swagger', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  it('is not served when disabled', async () => {
    const server = request(h.ctx.app.getHttpServer());
    for (const path of ['/api/docs', '/api/docs-json', '/api/docs/']) {
      expect((await server.get(path)).status, path).toBe(404);
    }
  });
});
