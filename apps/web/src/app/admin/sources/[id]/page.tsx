'use client';

import { CheckCircle2, ExternalLink, Eye, Pencil, Power, RefreshCw, XCircle } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { IssuesTable } from '@/components/admin/issues-table';
import { SyncJobsTable } from '@/components/admin/sync-jobs-table';
import { useStartSync } from '@/components/admin/use-start-sync';
import { Confirm } from '@/components/app/confirm';
import { Field, fieldErrors, onSubmit } from '@/components/app/form';
import { PageHeader, Section } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
import { ActivePill, StatusPill } from '@/components/app/status';
import { EmptyState, ErrorState, LoadingRows, PageLoading } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
import type { Paginated, Source, SourcePreview, SyncJob } from '@/lib/types';

function RenameDialog({ source }: { source: Source }) {
  const [open, setOpen] = useState(false);
  const update = useApiMutation(
    (label: string) => apiFetch(`/admin/sources/${source.id}`, json({ label }, 'PATCH')),
    {
      success: 'Label updated.',
      invalidate: ['/admin/sources', '/admin/generations'],
      onSuccess: () => setOpen(false),
    },
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        <Pencil aria-hidden />
        Rename
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={onSubmit((d) => update.mutate(String(d.get('label')).trim()))}
        >
          <DialogHeader>
            <DialogTitle>Rename source</DialogTitle>
          </DialogHeader>
          <Field label="Label" required error={fieldErrors(update.error).label}>
            {(p) => (
              <Input {...p} name="label" defaultValue={source.label} maxLength={120} autoFocus />
            )}
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PreviewResult({ preview }: { preview: SourcePreview }) {
  const { stats } = preview;
  return (
    <div className="space-y-4">
      {preview.fatal ? (
        <Alert variant="destructive">
          <XCircle aria-hidden />
          <AlertTitle>A sync would fail</AlertTitle>
          <AlertDescription>
            Fix the file-level errors below; nothing would be imported.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <CheckCircle2 aria-hidden />
          <AlertTitle>Ready to sync</AlertTitle>
          <AlertDescription>
            {stats.errors
              ? `${stats.errors} rows or cells would be rejected; everything else would be imported.`
              : 'No errors found. This was a dry run: nothing was written.'}
          </AlertDescription>
        </Alert>
      )}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Students', stats.students],
          ['Courses', `${stats.coursesWithValidScheme}/${stats.courses} with valid scheme`],
          ['Marks', `${stats.marks} (${stats.blankMarks} blank)`],
          ['Issues', `${stats.errors} errors · ${stats.warnings} warnings`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-muted/50 p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-sm font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {preview.courses.length ? (
        <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Course</TableHead>
                <TableHead>Term</TableHead>
                <TableHead className="hidden sm:table-cell">Criteria</TableHead>
                <TableHead className="hidden sm:table-cell">Rows</TableHead>
                <TableHead>Scheme</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.courses.map((c) => (
                <TableRow key={c.courseKey}>
                  <TableCell>
                    <span className="font-medium">{c.title}</span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {c.courseKey}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums">{c.termNumber}</TableCell>
                  <TableCell className="hidden tabular-nums sm:table-cell">{c.criteria}</TableCell>
                  <TableCell className="hidden tabular-nums sm:table-cell">{c.rows}</TableCell>
                  <TableCell>
                    <StatusPill tone={c.schemeValid ? 'success' : 'warning'}>
                      {c.schemeValid ? 'Valid' : 'Needs fixing'}
                    </StatusPill>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {preview.issues.length ? (
        <>
          <IssuesTable issues={preview.issues} />
          {preview.issuesTruncated ? (
            <p className="text-xs text-muted-foreground">Only the first 500 issues are shown.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export default function SourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [page, setPage] = useState(1);
  const { data: s, error, isPending, refetch } = useApi<Source>(`/admin/sources/${id}`);
  const history = useApi<Paginated<SyncJob>>(
    `/admin/sources/${id}/sync-history${qs({ page, pageSize: 10 })}`,
    {
      keepPrevious: true,
    },
  );
  const startSync = useStartSync();
  const preview = useApiMutation(() =>
    apiFetch<SourcePreview>(`/admin/sources/${id}/preview`, { method: 'POST' }),
  );
  const setStatus = useApiMutation(
    (status: 'ACTIVE' | 'DISABLED') => apiFetch(`/admin/sources/${id}`, json({ status }, 'PATCH')),
    {
      success: 'Source updated.',
      invalidate: ['/admin/sources', '/admin/generations', '/admin/dashboard'],
    },
  );

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isPending) return <PageLoading />;
  const active = s.status === 'ACTIVE';

  return (
    <>
      <PageHeader
        back={{ href: `/admin/generations/${s.generation.id}#sources`, label: s.generation.name }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {s.label}
            <ActivePill active={active} />
          </span>
        }
        description={s.spreadsheetTitle ?? s.spreadsheetId}
        actions={
          <>
            <a
              href={s.spreadsheetUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={buttonVariants({ variant: 'ghost' })}
            >
              <ExternalLink aria-hidden />
              Open sheet<span className="sr-only"> (opens in a new tab)</span>
            </a>
            <RenameDialog source={s} />
            {active ? (
              <Confirm
                trigger={
                  <Button variant="outline">
                    <Power aria-hidden />
                    Disable
                  </Button>
                }
                title="Disable this source?"
                description="Syncs will skip it. Data already imported stays as it is."
                confirmLabel="Disable source"
                destructive
                onConfirm={() => setStatus.mutateAsync('DISABLED')}
              />
            ) : (
              <Button variant="outline" onClick={() => setStatus.mutate('ACTIVE')}>
                <Power aria-hidden />
                Enable
              </Button>
            )}
            <Button
              disabled={!active || startSync.isPending}
              onClick={() => startSync.mutate({ scope: 'SOURCE', sourceId: s.id })}
            >
              <RefreshCw aria-hidden />
              Sync now
            </Button>
          </>
        }
      />

      <div className="space-y-8">
        <Card size="sm">
          <CardContent>
            <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Generation</dt>
                <dd className="font-medium">{s.generation.code}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Offerings owned</dt>
                <dd className="font-medium tabular-nums">{s.ownedOfferings}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Last successful sync</dt>
                <dd className="font-medium">{formatDateTime(s.lastSyncedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Connected</dt>
                <dd className="font-medium">
                  {formatDateTime(s.createdAt)} by {s.createdBy.username}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Section
          title="Preview"
          description="Reads and validates the whole spreadsheet exactly like a sync, without writing anything."
          actions={
            <Button
              variant="outline"
              onClick={() => preview.mutate(undefined)}
              disabled={preview.isPending}
            >
              <Eye aria-hidden />
              {preview.isPending
                ? 'Reading the spreadsheet…'
                : preview.data
                  ? 'Run again'
                  : 'Run preview'}
            </Button>
          }
        >
          {preview.isPending ? (
            <LoadingRows rows={3} label="Reading the spreadsheet" />
          ) : preview.data ? (
            <PreviewResult preview={preview.data} />
          ) : preview.error ? (
            <ErrorState error={preview.error} />
          ) : null}
        </Section>

        <Section title="Sync history">
          {history.error ? (
            <ErrorState error={history.error} onRetry={() => history.refetch()} />
          ) : !history.data ? (
            <LoadingRows rows={3} />
          ) : history.data.data.length === 0 ? (
            <EmptyState title="Never synchronized" description="Run a preview, then “Sync now”." />
          ) : (
            <>
              <SyncJobsTable jobs={history.data.data} showTarget={false} />
              <Pagination {...history.data.meta} onPage={setPage} />
            </>
          )}
        </Section>
      </div>
    </>
  );
}
