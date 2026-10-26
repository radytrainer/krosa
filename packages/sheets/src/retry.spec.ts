import { withRetry } from './retry.js';

class Transient extends Error {}
class Fatal extends Error {}

const classify = (e: unknown) => ({ retryable: e instanceof Transient });

describe('withRetry', () => {
  it('retries transient failures with growing, capped, jittered delays', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 4) throw new Transient('503');
        return 'ok';
      },
      {
        classify,
        sleep: async (ms) => void delays.push(ms),
        random: () => 1,
        baseDelayMs: 100,
        maxDelayMs: 300,
      },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(4);
    expect(delays).toEqual([100, 200, 300]);
  });

  it('does not retry fatal errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Fatal('403');
        },
        { classify, sleep: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(Fatal);
    expect(calls).toBe(1);
  });

  it('gives up after the configured attempts and rethrows the last error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Transient(`attempt ${calls}`);
        },
        { classify, attempts: 3, sleep: async () => undefined },
      ),
    ).rejects.toThrow('attempt 3');
    expect(calls).toBe(3);
  });

  it('honours a longer Retry-After hint', async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        if (calls++ === 0) throw new Transient('429');
        return 1;
      },
      {
        classify: () => ({ retryable: true, retryAfterMs: 5_000 }),
        sleep: async (ms) => void delays.push(ms),
        random: () => 0,
        maxDelayMs: 30_000,
      },
    );
    expect(delays).toEqual([5_000]);
  });
});
