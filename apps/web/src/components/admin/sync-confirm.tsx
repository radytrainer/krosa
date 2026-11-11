'use client';

import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { ReleaseAfterSyncOption, useReleaseStatus } from '@/components/admin/source-release';
import { useStartSync, type SyncTarget } from '@/components/admin/use-start-sync';
import { ErrorState, LoadingRows } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api';
import { json, qs, useApi, useApiMutation } from '@/lib/query';
import type { RemovedSubject, SheetPreview, SourceReleaseView } from '@/lib/types';

function RemovedLine({ subject }: { subject: RemovedSubject }) {
  return (
    <li>
      <span className="font-medium">{subject.subject}</span>: {subject.students} students,{' '}
      {subject.scores} score rows
    </li>
  );
}

/** The warning before subjects are removed, with the tick that a removal requires. */
export function RemovalWarning({
  removed,
  acknowledged,
  onAcknowledge,
}: {
  removed: RemovedSubject[];
  acknowledged: boolean;
  onAcknowledge(value: boolean): void;
}) {
  const id = useId();
  return (
    <div className="space-y-3">
      <Alert variant="destructive">
        <TriangleAlert aria-hidden />
        <AlertTitle>These subjects are no longer in the sheet</AlertTitle>
        <AlertDescription>
          <p>
            This sync removes them from the system. Students stop seeing them and they stop counting
            in totals. Their scores stay on record for audit.
          </p>
          <ul className="mt-2 list-disc pl-4">
            {removed.map((r) => (
              <RemovedLine key={r.offeringId} subject={r} />
            ))}
          </ul>
        </AlertDescription>
      </Alert>
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={acknowledged}
          onCheckedChange={(checked) => onAcknowledge(checked === true)}
        />
        <Label htmlFor={id} className="font-normal">
          I understand these subjects will be removed from the system.
        </Label>
      </div>
    </div>
  );
}

