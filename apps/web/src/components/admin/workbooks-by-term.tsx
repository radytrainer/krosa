'use client';

import Link from 'next/link';
import { StatusPill } from '@/components/app/status';
import { EmptyState, ErrorState, LoadingRows } from '@/components/app/states';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { useFreshApi } from '@/lib/query';
import type { TermWorkbooks } from '@/lib/types';

const PREVIEW_TEXT = {
  NONE: 'Not previewed',
  NOT_CONFIRMED: 'Preview not confirmed',
  CONFIRMED: 'Preview confirmed, ready to sync',
} as const;

/** Each term's active sheet, any sheet waiting to replace it, and how many came before. */
export function WorkbooksByTerm() {
  // Read fresh on every visit (never a cached "not synced yet"), and every 3 s while a sync runs,
  // so the row changes as soon as that sync promotes the new sheet.
  const { data, error, refetch } = useFreshApi<TermWorkbooks[]>('/admin/term-workbooks', {
    refetchInterval: (q) => (q.state.data?.some((r) => r.runningJobId) ? 3000 : false),
  });
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (!data) return <LoadingRows rows={3} />;
  const rows = data.filter((r) => r.active || r.pending || r.history.length > 0);
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No workbooks connected"
        description="Connect a workbook to a term from its generation page."
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Term</TableHead>
            <TableHead>Feeding student scores</TableHead>
            <TableHead>New sheet</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.term.id} className="align-top">
              <TableCell className="font-medium">
                <Link
                  href={`/admin/generations/${row.generation.id}#terms`}
                  className="hover:underline"
                >
                  {row.generation.name}, {row.term.name}
                </Link>
                {row.history.length ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {row.history.length} earlier {row.history.length === 1 ? 'sheet' : 'sheets'}
                  </span>
                ) : null}
              </TableCell>
              <TableCell>
                {row.active ? (
                  <Link href={`/admin/sources/${row.active.id}`} className="hover:underline">
                    {row.active.label}
                    <span className="block text-xs text-muted-foreground">
                      Last sync {formatDateTime(row.active.lastSyncedAt)}
                    </span>
                  </Link>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </TableCell>
              <TableCell>
                {row.pending ? (
                  <Link href={`/admin/sources/${row.pending.id}`} className="hover:underline">
                    <StatusPill tone="warning">New sheet connected, not synced yet</StatusPill>
                    <span className="mt-1 block">{row.pending.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {PREVIEW_TEXT[row.pending.previewState]}
                    </span>
                  </Link>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
