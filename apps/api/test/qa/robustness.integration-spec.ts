/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import request from 'supertest';
import { WEB_ORIGIN, type TestContext } from '../support/test-app.js';
import {
  ADMIN_V1,
  call,
  createHarness,
  fillPath,
  liveRoutes,
  sheetUrl,
  V1,
  type Harness,
} from './support.js';

/** QA suite, area G: hostile input. Every route list comes from the running app. */

const LEAK =
  /\bat [\w.<>]+ \(|node_modules|\.ts:\d+|[Pp]risma|[Pp]ostgres|SELECT |INSERT |invalid input|stack trace/;
const NUL = 'a\u0000b';

function assertClean(res: request.Response, label: string) {
  expect.soft(res.status, `${label}: ${res.text?.slice(0, 120)}`).toBeLessThan(500);
  if (res.status >= 400 && res.type === 'application/json') {
    expect.soft(res.body.error?.code, label).toBeTruthy();
    expect.soft(JSON.stringify(res.body), label).not.toMatch(LEAK);
  }
}

describe('QA G: robustness', () => {
  let h: Harness;
  let ctx: TestContext;
  let source: string;

  beforeAll(async () => {
    h = await createHarness();
    ctx = h.ctx;
    await h.reset();
    source = await h.importSheet();
  });
  afterAll(async () => h.close());

  const send = (method: string, path: string) =>
    call(h.session.agent, method, path)
      .set('Origin', WEB_ORIGIN)
      .set('X-CSRF-Token', h.session.csrf);

  const writeRoutes = () =>
    liveRoutes(ctx).filter(
      (r) =>
        r.method !== 'get' &&
        !r.path.endsWith('/auth/logout') &&
        !r.path.endsWith('/generations/:id/archive'),
    );

  it('G-01 every write route survives malformed bodies', async () => {
    const bodies: unknown[] = [
      {},
      [],
      'text',
      42,
      true,
      { a: { b: { c: { d: { e: { f: {} } } } } } },
      { name: null, label: null, url: null, status: null, scope: null, code: null },
      { name: 1, label: 1, url: 1, status: 1, scope: 1, code: 1, startDate: 1 },
      { columns: 'x', subjectName: [] },
      { columns: [null], subjectName: 'x' },
      { columns: [{ columnIndex: 'x', role: 'NOPE' }], subjectName: 'x' },
      { studentIds: 'x' },
      { studentIds: [1, 2] },
      { visible: 'yes' },
      { __proto__: { admin: true }, constructor: { prototype: {} } },
    ];
    for (const route of writeRoutes()) {
      const path = fillPath(route.path);
      for (const body of bodies) {
        const res = await send(route.method, path)
          .set('Content-Type', 'application/json')
          .send(JSON.stringify(body));
        assertClean(res, `${route.method} ${route.path} ${JSON.stringify(body).slice(0, 40)}`);
      }
    }
  }, 120_000);

  it('G-02 very long strings', async () => {
    const huge = 'x'.repeat(100_000);
    const server = request(ctx.app.getHttpServer());
    const started = Date.now();
    const res = await server
      .post(`${V1}/auth/login`)
      .set('Origin', WEB_ORIGIN)
      .send({ identifier: huge, password: huge });
    expect.soft(res.status, 'a 100 KB login body').toBe(400);
    expect(Date.now() - started).toBeLessThan(1000);
    assertClean(
      await h.admin.post(`${ADMIN_V1}/generations`, {
        code: huge,
        name: huge,
        startDate: '2030-01-01',
      }),
      'generation',
    );
    assertClean(await h.admin.patch(`${ADMIN_V1}/sources/${source}`, { label: huge }), 'label');
    assertClean(await h.admin.get(`${ADMIN_V1}/students?q=${'x'.repeat(20_000)}`), 'q');
    assertClean(await h.admin.get(`${ADMIN_V1}/audit-logs?action=${'x'.repeat(20_000)}`), 'action');
  });

  it('G-03 SQL injection strings change nothing and leak nothing', async () => {
    const before = await ctx.prisma.student.count();
    for (const s of [
      "' OR '1'='1",
      "'; DROP TABLE students; --",
      '" OR ""="',
      '%',
      '_',
      '\\',
      "1' UNION SELECT password_hash FROM users--",
      '$(whoami)',
      '{{7*7}}',
    ]) {
      const q = encodeURIComponent(s);
      const list = await h.admin.get(`${ADMIN_V1}/students?q=${q}`);
      assertClean(list, `q=${s}`);
      expect(JSON.stringify(list.body), s).not.toContain('$argon2');
      if (s === "' OR '1'='1") expect(list.body.meta.total).toBe(0);
      assertClean(await h.admin.get(`${ADMIN_V1}/generations?q=${q}`), `gen q=${s}`);
      assertClean(await h.admin.get(`${ADMIN_V1}/students?className=${q}`), `class=${s}`);
      assertClean(await h.admin.get(`${ADMIN_V1}/audit-logs?action=${q}`), `action=${s}`);
      assertClean(
        await request(ctx.app.getHttpServer())
          .post(`${V1}/auth/login`)
          .set('Origin', WEB_ORIGIN)
          .send({ identifier: s.slice(0, 60), password: s }),
        `login ${s}`,
      );
      await ctx.redis.flushdb();
    }
    expect(await ctx.prisma.student.count()).toBe(before);
  });

  describe('G-04 NUL bytes (PostgreSQL text cannot hold them)', () => {
    it.each([
      ['students q', `/students?q=${encodeURIComponent(NUL)}`],
      ['students className', `/students?className=${encodeURIComponent(NUL)}`],
      ['generations q', `/generations?q=${encodeURIComponent(NUL)}`],
      ['audit action', `/audit-logs?action=${encodeURIComponent(NUL)}`],
      ['audit entityType', `/audit-logs?entityType=${encodeURIComponent(NUL)}`],
    ])('GET %s', async (name, path) => {
      assertClean(await h.admin.get(`${ADMIN_V1}${path}`), name);
    });

    it('login identifier and password', async () => {
      await ctx.redis.flushdb();
      const server = request(ctx.app.getHttpServer());
      assertClean(
        await server
          .post(`${V1}/auth/login`)
          .set('Origin', WEB_ORIGIN)
          .send({ identifier: NUL, password: 'x' }),
        'identifier',
      );
      assertClean(
        await server
          .post(`${V1}/auth/login`)
          .set('Origin', WEB_ORIGIN)
          .send({ identifier: 'nobody', password: NUL }),
        'password',
      );
    });

    it('generation name, code, term name, sheet label', async () => {
      assertClean(
        await h.admin.post(`${ADMIN_V1}/generations`, {
          code: 'GEN2099',
          name: NUL,
          startDate: '2030-01-01',
        }),
        'gen name',
      );
      assertClean(await h.admin.patch(`${ADMIN_V1}/terms/${h.termId}`, { name: NUL }), 'term');
      assertClean(await h.admin.patch(`${ADMIN_V1}/sources/${source}`, { label: NUL }), 'label');
      assertClean(
        await h.admin.post(`${ADMIN_V1}/terms/${h.terms[2]}/sources`, {
          url: sheetUrl('1QaNoSuchSheet000000000000000000000000000'),
          label: NUL,
        }),
        'new label',
      );
    });
  });

  it('G-05b stored script strings come back as plain JSON text', async () => {
    const script = '<img src=x onerror=alert(1)>';
    const res = await h.admin.patch(`${ADMIN_V1}/terms/${h.termId}`, { name: script });
    assertClean(res, 'term name');
    const back = await h.admin.get(`${ADMIN_V1}/generations/${h.generationId}`).expect(200);
    expect(back.type).toBe('application/json');
    await h.admin.patch(`${ADMIN_V1}/terms/${h.termId}`, { name: 'Term 1' }).expect(200);
  });

  it('G-06 an oversized payload gets 413 in the standard format', async () => {
    const res = await send('post', `${ADMIN_V1}/generations`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ code: 'x', name: 'y'.repeat(5_000_000), startDate: '2030-01-01' }));
    expect.soft(res.status).toBe(413);
    expect(res.body.error?.code).toBeTruthy();
    expect(res.text).not.toMatch(LEAK);
  });

  it('G-07 malformed JSON, wrong content type, bad charset', async () => {
    const cases: [string, string][] = [
      ['application/json', '{"a":'],
      ['application/json', '{'],
      ['application/json', 'null'],
      ['application/json; charset=nonsense', '{}'],
      ['text/plain', 'hello'],
      ['application/xml', '<a/>'],
      ['application/x-www-form-urlencoded', 'a=1&a=2'],
      ['multipart/form-data; boundary=x', '--x--'],
    ];
    for (const [type, body] of cases) {
      const res = await send('post', `${ADMIN_V1}/generations`)
        .set('Content-Type', type)
        .send(body);
      assertClean(res, `${type} ${body}`);
      expect.soft(res.status, `${type} ${body}`).toBeGreaterThanOrEqual(400);
    }
  });

  it('G-07b malformed percent-encoding in a path', async () => {
    for (const path of [
      `${ADMIN_V1}/students/%E0%A4%A`,
      `${ADMIN_V1}/students/%`,
      `${V1}/%c0%ae`,
    ]) {
      assertClean(await h.session.agent.get(path), path);
    }
  });

  describe('G-11 pagination limits', () => {
    const lists = (job: string) => [
      '/generations',
      '/students',
      '/sync',
      '/audit-logs',
      `/sources/${source}/sync-history`,
      `/sync/${job}/errors`,
    ];
    let job = '';
    beforeAll(async () => {
      job = (await ctx.prisma.syncJob.findFirstOrThrow()).id;
    });

    it.each([
      ['pageSize=0', 400],
      ['pageSize=-1', 400],
      ['pageSize=101', 400],
      ['pageSize=abc', 400],
      ['pageSize=1.5', 400],
      ['page=0', 400],
      ['page=-1', 400],
      ['page=abc', 400],
      ['page=1e308', 400],
      ['page=99999999999999999999', 400],
      ['page=9007199254740991', 200],
      ['page=2147483648', 200],
    ])('%s', async (q, expected) => {
      for (const path of lists(job)) {
        const res = await h.admin.get(`${ADMIN_V1}${path}?${q}`);
        assertClean(res, `${path}?${q}`);
        expect.soft(res.status, `${path}?${q}`).toBe(expected);
      }
    });

    it('accepts the maximum', async () => {
      for (const path of lists(job)) {
        await h.admin.get(`${ADMIN_V1}${path}?pageSize=100`).expect(200);
      }
    });
  });

  it('G-12 filters with invalid values', async () => {
    for (const path of [
      '/audit-logs?from=not-a-date',
      '/audit-logs?to=2026-99-99',
      '/audit-logs?actorUserId=abc',
      '/students?generationId=abc',
      '/students?status=NOPE',
      '/sync?status=NOPE',
      '/sync?generationId=abc',
      '/generations?status=NOPE',
    ]) {
      const res = await h.admin.get(`${ADMIN_V1}${path}`);
      assertClean(res, path);
      expect.soft(res.status, path).toBe(400);
    }
  });
});
