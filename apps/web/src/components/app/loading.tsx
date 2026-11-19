'use client';

import { AlertCircle, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Loading indicators appear only after this long, so fast loads never flicker, and once shown
 * they stay at least this long, so they never blink. The CSS class `loading-delayed` (globals.css)
 * uses the same delay.
 */
export const LOADING_DELAY_MS = 300;
export const LOADING_MIN_MS = 300;
/** After this long a task adds "Still working…". */
export const STILL_WORKING_MS = 10_000;
export const STILL_WORKING_TEXT =
  'Still working. This can take up to a minute for a large workbook.';

/**
 * True while `pending`, and also for the rest of the minimum display time when a loading state was
 * already visible. Use it to decide when to swap a skeleton for the real content:
 * `if (useLoading(!data)) return <Skeleton…/>`.
 */
export function useLoading(pending: boolean): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    if (pending && !shown) {
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, LOADING_DELAY_MS);
      return () => clearTimeout(timer);
    }
    if (!pending && shown) {
      const left = Math.max(0, LOADING_MIN_MS - (Date.now() - shownAt.current));
      const timer = setTimeout(() => setShown(false), left);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [pending, shown]);
  return pending || shown;
}

/** True once `active` has lasted `ms` without stopping. */
export function useElapsed(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      const timer = setTimeout(() => setElapsed(false), 0);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active && elapsed;
}

/**
 * A spinner that appears only after the loading delay, so a fast action never flickers. (The
 * delay sits on a wrapper: on the icon itself it would replace the spin animation.)
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <span className="loading-delayed inline-flex shrink-0" aria-hidden>
      <Loader2 className={cn('size-4 animate-spin motion-reduce:animate-none', className)} />
    </span>
  );
}

/**
 * A region that is loading: `aria-busy`, a "Loading" text for screen readers, and placeholders
 * that become visible only after the loading delay (the space is kept, so nothing jumps).
 */
export function LoadingRegion({
  label = 'Loading',
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      <div className="loading-delayed" aria-hidden data-testid="skeleton">
        {children}
      </div>
    </div>
  );
}

/** A table: header plus `rows` rows of `columns` cells. */
export function TableSkeleton({
  rows = 5,
  columns = 4,
  label,
}: {
  rows?: number;
  columns?: number;
  label?: string;
}) {
  return (
    <LoadingRegion label={label}>
      <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
        <div className="flex gap-4 border-b bg-muted/40 px-3 py-3">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className={cn('h-4', c === 0 ? 'w-1/4' : 'flex-1')} />
          ))}
        </div>
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex gap-4 border-b px-3 py-3 last:border-b-0">
            {Array.from({ length: columns }, (_, c) => (
              <Skeleton key={c} className={cn('h-5', c === 0 ? 'w-1/4' : 'flex-1')} />
            ))}
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

/** A row of summary boxes (a number with a label). */
export function SummarySkeleton({ boxes = 4, label }: { boxes?: number; label?: string }) {
  return (
    <LoadingRegion label={label}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: boxes }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl p-4 ring-1 ring-foreground/10">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-7 w-1/3" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

/** A grid of cards (a title and two lines). */
export function CardGridSkeleton({ cards = 6, label }: { cards?: number; label?: string }) {
  return (
    <LoadingRegion label={label}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl p-4 ring-1 ring-foreground/10">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

/** A whole page: header, optional summary boxes, and a table. */
export function PageSkeleton({
  summary = false,
  columns = 4,
  rows = 5,
}: {
  summary?: boolean;
  columns?: number;
  rows?: number;
}) {
  return (
    <LoadingRegion label="Loading page">
      <div className="space-y-8">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        {summary ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-3 rounded-xl p-4 ring-1 ring-foreground/10">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-7 w-1/3" />
              </div>
            ))}
          </div>
        ) : null}
        <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
          {Array.from({ length: rows + 1 }, (_, r) => (
            <div key={r} className="flex gap-4 border-b px-3 py-3 last:border-b-0">
              {Array.from({ length: columns }, (_, c) => (
                <Skeleton key={c} className={cn('h-5', c === 0 ? 'w-1/4' : 'flex-1')} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}

/**
 * Inline status of a task the admin started (preview, detect tabs, issue passwords): a spinner and
 * `label` while it runs (after the loading delay), a "Still working" line after 10 s, and the error
 * with a Retry button when it failed. Shows nothing otherwise.
 */
export function TaskStatus({
  running,
  label,
  error,
  errorTitle = 'This did not finish',
  onRetry,
}: {
  running: boolean;
  label: string;
  error?: ReactNode;
  errorTitle?: string;
  onRetry?: () => void;
}) {
  const slow = useElapsed(running, STILL_WORKING_MS);
  if (running) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="text-sm text-muted-foreground"
      >
        <span className="sr-only">{label}</span>
        <p className="loading-delayed flex items-center gap-2" aria-hidden>
          <Spinner />
          {label}
        </p>
        {slow ? <p className="mt-1">{STILL_WORKING_TEXT}</p> : null}
      </div>
    );
  }
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden />
      <AlertTitle>{errorTitle}</AlertTitle>
      <AlertDescription>
        <div>{error}</div>
        {onRetry ? (
          <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
