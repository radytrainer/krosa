import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/infra/prisma.service.js';

export interface QueryCounter {
  /** Queries run through PrismaService since the last reset. */
  readonly count: number;
  /** The model.operation of each query since the last reset, in order. */
  readonly operations: readonly string[];
  reset(): void;
  /** Runs `fn` and returns how many queries it ran. */
  measure<T>(fn: () => Promise<T>): Promise<{ queries: number; result: T; ops: string[] }>;
}

/**
 * Counts every Prisma operation the app runs through PrismaService, by swapping its client for an
 * extended one. Install before the requests to measure; the app keeps using the counted client.
 */
export function installQueryCounter(app: INestApplication): QueryCounter {
  const ps = app.get(PrismaService);
  const ops: string[] = [];
  const counted = ps.client.$extends({
    query: {
      $allOperations: ({ model, operation, args, query }) => {
        ops.push(`${model ?? '$raw'}.${operation}`);
        return query(args);
      },
    },
  });
  Object.defineProperty(ps, 'client', { value: counted, configurable: true });
  const counter: QueryCounter = {
    get count() {
      return ops.length;
    },
    get operations() {
      return ops;
    },
    reset() {
      ops.length = 0;
    },
    async measure(fn) {
      ops.length = 0;
      const result = await fn();
      return { queries: ops.length, result, ops: [...ops] };
    },
  };
  return counter;
}
