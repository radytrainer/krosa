// The compiled API with Google replaced by FileSheetsReader. Started by e2e/qa/manual.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../dist/app.module.js';
import { configureApp } from '../../dist/bootstrap.js';
import { loadApiEnv } from '../../dist/config/env.js';
import { SHEETS_READER } from '../../dist/sheets-sources/sheets-reader.provider.js';
import { FileSheetsReader } from '../../../worker/test/qa/file-reader.mjs';

const env = loadApiEnv(process.env);
const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
  .overrideProvider(SHEETS_READER)
  .useValue(new FileSheetsReader(process.env.QA_SHEETS_DIR))
  .compile();
const app = moduleRef.createNestApplication({ bufferLogs: true });
configureApp(app, env);
await app.listen(env.API_PORT);
