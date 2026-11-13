'use client';

import {
  ArrowRight,
  ChevronDown,
  EyeOff,
  MessageSquareText,
  TriangleAlert,
  UserMinus,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CourseStatusPill, StatusPill } from '@/components/app/status';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { gradePillClass, gradeScoreClass, gradeToneAttr } from './grade-tone';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { humanize, trimDecimal } from '@/lib/format';
import type { CourseResultView, CriterionResultView } from '@/lib/types';
import { cn } from '@/lib/utils';

function MarkCell({ c }: { c: CriterionResultView }) {
  if (!c.score) return <span className="text-muted-foreground">Not entered</span>;
  if (c.score.status === 'ABSENT') {
    return (
      <span>
        <span className="font-medium">Absent</span>
        <span className="text-muted-foreground"> (0)</span>
      </span>
    );
  }
  return (
    <span className={cn('tabular-nums', c.invalidMark && 'text-warning')}>
      {trimDecimal(c.score.mark)}
      <span className="text-muted-foreground"> / {trimDecimal(c.maxMark)}</span>
      {c.invalidMark ? <span className="sr-only"> (outside the allowed range)</span> : null}
    </span>
  );
}

function Contribution({ c }: { c: CriterionResultView }) {
  return c.contribution === null ? (
    <span className="text-muted-foreground">—</span>
  ) : (
    <span className="tabular-nums">{c.contribution}</span>
  );
}

/** The teacher's comment. Rendered as a text node, so markup in the sheet shows as plain text. */
export function TeacherComment({ text }: { text: string }) {
  return (
    <figure className="rounded-lg bg-muted/50 p-3 text-sm">
      <figcaption className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <MessageSquareText className="size-4" aria-hidden />
        Teacher&apos;s comment
      </figcaption>
      <blockquote className="break-words whitespace-pre-wrap">{text}</blockquote>
    </figure>
  );
}

/**
 * The letter beside a COMPLETE subject's final score, as text ("Grade E"), never colour alone.
 * Coloured by its tone (decisions.md G7), like the score beside it. Nothing else (marks, progress,
 * course counts) ever shows a grade; a term's Top scoring shows this same letter beside that
 * subject's final score.
 */
export function FinalGrade({
  course,
}: {
  course: Pick<CourseResultView, 'status' | 'finalScore' | 'finalGrade'>;
}) {
  if (course.status !== 'COMPLETE' || !course.finalScore || !course.finalGrade) return null;
  return (
    <span
      data-slot="final-grade"
      data-grade-tone={gradeToneAttr(course.finalGrade)}
      className={cn(
        'ml-2 inline-flex h-6 items-center rounded-md px-2 align-middle text-sm font-semibold ring-1 ring-inset',
        gradePillClass(course.finalGrade) ?? 'bg-muted text-foreground ring-foreground/15',
      )}
    >
      Grade {course.finalGrade}
    </span>
  );
}

/** Score summary: the final score when complete, otherwise progress so far. */
export function ScoreSummary({ course, compact }: { course: CourseResultView; compact?: boolean }) {
  if (course.status === 'COMPLETE') {
    return (
      <span className="block text-right">
        <span className={cn('block font-semibold tabular-nums', compact ? 'text-lg' : 'text-2xl')}>
          <span
            data-slot="final-score"
            data-grade-tone={gradeToneAttr(course.finalGrade)}
            className={gradeScoreClass(course.finalGrade)}
          >
            {course.finalScore}
          </span>
          <span className="text-sm font-normal text-muted-foreground"> / 100</span>
          <FinalGrade course={course} />
        </span>
        {compact ? null : <span className="block text-xs text-muted-foreground">Final score</span>}
      </span>
    );
  }
  if (course.status === 'INCOMPLETE') {
    return (
      <span className="block text-right">
        <span className={cn('block font-semibold tabular-nums', compact ? 'text-base' : 'text-xl')}>
          {course.earnedSoFar}
          <span className="text-sm font-normal text-muted-foreground">
            {' '}
            of {trimDecimal(course.attemptedWeight)} so far
          </span>
        </span>
        {compact ? null : (
          <span className="block text-xs text-muted-foreground">
            Final score when all marks are in
          </span>
        )}
      </span>
    );
  }
  return null;
}

/**
 * One course's result. Collapsed, it shows the summary (title, status, score); the header is a
 * button that expands the criteria: a table (md+) or stacked cards (mobile).
 */
