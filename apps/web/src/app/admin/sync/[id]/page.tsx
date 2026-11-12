'use client';

import { RotateCcw, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ISSUES_PAGE_SIZE, IssueFilters, PagedIssues } from '@/components/admin/paged-issues';
import { PerSourceJobs } from '@/components/admin/source-release';
import { jobTarget } from '@/components/admin/sync-jobs-table';
import { NativeSelect } from '@/components/app/form';
import { PageHeader, Section } from '@/components/app/page-header';
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
import { useRefreshOnJobFinish } from '@/components/admin/use-refresh-on-job-finish';
import { formatDateTime, formatDuration, humanize } from '@/lib/format';
import { qs, useApi, useApiMutation } from '@/lib/query';
import type { SyncErrorPage, SyncJobDetail } from '@/lib/types';

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

function JobIssues({ job, active }: { job: SyncJobDetail; active: boolean }) {
  const [filters, setFilters] = useState({ severity: '', sheetTab: '', sourceId: '' });
  const [page, setPage] = useState(1);
  const filter = (next: typeof filters) => {
    setFilters(next);
    setPage(1);
  };
  const sources = job.children.flatMap((c) => (c.source ? [c.source] : []));
  const errors = useApi<SyncErrorPage>(
    `/admin/sync/${job.id}/errors${qs({ ...filters, page, pageSize: ISSUES_PAGE_SIZE })}`,
    {
      keepPrevious: true,
      refetchInterval: active ? 5000 : false,
    },
  );
  const { refetch } = errors;
  // A job saves its issues as it ends, often between two polls: read them once more.
  useEffect(() => {
    if (!active) void refetch();
  }, [active, refetch]);
  return (
    <Section
      title="Issues"
      description="Rejected rows and cells, and warnings, with their location in the spreadsheet."
      actions={
        <IssueFilters
          value={filters}
          tabs={errors.data?.tabs ?? []}
          onChange={(v) => filter({ ...filters, ...v })}
        >
          {sources.length > 1 ? (
            <NativeSelect
              aria-label="Workbook"
              className="w-48"
              value={filters.sourceId}
              onChange={(e) => filter({ ...filters, sourceId: e.target.value })}
            >
              <option value="">All workbooks</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.generation.name}, {s.term.name}
                </option>
              ))}
            </NativeSelect>
          ) : null}
        </IssueFilters>
      }
    >
      {errors.error ? (
        <ErrorState error={errors.error} onRetry={() => errors.refetch()} />
      ) : !errors.data ? (
        <LoadingRows rows={3} />
      ) : errors.data.data.length === 0 && errors.data.notListed === 0 ? (
        <EmptyState
          title="No issues"
          description={active ? 'Nothing reported so far.' : 'Nothing to show for these filters.'}
        />
      ) : (
        <>
          {errors.data.notListed > 0 ? (
            <p className="mb-3 text-sm text-muted-foreground">
              {errors.data.notListed.toLocaleString()} more issues are not listed: a job keeps only
              the first 20,000.
            </p>
          ) : null}
          <PagedIssues
            issues={errors.data.data}
            total={errors.data.meta.total}
            page={errors.data.meta.page}
            onPage={setPage}
            showWorkbook={sources.length > 1}
          />
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
  // Polls every 2 s while the job runs; the moment it finishes, every admin view is refreshed.
  useRefreshOnJobFinish(job ? [job] : null);
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
            <AlertDescription>{job.failureMessage ?? 'The job failed.'}</AlertDescription>
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
            description="A generation or full sync runs one job per spreadsheet. Hide or release each workbook's scores for students here; it acts on the whole term."
          >
            <PerSourceJobs jobs={job.children} />
          </Section>
        ) : null}

        {job.counts && Object.keys(job.counts).length ? (
          <Section title="What changed">
            <CountsTable counts={job.counts} />
          </Section>
        ) : null}

        <JobIssues job={job} active={active} />
      </div>
    </>
  );
}
