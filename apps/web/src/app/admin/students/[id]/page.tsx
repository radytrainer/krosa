'use client';

import { Check, Copy, KeyRound, Power, ShieldAlert } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Confirm } from '@/components/app/confirm';
import { PageHeader, Section } from '@/components/app/page-header';
import { AccountStatusPill } from '@/components/app/status';
import { ErrorState, LoadingRows, PageLoading } from '@/components/app/states';
import { ResultsTabs, defaultTerm } from '@/components/results/results-tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api';
import { formatDateTime, humanize } from '@/lib/format';
import { json, useApi, useApiMutation } from '@/lib/query';
import type { IssuedCredential, Student, StudentResultsView } from '@/lib/types';

/** Shows a just-issued temporary password once. It is not kept anywhere after closing. */
function CredentialDialog({
  credential,
  onClose,
}: {
  credential: IssuedCredential | null;
  onClose(): void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open={credential !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Temporary password</DialogTitle>
          <DialogDescription>
            Give this to the student privately. It is shown only now, expires{' '}
            {formatDateTime(credential?.expiresAt)}, and must be changed at first sign-in.
          </DialogDescription>
        </DialogHeader>
        <dl className="space-y-3 rounded-lg bg-muted p-4">
          <div>
            <dt className="text-xs text-muted-foreground">Student ID</dt>
            <dd className="font-mono">{credential?.studentCode}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Temporary password</dt>
            <dd className="flex items-center gap-2">
              <code className="text-lg font-semibold break-all">
                {credential?.temporaryPassword}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(credential?.temporaryPassword ?? '');
                  setCopied(true);
                }}
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </dd>
          </div>
        </dl>
        <DialogFooter>
          <Button
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function StudentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [credential, setCredential] = useState<IssuedCredential | null>(null);
  const [term, setTerm] = useState<number | null>(null);
  const { data: s, error, isPending, refetch } = useApi<Student>(`/admin/students/${id}`);
  const results = useApi<StudentResultsView>(`/admin/students/${id}/results`);

  const reset = useApiMutation(
    () => apiFetch<IssuedCredential>(`/admin/students/${id}/reset-password`, { method: 'POST' }),
    { invalidate: ['/admin/students', '/admin/dashboard'], onSuccess: (c) => setCredential(c) },
  );
  const setStatus = useApiMutation(
    (status: 'ACTIVE' | 'DISABLED') =>
      apiFetch(`/admin/students/${id}/status`, json({ status }, 'PATCH')),
    { success: 'Account updated.', invalidate: ['/admin/students', '/admin/dashboard'] },
  );

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isPending) return <PageLoading />;
  const { account } = s;

  return (
    <>
      <PageHeader
        back={{ href: '/admin/students', label: 'Students' }}
        title={s.fullName}
        description={
          <>
            <span className="font-mono">{s.studentCode}</span> · {s.generation.code} ·{' '}
            {s.className ?? 'no class'}
          </>
        }
        actions={
          <>
            {account.status === 'DISABLED' ? (
              <Button
                variant="outline"
                onClick={() => setStatus.mutate('ACTIVE')}
                disabled={setStatus.isPending}
              >
                <Power aria-hidden />
                Enable account
              </Button>
            ) : (
              <Confirm
                trigger={
                  <Button variant="outline">
                    <Power aria-hidden />
                    Disable account
                  </Button>
                }
                title={`Disable ${s.fullName}'s account?`}
                description="The student is signed out everywhere and cannot sign in until the account is enabled again. Results are kept."
                confirmLabel="Disable account"
                destructive
                onConfirm={() => setStatus.mutateAsync('DISABLED')}
              />
            )}
            <Confirm
              trigger={
                <Button disabled={account.status === 'DISABLED'}>
                  <KeyRound aria-hidden />
                  {account.status === 'PENDING' ? 'Issue password' : 'Reset password'}
                </Button>
              }
              title={
                account.status === 'PENDING' ? 'Issue a temporary password?' : 'Reset the password?'
              }
              description={
                account.status === 'PENDING'
                  ? 'This activates the account. The student must choose a new password at first sign-in.'
                  : 'The current password stops working, the student is signed out everywhere, and must choose a new password at next sign-in.'
              }
              confirmLabel={account.status === 'PENDING' ? 'Issue password' : 'Reset password'}
              onConfirm={() => reset.mutateAsync(undefined)}
            />
          </>
        }
      />

      <div className="space-y-8">
        <div className="grid gap-4 md:grid-cols-2">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Profile</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Gender</dt>
                  <dd>{humanize(s.gender)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Generation</dt>
                  <dd>{s.generation.name}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Class</dt>
                  <dd>{s.className ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Imported</dt>
                  <dd>{formatDateTime(s.createdAt)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Account <AccountStatusPill status={account.status} />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Last sign-in</dt>
                  <dd>{account.lastLoginAt ? formatDateTime(account.lastLoginAt) : 'Never'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Password</dt>
                  <dd>
                    {account.status === 'PENDING'
                      ? 'Not issued'
                      : account.mustChangePassword
                        ? `Temporary, expires ${formatDateTime(account.temporaryPasswordExpiresAt)}`
                        : 'Chosen by the student'}
                  </dd>
                </div>
              </dl>
              {account.locked ? (
                <Alert variant="destructive">
                  <ShieldAlert aria-hidden />
                  <AlertTitle>Temporarily locked</AlertTitle>
                  <AlertDescription>
                    Too many failed sign-in attempts. The lock lifts automatically.
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <Section
          title="Results"
          description="Everything recorded for this student, including courses hidden from them and withdrawn enrollments."
        >
          {results.error ? (
            <ErrorState error={results.error} onRetry={() => results.refetch()} />
          ) : !results.data ? (
            <LoadingRows rows={4} />
          ) : (
            <ResultsTabs
              terms={results.data.terms}
              value={term ?? defaultTerm(results.data.terms)}
              onValueChange={setTerm}
              showAdmin
            />
          )}
        </Section>
      </div>

      <CredentialDialog credential={credential} onClose={() => setCredential(null)} />
    </>
  );
}
