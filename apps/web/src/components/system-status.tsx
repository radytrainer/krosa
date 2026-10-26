'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api';

/** Shows whether the API is reachable through the same-origin /api proxy. */
export function SystemStatus() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<{ status: string }>('/health'),
    refetchInterval: 30_000,
  });

  if (isPending) return <Skeleton className="h-5 w-28" aria-label="Checking service status" />;

  const online = !isError && data?.status === 'ok';
  return (
    <Badge variant={online ? 'secondary' : 'destructive'} role="status">
      <span
        aria-hidden
        className={`size-2 rounded-full ${online ? 'bg-emerald-500' : 'bg-current'}`}
      />
      {online ? 'Service online' : 'Service unavailable'}
    </Badge>
  );
}
