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

describe('Admin dashboard (integration)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
  });

  it('returns counts and recent jobs to admins only', async () => {
    const adminUser = await seedUser(ctx, { ...ADMIN, role: 'ADMIN' });
    await seedUser(ctx, { ...STUDENT, role: 'STUDENT' });
    await seedUser(ctx, {
      username: 'GEN26-0002',
      password: STUDENT.password,
      role: 'STUDENT',
      status: 'PENDING',
    });
    const generation = await ctx.prisma.generation.findFirstOrThrow();
    await ctx.prisma.syncJob.create({
      data: {
        scope: 'GENERATION',
        generationId: generation.id,
        status: 'FAILED',
        failureCode: 'NO_SOURCES',
        requestedById: adminUser.id,
        finishedAt: new Date(),
      },
    });

    const admin = api(await login(ctx, ADMIN.username, ADMIN.password));
    const res = await admin.get('/api/v1/admin/dashboard').expect(200);
    expect(res.body).toMatchObject({
      generations: { active: 1, archived: 0 },
      students: { total: 2, pending: 1, active: 1, disabled: 0 },
      sources: { active: 0, disabled: 0 },
      offerings: { total: 0, visible: 0, withoutPublishedScheme: 0 },
      jobs: { active: 0, failedRecently: 1, failedWindowDays: 7 },
    });
    expect(res.body.recentJobs).toHaveLength(1);
    expect(res.body.recentJobs[0]).toMatchObject({ status: 'FAILED', scope: 'GENERATION' });

    const student = api(await login(ctx, STUDENT.username, STUDENT.password));
    await student.get('/api/v1/admin/dashboard').expect(403);
  });
});
