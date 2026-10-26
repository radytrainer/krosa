'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { PageHeader, Section } from '@/components/app/page-header';
import { CourseStatusPill } from '@/components/app/status';
import { EmptyState, ErrorState, LoadingRows } from '@/components/app/states';
import { TermChart } from '@/components/results/term-chart';
import { TermSummaryBar } from '@/components/results/term-summary';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { trimDecimal } from '@/lib/format';
import { useApi } from '@/lib/query';
import type { StudentCourseListItem, StudentSummaryView } from '@/lib/types';

export default function StudentDashboardPage() {
  const summary = useApi<StudentSummaryView>('/student/me/summary');
  const courses = useApi<StudentCourseListItem[]>('/student/me/courses');

  if (summary.error) return <ErrorState error={summary.error} onRetry={() => summary.refetch()} />;
  if (!summary.data) return <LoadingRows rows={4} />;
  const { student, terms, overall } = summary.data;
  const firstName = student.fullName.split(' ')[0] ?? student.fullName;

  return (
    <>
      <PageHeader
        title={`Hello, ${firstName}`}
        description={`${student.studentCode} · ${student.generation.name}${student.className ? ` · ${student.className}` : ''}`}
        actions={
          <Link href="/student/results" className={buttonVariants()}>
            View all results
            <ArrowRight aria-hidden />
          </Link>
        }
      />
      {overall.totalCourses === 0 ? (
        <EmptyState
          title="No results yet"
          description="Your results appear here as soon as your courses are released by the registrar."
        />
      ) : (
        <div className="space-y-8">
          <Section title="Overall">
            <TermSummaryBar summary={overall} label="Overall average" />
          </Section>

          <Card>
            <CardHeader>
              <CardTitle>Averages by term</CardTitle>
            </CardHeader>
            <CardContent>
              <TermChart terms={terms} />
            </CardContent>
          </Card>

          <Section title="Courses">
            {courses.error ? (
              <ErrorState error={courses.error} onRetry={() => courses.refetch()} />
            ) : !courses.data ? (
              <LoadingRows rows={3} />
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {courses.data.map((c) => (
                  <li key={c.offeringId}>
                    <Link
                      href={`/student/courses/${c.offeringId}`}
                      className="block h-full rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <Card size="sm" className="h-full transition-colors hover:bg-muted/40">
                        <CardHeader>
                          <p className="text-xs text-muted-foreground">
                            Term {c.termNumber} · <span className="font-mono">{c.courseCode}</span>{' '}
                            · {trimDecimal(c.credits)} cr
                          </p>
                          <CardTitle>{c.title}</CardTitle>
                        </CardHeader>
                        <CardContent className="flex items-center justify-between gap-2">
                          <CourseStatusPill status={c.status} />
                          {c.finalScore ? (
                            <span className="text-lg font-semibold tabular-nums">
                              {c.finalScore}
                            </span>
                          ) : null}
                        </CardContent>
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </>
  );
}
