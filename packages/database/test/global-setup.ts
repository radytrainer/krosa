import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { prepareTestDatabase } from '../src/testing.js';

export default async function setup(): Promise<void> {
  const rootEnv = resolve(import.meta.dirname, '../../../.env');
  if (existsSync(rootEnv)) config({ path: rootEnv, override: false, quiet: true });
  await prepareTestDatabase(process.env['TEST_DATABASE_URL']);
}
