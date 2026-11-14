import type { MonitoringSubjectSummaryView } from '@ssrs/shared';
import { Info } from 'lucide-react';
import { LastSyncLine } from './term-badges';

function Note({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="w-8 shrink-0 text-right font-medium tabular-nums">{count}</span>
      <span className="text-muted-foreground">{children}</span>
    </li>
  );
}

/** What the counts above leave out or flag (M5, M8), with the sync they come from. */
export function DataNotes({ summary }: { summary: MonitoringSubjectSummaryView }) {
  const { notes } = summary;
  return (
    <section aria-labelledby="data-notes-title" className="space-y-2 rounded-xl border p-4 text-sm">
      <h2 id="data-notes-title" className="flex items-center gap-1.5 font-semibold">
        <Info className="size-4" aria-hidden />
        Data notes
      </h2>
      <p className="text-xs text-muted-foreground">
        Follow the program and class filters, except the term-level count.
      </p>
      <ul className="space-y-1.5">
        <Note count={notes.termUndeterminedProgram}>
          Term-level: students in this term whose program could not be determined (skipped in sync).
          Not specific to this subject.
        </Note>
        <Note count={notes.pendingProgramSwitch}>
          Students of this subject with a program switch waiting for an admin decision.
        </Note>
        <Note count={notes.withdrawn}>
          Withdrawn enrollments: listed and flagged, not included in any count above.
        </Note>
        <Note count={notes.withdrawnByProgramSwitch}>
          Of those, withdrawn by a program switch: marks hidden after a program switch, shown
          flagged, admin only.
        </Note>
        <Note count={notes.missingFromSheet}>
          Enrolled but no longer in the sheet: still counted, flagged “Not in sheet”.
        </Note>
      </ul>
      <LastSyncLine sync={summary.lastSync} />
    </section>
  );
}
