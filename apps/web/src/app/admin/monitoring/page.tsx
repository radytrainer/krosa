'use client';

import type { MonitoringGenerationOption, MonitoringSubjectRow } from '@ssrs/shared';
import { BookOpen, CalendarRange } from 'lucide-react';
import { Suspense } from 'react';
import { useUrlState } from '@/components/admin/use-url-state';
import { Field, NativeSelect } from '@/components/app/form';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState, ErrorState, LoadingRows, PageLoading } from '@/components/app/states';
import { useMonitoringGenerations, useTermSubjects } from '@/components/monitoring/api';
import { GenerationTermPicker } from '@/components/monitoring/generation-term-picker';
import { LevelLegend } from '@/components/monitoring/level-summary';
import { MonitoringError } from '@/components/monitoring/monitoring-error';
import { SubjectList } from '@/components/monitoring/subject-list';
import {
  ArchivedBadge,
  GradeScaleNotice,
  LastSyncLine,
  NotSyncedState,
  ReleaseBadge,
  isNeverSynced,
} from '@/components/monitoring/term-badges';
import { Checkbox } from '@/components/ui/checkbox';
import { qs } from '@/lib/query';

/** Without a choice in the URL: the first active generation, and its latest term with subjects. */
function defaultGeneration(gens: MonitoringGenerationOption[]) {
  return gens.find((g) => g.status === 'ACTIVE') ?? gens[0];
}

function defaultTerm(gen: MonitoringGenerationOption | undefined): number | null {
  if (!gen || gen.terms.length === 0) return null;
  const withSubjects = gen.terms.filter((t) => t.subjects > 0);
  return (withSubjects.at(-1) ?? gen.terms[0]!).number;
}

function Monitoring() {
  const { values, set } = useUrlState(['generation', 'term', 'includeArchived', 'sort'] as const);
  const gens = useMonitoringGenerations();
  const list = gens.data?.data ?? [];

  const generation = values.generation
    ? list.find((g) => g.id === values.generation)
    : defaultGeneration(list);
  const termNumber = values.term && generation ? Number(values.term) : defaultTerm(generation);
  const term = generation?.terms.find((t) => t.number === termNumber);
  const includeArchived = values.includeArchived === 'true';
  const sort = values.sort === 'fail' ? 'fail' : 'name';

  const subjects = useTermSubjects(
    generation && term
      ? { generationId: generation.id, termNumber: term.number, includeArchived, sort }
      : null,
  );

  const hrefFor = (s: MonitoringSubjectRow) =>
    `/admin/monitoring/${encodeURIComponent(generation!.id)}/${term!.number}/${encodeURIComponent(s.subjectId)}${qs(
      {
        includeArchived: includeArchived ? 'true' : undefined,
        sort: sort === 'fail' ? 'fail' : undefined,
      },
    )}`;

  const header = (
    <PageHeader
      title="Subject monitoring"
      description="Read-only results per subject: levels, pass rate and students needing attention. Admins see every term, released or not."
    />
  );

  if (gens.error) {
    return (
      <>
        {header}
        <ErrorState error={gens.error} onRetry={() => gens.refetch()} />
      </>
    );
  }
  if (!gens.data) {
    return (
      <>
        {header}
        <LoadingRows rows={6} label="Loading generations" />
      </>
    );
  }
  if (list.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon={<CalendarRange className="size-8" />}
          title="No generations yet"
          description="Create a generation and sync its term workbook to monitor subjects."
        />
      </>
    );
  }

  const view = subjects.data;
  const rows = view?.subjects ?? [];

  return (
    <>
      {header}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <GenerationTermPicker
          generations={list}
          generationId={generation?.id ?? ''}
          termNumber={term ? term.number : null}
          onGeneration={(id) => set({ generation: id, term: null })}
          onTerm={(n) => set({ generation: generation?.id ?? null, term: n })}
        />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Sort subjects" className="w-44">
            {(p) => (
              <NativeSelect
                {...p}
                value={sort}
                disabled={!term}
                onChange={(e) => set({ sort: e.target.value === 'fail' ? 'fail' : null })}
              >
                <option value="name">By name</option>
                <option value="fail">Most Fail first</option>
              </NativeSelect>
            )}
          </Field>
          <label className="flex h-8 items-center gap-2 text-sm">
            <Checkbox
              checked={includeArchived}
              disabled={!term}
              onCheckedChange={(v) => set({ includeArchived: v === true ? 'true' : null })}
            />
            Include archived subjects
          </label>
        </div>
      </div>

      {values.generation && !generation ? (
        <EmptyState
          title="Generation not found"
          description="It may have been removed. Choose another generation above."
        />
      ) : !term ? (
        <EmptyState
          title={generation?.terms.length ? 'Term not found' : 'No terms in this generation'}
          description={generation?.terms.length ? 'Choose a term above.' : undefined}
        />
      ) : subjects.error ? (
        <MonitoringError error={subjects.error} onRetry={() => subjects.refetch()} />
      ) : !view ? (
        <LoadingRows rows={6} label="Loading subjects" />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {view.generation.code} · {view.term.name}
              </span>
              {generation?.status === 'ARCHIVED' ? <ArchivedBadge /> : null}
              <ReleaseBadge state={view.term.releaseState} />
            </div>
            <LastSyncLine sync={view.lastSync} />
          </div>
          {!view.gradeScale.usable ? <GradeScaleNotice /> : <LevelLegend scale={view.gradeScale} />}
          {rows.length === 0 ? (
            isNeverSynced(view.lastSync) ? (
              <NotSyncedState sync={view.lastSync} />
            ) : (
              <EmptyState
                icon={<BookOpen className="size-8" />}
                title="No subjects in this term"
                description={
                  includeArchived
                    ? 'No subject, archived or not, has been imported for this term.'
                    : 'No active subject has been imported for this term. Archived subjects are hidden; tick “Include archived subjects” to see them.'
                }
              />
            )
          ) : (
            <SubjectList subjects={rows} gradeScale={view.gradeScale} hrefFor={hrefFor} />
          )}
        </div>
      )}
    </>
  );
}

export default function MonitoringPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Monitoring />
    </Suspense>
  );
}
