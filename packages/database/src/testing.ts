import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { appRoleName, configureAppRole } from './app-role.js';
import { createPrismaClient } from './index.js';
import type { PrismaClient } from './generated/prisma/client.js';

/**
 * Test-only helpers. They refuse to run against any database whose name does not end in
 * `_test`, so a misconfigured environment can never wipe development or production data.
 *
 * Two connections, like production: TEST_DATABASE_URL is the database OWNER (migrations, resets,
 * the few checks that need it); TEST_APP_DATABASE_URL is the restricted application role
 * (`<database>_app`) that the code under test uses.
 */
export function assertTestDatabaseUrl(url: string | undefined): string {
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to use database "${dbName}" for tests: name must end with "_test"`);
  }
  return url;
}

/**
 * The application-role URL for tests: same host and database as TEST_DATABASE_URL, user
 * `<database>_app`. Refuses anything else.
 */
export function assertTestAppDatabaseUrl(
  url: string | undefined = process.env['TEST_APP_DATABASE_URL'],
  ownerUrl: string | undefined = process.env['TEST_DATABASE_URL'],
): string {
  if (!url)
    throw new Error('TEST_APP_DATABASE_URL is not set (the restricted role; see .env.example)');
  const owner = new URL(assertTestDatabaseUrl(ownerUrl));
  const app = new URL(assertTestDatabaseUrl(url));
  const dbName = decodeURIComponent(app.pathname.replace(/^\//, ''));
  if (app.host !== owner.host || app.pathname !== owner.pathname) {
    throw new Error(
      'TEST_APP_DATABASE_URL must name the same host and database as TEST_DATABASE_URL',
    );
  }
  if (decodeURIComponent(app.username) !== appRoleName(dbName)) {
    throw new Error(`TEST_APP_DATABASE_URL must connect as ${appRoleName(dbName)}`);
  }
  return url;
}

const packageRoot = resolve(import.meta.dirname, '..');

/**
 * Drops and recreates the public schema, applies all migrations as the owner, then gives the
 * application role its test password and grants.
 */
export async function prepareTestDatabase(
  url: string | undefined,
  appUrl: string | undefined = process.env['TEST_APP_DATABASE_URL'],
): Promise<void> {
  const testUrl = assertTestDatabaseUrl(url);
  const testAppUrl = assertTestAppDatabaseUrl(appUrl, testUrl);
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
    // Both names point at the test database, so a DATABASE_MIGRATION_URL from the root .env
    // (the development database) can never be picked up here.
    env: { ...process.env, DATABASE_URL: testUrl, DATABASE_MIGRATION_URL: testUrl },
    stdio: 'pipe',
  });

  const owner = createPrismaClient({ connectionString: testUrl, poolMax: 1 });
  try {
    await configureAppRole(owner, decodeURIComponent(new URL(testAppUrl).password));
  } finally {
    await owner.$disconnect();
  }
}

/** A client connected as the database owner, for resets and owner-only checks in tests. */
export function createOwnerTestClient(
  url: string | undefined = process.env['TEST_DATABASE_URL'],
): PrismaClient {
  return createPrismaClient({ connectionString: assertTestDatabaseUrl(url), poolMax: 2 });
}

/** A client connected as the restricted application role, as the api and worker are. */
export function createAppTestClient(url?: string): PrismaClient {
  return createPrismaClient({ connectionString: assertTestAppDatabaseUrl(url), poolMax: 5 });
}

let sharedOwner: PrismaClient | undefined;

/**
 * Empties every application table (fast reset between test files). TRUNCATE needs the owner
 * (the application role has no TRUNCATE privilege), so this uses an owner connection; the client
 * passed in only has to point at the test database.
 */
export async function truncateAllTables(_prisma?: PrismaClient): Promise<void> {
  sharedOwner ??= createOwnerTestClient();
  const rows = await sharedOwner.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename.replace(/"/g, '""')}"`).join(', ');
  // TRUNCATE does not fire row-level triggers, so append-only tables can be emptied here.
  await sharedOwner.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Closes the owner connection used by truncateAllTables (call from afterAll if needed). */
export async function closeOwnerTestClient(): Promise<void> {
  await sharedOwner?.$disconnect();
  sharedOwner = undefined;
}
