import { NextResponse, type NextRequest } from 'next/server';

/** Paths that need a session; visitors without one go to /login first. */
const PROTECTED = /^\/(admin|student)(\/|$)|^\/change-password$/;

/**
 * Content-Security-Policy with a fresh nonce per request (docs/security.md §6). Next.js reads
 * the nonce from this header while rendering and puts it on its own scripts; `'strict-dynamic'`
 * extends trust to the chunks they load. No other script can run. Styles allow inline because
 * the toast and chart libraries inject <style> elements at runtime (a nonce in style-src would
 * make browsers ignore 'unsafe-inline'). Development needs eval and the HMR websocket.
 */
export function buildCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Where /api/* goes when nothing sits in front of Next.js (development, tests). Read per request,
 * so one build works against any API address. In production Caddy routes /api to the API
 * directly and these requests never reach Next.js.
 */
function apiTarget(request: NextRequest): URL {
  const base = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  return new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, base);
}

/**
 * Runs before every request it matches:
 *  0. Forwards /api/* to the API (see apiTarget).
 *  1. Sends visitors without a session to /login. The session cookies are scoped to /api, so
 *     only the CSRF cookie (Path=/) is visible here: its absence means "never signed in or
 *     signed out". A convenience, not a security boundary; the API checks every request.
 *  2. Sets the CSP with a per-request nonce (pages are rendered per request for this reason;
 *     see the root layout).
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return NextResponse.rewrite(apiTarget(request));
  }
  if (PROTECTED.test(pathname) && !request.cookies.has('ssrs_csrf')) {
    const url = new URL('/login', request.url);
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages and /api; not static assets or prefetches (they need no CSP).
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
