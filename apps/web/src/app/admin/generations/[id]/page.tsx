'use client';

import {
  Archive,
  ArchiveRestore,
  BookOpen,
  FileSpreadsheet,
  Pencil,
  Plus,
  RefreshCw,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Confirm } from '@/components/app/confirm';
import { Field, fieldErrors, onSubmit } from '@/components/app/form';
import { PageHeader, Section } from '@/components/app/page-header';
import { StatusPill } from '@/components/app/status';
import { ErrorState, PageLoading } from '@/components/app/states';
import { TermSheet } from '@/components/admin/term-sheet';
import { useStartSync } from '@/components/admin/use-start-sync';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch, errorCode } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { json, useApi, useApiMutation } from '@/lib/query';
import type { GenerationDetail, Source, Term, TermDetail } from '@/lib/types';

function DatesFields({
  start,
  end,
  errors,
  startRequired,
}: {
  start: string | null;
  end: string | null;
  errors: Record<string, string>;
  startRequired?: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Start date" required={startRequired} error={errors.startDate}>
        {(p) => <Input {...p} name="startDate" type="date" defaultValue={start ?? ''} />}
      </Field>
      <Field label="End date" error={errors.endDate}>
        {(p) => <Input {...p} name="endDate" type="date" defaultValue={end ?? ''} />}
      </Field>
    </div>
  );
}

function rangeError(error: unknown): Record<string, string> {
  const errors = fieldErrors(error);
  if (errorCode(error) === 'INVALID_DATE_RANGE')
    errors.endDate = 'Must be on or after the start date.';
  return errors;
}

function EditGenerationDialog({ generation }: { generation: GenerationDetail }) {
  const [open, setOpen] = useState(false);
  const update = useApiMutation(
    (body: object) => apiFetch(`/admin/generations/${generation.id}`, json(body, 'PATCH')),
    {
      success: 'Generation updated.',
      invalidate: ['/admin/generations'],
      onSuccess: () => setOpen(false),
    },
  );
  const errors = rangeError(update.error);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="outline" disabled={generation.status === 'ARCHIVED'} />}
      >
        <Pencil aria-hidden />
        Edit
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={onSubmit((d) =>
            update.mutate({
              name: String(d.get('name')).trim(),
              startDate: String(d.get('startDate')),
              endDate: String(d.get('endDate')) || null,
            }),
          )}
        >
          <DialogHeader>
            <DialogTitle>Edit {generation.code}</DialogTitle>
            <DialogDescription>
              The code cannot change: it links the generation to its spreadsheets.
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" required error={errors.name}>
            {(p) => <Input {...p} name="name" defaultValue={generation.name} maxLength={120} />}
          </Field>
          <DatesFields
            start={generation.startDate}
            end={generation.endDate}
            errors={errors}
            startRequired
          />
          <DialogFooter>
            <Button type="submit" disabled={update.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditTermDialog({
  term,
  disabled,
  generationId,
}: {
  term: Term;
  disabled: boolean;
  generationId: string;
}) {
  const [open, setOpen] = useState(false);
  const update = useApiMutation(
    (body: object) => apiFetch(`/admin/terms/${term.id}`, json(body, 'PATCH')),
    {
      success: `${term.name} updated.`,
      invalidate: [`/admin/generations/${generationId}`],
      onSuccess: () => setOpen(false),
    },
  );
  const errors = rangeError(update.error);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" disabled={disabled} />}>
        <Pencil aria-hidden />
        <span className="sr-only sm:not-sr-only">Edit</span>
        <span className="sr-only"> {term.name}</span>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={onSubmit((d) =>
            update.mutate({
              name: String(d.get('name')).trim(),
              startDate: String(d.get('startDate')) || null,
              endDate: String(d.get('endDate')) || null,
            }),
          )}
        >
          <DialogHeader>
            <DialogTitle>Edit term {term.number}</DialogTitle>
            <DialogDescription>
              Students see the term name and dates on their results.
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" required error={errors.name}>
            {(p) => <Input {...p} name="name" defaultValue={term.name} maxLength={80} />}
          </Field>
          <DatesFields start={term.startDate} end={term.endDate} errors={errors} />
          <DialogFooter>
            <Button type="submit" disabled={update.isPending}>
              Save term
            </Button>
          </DialogFooter>
        </form>
        <TermSheet term={term} />
      </DialogContent>
    </Dialog>
  );
}

const SOURCE_ERRORS: Record<string, string> = {
  INVALID_URL: 'This is not a valid URL.',
  UNSUPPORTED_HOST: 'Only docs.google.com spreadsheet links are supported.',
  NOT_A_SPREADSHEET_URL: 'This link is not a Google Sheets spreadsheet.',
  SOURCE_EXISTS: 'This spreadsheet is already connected.',
  SHEET_NOT_SHARED: 'The spreadsheet is not shared with the service account (Viewer access).',
  SHEET_NOT_FOUND: 'The spreadsheet does not exist or was deleted.',
};