export function CourseResult({
  course,
  href,
  showAdmin,
  defaultOpen = false,
}: {
  course: CourseResultView;
  href?: string;
  showAdmin?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const titleId = `course-${course.offeringId}`;
  const panelId = `${titleId}-details`;
  return (
    <Card aria-labelledby={titleId} className={cn(!open && 'transition-colors hover:bg-muted/30')}>
      <CardHeader>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="-m-2 grid cursor-pointer gap-3 rounded-lg p-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:grid-cols-[1fr_auto_auto] sm:items-center"
        >
          <span className="block min-w-0 space-y-1">
            <span id={titleId} className="block text-base leading-snug font-medium">
              {course.title}
            </span>
            <span className="block text-xs text-muted-foreground">
              <span className="font-mono">{course.courseCode}</span> · {trimDecimal(course.credits)}{' '}
              credits
              {course.schemeVersion ? ` · scheme v${course.schemeVersion}` : ''}
            </span>
            <span className="flex flex-wrap gap-1 pt-1">
              <CourseStatusPill status={course.status} />
              {showAdmin && course.admin?.visibility === 'HIDDEN' ? (
                <StatusPill tone="neutral" icon={<EyeOff aria-hidden />}>
                  Hidden from student
                </StatusPill>
              ) : null}
              {showAdmin && course.admin?.enrollmentStatus === 'WITHDRAWN' ? (
                <StatusPill tone="neutral" icon={<UserMinus aria-hidden />}>
                  {course.admin.endedReason === 'PROGRAM_SWITCH'
                    ? 'Ended by program switch (marks kept)'
                    : 'Withdrawn'}
                </StatusPill>
              ) : null}
              {showAdmin && course.admin && !course.admin.presentInSource ? (
                <StatusPill tone="warning" icon={<TriangleAlert aria-hidden />}>
                  Missing from sheet
                </StatusPill>
              ) : null}
            </span>
          </span>
          <ScoreSummary course={course} />
          <ChevronDown
            aria-hidden
            className={cn(
              'size-5 justify-self-end text-muted-foreground transition-transform max-sm:hidden',
              open && 'rotate-180',
            )}
          />
          <span className="text-xs font-medium text-muted-foreground sm:hidden">
            {open ? 'Hide details' : 'Show details'}
          </span>
        </button>
      </CardHeader>
      {open ? (
        <CardContent id={panelId} className="space-y-3">
          {course.status === 'NOT_CONFIGURED' ? (
            <p className="text-sm text-muted-foreground">
              The grading scheme for this course has not been published yet.
            </p>
          ) : (
            <>
              {course.status === 'NEEDS_REVIEW' ? (
                <p className="mb-3 flex items-start gap-2 rounded-lg bg-warning/10 p-3 text-sm text-warning">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />A recorded mark is
                  outside the allowed range and is being reviewed. No final score is shown until it
                  is corrected.
                </p>
              ) : null}
              {/* Desktop/tablet: table */}
              <div className="hidden overflow-x-auto rounded-lg ring-1 ring-foreground/10 md:block">
                <Table>
                  <caption className="sr-only">Assessment criteria for {course.title}</caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Criterion</TableHead>
                      <TableHead className="text-right">Mark</TableHead>
                      <TableHead className="text-right">Weight</TableHead>
                      <TableHead className="text-right">Contribution</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {course.criteria.map((c) => (
                      <TableRow key={c.criterionId}>
                        <TableCell className="whitespace-normal">
                          <span className="font-medium">{c.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {humanize(c.category)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <MarkCell c={c} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {trimDecimal(c.weight)}%
                        </TableCell>
                        <TableCell className="text-right">
                          <Contribution c={c} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {/* Mobile: one card per criterion */}
              <ul
                className="space-y-2 md:hidden"
                aria-label={`Assessment criteria for ${course.title}`}
              >
                {course.criteria.map((c) => (
                  <li key={c.criterionId} className="rounded-lg border p-3">
                    <p className="text-sm font-medium">{c.name}</p>
                    <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <dt className="text-xs text-muted-foreground">Mark</dt>
                        <dd>
                          <MarkCell c={c} />
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Weight</dt>
                        <dd className="tabular-nums">{trimDecimal(c.weight)}%</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Contribution</dt>
                        <dd>
                          <Contribution c={c} />
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            </>
          )}
          {course.teacherComment ? <TeacherComment text={course.teacherComment} /> : null}
          {href ? (
            <Link
              href={href}
              className="inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
            >
              Open course page
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