function ProblemList({ preview }: { preview: SheetPreview }) {
  const { comparison, firstErrors } = preview.summary;
  const problems = [...comparison.blockers, ...firstErrors];
  return (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden />
      <AlertTitle>This sheet cannot be synced yet</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {problems.slice(0, 5).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** "Sync now" for an active sheet: reads the sheet first and shows what the sync would do. */
export function SyncActiveSheet({ sourceId, disabled }: { sourceId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [release, setRelease] = useState(false);
  const status = useReleaseStatus(open ? [sourceId] : []);
  const startSync = useStartSync();
  const run = useApiMutation(() =>
    apiFetch<SheetPreview>(`/admin/sources/${sourceId}/preview`, { method: 'POST' }),
  );
  const confirm = useApiMutation(
    (body: { id: string; acknowledgeRemovals: boolean }) =>
      apiFetch<SheetPreview>(
        `/admin/sources/${sourceId}/preview/${body.id}/confirm`,
        json({ acknowledgeRemovals: body.acknowledgeRemovals }),
      ),
    {
      onSuccess: (preview) => {
        startSync.mutate({
          scope: 'SOURCE',
          sourceId,
          previewId: preview.id,
          releaseAfterSync: release,
        });
      },
    },
  );
  const preview = run.data;
  const removed = preview?.summary.comparison.removed ?? [];
  const renames = preview?.summary.comparison.possibleRenames ?? [];
  const canSync = Boolean(preview?.summary.canConfirm) && (removed.length === 0 || acknowledged);
  const busy = confirm.isPending || startSync.isPending;

  return (
    <>
      <Button
        disabled={disabled}
        onClick={() => {
          setAcknowledged(false);
          setRelease(false);
          setOpen(true);
          run.mutate(undefined);
        }}
      >
        <RefreshCw aria-hidden />
        Sync now
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {removed.length ? 'Remove subjects and sync?' : 'Sync this sheet?'}
            </DialogTitle>
            <DialogDescription>
              Imports the latest marks and students from the sheet.
            </DialogDescription>
          </DialogHeader>
          {run.isPending ? <LoadingRows rows={2} /> : null}
          {run.error ? <ErrorState error={run.error} /> : null}
          {preview && !preview.summary.canConfirm ? <ProblemList preview={preview} /> : null}
          {renames.map((r) => (
            <Alert key={r.from}>
              <TriangleAlert aria-hidden />
              <AlertTitle>
                Possible rename: {r.from} to {r.to}
              </AlertTitle>
              <AlertDescription>
                If it is the same subject, cancel, then confirm tab {r.to} with the subject name of{' '}
                {r.from}. Its data carries over instead of being removed.
              </AlertDescription>
            </Alert>
          ))}
          {preview?.summary.canConfirm && removed.length > 0 ? (
            <RemovalWarning
              removed={removed}
              acknowledged={acknowledged}
              onAcknowledge={setAcknowledged}
            />
          ) : null}
          {preview?.summary.canConfirm ? (
            <ReleaseAfterSyncOption
              rows={status.data}
              loading={status.isPending}
              checked={release}
              onCheckedChange={setRelease}
            />
          ) : null}
          {confirm.error ? <ErrorState error={confirm.error} /> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={removed.length ? 'destructive' : 'default'}
              disabled={!canSync || busy}
              onClick={() =>
                preview &&
                confirm.mutate({ id: preview.id, acknowledgeRemovals: removed.length > 0 })
              }
            >
              {removed.length ? 'Remove and sync' : 'Sync now'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * "Sync now" for a pending sheet whose preview is confirmed: the sync that promotes it, with the
 * "Release scores after sync" option.
 */
export function SyncPendingSheet({ sourceId, disabled }: { sourceId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [release, setRelease] = useState(false);
  const status = useReleaseStatus(open ? [sourceId] : []);
  const startSync = useStartSync();
  return (
    <>
      <Button
        disabled={disabled || startSync.isPending}
        onClick={() => {
          setRelease(false);
          setOpen(true);
        }}
      >
        <RefreshCw aria-hidden />
        Sync now
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sync the new sheet?</DialogTitle>
            <DialogDescription>
              Imports exactly what the confirmed preview shows and makes this sheet the term&apos;s
              workbook.
            </DialogDescription>
          </DialogHeader>
          {status.error ? <ErrorState error={status.error} /> : null}
          <ReleaseAfterSyncOption
            rows={status.data}
            loading={status.isPending}
            checked={release}
            onCheckedChange={setRelease}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={startSync.isPending}>
              Cancel
            </Button>
            <Button
              disabled={startSync.isPending || !status.data}
              onClick={() =>
                startSync.mutate({ scope: 'SOURCE', sourceId, releaseAfterSync: release })
              }
            >
              Sync now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** GET /admin/sync/plan query for a Sync Center or generation target. */
function planQuery(target: SyncTarget): string {
  return qs({
    scope: target.scope,
    generationId: target.generationId,
    termId: target.termId,
    termNumber: target.termNumber,
  });
}

/**
 * Start sync for a generation, a term or everything (Sync Center, generation page). Such a sync
 * reads no preview, and changes what students see in released terms, so it is confirmed first:
 * the workbooks it reads, each with its release state, and "Release scores after sync".
 */
export function SyncPlanButton({
  target,
  disabled,
  label = 'Start sync',
}: {
  target: SyncTarget | null;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [release, setRelease] = useState(false);
  const startSync = useStartSync();
  const plan = useApi<SourceReleaseView[]>(
    open && target ? `/admin/sync/plan${planQuery(target)}` : null,
  );
  const rows = plan.data ?? [];
  return (
    <>
      <Button
        disabled={disabled || !target || startSync.isPending}
        onClick={() => {
          setRelease(false);
          setOpen(true);
        }}
      >
        <RefreshCw aria-hidden className={startSync.isPending ? 'animate-spin' : undefined} />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start this sync?</DialogTitle>
            <DialogDescription>
              Reads the confirmed tabs of each workbook below and imports students and marks.
              Subjects are never removed by this sync.
            </DialogDescription>
          </DialogHeader>
          {plan.error ? <ErrorState error={plan.error} onRetry={() => plan.refetch()} /> : null}
          {plan.isPending ? <LoadingRows rows={2} /> : null}
          {plan.data && rows.length === 0 ? (
            <Alert>
              <TriangleAlert aria-hidden />
              <AlertTitle>No workbooks to sync</AlertTitle>
              <AlertDescription>
                No confirmed workbook matches this Generation and Term.
              </AlertDescription>
            </Alert>
          ) : null}
          {rows.length ? (
            <>
              <div>
                <p className="mb-1 text-sm font-medium">
                  {rows.length} {rows.length === 1 ? 'workbook' : 'workbooks'} will be read:
                </p>
                <ul className="max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-sm">
                  {rows.map((r) => (
                    <li key={r.sourceId}>
                      {r.generation.name}, {r.term.name}: {r.subjects} subjects, {r.students}{' '}
                      students
                    </li>
                  ))}
                </ul>
              </div>
              <ReleaseAfterSyncOption rows={rows} checked={release} onCheckedChange={setRelease} />
            </>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={startSync.isPending}>
              Cancel
            </Button>
            <Button
              disabled={startSync.isPending || !rows.length || !target}
              onClick={() => target && startSync.mutate({ ...target, releaseAfterSync: release })}
            >
              Start sync
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
