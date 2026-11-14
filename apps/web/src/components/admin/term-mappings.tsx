'use client';

import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  ScanSearch,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { IssueFilters, PagedIssues, useIssuePage } from '@/components/admin/paged-issues';
import { NativeSelect } from '@/components/app/form';
import { Pagination } from '@/components/app/pagination';
import { StatusPill } from '@/components/app/status';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyState, ErrorState, LoadingRows } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, apiFetch } from '@/lib/api';
import { takeAutoDetect } from '@/lib/auto-detect';
import { json, useApi, useApiMutation } from '@/lib/query';
import type {
  ColumnMapping,
  ColumnRole,
  DetectedTab,
  Detection,
  DetectionChange,
  SheetIssue,
  TabMapping,
  TermClasses,
} from '@/lib/types';

const ROLES: { value: ColumnRole; label: string }[] = [
  { value: 'CRITERION', label: 'Marks' },
  { value: 'STUDENT_ID', label: 'Student ID' },
  { value: 'FIRST_NAME', label: 'First name' },
  { value: 'LAST_NAME', label: 'Last name' },
  { value: 'FULL_NAME', label: 'Full name' },
  { value: 'GENDER', label: 'Gender' },
  { value: 'CLASS', label: 'Class' },
  { value: 'PROGRAM', label: 'Major / program (check only)' },
  { value: 'ROW_NUMBER', label: 'Row number' },
  { value: 'REFERENCE_TOTAL', label: 'Sheet total (check only)' },
  { value: 'COMMENT', label: 'Teacher comment' },
  { value: 'IGNORE', label: 'Ignore' },
];

const STATUS: Record<
  TabMapping['status'],
  { label: string; tone: 'success' | 'warning' | 'neutral' }
> = {
  DRAFT: { label: 'Needs review', tone: 'warning' },
  CONFIRMED: { label: 'Confirmed', tone: 'success' },
  IGNORED: { label: 'Ignored', tone: 'neutral' },
};

/** Weights are added in thousandths so 7.5 + 7.5 + 1.25… totals exactly 100. */
function totalWeight(columns: ColumnMapping[]): number {
  const sum = columns
    .filter((c) => c.role === 'CRITERION')
    .reduce((total, c) => total + Math.round(Number(c.proposedWeight ?? 0) * 1000), 0);
  return sum / 1000;
}

const roleLabel = (role: ColumnRole) => ROLES.find((r) => r.value === role)?.label ?? role;

/**
 * Before confirming a tab with columns missing from the sheet: exactly what is dropped (name, role,
 * weight) and the weight total that remains. Only the mapping rows go; marks and criteria stay.
 * Weights that do not total 100 already block the confirm (the button and the API), so this dialog
 * cannot be reached then.
 */
