import type { NextConfig } from 'next';

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
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
