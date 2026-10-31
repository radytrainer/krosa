/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import { termWorkbookFixture } from '@ssrs/sheets/testing';
import { confirmAllTabs } from '@ssrs/sync/testing';
import request from 'supertest';
import { login, WEB_ORIGIN, type TestContext } from '../support/test-app.js';
import {
  ADMIN_V1,
  call,
  createHarness,
  fillPath,
  liveRoutes,
  sheetUrl,
  STUDENT_PASSWORD,
  V1,
  type Api,
  type Harness,
} from './support.js';

/** QA suite, area B. Routes come from the running app, so a new route is covered by itself. */

const ZERO = '00000000-0000-7000-8000-000000000000';
const CODE_A = 'PNC2027-001';
const CODE_B = 'PNC2027-002';
const CODE_C = 'PNC2027-003';

interface Results {
  student: { studentCode: string; id: string };
  terms: { number: number; courses: { offeringId: string; title: string; finalScore: string }[] }[];
}

describe('QA B: authorization and data isolation', () => {
  let h: Harness;
  let ctx: TestContext;
  let a: Api;
  let b: Api;

  beforeAll(async () => {
    h = await createHarness();
    ctx = h.ctx;
    await h.reset();
    await h.importSheet();
    a = await h.activate(CODE_A);
    b = await h.activate(CODE_B);
  });
  afterAll(async () => h.close());

  const results = async (session: Api) =>
    (await session.get(`${V1}/student/me/results`).expect(200)).body as Results;
  const offerings = (r: Results) => r.terms.flatMap((t) => t.courses);

  describe('route coverage', () => {
    it('sanity: the live route list matches the documented 53 routes', () => {
      const routes = liveRoutes(ctx);
      expect(routes.filter((r) => r.path.startsWith('/api/v1/admin'))).toHaveLength(41);
      expect(routes.filter((r) => r.path.startsWith('/api/v1/student'))).toHaveLength(5);
      expect(routes).toHaveLength(53);
    });

    it('B-01 a student token is refused on every admin route', async () => {
      const session = await login(ctx, CODE_C, 'x').catch(() => null);
      expect(session).toBeNull(); // C is still pending; A's session is the one under test.
      for (const route of liveRoutes(ctx).filter((r) => r.path.startsWith('/api/v1/admin'))) {
        const path = fillPath(route.path);
        const req = call(aAgent(), route.method, path)
          .set('Origin', WEB_ORIGIN)
          .set('X-CSRF-Token', aCsrf());
        const res = route.method === 'get' ? await req : await req.send({});
        expect(res.status, `${route.method} ${route.path}`).toBe(403);
        expect(JSON.stringify(res.body), route.path).not.toMatch(
          /generation|student_code|studentCode/,
        );
      }
    });

    it('B-02 no token, garbage token: 401 on every non-public route', async () => {
      const open = new Set(['/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/auth/logout']);
      for (const route of liveRoutes(ctx)) {
        if (open.has(route.path) || route.path.startsWith('/api/v1/health')) continue;
        const path = fillPath(route.path);
        for (const cookie of [undefined, 'ssrs_at=garbage']) {
          const req = call(request(ctx.app.getHttpServer()), route.method, path)
            .set('Origin', WEB_ORIGIN)
            .set('X-CSRF-Token', 'x');
          if (cookie) req.set('Cookie', cookie);
          const res = route.method === 'get' ? await req : await req.send({});
          expect(res.status, `${route.method} ${route.path} ${cookie}`).toBe(401);
        }
      }
    });

    it('B-03 an admin token is refused on the student routes', async () => {
      for (const route of liveRoutes(ctx).filter((r) => r.path.startsWith('/api/v1/student'))) {
        const res = await h.admin.get(fillPath(route.path));
        expect(res.status, route.path).toBe(403);
      }
    });
  });

  // B-01 needs raw access to A's agent, so keep the session objects as well.
  let sessionA: Awaited<ReturnType<typeof login>>;
  const aAgent = () => sessionA.agent;
  const aCsrf = () => sessionA.csrf;
  beforeAll(async () => {
    sessionA = await login(ctx, CODE_A, STUDENT_PASSWORD);
  });

  describe('student A cannot reach student B', () => {
    it('B-04 foreign, hidden, unknown offerings all give an identical 404', async () => {
      const eng = await ctx.prisma.courseOffering.findFirstOrThrow({ where: { title: 'ENG' } });
      await h.activate(CODE_C).then(async (c) => {
        // C has no row in ENG: the offering exists and is visible, but is not theirs.
        const foreign = await c.get(`${V1}/student/me/courses/${eng.id}`);
        const unknown = await c.get(`${V1}/student/me/courses/${ZERO}`);
        expect(foreign.status).toBe(404);
        expect(unknown.status).toBe(404);
        const strip = (r: request.Response) => ({ ...r.body.error, requestId: undefined });
        expect(strip(foreign)).toEqual(strip(unknown));
      });
    });

    it('B-05 identity parameters are refused or ignored everywhere', async () => {
      const victim = await ctx.prisma.student.findUniqueOrThrow({ where: { studentCode: CODE_B } });
      const victimUser = victim.userId;
      const mine = await results(a);
      const refused: string[] = [];
      for (const q of [
        `studentId=${victim.id}`,
        `studentCode=${CODE_B}`,
        `userId=${victimUser}`,
        `id=${victim.id}`,
        `student=${victim.id}`,
      ]) {
        for (const path of ['', '/results', '/summary', '/courses']) {
          const res = await a.get(`${V1}/student/me${path}?${q}`);
          // The leak check: never another student's data, whatever the status.
          expect(JSON.stringify(res.body), `${path}?${q}`).not.toContain(CODE_B);
          if (res.status !== 400) refused.push(`${path}?${q.split('=')[0]} -> ${res.status}`);
        }
      }
      expect.soft(refused, 'spec: unknown query parameters give 400').toEqual([]);
      const spoofed = await a
        .get(`${V1}/student/me/results`)
        .set('X-Student-Id', victim.id)
        .set('X-User-Id', victimUser)
        .set('X-Forwarded-User', victimUser);
      expect(spoofed.body.student.id).toBe(mine.student.id);
    });

    it('B-06 parameter pollution on term', async () => {
      for (const q of ['term=1&term=2', 'term[]=1', 'term[a]=1', 'term=1&term[x]=2']) {
        const res = await a.get(`${V1}/student/me/results?${q}`);
        expect(res.status, q).toBe(400);
      }
    });

    it('B-07 malformed offering ids', async () => {
      for (const id of [
        'abc',
        '1',
        "1'%20OR%20'1'='1",
        `${ZERO}%00`,
        'x'.repeat(5000),
        '..%2F..%2Fadmin%2Fdashboard',
      ]) {
        const res = await a.get(`${V1}/student/me/courses/${id}`);
        expect(res.status, id.slice(0, 40)).toBeGreaterThanOrEqual(400);
        expect(res.status, id.slice(0, 40)).toBeLessThan(500);
      }
    });

    it('B-08 term filter bounds', async () => {
      for (const t of ['0', '6', '-1', '1.5', 'abc', '', '999999999999']) {
        const res = await a.get(`${V1}/student/me/results?term=${t}`);
        expect(res.status, `term=${t}`).toBe(400);
      }
      for (const t of [1, 2, 3, 4, 5])
        await a.get(`${V1}/student/me/results?term=${t}`).expect(200);
    });

    it('B-09 cached responses never cross students', async () => {
      for (let i = 0; i < 3; i++) {
        const [ra, rb] = await Promise.all([results(a), results(b)]);
        expect(ra.student.studentCode).toBe(CODE_A);
        expect(rb.student.studentCode).toBe(CODE_B);
      }
      const keys = await ctx.redis.keys('ssrs:v1:results:*');
      expect(keys.length).toBeGreaterThanOrEqual(2);
      for (const key of keys) expect(key).toMatch(/:student:[0-9a-f-]{36}$/);
    });

    it('B-13 a student of another generation sees nothing of this one', async () => {
      const gen = (
        await h.admin
          .post(`${ADMIN_V1}/generations`, {
            code: 'GEN2028',
            name: 'Generation 2028',
            startDate: '2027-11-02',
          })
          .expect(201)
      ).body;
      const terms = (await h.admin.get(`${ADMIN_V1}/generations/${gen.id}/terms`).expect(200)).body;
      const sheetId = '1QaOtherGenerationSheet00000000000000000';
      const sheet = termWorkbookFixture();
      sheet.tabs['_meta']![2]![1] = 'GEN2028';
      for (const tab of ['ALL', 'Logic', 'ENG', 'PL', 'BCU', 'MsOffice']) {
        for (const row of sheet.tabs[tab]!) {
          if (typeof row[0] === 'string' && row[0].startsWith('PNC2027')) {
            row[0] = row[0].replace('PNC2027', 'PNC2028');
          }
        }
      }
      h.reader.set(sheetId, sheet);
      const source = (
        await h.admin
          .post(`${ADMIN_V1}/terms/${terms[0].id}/sources`, {
            url: sheetUrl(sheetId),
            label: 'G28',
          })
          .expect(201)
      ).body;
      await confirmAllTabs(ctx.prisma, h.reader, source.id);
      await h.sync(source.id);
      await h.admin.post(`${ADMIN_V1}/terms/${terms[0].id}/release`, { visible: true }).expect(200);
      const other = await h.activate('PNC2028-001');

      const mine = offerings(await results(other));
      const theirs = offerings(await results(a));
      expect(mine.length).toBeGreaterThan(0);
      const ids = new Set(mine.map((c) => c.offeringId));
      for (const course of theirs) expect(ids.has(course.offeringId)).toBe(false);
      await other.get(`${V1}/student/me/courses/${theirs[0]!.offeringId}`).expect(404);
    });

    it('B-15 path tricks do not bypass guards', async () => {
      for (const path of [
        '/API/V1/ADMIN/DASHBOARD',
        '/api/v1/admin/dashboard/',
        '/api/v1//admin/dashboard',
        '/api/v1/student/../admin/dashboard',
        '/api/v1/student/%2e%2e/admin/dashboard',
        '/api/v2/admin/dashboard',
        '/api/admin/dashboard',
        '/api/v1/admin/dashboard;x=1',
        '/api/v1/admin/dashboard%00',
        '/api/v1/admin/dashboard%20',
      ]) {
        const res = await sessionA.agent.get(path);
        expect(res.status, path).not.toBe(200);
        expect(res.status, path).toBeLessThan(500);
      }
      const override = await sessionA.agent
        .post(`${V1}/auth/me`)
        .set('Origin', WEB_ORIGIN)
        .set('X-CSRF-Token', sessionA.csrf)
        .set('X-HTTP-Method-Override', 'GET');
      expect(override.status).toBe(404);
    });

    it('B-16 unusual methods on protected routes', async () => {
      const server = request(ctx.app.getHttpServer());
      expect((await server.head(`${V1}/admin/dashboard`)).status).toBe(401);
      expect((await sessionA.agent.head(`${V1}/admin/dashboard`)).status).toBe(403);
      const opt = await server.options(`${V1}/admin/dashboard`);
      expect(opt.status).toBeLessThan(500);
      expect(opt.text).not.toMatch(/generation/i);
      for (const m of ['put', 'delete', 'patch'] as const) {
        const res = await sessionA.agent[m](`${V1}/student/me`)
          .set('Origin', WEB_ORIGIN)
          .set('X-CSRF-Token', sessionA.csrf);
        expect(res.status, m).toBe(404);
      }
    });

    it('B-19 mass assignment: forbidden fields on each write route', async () => {
      const row = await ctx.prisma.student.findUniqueOrThrow({ where: { studentCode: CODE_A } });
      const url = `${ADMIN_V1}/students/${row.id}/status`;
      for (const extra of [{ role: 'ADMIN' }, { passwordHash: 'x' }, { generationId: ZERO }]) {
        const res = await h.admin.patch(url, { status: 'ACTIVE', ...extra });
        expect(res.status, JSON.stringify(extra)).toBe(400);
      }
      const patchGen = await h.admin.patch(`${ADMIN_V1}/generations/${h.generationId}`, {
        status: 'ARCHIVED',
      });
      expect(patchGen.status).toBe(400);
      const pw = await a.post(`${V1}/auth/change-password`, {
        currentPassword: STUDENT_PASSWORD,
        newPassword: 'Yet-Another-Phrase-2026',
        role: 'ADMIN',
      });
      expect(pw.status).toBe(400);
      const signIn = await request(ctx.app.getHttpServer())
        .post(`${V1}/auth/login`)
        .set('Origin', WEB_ORIGIN)
        .send({ identifier: CODE_A, password: STUDENT_PASSWORD, role: 'ADMIN' });
      expect(signIn.status).toBe(400);
    });
  });

  describe('hidden terms and the cache', () => {
    const visibleTitles = async (s: Api) => offerings(await results(s)).map((c) => c.title);

    it('B-10 / B-12 hide takes effect at once on all four views, cached or not', async () => {
      expect((await visibleTitles(a)).length).toBeGreaterThan(0);
      const course = offerings(await results(a))[0]!;
      await a.get(`${V1}/student/me/courses/${course.offeringId}`).expect(200);

      await h.admin.post(`${ADMIN_V1}/terms/${h.termId}/release`, { visible: false }).expect(200);

      expect(await visibleTitles(a)).toEqual([]);
      expect((await a.get(`${V1}/student/me/courses`).expect(200)).body).toEqual([]);
      await a.get(`${V1}/student/me/courses/${course.offeringId}`).expect(404);
      const summary = (await a.get(`${V1}/student/me/summary`).expect(200)).body;
      expect(summary.overall.totalCourses).toBe(0);
      expect(summary.overall.provisionalAverage).toBeNull();
      expect(JSON.stringify(summary)).not.toContain(course.title);

      await h.admin.post(`${ADMIN_V1}/terms/${h.termId}/release`, { visible: true }).expect(200);
      expect((await visibleTitles(a)).length).toBeGreaterThan(0);
    });

    it('B-11 a sync change reaches a student with a cached view at once', async () => {
      await results(a);
      const sheet = termWorkbookFixture();
      sheet.tabs['Logic']![1]![5] = 10;
      h.reader.set(sheetIdA(), sheet);
      const source = await ctx.prisma.googleSheetSource.findFirstOrThrow({
        where: { spreadsheetId: sheetIdA() },
      });
      const job = await h.sync(source.id);
      expect(job.counts.scores['updated']).toBe(1);
      const logic = offerings(await results(a)).find((c) => c.title === 'Logic')!;
      // 78.9 - (90 - 10) × 10% = 70.9
      expect(logic.finalScore).toBe('70.90');
    });
  });
});

const sheetIdA = () => '1TermWorkbookFixture00000000000000000000';
