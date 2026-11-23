import { randomUUID } from 'node:crypto';
import type { NextConfig } from 'next';

/**
 * One id per build: Next.js's own build id and the service worker's cache version (src/lib/pwa.ts,
 * public/sw.js). A new build registers /sw.js?v=<new id>, so the next visit installs the new worker,
 * which deletes the previous build's cache. SSRS_BUILD_ID (e.g. the commit sha) may pin it.
 */
const buildId = process.env['SSRS_BUILD_ID']?.trim() || randomUUID();

// The Content-Security-Policy is set per request with a nonce in src/proxy.ts.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  generateBuildId: async () => buildId,
  // Inlined at build time; read by src/lib/pwa.ts.
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
  cacheComponents: true,
  experimental: {
    // Every page renders per request (the CSP nonce in src/proxy.ts needs it; see the root layout),
    // so dev-time instant-navigation checks can't render any page and only report it as skipped.
    // Validate only segments that opt in with `export const instant`. Pinned: the default may change.
    instantInsights: { validationLevel: 'manual-warning' },
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // The service worker script is always revalidated, so a new build (or the kill switch,
      // docs/runbook.md "Service worker") reaches every browser on its next visit.
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache, max-age=0' }] },
    ];
  },
};

export default nextConfig;
