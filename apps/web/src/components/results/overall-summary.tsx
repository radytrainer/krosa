import type { StudentSummaryView } from '@/lib/types';

/** "Term 2 · Class D · SNAC", or "Term 2" when the student has no enrollment row for it. */
function termLabel(summary: StudentSummaryView, termNumber: number, termName: string): string {
  const t = summary.student.terms.find((x) => x.termNumber === termNumber);
  return t ? `${termName} · Class ${t.className} · ${t.program.code}` : termName;
}

/**
 * The dashboard's Overall card: courses complete (all terms) and the highest final score of the
 * latest term, with its grade (decisions.md S1–S3). No average, no credits, no other grade.
 */
export function OverallSummary({ summary }: { summary: StudentSummaryView }) {
  const { overall, latestTermHighest: highest } = summary;
  return (
    <dl className="grid divide-y rounded-xl bg-card text-sm ring-1 ring-foreground/10 sm:grid-cols-[auto_1fr] sm:divide-x sm:divide-y-0 [&>div]:px-4 [&>div]:py-3.5">
      <div>
        <dt className="text-xs text-muted-foreground">Courses complete</dt>
        <dd className="text-xl font-semibold tabular-nums">
          {overall.completedCourses}
          <span className="text-sm font-normal text-muted-foreground">
            {' '}
            / {overall.totalCourses}
          </span>
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">Highest final score of the latest term</dt>
        {!highest ? (
          <dd className="text-muted-foreground">No released results yet</dd>
        ) : highest.finalScore === null ? (
          <dd data-slot="highest-empty" className="text-muted-foreground">
            {termLabel(summary, highest.termNumber, highest.termName)}: no final scores yet
          </dd>
        ) : (
          <dd data-slot="highest" className="break-words">
            <span className="text-xl font-semibold tabular-nums">{highest.finalScore}</span>
            {highest.finalGrade ? (
              <span data-slot="highest-grade" className="text-xl font-semibold">
                {' '}
                ({highest.finalGrade})
              </span>
            ) : null}
            <span>, {highest.subjects.map((s) => s.title).join(', ')}</span>
            <span className="text-muted-foreground">
              , {termLabel(summary, highest.termNumber, highest.termName)}
            </span>
          </dd>
        )}
      </div>
    </dl>
  );
}
