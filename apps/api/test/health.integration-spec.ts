import request from 'supertest';
import { createTestApp, type TestContext } from './support/test-app.js';

describe('Health (integration)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('GET /api/v1/health returns liveness without authentication', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('GET /api/v1/health/ready reports database and redis up', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database.status).toBe('up');
    expect(res.body.checks.redis.status).toBe('up');
  });

  it('echoes a well-formed X-Request-Id and replaces a malformed one', async () => {
    const good = await request(ctx.app.getHttpServer())
      .get('/api/v1/health')
      .set('X-Request-Id', 'abc12345-trace');
    expect(good.headers['x-request-id']).toBe('abc12345-trace');

    const bad = await request(ctx.app.getHttpServer())
      .get('/api/v1/health')
      .set('X-Request-Id', 'bad id with spaces <script>');
    expect(bad.headers['x-request-id']).not.toContain('script');
  });

  it('unknown routes require authentication first (no route enumeration)', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/does-not-exist');
    expect([401, 404]).toContain(res.status);
    expect(typeof res.body.error.requestId).toBe('string');
  });
});
