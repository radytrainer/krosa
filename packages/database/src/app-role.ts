import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { PrismaClient } from './generated/prisma/client.js';

/**
 * The restricted application role (migration 20261118120000_app_role): `<database>_app`, used by
 * the api and worker. The migration creates it without a password; `configureAppRole` (run as
 * the database owner) gives it LOGIN and a password and re-applies its grants.
 */
export function appRoleName(database: string): string {
  return `${database}_app`;
}

/** Printable ASCII, no spaces, at least 16 characters (generated values are 64 hex digits). */
const PASSWORD = /^[\x21-\x7e]{16,256}$/;

/**
 * PostgreSQL's SCRAM-SHA-256 verifier for a password (RFC 5802/7677, as `password_encryption =
 * scram-sha-256` stores it). Sending the verifier instead of the password means the password
 * itself never reaches the server, so it cannot appear in a server log line.
 */
export function scramVerifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = 4096,
): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

const VERIFIER = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

export interface AppRoleResult {
  role: string;
  database: string;
}

/**
 * Sets LOGIN and the password of this database's application role and re-applies its grants.
 * `owner` must be connected as the database owner. Idempotent; prints nothing.
 */
export async function configureAppRole(
  owner: PrismaClient,
  password: string,
): Promise<AppRoleResult> {
  if (!PASSWORD.test(password)) {
    throw new Error('the application role password must be 16-256 printable characters, no spaces');
  }
  const rows = await owner.$queryRaw<{ database: string }[]>`SELECT current_database() AS database`;
  const database = rows[0]?.database;
  if (!database) throw new Error('could not read the current database name');
  const role = appRoleName(database);
  if (!ROLE.test(role)) throw new Error(`unexpected role name "${role}"`);
  const verifier = scramVerifier(password);
  if (!VERIFIER.test(verifier)) throw new Error('could not build a SCRAM verifier');
  // ALTER ROLE takes no bind parameters; both values are checked against strict patterns above.
  await owner.$executeRawUnsafe(`ALTER ROLE "${role}" WITH LOGIN PASSWORD '${verifier}'`);
  // A role may set its own session defaults (ALTER ROLE ... SET); wipe any it gave itself.
  await owner.$executeRawUnsafe(`ALTER ROLE "${role}" RESET ALL`);
  // The function returns void, which $queryRaw cannot read; $executeRaw ignores the result.
  await owner.$executeRawUnsafe('SELECT ssrs_grant_app_role()');
  return { role, database };
}
