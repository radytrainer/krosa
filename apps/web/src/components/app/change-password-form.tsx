'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Field, onSubmit } from '@/components/app/form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, apiFetch } from '@/lib/api';
import { json } from '@/lib/query';

interface Errors {
  currentPassword?: string;
  newPassword?: string[];
  confirm?: string;
  form?: string;
}

/**
 * POST /auth/change-password. The policy is enforced by the API; the form shows every policy
 * problem it reports. Other sessions are signed out by the API on success.
 */
export function ChangePasswordForm({
  submitLabel = 'Change password',
  currentLabel = 'Current password',
  onDone,
}: {
  submitLabel?: string;
  currentLabel?: string;
  onDone(): void | Promise<void>;
}) {
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  const submit = onSubmit(async (data, form) => {
    const currentPassword = String(data.get('currentPassword') ?? '');
    const newPassword = String(data.get('newPassword') ?? '');
    if (newPassword !== data.get('confirm')) {
      setErrors({ confirm: 'The passwords do not match.' });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await apiFetch('/auth/change-password', json({ currentPassword, newPassword }));
      form.reset();
      await onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WEAK_PASSWORD') {
        setErrors({ newPassword: err.details?.map((d) => d.message) ?? [err.message] });
      } else if (err instanceof ApiError && err.code === 'INVALID_CURRENT_PASSWORD') {
        setErrors({ currentPassword: 'This is not your current password.' });
      } else {
        setErrors({ form: err instanceof Error ? err.message : 'The request failed.' });
      }
    } finally {
      setBusy(false);
    }
  });

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label={currentLabel} required error={errors.currentPassword}>
        {(p) => (
          <Input
            {...p}
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            maxLength={128}
          />
        )}
      </Field>
      <Field
        label="New password"
        required
        hint="10–128 characters. Must not contain your username or student ID, or be a common password."
        error={errors.newPassword?.join(' ')}
      >
        {(p) => (
          <Input
            {...p}
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={128}
          />
        )}
      </Field>
      <Field label="Confirm new password" required error={errors.confirm}>
        {(p) => (
          <Input
            {...p}
            name="confirm"
            type="password"
            autoComplete="new-password"
            maxLength={128}
          />
        )}
      </Field>
      {errors.form ? (
        <p className="text-sm text-destructive" role="alert">
          {errors.form}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {submitLabel}
      </Button>
    </form>
  );
}
