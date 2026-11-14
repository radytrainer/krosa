'use client';

import type { GradeScaleInfo, MonitoringLevel, MonitoringSubjectRow } from '@ssrs/shared';
import { MONITORING_LEVELS } from '@ssrs/shared';
import { ChevronRight, EyeOff, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { StatusPill } from '@/components/app/status';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { LEVEL_LABEL, levelLetters } from './level-labels';
import { ArchivedBadge } from './term-badges';
import { KHMER_SAFE, audienceLabel, percent } from './text';

function SubjectFlags({ s }: { s: MonitoringSubjectRow }) {
  return (
    <span className="flex flex-wrap gap-1">
      {s.archived ? <ArchivedBadge /> : null}
      {s.visibility === 'HIDDEN' ? (
        <StatusPill tone="neutral" icon={<EyeOff aria-hidden />}>
          Hidden from students
        </StatusPill>
      ) : null}
      {!s.configured ? (
        <StatusPill tone="warning" icon={<TriangleAlert aria-hidden />}>
          No grading scheme
        </StatusPill>
      ) : null}
    </span>
  );
}

/** Graded levels are only meaningful with a usable scale; Incomplete always is. */
function shownLevels(scale: GradeScaleInfo): readonly MonitoringLevel[] {
  return scale.usable ? MONITORING_LEVELS : ['INCOMPLETE'];
}

/**
 * The term's subjects with level counts. A table on laptops, cards on phones. The title is the
 * link (keyboard and screen readers); the whole row is also clickable with a mouse.
 */
export function SubjectList({
  subjects,
  gradeScale,
  hrefFor,
}: {
  subjects: MonitoringSubjectRow[];
  gradeScale: GradeScaleInfo;
  hrefFor(s: MonitoringSubjectRow): string;
}) {
  const router = useRouter();
  const levels = shownLevels(gradeScale);
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl ring-1 ring-foreground/10 md:block">
        <Table>
          <caption className="sr-only">Subjects in this term with counts per level</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Subject</TableHead>
              <TableHead>Programs</TableHead>
              <TableHead className="text-right">Students</TableHead>
              {levels.map((l) => (
                <TableHead
                  key={l}
                  className="text-right"
                  title={levelLetters(gradeScale, l) || undefined}
                >
                  {LEVEL_LABEL[l]}
                </TableHead>
              ))}
              <TableHead className="text-right">Needs review</TableHead>
              <TableHead className="text-right">Pass rate</TableHead>
              <TableHead className="w-6">
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {subjects.map((s) => (
              <TableRow
                key={s.subjectId}
                className="cursor-pointer"
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('a')) return;
                  router.push(hrefFor(s));
                }}
              >
                <TableCell className="min-w-[14rem] whitespace-normal">
                  <Link
                    href={hrefFor(s)}
                    className={`font-medium underline-offset-4 outline-none hover:underline focus-visible:rounded focus-visible:ring-3 focus-visible:ring-ring/50 ${KHMER_SAFE}`}
                  >
                    {s.title}
                  </Link>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {s.courseCode}
                  </span>
                  <span className="mt-1 block">
                    <SubjectFlags s={s} />
                  </span>
                </TableCell>
                <TableCell className="whitespace-normal">{audienceLabel(s.audience)}</TableCell>
                <TableCell className="text-right tabular-nums">{s.students}</TableCell>
                {levels.map((l) => (
                  <TableCell key={l} className="text-right tabular-nums">
                    {s.levels[l]}
                  </TableCell>
                ))}
                <TableCell className="text-right tabular-nums">
                  {s.needsReview > 0 ? (
                    <span className="font-medium text-warning">{s.needsReview}</span>
                  ) : (
                    0
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{percent(s.passRate)}</TableCell>
                <TableCell>
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="space-y-2 md:hidden" aria-label="Subjects in this term">
        {subjects.map((s) => (
          <li key={s.subjectId}>
            <Link
              href={hrefFor(s)}
              className="block rounded-xl p-3 ring-1 ring-foreground/10 outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className={`block font-medium ${KHMER_SAFE}`}>{s.title}</span>
              <span className="block text-xs text-muted-foreground">
                <span className="font-mono">{s.courseCode}</span> · {audienceLabel(s.audience)}
              </span>
              <span className="mt-1 block">
                <SubjectFlags s={s} />
              </span>
              <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Students</dt>
                  <dd className="tabular-nums">{s.students}</dd>
                </div>
                {levels.map((l) => (
                  <div key={l}>
                    <dt className="text-xs text-muted-foreground">{LEVEL_LABEL[l]}</dt>
                    <dd className="tabular-nums">{s.levels[l]}</dd>
                  </div>
                ))}
                <div>
                  <dt className="text-xs text-muted-foreground">Needs review</dt>
                  <dd className="tabular-nums">{s.needsReview}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Pass rate</dt>
                  <dd className="tabular-nums">{percent(s.passRate)}</dd>
                </div>
              </dl>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
