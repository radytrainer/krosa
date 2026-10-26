import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Geist, Geist_Mono } from 'next/font/google';
import { Providers } from '@/components/providers';
import './globals.css';

const geistSans = Geist({
  variable: '--font-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: {
    default: 'Student Score Record System',
    template: '%s · Student Score Record System',
  },
  description: 'Academic results for students and administrators.',
};

/**
 * Pages are rendered per request, never served from a prerendered shell: the CSP nonce set in
 * src/proxy.ts only exists at request time, and Next.js must stamp it on its inline scripts.
 * Every page is a small client shell behind a sign-in, so this costs little.
 */
export const instant = false;

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  await connection();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
