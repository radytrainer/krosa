'use client';

import { CheckCircle2, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { NativeSelect } from '@/components/app/form';
import { PageHeader, Section } from '@/components/app/page-header';
import { Confirm } from '@/components/app/confirm';
import { Pagination } from '@/components/app/pagination';
import { EmptyState, ErrorState, LoadingRows, PageLoading } from '@/components/app/states';
import { StatusPill } from '@/components/app/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { json, qs, useApi, useApiMutation } from '@/lib/query';
import type { Paginated, StudentIssue, StudentIssueKind, Term, TermClasses } from '@/lib/types';

const KIND: Record<StudentIssueKind, string> = {
  PROGRAM_SWITCH: 'Program switch',
  PROGRAM_CONFLICT: 'Class and CLASS 2 disagree',
  UNKNOWN_CLASS: 'Class not in the list',
  UNDETERMINED_PROGRAM: 'No class in ALL',
  DUPLICATE_IN_ROSTER: 'Listed twice in ALL',
};

/** What an issue is about, from its detail (IDs, classes and program codes only). */
function issueDetail(issue: StudentIssue): string {
  const d = issue.detail as Record<string, unknown>;
  const text = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
  switch (issue.kind) {
    case 'PROGRAM_SWITCH':
      return `${text(d['from'])} → ${text(d['to'])} (class ${text(d['class'])})`;
    case 'PROGRAM_CONFLICT':
      return d['adminProgram']
        ? `Class ${text(d['class'])} is ${text(d['classProgram'])}; an admin set ${text(d['adminProgram'])}`
        : `Class ${text(d['class'])} (${text(d['classProgram'])}), CLASS 2 "${text(d['programText'])}"`;
    case 'DUPLICATE_IN_ROSTER':
      return `Rows ${(d['rows'] as number[] | undefined)?.join(', ') ?? '—'}, classes ${(d['classes'] as string[] | undefined)?.map(text).join(' / ') ?? '—'}`;
    default:
      return `Class ${text(d['class'])}`;
  }
}

/** Edits a term's class lists: one comma-separated line per program. */
function ClassLists({ term }: { term: TermClasses }) {
  const initial = Object.fromEntries(
    term.programs.map((p) => [p.code, p.classes.map((c) => c.name).join(', ')]),
  );
  const [lines, setLines] = useState<Record<string, string>>(initial);
  const save = useApiMutation(
    () =>
      apiFetch<TermClasses>(
        `/admin/terms/${term.termId}/classes`,
        json(
          {
            programs: term.programs.map((p) => ({
              program: p.code,
              classes: (lines[p.code] ?? '')
                .split(',')
                .map((c) => c.trim())
                .filter(Boolean),
            })),
          },
          'PUT',
        ),
      ),
    { success: 'Class lists saved.', invalidate: [`/admin/terms/${term.termId}`] },
  );
  const changed = term.programs.some((p) => (lines[p.code] ?? '') !== initial[p.code]);
  // The previous term's lists, for the programs both terms have (Term 1's General has none).
  const terms = useApi<Term[]>(`/admin/generations/${term.generationId}/terms`);
  const previousTerm = terms.data?.find((t) => t.number === term.termNumber - 1);
  const previous = useApi<TermClasses>(
    previousTerm ? `/admin/terms/${previousTerm.id}/classes` : null,
  );
  const codes = new Set(term.programs.map((p) => p.code));
  const shared = previous.data?.programs.filter((p) => codes.has(p.code)) ?? [];
  const copyable = shared.length > 0 ? shared : null;
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Program</TableHead>
              <TableHead>Classes (students)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {term.programs.map((p) => (
              <TableRow key={p.id} className="align-top">
                <TableCell className="font-medium">
                  {p.code}
                  <span className="block text-xs font-normal text-muted-foreground">{p.name}</span>
                </TableCell>
                <TableCell className="space-y-2 whitespace-normal">
                  <div className="flex flex-wrap gap-1">
                    {p.classes.map((c) => (
                      <StatusPill key={c.id} tone="neutral">
                        {c.name} ({c.students})
                      </StatusPill>
                    ))}
                  </div>
                  <div className="max-w-sm space-y-1">
                    <Label htmlFor={`classes-${p.code}`} className="sr-only">
                      Classes of {p.code}
                    </Label>
                    <Input
                      id={`classes-${p.code}`}
                      value={lines[p.code] ?? ''}
                      onChange={(e) => setLines({ ...lines, [p.code]: e.target.value })}
                      placeholder="A, B, C"
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Separate classes with commas. A class name can belong to one program per term, and a class
          that has students cannot be removed.
        </p>
        <span className="inline-flex flex-wrap gap-2">
          {copyable ? (
            <Button
              variant="outline"
              onClick={() =>
                setLines({
                  ...lines,
                  ...Object.fromEntries(
                    copyable.map((p) => [p.code, p.classes.map((c) => c.name).join(', ')]),
                  ),
                })
              }
            >
              Copy {previousTerm?.name}&apos;s classes
            </Button>
          ) : null}
          <Button disabled={!changed || save.isPending} onClick={() => save.mutate(undefined)}>
            {save.isPending ? 'Saving…' : 'Save class lists'}
          </Button>
        </span>
      </div>
    </div>
  );
}

function StudentIssues({ termId }: { termId: string }) {
  const [status, setStatus] = useState('OPEN');
  const [page, setPage] = useState(1);
  const path = `/admin/terms/${termId}/student-issues`;
  const issues = useApi<Paginated<StudentIssue>>(`${path}${qs({ status, page, pageSize: 20 })}`, {
    keepPrevious: true,
  });
  const invalidate = [path, `/admin/terms/${termId}`, '/admin/students'];
  const approve = useApiMutation(
    (id: string) => apiFetch(`/admin/student-issues/${id}/approve`, { method: 'POST' }),
    { success: 'Program switch approved.', invalidate },
  );
  const reverse = useApiMutation(
    (id: string) => apiFetch(`/admin/student-issues/${id}/reverse`, { method: 'POST' }),
    { success: 'Program switch reversed.', invalidate },
  );
  return (
    <Section
      title="Student issues"
      description="Students the sync could not enroll in this term, and program switches waiting for you. Only that student is affected; their rows are skipped until it is settled."
      actions={
        <NativeSelect
          aria-label="Status"
          className="w-40"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="OPEN">Open</option>
          <option value="RESOLVED">Resolved</option>
          <option value="ALL">All</option>
        </NativeSelect>
      }
    >
      {issues.error ? (
        <ErrorState error={issues.error} onRetry={() => issues.refetch()} />
      ) : !issues.data ? (
        <LoadingRows rows={3} />
      ) : issues.data.data.length === 0 ? (
        <EmptyState
          title={status === 'OPEN' ? 'Nothing to settle' : 'No issues'}
          description="Every student in the roster has a program and class in this term."
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Problem</TableHead>
                  <TableHead className="hidden md:table-cell">Since</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {issues.data.data.map((i) => (
                  <TableRow key={i.id} className="align-top">
                    <TableCell>
                      {i.studentId ? (
                        <Link href={`/admin/students/${i.studentId}`} className="hover:underline">
                          <span className="font-mono">{i.studentCode}</span>
                          {i.fullName ? (
                            <span className="block text-xs text-muted-foreground">
                              {i.fullName}
                            </span>
                          ) : null}
                        </Link>
                      ) : (
                        <span className="font-mono">{i.studentCode}</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <p className="font-medium">{KIND[i.kind]}</p>
                      <p className="text-xs text-muted-foreground">{issueDetail(i)}</p>
                      {i.resolution ? (
                        <StatusPill tone="neutral" className="mt-1">
                          {i.resolution.replaceAll('_', ' ').toLowerCase()}
                        </StatusPill>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {formatDateTime(i.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {i.kind === 'PROGRAM_SWITCH' && !i.resolvedAt ? (
                        <Confirm
                          trigger={
                            <Button size="sm">
                              <CheckCircle2 aria-hidden />
                              Approve
                            </Button>
                          }
                          title={`Move ${i.studentCode} to ${String(i.detail['to'])}?`}
                          description="Subjects the new program does not take are withdrawn: their marks stay stored, hidden from the student and flagged for admins. Nothing is deleted, and you can reverse it."
                          confirmLabel="Approve switch"
                          onConfirm={() => approve.mutateAsync(i.id)}
                        />
                      ) : i.kind === 'PROGRAM_SWITCH' && i.resolution === 'APPROVED' ? (
                        <Confirm
                          trigger={
                            <Button size="sm" variant="outline">
                              <RotateCcw aria-hidden />
                              Reverse
                            </Button>
                          }
                          title={`Reverse the switch of ${i.studentCode}?`}
                          description="The previous program and class come back, and the withdrawn subjects are restored."
                          confirmLabel="Reverse switch"
                          onConfirm={() => reverse.mutateAsync(i.id)}
                        />
                      ) : !i.resolvedAt && i.studentId ? (
                        <Link
                          href={`/admin/students/${i.studentId}`}
                          className="text-sm font-medium underline-offset-4 hover:underline"
                        >
                          Fix ALL, or assign
                        </Link>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination {...issues.data.meta} onPage={setPage} />
        </>
      )}
    </Section>
  );
}

export default function TermPage() {
  const { id } = useParams<{ id: string }>();
  const term = useApi<TermClasses>(`/admin/terms/${id}/classes`);
  if (term.error) return <ErrorState error={term.error} onRetry={() => term.refetch()} />;
  if (!term.data) return <PageLoading />;
  return (
    <>
      <PageHeader
        title={`${term.data.termName}: classes and students`}
        description="Programs and classes of this term, and students who need a decision."
        back={{ href: `/admin/generations/${term.data.generationId}`, label: 'Generation' }}
      />
      <div className="space-y-8">
        <Section
          title="Programs and classes"
          description="A student's class in the ALL tab decides their program through this list."
        >
          <ClassLists key={JSON.stringify(term.data.programs)} term={term.data} />
        </Section>
        <StudentIssues termId={id} />
      </div>
    </>
  );
}
