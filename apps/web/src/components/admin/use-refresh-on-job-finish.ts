'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { isActiveJob } from '@/components/app/status';
import { apiKey } from '@/lib/query';
import type { SyncStatus } from '@/lib/types';

/**
 * When a job seen QUEUED or RUNNING here reaches a final state (SUCCEEDED, SUCCEEDED_WITH_ERRORS,
 * FAILED or CANCELLED), every admin view is refreshed at once, including pages not open now. A
 * sync can promote a waiting sheet, so its "not synced yet" notice must not survive in a cached
 * list. Jobs already finished when first seen change nothing.
 */
export function useRefreshOnJobFinish(jobs: readonly { id: string; status: SyncStatus }[] | null) {
  const queryClient = useQueryClient();
  const running = useRef(new Set<string>());

  useEffect(() => {
    if (!jobs) return;
    let finished = false;
    for (const job of jobs) {
      if (isActiveJob(job.status)) running.current.add(job.id);
      else if (running.current.delete(job.id)) finished = true;
    }
    if (finished) {
      void queryClient.invalidateQueries({ queryKey: apiKey('/admin'), refetchType: 'all' });
    }
  }, [jobs, queryClient]);
}
