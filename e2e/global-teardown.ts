import { existsSync, readFileSync, rmSync } from 'node:fs';
import { PIDS_FILE } from './global-setup.js';
import { stop } from './support/stack.js';

export default function globalTeardown(): void {
  if (!existsSync(PIDS_FILE)) return;
  const pids = JSON.parse(readFileSync(PIDS_FILE, 'utf8')) as (number | undefined)[];
  process.env['E2E_STOPPING'] = '1';
  for (const pid of pids) stop(pid);
  rmSync(PIDS_FILE, { force: true });
}
