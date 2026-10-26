'use client';

import { Tabs } from '@base-ui/react/tabs';
import { BookOpen, CalendarDays } from 'lucide-react';
import { EmptyState } from '@/components/app/states';
import { formatDate, plural } from '@/lib/format';
import type { TermResultView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CourseResult } from './course-result';
import { TermSummaryBar } from './term-summary';

/** Second line of a term tab: what the student will find there. */
function termCaption(t: TermResultView): string {
  if (t.courses.length === 0) return 'No results yet';
  const average = t.summary.average ?? t.summary.provisionalAverage;
  return average
    ? `${plural(t.courses.length, 'course')} · avg ${average}`
    : plural(t.courses.length, 'course');
}

/**
 * Five-term navigation with each term's summary and course results. Built on Base UI tabs, so
 * arrow keys move between terms and the roles/ARIA states are set. The tab bar scrolls sideways on
 * narrow screens (scrollbar hidden; every tab stays reachable by swipe and keyboard).
 */
export function ResultsTabs({
  terms,
  value,
  onValueChange,
  courseHref,
  showAdmin,
}: {
  terms: TermResultView[];
  value: number;
  onValueChange(term: number): void;
  courseHref?: (offeringId: string) => string;
  showAdmin?: boolean;
}) {
  return (
    <Tabs.Root value={value} onValueChange={(v) => onValueChange(Number(v))}>
      <div className="-mx-4 overflow-x-auto overflow-y-hidden border-b px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
        <Tabs.List aria-label="Terms" className="flex min-w-max gap-1 sm:min-w-0">
          {terms.map((t) => {
            const empty = t.courses.length === 0;
            return (
              <Tabs.Tab
                key={t.number}
                value={t.number}
                className={cn(
                  'group relative flex min-w-[8.5rem] flex-1 cursor-pointer flex-col items-start gap-0.5 rounded-t-lg px-4 pt-2.5 pb-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:ring-inset',
                  'after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors data-[active]:after:bg-primary',
                )}
              >
                <span
                  className={cn(
                    'text-sm font-semibold text-muted-foreground group-hover:text-foreground group-data-[active]:text-primary',
                    empty && 'font-medium',
                  )}
                >
                  {t.name}
                </span>
                <span
                  className={cn(
                    'text-xs whitespace-nowrap text-muted-foreground tabular-nums',
                    empty && 'text-muted-foreground/80',
                  )}
                >
                  {termCaption(t)}
                </span>
              </Tabs.Tab>
            );
          })}
        </Tabs.List>
      </div>
      {terms.map((t) => (
        <Tabs.Panel
          key={t.number}
          value={t.number}
          className="mt-5 space-y-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        >
          {t.startDate || t.endDate ? (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <CalendarDays className="size-4" aria-hidden />
              {formatDate(t.startDate)} – {formatDate(t.endDate)}
            </p>
          ) : null}
          {t.courses.length === 0 ? (
            <EmptyState
              icon={<BookOpen className="size-8" />}
              title="No results for this term yet"
              description="Courses appear here once their results are released."
            />
          ) : (
            <>
              <TermSummaryBar summary={t.summary} />
              <div className="space-y-3">
                {t.courses.map((c) => (
                  <CourseResult
                    key={c.offeringId}
                    course={c}
                    href={courseHref?.(c.offeringId)}
                    showAdmin={showAdmin}
                  />
                ))}
              </div>
            </>
          )}
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}

/** First term that has courses, else term 1. */
export function defaultTerm(terms: TermResultView[]): number {
  return terms.find((t) => t.courses.length > 0)?.number ?? terms[0]?.number ?? 1;
}
