/**
 * Same-origin API client. Requests go to /api/v1 on the current origin so the HttpOnly
 * session cookies are sent automatically. State-changing requests echo the session-bound
 * CSRF token, and an expired access token is refreshed once, transparently.
 */
export const API_BASE = '/api/v1';

const CSRF_COOKIE = 'ssrs_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** 401 codes that a refresh can fix. Others (e.g. revoked sessions) mean signing in again. */
const REFRESHABLE_CODES = new Set(['ACCESS_TOKEN_EXPIRED', 'UNAUTHENTICATED']);

/** Why the server ended the session, for the 401 codes the browser tells the user about. */
export type EndedReason = 'SIGNED_IN_ELSEWHERE' | 'IDLE_TIMEOUT';

const ENDED_CODES: Record<string, EndedReason> = {
  SESSION_REPLACED: 'SIGNED_IN_ELSEWHERE',
  SESSION_IDLE: 'IDLE_TIMEOUT',
};

/** The ended reason behind a 401 code, or null when the code is not one of them. */
export function endedReasonOf(code: string | null | undefined): EndedReason | null {
  return (code && ENDED_CODES[code]) || null;
}

/**
 * Codes after which the session cannot come back: revoked, or a refresh that failed for good.
 * Anything else (network, 5xx, 429, unreachable) is passing and worth another try.
 */
const FINAL_CODES = new Set([
  'SESSION_REVOKED',
  'INVALID_REFRESH_TOKEN',
  'SESSION_EXPIRED',
  'REFRESH_TOKEN_REUSED',
  'ACCOUNT_NOT_ACTIVE',
]);

/** The handler gets the reason and the session marker of the request that learned it. */
type SessionEndedHandler = (reason: EndedReason, marker: string | undefined) => void;

let sessionEndedHandler: SessionEndedHandler | null = null;

/**
 * Registers the one handler that runs when any request (or a refresh) learns that the server
 * ended this session: signed in elsewhere, or idle too long. Returns a function that unregisters it.
 */
export function onSessionEnded(handler: SessionEndedHandler): () => void {
  sessionEndedHandler = handler;
  return () => {
    if (sessionEndedHandler === handler) sessionEndedHandler = null;
  };
}

/**
 * The browser's current session marker: the session-bound CSRF cookie (one value per session),
 * or undefined when signed out. Lets a tab tell its own session from a newer one in the same
 * browser, whose tabs share the cookies.
 */
export function sessionMarker(): string | undefined {
  return readCookie(CSRF_COOKIE);
}

/**
 * True when `marker` (the session a request or connection used) is still this browser's session,
 * or the cookies were cleared. False when a newer session has replaced it in this browser: then
 * the ended session was ours, but the browser is signed in again and must not be signed out.
 */
export function isCurrentSession(marker: string | undefined): boolean {
  const now = sessionMarker();
  return now === undefined || now === marker;
}

function reportEnded(code: string | null | undefined, marker: string | undefined): void {
  const reason = endedReasonOf(code);
  if (reason && isCurrentSession(marker)) sessionEndedHandler?.(reason, marker);
}

export const UNREACHABLE = 'The service is unreachable. Please try again.';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { field?: string; message: string }[];
    requestId?: string;
    [extra: string]: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ApiErrorBody['error']['details'],
    public readonly requestId?: string,
    /** The whole `error` object, including endpoint-specific fields such as `jobId`. */
    public readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error?.code === 'string'
  );
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const part of document.cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toApiError(res: Response, body: unknown): ApiError {
  if (isErrorBody(body)) {
    const { code, message, details, requestId } = body.error;
    return new ApiError(res.status, code, message, details, requestId, body.error);
  }
  // Not our API's answer: a proxy could not reach it. Its status text means nothing to a user.
  if (res.status >= 500) return new ApiError(res.status, `HTTP_${res.status}`, UNREACHABLE);
  return new ApiError(res.status, `HTTP_${res.status}`, res.statusText || 'Request failed');
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const method = (init.method ?? 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers.set('X-CSRF-Token', csrf);
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'same-origin' });
}

export type RefreshResult = { ok: true } | { ok: false; code: string };

/** The refresh got no answer from the API (network or proxy failure). */
export const REFRESH_UNREACHABLE = 'UNREACHABLE';

/** Single in-flight refresh shared by concurrent requests (reuse would revoke the session). */
let refreshing: Promise<RefreshResult> | null = null;

/** Tabs take turns: the next one then sends the new token from the shared cookie jar. */
function acrossTabs<T>(work: () => Promise<T>): Promise<T> {
  return typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request('ssrs-session-refresh', work)
    : work();
}

/**
 * Refreshes the access token. A failure carries the API's code; when that code says the session
 * was ended (signed in elsewhere, idle), the session-ended handler runs too.
 */
