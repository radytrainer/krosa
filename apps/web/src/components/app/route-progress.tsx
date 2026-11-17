'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useLoading } from '@/components/app/loading';

/** A navigation that never lands (cancelled, or blocked by the page) stops the bar after this. */
const GIVE_UP_MS = 15_000;

/** True when a click on this element starts a client navigation to another page of this app. */
function startsNavigation(event: MouseEvent): boolean {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement)) return false;
  if ((link.target && link.target !== '_self') || link.hasAttribute('download')) return false;
  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin) return false;
  // Same page (or only a #hash): nothing loads.
  return url.pathname !== window.location.pathname || url.search !== window.location.search;
}

/**
 * Thin bar at the top of the window from a link click until the new page renders, so the admin
 * knows the click worked. Never blocks anything (pointer-events: none). It appears only after the
 * loading delay, and holds still when the viewer prefers reduced motion.
 */
export function RouteProgress() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const url = `${pathname}?${search}`;
  const [navigating, setNavigating] = useState(false);
  const [landedOn, setLandedOn] = useState(url);
  // The URL changed: the new page is rendering now.
  if (landedOn !== url) {
    setLandedOn(url);
    setNavigating(false);
  }

  useEffect(() => {
    // Capture phase: runs before next/link handles (and cancels) the click.
    const onClick = (event: MouseEvent) => {
      if (startsNavigation(event)) setNavigating(true);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    if (!navigating) return undefined;
    const timer = setTimeout(() => setNavigating(false), GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [navigating]);

  const visible = useLoading(navigating);
  if (!visible) return null;
  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      data-testid="route-progress"
      className="loading-delayed pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden"
    >
      <div className="route-progress-bar h-full bg-primary" />
    </div>
  );
}
