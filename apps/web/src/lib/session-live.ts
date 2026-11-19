/**
 * The live session connection: the server tells the browser at once when the session ends
 * (signed in elsewhere, idle, revoked), so every open tab leaves without waiting for a request.
 *
 * - One connection per browser: the tab holding the Web Lock `ssrs-live` (held while it lives)
 *   reads `GET /api/v1/auth/live` as a server-sent event stream with fetch + ReadableStream (not
 *   EventSource, so 401 codes are visible and an expired access token is refreshed). When the
 *   leader tab closes, another tab takes the lock and connects. The leader never gives up the
 *   connection while it lives: after any outcome it reconnects (at once, or with backoff).
 * - `ended` is relayed to every tab through the BroadcastChannel `ssrs-session` (by the
 *   session-ended handler in auth.tsx, with a hash of the session marker, never the token).
 * - The stream stays open whether the tab is visible or hidden. A close without `ended` (the
 *   access token's expiry) reconnects at once; errors back off.
 * - Tabs of one browser share a session and never end each other: an `ended` for a session that a
 *   newer sign-in in this browser has replaced is ignored (see `isCurrentSession` in api.ts).
 */
import { isCurrentSession, sessionMarker, sessionUpkeep } from './api';
import type { SessionEndReason } from './types';

const CHANNEL_NAME = 'ssrs-session';
const LOCK_NAME = 'ssrs-live';
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** Over the connection limit: wait longer before trying again. */
const TOO_MANY_BACKOFF_MS = 30_000;
/** Signed out in this browser for now: look for a new sign-in this often (no request is sent). */
const SIGNED_OUT_CHECK_MS = 5_000;
const END_REASONS = new Set<SessionEndReason>(['SIGNED_IN_ELSEWHERE', 'IDLE_TIMEOUT', 'REVOKED']);

interface EndedMessage {
  type: 'ended';
  reason: SessionEndReason;
  /** A short hash of the ended session's marker, or undefined when the cookies were cleared. */
  markerHash: string | undefined;
}

function isEndedMessage(value: unknown): value is EndedMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as EndedMessage).type === 'ended' &&
    END_REASONS.has((value as EndedMessage).reason)
  );
}

function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}

/** FNV-1a, for pages without SubtleCrypto (plain http on another host than localhost). */
function fnv1a(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(i), 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * A short hash of a session marker (the first 16 hex characters of its SHA-256), so the CSRF
 * token itself never goes on the BroadcastChannel.
 */
export async function markerHash(marker: string | undefined): Promise<string | undefined> {
  if (marker === undefined) return undefined;
  try {
    if (globalThis.crypto?.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(marker));
      return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
    }
  } catch {
    // fall back below
  }
  return fnv1a(marker);
}

/** Like `isCurrentSession`, for a marker known only by its hash (a message from another tab). */
export async function isCurrentSessionHash(hash: string | undefined): Promise<boolean> {
  const now = sessionMarker();
  if (now === undefined) return true;
  return hash !== undefined && (await markerHash(now)) === hash;
}

/** Tells the other tabs of this browser that the session ended. */
export async function broadcastEnded(
  reason: SessionEndReason,
  marker: string | undefined,
): Promise<void> {
  const channel = openChannel();
  if (!channel) return;
  try {
    channel.postMessage({
      type: 'ended',
      reason,
      markerHash: await markerHash(marker),
    } satisfies EndedMessage);
  } finally {
    channel.close();
  }
}

/** One server-sent event: its name and data (the default name is `message`). */
interface SseEvent {
  event: string;
  data: string;
}

/** Parses one event block (the lines between blank lines). Comments (`: ping`) give null. */
export function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  let any = false;
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      event = value;
      any = true;
    } else if (field === 'data') {
      data.push(value);
      any = true;
    }
  }
  return any ? { event, data: data.join('\n') } : null;
}

