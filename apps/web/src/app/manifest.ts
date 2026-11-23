import type { MetadataRoute } from 'next';

/**
 * Web app manifest (served at /manifest.webmanifest): makes the app installable on phones and
 * desktops. Static content only; the service worker is in public/sw.js.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Student Score Record System',
    short_name: 'PNC Scores',
    description: 'Academic results for students and administrators.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // The page background (globals.css --background, light), so the title bar matches the page.
    background_color: '#f8fafc',
    theme_color: '#f8fafc',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
