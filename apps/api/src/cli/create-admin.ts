/**
 * Bootstrap an administrator account (there are no default credentials).
 *
 *   pnpm --filter @ssrs/api admin:create -- --username admin --display-name "Registrar"
 *
 * The password is prompted without echo, or read from the first line of stdin when piped
 * (e.g. from a secret manager). It must satisfy the password policy.
 */
import { parseArgs } from 'node:util';
import { createPrismaClient } from '@ssrs/database';
import { envFields, parseEnv } from '@ssrs/shared';
import { loadRootEnv } from '@ssrs/shared/node';
import { z } from 'zod';
import { scrubMetadata } from '../audit/audit.service.js';
import { checkPasswordPolicy, PASSWORD_POLICY_MESSAGES } from '../auth/password-policy.js';
import { PasswordService } from '../auth/password.service.js';
import { readSecret } from './read-secret.js';

const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{2,63}$/;

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  // `pnpm <script> -- --flag` forwards the separator literally; ignore a leading one.
  const argv = process.argv.slice(2);
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      username: { type: 'string' },
      'display-name': { type: 'string' },
    },
    strict: true,
  });
  const username = values.username?.trim();
  if (!username || !USERNAME_PATTERN.test(username)) {
    fail(
      '--username is required: 3-64 characters, starting with a letter (letters, digits, . _ -)',
    );
  }

  loadRootEnv();
  const env = parseEnv(z.object({ DATABASE_URL: envFields.postgresUrl }), process.env);

  const password = await readSecret('Password: ');
  const problems = checkPasswordPolicy(password, username).map((v) => PASSWORD_POLICY_MESSAGES[v]);
  if (problems.length > 0) fail(problems.join(' '));
  if (process.stdin.isTTY) {
    const confirm = await readSecret('Confirm password: ');
    if (confirm !== password) fail('Passwords do not match.');
  }

  const passwords = new PasswordService();
  const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, poolMax: 1 });
  try {
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) fail(`A user named "${username}" already exists.`);

    const passwordHash = await passwords.hash(password);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          username,
          role: 'ADMIN',
          status: 'ACTIVE',
          passwordHash,
          passwordChangedAt: new Date(),
          displayName: values['display-name']?.trim() || null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action: 'admin.created',
          entityType: 'user',
          entityId: created.id,
          metadata: scrubMetadata({ username, via: 'cli' }) as object,
        },
      });
      return created;
    });
    process.stdout.write(`Created administrator "${user.username}" (${user.id}).\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
