'use client';

import { toast } from 'sonner';
import { ChangePasswordForm } from '@/components/app/change-password-form';
import { PageHeader } from '@/components/app/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

export default function AdminAccountPage() {
  const { me } = useAuth();
  return (
    <>
      <PageHeader title="Account" description="Your administrator account." />
      <div className="grid max-w-3xl gap-6 md:grid-cols-[1fr_1.4fr]">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Username</dt>
                <dd className="font-medium">{me?.username}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Display name</dt>
                <dd className="font-medium">{me?.displayName ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Role</dt>
                <dd className="font-medium">Administrator</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>
              Your other sessions are signed out when the password changes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm
              onDone={() => void toast.success('Password changed. Other sessions were signed out.')}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
