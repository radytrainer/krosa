import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Local development reads the monorepo root .env; real environment variables take precedence.
const rootEnv = resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) config({ path: rootEnv, override: false, quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
