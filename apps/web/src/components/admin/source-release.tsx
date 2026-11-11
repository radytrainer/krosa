'use client';

import { CircleDashed, Eye, EyeOff, Info } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { jobTarget } from '@/components/admin/sync-jobs-table';
import { StatusPill, SyncStatusPill } from '@/components/app/status';
import { ErrorState, LoadingRows } from '@/components/app/states';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { json, qs, useApi, useApiMutation } from '@/lib/query';
import type { ReleaseState, SourceReleaseView, SyncJob } from '@/lib/types';

/** Paths whose data a release changes. */
export const RELEASE_INVALIDATES = [
  '/admin/sources',
  '/admin/sync',
  '/admin/generations',
  '/admin/dashboard',
];

const STATE: Record<ReleaseState, { tone: 'success' | 'neutral' | 'warning'; label: string }> = {
  RELEASED: { tone: 'success', label: 'Released' },
  HIDDEN: { tone: 'neutral', label: 'Hidden' },
  PARTLY_RELEASED: { tone: 'warning', label: 'Partly released' },
  EMPTY: { tone: 'neutral', label: 'Nothing synced' },
};

/** Released / Hidden / Partly released: icon and text, never color alone. */
export function ReleaseStatePill({ state }: { state: ReleaseState }) {
  const s = STATE[state];
  const icon =
    state === 'RELEASED' ? (
      <Eye aria-hidden />
    ) : state === 'HIDDEN' ? (
      <EyeOff aria-hidden />
    ) : (
      <CircleDashed aria-hidden />
    );
  return (
    <StatusPill tone={s.tone} icon={icon}>
      {s.label}
    </StatusPill>
  );
}

const termOf = (r: SourceReleaseView) => `${r.generation.name}, ${r.term.name}`;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Release state of the given sources (their terms), in the given order. */
export function useReleaseStatus(sourceIds: readonly string[]) {
  return useApi<SourceReleaseView[]>(
    sourceIds.length ? `/admin/sources/release${qs({ ids: sourceIds.join(',') })}` : null,
  );
}

/**
 * Confirms Hide or Release for one or more sources, with what changes and who it reaches. A
 * source is one term's workbook: the action covers every subject of the term, like the term
 * button.
 */
