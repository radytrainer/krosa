import type { LastSyncInfo, MonitoringReleaseState } from '@ssrs/shared';
import { Archive, CalendarClock, Eye, EyeOff, FileSpreadsheet, Info } from 'lucide-react';
import { StatusPill } from '@/components/app/status';
import { EmptyState } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatDateTime } from '@/lib/format';

/** Release state of the term, always as text: admins see every term, released or not (M1). */
export function ReleaseBadge({ state }: { state: MonitoringReleaseState }) {
  switch (state) {
    case 'RELEASED':
      return (
        <StatusPill tone="success" icon={<Eye aria-hidden />}>
          Released to students
        </StatusPill>
      );
    case 'PARTLY_RELEASED':
      return (
        <StatusPill tone="warning" icon={<EyeOff aria-hidden />}>
          Partly released to students
        </StatusPill>
      );
    case 'HIDDEN':
      return (
        <StatusPill tone="warning" icon={<EyeOff aria-hidden />}>
          Not released to students
        </StatusPill>
      );
    default:
      return (
        <StatusPill tone="neutral" icon={<EyeOff aria-hidden />}>
          Nothing synced · not released
        </StatusPill>
      );
  }
}

export function ArchivedBadge() {
  return (
    <StatusPill tone="neutral" icon={<Archive aria-hidden />}>
      Archived
    </StatusPill>
  );
}

/** "Last sync 12 Nov 2026, 09:15 · G2026 Term 2 (workbook title)". */
export function LastSyncLine({ sync }: { sync: LastSyncInfo | null }) {
  if (!sync) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <FileSpreadsheet className="size-4 shrink-0" aria-hidden />
        No sheet connected for this term
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground">
      <CalendarClock className="size-4 shrink-0" aria-hidden />
      <span>
        Last sync{' '}
        <span className="text-foreground">
          {sync.lastSyncedAt ? formatDateTime(sync.lastSyncedAt) : 'never'}
        </span>
      </span>
      <span aria-hidden>·</span>
      <span className="break-words">
        Sheet <span className="text-foreground">{sync.label}</span>
        {sync.spreadsheetTitle && sync.spreadsheetTitle !== sync.label
          ? ` (${sync.spreadsheetTitle})`
          : ''}
      </span>
    </p>
  );
}

export function isNeverSynced(sync: LastSyncInfo | null): boolean {
  return !sync || !sync.lastSyncedAt;
}

export function NotSyncedState({ sync }: { sync: LastSyncInfo | null }) {
  return (
    <EmptyState
      icon={<FileSpreadsheet className="size-8" />}
      title="This term has not been synced yet"
      description={
        sync
          ? `The sheet "${sync.label}" is connected but has never been synced. Sync it from the Sync center to see results here.`
          : 'No sheet is connected for this term. Connect and sync one from the Sync center.'
      }
    />
  );
}

/** No confirmed, usable grade scale: totals only, no grade or level (M4). */
export function GradeScaleNotice() {
  return (
    <Alert>
      <Info aria-hidden />
      <AlertTitle>No usable grade scale for this generation</AlertTitle>
      <AlertDescription>
        Grades and levels cannot be worked out, so only totals are shown. Confirm the generation’s
        grade scale to see levels.
      </AlertDescription>
    </Alert>
  );
}
