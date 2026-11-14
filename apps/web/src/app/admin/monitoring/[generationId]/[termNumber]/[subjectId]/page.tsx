'use client';

import type {
  MonitoringLevel,
  MonitoringStudentSort,
  MonitoringSubjectSummaryView,
  SortOrder,
} from '@ssrs/shared';
import {
  MONITORING_DEFAULT_PAGE_SIZE,
  MONITORING_LEVELS,
  MONITORING_MAX_PAGE_SIZE,
  MONITORING_STUDENT_SORTS,
} from '@ssrs/shared';
import { Archive, ChevronRight, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useUrlState } from '@/components/admin/use-url-state';
import { Field, NativeSelect } from '@/components/app/form';
import { PageHeader, Section } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
import { EmptyState, LoadingRows, PageLoading } from '@/components/app/states';
import { useSubjectStudents, useSubjectSummary } from '@/components/monitoring/api';
import { DataNotes } from '@/components/monitoring/data-notes';
import { LEVEL_LABEL } from '@/components/monitoring/level-labels';
import { LevelSummary } from '@/components/monitoring/level-summary';
import {
  MonitoringError,
  type MonitoringErrorActions,
} from '@/components/monitoring/monitoring-error';
import { StudentsTable } from '@/components/monitoring/students-table';
import {
  LastSyncLine,
  NotSyncedState,
  ReleaseBadge,
  isNeverSynced,
} from '@/components/monitoring/term-badges';
import { KHMER_SAFE, audienceLabel } from '@/components/monitoring/text';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { formatDate } from '@/lib/format';
import { qs } from '@/lib/query';

const KEYS = [
  'includeArchived',
  /** The subject list's sort on page 1, only carried for the back link. */
  'sort',
  'program',
  'className',
  'level',
  'search',
  'sortKey',
  'order',
  'pageSize',
] as const;

const PAGE_SIZES = [25, 50, MONITORING_MAX_PAGE_SIZE];

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function asLevel(value: string): MonitoringLevel | null {
  return (MONITORING_LEVELS as readonly string[]).includes(value)
    ? (value as MonitoringLevel)
    : null;
}

function asSort(value: string): MonitoringStudentSort {
  if ((MONITORING_STUDENT_SORTS as readonly string[]).includes(value)) {
    return value as MonitoringStudentSort;
  }
  return value.startsWith('criterion:') && value.length > 'criterion:'.length
    ? (value as MonitoringStudentSort)
    : 'studentCode';
}

function asPageSize(value: string): number {
  const n = Number(value);
  return PAGE_SIZES.includes(n) ? n : MONITORING_DEFAULT_PAGE_SIZE;
}

/** "Term 2 · Class D · SNAC", or the subject's programs when no class or program is chosen. */
function contextLine(s: MonitoringSubjectSummaryView, program: string, className: string) {
  const cls = s.filters.classes.find(
    (c) => c.name === className && (!program || c.programCode === program),
  );
  return [
    s.term.name,
    className ? `Class ${className}` : 'All classes',
    program || cls?.programCode || audienceLabel(s.subject.audience),
  ].join(' · ');
}

