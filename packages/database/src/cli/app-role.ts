/**
 * Gives the restricted application role (`<database>_app`) LOGIN and its password, and re-applies
 * its grants. Run as the database OWNER after `prisma migrate deploy`:
 *
 *   DATABASE_MIGRATION_URL=<owner url> APP_DB_PASSWORD=<secret> node dist/cli/app-role.js
 *
 * - Beta server: scripts/server/deploy.sh runs it in the one-off migrate container.
 * - Local development: through scripts/db-guard.sh, e.g.
 *   `DB_GUARD_ALLOW_SSRS=yes scripts/db-guard.sh ssrs "$OWNER_URL" pnpm db:app-role` (after approval).
 * - Tests: prepareTestDatabase does the same for ssrs_test.
 *
 * The password is sent as a SCRAM verifier; nothing secret is printed.
 */
import { configureAppRole } from '../app-role.js';
import { createPrismaClient } from '../index.js';

// Only the migration (owner) URL: never DATABASE_URL, which is the application role's own URL.
const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
const password = process.env['APP_DB_PASSWORD'];

if (!ownerUrl) {
  process.stderr.write('app-role: set DATABASE_MIGRATION_URL (the database owner connection)\n');
  process.exit(2);
}
if (!password) {
  process.stderr.write('app-role: set APP_DB_PASSWORD\n');
  process.exit(2);
}

const owner = createPrismaClient({ connectionString: ownerUrl, poolMax: 1, log: ['error'] });
try {
  const { role, database } = await configureAppRole(owner, password);
  process.stdout.write(`app-role: ${role} can log in to ${database}; grants applied\n`);
} catch (err) {
  // Prisma errors can echo the statement; mask the verifier and keep the output to one line.
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
  const masked = message.replace(/SCRAM-SHA-256\$[^'\s]+/g, 'SCRAM-SHA-256$…');
  process.stderr.write(`app-role: failed: ${masked}\n`);
  process.exitCode = 1;
} finally {
  await owner.$disconnect();
}
