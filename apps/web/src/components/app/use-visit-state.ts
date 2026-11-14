'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * State that belongs to one visit of a page, such as whether a confirm dialog is open.
 *
 * With `cacheComponents`, Next.js keeps a page mounted (in a hidden React Activity) when the admin
 * navigates to another route, and shows the same instance again on return. Plain `useState` would
 * bring back a dialog left open (for example after confirming, which navigates to the job page).
 * Leaving the route runs effect cleanups, and this puts the value back to its initial one there,
 * so the next visit starts fresh. Switching to another browser tab is not leaving the route: it
 * runs no cleanup, and the value stays. A reload or a new tab starts fresh anyway.
 */
export function useVisitState<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const initialRef = useRef(initial);
  useEffect(() => {
    const reset = initialRef.current;
    return () => setValue(reset);
  }, []);
  return [value, setValue] as const;
}
