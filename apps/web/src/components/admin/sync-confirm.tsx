'use client';

import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useStartSync } from '@/components/admin/use-start-sync';
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
import { json, useApiMutation } from '@/lib/query';
import type { RemovedSubject, SheetPreview } from '@/lib/types';

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
        startSync.mutate({ scope: 'SOURCE', sourceId, previewId: preview.id });
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