function ConnectWorkbookDialog({
  generation,
  term,
}: {
  generation: GenerationDetail;
  term: TermDetail;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const account = useApi<{ configured: boolean; email: string | null }>(
    open ? '/admin/sources/service-account' : null,
  );
  const add = useApiMutation(
    (body: { url: string; label: string }) =>
      apiFetch<Source>(`/admin/terms/${term.id}/sources`, json(body)),
    {
      success: (s) => `Connected "${s.label}". Detect its tabs next.`,
      invalidate: [`/admin/generations/${generation.id}`],
      onSuccess: (s) => router.push(`/admin/sources/${s.id}`),
    },
  );
  const errors = fieldErrors(add.error);
  const code = errorCode(add.error);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="outline" size="sm" disabled={generation.status === 'ARCHIVED'} />}
      >
        <Plus aria-hidden />
        Connect workbook
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={onSubmit((d) =>
            add.mutate({ url: String(d.get('url')).trim(), label: String(d.get('label')).trim() }),
          )}
        >
          <DialogHeader>
            <DialogTitle>Connect the {term.name} workbook</DialogTitle>
            <DialogDescription>
              One workbook per term, one tab per subject, with the student list in the{' '}
              <code>ALL</code> tab. If it has a <code>_meta</code> tab, that tab must say{' '}
              <code>{generation.code}</code> and term {term.number}.
            </DialogDescription>
          </DialogHeader>
          {account.data ? (
            account.data.configured ? (
              <Alert>
                <FileSpreadsheet aria-hidden />
                <AlertTitle>Share the file first</AlertTitle>
                <AlertDescription>
                  Give <strong className="break-all">{account.data.email}</strong> Viewer access to
                  the spreadsheet.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="destructive">
                <AlertTitle>Google access is not configured</AlertTitle>
                <AlertDescription>
                  The server has no service-account key, so spreadsheets cannot be read yet.
                </AlertDescription>
              </Alert>
            )
          ) : null}
          <Field
            label="Spreadsheet URL"
            required
            error={errors.url ?? (code && SOURCE_ERRORS[code]) ?? null}
          >
            {(p) => (
              <Input
                {...p}
                name="url"
                type="url"
                placeholder="https://docs.google.com/spreadsheets/d/…"
                autoFocus
              />
            )}
          </Field>
          <Field
            label="Label"
            required
            hint="How the workbook appears in lists, e.g. “Term 1 scores”."
            error={errors.label}
          >
            {(p) => (
              <Input {...p} name="label" maxLength={120} defaultValue={`${term.name} scores`} />
            )}
          </Field>
          {add.error && code && !SOURCE_ERRORS[code] && !errors.url ? (
            <p className="text-sm text-destructive" role="alert">
              {add.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? 'Checking the file…' : 'Connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReleaseButton({ term, disabled }: { term: TermDetail; disabled: boolean }) {
  const released = term.subjects > 0 && term.visibleSubjects === term.subjects;
  const release = useApiMutation(
    (visible: boolean) =>
      apiFetch<{ visible: boolean }>(`/admin/terms/${term.id}/release`, json({ visible })),
    {
      success: (r) =>
        r.visible ? `${term.name} released to students.` : `${term.name} hidden from students.`,
      invalidate: ['/admin/generations', '/admin/dashboard'],
    },
  );
  if (term.subjects === 0) return null;
  return released ? (
    <Confirm
      trigger={
        <Button variant="outline" size="sm" disabled={disabled}>
          Hide scores
        </Button>
      }
      title={`Hide ${term.name} from students?`}
      description="Students stop seeing the scores of this term until you release it again. Nothing is deleted."
      confirmLabel="Hide scores"
      onConfirm={() => release.mutateAsync(false)}
    />
  ) : (
    <Confirm
      trigger={
        <Button size="sm" disabled={disabled}>
          Release scores
        </Button>
      }
      title={`Release ${term.name} to students?`}
      description={`Students will see their scores for all ${term.subjects} subjects of this term.`}
      confirmLabel="Release scores"
      onConfirm={() => release.mutateAsync(true)}
    />
  );
}

export default function GenerationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const {
    data: g,
    error,
    isPending,
    refetch,
  } = useApi<GenerationDetail>(`/admin/generations/${id}`);
  const sources = useApi<Source[]>(`/admin/generations/${id}/sources`);
  const startSync = useStartSync();
  const setStatus = useApiMutation(
    (action: 'archive' | 'activate') =>
      apiFetch(`/admin/generations/${id}/${action}`, { method: 'POST' }),
    {
      success: 'Generation status updated.',
      invalidate: ['/admin/generations', '/admin/dashboard'],
    },
  );

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isPending) return <PageLoading />;
  const archived = g.status === 'ARCHIVED';
  const activeSources = sources.data?.filter((s) => s.status === 'ACTIVE').length ?? 0;

  return (
    <>
      <PageHeader
        back={{ href: '/admin/generations', label: 'Generations' }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {g.name}
            <StatusPill tone={archived ? 'neutral' : 'success'}>
              {archived ? 'Archived' : 'Active'}
            </StatusPill>
          </span>
        }
        description={
          <>
            <span className="font-mono">{g.code}</span> · {formatDate(g.startDate)} –{' '}
            {g.endDate ? formatDate(g.endDate) : 'ongoing'}
          </>
        }
        actions={
          <>
            <EditGenerationDialog generation={g} />
            {archived ? (
              <Button
                variant="outline"
                onClick={() => setStatus.mutate('activate')}
                disabled={setStatus.isPending}
              >
                <ArchiveRestore aria-hidden />
                Activate
              </Button>
            ) : (
              <Confirm
                trigger={
                  <Button variant="outline">
                    <Archive aria-hidden />
                    Archive
                  </Button>
                }
                title={`Archive ${g.code}?`}
                description="Terms and workbooks become read-only and syncs are refused. Students keep seeing their results. You can activate it again later."
                confirmLabel="Archive generation"
                onConfirm={() => setStatus.mutateAsync('archive')}
              />
            )}
            <Button
              disabled={archived || activeSources === 0 || startSync.isPending}
              onClick={() => startSync.mutate({ scope: 'GENERATION', generationId: g.id })}
            >
              <RefreshCw aria-hidden />
              Sync all workbooks
            </Button>
          </>
        }
      />

      {archived ? (
        <Alert className="mb-6">
          <Archive aria-hidden />
          <AlertTitle>This generation is archived</AlertTitle>
          <AlertDescription>
            Configuration is read-only and syncs are refused until it is activated.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-8">
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            {
              label: 'Students',
              value: g.counts.students,
              href: `/admin/students?generationId=${g.id}`,
              icon: Users,
            },
            {
              label: 'Subjects',
              value: g.counts.offerings,
              href: '#terms',
              icon: BookOpen,
            },
            {
              label: 'Workbooks',
              value: g.counts.sources,
              href: '#terms',
              icon: FileSpreadsheet,
            },
          ].map((s) => (
            <Link
              key={s.label}
              href={s.href}
              className="rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Card className="transition-colors hover:bg-muted/40">
                <CardHeader>
                  <CardDescription className="flex items-center gap-2">
                    <s.icon className="size-4" aria-hidden />
                    {s.label}
                  </CardDescription>
                  <CardTitle className="text-2xl tabular-nums">{s.value}</CardTitle>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>

        <div id="terms" className="scroll-mt-20">
          <Section
            title="Terms"
            description="Connect one workbook per term, confirm its tabs and sync. Scores stay hidden from students until you release the term."
          >
            {sources.error ? (
              <ErrorState error={sources.error} onRetry={() => sources.refetch()} />
            ) : null}
            <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Workbook</TableHead>
                    <TableHead>Scores</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.terms.map((t) => {
                    const own = sources.data?.filter((s) => s.term.id === t.id);
                    const source = own?.find((s) => s.status === 'ACTIVE');
                    const pending = own?.find((s) => s.status === 'PENDING');
                    return (
                      <TableRow key={t.id}>
                        <TableCell className="tabular-nums">{t.number}</TableCell>
                        <TableCell className="font-medium">
                          {t.name}
                          <span className="block text-xs font-normal text-muted-foreground">
                            {t.startDate || t.endDate
                              ? `${formatDate(t.startDate)} – ${formatDate(t.endDate)}`
                              : 'No dates'}
                          </span>
                        </TableCell>
                        <TableCell>
                          {source ? (
                            <Link href={`/admin/sources/${source.id}`} className="hover:underline">
                              {source.label}
                              <span className="block text-xs text-muted-foreground">
                                Last sync {formatDateTime(source.lastSyncedAt)}
                              </span>
                            </Link>
                          ) : !own || pending ? null : own.some((s) => s.lastSyncedAt) ? (
                            <span className="text-muted-foreground">
                              No sheet connected
                              <span className="block text-xs">
                                Scores stay. Connect a new sheet from Edit.
                              </span>
                            </span>
                          ) : (
                            <ConnectWorkbookDialog generation={g} term={t} />
                          )}
                          {pending ? (
                            <Link
                              href={`/admin/sources/${pending.id}`}
                              className="mt-1 block hover:underline"
                            >
                              <StatusPill tone="warning">
                                New sheet connected, not synced yet
                              </StatusPill>
                              <span className="block text-xs text-muted-foreground">
                                {pending.label}
                              </span>
                            </Link>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          {t.subjects === 0 ? (
                            <span className="text-muted-foreground">Not synced</span>
                          ) : (
                            <StatusPill tone={t.visibleSubjects ? 'success' : 'neutral'}>
                              {t.visibleSubjects === t.subjects
                                ? 'Released'
                                : t.visibleSubjects
                                  ? `${t.visibleSubjects} of ${t.subjects} released`
                                  : 'Hidden'}
                            </StatusPill>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="inline-flex items-center gap-2">
                            <ReleaseButton term={t} disabled={archived} />
                            <EditTermDialog term={t} disabled={archived} generationId={g.id} />
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
