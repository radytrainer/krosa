'use client';

import { RefreshCw } from 'lucide-react';
import { Suspense, useState } from 'react';
import { SyncJobsTable } from '@/components/admin/sync-jobs-table';
import { useStartSync } from '@/components/admin/use-start-sync';
import { useUrlState } from '@/components/admin/use-url-state';
import { WorkbooksByTerm } from '@/components/admin/workbooks-by-term';
import { Field, NativeSelect } from '@/components/app/form';
import { PageHeader, Section } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
import { isActiveJob } from '@/components/app/status';
import { EmptyState, ErrorState, LoadingRows, PageLoading } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { humanize } from '@/lib/format';
import { qs, useApi } from '@/lib/query';
import type { Generation, Paginated, SyncJob, SyncStatus, SyncTargetOption } from '@/lib/types';

const STATUSES: SyncStatus[] = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'SUCCEEDED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
];

const ALL = 'ALL';

function StartSyncCard() {
  const targets = useApi<SyncTargetOption[]>('/admin/sync/targets');
  const [generationId, setGenerationId] = useState(ALL);
  const [term, setTerm] = useState(ALL);
  const startSync = useStartSync();
  const generations = targets.data ?? [];
  const selected = generations.find((g) => g.id === generationId);
  // With every generation selected, a term means that term number in each of them.
  const termOptions = selected
    ? selected.terms.map((t) => ({ value: t.id, label: t.name }))
    : [...new Set(generations.flatMap((g) => g.terms.map((t) => t.number)))]
        .toSorted((a, b) => a - b)
        .map((n) => ({ value: String(n), label: `Term ${n}` }));

  const start = () => {
    if (selected) {
      startSync.mutate(
        term === ALL
          ? { scope: 'GENERATION', generationId: selected.id }
          : { scope: 'TERM', generationId: selected.id, termId: term },
      );
    } else {
      startSync.mutate(
        term === ALL ? { scope: 'ALL' } : { scope: 'ALL', termNumber: Number(term) },
      );
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start a synchronization</CardTitle>
        <CardDescription>
          Reads the confirmed tabs of each matching workbook and imports students and marks.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Generation" required className="sm:w-64">
          {(p) => (
            <NativeSelect
              {...p}
              value={generationId}
              onChange={(e) => {
                setGenerationId(e.target.value);
                setTerm(ALL);
              }}
            >
              <option value={ALL}>All active generations</option>
              {generations.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Term" required className="sm:w-48">
          {(p) => (
            <NativeSelect {...p} value={term} onChange={(e) => setTerm(e.target.value)}>
              <option value={ALL}>All terms</option>
              {termOptions.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Button disabled={startSync.isPending || !targets.data} onClick={start}>
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
        <StartSyncCard />
        <Section
          title="Workbooks by term"
          description="The sheet feeding each term's scores. To replace or remove it, edit the term on its generation page. Students are affected only after a new sheet is reviewed and synced."
        >
          <WorkbooksByTerm />
        </Section>
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