function SubjectMonitoring() {
  const params = useParams<{ generationId: string; termNumber: string; subjectId: string }>();
  const generationId = safeDecode(params.generationId);
  const subjectId = safeDecode(params.subjectId);
  const termNumber = Number(params.termNumber);
  const { values, page, set } = useUrlState(KEYS);

  const includeArchived = values.includeArchived === 'true';
  const urlLevel = asLevel(values.level);
  const sortKey = asSort(values.sortKey);
  const order: SortOrder = values.order === 'desc' ? 'desc' : 'asc';
  const pageSize = asPageSize(values.pageSize);

  /** Typed text, written to the URL after a pause; follows the URL on Back/Forward. */
  const [search, setSearch] = useState(values.search);
  const [urlSearch, setUrlSearch] = useState(values.search);
  if (values.search !== urlSearch) {
    setUrlSearch(values.search);
    setSearch(values.search);
  }
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== values.search) set({ search });
    }, 300);
    return () => clearTimeout(t);
  }, [search, values.search, set]);

  const base = {
    generationId,
    termNumber,
    subjectId,
    program: values.program || undefined,
    className: values.className || undefined,
    includeArchived,
  };
  const summary = useSubjectSummary(base);
  /**
   * Without a usable scale only Incomplete exists, so a graded level from the URL counts as no
   * level. Until the summary says which, a graded level waits rather than being sent.
   */
  const usableScale = summary.data?.gradeScale.usable;
  const level = urlLevel === 'INCOMPLETE' || usableScale ? urlLevel : null;
  const levelPending = urlLevel !== null && urlLevel !== 'INCOMPLETE' && usableScale === undefined;
  const studentsQuery = {
    ...base,
    level: level ?? undefined,
    search: values.search.trim() || undefined,
    sort: sortKey,
    order,
    page,
    pageSize,
  };
  const students = useSubjectStudents(levelPending ? null : studentsQuery);

  const backHref = `/admin/monitoring${qs({
    generation: generationId,
    term: Number.isFinite(termNumber) ? termNumber : undefined,
    includeArchived: includeArchived ? 'true' : undefined,
    sort: values.sort === 'fail' ? 'fail' : undefined,
  })}`;

  const s = summary.data;
  const title = s?.subject.title ?? 'Subject';

  const header = (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted-foreground">
        <ol className="flex flex-wrap items-center gap-1">
          <li>
            <Link href="/admin/monitoring" className="hover:text-foreground hover:underline">
              Subject monitoring
            </Link>
          </li>
          <li aria-hidden>
            <ChevronRight className="size-3.5" />
          </li>
          <li>
            <Link href={backHref} className="hover:text-foreground hover:underline">
              {s ? `${s.generation.code} · ${s.term.name}` : `Term ${params.termNumber}`}
            </Link>
          </li>
          <li aria-hidden>
            <ChevronRight className="size-3.5" />
          </li>
          <li aria-current="page" className={`text-foreground ${KHMER_SAFE}`}>
            {title}
          </li>
        </ol>
      </nav>
      <PageHeader
        back={{ href: backHref, label: 'Back to subjects' }}
        title={<span className={KHMER_SAFE}>{title}</span>}
        description={
          s ? (
            <>
              <span className="font-mono">{s.subject.courseCode}</span> ·{' '}
              {contextLine(s, values.program, values.className)}
            </>
          ) : null
        }
        actions={s ? <ReleaseBadge state={s.term.releaseState} /> : null}
      />
    </>
  );

  /** Fixes offered by the error state: they only change the URL. */
  const errorActions: MonitoringErrorActions = {
    clearProgram: () => set({ program: null, className: null }),
    clearClass: () => set({ className: null }),
    clearSort: () => set({ sortKey: null, order: null }),
    resetFilters: () =>
      set({
        program: null,
        className: null,
        level: null,
        search: null,
        sortKey: null,
        order: null,
        pageSize: null,
      }),
    backHref,
  };

  if (summary.error && !s) {
    return (
      <>
        {header}
        <MonitoringError
          error={summary.error}
          onRetry={() => summary.refetch()}
          actions={errorActions}
        />
      </>
    );
  }
  if (!s) {
    return (
      <>
        {header}
        <LoadingRows rows={6} label="Loading subject" />
      </>
    );
  }

  const { filters } = s;
  const programOk = (code: string) => filters.programs.some((p) => p.code === code);
  const program = values.program && programOk(values.program) ? values.program : '';
  const classes = filters.classes.filter((c) => !program || c.programCode === program);
  const classValid = (name: string, prog: string) =>
    filters.classes.some((c) => c.name === name && (!prog || c.programCode === prog));
  const levelOptions = s.gradeScale.usable ? MONITORING_LEVELS : (['INCOMPLETE'] as const);
  /**
   * Same rule as page 1: "not synced yet" only when there is nothing to show. A term whose sheet
   * was removed or disabled after a sync keeps its results; the sync line then says so.
   */
  const neverSynced =
    isNeverSynced(s.lastSync) &&
    s.stats.students === 0 &&
    s.notes.withdrawn === 0 &&
    !values.program &&
    !values.className;
  const filtered = Boolean(values.program || values.className || level || values.search);
  const busy = summary.isPlaceholderData || summary.isFetching;

  const onSort = (key: MonitoringStudentSort) =>
    set(
      key === sortKey
        ? { sortKey: key, order: order === 'asc' ? 'desc' : 'asc' }
        : { sortKey: key, order: null },
    );

  return (
    <>
      {header}
      <div className="space-y-6">
        {s.subject.archived ? (
          <Alert>
            <Archive aria-hidden />
            <AlertTitle>Archived subject</AlertTitle>
            <AlertDescription>
              This subject was archived
              {s.subject.archivedAt ? ` on ${formatDate(s.subject.archivedAt)}` : ''}. Its results
              are kept and shown here for reference.
            </AlertDescription>
          </Alert>
        ) : null}
        {summary.error ? (
          <MonitoringError
            error={summary.error}
            onRetry={() => summary.refetch()}
            actions={errorActions}
          />
        ) : null}

        {neverSynced ? (
          <NotSyncedState sync={s.lastSync} />
        ) : (
          <>
            <div
              role="search"
              aria-label="Filter students"
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,11rem))_minmax(0,1fr)_auto] lg:items-end"
            >
              {filters.programFilter ? (
                <Field label="Program">
                  {(p) => (
                    <NativeSelect
                      {...p}
                      value={program}
                      onChange={(e) => {
                        const next = e.target.value;
                        set({
                          program: next || null,
                          className:
                            values.className && classValid(values.className, next)
                              ? values.className
                              : null,
                        });
                      }}
                    >
                      <option value="">All programs</option>
                      {filters.programs.map((p) => (
                        <option key={p.id} value={p.code}>
                          {p.code} · {p.name}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              ) : null}
              <Field label="Class">
                {(p) => (
                  <NativeSelect
                    {...p}
                    value={values.className}
                    disabled={classes.length === 0}
                    onChange={(e) => set({ className: e.target.value || null })}
                  >
                    <option value="">All classes</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.name}>
                        {program || !filters.programFilter
                          ? c.name
                          : `${c.name} (${c.programCode})`}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field
                label="Level"
                hint={s.gradeScale.usable ? undefined : 'Only Incomplete: no usable grade scale.'}
              >
                {(p) => (
                  <NativeSelect
                    {...p}
                    value={level ?? ''}
                    onChange={(e) => set({ level: e.target.value || null })}
                  >
                    <option value="">All levels</option>
                    {levelOptions.map((l) => (
                      <option key={l} value={l}>
                        {LEVEL_LABEL[l]}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Search">
                {(p) => (
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      {...p}
                      type="search"
                      placeholder="Student ID or name"
                      maxLength={100}
                      className="pl-8"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                )}
              </Field>
              <label className="flex h-8 items-center gap-2 text-sm whitespace-nowrap">
                <Checkbox
                  checked={includeArchived}
                  onCheckedChange={(v) => set({ includeArchived: v === true ? 'true' : null })}
                />
                Include archived
              </label>
            </div>

            <Section title="Summary" description={contextLine(s, program, values.className)}>
              <div className={busy ? 'opacity-60 transition-opacity' : undefined} aria-busy={busy}>
                <LevelSummary summary={s} level={level} onLevel={(l) => set({ level: l })} />
              </div>
            </Section>

            <Section
              title="Students"
              description={
                students.data
                  ? `${students.data.meta.total} listed${level ? ` · level ${LEVEL_LABEL[level]}` : ''}. Withdrawn students are listed and flagged but not counted in the summary.`
                  : undefined
              }
              actions={
                <Field label="Rows per page" className="w-36">
                  {(p) => (
                    <NativeSelect
                      {...p}
                      value={pageSize}
                      disabled={!students.data}
                      onChange={(e) =>
                        set({
                          pageSize:
                            Number(e.target.value) === MONITORING_DEFAULT_PAGE_SIZE
                              ? null
                              : e.target.value,
                        })
                      }
                    >
                      {PAGE_SIZES.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              }
            >
              {students.error ? (
                <MonitoringError
                  error={students.error}
                  onRetry={() => students.refetch()}
                  actions={errorActions}
                />
              ) : !students.data ? (
                <LoadingRows rows={8} label="Loading students" />
              ) : students.data.data.length === 0 && students.data.meta.total > 0 ? (
                <EmptyState
                  title="This page is past the end of the list"
                  description={`${
                    students.data.meta.total === 1
                      ? '1 student matches'
                      : `${students.data.meta.total} students match`
                  }, which fit on fewer pages.`}
                  action={
                    <Button variant="outline" size="sm" onClick={() => set({ page: null })}>
                      Go to page 1
                    </Button>
                  }
                />
              ) : students.data.data.length === 0 ? (
                <EmptyState
                  icon={<Users className="size-8" />}
                  title="No students found"
                  description={
                    filtered
                      ? 'No student matches these filters. Try other filters.'
                      : 'No student is enrolled in this subject for this term.'
                  }
                />
              ) : (
                <>
                  <StudentsTable
                    rows={students.data.data}
                    criteria={students.data.criteria}
                    termNumber={termNumber}
                    showGrades={s.gradeScale.usable}
                    sort={sortKey}
                    order={order}
                    onSort={onSort}
                    busy={students.isPlaceholderData}
                  />
                  <Pagination {...students.data.meta} onPage={(p) => set({ page: p })} />
                </>
              )}
            </Section>
          </>
        )}

        {neverSynced ? <LastSyncLine sync={s.lastSync} /> : <DataNotes summary={s} />}
      </div>
    </>
  );
}

export default function SubjectMonitoringPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <SubjectMonitoring />
    </Suspense>
  );
}
