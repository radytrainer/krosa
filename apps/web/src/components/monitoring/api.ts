'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  MonitoringGenerationsView,
  MonitoringStudentsPage,
  MonitoringStudentsQuery,
  MonitoringSubjectQuery,
  MonitoringSubjectSort,
  MonitoringSubjectSummaryView,
  MonitoringTermSubjectsView,
} from '@ssrs/shared';
import { ApiError, apiFetch } from '@/lib/api';
import { apiKey, qs } from '@/lib/query';

/**
 * Read-only admin report, never cached (decisions.md M1): asked for on every visit. Routes and
 * query names follow apps/api/src/monitoring/monitoring.dto.ts.
 */
function useMonitoring<T>(path: string | null, keepPrevious = false) {
  return useQuery<T>({
    queryKey: apiKey(path ?? ''),
    queryFn: () => apiFetch<T>(path!),
    // A 4xx (stale filter, unknown subject) will not fix itself; only retry other failures.
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    enabled: path !== null,
    staleTime: 0,
    gcTime: keepPrevious ? 60_000 : 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    ...(keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });
}

export function useMonitoringGenerations() {
  return useMonitoring<MonitoringGenerationsView>('/admin/monitoring/generations');
}

export function useTermSubjects(
  params: {
    generationId: string;
    termNumber: number;
    includeArchived: boolean;
    sort: MonitoringSubjectSort;
  } | null,
) {
  return useMonitoring<MonitoringTermSubjectsView>(
    params
      ? `/admin/monitoring/terms/${encodeURIComponent(params.generationId)}/${params.termNumber}/subjects${qs(
          { includeArchived: params.includeArchived || undefined, sort: params.sort },
        )}`
      : null,
  );
}

function subjectParams(q: MonitoringSubjectQuery) {
  return {
    generationId: q.generationId,
    termNumber: q.termNumber,
    subjectId: q.subjectId,
    program: q.program,
    className: q.className,
    includeArchived: q.includeArchived || undefined,
  };
}

export function useSubjectSummary(q: MonitoringSubjectQuery) {
  return useMonitoring<MonitoringSubjectSummaryView>(
    `/admin/monitoring/subjects/summary${qs(subjectParams(q))}`,
    true,
  );
}

/** `null` waits, e.g. until the summary says whether a graded level filter can apply. */
export function useSubjectStudents(q: MonitoringStudentsQuery | null) {
  return useMonitoring<MonitoringStudentsPage>(
    q &&
      `/admin/monitoring/subjects/students${qs({
        ...subjectParams(q),
        level: q.level,
        search: q.search,
        sort: q.sort,
        order: q.order,
        page: q.page,
        pageSize: q.pageSize,
      })}`,
    true,
  );
}
