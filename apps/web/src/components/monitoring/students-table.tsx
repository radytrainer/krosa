'use client';

import type {
  MonitoringCriterion,
  MonitoringMark,
  MonitoringStudentRow,
  MonitoringStudentSort,
  SortOrder,
} from '@ssrs/shared';
import { ArrowDown, ArrowUp, ArrowUpDown, FileX, TriangleAlert, UserMinus } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { StatusPill } from '@/components/app/status';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trimDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CommentPanel, CommentToggle } from './comment-cell';
import { levelLabel } from './level-labels';
import { KHMER_SAFE } from './text';

/** A mark as entered: "-" when not entered (never 0), "Absent" for ABSENT. */
function Mark({ mark }: { mark: MonitoringMark | null | undefined }) {
  if (!mark) {
    return (
      <span className="text-muted-foreground">
        -<span className="sr-only">not entered</span>
      </span>
    );
  }
  if (mark.status === 'ABSENT') return <span className="font-medium">Absent</span>;
  return <span className="tabular-nums">{trimDecimal(mark.mark)}</span>;
}

function RowFlags({ row }: { row: MonitoringStudentRow }) {
  const { flags } = row;
  if (!flags.withdrawn && flags.presentInSource && !flags.needsReview) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {flags.withdrawn ? (
        <StatusPill tone="neutral" icon={<UserMinus aria-hidden />}>
          {flags.withdrawnByProgramSwitch ? 'Withdrawn (program switch)' : 'Withdrawn'}
        </StatusPill>
      ) : null}
      {!flags.presentInSource ? (
        <StatusPill tone="warning" icon={<FileX aria-hidden />}>
          Not in sheet
        </StatusPill>
      ) : null}
      {flags.needsReview ? (
        <StatusPill tone="warning" icon={<TriangleAlert aria-hidden />}>
          Needs review
        </StatusPill>
      ) : null}
    </span>
  );
}

/** A configured weight worth showing: "10.000" → "10"; null, empty or zero → null. */
function weightOf(c: MonitoringCriterion): string | null {
  if (c.weight === null || c.weight === undefined || c.weight.trim() === '') return null;
  return Number(c.weight) === 0 ? null : trimDecimal(c.weight);
}

/** Header text after the name: " · 10%", plus " · /50" only when the maximum is not 100. */
function criterionSuffix(c: MonitoringCriterion): string {
  const weight = weightOf(c);
  const max = trimDecimal(c.maxMark);
  return `${weight ? ` · ${weight}%` : ''}${Number(c.maxMark) === 100 ? '' : ` · /${max}`}`;
}

/** Hover detail: "Quiz 1: weight 10%, out of 100" ("Quiz 1: out of 100" without a weight). */
function criterionDetail(c: MonitoringCriterion): string {
  const weight = weightOf(c);
  return `${c.name}: ${weight ? `weight ${weight}%, ` : ''}out of ${trimDecimal(c.maxMark)}`;
}

function SortHeader({
  label,
  sortKey,
  current,
  order,
  onSort,
  align = 'left',
  detail,
  children,
}: {
  label: string;
  sortKey: MonitoringStudentSort;
  current: MonitoringStudentSort;
  order: SortOrder;
  onSort(key: MonitoringStudentSort): void;
  align?: 'left' | 'right';
  /** Hover detail for the header. */
  detail?: string;
  children?: React.ReactNode;
}) {
  const active = current === sortKey;
  const Icon = !active ? ArrowUpDown : order === 'asc' ? ArrowUp : ArrowDown;
  const button = (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn(
        '-mx-1 inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 font-medium whitespace-nowrap outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
        align === 'right' && 'flex-row-reverse text-right',
      )}
      aria-label={`Sort by ${label}${active ? (order === 'asc' ? ', ascending' : ', descending') : ''}`}
    >
      <span className="text-left">
        {label}
        {children}
      </span>
      <Icon
        className={cn('size-3.5 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')}
        aria-hidden
      />
    </button>
  );
  return (
    <TableHead
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : undefined}
      className={cn(align === 'right' && 'text-right')}
    >
      {detail ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipContent>{detail}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
    </TableHead>
  );
}

