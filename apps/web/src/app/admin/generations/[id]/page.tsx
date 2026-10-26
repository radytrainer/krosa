'use client';

import {
  Archive,
  ArchiveRestore,
  BookOpen,
  ExternalLink,
  FileSpreadsheet,
  Pencil,
  Plus,
  RefreshCw,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Confirm } from '@/components/app/confirm';
import { Field, fieldErrors, onSubmit } from '@/components/app/form';
import { PageHeader, Section } from '@/components/app/page-header';
import { ActivePill, StatusPill } from '@/components/app/status';
import { EmptyState, ErrorState, PageLoading } from '@/components/app/states';
import { useStartSync } from '@/components/admin/use-start-sync';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import type { GenerationDetail, Source, Term } from '@/lib/types';

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
      <DialogContent>
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

function AddSourceDialog({ generation }: { generation: GenerationDetail }) {
  const [open, setOpen] = useState(false);
  const account = useApi<{ configured: boolean; email: string | null }>(
    open ? '/admin/sources/service-account' : null,
  );
  const add = useApiMutation(
    (body: { url: string; label: string }) =>
      apiFetch<Source>(`/admin/generations/${generation.id}/sources`, json(body)),
    {
      success: (s) => `Connected "${s.label}". Preview it before the first sync.`,
      invalidate: [`/admin/generations/${generation.id}`],
      onSuccess: () => setOpen(false),
    },
  );
  const errors = fieldErrors(add.error);
  const code = errorCode(add.error);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="outline" disabled={generation.status === 'ARCHIVED'} />}
      >
        <Plus aria-hidden />
        Connect sheet
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={onSubmit((d) =>
            add.mutate({ url: String(d.get('url')).trim(), label: String(d.get('label')).trim() }),
          )}
        >
          <DialogHeader>
            <DialogTitle>Connect a Google Sheet</DialogTitle>
            <DialogDescription>
              The file must follow the template and its <code>_meta</code> tab must name{' '}
              <code>{generation.code}</code>.
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
            hint="How the source appears in lists, e.g. “Term marks 2026”."
            error={errors.label}
          >
            {(p) => <Input {...p} name="label" maxLength={120} />}
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
                description="Terms, offerings, criteria and grading schemes become read-only and syncs are refused. Students keep seeing their results. You can activate it again later."
                confirmLabel="Archive generation"
                onConfirm={() => setStatus.mutateAsync('archive')}
              />
            )}
            <Button
              disabled={archived || activeSources === 0 || startSync.isPending}
              onClick={() => startSync.mutate({ scope: 'GENERATION', generationId: g.id })}
            >
              <RefreshCw aria-hidden />
              Sync all sources
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
              label: 'Course offerings',
              value: g.counts.offerings,
              href: `/admin/offerings?generationId=${g.id}`,
              icon: BookOpen,
            },
            {
              label: 'Sheet sources',
              value: g.counts.sources,
              href: '#sources',
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

        <Section title="Terms" description="Every generation has exactly five terms.">
          <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Dates</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.terms.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="tabular-nums">{t.number}</TableCell>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {t.startDate || t.endDate
                        ? `${formatDate(t.startDate)} – ${formatDate(t.endDate)}`
                        : 'No dates'}
                    </TableCell>
                    <TableCell className="text-right">
                      <EditTermDialog term={t} disabled={archived} generationId={g.id} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>

        <div id="sources" className="scroll-mt-20">
          <Section
            title="Google Sheet sources"
            description="Spreadsheets that provide this generation's students, courses and marks."
            actions={<AddSourceDialog generation={g} />}
          >
            {sources.error ? (
              <ErrorState error={sources.error} onRetry={() => sources.refetch()} />
            ) : !sources.data ? null : sources.data.length === 0 ? (
              <EmptyState
                icon={<FileSpreadsheet className="size-8" />}
                title="No spreadsheets connected"
                description="Connect the generation's Google Sheet, preview it, then run the first sync."
              />
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {sources.data.map((s) => (
                  <li key={s.id}>
                    <Card size="sm">
                      <CardHeader>
                        <CardTitle className="flex items-center justify-between gap-2">
                          <Link
                            href={`/admin/sources/${s.id}`}
                            className="truncate hover:underline"
                          >
                            {s.label}
                          </Link>
                          <ActivePill active={s.status === 'ACTIVE'} />
                        </CardTitle>
                        <CardDescription className="truncate">
                          {s.spreadsheetTitle ?? s.spreadsheetId}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                          {s.ownedOfferings} offerings · last sync {formatDateTime(s.lastSyncedAt)}
                        </span>
                        <a
                          href={s.spreadsheetUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className={buttonVariants({ variant: 'ghost', size: 'xs' })}
                        >
                          Open sheet
                          <ExternalLink aria-hidden />
                          <span className="sr-only">(opens in a new tab)</span>
                        </a>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
