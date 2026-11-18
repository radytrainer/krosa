'use client';

import { KeyRound, RotateCcw, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { ISSUES_PAGE_SIZE, IssueFilters, PagedIssues } from '@/components/admin/paged-issues';
import { PerSourceJobs } from '@/components/admin/source-release';
import { jobTarget } from '@/components/admin/sync-jobs-table';
import { NativeSelect } from '@/components/app/form';
import { PageHeader, Section } from '@/components/app/page-header';
import { Confirm } from '@/components/app/confirm';
import { SyncStatusPill, isActiveJob } from '@/components/app/status';
import {
  PageSkeleton,
  STILL_WORKING_MS,
  STILL_WORKING_TEXT,
  Spinner,
  useElapsed,
  useLoading,
} from '@/components/app/loading';
import { EmptyState, ErrorState, LoadingRows, errorMessage } from '@/components/app/states';
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
import { apiDownload, apiFetch, saveBlob } from '@/lib/api';
import { useRefreshOnJobFinish } from '@/components/admin/use-refresh-on-job-finish';
import { formatDateTime, formatDuration, humanize } from '@/lib/format';
import { json, qs, useApi, useApiMutation } from '@/lib/query';
import type { SyncErrorPage, SyncJobDetail } from '@/lib/types';

const PHASES: Record<string, string> = {
  FETCH: 'Reading the spreadsheet',
  APPLY: 'Importing courses and marks',
  WAITING_RETRY: 'Waiting to retry after a Google error',
};

/** `counts` as a table: one row per entity, one column per outcome. */
function CountsTable({ counts }: { counts: SyncJobDetail['counts'] }) {
  const entries = Object.entries(counts ?? {}).filter(
    (e): e is [string, Record<string, number>] =>
      // newStudents holds ids, not counts: it has its own button below.
      e[0] !== 'newStudents' && typeof e[1] === 'object' && e[1] !== null,
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

/** The API issues at most 500 passwords per file. */
const ISSUE_BATCH = 500;
const BOM = String.fromCharCode(0xfeff);

/**
 * Issues the passwords in batches of 500 and joins the CSVs into one (one header row). Passwords
 * stay in memory only until the file is saved. If a later batch fails, the passwords already
 * issued are still saved, so none is lost.
 */
async function issueInBatches(
  ids: string[],
): Promise<{ csv: string | null; filename: string; issued: number; error: unknown }> {
  let header: string | null = null;
  const rows: string[] = [];
  let issued = 0;
  let filename = 'credentials.csv';
  const file = () => (header ? `${BOM}${header}\r\n${rows.join('')}` : null);
  for (let i = 0; i < ids.length; i += ISSUE_BATCH) {
    try {
      const res = await apiDownload(
        '/admin/students/issue-credentials',
        json({ studentIds: ids.slice(i, i + ISSUE_BATCH), onlyPending: true }),
      );
      const count = Number(res.headers.get('X-Issued-Count') ?? 0);
      if (count === 0) continue;
      issued += count;
      filename = res.filename;
      const text = await res.blob.text();
      const csv = text.startsWith(BOM) ? text.slice(1) : text;
      const cut = csv.indexOf('\r\n');
      header ??= csv.slice(0, cut);
      const body = csv.slice(cut + 2);
      if (body) rows.push(body.endsWith('\r\n') ? body : `${body}\r\n`);
    } catch (error) {
      return { csv: file(), filename, issued, error };
    }
  }
  return { csv: file(), filename, issued, error: null };
}

/**
 * "Issue passwords for N new students": the students this job created, through the usual
 * temporary-password CSV (only accounts still waiting for one), one file however many there are.
 * The file is the only copy.
 */
function IssueNewStudentPasswords({ ids }: { ids: string[] }) {
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const count = ids.length;
  const label = `Issue passwords for ${count} new ${count === 1 ? 'student' : 'students'}`;
  if (issued !== null) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {issued} temporary {issued === 1 ? 'password' : 'passwords'} issued. The file is the only
        copy: distribute it securely, then delete it.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <Confirm
        trigger={
          <Button>
            <KeyRound aria-hidden />
            {label}
          </Button>
        }
        title={`${label}?`}
        description={`Downloads one CSV with a temporary password for each of the ${count} students this sync created, if they still have none. Passwords are shown only in this file, expire in 14 days, and must be changed at first sign-in.`}
        confirmLabel="Download passwords"
        onConfirm={async () => {
          setError(null);
          const result = await issueInBatches(ids);
          if (result.csv) {
            saveBlob(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }), result.filename);
            toast.success(
              `Issued ${result.issued} temporary passwords. Distribute the file securely, then delete it.`,
            );
            await queryClient.invalidateQueries({ queryKey: ['/admin'] });
          }
          if (result.error) {
            setError(
              `${result.issued ? `${result.issued} passwords were issued and saved. ` : ''}The rest could not be issued: ${errorMessage(result.error)} Try again for the others.`,
            );
          } else if (result.issued === 0) {
            setError('These students already have passwords. Nothing was issued.');
          } else {
            setIssued(result.issued);
          }
        }}
      />
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
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

/** A job still QUEUED this long after it was queued has no worker taking it. */
const NO_WORKER_MS = 60_000;

/** True once `job` has been QUEUED for more than NO_WORKER_MS (measured from `queuedAt`). */
function useQueuedTooLong(job: SyncJobDetail | undefined): boolean {
  const queued = job?.status === 'QUEUED';
  const queuedAt = job?.queuedAt;
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!queued || !queuedAt) {
      const timer = setTimeout(() => setLate(false), 0);
      return () => clearTimeout(timer);
    }
    const left = NO_WORKER_MS - (Date.now() - new Date(queuedAt).getTime());
    const timer = setTimeout(() => setLate(true), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [queued, queuedAt]);
  return queued && late;
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

  const loading = useLoading(isPending);
  const running = job !== undefined && isActiveJob(job.status);
  const slow = useElapsed(running, STILL_WORKING_MS);
  const noWorker = useQueuedTooLong(job);

  if (loading || isPending) return <PageSkeleton columns={5} />;
  // The first read failed. (A failed poll keeps the job on screen; see below.)
  if (!job) return <ErrorState error={error} onRetry={() => refetch()} />;
  const active = isActiveJob(job.status);
  const pct = job.progress.total
    ? Math.round((job.progress.current / job.progress.total) * 100)
    : 0;
  const retryable = job.status === 'FAILED' || job.status === 'SUCCEEDED_WITH_ERRORS';
  const newStudentIds = active ? [] : (job.counts?.newStudents?.ids ?? []);

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
              {retry.isPending ? <Spinner /> : <RotateCcw aria-hidden />}
              Retry
            </Button>
          ) : null
        }
      />

      <div className="space-y-8">
        {error ? (
          <Alert variant="destructive">
            <XCircle aria-hidden />
            <AlertTitle>Could not read the latest status of this job</AlertTitle>
            <AlertDescription>
              <p>{errorMessage(error)} The job itself is not affected.</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>
                Reload status
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {active ? (
          <Card>
            <CardContent className="space-y-2" aria-live="polite" aria-busy="true">
              <div className="flex justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <Spinner />
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
              {noWorker ? (
                <div className="flex flex-wrap items-center gap-2 text-sm text-warning">
                  <span>
                    No worker has picked this up yet. Check that the worker is running.
                  </span>
                  <Button variant="outline" size="sm" onClick={() => refetch()}>
                    Refresh
                  </Button>
                </div>
              ) : slow ? (
                <p className="text-sm text-muted-foreground">{STILL_WORKING_TEXT}</p>
              ) : null}
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

        {newStudentIds.length ? (
          <Section
            title="New students"
            description="This sync created accounts without a password. Students cannot sign in until they get one."
          >
            <IssueNewStudentPasswords ids={newStudentIds} />
          </Section>
        ) : null}

        <JobIssues job={job} active={active} />
      </div>
    </>
  );
}
