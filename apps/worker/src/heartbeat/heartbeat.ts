/** Redis key namespace for worker liveness. Read by the admin dashboard (Phase 7). */
export const HEARTBEAT_KEY_PREFIX = 'ssrs:v1:worker:heartbeat:';

export interface HeartbeatPayload {
  workerId: string;
  pid: number;
  startedAt: string;
  at: string;
}

export function heartbeatKey(workerId: string): string {
  return `${HEARTBEAT_KEY_PREFIX}${workerId}`;
}

/** A heartbeat expires after three missed intervals. */
export function heartbeatTtlSeconds(intervalMs: number): number {
  return Math.ceil((intervalMs * 3) / 1000);
}
