'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PageHeader } from '@/components/app/page-header';
import { ErrorState, PageLoading } from '@/components/app/states';
import { CourseResult } from '@/components/results/course-result';
import { Card, CardContent } from '@/components/ui/card';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { COURSE_UNAVAILABLE_REDIRECT } from '@/lib/notices';
import { apiKey, useFreshApi } from '@/lib/query';
import type { CourseResultView } from '@/lib/types';

/**
 * What the page does with a failed request. The API answers 404 alike for a hidden, withdrawn,
 * not-enrolled or nonexistent course (and 400 for an id that is not one), so all of them lead to
 * the same place with the same notice. A 401 that the silent refresh could not fix is a signed-out
 * session, never this notice.
 */
function outcome(error: Error | null): 'unavailable' | 'signed-out' | 'error' | null {
  if (!error) return null;
  if (error instanceof ApiError) {
    if (error.status === 401) return 'signed-out';
    if (error.status === 404 || error.status === 400) return 'unavailable';
  }
  return 'error';
}

export default function StudentCoursePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { sessionExpired } = useAuth();
  // A course can be hidden at any time: asked for on every visit and whenever the student comes
  // back to this tab, and never shown from a copy kept from an earlier visit.
  const { data, error, refetch } = useFreshApi<CourseResultView>(`/student/me/courses/${id}`, {
    refetchOnWindowFocus: true,
  });
  const result = outcome(error);

  useEffect(() => {
    if (result === 'unavailable') {
      // Lists cached from before the change could still show the course: drop them all.
      queryClient.removeQueries({ queryKey: apiKey('/student') });
      // A fixed internal route; nothing from the request decides where the student goes.
      router.replace(COURSE_UNAVAILABLE_REDIRECT);
    } else if (result === 'signed-out') {
      sessionExpired(`/student/courses/${id}`);
    }
  }, [result, id, queryClient, router, sessionExpired]);

  if (result === 'unavailable' || result === 'signed-out') return <PageLoading />;
  if (result === 'error') {
    return (
      <>
        <PageHeader back={{ href: '/student/results', label: 'My results' }} title="Course" />
        <ErrorState error={error} onRetry={() => refetch()} />
      </>
    );
  }
  if (!data) return <PageLoading />;

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
