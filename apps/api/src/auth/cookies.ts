import type { CookieOptions, Response } from 'express';
import type { ApiEnv } from '../config/env.js';

export const ACCESS_COOKIE = 'ssrs_at';
export const REFRESH_COOKIE = 'ssrs_rt';
export const CSRF_COOKIE = 'ssrs_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Refresh cookie is only ever sent to the auth endpoints. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
const ACCESS_COOKIE_PATH = '/api';

export interface SessionCookies {
  accessToken: string;
  refreshToken?: string;
  csrfToken?: string;
  /** Absolute session expiry; bounds refresh/CSRF cookie lifetime. */
  sessionExpiresAt?: Date;
}

export function setSessionCookies(res: Response, env: ApiEnv, cookies: SessionCookies): void {
  const base: CookieOptions = { secure: env.COOKIE_SECURE };
  res.cookie(ACCESS_COOKIE, cookies.accessToken, {
    ...base,
    httpOnly: true,
    sameSite: 'lax',
    path: ACCESS_COOKIE_PATH,
    maxAge: env.ACCESS_TOKEN_TTL_SECONDS * 1000,
  });

  const sessionMaxAge = cookies.sessionExpiresAt
    ? Math.max(cookies.sessionExpiresAt.getTime() - Date.now(), 0)
    : undefined;
  if (cookies.refreshToken) {
    res.cookie(REFRESH_COOKIE, cookies.refreshToken, {
      ...base,
      httpOnly: true,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: sessionMaxAge,
    });
  }
  if (cookies.csrfToken) {
    // Readable by the web app's JavaScript, which echoes it in the X-CSRF-Token header.
    res.cookie(CSRF_COOKIE, cookies.csrfToken, {
      ...base,
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      maxAge: sessionMaxAge,
    });
  }
}

export function clearSessionCookies(res: Response, env: ApiEnv): void {
  const base: CookieOptions = { secure: env.COOKIE_SECURE };
  res.clearCookie(ACCESS_COOKIE, {
    ...base,
    httpOnly: true,
    sameSite: 'lax',
    path: ACCESS_COOKIE_PATH,
  });
  res.clearCookie(REFRESH_COOKIE, {
    ...base,
    httpOnly: true,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
  res.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false, sameSite: 'lax', path: '/' });
}

export function readCookie(cookies: unknown, name: string): string | undefined {
  if (typeof cookies !== 'object' || cookies === null) return undefined;
  const value = (cookies as Record<string, unknown>)[name];
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : undefined;
}
