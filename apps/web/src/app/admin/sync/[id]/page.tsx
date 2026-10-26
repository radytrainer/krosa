'use client';

import { RotateCcw, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { IssuesTable } from '@/components/admin/issues-table';
import { SyncJobsTable, jobTarget } from '@/components/admin/sync-jobs-table';
import { NativeSelect } from '@/components/app/form';
import { PageHeader, Section } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
import { SyncStatusPill, isActiveJob } from '@/components/app/status';
import { EmptyState, ErrorState, LoadingRows, PageLoading } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api';
import { formatDateTime, formatDuration, humanize } from '@/lib/format';
import { qs, useApi, useApiMutation } from '@/lib/query';
import type { Paginated, SyncError, SyncJobDetail } from '@/lib/types';

const PHASES: Record<string, string> = {
  FETCH: 'Reading the spreadsheet',
  APPLY: 'Importing courses and marks',
  WAITING_RETRY: 'Waiting to retry after a Google error',
};

/** `counts` as a table: one row per entity, one column per outcome. */
function CountsTable({ counts }: { counts: SyncJobDetail['counts'] }) {
  const entries = Object.entries(counts ?? {}).filter(
    (e): e is [string, Record<string, number>] => typeof e[1] === 'object' && e[1] !== null,
  );
  if (!entries.length) return null;
  const columns = [...new Set(entries.flatMap(([, v]) => Object.keys(v)))];
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Entity</TableHead>
            {columns.map((c) => (
              <TableHead key={c} className="text-right">
                {humanize(c.replace(/([a-z])([A-Z])/g, '$1_$2'))}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([entity, values]) => (
            <TableRow key={entity}>
              <TableCell className="font-medium">{humanize(entity)}</TableCell>
              {columns.map((c) => (
                <TableCell key={c} className="text-right tabular-nums">
                  {values[c] ?? '—'}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function JobIssues({ jobId, active }: { jobId: string; active: boolean }) {
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);
  const errors = useApi<Paginated<SyncError>>(
    `/admin/sync/${jobId}/errors${qs({ severity, page, pageSize: 50 })}`,
    {
      keepPrevious: true,
      refetchInterval: active ? 5000 : false,
    },
  );
  return (
    <Section
      title="Issues"
      description="Rejected rows and cells, and warnings, with their location in the spreadsheet."
      actions={
        <NativeSelect
          aria-label="Severity"
          className="w-40"
          value={severity}
          onChange={(e) => {
            setSeverity(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Errors and warnings</option>
          <option value="ERROR">Errors only</option>
          <option value="WARNING">Warnings only</option>
        </NativeSelect>
      }
    >
      {errors.error ? (
        <ErrorState error={errors.error} onRetry={() => errors.refetch()} />
      ) : !errors.data ? (
        <LoadingRows rows={3} />
      ) : errors.data.data.length === 0 ? (
        <EmptyState
          title="No issues"
          description={active ? 'Nothing reported so far.' : 'Everything in the file was accepted.'}
        />
      ) : (
        <>
          <IssuesTable issues={errors.data.data} />
          <Pagination {...errors.data.meta} onPage={setPage} />
        </>
      )}
    </Section>
  );
}

export default function SyncJobPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const {
    data: job,
    error,
    isPending,
    refetch,
  } = useApi<SyncJobDetail>(`/admin/sync/${id}`, {
    refetchInterval: (q) => (q.state.data && isActiveJob(q.state.data.status) ? 2000 : false),
  });
  const retry = useApiMutation(
    () => apiFetch<{ jobId: string }>(`/admin/sync/${id}/retry`, { method: 'POST' }),
    {
      success: 'Retry queued.',
      invalidate: ['/admin/sync', '/admin/dashboard'],
      onSuccess: ({ jobId }) => router.push(`/admin/sync/${jobId}`),
    },
  );

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isPending) return <PageLoading />;
  const active = isActiveJob(job.status);
  const pct = job.progress.total
    ? Math.round((job.progress.current / job.progress.total) * 100)
    : 0;
  const retryable = job.status === 'FAILED' || job.status === 'SUCCEEDED_WITH_ERRORS';

  return (
    <>
      <PageHeader
        back={
          job.parentId
            ? { href: `/admin/sync/${job.parentId}`, label: 'Parent job' }
            : { href: '/admin/sync', label: 'Sync center' }
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {jobTarget(job)}
            <SyncStatusPill status={job.status} />
          </span>
        }
        description={`Requested ${formatDateTime(job.queuedAt)} by ${job.requestedBy.username}`}
        actions={
          retryable ? (
            <Button onClick={() => retry.mutate(undefined)} disabled={retry.isPending}>
              <RotateCcw aria-hidden />
              Retry
            </Button>
          ) : null
        }
      />

      <div className="space-y-8">
        {active ? (
          <Card>
            <CardContent className="space-y-2" aria-live="polite">
              <div className="flex justify-between text-sm">
                <span className="font-medium">
                  {job.status === 'QUEUED'
                    ? 'Waiting for a worker'
                    : (job.phase && PHASES[job.phase]) || 'Running'}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {job.progress.total
                    ? `${job.progress.current} of ${job.progress.total} steps`
                    : ''}
                </span>
              </div>
              <Progress value={job.status === 'QUEUED' ? null : pct} aria-label="Sync progress" />
            </CardContent>
          </Card>
        ) : null}

        {job.failureCode ? (
          <Alert variant="destructive">
            <XCircle aria-hidden />
            <AlertTitle>{humanize(job.failureCode)}</AlertTitle>
            <AlertDescription>
              {job.failureMessage ?? 'The job failed.'}
              {job.status === 'FAILED' ? ' Nothing from this run was applied.' : ''}
            </AlertDescription>
          </Alert>
        ) : null}

        <Card size="sm">
          <CardContent>
            <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Scope</dt>
                <dd className="font-medium">
                  {job.scope === 'SOURCE' && job.source ? (
                    <Link href={`/admin/sources/${job.source.id}`} className="underline">
                      {job.source.label}
                    </Link>
                  ) : (
                    humanize(job.scope)
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Started</dt>
                <dd className="font-medium">{formatDateTime(job.startedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Duration</dt>
                <dd className="font-medium tabular-nums">
                  {formatDuration(job.startedAt, job.finishedAt)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Issues</dt>
                <dd className="font-medium tabular-nums">
                  {job.errorCount} errors · {job.warningCount} warnings
                </dd>
              </div>
            </dl>
            {job.retryOfId ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Retry of{' '}
                <Link href={`/admin/sync/${job.retryOfId}`} className="underline">
                  an earlier job
                </Link>
                .
              </p>
            ) : null}
          </CardContent>
        </Card>

        {job.children.length ? (
          <Section
            title="Per-source jobs"
            description="A generation or full sync runs one job per spreadsheet."
          >
            <SyncJobsTable jobs={job.children} />
          </Section>
        ) : null}

        {job.counts && Object.keys(job.counts).length ? (
          <Section title="What changed">
            <CountsTable counts={job.counts} />
          </Section>
        ) : null}

        <JobIssues jobId={job.id} active={active} />
      </div>
    </>
  );
}
