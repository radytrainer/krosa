export interface RetryOptions {
  /** Total attempts including the first (default 5). */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Decides whether an error is worth retrying; may suggest a delay (e.g. Retry-After). */
  classify: (error: unknown) => { retryable: boolean; retryAfterMs?: number };
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with full jitter (delay = random × min(max, base × 2^n)), honouring a
 * server-provided Retry-After when it is longer. Non-retryable errors are rethrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = options.attempts ?? 5;
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 16_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const { retryable, retryAfterMs } = options.classify(err);
      if (!retryable || attempt === attempts - 1) throw err;
      const backoff = Math.floor(random() * Math.min(max, base * 2 ** attempt));
      await sleep(Math.min(max, Math.max(backoff, retryAfterMs ?? 0)));
    }
  }
  throw lastError;
}
