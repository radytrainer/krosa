// A real worker process (the compiled app) for the kill tests, with Google replaced by a local
// workbook. Started by faults.integration-spec.ts. Uses only the test database it is given.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { InMemorySheetsReader } from '@ssrs/sheets/testing';
import { loadWorkerEnv } from '../../dist/config/env.js';
import { SHEETS_READER } from '../../dist/sync/sync.processor.js';
import { WorkerModule } from '../../dist/worker.module.js';
import { bigWorkbook } from './big-workbook.mjs';

const env = loadWorkerEnv(process.env);
const reader = new InMemorySheetsReader().set(
  process.env.QA_SHEET_ID,
  bigWorkbook(Number(process.env.QA_VERSION)),
);
const app = await Test.createTestingModule({ imports: [WorkerModule.forRoot(env)] })
  .overrideProvider(SHEETS_READER)
  .useValue(reader)
  .compile();
await app.init();
process.stdout.write('worker-ready\n');