export function refreshSession(): Promise<RefreshResult> {
  // No CSRF cookie means no session: a signed-out visitor has nothing to refresh.
  if (!readCookie(CSRF_COOKIE)) {
    return Promise.resolve({ ok: false, code: 'UNAUTHENTICATED' });
  }
  let marker: string | undefined;
  refreshing ??= acrossTabs(() => {
    marker = sessionMarker();
    return send('/auth/refresh', { method: 'POST' });
  })
    .then(async (res): Promise<RefreshResult> => {
      if (res.ok) {
        await res.body?.cancel(); // an unread body would keep the request open
        return { ok: true };
      }
      const body = await parseBody(res);
      const code = isErrorBody(body) ? body.error.code : `HTTP_${res.status}`;
      reportEnded(code, marker);
      return { ok: false, code };
    })
    .catch((): RefreshResult => ({ ok: false, code: REFRESH_UNREACHABLE }))
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** These calls settle the session themselves, so a 401 from them is final. */
const NO_REFRESH_PATHS = new Set(['/auth/login', '/auth/refresh', '/auth/logout']);

/**
 * Sends the request, refreshing the session once on an expired access token. A 401 saying the
 * session was ended elsewhere or for inactivity runs the session-ended handler.
 */
async function request(path: string, init: RequestInit): Promise<Response> {
  const marker = sessionMarker();
  const res = await send(path, init);
  if (res.status !== 401 || NO_REFRESH_PATHS.has(path)) return res;
  const body = await parseBody(res.clone());
  if (!isErrorBody(body)) return res;
  if (REFRESHABLE_CODES.has(body.error.code)) {
    if ((await refreshSession()).ok) {
      const retryMarker = sessionMarker();
      const retried = await send(path, init);
      if (retried.status === 401) {
        const again = await parseBody(retried.clone());
        if (isErrorBody(again)) reportEnded(again.error.code, retryMarker);
      }
      return retried;
    }
    return res;
  }
  reportEnded(body.error.code, marker);
  return res;
}

export type UpkeepResult =
  /** The server answered (anything but a 401): the caller reads or checks it. */
  | { kind: 'response'; res: Response }
  /** The session is over for good; the caller signs the browser out. */
  | {
      kind: 'ended';
      reason: 'SIGNED_IN_ELSEWHERE' | 'IDLE_TIMEOUT' | 'REVOKED';
      marker: string | undefined;
    }
  /** A refresh learned that the session ended: the session-ended handler already ran. */
  | { kind: 'handled' }
  /** A passing failure, or signed out for now (no cookie): try again later. */
  | { kind: 'retry'; code: string };

/**
 * One session upkeep call (heartbeat, live connection). Sends the CSRF token on every method
 * (the live connection requires it on GET), refreshes once on an expired access token, and tells a
 * final end of the session from a passing failure. Network failures throw.
 */
export async function sessionUpkeep(path: string, init: RequestInit = {}): Promise<UpkeepResult> {
  for (let attempt = 0; ; attempt++) {
    const marker = sessionMarker();
    if (!marker) return { kind: 'retry', code: 'UNAUTHENTICATED' };
    const headers = new Headers(init.headers);
    headers.set('X-CSRF-Token', marker);
    const res = await send(path, { ...init, headers });
    if (res.status !== 401) return { kind: 'response', res };

    const body = await parseBody(res);
    const code = isErrorBody(body) ? body.error.code : 'HTTP_401';
    // A newer sign-in in this browser replaced the session this call used: not ours to end.
    const ours = isCurrentSession(marker);
    const reason = endedReasonOf(code);
    if (reason) return ours ? { kind: 'ended', reason, marker } : { kind: 'retry', code };
    if (FINAL_CODES.has(code)) {
      return ours ? { kind: 'ended', reason: 'REVOKED', marker } : { kind: 'retry', code };
    }
    if (!REFRESHABLE_CODES.has(code) || attempt > 0) return { kind: 'retry', code };

    const refreshed = await refreshSession();
    if (refreshed.ok) continue;
    const stillOurs = isCurrentSession(marker);
    if (endedReasonOf(refreshed.code) && stillOurs) return { kind: 'handled' };
    if (FINAL_CODES.has(refreshed.code) && stillOurs) {
      return { kind: 'ended', reason: 'REVOKED', marker };
    }
    return { kind: 'retry', code: refreshed.code };
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await request(path, init);
  const body = await parseBody(res);
  if (!res.ok) throw toApiError(res, body);
  return body as T;
}

/** For file responses (CSV): returns the body as a Blob with the response headers. */
export async function apiDownload(
  path: string,
  init: RequestInit = {},
): Promise<{ blob: Blob; filename: string; headers: Headers }> {
  const res = await request(path, init);
  if (!res.ok) throw toApiError(res, await parseBody(res));
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download';
  return { blob: await res.blob(), filename, headers: res.headers };
}

/** Saves a Blob through a temporary object URL (revoked right after). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Client limit for a long request the admin waits on (preview, detect tabs). */
export const TASK_TIMEOUT_MS = 120_000;
export const TIMED_OUT = 'TIMED_OUT';

/**
 * Runs a request with a client-side time limit: past `ms` the request is abandoned and fails with
 * a `TIMED_OUT` ApiError, so a spinner never runs forever. Only for requests that are safe to send
 * again (they import nothing): the server may still finish the abandoned one.
 */
export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number = TASK_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      const minutes = Math.round(ms / 60_000);
      throw new ApiError(
        0,
        TIMED_OUT,
        `No answer after ${minutes} minutes, so this was stopped.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** The API error code of a failed request, or null. */
export function errorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}
