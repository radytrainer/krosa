'use client';

import { toast } from 'sonner';
import { ChangePasswordForm } from '@/components/app/change-password-form';
import { PageHeader } from '@/components/app/page-header';
import { ErrorState, LoadingRows } from '@/components/app/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { humanize } from '@/lib/format';
import { useApi } from '@/lib/query';
import type { StudentProfileView } from '@/lib/types';

export default function StudentProfilePage() {
  const { data, error, refetch } = useApi<StudentProfileView>('/student/me');
  return (
    <>
      <PageHeader
        title="Profile"
        description="Your details come from the registrar's records. Ask the registrar to correct anything wrong."
      />
      <div className="grid max-w-3xl gap-6 md:grid-cols-[1fr_1.4fr]">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Your details</CardTitle>
          </CardHeader>
          <CardContent>
            {error ? (
              <ErrorState error={error} onRetry={() => refetch()} />
            ) : !data ? (
              <LoadingRows rows={4} />
            ) : (
              <dl className="space-y-3 text-sm">
                {[
                  ['Full name', data.fullName],
                  ['Student ID', data.studentCode],
                  ['Generation', `${data.generation.name} (${data.generation.code})`],
                  ['Gender', humanize(data.gender)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-medium">{value}</dd>
                  </div>
                ))}
                <div>
                  <dt className="text-muted-foreground">Program and class by term</dt>
                  {data.terms.length === 0 ? (
                    <dd className="font-medium">—</dd>
                  ) : (
                    data.terms.map((t) => (
                      <dd key={t.termNumber} className="font-medium">
                        {t.termName}: {t.program.name}, class {t.className}
                      </dd>
                    ))
                  )}
                </div>
              </dl>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>
              You stay signed in here; other devices are signed out.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm onDone={() => void toast.success('Password changed.')} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
