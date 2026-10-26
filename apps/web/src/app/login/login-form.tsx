'use client';

import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Field, onSubmit } from '@/components/app/form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, apiFetch } from '@/lib/api';
import { homeFor, useAuth } from '@/lib/auth';
import { json } from '@/lib/query';
import type { Me } from '@/lib/types';

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'The username / student ID or password is incorrect.',
  ACCOUNT_LOCKED: 'Too many failed attempts. The account is locked for a few minutes.',
  RATE_LIMITED: 'Too many sign-in attempts. Please wait a moment and try again.',
  ACCOUNT_DISABLED: 'This account is disabled. Contact the registrar.',
  ACCOUNT_PENDING:
    'This account has not been activated yet. Contact the registrar for credentials.',
  TEMPORARY_PASSWORD_EXPIRED:
    'Your temporary password has expired. Ask the registrar to issue a new one.',
};

/** Only same-site relative paths; never `//host` or `/\host` (open redirect). */
function safeNext(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return null;
  }
  return value;
}

function destination(me: Me, next: string | null): string {
  if (me.mustChangePassword) return '/change-password';
  const home = homeFor(me);
  // Follow `next` only into the user's own portal.
  return next && next.startsWith(home) ? next : home;
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { me, loading } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get('next'));

  // Already signed in: go straight to the portal.
  useEffect(() => {
    if (!loading && me) router.replace(destination(me, next));
  }, [loading, me, next, router]);

  const submit = onSubmit(async (data, form) => {
    setBusy(true);
    setError(null);
    try {
      const { user } = await apiFetch<{ user: Me }>(
        '/auth/login',
        json({ identifier: String(data.get('identifier')).trim(), password: data.get('password') }),
      );
      queryClient.setQueryData(['auth', 'me'], user);
      // The page stays mounted (hidden) after navigating away: never leave the password in it.
      form.reset();
      setBusy(false);
      router.replace(destination(user, next));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (MESSAGES[err.code] ?? err.message)
          : 'The service is unreachable. Please try again.',
      );
      form.querySelector<HTMLInputElement>('input[name=password]')!.value = '';
      setBusy(false);
    }
  });

  return (
    <form onSubmit={submit} className="space-y-4" noValidate={false}>
      {error ? (
        <Alert variant="destructive" aria-live="assertive">
          <AlertCircle aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Field label="Username or student ID" required>
        {(p) => (
          <Input
            {...p}
            name="identifier"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            maxLength={64}
          />
        )}
      </Field>
      <Field label="Password" required>
        {(p) => (
          <Input
            {...p}
            name="password"
            type="password"
            autoComplete="current-password"
            maxLength={128}
          />
        )}
      </Field>
      <Button type="submit" className="w-full" size="lg" disabled={busy}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
        Sign in
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Students: your first password is given to you by the registrar.
      </p>
    </form>
  );
}
