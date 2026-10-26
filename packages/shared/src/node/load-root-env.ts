import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';

/**
 * Loads the monorepo root `.env` for local development. Walks up from `startDir` to the
 * directory containing `pnpm-workspace.yaml`. Existing environment variables always win,
 * and nothing happens in containers (no workspace file / no .env present).
 */
export function loadRootEnv(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const envPath = join(dir, '.env');
      if (!existsSync(envPath)) return null;
      config({ path: envPath, override: false, quiet: true });
      return envPath;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