/**
 * One row per student of the subject (withdrawn ones listed and flagged). Sorting is server-side:
 * headers only report the requested key. On phones the table scrolls sideways.
 */
export function StudentsTable({
  rows,
  criteria,
  termNumber,
  showGrades,
  sort,
  order,
  onSort,
  busy,
}: {
  rows: MonitoringStudentRow[];
  criteria: MonitoringCriterion[];
  termNumber: number;
  showGrades: boolean;
  sort: MonitoringStudentSort;
  order: SortOrder;
  onSort(key: MonitoringStudentSort): void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const ordered = [...criteria].sort((a, b) => a.order - b.order);
  const columns = 6 + ordered.length + (showGrades ? 2 : 0);
  const head = { current: sort, order, onSort };
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div
      className={cn('rounded-xl ring-1 ring-foreground/10', busy && 'opacity-60')}
      aria-busy={busy || undefined}
    >
      <Table>
        <caption className="sr-only">
          Students of this subject. Column headers sort the list.
        </caption>
        <TableHeader>
          <TableRow>
            <SortHeader label="Student ID" sortKey="studentCode" {...head} />
            <SortHeader label="Name" sortKey="name" {...head} />
            <SortHeader label="Program" sortKey="program" {...head} />
            <SortHeader label="Class" sortKey="class" {...head} />
            {ordered.map((c) => (
              <SortHeader
                key={c.criterionId}
                label={c.name}
                sortKey={`criterion:${c.criterionId}`}
                align="right"
                detail={criterionDetail(c)}
                {...head}
              >
                {criterionSuffix(c)}
              </SortHeader>
            ))}
            <SortHeader label="Total" sortKey="total" align="right" {...head} />
            {showGrades ? (
              <>
                <SortHeader label="Grade" sortKey="grade" {...head} />
                <SortHeader label="Level" sortKey="level" {...head} />
              </>
            ) : null}
            <TableHead>
              <span className="sr-only">Teacher comment</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const panelId = `comment-${r.studentId}`;
            const isOpen = open.has(r.studentId) && r.teacherComment !== null;
            return (
              <Fragment key={r.studentId}>
                <TableRow className={cn(r.flags.withdrawn && 'text-muted-foreground')}>
                  <TableCell className="font-mono text-xs">{r.studentCode}</TableCell>
                  <TableCell className="min-w-[12rem]">
                    <Link
                      href={`/admin/students/${encodeURIComponent(r.studentId)}?term=${termNumber}`}
                      className={cn(
                        'font-medium underline-offset-4 outline-none hover:underline focus-visible:rounded focus-visible:ring-3 focus-visible:ring-ring/50',
                        KHMER_SAFE,
                      )}
                    >
                      {r.fullName}
                    </Link>
                    <RowFlags row={r} />
                  </TableCell>
                  <TableCell title={r.program?.name}>{r.program?.code ?? '-'}</TableCell>
                  <TableCell>{r.className ?? '-'}</TableCell>
                  {ordered.map((c) => (
                    <TableCell key={c.criterionId} className="text-right">
                      <Mark mark={r.marks[c.criterionId]} />
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-medium tabular-nums">
                    {r.finalScore === null ? (
                      <span className="font-normal text-muted-foreground">-</span>
                    ) : (
                      trimDecimal(r.finalScore)
                    )}
                  </TableCell>
                  {showGrades ? (
                    <>
                      <TableCell>{r.finalGrade ?? '-'}</TableCell>
                      <TableCell>{levelLabel(r.level)}</TableCell>
                    </>
                  ) : null}
                  <TableCell>
                    {r.teacherComment ? (
                      <CommentToggle
                        open={isOpen}
                        onToggle={() => toggle(r.studentId)}
                        controls={panelId}
                        studentLabel={r.studentCode}
                      />
                    ) : (
                      <span className="sr-only">No comment</span>
                    )}
                  </TableCell>
                </TableRow>
                {isOpen && r.teacherComment ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={columns} className="whitespace-normal">
                      <CommentPanel id={panelId} text={r.teacherComment} />
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
