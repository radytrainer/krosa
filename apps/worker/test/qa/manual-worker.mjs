// The compiled worker with Google replaced by FileSheetsReader. Started by e2e/qa/manual.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { loadWorkerEnv } from '../../dist/config/env.js';
import { SHEETS_READER } from '../../dist/sync/sync.processor.js';
import { WorkerModule } from '../../dist/worker.module.js';
import { FileSheetsReader } from './file-reader.mjs';

const env = loadWorkerEnv(process.env);
const app = await Test.createTestingModule({ imports: [WorkerModule.forRoot(env)] })
  .overrideProvider(SHEETS_READER)
  .useValue(new FileSheetsReader(process.env.QA_SHEETS_DIR))
  .compile();
await app.init();