/** The reason of an `ended` event's data, defaulting to REVOKED for anything unexpected. */
export function endedReasonFromData(data: string): SessionEndReason {
  try {
    const reason = (JSON.parse(data) as { reason?: unknown }).reason;
    if (typeof reason === 'string' && END_REASONS.has(reason as SessionEndReason)) {
      return reason as SessionEndReason;
    }
  } catch {
    // fall through
  }
  return 'REVOKED';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

type StreamOutcome =
  /** The server ended this browser's current session. */
  | { kind: 'ended'; reason: SessionEndReason; marker: string | undefined }
  /** Closed without `ended` (token expiry, server restart): reconnect. `ready` says it had opened. */
  | { kind: 'closed'; ready: boolean }
  /** This tab is stopping. */
  | { kind: 'stop' }
  /** Try again after `waitMs`, or after the usual backoff when 0. */
  | { kind: 'retry'; waitMs: number };

async function readStream(res: Response, marker: string | undefined): Promise<StreamOutcome> {
  if (!res.body) return { kind: 'closed', ready: false };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let ready = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { kind: 'closed', ready };
      buffer += value;
      const blocks = buffer.split(/\r\n\r\n|\n\n|\r\r/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (event?.event === 'ready') ready = true;
        if (event?.event === 'ended') {
          // That session was replaced by a newer sign-in in this browser: reconnect with it.
          if (!isCurrentSession(marker)) return { kind: 'closed', ready: true };
          return { kind: 'ended', reason: endedReasonFromData(event.data), marker };
        }
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

async function connectOnce(signal: AbortSignal): Promise<StreamOutcome> {
  // The session this connection watches (a refresh keeps it: one marker per session).
  const marker = sessionMarker();
  if (!marker) return { kind: 'retry', waitMs: SIGNED_OUT_CHECK_MS };
  try {
    const result = await sessionUpkeep('/auth/live', {
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store',
      signal,
    });
    if (result.kind === 'ended') return result;
    // The session-ended handler already ran; keep leading in case it decided to stay.
    if (result.kind === 'handled') return { kind: 'retry', waitMs: 0 };
    if (result.kind === 'retry') return { kind: 'retry', waitMs: 0 };
    const { res } = result;
    if (res.ok) return await readStream(res, marker);
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'retry', waitMs: res.status === 429 ? TOO_MANY_BACKOFF_MS : 0 };
  } catch {
    return signal.aborted ? { kind: 'stop' } : { kind: 'retry', waitMs: 0 };
  }
}

export interface SessionLiveOptions {
  /** The server ended the session this connection watched (marker: that session's marker). */
  onEnded(reason: SessionEndReason, marker: string | undefined): void;
  /** Another tab of this browser reports the session ended (with its marker's hash). */
  onEndedElsewhere(reason: SessionEndReason, markerHash: string | undefined): void;
}

/** Joins the browser's live connection (leading it when no other tab does). Returns a stop function. */
export function startSessionLive({ onEnded, onEndedElsewhere }: SessionLiveOptions): () => void {
  const controller = new AbortController();
  const { signal } = controller;

  const channel = openChannel();
  const onMessage = (message: MessageEvent<unknown>) => {
    if (isEndedMessage(message.data)) {
      onEndedElsewhere(message.data.reason, message.data.markerHash);
    }
  };
  channel?.addEventListener('message', onMessage);

  async function lead(): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    while (!signal.aborted) {
      const outcome = await connectOnce(signal);
      if (signal.aborted || outcome.kind === 'stop') return;
      if (outcome.kind === 'closed' && outcome.ready) {
        backoff = MIN_BACKOFF_MS; // a normal close (token expiry, replaced session): at once
        continue;
      }
      // The handler leaves the page; if it stays (a sign-in in this browser), keep leading.
      if (outcome.kind === 'ended') onEnded(outcome.reason, outcome.marker);
      const base = outcome.kind === 'retry' && outcome.waitMs > 0 ? outcome.waitMs : backoff;
      await sleep(base + Math.floor(Math.random() * 500), signal);
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
    }
  }

  if (typeof navigator !== 'undefined' && navigator.locks) {
    // `lead` returns only when this tab stops, so the lock is held while the tab lives.
    navigator.locks.request(LOCK_NAME, { signal }, lead).catch(() => undefined);
  } else {
    // No Web Locks: every tab keeps its own connection.
    void lead();
  }

  return () => {
    controller.abort();
    channel?.removeEventListener('message', onMessage);
    channel?.close();
  };
}
