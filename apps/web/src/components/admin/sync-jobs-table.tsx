import Link from 'next/link';
import { SyncStatusPill } from '@/components/app/status';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime, formatDuration, humanize } from '@/lib/format';
import type { SyncJob } from '@/lib/types';

export function jobTarget(job: SyncJob): string {
  if (job.scope === 'SOURCE') return job.source?.label ?? 'Source';
  if (job.scope === 'GENERATION')
    return job.generation ? `${job.generation.code} (all sources)` : 'Generation';
  return 'All generations';
}

export function SyncJobsTable({
  jobs,
  showTarget = true,
}: {
  jobs: SyncJob[];
  showTarget?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            {showTarget ? <TableHead>Target</TableHead> : null}
            <TableHead className="hidden md:table-cell">Issues</TableHead>
            <TableHead className="hidden sm:table-cell">Requested</TableHead>
            <TableHead className="hidden lg:table-cell">Duration</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Details</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <TableRow key={job.id}>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <SyncStatusPill status={job.status} />
                  {job.status === 'RUNNING' && job.progress.total > 0 ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {job.phase ? `${humanize(job.phase)} · ` : ''}
                      {job.progress.current}/{job.progress.total}
                    </span>
                  ) : null}
                  {job.failureCode ? (
                    <span className="font-mono text-xs text-destructive">{job.failureCode}</span>
                  ) : null}
                </div>
              </TableCell>
              {showTarget ? (
                <TableCell className="max-w-56 truncate">{jobTarget(job)}</TableCell>
              ) : null}
              <TableCell className="hidden tabular-nums md:table-cell">
                <span className={job.errorCount ? 'text-destructive' : undefined}>
                  {job.errorCount} errors
                </span>
                <span className="text-muted-foreground"> · {job.warningCount} warnings</span>
              </TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">
                {formatDateTime(job.queuedAt)}
                <span className="block text-xs">by {job.requestedBy.username}</span>
              </TableCell>
              <TableCell className="hidden tabular-nums lg:table-cell">
                {formatDuration(job.startedAt, job.finishedAt)}
              </TableCell>
              <TableCell className="text-right">
                <Link
                  href={`/admin/sync/${job.id}`}
                  className="text-sm font-medium underline-offset-4 hover:underline"
                >
                  View<span className="sr-only"> sync job from {formatDateTime(job.queuedAt)}</span>
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
