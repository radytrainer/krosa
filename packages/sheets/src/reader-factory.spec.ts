import { GoogleSheetsReader } from './google-reader.js';
import {
  createSheetsReader,
  createSheetsReaderFromEnv,
  NotConfiguredSheetsReader,
} from './reader-factory.js';

describe('createSheetsReaderFromEnv', () => {
  it('returns a not-configured reader without credentials', async () => {
    const reader = createSheetsReaderFromEnv({});
    expect(reader).toBeInstanceOf(NotConfiguredSheetsReader);
    await expect(reader.getMetadata('x')).rejects.toMatchObject({ code: 'GOOGLE_NOT_CONFIGURED' });
  });

  it('builds a Google reader from inline credentials and exposes the email', () => {
    const reader = createSheetsReaderFromEnv({
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@p.iam.gserviceaccount.com',
      GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
    });
    expect(reader).toBeInstanceOf(GoogleSheetsReader);
    expect(reader.serviceAccountEmail).toBe('sa@p.iam.gserviceaccount.com');
  });

  it('rejects incomplete or conflicting settings', () => {
    expect(() => createSheetsReaderFromEnv({ GOOGLE_PRIVATE_KEY: 'k' })).toThrow(/together/);
    expect(() =>
      createSheetsReaderFromEnv({
        GOOGLE_APPLICATION_CREDENTIALS: '/k.json',
        GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@p.iam.gserviceaccount.com',
        GOOGLE_PRIVATE_KEY: 'k',
      }),
    ).toThrow(/either/);
  });
});

describe('createSheetsReader', () => {
  it('serves the fixture workbook in test mode', async () => {
    const { TERM_FIXTURE_SPREADSHEET_ID } = await import('./testing/index.js');
    const reader = await createSheetsReader({ SHEETS_TEST_MODE: 'fixtures' });
    const meta = await reader.getMetadata(TERM_FIXTURE_SPREADSHEET_ID);
    expect(meta.title).toContain('GEN 2027');
  });

  it('refuses test mode in production', async () => {
    await expect(
      createSheetsReader({ NODE_ENV: 'production', SHEETS_TEST_MODE: 'fixtures' }),
    ).rejects.toThrow(/production/);
  });

  it('uses the configured Google reader otherwise', async () => {
    expect(await createSheetsReader({})).toBeInstanceOf(NotConfiguredSheetsReader);
  });
});
