'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageHeader } from '@/components/app/page-header';
import { ErrorState, LoadingRows, PageLoading } from '@/components/app/states';
import { ResultsTabs, defaultTerm } from '@/components/results/results-tabs';
import { useApi } from '@/lib/query';
import type { StudentResultsView } from '@/lib/types';

function Results() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { data, error, refetch } = useApi<StudentResultsView>('/student/me/results');

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (!data) return <LoadingRows rows={5} />;
  const requested = Number(params.get('term'));
  const term = data.terms.some((t) => t.number === requested) ? requested : defaultTerm(data.terms);

  return (
    <ResultsTabs
      terms={data.terms}
      value={term}
      onValueChange={(n) => router.replace(`${pathname}?term=${n}`, { scroll: false })}
      courseHref={(id) => `/student/courses/${id}`}
    />
  );
}

export default function StudentResultsPage() {
  return (
    <>
      <PageHeader
        title="My results"
        description="Marks, weights and contributions for every course, by term. A course's final score appears once all its marks are in."
      />
      <Suspense fallback={<PageLoading />}>
        <Results />
      </Suspense>
    </>
  );
}
