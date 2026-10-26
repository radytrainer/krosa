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
  return new ApiError(res.status, `HTTP_${res.status}`, res.statusText || 'Request failed');
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
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

/** Single in-flight refresh shared by concurrent requests (reuse would revoke the session). */
let refreshing: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  refreshing ??= send('/auth/refresh', { method: 'POST' })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Sends the request, refreshing the session once on an expired access token. */
async function request(path: string, init: RequestInit): Promise<Response> {
  const res = await send(path, init);
  if (res.status !== 401 || path.startsWith('/auth/')) return res;
  const body = await parseBody(res.clone());
  if (isErrorBody(body) && REFRESHABLE_CODES.has(body.error.code) && (await refreshSession())) {
    return send(path, init);
  }
  return res;
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

/** The API error code of a failed request, or null. */
export function errorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}
