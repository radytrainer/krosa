import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, apiFetch } from './api';

type Params = Record<string, string | number | boolean | null | undefined>;

/** Builds `?a=1&b=x`, skipping empty values. */
export function qs(params: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** GET with a query key derived from the path, so invalidating a path prefix refreshes it. */
export function useApi<T>(
  path: string | null,
  options: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'> & { keepPrevious?: boolean } = {},
) {
  const { keepPrevious, ...rest } = options;
  return useQuery<T>({
    queryKey: apiKey(path ?? ''),
    queryFn: () => apiFetch<T>(path!),
    enabled: path !== null && (rest.enabled ?? true),
    ...(keepPrevious ? { placeholderData: keepPreviousData } : {}),
    ...rest,
  });
}

/** `/admin/sync/abc?x=1` → `['/admin', '/sync', '/abc', '?x=1']`, so prefixes match parents. */
export function apiKey(path: string): string[] {
  const [pathname = '', search] = path.split('?');
  const parts = pathname
    .split('/')
    .filter(Boolean)
    .map((p) => `/${p}`);
  return search ? [...parts, `?${search}`] : parts;
}

export function json(body: unknown, method = 'POST'): RequestInit {
  return { method, body: JSON.stringify(body) };
}

/**
 * Mutation that shows a toast on success or failure and invalidates the given path prefixes.
 * Field-level validation errors stay on the returned `error` for forms to display.
 */
export function useApiMutation<TVars, TResult = unknown>(
  run: (vars: TVars) => Promise<TResult>,
  options: {
    success?: string | ((result: TResult) => string);
    invalidate?: string[];
    onSuccess?: (result: TResult, vars: TVars) => void;
  } = {},
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, Error, TVars>({
    mutationFn: run,
    onSuccess: async (result, vars) => {
      await Promise.all(
        (options.invalidate ?? []).map((p) =>
          queryClient.invalidateQueries({ queryKey: apiKey(p) }),
        ),
      );
      const message =
        typeof options.success === 'function' ? options.success(result) : options.success;
      if (message) toast.success(message);
      options.onSuccess?.(result, vars);
    },
    onError: (error) => {
      if (!(error instanceof ApiError && error.details?.some((d) => d.field))) {
        toast.error(error.message || 'The request failed.');
      }
    },
  });
}
