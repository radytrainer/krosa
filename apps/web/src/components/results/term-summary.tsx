import { EyeOff } from 'lucide-react';
import { Fragment } from 'react';
import { StatusPill } from '@/components/app/status';
import type { TermSummaryView } from '@/lib/types';

/**
 * One term's summary (decisions.md T1–T3): Courses complete and Top scoring. No average and no
 * credits. Top scoring's grade is the only grade here, and it sits beside that final score.
 * Admin views mark a subject hidden from the student; student views never contain one.
 */
export function TermSummaryBar({ summary }: { summary: TermSummaryView }) {
  if (summary.status === 'EMPTY') {
    return <p className="text-sm text-muted-foreground">No courses in this term yet.</p>;
  }
  const top = summary.topScoring;
  return (
    <dl className="grid divide-y rounded-xl bg-card text-sm ring-1 ring-foreground/10 sm:grid-cols-[auto_1fr] sm:divide-x sm:divide-y-0 [&>div]:px-4 [&>div]:py-3.5">
      <div>
        <dt className="text-xs text-muted-foreground">Courses complete</dt>
        <dd className="text-xl font-semibold tabular-nums">
          {summary.completedCourses}
          <span className="text-sm font-normal text-muted-foreground">
            {' '}
            / {summary.totalCourses}
          </span>
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">Top scoring</dt>
        {top ? (
          <dd data-slot="top-scoring" className="break-words">
            {/* Ties: every subject on that score, in one line. */}
            {top.subjects.map((s, i) => (
              <Fragment key={s.offeringId}>
                {i > 0 ? ', ' : null}
                <span className="font-medium">{s.title}</span>
                {s.hiddenFromStudent ? (
                  <StatusPill tone="neutral" icon={<EyeOff aria-hidden />} className="ml-1.5">
                    Hidden from student
                  </StatusPill>
                ) : null}
              </Fragment>
            ))}
            : <span className="text-xl font-semibold tabular-nums">{top.finalScore}</span>
            {top.finalGrade ? (
              <span data-slot="top-scoring-grade" className="text-xl font-semibold">
                {' '}
                ({top.finalGrade})
              </span>
            ) : null}
          </dd>
        ) : (
          <dd data-slot="top-scoring-empty" className="text-muted-foreground">
            No final score yet
          </dd>
        )}
      </div>
    </dl>
  );
}
