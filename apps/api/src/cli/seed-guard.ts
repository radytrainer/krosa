/**
 * Where the demo seed may write: a local database only (localhost, 127.0.0.1, ::1 or the compose
 * service `postgres`), never with NODE_ENV=production, and never into `ssrs` (real student data)
 * unless the operator passes --allow-ssrs after explicit approval.
 */
export const LOCAL_DATABASE_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres'] as const;
export const PROTECTED_DATABASE = 'ssrs';

export interface SeedTarget {
  nodeEnv: string | undefined;
  databaseUrl: string;
  allowSsrs: boolean;
}

/** Returns why the seed must not run against this target, or null when it may. */
export function seedRefusal(target: SeedTarget): string | null {
  if (target.nodeEnv === 'production') {
    return 'Refusing to load demo data with NODE_ENV=production.';
  }
  let url: URL;
  try {
    url = new URL(target.databaseUrl);
  } catch {
    return 'Refusing to load demo data: DATABASE_URL is not a valid URL.';
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!(LOCAL_DATABASE_HOSTS as readonly string[]).includes(host)) {
    return `Refusing to load demo data into a database on "${host}": only a local database (${LOCAL_DATABASE_HOSTS.join(', ')}) is allowed.`;
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')).toLowerCase();
  if (!database) return 'Refusing to load demo data: DATABASE_URL names no database.';
  if (database === PROTECTED_DATABASE && !target.allowSsrs) {
    return `Refusing to load demo data into "${PROTECTED_DATABASE}": it holds real student data. Use a disposable database, or pass --allow-ssrs only with explicit approval.`;
  }
  return null;
}
