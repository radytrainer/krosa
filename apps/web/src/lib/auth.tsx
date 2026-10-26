'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { ApiError, apiFetch } from './api';
import type { Me, Role } from './types';

interface AuthState {
  me: Me | null;
  loading: boolean;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);
const ME_KEY = ['auth', 'me'];

/** Where each role lands after signing in. */
export function homeFor(me: Pick<Me, 'role' | 'mustChangePassword'>): string {
  if (me.mustChangePassword) return '/change-password';
  return me.role === 'ADMIN' ? '/admin' : '/student';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await apiFetch<Me>('/auth/me');
      } catch (err) {
        // Signed out is a normal state, not an error.
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
  });

  /**
   * Revokes the session, then reloads the page at /login. A full load (not client navigation)
   * discards every cached query and every kept-alive page, so nothing of this user's data
   * survives in the tab for the next person on a shared computer.
   */
  const signOut = useCallback(async () => {
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => undefined);
    queryClient.clear();
    window.location.replace('/login');
  }, [queryClient]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
  }, [queryClient]);

  return (
    <AuthContext.Provider value={{ me: data ?? null, loading: isPending, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * Client-side gate for a portal. The API enforces every rule; this only routes users to the
 * page they can use (sign-in, forced password change, or their own portal).
 */
export function useRequireRole(role: Role): Me | null {
  const { me, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const target = loading
    ? null
    : !me
      ? `/login?next=${encodeURIComponent(pathname)}`
      : me.mustChangePassword
        ? '/change-password'
        : me.role !== role
          ? homeFor(me)
          : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [router, target]);

  return !loading && !target ? me : null;
}
