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
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ApiErrorBody['error']['details'],
    public readonly requestId?: string,
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
    return new ApiError(res.status, code, message, details, requestId);
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

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await send(path, init);
  let body = await parseBody(res);

  if (
    res.status === 401 &&
    !path.startsWith('/auth/') &&
    isErrorBody(body) &&
    REFRESHABLE_CODES.has(body.error.code) &&
    (await refreshSession())
  ) {
    res = await send(path, init);
    body = await parseBody(res);
  }

  if (!res.ok) throw toApiError(res, body);
  return body as T;
}
