import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { PrismaClient, UserRole, UserStatus } from '@ssrs/database';
import { truncateAllTables } from '@ssrs/database/testing';
import type { SheetsReader } from '@ssrs/sheets';
import { InMemorySheetsReader } from '@ssrs/sheets/testing';
import { loadRootEnv } from '@ssrs/shared/node';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { PasswordService } from '../../src/auth/password.service.js';
import { configureApp } from '../../src/bootstrap.js';
import { loadApiEnv, type ApiEnv } from '../../src/config/env.js';
import { PrismaService } from '../../src/infra/prisma.service.js';
import { RedisService } from '../../src/infra/redis.service.js';
import { SHEETS_READER } from '../../src/sheets-sources/sheets-reader.provider.js';
import { TestRoutesController } from './test-routes.controller.js';

export const WEB_ORIGIN = 'http://localhost:3000';

export interface TestContext {
  app: INestApplication<App>;
  env: ApiEnv;
  prisma: PrismaClient;
  redis: Redis;
  passwords: PasswordService;
  close(): Promise<void>;
}

function testEnv(): ApiEnv {
  loadRootEnv();
  const dbUrl = process.env['TEST_DATABASE_URL'];
  const redisUrl = process.env['TEST_REDIS_URL'];
  if (!dbUrl || !redisUrl) throw new Error('TEST_DATABASE_URL and TEST_REDIS_URL must be set');
  if (new URL(redisUrl).pathname !== '/15') {
    throw new Error('TEST_REDIS_URL must select Redis database 15 (it is flushed by tests)');
  }
  return loadApiEnv({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: dbUrl,
    REDIS_URL: redisUrl,
    WEB_ORIGIN,
    JWT_ACCESS_SECRET: 'integration-test-secret-integration-test-secret',
    SWAGGER_ENABLED: 'false',
    COOKIE_SECURE: 'false',
  });
}

export interface TestAppOptions {
  /** Replaces the Google Sheets reader (defaults to an empty in-memory reader). */
  sheetsReader?: SheetsReader;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestContext> {
  const env = testEnv();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(env)],
    controllers: [TestRoutesController],
  })
    .overrideProvider(SHEETS_READER)
    .useValue(options.sheetsReader ?? new InMemorySheetsReader())
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app, env);
  await app.init();

  const prisma = app.get(PrismaService).client;
  const redis = app.get(RedisService).client;
  return {
    app: app as unknown as INestApplication<App>,
    env,
    prisma,
    redis,
    passwords: app.get(PasswordService),
    close: () => app.close(),
  };
}

export async function resetState(ctx: TestContext): Promise<void> {
  await truncateAllTables(ctx.prisma);
  await ctx.redis.flushdb();
}

/** Clears rate-limit counters (simulates the window elapsing). */
export async function clearRateLimits(ctx: TestContext): Promise<void> {
  const keys = await ctx.redis.keys('ssrs:v1:rl:*');
  if (keys.length > 0) await ctx.redis.del(...keys);
}

export interface SeedUserOptions {
  username: string;
  password: string;
  role?: UserRole;
  status?: UserStatus;
  mustChangePassword?: boolean;
  passwordExpiresAt?: Date | null;
  passwordHash?: string;
}

export async function seedUser(ctx: TestContext, options: SeedUserOptions) {
  const role = options.role ?? 'ADMIN';
  const user = await ctx.prisma.user.create({
    data: {
      username: options.username,
      role,
      status: options.status ?? 'ACTIVE',
      passwordHash: options.passwordHash ?? (await ctx.passwords.hash(options.password)),
      mustChangePassword: options.mustChangePassword ?? false,
      passwordExpiresAt: options.passwordExpiresAt ?? null,
    },
  });
  if (role === 'STUDENT') {
    const generation =
      (await ctx.prisma.generation.findFirst({ where: { code: 'GEN2026' } })) ??
      (await ctx.prisma.generation.create({
        data: { code: 'GEN2026', name: 'Generation 2026', startDate: new Date('2026-01-01') },
      }));
    await ctx.prisma.student.create({
      data: {
        studentCode: options.username.toUpperCase(),
        userId: user.id,
        generationId: generation.id,
        fullName: `Student ${options.username}`,
      },
    });
  }
  return user;
}

/** Parses Set-Cookie headers into name → { value, attributes }. */
export function parseSetCookies(
  res: request.Response,
): Map<string, { value: string; attrs: string }> {
  const raw = res.headers['set-cookie'] as unknown;
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const map = new Map<string, { value: string; attrs: string }>();
  for (const cookie of list) {
    const [pair, ...attrs] = cookie.split(';');
    const eq = pair!.indexOf('=');
    map.set(pair!.slice(0, eq).trim(), {
      value: decodeURIComponent(pair!.slice(eq + 1)),
      attrs: attrs.join(';').trim().toLowerCase(),
    });
  }
  return map;
}

export interface LoggedIn {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  cookies: Map<string, { value: string; attrs: string }>;
  body: { user: { id: string; role: string; mustChangePassword: boolean } };
}

/** Request helpers that send Origin + CSRF headers for an authenticated session. */
export function api(session: LoggedIn) {
  const withHeaders = (req: request.Test) =>
    req.set('Origin', WEB_ORIGIN).set('X-CSRF-Token', session.csrf);
  return {
    get: (url: string) => session.agent.get(url),
    post: (url: string, body?: object) => withHeaders(session.agent.post(url)).send(body ?? {}),
    patch: (url: string, body: object) => withHeaders(session.agent.patch(url)).send(body),
    put: (url: string, body: object) => withHeaders(session.agent.put(url)).send(body),
    delete: (url: string) => withHeaders(session.agent.delete(url)),
  };
}

export async function login(
  ctx: TestContext,
  identifier: string,
  password: string,
): Promise<LoggedIn> {
  const agent = request.agent(ctx.app.getHttpServer());
  const res = await agent
    .post('/api/v1/auth/login')
    .set('Origin', WEB_ORIGIN)
    .send({ identifier, password });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const cookies = parseSetCookies(res);
  return { agent, csrf: cookies.get('ssrs_csrf')!.value, cookies, body: res.body };
}
