'use client';

import { CheckCircle2, ScanSearch, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { ISSUES_PAGE_SIZE, IssueFilters, PagedIssues } from '@/components/admin/paged-issues';
import {
  ReplacementSummary,
  TermLabelInput,
  termLabelMatches,
} from '@/components/admin/replacement-summary';
import {
  RosterCheckSection,
  StudentNameIssues,
  rosterCheckNeeded,
} from '@/components/admin/roster-check';
import { RemovalWarning } from '@/components/admin/sync-confirm';
import { StatusPill } from '@/components/app/status';
import { Spinner, TaskStatus } from '@/components/app/loading';
import { ErrorState, errorMessage } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch, withTimeout } from '@/lib/api';
import { json, qs, useApi, useApiMutation } from '@/lib/query';
import type {
  CommentCounts,
  ConfirmPreviewBody,
  ImpactCounts,
  PreviewIssuePage,
  PreviewTab,
  RemovedSubject,
  Replacement,
  RosterCheck,
  SheetComparison,
  SheetPreview,
} from '@/lib/types';

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

/** The preview's issues, a page at a time from the server, filtered like a sync job's. */
function PreviewIssues({ sourceId, previewId }: { sourceId: string; previewId: string }) {
  const [filters, setFilters] = useState({ severity: '', sheetTab: '' });
  const [page, setPage] = useState(1);
  const issues = useApi<PreviewIssuePage>(
    `/admin/sources/${sourceId}/preview/${previewId}/issues${qs({
      ...filters,
      page,
      pageSize: ISSUES_PAGE_SIZE,
    })}`,
    { keepPrevious: true },
  );
  return (
    <section aria-label="Issues" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Issues</h3>
        <IssueFilters
          value={filters}
          tabs={issues.data?.tabs ?? []}
          onChange={(next) => {
            setFilters(next);
            setPage(1);
          }}
        />
      </div>
      {issues.error ? (
        <ErrorState error={issues.error} onRetry={() => issues.refetch()} />
      ) : !issues.data ? null : (
        <>
          {issues.data.notListed > 0 ? (
            <p className="text-sm text-muted-foreground">
              {issues.data.notListed.toLocaleString()} more issues are not listed: a preview keeps
              only the first 20,000.
            </p>
          ) : null}
          <PagedIssues
            issues={issues.data.data}
            total={issues.data.meta.total}
            page={issues.data.meta.page}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}

/** Per-tab comment changes for the Notes column; null when nothing would change. */
function commentNote(c: CommentCounts | undefined): string | null {
  if (!c) return null;
  const parts = [
    c.new + c.changed ? `${c.new + c.changed} comments new or changed` : null,
    c.cleared ? `${c.cleared} comments cleared` : null,
    c.tooLong ? `${c.tooLong} comments too long` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function CommentCountsBox({ counts }: { counts: CommentCounts }) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <p className="text-xs text-muted-foreground">Teacher comments</p>
      <p className="text-sm font-medium tabular-nums">
        {counts.new} new · {counts.changed} changed · {counts.cleared} cleared · {counts.unchanged}{' '}
        unchanged
        {counts.tooLong ? (
          <span className="text-warning"> · {counts.tooLong} too long, not imported</span>
        ) : null}
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

/** The term's subjects today against this sheet. */
function Comparison({
  comparison,
  replacing,
}: {
  comparison: SheetComparison;
  /** A replacement lists its subjects itself, as deleted rather than removed. */
  replacing: boolean;
}) {
  const added = comparison.added.map((a) =>
    a.returning ? `${a.subject} (returning, starts with no old scores)` : a.subject,
  );
  return (
    <div className="space-y-3">
      {replacing ? null : (
        <>
          <List title="Kept subjects" items={comparison.kept} />
          <List title="Added subjects" items={added} />
        </>
      )}
      {!replacing && comparison.removed.length ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Removed subjects (lost compared with the old sheet)</p>
          <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>Tab</TableHead>
                  <TableHead className="text-right">Students</TableHead>
                  <TableHead className="text-right">Score rows</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {comparison.removed.map((r) => (
                  <TableRow key={r.offeringId}>
                    <TableCell className="font-medium">{r.subject}</TableCell>
                    <TableCell>{r.tabName ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.students}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.scores}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}
      {comparison.possibleRenames.map((r) => (
        <Alert key={r.from}>
          <TriangleAlert aria-hidden />
          <AlertTitle>
            Possible rename: {r.from} to {r.to}
          </AlertTitle>
          <AlertDescription>
            If it is the same subject, confirm tab {r.to} with the subject name of {r.from}, then
            run the preview again. Its data carries over instead of being removed.
          </AlertDescription>
        </Alert>
      ))}
      {comparison.blockers.length ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <AlertTitle>Fix these before syncing</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {comparison.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * Asks before a sheet's preview is accepted. A replacement (a different spreadsheet) deletes the
 * term's data for good, so the term label must be typed; removed subjects need the tick; a roster
 * check needs "I have checked these students". Cancel changes nothing.
 */
function ConfirmPreview({
  removed,
  replacement,
  rosterCheck,
  busy,
  onConfirm,
}: {
  removed: RemovedSubject[];
  replacement: Replacement | null;
  rosterCheck: RosterCheck | null;
  busy: boolean;
  onConfirm(body: ConfirmPreviewBody): void;
}) {
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [typed, setTyped] = useState('');
  const [rosterChecked, setRosterChecked] = useState(false);
  // A replacement deletes instead of removing: the typed label replaces the tick.
  const removing = !replacement && removed.length > 0;
  const needsRoster = rosterCheckNeeded(rosterCheck);
  const ready =
    (replacement ? termLabelMatches(typed, replacement) : !removing || acknowledged) &&
    (!needsRoster || rosterChecked);
  const destructive = Boolean(replacement) || removing;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setAcknowledged(false);
        setTyped('');
        setRosterChecked(false);
      }}
    >
      <DialogTrigger render={<Button variant={replacement ? 'destructive' : 'default'} />}>
        <CheckCircle2 aria-hidden />
        Confirm preview
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {replacement
              ? `Permanently delete the data of ${replacement.termLabel} and replace it?`
              : removing
                ? 'Remove subjects with this sheet?'
                : 'Confirm preview?'}
          </DialogTitle>
          <DialogDescription>
            {replacement
              ? 'This cannot be undone. The sync that follows deletes what is listed here, then imports exactly what this preview shows.'
              : 'The sync that follows imports exactly what this preview shows.'}
          </DialogDescription>
        </DialogHeader>
        {replacement ? <ReplacementSummary replacement={replacement} /> : null}
        {removing ? (
          <RemovalWarning
            removed={removed}
            acknowledged={acknowledged}
            onAcknowledge={setAcknowledged}
          />
        ) : null}
        <RosterCheckSection
          check={rosterCheck}
          checked={rosterChecked}
          onCheckedChange={setRosterChecked}
          disabled={busy}
        />
        {replacement ? (
          <TermLabelInput
            termLabel={replacement.termLabel}
            value={typed}
            onChange={setTyped}
            disabled={busy}
          />
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy || !ready}
            onClick={() => {
              onConfirm({
                ...(replacement
                  ? { confirmTermLabel: typed.trim() }
                  : { acknowledgeRemovals: removing }),
                ...(needsRoster ? { rosterChecked: true } : {}),
              });
              setOpen(false);
            }}
          >
            {replacement ? 'Delete and replace' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Runs and confirms the impact preview a new sheet needs before it can be synced. */
export function SheetPreviewPanel({ sourceId }: { sourceId: string }) {
  const latest = useApi<SheetPreview | null>(`/admin/sources/${sourceId}/preview`);
  const invalidate = [`/admin/sources/${sourceId}`, '/admin/term-workbooks'];
  const run = useApiMutation(
    () =>
      withTimeout((signal) =>
        apiFetch<SheetPreview>(`/admin/sources/${sourceId}/preview`, { method: 'POST', signal }),
      ),
    { invalidate },
  );
  const confirm = useApiMutation(
    ({ id, ...body }: ConfirmPreviewBody & { id: string }) =>
      apiFetch<SheetPreview>(`/admin/sources/${sourceId}/preview/${id}/confirm`, json(body)),
    { success: 'Preview confirmed. You can sync this sheet now.', invalidate },
  );
  const preview = latest.data;
  const summary = preview?.summary;
  const replacement = summary?.replacement ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Compares this sheet with the current scores. Nothing is imported. Any change to the sheet
          or its tabs means running this again.
        </p>
        <Button
          variant="outline"
          onClick={() => run.mutate(undefined)}
          disabled={run.isPending}
          aria-busy={run.isPending || undefined}
        >
          {run.isPending ? <Spinner /> : <ScanSearch aria-hidden />}
          {run.isPending ? 'Reading the sheet…' : preview ? 'Run preview again' : 'Run preview'}
        </Button>
      </div>
      <TaskStatus
        running={run.isPending}
        label="Building preview…"
        error={run.error ? errorMessage(run.error) : null}
        errorTitle="The preview did not finish"
        onRetry={() => run.mutate(undefined)}
      />
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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Counts title="Students" counts={summary.students} />
            <Counts title="Scores" counts={summary.scores} />
            {summary.comments ? <CommentCountsBox counts={summary.comments} /> : null}
            {summary.termEnrollments ? (
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">
                  Term enrollments (class and program)
                </p>
                <p className="text-sm font-medium tabular-nums">
                  {summary.termEnrollments.created} new · {summary.termEnrollments.classChanged}{' '}
                  class changes · {summary.termEnrollments.unchanged} unchanged
                  {summary.termEnrollments.blocked ? (
                    <span className="text-warning">
                      {' '}
                      · {summary.termEnrollments.blocked} need an admin
                    </span>
                  ) : null}
                </p>
              </div>
            ) : null}
          </div>
          {summary.programChanges?.length ? (
            <p className="text-sm">
              <span className="font-medium">
                {summary.programChanges.length} program changes wait for an admin (not applied):
              </span>{' '}
              {summary.programChanges.map((c) => `${c.studentCode} ${c.from} → ${c.to}`).join(', ')}
            </p>
          ) : null}
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
                        tab.cleared ? `${tab.cleared} blank cells clear a stored mark` : null,
                        commentNote(tab.comments),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {replacement ? <ReplacementSummary replacement={replacement} /> : null}
          <Comparison comparison={summary.comparison} replacing={Boolean(replacement)} />
          <StudentNameIssues summary={summary} />
          <List title="Tabs with no confirmed mapping" items={summary.unmappedTabs} />
          {!replacement && summary.missingStudents.total ? (
            <p className="text-sm">
              <span className="font-medium">
                {summary.missingStudents.total} students missing from this sheet (they keep their
                scores):
              </span>{' '}
              {summary.missingStudents.sample.map((s) => s.studentCode).join(', ')}
            </p>
          ) : null}
          {summary.issueCounts.total ? (
            <PreviewIssues sourceId={sourceId} previewId={preview.id} />
          ) : null}
          {!preview.confirmedAt && summary.canConfirm ? (
            <div className="flex justify-end">
              <ConfirmPreview
                removed={summary.comparison.removed}
                replacement={replacement}
                rosterCheck={summary.rosterCheck ?? null}
                busy={confirm.isPending}
                onConfirm={(body) => confirm.mutate({ id: preview.id, ...body })}
              />
            </div>
          ) : null}
          {confirm.error ? <ErrorState error={confirm.error} /> : null}
        </>
      ) : null}
    </div>
  );
}
