'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { apiKey, json } from '@/lib/query';
import type { SyncScope } from '@/lib/types';

export interface SyncTarget {
  scope: SyncScope;
  sourceId?: string;
  generationId?: string;
}

const MESSAGES: Record<string, string> = {
  SOURCE_DISABLED: 'This source is disabled. Enable it before syncing.',
  GENERATION_ARCHIVED: 'This generation is archived. Activate it before syncing.',
  NO_SOURCES: 'There are no active sheet sources to sync.',
  QUEUE_UNAVAILABLE: 'The job queue is unavailable. Try again in a minute.',
  RATE_LIMITED: 'Too many sync requests. Wait a minute and try again.',
};

/** POST /admin/sync, then open the job page (or the job already running for this source). */
export function useStartSync() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (target: SyncTarget) => apiFetch<{ jobId: string }>('/admin/sync', json(target)),
    onSuccess: async ({ jobId }) => {
      await queryClient.invalidateQueries({ queryKey: apiKey('/admin') });
      toast.success('Sync queued.');
      router.push(`/admin/sync/${jobId}`);
    },
    onError: (error) => {
      const jobId = error instanceof ApiError ? error.data.jobId : undefined;
      if (
        error instanceof ApiError &&
        error.code === 'SYNC_IN_PROGRESS' &&
        typeof jobId === 'string'
      ) {
        toast.info('A sync of this source is already running.', {
          action: { label: 'View', onClick: () => router.push(`/admin/sync/${jobId}`) },
        });
        return;
      }
      const code = error instanceof ApiError ? error.code : '';
      toast.error(MESSAGES[code] ?? error.message);
    },
  });
}