export function ReleaseDialog({
  rows,
  visible,
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  rows: SourceReleaseView[];
  visible: boolean;
  open: boolean;
  busy: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  const one = rows.length === 1 ? rows[0] : undefined;
  const students = rows.reduce((n, r) => n + r.students, 0);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {visible ? 'Release scores to students?' : 'Hide scores from students?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {visible
              ? 'Students see their scores for every subject of these terms at once.'
              : 'Students stop seeing these scores at once. Nothing is deleted; you can release them again.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-2 text-sm">
          {rows.map((r) => {
            const changing = visible ? r.subjects - r.visibleSubjects : r.visibleSubjects;
            return (
              <li key={r.sourceId} className="rounded-lg bg-muted/50 p-3">
                <p className="font-medium">{termOf(r)}</p>
                <p className="text-muted-foreground">
                  <ReleaseStatePill state={r.state} /> → {visible ? 'Released' : 'Hidden'}:{' '}
                  {plural(changing, 'subject')} {visible ? 'shown' : 'hidden'} (of {r.subjects}),{' '}
                  {plural(r.students, 'student')} affected
                </p>
              </li>
            );
          })}
        </ul>
        <p className="text-sm font-medium" data-slot="students-affected">
          {one
            ? `${plural(one.students, 'student')} affected.`
            : `${plural(students, 'student enrollment')} affected across ${rows.length} terms (a student in two terms counts twice).`}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant={visible ? 'default' : 'destructive'} disabled={busy} onClick={onConfirm}>
            {visible ? 'Release scores' : 'Hide scores'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** POST /admin/sources/release, with its confirmation dialog state. */
function useReleaseAction() {
  const [pending, setPending] = useState<{ rows: SourceReleaseView[]; visible: boolean } | null>(
    null,
  );
  const mutation = useApiMutation(
    (body: { sourceIds: string[]; visible: boolean }) =>
      apiFetch<unknown[]>('/admin/sources/release', json(body)),
    {
      success: (results) =>
        `${pending?.visible ? 'Released' : 'Hid'} the scores of ${plural(results.length, 'workbook')}.`,
      invalidate: RELEASE_INVALIDATES,
      onSuccess: () => setPending(null),
    },
  );
  return { pending, setPending, mutation };
}

/**
 * The Sync Center's per-source list under a job: each workbook's job, its scores' state for
 * students and a Hide / Release action, plus the same actions for the selected workbooks.
 */
export function PerSourceJobs({ jobs }: { jobs: SyncJob[] }) {
  const sourceIds = [...new Set(jobs.flatMap((j) => (j.source ? [j.source.id] : [])))];
  const status = useReleaseStatus(sourceIds);
  const byId = new Map(status.data?.map((r) => [r.sourceId, r]));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { pending, setPending, mutation } = useReleaseAction();
  const selectable = (status.data ?? []).filter((r) => r.state !== 'EMPTY');
  const chosen = selectable.filter((r) => selected.has(r.sourceId));
  const allId = useId();

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="space-y-3">
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 p-2 text-sm"
        role="toolbar"
        aria-label="Selected workbooks"
      >
        <span className="px-1 text-muted-foreground" aria-live="polite">
          {chosen.length
            ? `${chosen.length} selected`
            : 'Select workbooks to change several at once'}
        </span>
        <Button
          size="sm"
          disabled={!chosen.length || mutation.isPending}
          onClick={() => setPending({ rows: chosen, visible: true })}
        >
          <Eye aria-hidden />
          Release selected
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!chosen.length || mutation.isPending}
          onClick={() => setPending({ rows: chosen, visible: false })}
        >
          <EyeOff aria-hidden />
          Hide selected
        </Button>
      </div>
      {status.error ? <ErrorState error={status.error} onRetry={() => status.refetch()} /> : null}
      <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  id={allId}
                  aria-label="Select all workbooks"
                  checked={selectable.length > 0 && chosen.length === selectable.length}
                  indeterminate={chosen.length > 0 && chosen.length < selectable.length}
                  disabled={!selectable.length}
                  onCheckedChange={(on) =>
                    setSelected(on ? new Set(selectable.map((r) => r.sourceId)) : new Set())
                  }
                />
              </TableHead>
              <TableHead>Workbook</TableHead>
              <TableHead>Sync</TableHead>
              <TableHead className="hidden md:table-cell">Issues</TableHead>
              <TableHead>Scores for students</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => {
              const row = job.source ? byId.get(job.source.id) : undefined;
              const target = jobTarget(job);
              return (
                <TableRow key={job.id}>
                  <TableCell>
                    {row && row.state !== 'EMPTY' ? (
                      <Checkbox
                        aria-label={`Select ${target}`}
                        checked={selected.has(row.sourceId)}
                        onCheckedChange={(on) => toggle(row.sourceId, on === true)}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell className="min-w-40">
                    {target}
                    {job.releaseAfterSync ? (
                      <span className="block text-xs text-muted-foreground">
                        Release after sync was chosen
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <SyncStatusPill status={job.status} />
                  </TableCell>
                  <TableCell className="hidden tabular-nums md:table-cell">
                    <span className={job.errorCount ? 'text-destructive' : undefined}>
                      {job.errorCount} errors
                    </span>
                    <span className="text-muted-foreground"> · {job.warningCount} warnings</span>
                  </TableCell>
                  <TableCell>
                    {!job.source ? null : !row ? (
                      status.isPending ? (
                        <span className="text-xs text-muted-foreground">Loading…</span>
                      ) : null
                    ) : (
                      <span className="flex flex-col items-start gap-1">
                        <ReleaseStatePill state={row.state} />
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {row.visibleSubjects} of {row.subjects} subjects ·{' '}
                          {plural(row.students, 'student')}
                        </span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {row && row.state !== 'EMPTY' ? (
                      row.state === 'HIDDEN' || row.state === 'PARTLY_RELEASED' ? (
                        <Button
                          size="sm"
                          disabled={mutation.isPending}
                          onClick={() => setPending({ rows: [row], visible: true })}
                        >
                          Release scores<span className="sr-only"> of {target}</span>
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={mutation.isPending}
                          onClick={() => setPending({ rows: [row], visible: false })}
                        >
                          Hide scores<span className="sr-only"> of {target}</span>
                        </Button>
                      )
                    ) : null}
                    <Link
                      href={`/admin/sync/${job.id}`}
                      className="ml-3 text-sm font-medium underline-offset-4 hover:underline"
                    >
                      View
                      <span className="sr-only"> sync job from {formatDateTime(job.queuedAt)}</span>
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {pending ? (
        <ReleaseDialog
          rows={pending.rows}
          visible={pending.visible}
          open
          busy={mutation.isPending}
          onOpenChange={(open) => {
            if (!open && !mutation.isPending) setPending(null);
          }}
          onConfirm={() =>
            mutation.mutate({
              sourceIds: pending.rows.map((r) => r.sourceId),
              visible: pending.visible,
            })
          }
        />
      ) : null}
    </div>
  );
}

/**
 * "Release scores after sync" for a sync confirmation (decisions.md R4). Off by default. Terms
 * already released get a note instead: their updated scores reach students when the sync ends.
 */
export function ReleaseAfterSyncOption({
  rows,
  loading,
  checked,
  onCheckedChange,
}: {
  rows: SourceReleaseView[] | undefined;
  loading?: boolean;
  checked: boolean;
  onCheckedChange(value: boolean): void;
}) {
  const id = useId();
  if (loading || !rows) return <LoadingRows rows={1} />;
  const released = rows.filter((r) => r.state === 'RELEASED');
  const others = rows.filter((r) => r.state !== 'RELEASED');
  return (
    <div className="space-y-3">
      {others.length ? (
        <div className="flex items-start gap-2">
          <Checkbox
            id={id}
            checked={checked}
            onCheckedChange={(value) => onCheckedChange(value === true)}
          />
          <div className="grid gap-1">
            <Label htmlFor={id} className="font-normal">
              Release scores after sync
            </Label>
            <p className="text-xs text-muted-foreground">
              {others.map((r) => `${termOf(r)} (${STATE[r.state].label.toLowerCase()})`).join('; ')}
              : every subject becomes visible to its students once the sync succeeds. Left unticked,
              scores stay hidden until you release them.
            </p>
          </div>
        </div>
      ) : null}
      {released.length ? (
        <p
          className="flex items-start gap-2 text-sm text-muted-foreground"
          data-slot="released-note"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {released.map(termOf).join('; ')} {released.length === 1 ? 'is' : 'are'} already
            released: updated scores become visible to students after this sync.
          </span>
        </p>
      ) : null}
    </div>
  );
}
