import { prepareTestDatabase } from '@ssrs/database/testing';
import { loadRootEnv } from '@ssrs/shared/node';

export default async function setup(): Promise<void> {
  loadRootEnv();
  await prepareTestDatabase(process.env['TEST_DATABASE_URL']);
}
