'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { AuthShell } from '@/components/app/auth-shell';
import { ChangePasswordForm } from '@/components/app/change-password-form';
import { PageLoading } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { homeFor, useAuth } from '@/lib/auth';

/** Shown after signing in with a temporary password; every other page is blocked until done. */
export function ForcedPasswordChange() {
  const { me, loading, refresh, signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!me) router.replace('/login');
    else if (!me.mustChangePassword) router.replace(homeFor(me));
  }, [loading, me, router]);

  if (!me?.mustChangePassword) return <PageLoading />;

  return (
    <AuthShell
      title="Choose a new password"
      description={`Signed in as ${me.student?.studentCode ?? me.username}. Replace your temporary password to continue.`}
    >
      <div className="space-y-4">
        <ChangePasswordForm
          currentLabel="Temporary password"
          submitLabel="Save and continue"
          onDone={async () => {
            toast.success('Password changed.');
            await refresh();
          }}
        />
        <Button variant="link" className="px-0" onClick={() => void signOut()}>
          Sign out instead
        </Button>
      </div>
    </AuthShell>
  );
}
