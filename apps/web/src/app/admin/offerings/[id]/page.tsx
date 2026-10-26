'use client';

import { Eye, EyeOff, FileSpreadsheet, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CriteriaManager } from '@/components/admin/criteria-manager';
import { SchemeEditor } from '@/components/admin/scheme-editor';
import { Field, fieldErrors, onSubmit } from '@/components/app/form';
import { PageHeader } from '@/components/app/page-header';
import { StatusPill } from '@/components/app/status';
import { ErrorState, LoadingRows, PageLoading } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiFetch } from '@/lib/api';
import { json, useApi, useApiMutation } from '@/lib/query';
import type { Criterion, GenerationDetail, Offering, Scheme } from '@/lib/types';

function EditOfferingDialog({ offering, disabled }: { offering: Offering; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const save = useApiMutation(
    (body: object) => apiFetch(`/admin/offerings/${offering.id}`, json(body, 'PATCH')),
    {
      success: 'Offering updated.',
      invalidate: ['/admin/offerings'],
      onSuccess: () => setOpen(false),
    },
  );
  const errors = fieldErrors(save.error);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" disabled={disabled} />}>
        <Pencil aria-hidden />
        Edit
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={onSubmit((d) =>
            save.mutate({
              title: String(d.get('title')).trim(),
              credits: String(d.get('credits')).trim(),
            }),
          )}
        >
          <DialogHeader>
            <DialogTitle>Edit offering</DialogTitle>
            <DialogDescription>
              {offering.sourceId
                ? 'A later sync may overwrite these values from the spreadsheet.'
                : 'Shown to students on their results.'}
            </DialogDescription>
          </DialogHeader>
          <Field label="Title" required error={errors.title}>
            {(p) => <Input {...p} name="title" defaultValue={offering.title} maxLength={160} />}
          </Field>
          <Field
            label="Credits"
            required
            hint="Used to weight term averages."
            error={errors.credits}
          >
            {(p) => (
              <Input
                {...p}
                name="credits"
                defaultValue={offering.credits}
                inputMode="decimal"
                pattern="\d{1,3}(\.\d)?"
              />
            )}
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function OfferingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: o, error, isPending, refetch } = useApi<Offering>(`/admin/offerings/${id}`);
  const generation = useApi<GenerationDetail>(o ? `/admin/generations/${o.generationId}` : null);
  const criteria = useApi<Criterion[]>(`/admin/offerings/${id}/criteria`);
  const schemes = useApi<Scheme[]>(`/admin/offerings/${id}/grading-schemes`);
  const visibility = useApiMutation(
    (v: 'VISIBLE' | 'HIDDEN') =>
      apiFetch(`/admin/offerings/${id}`, json({ visibility: v }, 'PATCH')),
    {
      success: 'Visibility updated.',
      invalidate: ['/admin/offerings', '/admin/dashboard'],
    },
  );

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isPending) return <PageLoading />;
  const readOnly = generation.data?.status === 'ARCHIVED';
  const visible = o.visibility === 'VISIBLE';
  const published = schemes.data?.find((s) => s.status === 'PUBLISHED');

  return (
    <>
      <PageHeader
        back={{
          href: `/admin/offerings?generationId=${o.generationId}`,
          label: 'Course offerings',
        }}
        title={o.title}
        description={
          <>
            <span className="font-mono">{o.course.code}</span> · {o.term.name} ·{' '}
            {generation.data?.code ?? '…'} · {o.credits} credits · key{' '}
            <span className="font-mono">{o.externalKey}</span>
          </>
        }
        actions={<EditOfferingDialog offering={o} disabled={readOnly} />}
      />

      <div className="space-y-8">
        {readOnly ? (
          <Alert>
            <AlertTitle>Read-only</AlertTitle>
            <AlertDescription>This offering belongs to an archived generation.</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <Card size="sm">
            <CardContent className="flex items-start gap-3">
              <Switch
                id="visibility"
                checked={visible}
                disabled={readOnly || visibility.isPending}
                onCheckedChange={(v) => visibility.mutate(v ? 'VISIBLE' : 'HIDDEN')}
              />
              <div className="space-y-1">
                <label htmlFor="visibility" className="flex items-center gap-2 text-sm font-medium">
                  {visible ? (
                    <Eye className="size-4" aria-hidden />
                  ) : (
                    <EyeOff className="size-4" aria-hidden />
                  )}
                  Visible to students
                </label>
                <p className="text-xs text-muted-foreground">
                  {o.visibilityOverridden
                    ? 'Set by an administrator; the sheet no longer controls it.'
                    : "Controlled by the sheet's visible column until you change it here."}
                </p>
                {visible && !published ? (
                  <p className="text-xs text-warning">
                    Students see “Not graded yet” until a scheme is published.
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardContent className="flex items-start gap-3 text-sm">
              <FileSpreadsheet className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
              <div className="space-y-1">
                <p className="font-medium">
                  {o.sourceId ? 'Managed by a spreadsheet' : 'Created manually'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {o.sourceId ? (
                    <>
                      Tab <span className="font-mono">{o.sheetTab ?? '—'}</span> of{' '}
                      <Link href={`/admin/sources/${o.sourceId}`} className="underline">
                        its source
                      </Link>
                      . Marks are imported by sync.
                    </>
                  ) : (
                    'No spreadsheet supplies marks for this offering.'
                  )}
                </p>
                <div className="flex flex-wrap gap-1 pt-1">
                  {published ? (
                    <StatusPill tone="success">Scheme v{published.version} published</StatusPill>
                  ) : (
                    <StatusPill tone="warning">No published scheme</StatusPill>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <CriteriaManager
          offeringId={o.id}
          criteria={criteria.data}
          error={criteria.error}
          onRetry={() => criteria.refetch()}
          readOnly={readOnly}
        />

        {criteria.data && schemes.data ? (
          <SchemeEditor
            key={published?.id ?? 'none'}
            offeringId={o.id}
            criteria={criteria.data}
            schemes={schemes.data}
            readOnly={readOnly}
          />
        ) : schemes.error ? (
          <ErrorState error={schemes.error} onRetry={() => schemes.refetch()} />
        ) : (
          <LoadingRows rows={4} />
        )}
      </div>
    </>
  );
}
