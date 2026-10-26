import {
  api,
  createTestApp,
  login,
  resetState,
  seedUser,
  type TestContext,
} from './support/test-app.js';

const ADMIN = { username: 'admin', password: 'Admin-Initial-Pass-2026' };
const STUDENT = { username: 'GEN26-0001', password: 'Student-Initial-Pass-2026' };
const V1 = '/api/v1/admin';

describe('Academic management (integration)', () => {
  let ctx: TestContext;
  let admin: ReturnType<typeof api>;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    admin = api(await login(ctx, ADMIN.username, ADMIN.password));
  });

  async function seedStudent(status: 'PENDING' | 'ACTIVE' = 'ACTIVE') {
    const user = await seedUser(ctx, { ...STUDENT, role: 'STUDENT', status });
    return ctx.prisma.student.findUniqueOrThrow({ where: { userId: user.id } });
  }

  async function createGeneration(code = 'GEN2027') {
    const res = await admin
      .post(`${V1}/generations`, { code, name: `Generation ${code}`, startDate: '2027-01-04' })
      .expect(201);
    return res.body as { id: string; terms: { id: string; number: number }[] };
  }

  async function createOffering(generation?: Awaited<ReturnType<typeof createGeneration>>) {
    const gen = generation ?? (await createGeneration());
    const course = (
      await admin.post(`${V1}/courses`, { code: 'MATH101', name: 'Mathematics I' }).expect(201)
    ).body as { id: string };
    const offering = (
      await admin
        .post(`${V1}/offerings`, {
          termId: gen.terms[0]!.id,
          courseId: course.id,
          externalKey: 'T1-MATH101',
          title: 'Mathematics I',
          credits: 3,
        })
        .expect(201)
    ).body as { id: string; generationId: string };
    return { gen, course, offering };
  }

  async function addCriteria(offeringId: string, keys: string[]) {
    const ids: string[] = [];
    for (const key of keys) {
      const res = await admin
        .post(`${V1}/offerings/${offeringId}/criteria`, { key, name: key })
        .expect(201);
      ids.push(res.body.id as string);
    }
    return ids;
  }

  describe('generations & terms', () => {
    it('creates a generation with exactly five terms and audits it', async () => {
      const gen = await createGeneration();
      expect(gen.terms.map((t) => t.number)).toEqual([1, 2, 3, 4, 5]);
      expect(
        await ctx.prisma.auditLog.count({
          where: { action: 'generation.created', entityId: gen.id },
        }),
      ).toBe(1);
    });

    it('rejects duplicate codes case-insensitively, bad dates and inverted ranges', async () => {
      await createGeneration('GEN2027');
      const dup = await admin
        .post(`${V1}/generations`, { code: 'gen2027', name: 'x', startDate: '2027-01-01' })
        .expect(409);
      expect(dup.body.error.code).toBe('GENERATION_CODE_EXISTS');
      await admin
        .post(`${V1}/generations`, { code: 'G1', name: 'x', startDate: '2027-02-30' })
        .expect(400);
      const range = await admin
        .post(`${V1}/generations`, {
          code: 'G2',
          name: 'x',
          startDate: '2027-01-01',
          endDate: '2026-01-01',
        })
        .expect(422);
      expect(range.body.error.code).toBe('INVALID_DATE_RANGE');
      await admin
        .post(`${V1}/generations`, { code: 'bad code!', name: 'x', startDate: '2027-01-01' })
        .expect(400);
    });

    it('lists with pagination and search', async () => {
      for (const code of ['GEN2026', 'GEN2027', 'GEN2028']) await createGeneration(code);
      const page = await admin.get(`${V1}/generations?page=1&pageSize=2`).expect(200);
      expect(page.body.meta).toEqual({ page: 1, pageSize: 2, total: 3 });
      expect(page.body.data).toHaveLength(2);
      const search = await admin.get(`${V1}/generations?q=2027`).expect(200);
      expect(search.body.data.map((g: { code: string }) => g.code)).toEqual(['GEN2027']);
      await admin.get(`${V1}/generations?pageSize=500`).expect(400);
    });

    it('makes archived generations read-only until reactivated', async () => {
      const gen = await createGeneration();
      await admin.post(`${V1}/generations/${gen.id}/archive`).expect(200);
      const blocked = await admin
        .patch(`${V1}/generations/${gen.id}`, { name: 'Renamed' })
        .expect(409);
      expect(blocked.body.error.code).toBe('GENERATION_ARCHIVED');
      await admin.patch(`${V1}/terms/${gen.terms[0]!.id}`, { name: 'Semester 1' }).expect(409);

      await admin.post(`${V1}/generations/${gen.id}/activate`).expect(200);
      const renamed = await admin
        .patch(`${V1}/generations/${gen.id}`, { name: 'Renamed' })
        .expect(200);
      expect(renamed.body.name).toBe('Renamed');
      const term = await admin
        .patch(`${V1}/terms/${gen.terms[0]!.id}`, {
          name: 'Semester 1',
          startDate: '2027-01-04',
          endDate: '2027-04-30',
        })
        .expect(200);
      expect(term.body).toMatchObject({
        name: 'Semester 1',
        startDate: '2027-01-04',
        endDate: '2027-04-30',
      });
    });

    it('is admin-only', async () => {
      await seedUser(ctx, { ...STUDENT, role: 'STUDENT' });
      const student = api(await login(ctx, STUDENT.username, STUDENT.password));
      await student.get(`${V1}/generations`).expect(403);
      await student
        .post(`${V1}/generations`, { code: 'X1', name: 'x', startDate: '2027-01-01' })
        .expect(403);
    });

    it('returns 404 for unknown ids and 400 for malformed ids', async () => {
      await admin.get(`${V1}/generations/0199a3f0-0000-7000-8000-000000000000`).expect(404);
      await admin.get(`${V1}/generations/not-a-uuid`).expect(400);
    });
  });

  describe('courses & offerings', () => {
    it('creates catalog courses and offerings, rejecting duplicates', async () => {
      const { gen, course, offering } = await createOffering();
      await admin.post(`${V1}/courses`, { code: 'math101', name: 'dup' }).expect(409);
      const dup = await admin
        .post(`${V1}/offerings`, {
          termId: gen.terms[0]!.id,
          courseId: course.id,
          externalKey: 'OTHER',
          title: 'x',
        })
        .expect(409);
      expect(dup.body.error.code).toBe('OFFERING_EXISTS');

      // The same course may be offered again in another term.
      await admin
        .post(`${V1}/offerings`, {
          termId: gen.terms[1]!.id,
          courseId: course.id,
          externalKey: 'T2-MATH101',
          title: 'Mathematics I',
        })
        .expect(201);

      const list = await admin
        .get(`${V1}/offerings?generationId=${gen.id}&termNumber=1`)
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        id: offering.id,
        credits: '3.0',
        visibility: 'HIDDEN',
        term: { number: 1 },
        course: { code: 'MATH101' },
        publishedSchemeVersion: null,
      });
    });

    it('validates credits', async () => {
      const gen = await createGeneration();
      const course = (
        await admin.post(`${V1}/courses`, { code: 'ENG101', name: 'English' }).expect(201)
      ).body;
      for (const credits of [0, '0.0', -1, '1.25', 'abc']) {
        await admin
          .post(`${V1}/offerings`, {
            termId: gen.terms[0]!.id,
            courseId: course.id,
            externalKey: 'K',
            title: 'x',
            credits,
          })
          .expect(400);
      }
    });

    it('records an admin visibility override and invalidates cached results', async () => {
      const { gen, offering } = await createOffering();
      const before = await ctx.prisma.generation.findUniqueOrThrow({ where: { id: gen.id } });
      const res = await admin
        .patch(`${V1}/offerings/${offering.id}`, { visibility: 'VISIBLE' })
        .expect(200);
      expect(res.body).toMatchObject({ visibility: 'VISIBLE', visibilityOverridden: true });
      const after = await ctx.prisma.generation.findUniqueOrThrow({ where: { id: gen.id } });
      expect(after.cacheVersion).toBe(before.cacheVersion + 1);
    });
  });

  describe('assessment criteria', () => {
    it('adds criteria in order and rejects duplicate keys case-insensitively', async () => {
      const { offering } = await createOffering();
      await addCriteria(offering.id, ['Q1', 'Q2', 'MID']);
      const dup = await admin
        .post(`${V1}/offerings/${offering.id}/criteria`, { key: 'q1', name: 'again' })
        .expect(409);
      expect(dup.body.error.code).toBe('CRITERION_KEY_EXISTS');
      await admin
        .post(`${V1}/offerings/${offering.id}/criteria`, { key: '1bad', name: 'x' })
        .expect(400);

      const list = await admin.get(`${V1}/offerings/${offering.id}/criteria`).expect(200);
      expect(
        list.body.map((c: { key: string; displayOrder: number }) => [c.key, c.displayOrder]),
      ).toEqual([
        ['Q1', 1],
        ['Q2', 2],
        ['MID', 3],
      ]);
    });

    it('renames without touching scores and keeps the key immutable', async () => {
      const { offering } = await createOffering();
      const [q1] = await addCriteria(offering.id, ['Q1']);
      const student = await seedUser(ctx, { ...STUDENT, role: 'STUDENT' });
      const studentRow = await ctx.prisma.student.findUniqueOrThrow({
        where: { userId: student.id },
      });
      const enrollment = await ctx.prisma.enrollment.create({
        data: { studentId: studentRow.id, offeringId: offering.id },
      });
      const score = await ctx.prisma.assessmentScore.create({
        data: {
          enrollmentId: enrollment.id,
          offeringId: offering.id,
          criterionId: q1!,
          status: 'RECORDED',
          mark: 8,
        },
      });

      const renamed = await admin
        .patch(`${V1}/criteria/${q1}`, { name: 'Quiz One', category: 'QUIZ' })
        .expect(200);
      expect(renamed.body).toMatchObject({
        key: 'Q1',
        name: 'Quiz One',
        category: 'QUIZ',
        scoreCount: 1,
      });
      const stillThere = await ctx.prisma.assessmentScore.findUniqueOrThrow({
        where: { id: score.id },
      });
      expect(stillThere.criterionId).toBe(q1);

      await admin.patch(`${V1}/criteria/${q1}`, { key: 'QUIZ1' }).expect(400);
    });

    it('reorders criteria only with the complete set', async () => {
      const { offering } = await createOffering();
      const [a, b, c] = await addCriteria(offering.id, ['A', 'B', 'C']);
      const res = await admin
        .put(`${V1}/offerings/${offering.id}/criteria/order`, { criterionIds: [c, a, b] })
        .expect(200);
      expect(res.body.map((x: { key: string }) => x.key)).toEqual(['C', 'A', 'B']);
      const partial = await admin
        .put(`${V1}/offerings/${offering.id}/criteria/order`, { criterionIds: [a, b] })
        .expect(422);
      expect(partial.body.error.code).toBe('INVALID_CRITERIA_ORDER');
    });
  });

  describe('grading schemes', () => {
    it('saves drafts freely but only publishes schemes totalling 100%', async () => {
      const { offering } = await createOffering();
      const [q1, mid] = await addCriteria(offering.id, ['Q1', 'MID']);

      const draft = await admin
        .post(`${V1}/offerings/${offering.id}/grading-schemes`, {
          items: [
            { criterionId: q1, maxMark: 10, weight: 30 },
            { criterionId: mid, maxMark: '50', weight: '60' },
          ],
        })
        .expect(201);
      expect(draft.body).toMatchObject({ version: 1, status: 'DRAFT', totalWeight: '90.000' });
      expect(draft.body.validation.issues.map((i: { code: string }) => i.code)).toEqual([
        'WEIGHTS_NOT_100',
      ]);

      const rejected = await admin
        .post(`${V1}/grading-schemes/${draft.body.id}/publish`)
        .expect(422);
      expect(rejected.body.error.code).toBe('WEIGHTS_NOT_100');

      await admin
        .post(`${V1}/offerings/${offering.id}/grading-schemes`, {
          items: [
            { criterionId: q1, maxMark: 10, weight: '40' },
            { criterionId: mid, maxMark: '50', weight: '60' },
          ],
        })
        .expect(201);
      const valid = await admin
        .get(`${V1}/offerings/${offering.id}/grading-schemes/validate`)
        .expect(200);
      expect(valid.body).toEqual({ valid: true, totalWeight: '100.000', issues: [] });

      const before = await ctx.prisma.generation.findUniqueOrThrow({
        where: { id: offering.generationId },
      });
      const published = await admin
        .post(`${V1}/grading-schemes/${draft.body.id}/publish`)
        .expect(200);
      expect(published.body).toMatchObject({
        version: 1,
        status: 'PUBLISHED',
        totalWeight: '100.000',
      });
      const after = await ctx.prisma.generation.findUniqueOrThrow({
        where: { id: offering.generationId },
      });
      expect(after.cacheVersion).toBe(before.cacheVersion + 1);

      const criteria = await admin.get(`${V1}/offerings/${offering.id}/criteria`).expect(200);
      expect(criteria.body[0].published).toEqual({ maxMark: '10.000', weight: '40.000' });
    });

    it('versions schemes: publishing a new draft archives the previous version', async () => {
      const { offering } = await createOffering();
      const [q1, q2] = await addCriteria(offering.id, ['Q1', 'Q2']);
      const save = (w1: number, w2: number) =>
        admin.post(`${V1}/offerings/${offering.id}/grading-schemes`, {
          items: [
            { criterionId: q1, maxMark: 10, weight: w1 },
            { criterionId: q2, maxMark: 10, weight: w2 },
          ],
        });

      const v1 = (await save(50, 50).expect(201)).body;
      await admin.post(`${V1}/grading-schemes/${v1.id}/publish`).expect(200);
      const v2 = (await save(30, 70).expect(201)).body;
      expect(v2.version).toBe(2);
      await admin.post(`${V1}/grading-schemes/${v2.id}/publish`).expect(200);

      const history = await admin.get(`${V1}/offerings/${offering.id}/grading-schemes`).expect(200);
      expect(
        history.body.map((s: { version: number; status: string }) => [s.version, s.status]),
      ).toEqual([
        [2, 'PUBLISHED'],
        [1, 'ARCHIVED'],
      ]);
      // History is immutable.
      const del = await admin.delete(`${V1}/grading-schemes/${v1.id}`).expect(409);
      expect(del.body.error.code).toBe('SCHEME_NOT_DRAFT');
      await admin.post(`${V1}/grading-schemes/${v1.id}/publish`).expect(409);

      const v3 = (await save(20, 80).expect(201)).body;
      await admin.delete(`${V1}/grading-schemes/${v3.id}`).expect(204);
      expect(await ctx.prisma.gradingScheme.count({ where: { offeringId: offering.id } })).toBe(2);
    });

    it('refuses to lower a max mark below recorded marks', async () => {
      const { offering } = await createOffering();
      const [q1] = await addCriteria(offering.id, ['Q1']);
      const user = await seedUser(ctx, { ...STUDENT, role: 'STUDENT' });
      const student = await ctx.prisma.student.findUniqueOrThrow({ where: { userId: user.id } });
      const enrollment = await ctx.prisma.enrollment.create({
        data: { studentId: student.id, offeringId: offering.id },
      });
      await ctx.prisma.assessmentScore.create({
        data: {
          enrollmentId: enrollment.id,
          offeringId: offering.id,
          criterionId: q1!,
          status: 'RECORDED',
          mark: 9,
        },
      });

      const draft = (
        await admin
          .post(`${V1}/offerings/${offering.id}/grading-schemes`, {
            items: [{ criterionId: q1, maxMark: 5, weight: 100 }],
          })
          .expect(201)
      ).body;
      const res = await admin.post(`${V1}/grading-schemes/${draft.id}/publish`).expect(422);
      expect(res.body.error.code).toBe('MARKS_EXCEED_MAX');
      expect(res.body.error.issues[0]).toMatchObject({ code: 'MARKS_EXCEED_MAX', count: 1 });
    });

    it('rejects foreign, inactive, duplicate and over-precise items', async () => {
      const { gen, offering } = await createOffering();
      const [q1, q2] = await addCriteria(offering.id, ['Q1', 'Q2']);
      const eng = (
        await admin.post(`${V1}/courses`, { code: 'ENG101', name: 'English' }).expect(201)
      ).body;
      const other = (
        await admin
          .post(`${V1}/offerings`, {
            termId: gen.terms[0]!.id,
            courseId: eng.id,
            externalKey: 'T1-ENG101',
            title: 'English',
          })
          .expect(201)
      ).body;
      const [foreign] = await addCriteria(other.id, ['Q1']);
      const url = `${V1}/offerings/${offering.id}/grading-schemes`;

      expect(
        (
          await admin
            .post(url, { items: [{ criterionId: foreign, maxMark: 10, weight: 100 }] })
            .expect(422)
        ).body.error.code,
      ).toBe('CRITERION_NOT_IN_OFFERING');
      expect(
        (
          await admin
            .post(url, {
              items: [
                { criterionId: q1, maxMark: 10, weight: 50 },
                { criterionId: q1, maxMark: 10, weight: 50 },
              ],
            })
            .expect(422)
        ).body.error.code,
      ).toBe('DUPLICATE_CRITERION');
      await admin
        .post(url, { items: [{ criterionId: q1, maxMark: 10, weight: '33.3333' }] })
        .expect(400);
      await admin.post(url, { items: [{ criterionId: q1, maxMark: -1, weight: 100 }] }).expect(400);

      await admin.patch(`${V1}/criteria/${q2}`, { isActive: false }).expect(200);
      expect(
        (
          await admin
            .post(url, { items: [{ criterionId: q2, maxMark: 10, weight: 100 }] })
            .expect(422)
        ).body.error.code,
      ).toBe('INACTIVE_CRITERION');
    });

    it('applies the deactivation policy for criteria used in schemes', async () => {
      const { offering } = await createOffering();
      const [q1, q2] = await addCriteria(offering.id, ['Q1', 'Q2']);
      const url = `${V1}/offerings/${offering.id}/grading-schemes`;
      const v1 = (
        await admin
          .post(url, { items: [{ criterionId: q1, maxMark: 10, weight: 100 }] })
          .expect(201)
      ).body;
      await admin.post(`${V1}/grading-schemes/${v1.id}/publish`).expect(200);

      const inPublished = await admin
        .patch(`${V1}/criteria/${q1}`, { isActive: false })
        .expect(409);
      expect(inPublished.body.error.code).toBe('CRITERION_IN_PUBLISHED_SCHEME');

      const draft = (
        await admin
          .post(url, {
            items: [
              { criterionId: q1, maxMark: 10, weight: 60 },
              { criterionId: q2, maxMark: 10, weight: 40 },
            ],
          })
          .expect(201)
      ).body;
      await admin.patch(`${V1}/criteria/${q2}`, { isActive: false }).expect(200);
      const after = await admin.get(`${V1}/grading-schemes/${draft.id}`).expect(200);
      expect(after.body.items.map((i: { key: string }) => i.key)).toEqual(['Q1']);
      expect(after.body.totalWeight).toBe('60.000');
    });

    it('blocks scheme changes in archived generations', async () => {
      const { gen, offering } = await createOffering();
      const [q1] = await addCriteria(offering.id, ['Q1']);
      await admin.post(`${V1}/generations/${gen.id}/archive`).expect(200);
      const res = await admin
        .post(`${V1}/offerings/${offering.id}/grading-schemes`, {
          items: [{ criterionId: q1, maxMark: 10, weight: 100 }],
        })
        .expect(409);
      expect(res.body.error.code).toBe('GENERATION_ARCHIVED');
      await admin
        .post(`${V1}/offerings/${offering.id}/criteria`, { key: 'Q9', name: 'x' })
        .expect(409);
    });
  });

  describe('student accounts', () => {
    it('lists and searches students', async () => {
      await seedStudent();
      const res = await admin.get(`${V1}/students?q=0001`).expect(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0]).toMatchObject({
        studentCode: 'GEN26-0001',
        account: { status: 'ACTIVE', mustChangePassword: false, locked: false },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
      expect((await admin.get(`${V1}/students?status=PENDING`).expect(200)).body.meta.total).toBe(
        0,
      );
    });

    it('resets a password: shown once, forces a change, expires, revokes sessions', async () => {
      const student = await seedStudent();
      const studentSession = api(await login(ctx, STUDENT.username, STUDENT.password));

      const res = await admin.post(`${V1}/students/${student.id}/reset-password`).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { temporaryPassword, expiresAt } = res.body as {
        temporaryPassword: string;
        expiresAt: string;
      };
      expect(temporaryPassword).toMatch(/^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);

      await studentSession.get('/api/v1/auth/me').expect(401);
      const fresh = await login(ctx, STUDENT.username, temporaryPassword);
      expect(fresh.body.user.mustChangePassword).toBe(true);

      const logs = JSON.stringify(await ctx.prisma.auditLog.findMany());
      expect(logs).toContain('student.password.reset');
      expect(logs).not.toContain(temporaryPassword);
    });

    it('activates PENDING accounts only by issuing credentials', async () => {
      const student = await seedStudent('PENDING');
      const enable = await admin
        .patch(`${V1}/students/${student.id}/status`, { status: 'ACTIVE' })
        .expect(409);
      expect(enable.body.error.code).toBe('CREDENTIALS_NOT_ISSUED');

      await admin.post(`${V1}/students/${student.id}/reset-password`).expect(200);
      const view = await admin.get(`${V1}/students/${student.id}`).expect(200);
      expect(view.body.account).toMatchObject({ status: 'ACTIVE', mustChangePassword: true });
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'student.credentials.issued' } }),
      ).toBe(1);
    });

    it('disabling revokes sessions and blocks login and password resets', async () => {
      const student = await seedStudent();
      const studentSession = api(await login(ctx, STUDENT.username, STUDENT.password));

      await admin.patch(`${V1}/students/${student.id}/status`, { status: 'DISABLED' }).expect(200);
      expect((await studentSession.get('/api/v1/auth/me').expect(401)).body.error.code).toBe(
        'SESSION_REVOKED',
      );
      await expect(login(ctx, STUDENT.username, STUDENT.password)).rejects.toThrow(/403/);
      expect(
        (await admin.post(`${V1}/students/${student.id}/reset-password`).expect(409)).body.error
          .code,
      ).toBe('ACCOUNT_DISABLED');

      await admin.patch(`${V1}/students/${student.id}/status`, { status: 'ACTIVE' }).expect(200);
      await login(ctx, STUDENT.username, STUDENT.password);
    });
  });

  it('exposes audit logs to admins with prefix filtering', async () => {
    await createGeneration();
    const res = await admin.get(`${V1}/audit-logs?action=generation.`).expect(200);
    expect(res.body.data.map((l: { action: string }) => l.action)).toEqual(['generation.created']);
    expect(res.body.data[0].actor).toMatchObject({ username: 'admin', role: 'ADMIN' });
  });
});
