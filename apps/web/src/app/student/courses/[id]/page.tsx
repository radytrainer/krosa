'use client';

import { Info } from 'lucide-react';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/app/page-header';
import { ErrorState, PageLoading } from '@/components/app/states';
import { CourseResult } from '@/components/results/course-result';
import { Card, CardContent } from '@/components/ui/card';
import { useApi } from '@/lib/query';
import type { CourseResultView } from '@/lib/types';

export default function StudentCoursePage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isPending, refetch } = useApi<CourseResultView>(`/student/me/courses/${id}`);

  if (error) {
    return (
      <>
        <PageHeader back={{ href: '/student/results', label: 'My results' }} title="Course" />
        <ErrorState error={error} onRetry={() => refetch()} />
      </>
    );
  }
  if (isPending) return <PageLoading />;

  return (
    <>
      <PageHeader
        back={{ href: `/student/results?term=${data.termNumber}`, label: 'My results' }}
        title={data.title}
        description={`Term ${data.termNumber} · ${data.courseCode}`}
      />
      <div className="space-y-4">
        <CourseResult course={data} defaultOpen />
        {data.status !== 'NOT_CONFIGURED' ? (
          <Card size="sm">
            <CardContent className="flex gap-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="space-y-1">
                <p className="font-medium text-foreground">How your score is calculated</p>
                <p>
                  Each criterion contributes <em>mark ÷ max mark × weight</em>. The weights add up
                  to 100, so the contributions add up to your final score out of 100. A missing mark
                  is not counted as zero: the final score appears only when every mark is in.
                  &ldquo;Absent&rdquo; counts as 0.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
