import { trimDecimal } from '@/lib/format';
import type { TermSummary } from '@/lib/types';

/** Average (or provisional average) plus completion counts for one term or overall. */
export function TermSummaryBar({
  summary,
  label = 'Term average',
}: {
  summary: TermSummary;
  label?: string;
}) {
  if (summary.status === 'EMPTY') {
    return <p className="text-sm text-muted-foreground">No courses in this term yet.</p>;
  }
  const average = summary.average ?? summary.provisionalAverage;
  return (
    <dl className="grid grid-cols-3 divide-x rounded-xl bg-card text-sm ring-1 ring-foreground/10 [&>div]:px-4 [&>div]:py-3.5">
      <div>
        <dt className="text-xs text-muted-foreground">
          {summary.average ? label : `Provisional ${label.toLowerCase()}`}
        </dt>
        <dd className="text-xl font-semibold tabular-nums">{average ?? '—'}</dd>
      </div>
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
      <div>
        <dt className="text-xs text-muted-foreground">Credits complete</dt>
        <dd className="text-xl font-semibold tabular-nums">
          {trimDecimal(summary.creditsCompleted)}
          <span className="text-sm font-normal text-muted-foreground">
            {' '}
            / {trimDecimal(summary.creditsTotal)}
          </span>
        </dd>
      </div>
    </dl>
  );
}
