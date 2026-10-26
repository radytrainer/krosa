import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createPrismaClient } from './index.js';
import type { PrismaClient } from './generated/prisma/client.js';

/**
 * Test-only helpers. They refuse to run against any database whose name does not end in
 * `_test`, so a misconfigured environment can never wipe development or production data.
 */
export function assertTestDatabaseUrl(url: string | undefined): string {
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to use database "${dbName}" for tests: name must end with "_test"`);
  }
  return url;
}

const packageRoot = resolve(import.meta.dirname, '..');

/** Drops and recreates the public schema, then applies all migrations. */
export async function prepareTestDatabase(url: string | undefined): Promise<void> {
  const testUrl = assertTestDatabaseUrl(url);
  const prisma = createPrismaClient({ connectionString: testUrl, poolMax: 1 });
  try {
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  } finally {
    await prisma.$disconnect();
  }

  const require = createRequire(import.meta.url);
  const prismaCli = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
}

/** Empties every application table (fast reset between test files). */
export async function truncateAllTables(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename.replace(/"/g, '""')}"`).join(', ');
  // TRUNCATE does not fire row-level triggers, so append-only tables can be emptied here.
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