function DropMissingDialog({
  open,
  onOpenChange,
  missing,
  total,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  missing: ColumnMapping[];
  total: number;
  busy: boolean;
  onConfirm(): void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Drop {missing.length === 1 ? '1 missing column' : `${missing.length} missing columns`}{' '}
            and confirm?
          </AlertDialogTitle>
          <AlertDialogDescription>
            These columns are no longer in the sheet. Confirming removes them from this tab&apos;s
            mapping. Their marks and criteria are kept.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul
          data-slot="dropped-columns"
          className="divide-y rounded-lg text-sm ring-1 ring-foreground/10"
        >
          {missing.map((c, i) => (
            <li
              key={`${c.headerLabel}:${i}`}
              className="flex flex-wrap justify-between gap-2 px-3 py-2"
            >
              <span className="font-medium break-words">
                {c.proposedName ?? c.headerLabel ?? 'Unnamed column'}
              </span>
              <span className="text-muted-foreground">
                {roleLabel(c.role)}
                {c.role === 'CRITERION' ? ` · ${c.proposedWeight ?? 0}%` : ''}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-sm tabular-nums">
          Weight total after dropping them: <span className="font-medium">{total}%</span>
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button disabled={busy || total !== 100} onClick={onConfirm}>
            Drop and confirm
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "Shared" or "WEP only", for an audience as the API returns it. */
function audienceLabel(audience: string | null, programs: number): string {
  if (programs <= 1) return 'Everyone (one program this term)';
  if (!audience) return 'Not set: the next sync guesses it from who the tab lists';
  return audience === 'SHARED' ? 'Shared by every program' : `${audience} only`;
}

function TabReview({
  sourceId,
  tab,
  detected,
  audienceSuggestion,
  readOnly,
  programs,
}: {
  sourceId: string;
  tab: TabMapping;
  detected: DetectedTab['detected'] | undefined;
  /** What the sheet now suggests for a reopened tab; the saved choice stays until confirmed. */
  audienceSuggestion: string | null | undefined;
  readOnly: boolean;
  /** The term's program codes. */
  programs: string[];
}) {
  const [subjectName, setSubjectName] = useState(tab.carriedFrom?.subject ?? tab.tabName);
  const [audience, setAudience] = useState(tab.audience ?? 'SHARED');
  const [usedSuggestion, setUsedSuggestion] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);
  const [columns, setColumns] = useState(tab.columns);
  // Columns missing from the sheet are shown, never sent or counted; confirming drops them.
  const present = columns.filter((c) => !c.missingFromSheet);
  const missing = columns.filter((c) => c.missingFromSheet);
  const invalidate = [`/admin/sources/${sourceId}`, '/admin/term-workbooks'];
  const base = `/admin/sources/${sourceId}/mappings/${tab.id}`;
  const confirm = useApiMutation(
    () =>
      apiFetch(
        `${base}/confirm`,
        json({
          subjectName,
          ...(programs.length > 1 ? { audience } : {}),
          ...(missing.length > 0 ? { dropMissingColumns: true } : {}),
          ...(usedSuggestion && audience === audienceSuggestion
            ? { appliedAudienceSuggestion: true }
            : {}),
          columns: present.map((c) => ({
            columnIndex: c.columnIndex,
            role: c.role,
            ...(c.role === 'CRITERION'
              ? { name: c.proposedName ?? c.headerLabel ?? '', weight: c.proposedWeight ?? '' }
              : {}),
          })),
        }),
      ),
    {
      success: `Confirmed "${tab.tabName}".`,
      invalidate,
      onSuccess: () => setDropOpen(false),
    },
  );
  const ignore = useApiMutation(() => apiFetch(`${base}/ignore`, { method: 'POST' }), {
    success: `"${tab.tabName}" will be skipped.`,
    invalidate,
  });
  const reopen = useApiMutation(() => apiFetch(`${base}/reopen`, { method: 'POST' }), {
    success: 'Reopened. Detect tabs again to refresh its columns.',
    invalidate,
  });

  const editable = !readOnly && tab.status === 'DRAFT';
  const total = totalWeight(present);
  const update = (index: number | null, patch: Partial<ColumnMapping>) =>
    setColumns((all) => all.map((c) => (c.columnIndex === index ? { ...c, ...patch } : c)));

  return (
    <div className="space-y-4 border-t p-4">
      {detected?.crossCheck ? (
        <p className="text-sm text-muted-foreground">
          Sheet total check:{' '}
          {detected.crossCheck.comparableRows - detected.crossCheck.mismatchedRows} of{' '}
          {detected.crossCheck.comparableRows} complete rows match
          {detected.crossCheck.blanksAsZeroRows
            ? `; ${detected.crossCheck.blanksAsZeroRows} rows match only if blanks count as 0`
            : ''}
          .
        </p>
      ) : null}
      {detected?.headersChanged ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <AlertTitle>The headers of this tab changed</AlertTitle>
          <AlertDescription>
            Its scores are skipped until you reopen the tab, detect again and confirm.
          </AlertDescription>
        </Alert>
      ) : null}
      {tab.carriedFrom ? (
        <p className="text-sm text-muted-foreground">
          {tab.carriedFrom.headersMatch
            ? 'Prefilled from the current sheet. Its headers match; check it and confirm.'
            : 'Prefilled from the current sheet, but the headers differ. Check every column.'}
        </p>
      ) : null}
      {editable ? (
        <div className="flex flex-wrap gap-4">
          <div className="w-full max-w-sm space-y-1.5">
            <Label htmlFor={`subject-${tab.id}`}>Subject name</Label>
            <Input
              id={`subject-${tab.id}`}
              value={subjectName}
              maxLength={120}
              onChange={(e) => setSubjectName(e.target.value)}
            />
          </div>
          {programs.length > 1 ? (
            <div className="w-full max-w-xs space-y-1.5">
              <Label htmlFor={`audience-${tab.id}`}>Who takes it</Label>
              <NativeSelect
                id={`audience-${tab.id}`}
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
              >
                <option value="SHARED">Shared by every program</option>
                {programs.map((p) => (
                  <option key={p} value={p}>
                    {p} only
                  </option>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">
                Proposed from who the tab lists. Students of another program in it are rejected.
              </p>
              {audienceSuggestion && audienceSuggestion !== audience ? (
                <p data-slot="audience-suggestion" className="text-xs" role="note">
                  The sheet now suggests{' '}
                  <strong>{audienceLabel(audienceSuggestion, programs.length)}</strong>. Your saved
                  choice is kept.{' '}
                  <button
                    type="button"
                    className="font-medium underline underline-offset-4"
                    onClick={() => {
                      setAudience(audienceSuggestion);
                      setUsedSuggestion(true);
                    }}
                  >
                    Use the suggestion
                  </button>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm">
          <span className="text-muted-foreground">Who takes it: </span>
          {audienceLabel(tab.audience, programs.length)}
        </p>
      )}
      <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sheet column</TableHead>
              <TableHead>Use as</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-28">Weight %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {missing.map((c, i) => (
              <TableRow key={`missing:${c.headerLabel}:${i}`} data-slot="missing-column">
                <TableCell>
                  <span className="font-medium">{c.headerLabel}</span>
                  <StatusPill tone="warning" className="ml-2">
                    Missing from the sheet
                  </StatusPill>
                </TableCell>
                <TableCell className="text-muted-foreground">{roleLabel(c.role)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {c.role === 'CRITERION' ? (c.proposedName ?? c.headerLabel) : null}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {c.role === 'CRITERION' ? `${c.proposedWeight ?? 0}` : null}
                </TableCell>
              </TableRow>
            ))}
            {present.map((c) => (
              <TableRow key={c.columnIndex}>
                <TableCell>
                  <span className="font-medium">{c.headerLabel}</span>
                  {c.groupLabel ? (
                    <span className="block text-xs text-muted-foreground">{c.groupLabel}</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <select
                    aria-label={`Use of column ${c.headerLabel}`}
                    className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm disabled:opacity-60"
                    value={c.role}
                    disabled={!editable}
                    onChange={(e) => update(c.columnIndex, { role: e.target.value as ColumnRole })}
                  >
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </TableCell>
                <TableCell>
                  {c.role === 'CRITERION' ? (
                    <Input
                      aria-label={`Name of column ${c.headerLabel}`}
                      value={c.proposedName ?? c.headerLabel ?? ''}
                      maxLength={120}
                      disabled={!editable}
                      onChange={(e) => update(c.columnIndex, { proposedName: e.target.value })}
                    />
                  ) : null}
                </TableCell>
                <TableCell>
                  {c.role === 'CRITERION' ? (
                    <Input
                      aria-label={`Weight of column ${c.headerLabel}`}
                      inputMode="decimal"
                      value={c.proposedWeight ?? ''}
                      disabled={!editable}
                      onChange={(e) => update(c.columnIndex, { proposedWeight: e.target.value })}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm tabular-nums">
          Total weight:{' '}
          <span className={total === 100 ? 'font-medium' : 'font-medium text-destructive'}>
            {total}%
          </span>
          {total === 100 ? null : ' (must be 100)'}
          {missing.length > 0 ? (
            <span className="block text-xs text-muted-foreground">
              Columns missing from the sheet are not counted.
            </span>
          ) : null}
        </p>
        {readOnly ? null : (
          <div className="flex flex-wrap gap-2">
            {tab.status === 'DRAFT' ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => ignore.mutate(undefined)}
                  disabled={ignore.isPending}
                >
                  Not a subject
                </Button>
                <Button
                  onClick={() =>
                    missing.length > 0 ? setDropOpen(true) : confirm.mutate(undefined)
                  }
                  disabled={confirm.isPending || total !== 100 || !subjectName.trim()}
                >
                  <CheckCircle2 aria-hidden />
                  Confirm tab
                </Button>
                <DropMissingDialog
                  open={dropOpen}
                  onOpenChange={setDropOpen}
                  missing={missing}
                  total={total}
                  busy={confirm.isPending}
                  onConfirm={() => confirm.mutate(undefined)}
                />
              </>
            ) : (
              <Button
                variant="outline"
                onClick={() => reopen.mutate(undefined)}
                disabled={reopen.isPending}
              >
                Reopen for review
              </Button>
            )}
          </div>
        )}
      </div>
      {confirm.error ? (
        <p className="text-sm text-destructive" role="alert">
          {confirm.error.message}
        </p>
      ) : null}
    </div>
  );
}

const CHANGES_PAGE_SIZE = 5;

function changeText(c: DetectionChange, programs: number): string {
  switch (c.kind) {
    case 'TAB_NEW':
      return 'New tab, to review';
    case 'TAB_GONE':
      return 'No longer in the sheet';
    case 'COLUMN_ADDED':
      return `New column "${c.detail}": proposed, check it`;
    case 'COLUMN_MISSING':
      return `Column "${c.detail}" is missing from the sheet`;
    case 'COLUMN_RETURNED':
      return `Column "${c.detail}" is back in the sheet, as you left it`;
    case 'HEADERS_CHANGED':
      return 'Headers changed since it was confirmed: reopen it to review';
    case 'AUDIENCE_SUGGESTED':
      return `The sheet suggests "${audienceLabel(c.detail, programs)}"; your choice is kept`;
  }
}

/** "Changes detected" after each run, 5 per page like every other list of findings. */
function DetectionChanges({ changes, programs }: { changes: DetectionChange[]; programs: number }) {
  const [page, setPage] = useState(1);
  if (changes.length === 0) {
    return (
      <p data-slot="detection-changes" className="text-sm text-muted-foreground">
        No changes since the tabs were last read.
      </p>
    );
  }
  const shown = changes.slice((page - 1) * CHANGES_PAGE_SIZE, page * CHANGES_PAGE_SIZE);
  return (
    <section data-slot="detection-changes" aria-label="Changes detected" className="space-y-2">
      <h4 className="text-sm font-medium">Changes detected</h4>
      <ul className="divide-y rounded-lg text-sm ring-1 ring-foreground/10">
        {shown.map((c, i) => (
          <li key={`${c.tabName}:${c.kind}:${c.detail}:${i}`} className="px-3 py-2">
            <span className="font-medium">{c.tabName}</span>
            <span className="text-muted-foreground">: {changeText(c, programs)}</span>
          </li>
        ))}
      </ul>
      {changes.length > CHANGES_PAGE_SIZE ? (
        <Pagination
          page={page}
          pageSize={CHANGES_PAGE_SIZE}
          total={changes.length}
          onPage={setPage}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {changes.length === 1 ? '1 change' : `${changes.length} changes`}
        </p>
      )}
    </section>
  );
}

/** A failed read: the sheet stays connected; the admin can try again. */
function DetectError({ error, onRetry }: { error: Error; onRetry(): void }) {
  const running = error instanceof ApiError && error.code === 'DETECT_IN_PROGRESS';
  return (
    <Alert variant={running ? 'default' : 'destructive'} role="alert">
      <TriangleAlert aria-hidden />
      <AlertTitle>
        {running ? 'The tabs are already being read' : 'The tabs could not be read'}
      </AlertTitle>
      <AlertDescription>
        <p>
          {running
            ? 'Another detection of this sheet is still running. Wait a moment, then try again.'
            : `${error.message} The sheet is still connected; nothing was changed.`}
        </p>
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** Detection issues are not stored, so they are paged in the browser, the same way as the others. */
function DetectionIssues({ issues }: { issues: SheetIssue[] }) {
  const [filters, setFilters] = useState({ severity: '', sheetTab: '' });
  const matching = issues.filter(
    (i) =>
      (!filters.severity || i.severity === filters.severity) &&
      (!filters.sheetTab || i.sheetTab === filters.sheetTab),
  );
  const paged = useIssuePage(matching, `${filters.severity}|${filters.sheetTab}`);
  const tabs = [...new Set(issues.flatMap((i) => (i.sheetTab ? [i.sheetTab] : [])))].toSorted();
  return (
    <div className="space-y-3">
      <IssueFilters value={filters} tabs={tabs} onChange={setFilters} />
      <PagedIssues
        issues={paged.items}
        total={paged.total}
        page={paged.page}
        onPage={paged.setPage}
      />
    </div>
  );
}

export function TermMappings({
  sourceId,
  termId,
  readOnly,
}: {
  sourceId: string;
  termId: string;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const mappings = useApi<TabMapping[]>(`/admin/sources/${sourceId}/mappings`);
  const classes = useApi<TermClasses>(`/admin/terms/${termId}/classes`);
  const programs = classes.data?.programs.map((p) => p.code) ?? [];
  const detect = useApiMutation(
    () => apiFetch<Detection>(`/admin/sources/${sourceId}/detect`, { method: 'POST' }),
    { invalidate: [`/admin/sources/${sourceId}`] },
  );
  const { mutate: runDetect } = detect;
  // A sheet just connected here is read once, automatically; never on a later visit or reload.
  useEffect(() => {
    if (!readOnly && takeAutoDetect(sourceId)) runDetect(undefined);
  }, [readOnly, sourceId, runDetect]);
  const detectedByTab = new Map(detect.data?.tabs.map((t) => [t.tabName, t.detected]));
  const suggestionByTab = new Map(detect.data?.tabs.map((t) => [t.tabName, t.audienceSuggestion]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Reads the workbook and lists each subject tab. Check the columns and weights, then confirm
          each tab. Sync imports confirmed tabs only.
        </p>
        <Button
          variant="outline"
          onClick={() => detect.mutate(undefined)}
          disabled={detect.isPending || readOnly}
        >
          <ScanSearch aria-hidden />
          {detect.isPending ? 'Reading the workbook…' : 'Detect tabs'}
        </Button>
      </div>
      {detect.isPending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Reading the tabs of this sheet…
        </p>
      ) : null}
      {detect.error && !detect.isPending ? (
        <DetectError error={detect.error} onRetry={() => detect.mutate(undefined)} />
      ) : null}
      {detect.data && !detect.isPending ? (
        <div className="space-y-3">
          <Alert variant={detect.data.fatal ? 'destructive' : 'default'}>
            {detect.data.fatal ? <TriangleAlert aria-hidden /> : <CheckCircle2 aria-hidden />}
            <AlertTitle>
              {detect.data.fatal
                ? 'This workbook cannot be synced yet'
                : `${detect.data.rosterStudents} students found in "${detect.data.rosterTab}"`}
            </AlertTitle>
            <AlertDescription>
              {detect.data.fatal
                ? 'Fix the file-level errors below, then detect again.'
                : `${detect.data.tabs.length} subject tabs read. Nothing was imported.`}
            </AlertDescription>
          </Alert>
          {detect.data.issues.length ? (
            // A new detection remounts the list, which starts again on page 1.
            <DetectionIssues key={detect.submittedAt} issues={detect.data.issues} />
          ) : null}
          {detect.data.issuesTruncated ? (
            <p className="text-xs text-muted-foreground">Only the first 500 issues are listed.</p>
          ) : null}
          <DetectionChanges
            key={detect.submittedAt}
            changes={detect.data.changes}
            programs={programs.length}
          />
        </div>
      ) : null}

      {mappings.error ? (
        <ErrorState error={mappings.error} onRetry={() => mappings.refetch()} />
      ) : !mappings.data ? (
        <LoadingRows rows={3} />
      ) : mappings.data.length === 0 ? (
        <EmptyState title="No tabs yet" description="Choose “Detect tabs” to read the workbook." />
      ) : (
        <ul className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
          {mappings.data.map((tab) => {
            const expanded = open === tab.id;
            const Icon = expanded ? ChevronDown : ChevronRight;
            return (
              <li key={tab.id} className="border-b last:border-b-0">
                <button
                  type="button"
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted/40"
                  onClick={() => setOpen(expanded ? null : tab.id)}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-medium">{tab.tabName}</span>
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {tab.columns.filter((c) => c.role === 'CRITERION').length} mark columns
                  </span>
                  <StatusPill tone={STATUS[tab.status].tone}>{STATUS[tab.status].label}</StatusPill>
                </button>
                {expanded ? (
                  <TabReview
                    key={`${tab.id}:${tab.status}:${tab.version}:${tab.columns.length}:${tab.audience}`}
                    sourceId={sourceId}
                    tab={tab}
                    detected={detectedByTab.get(tab.tabName)}
                    audienceSuggestion={suggestionByTab.get(tab.tabName)}
                    readOnly={readOnly}
                    programs={programs}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
