/* eslint-disable -- QA suite: uses expect messages, console evidence and supertest .expect() */
import request from 'supertest';
import { WEB_ORIGIN, type TestContext } from '../support/test-app.js';
import { ADMIN_V1, createHarness, editedFixture, SHEET_A, V1, type Harness } from './support.js';

/** QA suite, area F: student and admin flows. */

const CODE_1 = 'PNC2027-001';
const CODE_2 = 'PNC2027-002';

describe('QA F: student and admin flows', () => {
  let h: Harness;
  let ctx: TestContext;
  let source: string;

  beforeAll(async () => {
    h = await createHarness();
    ctx = h.ctx;
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reset();
    source = await h.importSheet();
  });

  const studentId = async (code: string) =>
    (await ctx.prisma.student.findUniqueOrThrow({ where: { studentCode: code } })).id;

  it('F-01 sync creates each account once, PENDING and locked; a second run creates none', async () => {
    const users = await ctx.prisma.user.findMany({ where: { role: 'STUDENT' } });
    expect(users).toHaveLength(3);
    for (const u of users) {
      expect(u.status).toBe('PENDING');
      expect(u.mustChangePassword).toBe(true);
      expect(u.passwordHash.startsWith('!locked:')).toBe(true);
    }
    const hashes = users.map((u) => u.passwordHash).toSorted();
    const job = await h.sync(source);
    expect(job.counts.students['created']).toBe(0);
    const again = await ctx.prisma.user.findMany({ where: { role: 'STUDENT' } });
    expect(again.map((u) => u.passwordHash).toSorted()).toEqual(hashes);
  });

  it('F-01b a later sync leaves an active account, password and session alone', async () => {
    const student = await h.activate(CODE_1);
    const before = await ctx.prisma.user.findFirstOrThrow({ where: { username: CODE_1 } });
    await h.sync(source);
    const after = await ctx.prisma.user.findFirstOrThrow({ where: { username: CODE_1 } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.status).toBe('ACTIVE');
    await student.get(`${V1}/auth/me`).expect(200);
  });

  it('F-02 a temporary password is shown once, no-store, and not retrievable', async () => {
    const id = await studentId(CODE_1);
    const res = await h.admin.post(`${ADMIN_V1}/students/${id}/reset-password`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const password = res.body.temporaryPassword as string;
    expect(password.replaceAll('-', '').length).toBeGreaterThanOrEqual(16);
    for (const path of [
      `/students/${id}`,
      `/students?q=${CODE_1}`,
      `/students/${id}/results`,
      `/audit-logs?pageSize=100`,
    ]) {
      const body = await h.admin.get(`${ADMIN_V1}${path}`).expect(200);
      expect(JSON.stringify(body.body), path).not.toContain(password);
    }
    const row = await ctx.prisma.user.findFirstOrThrow({ where: { username: CODE_1 } });
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(row.passwordHash).not.toContain(password);
    expect(row.passwordExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 13 * 864e5);
  });

  it('F-04 bulk issue leaves active students alone by default', async () => {
    await h.activate(CODE_1);
    const hash = (await ctx.prisma.user.findFirstOrThrow({ where: { username: CODE_1 } }))
      .passwordHash;
    const res = await h.admin
      .post(`${ADMIN_V1}/students/issue-credentials`, { generationId: h.generationId })
      .expect(200);
    expect(res.headers['x-issued-count']).toBe('2');
    const after = await ctx.prisma.user.findFirstOrThrow({ where: { username: CODE_1 } });
    expect(after.passwordHash).toBe(hash);
    const twice = await h.admin
      .post(`${ADMIN_V1}/students/issue-credentials`, { generationId: h.generationId })
      .expect(200);
    expect(twice.headers['x-issued-count']).toBe('0');
  });

  it('F-04b onlyPending:false never touches a disabled student', async () => {
    await h.activate(CODE_1);
    const id = await studentId(CODE_1);
    await h.admin.patch(`${ADMIN_V1}/students/${id}/status`, { status: 'DISABLED' }).expect(200);
    const res = await h.admin
      .post(`${ADMIN_V1}/students/issue-credentials`, {
        generationId: h.generationId,
        onlyPending: false,
      })
      .expect(200);
    expect(res.text).not.toContain(CODE_1);
    const row = await ctx.prisma.user.findFirstOrThrow({ where: { username: CODE_1 } });
    expect(row.status).toBe('DISABLED');
  });

  it('F-05 CSV: BOM, formula-safe, no-store, attachment', async () => {
    h.reader.set(
      SHEET_A,
      editedFixture((s) => {
        s.tabs['ALL']![3]![1] = '=1+1';
        s.tabs['ALL']![4]![1] = '@SUM(A1)';
        s.tabs['ALL']![5]![1] = '+1';
      }),
    );
    await h.sync(source);
    const res = await h.admin
      .post(`${ADMIN_V1}/students/issue-credentials`, { generationId: h.generationId })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const bytes = res.body as Buffer;
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['cache-control']).toBe('no-store');
    const text = bytes.toString('utf8');
    for (const line of text.split(/\r?\n/).slice(1)) {
      for (const cell of line.split(',')) {
        expect(cell.replace(/^"/, ''), line).not.toMatch(/^[=+@\t\r]/);
      }
    }
  });

  it('F-05b selection limits', async () => {
    const tooMany = Array.from({ length: 501 }, () => '00000000-0000-7000-8000-000000000000');
    const res = await h.admin.post(`${ADMIN_V1}/students/issue-credentials`, {
      studentIds: tooMany,
    });
    expect(res.status).toBe(400);
    const none = await h.admin.post(`${ADMIN_V1}/students/issue-credentials`, {});
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('SELECTION_REQUIRED');
  });

  it('F-06 student view: components and status; total only when complete', async () => {
    const student = await h.activate(CODE_1);
    const body = (await student.get(`${V1}/student/me/results`).expect(200)).body;
    expect(body.terms).toHaveLength(5);
    const courses = body.terms[0].courses as {
      title: string;
      status: string;
      finalScore: string | null;
      criteria: unknown[];
    }[];
    for (const course of courses) {
      expect(course.criteria.length).toBeGreaterThan(0);
      if (course.status === 'COMPLETE') expect(course.finalScore).not.toBeNull();
      else expect(course.finalScore).toBeNull();
    }
    expect(courses.map((c) => c.title).toSorted()).toEqual([
      'BCU',
      'ENG',
      'Logic',
      'MsOffice',
      'PL',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/teacherComment|sheetTotal|passwordHash/);
  });

  it('F-10 disable and enable are audited; disabling needs no login change', async () => {
    await h.activate(CODE_1);
    const id = await studentId(CODE_1);
    await h.admin.patch(`${ADMIN_V1}/students/${id}/status`, { status: 'DISABLED' }).expect(200);
    await h.admin.patch(`${ADMIN_V1}/students/${id}/status`, { status: 'ACTIVE' }).expect(200);
    const actions = (
      await ctx.prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } })
    ).map((a) => a.action);
    expect(
      actions.filter((a) => a.includes('status') || a.includes('disabled') || a.includes('enabled'))
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('F-10b PENDING cannot be activated without credentials; reset of a disabled account is refused', async () => {
    const id = await studentId(CODE_2);
    const res = await h.admin.patch(`${ADMIN_V1}/students/${id}/status`, { status: 'ACTIVE' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CREDENTIALS_NOT_ISSUED');
    await h.activate(CODE_1);
    const one = await studentId(CODE_1);
    await h.admin.patch(`${ADMIN_V1}/students/${one}/status`, { status: 'DISABLED' }).expect(200);
    const reset = await h.admin.post(`${ADMIN_V1}/students/${one}/reset-password`);
    expect(reset.status).toBe(409);
    expect(reset.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('F-11 a student who leaves and returns: same enrollment, marks kept, flag follows', async () => {
    h.reader.set(
      SHEET_A,
      editedFixture((s) => s.tabs['Logic']!.pop()),
    );
    await h.sync(source);
    const where = { student: { studentCode: 'PNC2027-003' }, offering: { title: 'Logic' } };
    const gone = await ctx.prisma.enrollment.findFirstOrThrow({ where });
    expect(gone.presentInSource).toBe(false);
    h.reader.set(
      SHEET_A,
      editedFixture(() => undefined),
    );
    const job = await h.sync(source);
    const back = await ctx.prisma.enrollment.findFirstOrThrow({ where });
    expect(back.id).toBe(gone.id);
    expect(back.presentInSource).toBe(true);
    expect(job.counts.scores).toMatchObject({ created: 0, updated: 0 });
  });

  it('F-12 audit rows cannot be changed or deleted', async () => {
    const row = await ctx.prisma.auditLog.findFirstOrThrow();
    await expect(
      ctx.prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'x' WHERE id = '${row.id}'`),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${row.id}'`),
    ).rejects.toThrow();
  });

  it('F-12b the audit log filters work and failed logins are recorded', async () => {
    await request(ctx.app.getHttpServer())
      .post(`${V1}/auth/login`)
      .set('Origin', WEB_ORIGIN)
      .send({ identifier: 'nobody', password: 'x' });
    const res = await h.admin.get(`${ADMIN_V1}/audit-logs?action=auth.`).expect(200);
    const actions = (res.body.data as { action: string }[]).map((a) => a.action);
    expect(actions).toContain('auth.login.failure');
    expect(actions.every((a) => a.startsWith('auth.'))).toBe(true);
  });

  describe('F-13 generations', () => {
    const body = { code: 'GEN2030', name: 'Generation 2030', startDate: '2030-01-07' };

    it('create: five terms, duplicate codes refused in any case, date order checked', async () => {
      const gen = (await h.admin.post(`${ADMIN_V1}/generations`, body).expect(201)).body;
      expect(
        gen.terms ?? (await h.admin.get(`${ADMIN_V1}/generations/${gen.id}/terms`)).body,
      ).toHaveLength(5);
      const dup = await h.admin.post(`${ADMIN_V1}/generations`, { ...body, code: 'gen2030' });
      expect(dup.status).toBe(409);
      const range = await h.admin.post(`${ADMIN_V1}/generations`, {
        ...body,
        code: 'GEN2031',
        endDate: '2029-01-01',
      });
      expect(range.status).toBe(422);
      for (const startDate of ['2030-02-30', '2030-13-01', 'tomorrow', '', '20300107']) {
        const bad = await h.admin.post(`${ADMIN_V1}/generations`, {
          ...body,
          code: 'GEN2032',
          startDate,
        });
        expect(bad.status, startDate).toBe(400);
      }
    });

    it('an archived generation is read-only and its students keep reading', async () => {
      const student = await h.activate(CODE_1);
      const url = `${ADMIN_V1}/generations/${h.generationId}`;
      await h.admin.post(`${url}/archive`).expect(200);
      expect((await h.admin.patch(url, { name: 'X' })).status).toBe(409);
      expect((await h.admin.patch(`${ADMIN_V1}/terms/${h.termId}`, { name: 'X' })).status).toBe(
        409,
      );
      expect(
        (await h.admin.post(`${ADMIN_V1}/terms/${h.termId}/release`, { visible: false })).status,
      ).toBe(409);
      expect(
        (await h.admin.post(`${ADMIN_V1}/sync`, { scope: 'SOURCE', sourceId: source })).status,
      ).toBe(409);
      await student.get(`${V1}/student/me/results`).expect(200);
      await h.admin.post(`${url}/activate`).expect(200);
      expect((await h.admin.patch(url, { name: 'Y' })).status).toBe(200);
    });
  });

  describe('F-14 restored from the deleted suite (T10)', () => {
    const ZERO = '00000000-0000-7000-8000-000000000000';

    it('unknown ids give 404, malformed ids give 400, on each detail route', async () => {
      for (const path of [
        `/students/${ZERO}`,
        `/students/${ZERO}/results`,
        `/generations/${ZERO}`,
        `/sources/${ZERO}`,
        `/sync/${ZERO}`,
      ]) {
        expect((await h.admin.get(`${ADMIN_V1}${path}`)).status, path).toBe(404);
        expect((await h.admin.get(`${ADMIN_V1}${path.replace(ZERO, 'abc')}`)).status, path).toBe(
          400,
        );
      }
    });

    it('lists are paginated and filtered', async () => {
      const res = await h.admin.get(`${ADMIN_V1}/students?pageSize=2&page=1`).expect(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta).toEqual({ page: 1, pageSize: 2, total: 3 });
      const q = await h.admin.get(`${ADMIN_V1}/students?q=${CODE_2}`).expect(200);
      expect(q.body.meta.total).toBe(1);
    });
  });
});
