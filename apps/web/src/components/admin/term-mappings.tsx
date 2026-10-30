'use client';

import { CheckCircle2, ChevronDown, ChevronRight, ScanSearch, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { IssuesTable } from '@/components/admin/issues-table';
import { StatusPill } from '@/components/app/status';
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
import { apiFetch } from '@/lib/api';
import { json, useApi, useApiMutation } from '@/lib/query';
import type { ColumnMapping, ColumnRole, DetectedTab, Detection, TabMapping } from '@/lib/types';

const ROLES: { value: ColumnRole; label: string }[] = [
  { value: 'CRITERION', label: 'Marks' },
  { value: 'STUDENT_ID', label: 'Student ID' },
  { value: 'FIRST_NAME', label: 'First name' },
  { value: 'LAST_NAME', label: 'Last name' },
  { value: 'FULL_NAME', label: 'Full name' },
  { value: 'GENDER', label: 'Gender' },
  { value: 'CLASS', label: 'Class' },
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

function TabReview({
  sourceId,
  tab,
  detected,
  readOnly,
}: {
  sourceId: string;
  tab: TabMapping;
  detected: DetectedTab['detected'] | undefined;
  readOnly: boolean;
}) {
  const [subjectName, setSubjectName] = useState(tab.carriedFrom?.subject ?? tab.tabName);
  const [columns, setColumns] = useState(tab.columns);
  const invalidate = [`/admin/sources/${sourceId}`, '/admin/term-workbooks'];
  const base = `/admin/sources/${sourceId}/mappings/${tab.id}`;
  const confirm = useApiMutation(
    () =>
      apiFetch(
        `${base}/confirm`,
        json({
          subjectName,
          columns: columns.map((c) => ({
            columnIndex: c.columnIndex,
            role: c.role,
            ...(c.role === 'CRITERION'
              ? { name: c.proposedName ?? c.headerLabel ?? '', weight: c.proposedWeight ?? '' }
              : {}),
          })),
        }),
      ),
    { success: `Confirmed "${tab.tabName}".`, invalidate },
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
  const total = totalWeight(columns);
  const update = (index: number, patch: Partial<ColumnMapping>) =>
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
        <div className="max-w-sm space-y-1.5">
          <Label htmlFor={`subject-${tab.id}`}>Subject name</Label>
          <Input
            id={`subject-${tab.id}`}
            value={subjectName}
            maxLength={120}
            onChange={(e) => setSubjectName(e.target.value)}
          />
        </div>
      ) : null}
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
            {columns.map((c) => (
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
                  onClick={() => confirm.mutate(undefined)}
                  disabled={confirm.isPending || total !== 100 || !subjectName.trim()}
                >
                  <CheckCircle2 aria-hidden />
                  Confirm tab
                </Button>
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

export function TermMappings({ sourceId, readOnly }: { sourceId: string; readOnly: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const mappings = useApi<TabMapping[]>(`/admin/sources/${sourceId}/mappings`);
  const detect = useApiMutation(
    () => apiFetch<Detection>(`/admin/sources/${sourceId}/detect`, { method: 'POST' }),
    { invalidate: [`/admin/sources/${sourceId}`] },
  );
  const detectedByTab = new Map(detect.data?.tabs.map((t) => [t.tabName, t.detected]));

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
      {detect.error ? <ErrorState error={detect.error} /> : null}
      {detect.data ? (
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
          {detect.data.issues.length ? <IssuesTable issues={detect.data.issues} /> : null}
          {detect.data.issuesTruncated ? (
            <p className="text-xs text-muted-foreground">Only the first 500 issues are shown.</p>
          ) : null}
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
                    key={`${tab.id}:${tab.status}:${tab.version}:${tab.columns.length}`}
                    sourceId={sourceId}
                    tab={tab}
                    detected={detectedByTab.get(tab.tabName)}
                    readOnly={readOnly}
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
