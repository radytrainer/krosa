import type { Provider } from '@nestjs/common';
import { createSheetsReader } from '@ssrs/sheets';
import { API_ENV, type ApiEnv } from '../config/env.js';

export const SHEETS_READER = Symbol('SHEETS_READER');

export const sheetsReaderProvider: Provider = {
  provide: SHEETS_READER,
  inject: [API_ENV],
  useFactory: (env: ApiEnv) => createSheetsReader(env),
};
