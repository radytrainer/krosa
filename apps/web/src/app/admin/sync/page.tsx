'use client';

import { RefreshCw } from 'lucide-react';
import { Suspense, useState } from 'react';
import { SyncJobsTable } from '@/components/admin/sync-jobs-table';
import { useStartSync } from '@/components/admin/use-start-sync';
import { useUrlState } from '@/components/admin/use-url-state';
import { Field, NativeSelect } from '@/components/app/form';
import { PageHeader, Section } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
import { isActiveJob } from '@/components/app/status';
import { EmptyState, ErrorState, LoadingRows, PageLoading } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { humanize } from '@/lib/format';
import { qs, useApi } from '@/lib/query';
import type { Generation, Paginated, SyncJob, SyncStatus } from '@/lib/types';

const STATUSES: SyncStatus[] = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'SUCCEEDED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
];

function StartSyncCard({ generations }: { generations: Generation[] }) {
  const active = generations.filter((g) => g.status === 'ACTIVE');
  const [target, setTarget] = useState('ALL');
  const startSync = useStartSync();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Start a synchronization</CardTitle>
        <CardDescription>
          Reads every active spreadsheet of the target and imports students, courses and marks. To
          sync a single spreadsheet, open its source page.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Target" className="sm:w-72">
          {(p) => (
            <NativeSelect {...p} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="ALL">All active generations</option>
              {active.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.code} · {g.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Button
          disabled={startSync.isPending}
          onClick={() =>
            startSync.mutate(
              target === 'ALL' ? { scope: 'ALL' } : { scope: 'GENERATION', generationId: target },
            )
          }
        >
          <RefreshCw aria-hidden className={startSync.isPending ? 'animate-spin' : undefined} />
          Start sync
        </Button>
      </CardContent>
    </Card>
  );
}

function SyncCenter() {
  const { values, page, set } = useUrlState([
    'status',
    'scope',
    'generationId',
    'includeChildren',
  ] as const);
  const generations = useApi<Paginated<Generation>>('/admin/generations?pageSize=100');
  const jobs = useApi<Paginated<SyncJob>>(`/admin/sync${qs({ ...values, page, pageSize: 25 })}`, {
    keepPrevious: true,
    // Poll while anything on screen is still queued or running.
    refetchInterval: (q) => (q.state.data?.data.some((j) => isActiveJob(j.status)) ? 3000 : false),
  });

  return (
    <>
      <PageHeader
        title="Sync center"
        description="Imports from Google Sheets: start a run, follow progress and inspect problems."
      />
      <div className="space-y-8">
        <StartSyncCard generations={generations.data?.data ?? []} />
        <Section title="Jobs">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[12rem_10rem_12rem_auto]">
            <NativeSelect
              aria-label="Status"
              value={values.status}
              onChange={(e) => set({ status: e.target.value })}
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="Scope"
              value={values.scope}
              onChange={(e) => set({ scope: e.target.value })}
            >
              <option value="">All scopes</option>
              <option value="SOURCE">One source</option>
              <option value="GENERATION">Generation</option>
              <option value="ALL">All</option>
            </NativeSelect>
            <NativeSelect
              aria-label="Generation"
              value={values.generationId}
              onChange={(e) => set({ generationId: e.target.value })}
            >
              <option value="">All generations</option>
              {generations.data?.data.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.code}
                </option>
              ))}
            </NativeSelect>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.includeChildren === 'true'}
                onChange={(e) => set({ includeChildren: e.target.checked ? 'true' : null })}
              />
              Show per-source child jobs
            </label>
          </div>
          {jobs.error ? (
            <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />
          ) : !jobs.data ? (
            <LoadingRows />
          ) : jobs.data.data.length === 0 ? (
            <EmptyState
              title="No jobs found"
              description="Start a sync above, or change the filters."
            />
          ) : (
            <>
              <SyncJobsTable jobs={jobs.data.data} />
              <Pagination {...jobs.data.meta} onPage={(p) => set({ page: p })} />
            </>
          )}
        </Section>
      </div>
    </>
  );
}

export default function SyncCenterPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <SyncCenter />
    </Suspense>
  );
}
