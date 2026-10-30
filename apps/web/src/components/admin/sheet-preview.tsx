'use client';

import { CheckCircle2, ScanSearch, TriangleAlert } from 'lucide-react';
import { IssuesTable } from '@/components/admin/issues-table';
import { StatusPill } from '@/components/app/status';
import { ErrorState } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/query';
import type { ImpactCounts, PreviewTab, SheetPreview } from '@/lib/types';

const TAB_STATUS: Record<PreviewTab['status'], { label: string; tone: 'success' | 'danger' }> = {
  OK: { label: 'Ready', tone: 'success' },
  MISSING: { label: 'Missing from sheet', tone: 'danger' },
  HEADERS_CHANGED: { label: 'Headers changed', tone: 'danger' },
  INVALID: { label: 'Invalid data', tone: 'danger' },
};

function Counts({ title, counts }: { title: string; counts: ImpactCounts }) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="text-sm font-medium tabular-nums">
        {counts.new} new · {counts.changed} changed · {counts.unchanged} unchanged ·{' '}
        <span className={counts.invalid ? 'text-destructive' : undefined}>
          {counts.invalid} invalid
        </span>
      </p>
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <p className="text-sm">
      <span className="font-medium">{title}:</span> {items.join(', ')}
    </p>
  );
}

/** Runs and confirms the impact preview a new sheet needs before it can be synced. */
export function SheetPreviewPanel({ sourceId }: { sourceId: string }) {
  const latest = useApi<SheetPreview | null>(`/admin/sources/${sourceId}/preview`);
  const invalidate = [`/admin/sources/${sourceId}`, '/admin/term-workbooks'];
  const run = useApiMutation(
    () => apiFetch<SheetPreview>(`/admin/sources/${sourceId}/preview`, { method: 'POST' }),
    { invalidate },
  );
  const confirm = useApiMutation(
    (id: string) =>
      apiFetch<SheetPreview>(`/admin/sources/${sourceId}/preview/${id}/confirm`, {
        method: 'POST',
      }),
    { success: 'Preview confirmed. You can sync this sheet now.', invalidate },
  );
  const preview = latest.data;
  const summary = preview?.summary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Compares this sheet with the current scores. Nothing is imported. Any change to the sheet
          or its tabs means running this again.
        </p>
        <Button variant="outline" onClick={() => run.mutate(undefined)} disabled={run.isPending}>
          <ScanSearch aria-hidden />
          {run.isPending ? 'Reading the sheet…' : preview ? 'Run preview again' : 'Run preview'}
        </Button>
      </div>
      {run.error ? <ErrorState error={run.error} /> : null}
      {latest.error ? <ErrorState error={latest.error} onRetry={() => latest.refetch()} /> : null}
      {preview && summary ? (
        <>
          {preview.confirmedAt ? (
            <Alert>
              <CheckCircle2 aria-hidden />
              <AlertTitle>Preview confirmed</AlertTitle>
              <AlertDescription>Choose “Sync now” to import this sheet.</AlertDescription>
            </Alert>
          ) : summary.canConfirm ? null : (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden />
              <AlertTitle>This sheet cannot be synced yet</AlertTitle>
              <AlertDescription>
                A sync needs zero errors. Fix the problems below, then run the preview again.
              </AlertDescription>
            </Alert>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Counts title="Students" counts={summary.students} />
            <Counts title="Scores" counts={summary.scores} />
          </div>
          <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tab</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">New</TableHead>
                  <TableHead className="text-right">Changed</TableHead>
                  <TableHead className="text-right">Unchanged</TableHead>
                  <TableHead className="text-right">Invalid</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.tabs.map((tab) => (
                  <TableRow key={tab.tabName}>
                    <TableCell className="font-medium">{tab.subject}</TableCell>
                    <TableCell>
                      <StatusPill tone={TAB_STATUS[tab.status].tone}>
                        {TAB_STATUS[tab.status].label}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{tab.scores.new}</TableCell>
                    <TableCell className="text-right tabular-nums">{tab.scores.changed}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {tab.scores.unchanged}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{tab.scores.invalid}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {[
                        tab.weightsChanged ? 'Weights change' : null,
                        tab.keptBlank ? `${tab.keptBlank} blank cells keep their old mark` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <List title="Tabs with no confirmed mapping (skipped)" items={summary.unmappedTabs} />
          <List
            title="Subjects not fed by this sheet (keep their scores)"
            items={summary.subjectsNotInSheet}
          />
          {summary.missingStudents.total ? (
            <p className="text-sm">
              <span className="font-medium">
                {summary.missingStudents.total} students missing from this sheet (they keep their
                scores):
              </span>{' '}
              {summary.missingStudents.sample.map((s) => s.studentCode).join(', ')}
            </p>
          ) : null}
          {summary.issues.length ? <IssuesTable issues={summary.issues} /> : null}
          {summary.issuesTruncated ? (
            <p className="text-xs text-muted-foreground">Only the first 200 issues are shown.</p>
          ) : null}
          {!preview.confirmedAt && summary.canConfirm ? (
            <div className="flex justify-end">
              <Button onClick={() => confirm.mutate(preview.id)} disabled={confirm.isPending}>
                <CheckCircle2 aria-hidden />
                Confirm preview
              </Button>
            </div>
          ) : null}
          {confirm.error ? <ErrorState error={confirm.error} /> : null}
        </>
      ) : null}
    </div>
  );
}
