import request from 'supertest';
import { resultsCacheKey } from '../src/results/results.service.js';
import {
  api,
  createTestApp,
  login,
  resetState,
  seedUser,
  type TestContext,
} from './support/test-app.js';

const ADMIN = { username: 'admin', password: 'Admin-Initial-Pass-2026' };
const ALICE = { username: 'GEN26-0001', password: 'Student-Alice-Pass-2026' };
const BOB = { username: 'GEN26-0002', password: 'Student-Bob-Pass-2026' };
const ME = '/api/v1/student/me';

interface CriterionSpec {
  key: string;
  maxMark: string;
  weight: string;
}

describe('Student results (integration)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  /**
   * Generation GEN2026 (seeded by seedUser) with:
   *  T1 MATH101 visible, credits 3, scheme Q1 10/20 · MID 50/30 · FIN 100/50
   *  T1 ENG101  visible, credits 2, scheme Q1 10/40 · FIN 100/60
   *  T1 ART101  hidden,  credits 1, scheme P1 10/100
   *  T2 SCI101  visible, no published scheme
   *  T3 HIS101  visible, scheme H1 10/100 (Alice withdrawn)
   */
  async function seed() {
    await resetState(ctx);
    await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    const aliceUser = await seedUser(ctx, { ...ALICE, role: 'STUDENT' });
    const bobUser = await seedUser(ctx, { ...BOB, role: 'STUDENT' });
    const alice = await ctx.prisma.student.findUniqueOrThrow({ where: { userId: aliceUser.id } });
    const bob = await ctx.prisma.student.findUniqueOrThrow({ where: { userId: bobUser.id } });
    const generation = await ctx.prisma.generation.findUniqueOrThrow({
      where: { id: alice.generationId },
    });
    const terms = await Promise.all(
      [1, 2, 3, 4, 5].map((number) =>
        ctx.prisma.term.create({
          data: { generationId: generation.id, number, name: `Term ${number}` },
        }),
      ),
    );

    async function offering(
      termNumber: number,
      code: string,
      credits: number,
      visibility: 'VISIBLE' | 'HIDDEN',
      criteria: CriterionSpec[] | null,
    ) {
      const course = await ctx.prisma.course.create({ data: { code, name: code } });
      const o = await ctx.prisma.courseOffering.create({
        data: {
          termId: terms[termNumber - 1]!.id,
          generationId: generation.id,
          courseId: course.id,
          externalKey: `T${termNumber}-${code}`,
          title: `${code} title`,
          credits,
          visibility,
        },
      });
      const criterionIds: Record<string, string> = {};
      if (criteria) {
        for (const [i, c] of criteria.entries()) {
          const row = await ctx.prisma.assessmentCriterion.create({
            data: { offeringId: o.id, key: c.key, name: `${c.key} name`, displayOrder: i + 1 },
          });
          criterionIds[c.key] = row.id;
        }
        const scheme = await ctx.prisma.gradingScheme.create({
          data: {
            offeringId: o.id,
            version: 1,
            origin: 'ADMIN',
            totalWeight: 100,
          },
        });
        await ctx.prisma.gradingSchemeItem.createMany({
          data: criteria.map((c) => ({
            schemeId: scheme.id,
            offeringId: o.id,
            criterionId: criterionIds[c.key]!,
            maxMark: c.maxMark,
            weight: c.weight,
          })),
        });
        await ctx.prisma.gradingScheme.update({
          where: { id: scheme.id },
          data: { status: 'PUBLISHED', publishedAt: new Date() },
        });
      }
      return { id: o.id, criterionIds };
    }

    const math = await offering(1, 'MATH101', 3, 'VISIBLE', [
      { key: 'Q1', maxMark: '10', weight: '20' },
      { key: 'MID', maxMark: '50', weight: '30' },
      { key: 'FIN', maxMark: '100', weight: '50' },
    ]);
    const eng = await offering(1, 'ENG101', 2, 'VISIBLE', [
      { key: 'Q1', maxMark: '10', weight: '40' },
      { key: 'FIN', maxMark: '100', weight: '60' },
    ]);
    const art = await offering(1, 'ART101', 1, 'HIDDEN', [
      { key: 'P1', maxMark: '10', weight: '100' },
    ]);
    const sci = await offering(2, 'SCI101', 4, 'VISIBLE', null);
    const his = await offering(3, 'HIS101', 2, 'VISIBLE', [
      { key: 'H1', maxMark: '10', weight: '100' },
    ]);

    async function enroll(
      studentId: string,
      o: { id: string; criterionIds: Record<string, string> },
      marks: Record<string, string | 'ABS'>,
      status: 'ENROLLED' | 'WITHDRAWN' = 'ENROLLED',
    ) {
      const enrollment = await ctx.prisma.enrollment.create({
        data: { studentId, offeringId: o.id, status },
      });
      for (const [key, mark] of Object.entries(marks)) {
        await ctx.prisma.assessmentScore.create({
          data: {
            enrollmentId: enrollment.id,
            offeringId: o.id,
            criterionId: o.criterionIds[key]!,
            status: mark === 'ABS' ? 'ABSENT' : 'RECORDED',
            mark: mark === 'ABS' ? 0 : mark,
          },
        });
      }
    }

    await enroll(alice.id, math, { Q1: '8', MID: '40', FIN: 'ABS' });
    await enroll(alice.id, eng, { Q1: '7' });
    await enroll(alice.id, art, { P1: '9' });
    await enroll(alice.id, sci, {});
    await enroll(alice.id, his, { H1: '5' }, 'WITHDRAWN');
    await enroll(bob.id, math, { Q1: '10', MID: '50', FIN: '100' });

    return { generation, alice, bob, math, eng, art, sci, his };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;
  let s: Seeded;
  let alice: ReturnType<typeof api>;
  let bob: ReturnType<typeof api>;
  let admin: ReturnType<typeof api>;

  beforeEach(async () => {
    s = await seed();
    alice = api(await login(ctx, ALICE.username, ALICE.password));
    bob = api(await login(ctx, BOB.username, BOB.password));
    admin = api(await login(ctx, ADMIN.username, ADMIN.password));
  });

  describe('results', () => {
    it('returns all five terms with computed course results from raw marks', async () => {
      const res = await alice.get(`${ME}/results`).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.student).toMatchObject({
        studentCode: 'GEN26-0001',
        generation: { code: 'GEN2026', name: 'Generation 2026' },
      });
      expect(res.body.terms.map((t: { number: number }) => t.number)).toEqual([1, 2, 3, 4, 5]);

      const [t1, t2, t3] = res.body.terms;
      // ART101 is hidden; ENG101 sorts before MATH101.
      expect(t1.courses.map((c: { courseCode: string }) => c.courseCode)).toEqual([
        'ENG101',
        'MATH101',
      ]);
      const [eng, math] = t1.courses;
      expect(math).toMatchObject({
        offeringId: s.math.id,
        termNumber: 1,
        credits: '3.0',
        status: 'COMPLETE',
        schemeVersion: 1,
        finalScore: '40.00',
        attemptedWeight: '100.000',
        earnedSoFar: '40.00',
      });
      expect(math.admin).toBeUndefined();
      expect(math.criteria).toEqual([
        expect.objectContaining({
          key: 'Q1',
          order: 1,
          maxMark: '10.000',
          weight: '20.000',
          score: { status: 'RECORDED', mark: '8.000' },
          contribution: '16.00',
        }),
        expect.objectContaining({ key: 'MID', contribution: '24.00' }),
        expect.objectContaining({
          key: 'FIN',
          score: { status: 'ABSENT', mark: '0.000' },
          contribution: '0.00',
        }),
      ]);
      // Missing mark is never zero: INCOMPLETE with progress, no final score.
      expect(eng).toMatchObject({
        status: 'INCOMPLETE',
        finalScore: null,
        attemptedWeight: '40.000',
        earnedSoFar: '28.00',
      });
      expect(eng.criteria[1]).toMatchObject({ key: 'FIN', score: null, contribution: null });

      expect(t1.summary).toEqual({
        status: 'INCOMPLETE',
        average: null,
        provisionalAverage: '40.00',
        completedCourses: 1,
        totalCourses: 2,
        creditsCompleted: '3.0',
        creditsTotal: '5.0',
      });
      expect(t2.courses).toEqual([
        expect.objectContaining({
          courseCode: 'SCI101',
          status: 'NOT_CONFIGURED',
          schemeVersion: null,
          criteria: [],
          finalScore: null,
        }),
      ]);
      // Withdrawn enrollments are not shown to students.
      expect(t3.courses).toEqual([]);
      expect(t3.summary.status).toBe('EMPTY');
    });

    it('filters to one term and validates the term parameter', async () => {
      const res = await alice.get(`${ME}/results?term=2`).expect(200);
      expect(res.body.terms.map((t: { number: number }) => t.number)).toEqual([2]);
      await alice.get(`${ME}/results?term=6`).expect(400);
      await alice.get(`${ME}/results?term=x`).expect(400);
    });

    it('serves the profile, the course list, one course and the summary', async () => {
      const profile = await alice.get(ME).expect(200);
      expect(profile.body).toEqual({
        id: s.alice.id,
        studentCode: 'GEN26-0001',
        fullName: 'Student GEN26-0001',
        gender: 'UNSPECIFIED',
        className: null,
        generation: { id: s.generation.id, code: 'GEN2026', name: 'Generation 2026' },
      });

      const courses = await alice.get(`${ME}/courses`).expect(200);
      expect(courses.body).toEqual([
        expect.objectContaining({ courseCode: 'ENG101', status: 'INCOMPLETE', finalScore: null }),
        expect.objectContaining({ courseCode: 'MATH101', status: 'COMPLETE', finalScore: '40.00' }),
        expect.objectContaining({ courseCode: 'SCI101', status: 'NOT_CONFIGURED' }),
      ]);
      expect(courses.body[0].criteria).toBeUndefined();

      const course = await alice.get(`${ME}/courses/${s.math.id}`).expect(200);
      expect(course.body).toMatchObject({ courseCode: 'MATH101', finalScore: '40.00' });

      const summary = await alice.get(`${ME}/summary`).expect(200);
      expect(summary.body.terms).toHaveLength(5);
      expect(summary.body.overall).toMatchObject({
        status: 'INCOMPLETE',
        completedCourses: 1,
        totalCourses: 3,
        creditsTotal: '9.0',
        provisionalAverage: '40.00',
      });
    });
  });

  describe('access control (STU-01, STU-04)', () => {
    it('returns 404 for hidden, withdrawn, not-enrolled and unknown offerings', async () => {
      for (const id of [s.art.id, s.his.id, '01900000-0000-7000-8000-000000000000']) {
        const res = await alice.get(`${ME}/courses/${id}`).expect(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      // Bob is enrolled only in MATH101; Alice's other courses look like they don't exist.
      await bob.get(`${ME}/courses/${s.eng.id}`).expect(404);
      await alice.get(`${ME}/courses/not-a-uuid`).expect(400);
    });

    it('ignores every attempt to name another student', async () => {
      // Unknown query parameters are rejected rather than silently honoured.
      await alice.get(`${ME}/results?studentId=${s.bob.id}`).expect(400);
      await alice.get(`${ME}/results?studentCode=GEN26-0002`).expect(400);
      // Header spoofing has no effect: identity comes only from the access token.
      const res = await alice.get(`${ME}/results`).set('X-Student-Id', s.bob.id).expect(200);
      expect(res.body.student.studentCode).toBe('GEN26-0001');
      // Admin routes stay closed to students.
      await alice.get(`/api/v1/admin/students/${s.bob.id}/results`).expect(403);

      const bobMath = await bob.get(`${ME}/courses/${s.math.id}`).expect(200);
      expect(bobMath.body.finalScore).toBe('100.00');
    });

    it('denies unauthenticated users, admins and students who must change their password', async () => {
      await request(ctx.app.getHttpServer()).get(`${ME}/results`).expect(401);
      await admin.get(`${ME}/results`).expect(403);

      await ctx.prisma.user.update({
        where: { id: s.alice.userId },
        data: { mustChangePassword: true },
      });
      const forced = api(await login(ctx, ALICE.username, ALICE.password));
      const res = await forced.get(`${ME}/results`).expect(403);
      expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    });
  });

  describe('caching', () => {
    it('caches per student under the generation version and isolates students', async () => {
      await alice.get(`${ME}/results`).expect(200);
      await bob.get(`${ME}/results`).expect(200);
      const version = s.generation.cacheVersion;
      const aliceKey = resultsCacheKey(s.generation.id, version, s.alice.id);
      const bobKey = resultsCacheKey(s.generation.id, version, s.bob.id);
      expect(await ctx.redis.ttl(aliceKey)).toBeGreaterThan(0);
      expect(JSON.parse((await ctx.redis.get(bobKey))!).results.student.studentCode).toBe(
        'GEN26-0002',
      );

      // A cached entry is served as is (proves the read path uses the cache).
      const cached = JSON.parse((await ctx.redis.get(aliceKey))!);
      cached.results.student.fullName = 'From cache';
      await ctx.redis.set(aliceKey, JSON.stringify(cached));
      expect((await alice.get(ME).expect(200)).body.fullName).toBe('From cache');
      // Bob never sees Alice's entry.
      expect((await bob.get(ME).expect(200)).body.studentCode).toBe('GEN26-0002');
    });

    it('stops serving stale results after an admin visibility change', async () => {
      await alice.get(`${ME}/results`).expect(200);
      await admin
        .patch(`/api/v1/admin/offerings/${s.art.id}`, { visibility: 'VISIBLE' })
        .expect(200);
      const res = await alice.get(`${ME}/courses/${s.art.id}`).expect(200);
      expect(res.body).toMatchObject({ status: 'COMPLETE', finalScore: '90.00' });

      await admin
        .patch(`/api/v1/admin/offerings/${s.math.id}`, { visibility: 'HIDDEN' })
        .expect(200);
      await alice.get(`${ME}/courses/${s.math.id}`).expect(404);
    });

    it('reflects term and generation renames', async () => {
      await alice.get(`${ME}/results`).expect(200);
      const term = await ctx.prisma.term.findFirstOrThrow({
        where: { generationId: s.generation.id, number: 1 },
      });
      await admin.patch(`/api/v1/admin/terms/${term.id}`, { name: 'Semester One' }).expect(200);
      await admin
        .patch(`/api/v1/admin/generations/${s.generation.id}`, { name: 'Class of 2026' })
        .expect(200);
      const res = await alice.get(`${ME}/results?term=1`).expect(200);
      expect(res.body.terms[0].name).toBe('Semester One');
      expect(res.body.student.generation.name).toBe('Class of 2026');
    });

    it('falls back to PostgreSQL when the cached entry is unreadable', async () => {
      await alice.get(`${ME}/results`).expect(200);
      const key = resultsCacheKey(s.generation.id, s.generation.cacheVersion, s.alice.id);
      await ctx.redis.set(key, '{not json');
      const res = await alice.get(`${ME}/results`).expect(200);
      expect(res.body.student.studentCode).toBe('GEN26-0001');
    });
  });

  describe('admin view', () => {
    it('includes hidden offerings and withdrawn enrollments with metadata', async () => {
      const res = await admin.get(`/api/v1/admin/students/${s.alice.id}/results`).expect(200);
      const [t1, , t3] = res.body.terms;
      expect(t1.courses.map((c: { courseCode: string }) => c.courseCode)).toEqual([
        'ART101',
        'ENG101',
        'MATH101',
      ]);
      expect(t1.courses[0].admin).toEqual({
        visibility: 'HIDDEN',
        enrollmentStatus: 'ENROLLED',
        presentInSource: true,
      });
      expect(t1.summary.totalCourses).toBe(3);
      expect(t3.courses[0]).toMatchObject({
        courseCode: 'HIS101',
        admin: { enrollmentStatus: 'WITHDRAWN' },
      });
      // Withdrawn courses are listed but not counted.
      expect(t3.summary).toMatchObject({ status: 'EMPTY', totalCourses: 0 });

      // Never cached.
      expect(await ctx.redis.keys('ssrs:v1:results:*')).toEqual([]);
      await admin
        .get('/api/v1/admin/students/01900000-0000-7000-8000-000000000000/results')
        .expect(404);
    });
  });
});
