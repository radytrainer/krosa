/**
 * Tells the API that someone is using the app, so the session survives the inactivity limit.
 *
 * - Only while THIS tab is visible: a hidden tab, or a closed laptop lid, never keeps a session
 *   alive. It stops when the tab is hidden and checks at once when it is shown again.
 * - One browser sends at most one heartbeat per interval, however many tabs are open: the time of
 *   the last one is shared in localStorage, and the send happens under the Web Lock
 *   `ssrs-heartbeat` after checking that time again.
 * - Laptop sleep: when the timer fires after a wall-clock jump longer than the interval, it sends at
 *   once. Past the limit the server answers SESSION_IDLE, and `onEnded` signs the browser out.
 * - Only a final answer signs out (replaced, idle, revoked, or a refresh that failed for good);
 *   network errors, 5xx and 429 just wait for the next check.
 */
import { sessionUpkeep } from './api';
import type { SessionEndReason } from './types';

const LAST_HEARTBEAT_KEY = 'ssrs:lastHeartbeatAt';
const LOCK_NAME = 'ssrs-heartbeat';
/** How often a visible tab checks whether a heartbeat is due (never more than this). */
const MAX_CHECK_MS = 30_000;

function readLast(): number {
  try {
    const value = Number(window.localStorage.getItem(LAST_HEARTBEAT_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeLast(at: number): void {
  try {
    window.localStorage.setItem(LAST_HEARTBEAT_KEY, String(at));
  } catch {
    // Storage blocked: this tab still sends on its own timer.
  }
}

/** True when no tab of this browser has sent a heartbeat for at least one interval. */
export function heartbeatDue(now: number, last: number, intervalMs: number): boolean {
  // A time in the future (clock moved back) cannot be trusted: send.
  return last > now || now - last >= intervalMs;
}

/** True when the timer fired much later than planned: the computer slept in between. */
export function clockJumped(now: number, previousTick: number, checkMs: number, intervalMs: number) {
  return now - previousTick > checkMs + intervalMs;
}

function withLock(work: () => Promise<void>): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.locks) return work();
  // Another tab holding the lock is sending right now: nothing to add.
  return navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (lock) await work();
  });
}

export interface HeartbeatOptions {
  intervalSeconds: number;
  /** The session is over (marker: the session the heartbeat used). */
  onEnded(reason: SessionEndReason, marker: string | undefined): void;
}

/** Starts the heartbeat for this tab. Returns a function that stops it. */
export function startHeartbeat({ intervalSeconds, onEnded }: HeartbeatOptions): () => void {
  const intervalMs = Math.max(10, intervalSeconds) * 1000;
  const checkMs = Math.min(MAX_CHECK_MS, Math.max(1000, Math.floor(intervalMs / 4)));
  let timer: ReturnType<typeof setInterval> | null = null;
  let previousTick = Date.now();
  let sending = false;
  let stopped = false;

  async function send(force: boolean): Promise<void> {
    if (sending || stopped) return;
    sending = true;
    try {
      await withLock(async () => {
        // Checked again under the lock: another tab may have just sent one.
        if (!force && !heartbeatDue(Date.now(), readLast(), intervalMs)) return;
        try {
          const result = await sessionUpkeep('/auth/heartbeat', { method: 'POST' });
          if (result.kind === 'response') {
            await result.res.body?.cancel().catch(() => undefined);
            if (result.res.ok) writeLast(Date.now());
          } else if (result.kind === 'ended' && !stopped) {
            onEnded(result.reason, result.marker);
          }
          // 'handled': the session-ended handler already ran. 'retry': try on the next check.
        } catch {
          // Offline: try again on the next check.
        }
      });
    } finally {
      sending = false;
    }
  }

  function tick(): void {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    const jumped = clockJumped(now, previousTick, checkMs, intervalMs);
    previousTick = now;
    if (jumped || heartbeatDue(now, readLast(), intervalMs)) void send(jumped);
  }

  function startTimer(): void {
    if (timer) return;
    previousTick = Date.now();
    timer = setInterval(tick, checkMs);
  }

  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function onVisibility(): void {
    if (document.visibilityState === 'visible') {
      startTimer();
      tick();
    } else {
      stopTimer();
    }
  }

  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();

  return () => {
    stopped = true;
    stopTimer();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
