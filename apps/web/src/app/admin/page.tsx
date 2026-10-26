'use client';

import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CalendarRange,
  KeyRound,
  RefreshCw,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SyncJobsTable } from '@/components/admin/sync-jobs-table';
import { PageHeader, Section } from '@/components/app/page-header';
import { EmptyState, ErrorState, LoadingRows } from '@/components/app/states';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useApi } from '@/lib/query';
import type { Dashboard } from '@/lib/types';
import { cn } from '@/lib/utils';

function Stat({
  label,
  value,
  detail,
  href,
  icon,
  attention,
}: {
  label: string;
  value: number;
  detail: ReactNode;
  href: string;
  icon: ReactNode;
  attention?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <Card
        className={cn(
          'h-full transition-colors group-hover:bg-muted/40',
          attention && 'ring-warning/40',
        )}
      >
        <CardHeader>
          <CardDescription className="flex items-center gap-2">
            <span aria-hidden>{icon}</span>
            {label}
          </CardDescription>
          <CardTitle className="text-3xl font-semibold tabular-nums">{value}</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>
      </Card>
    </Link>
  );
}

export default function AdminDashboardPage() {
  const { data, error, isPending, refetch } = useApi<Dashboard>('/admin/dashboard', {
    refetchInterval: (q) => (q.state.data?.jobs.active ? 5000 : false),
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Overview of students, courses and synchronization."
        actions={
          <>
            <Link
              href="/admin/students?status=PENDING"
              className={buttonVariants({ variant: 'outline' })}
            >
              <KeyRound aria-hidden />
              Issue credentials
            </Link>
            <Link href="/admin/sync" className={buttonVariants()}>
              <RefreshCw aria-hidden />
              Sync center
            </Link>
          </>
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isPending ? (
        <LoadingRows rows={4} />
      ) : (
        <div className="space-y-8">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Students"
              value={data.students.total}
              href="/admin/students"
              icon={<Users className="size-4" />}
              attention={data.students.pending > 0}
              detail={
                <>
                  {data.students.active} active ·{' '}
                  <span className={data.students.pending ? 'font-medium text-warning' : undefined}>
                    {data.students.pending} awaiting credentials
                  </span>{' '}
                  · {data.students.disabled} disabled
                </>
              }
            />
            <Stat
              label="Generations"
              value={data.generations.active}
              href="/admin/generations"
              icon={<CalendarRange className="size-4" />}
              detail={`${data.generations.archived} archived · ${data.sources.active} active sheet sources`}
            />
            <Stat
              label="Course offerings"
              value={data.offerings.total}
              href="/admin/offerings"
              icon={<BookOpen className="size-4" />}
              attention={data.offerings.withoutPublishedScheme > 0}
              detail={
                <>
                  {data.offerings.visible} visible to students ·{' '}
                  <span
                    className={
                      data.offerings.withoutPublishedScheme ? 'font-medium text-warning' : undefined
                    }
                  >
                    {data.offerings.withoutPublishedScheme} without a published scheme
                  </span>
                </>
              }
            />
            <Stat
              label="Failed syncs"
              value={data.jobs.failedRecently}
              href="/admin/sync?status=FAILED"
              icon={<AlertTriangle className="size-4" />}
              attention={data.jobs.failedRecently > 0}
              detail={`Last ${data.jobs.failedWindowDays} days · ${data.jobs.active} running now`}
            />
          </div>

          <Section
            title="Recent synchronizations"
            actions={
              <Link href="/admin/sync" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                All jobs
                <ArrowRight aria-hidden />
              </Link>
            }
          >
            {data.recentJobs.length ? (
              <SyncJobsTable jobs={data.recentJobs} />
            ) : (
              <EmptyState
                title="No synchronizations yet"
                description="Connect a Google Sheet to a generation, then run a sync to import students and marks."
                action={
                  <Link
                    href="/admin/generations"
                    className={buttonVariants({ variant: 'outline' })}
                  >
                    Go to generations
                  </Link>
                }
              />
            )}
          </Section>
        </div>
      )}
    </>
  );
}
