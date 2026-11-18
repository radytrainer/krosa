'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, apiFetch, isCurrentSession, onSessionEnded } from './api';
import { startHeartbeat } from './heartbeat';
import { broadcastEnded, isCurrentSessionHash, startSessionLive } from './session-live';
import type { Me, Role, SessionEndReason } from './types';

interface AuthState {
  me: Me | null;
  loading: boolean;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  /**
   * For a 401 that the silent refresh could not fix: forgets the cached user and every cached
   * query, then loads the login page, which returns to `returnTo` (an internal path) after sign-in.
   */
  sessionExpired(returnTo: string): void;
  /**
   * The server ended the session and this tab is about to load the login page with the reason.
   * Meanwhile nothing else may redirect (a plain `/login?next=` would hide the reason).
   */
  sessionEnding: boolean;
}

const AuthContext = createContext<AuthState | null>(null);
const ME_KEY = ['auth', 'me'];

/** Defaults when `/auth/me` does not carry the session rules. */
const DEFAULT_HEARTBEAT_SECONDS = 300;
const IDLE_TIMEOUT_KEY = 'ssrs:idleTimeoutSeconds';

/** Kept for the login page, which shows the inactivity limit after the session is gone. */
function rememberIdleTimeout(seconds: number | undefined): void {
  if (!seconds) return;
  try {
    window.localStorage.setItem(IDLE_TIMEOUT_KEY, String(seconds));
  } catch {
    // Storage blocked: the login page falls back to the default text.
  }
}

/** The inactivity limit last seen in configuration, or null. */
export function rememberedIdleTimeout(): number | null {
  try {
    const value = Number(window.localStorage.getItem(IDLE_TIMEOUT_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * How long a tab waits before acting on "signed in elsewhere": a sign-in in this same browser
 * replaces the old session too, and its new cookies must have a moment to arrive, so that sign-in
 * never shows the "another browser" message.
 */
const ELSEWHERE_SETTLE_MS = 1_000;

/** Which session an end report is about: its marker (this tab) or its marker's hash (another tab). */
type EndedSource = { marker: string | undefined } | { markerHash: string | undefined };

/** True on a login page that already shows why the session ended. */
function showingEndReason(): boolean {
  return (
    window.location.pathname === '/login' &&
    new URLSearchParams(window.location.search).has('reason')
  );
}

/** Where a tab goes when the server ended its session. */
export function loginUrlFor(reason: SessionEndReason): string {
  if (reason === 'SIGNED_IN_ELSEWHERE') return '/login?reason=elsewhere';
  if (reason === 'IDLE_TIMEOUT') return '/login?reason=idle';
  return '/login';
}

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

  /** Set once this tab is leaving the session, so it leaves only once. */
  const ending = useRef(false);
  /** Set while a session end report is being checked (and, for "elsewhere", waited on). */
  const settling = useRef(false);
  const [sessionEnding, setSessionEnding] = useState(false);

  /**
   * Revokes the session, then reloads the page at /login. A full load (not client navigation)
   * discards every cached query and every kept-alive page, so nothing of this user's data
   * survives in the tab for the next person on a shared computer.
   */
  const signOut = useCallback(async () => {
    ending.current = true; // the live connection's `ended` for this logout is expected
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => undefined);
    queryClient.clear();
    window.location.replace('/login');
  }, [queryClient]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
  }, [queryClient]);

  const sessionExpired = useCallback(
    (returnTo: string) => {
      // A session end in progress loads the login page with its reason instead.
      if (ending.current || settling.current) return;
      queryClient.clear();
      window.location.replace(`/login?next=${encodeURIComponent(returnTo)}`);
    },
    [queryClient],
  );

  /**
   * The server ended this session (signed in elsewhere, idle, revoked): tell the other tabs,
   * forget every cached query and load the login page with the reason. Runs once per tab, and
   * only when the ended session is still this browser's session.
   */
  const sessionEnded = useCallback(
    async (reason: SessionEndReason, source: EndedSource) => {
      // Already handled, or the login page already says why (e.g. its own /auth/me check).
      if (ending.current || settling.current || showingEndReason()) return;
      settling.current = true;
      // From here on no page redirects on its own, whatever the /auth/me query now says.
      setSessionEnding(true);
      const fromOtherTab = 'markerHash' in source;
      let current = false;
      try {
        if (reason === 'SIGNED_IN_ELSEWHERE') {
          await new Promise((resolve) => setTimeout(resolve, ELSEWHERE_SETTLE_MS));
        }
        current =
          'markerHash' in source
            ? await isCurrentSessionHash(source.markerHash)
            : isCurrentSession(source.marker);
      } finally {
        settling.current = false;
      }
      if (!current) {
        // A newer sign-in in this browser replaced that session: stay, with the new session.
        setSessionEnding(false);
        void queryClient.invalidateQueries({ queryKey: ME_KEY });
        return;
      }
      ending.current = true;
      if (!fromOtherTab) await broadcastEnded(reason, source.marker).catch(() => undefined);
      queryClient.clear();
      window.location.replace(loginUrlFor(reason));
    },
    [queryClient],
  );

  // Any request or refresh answering SESSION_REPLACED / SESSION_IDLE lands here.
  useEffect(
    () => onSessionEnded((reason, marker) => void sessionEnded(reason, { marker })),
    [sessionEnded],
  );

  // Live connection and heartbeat, only while signed in.
  const signedIn = Boolean(data);
  const heartbeatSeconds = data?.session?.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
  const idleSeconds = data?.session?.idleTimeoutSeconds;
  useEffect(() => {
    if (!signedIn) return;
    rememberIdleTimeout(idleSeconds);
    const stopLive = startSessionLive({
      onEnded: (reason, marker) => void sessionEnded(reason, { marker }),
      onEndedElsewhere: (reason, markerHash) => void sessionEnded(reason, { markerHash }),
    });
    const stopHeartbeat = startHeartbeat({
      intervalSeconds: heartbeatSeconds,
      onEnded: (reason, marker) => void sessionEnded(reason, { marker }),
    });
    return () => {
      stopHeartbeat();
      stopLive();
    };
  }, [signedIn, heartbeatSeconds, idleSeconds, sessionEnded]);

  return (
    <AuthContext.Provider
      value={{
        me: data ?? null,
        loading: isPending,
        signOut,
        refresh,
        sessionExpired,
        sessionEnding,
      }}
    >
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
  const { me, loading, sessionEnding } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // While a session end is handled, its own full load to the login page wins.
  const target = loading || sessionEnding
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
