// Container health check of the worker (Dockerfile `worker` target).
//
// Healthy when THIS container's worker heartbeat exists in Redis. The worker refreshes
// `ssrs:v1:worker:heartbeat:<hostname>-<pid>-<random>` every WORKER_HEARTBEAT_INTERVAL_MS with a
// TTL of three intervals (apps/worker/src/heartbeat), so a missing key means the process stopped
// working or lost Redis. Matching on the container's hostname ignores a previous container's key
// that has not expired yet. The scan walks the whole key space (a single SCAN call only looks at
// a small batch). Reads only; prints nothing (REDIS_URL contains the password).
import { hostname } from 'node:os';
import { Redis } from 'ioredis';

const PATTERN = `ssrs:v1:worker:heartbeat:${hostname()}-*`;
const DEADLINE = Date.now() + 8000;

const redis = new Redis(process.env.REDIS_URL ?? '', {
  lazyConnect: true,
  connectTimeout: 3000,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
redis.on('error', () => undefined);

let ok = false;
try {
  await redis.connect();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', PATTERN, 'COUNT', 1000);
    if (keys.length > 0) {
      ok = true;
      break;
    }
    cursor = next;
  } while (cursor !== '0' && Date.now() < DEADLINE);
} catch {
  ok = false;
} finally {
  redis.disconnect();
}
process.exit(ok ? 0 : 1);
