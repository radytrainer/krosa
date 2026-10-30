'use client';

import { ExternalLink, Pencil, Power, RefreshCw, TriangleAlert } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { SyncJobsTable } from '@/components/admin/sync-jobs-table';
import { SheetPreviewPanel } from '@/components/admin/sheet-preview';
import { TermMappings } from '@/components/admin/term-mappings';
import { useStartSync } from '@/components/admin/use-start-sync';
import { Confirm } from '@/components/app/confirm';
import { Field, fieldErrors, onSubmit } from '@/components/app/form';
import { PageHeader, Section } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
import { ActivePill, StatusPill } from '@/components/app/status';
import { EmptyState, ErrorState, LoadingRows, PageLoading } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { json, qs, useApi, useApiMutation } from '@/lib/query';
import type { Paginated, SheetPreview, Source, SyncJob, TermWorkbooks } from '@/lib/types';

function RenameDialog({ source }: { source: Source }) {
  const [open, setOpen] = useState(false);
  const update = useApiMutation(
    (label: string) => apiFetch(`/admin/sources/${source.id}`, json({ label }, 'PATCH')),
    {
      success: 'Label updated.',
      invalidate: ['/admin/sources', '/admin/generations'],
      onSuccess: () => setOpen(false),
    },
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        <Pencil aria-hidden />
        Rename
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={onSubmit((d) => update.mutate(String(d.get('label')).trim()))}
        >
          <DialogHeader>
            <DialogTitle>Rename source</DialogTitle>
          </DialogHeader>
          <Field label="Label" required error={fieldErrors(update.error).label}>
            {(p) => (
              <Input {...p} name="label" defaultValue={source.label} maxLength={120} autoFocus />
            )}
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function SourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [page, setPage] = useState(1);
  const { data: s, error, isPending, refetch } = useApi<Source>(`/admin/sources/${id}`);
  const history = useApi<Paginated<SyncJob>>(
    `/admin/sources/${id}/sync-history${qs({ page, pageSize: 10 })}`,
    {
      keepPrevious: true,
    },
  );
  const startSync = useStartSync();
  const preview = useApi<SheetPreview | null>(`/admin/sources/${id}/preview`);
  const workbooks = useApi<TermWorkbooks[]>('/admin/term-workbooks');
  const discard = useApiMutation(
    () => apiFetch(`/admin/sources/${id}/discard`, { method: 'POST' }),
    {
      success: 'New sheet discarded. The current sheet stays active.',
      invalidate: ['/admin/sources', '/admin/term-workbooks', '/admin/generations'],
    },
  );
  const setStatus = useApiMutation(
    (status: 'ACTIVE' | 'DISABLED') => apiFetch(`/admin/sources/${id}`, json({ status }, 'PATCH')),
    {
      success: 'Source updated.',
      invalidate: [
        '/admin/sources',
        '/admin/term-workbooks',
        '/admin/generations',
        '/admin/dashboard',
      ],
    },
  );

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isPending) return <PageLoading />;
  const active = s.status === 'ACTIVE';
  const pending = s.status === 'PENDING';
  const term = workbooks.data?.find((w) => w.term.id === s.term.id);
  const previewConfirmed = Boolean(preview.data?.confirmedAt);

  return (
    <>
      <PageHeader
        back={{ href: `/admin/generations/${s.generation.id}#terms`, label: s.generation.name }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {s.label}
            {pending ? (
              <StatusPill tone="warning">Pending</StatusPill>
            ) : (
              <ActivePill active={active} />
            )}
          </span>
        }
        description={`${s.generation.name}, ${s.term.name} · ${s.spreadsheetTitle ?? s.spreadsheetId}`}
        actions={
          <>
            <a
              href={s.spreadsheetUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={buttonVariants({ variant: 'ghost' })}
            >
              <ExternalLink aria-hidden />
              Open sheet<span className="sr-only"> (opens in a new tab)</span>
            </a>
            <RenameDialog source={s} />
            {pending ? (
              <Confirm
                trigger={<Button variant="outline">Discard new sheet</Button>}
                title="Discard this new sheet?"
                description="It goes back to this term's history. The current sheet stays active and student scores do not change."
                confirmLabel="Discard"
                destructive
                onConfirm={() => discard.mutateAsync(undefined)}
              />
            ) : active ? (
              <Confirm
                trigger={
                  <Button variant="outline">
                    <Power aria-hidden />
                    Disable
                  </Button>
                }
                title="Disable this source?"
                description="Syncs will skip it. Data already imported stays as it is."
                confirmLabel="Disable source"
                destructive
                onConfirm={() => setStatus.mutateAsync('DISABLED')}
              />
            ) : (
              <Button variant="outline" onClick={() => setStatus.mutate('ACTIVE')}>
                <Power aria-hidden />
                Enable
              </Button>
            )}
            <Button
              disabled={(pending ? !previewConfirmed : !active) || startSync.isPending}
              onClick={() => startSync.mutate({ scope: 'SOURCE', sourceId: s.id })}
            >
              <RefreshCw aria-hidden />
              Sync now
            </Button>
          </>
        }
      />

      <div className="space-y-8">
        {pending ? (
          <Alert>
            <TriangleAlert aria-hidden />
            <AlertTitle>New sheet connected, not synced yet</AlertTitle>
            <AlertDescription>
              {term?.active
                ? `"${term.active.label}" is still feeding student scores. `
                : 'No sheet is feeding student scores. '}
              Confirm the tabs below, run and confirm a preview, then sync. Student scores change
              only when that sync completes.
            </AlertDescription>
          </Alert>
        ) : null}
        <Card size="sm">
          <CardContent>
            <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Term</dt>
                <dd className="font-medium">
                  {s.generation.code} · {s.term.name}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Subjects synced</dt>
                <dd className="font-medium tabular-nums">{s.ownedOfferings}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Last successful sync</dt>
                <dd className="font-medium">{formatDateTime(s.lastSyncedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Connected</dt>
                <dd className="font-medium">
                  {formatDateTime(s.createdAt)} by {s.createdBy.username}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Section title="Subject tabs">
          <TermMappings sourceId={s.id} readOnly={!active && !pending} />
        </Section>

        {pending ? (
          <Section title="Preview">
            <SheetPreviewPanel sourceId={s.id} />
          </Section>
        ) : null}

        <Section title="Sync history">
          {history.error ? (
            <ErrorState error={history.error} onRetry={() => history.refetch()} />
          ) : !history.data ? (
            <LoadingRows rows={3} />
          ) : history.data.data.length === 0 ? (
            <EmptyState
              title="Never synchronized"
              description="Confirm the subject tabs, then choose “Sync now”."
            />
          ) : (
            <>
              <SyncJobsTable jobs={history.data.data} showTarget={false} />
              <Pagination {...history.data.meta} onPage={setPage} />
            </>
          )}
        </Section>
      </div>
    </>
  );
}
