'use client';

import { KeyRound, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useUrlState } from '@/components/admin/use-url-state';
import { Field, NativeSelect, onSubmit } from '@/components/app/form';
import { PageHeader } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
import { AccountStatusPill } from '@/components/app/status';
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  PageLoading,
  errorMessage,
} from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { apiDownload, errorCode, saveBlob } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { json, qs, useApi } from '@/lib/query';
import { useQueryClient } from '@tanstack/react-query';
import type { Generation, Paginated, Student } from '@/lib/types';

const ISSUE_ERRORS: Record<string, string> = {
  TOO_MANY_STUDENTS: 'At most 500 students per file. Narrow the selection (for example by class).',
  SELECTION_REQUIRED: 'Choose students, or a generation.',
};

function IssueCredentialsDialog({
  selected,
  generations,
  defaults,
  onIssued,
}: {
  selected: Student[];
  generations: Generation[];
  defaults: { generationId: string; className: string };
  onIssued(): void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'selected' | 'filter'>('filter');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyPending, setOnlyPending] = useState(true);

  const submit = onSubmit(async (d) => {
    setBusy(true);
    setError(null);
    const body =
      mode === 'selected'
        ? { studentIds: selected.map((s) => s.id), onlyPending }
        : {
            generationId: String(d.get('generationId')),
            ...(String(d.get('className') ?? '').trim()
              ? { className: String(d.get('className')).trim() }
              : {}),
            onlyPending,
          };
    try {
      const { blob, filename, headers } = await apiDownload(
        '/admin/students/issue-credentials',
        json(body),
      );
      const count = Number(headers.get('X-Issued-Count') ?? 0);
      if (count === 0) {
        setError('No matching students needed credentials. Nothing was issued.');
        return;
      }
      saveBlob(blob, filename);
      toast.success(
        `Issued ${count} temporary passwords. Distribute the file securely, then delete it.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['/admin'] });
      onIssued();
      setOpen(false);
    } catch (err) {
      const code = errorCode(err);
      setError((code && ISSUE_ERRORS[code]) ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setMode(selected.length ? 'selected' : 'filter');
          setOnlyPending(true);
          setError(null);
        }
      }}
    >
      <DialogTrigger render={<Button />}>
        <KeyRound aria-hidden />
        Issue credentials
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Issue temporary passwords</DialogTitle>
            <DialogDescription>
              Downloads a CSV with one temporary password per student. Passwords are shown only in
              this file, expire in 14 days, and must be changed at first sign-in.
            </DialogDescription>
          </DialogHeader>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Students</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="mode"
                checked={mode === 'selected'}
                disabled={!selected.length}
                onChange={() => setMode('selected')}
              />
              Selected on this page ({selected.length})
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="mode"
                checked={mode === 'filter'}
                onChange={() => setMode('filter')}
              />
              By generation and class
            </label>
          </fieldset>
          {mode === 'filter' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Generation" required>
                {(p) => (
                  <NativeSelect
                    {...p}
                    name="generationId"
                    defaultValue={defaults.generationId || generations[0]?.id}
                  >
                    {generations.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.code}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Class" hint="Optional. Exact class name.">
                {(p) => (
                  <Input {...p} name="className" defaultValue={defaults.className} maxLength={60} />
                )}
              </Field>
            </div>
          ) : null}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={onlyPending}
              onCheckedChange={(v) => setOnlyPending(v === true)}
              className="mt-0.5"
            />
            <span>
              Only accounts still awaiting credentials
              <span className="block text-xs text-muted-foreground">
                Unticked, active students also get a new password and are signed out everywhere.
              </span>
            </span>
          </label>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>No file was issued</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy ? 'Generating passwords…' : 'Issue and download CSV'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StudentsList() {
  const { values, page, set } = useUrlState(['generationId', 'className', 'status', 'q'] as const);
  const [q, setQ] = useState(values.q);
  const [className, setClassName] = useState(values.className);
  const [selected, setSelected] = useState<Map<string, Student>>(new Map());
  const generations = useApi<Paginated<Generation>>('/admin/generations?pageSize=100');
  const list = useApi<Paginated<Student>>(
    `/admin/students${qs({ ...values, page, pageSize: 25 })}`,
    {
      keepPrevious: true,
    },
  );

  useEffect(() => {
    const t = setTimeout(() => {
      if (q !== values.q || className !== values.className) set({ q, className });
    }, 300);
    return () => clearTimeout(t);
  }, [q, className, values.q, values.className, set]);

  const rows = list.data?.data ?? [];
  const allOnPage = rows.length > 0 && rows.every((s) => selected.has(s.id));
  const toggle = (s: Student, on: boolean) =>
    setSelected((m) => {
      const next = new Map(m);
      if (on) next.set(s.id, s);
      else next.delete(s.id);
      return next;
    });

  return (
    <>
      <PageHeader
        title="Students"
        description="Students are created by sync. Activate accounts by issuing temporary passwords."
        actions={
          <IssueCredentialsDialog
            selected={[...selected.values()]}
            generations={generations.data?.data ?? []}
            defaults={{ generationId: values.generationId, className: values.className }}
            onIssued={() => setSelected(new Map())}
          />
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,16rem)_12rem_10rem_10rem]">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search students"
            placeholder="Search name or student ID"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <NativeSelect
          aria-label="Generation"
          value={values.generationId}
          onChange={(e) => set({ generationId: e.target.value })}
        >
          <option value="">All generations</option>
          {generations.data?.data.map((g) => (
            <option key={g.id} value={g.id}>
              {g.code}
            </option>
          ))}
        </NativeSelect>
        <Input
          aria-label="Class"
          placeholder="Class"
          value={className}
          onChange={(e) => setClassName(e.target.value)}
        />
        <NativeSelect
          aria-label="Account status"
          value={values.status}
          onChange={(e) => set({ status: e.target.value })}
        >
          <option value="">All accounts</option>
          <option value="PENDING">Pending</option>
          <option value="ACTIVE">Active</option>
          <option value="DISABLED">Disabled</option>
        </NativeSelect>
      </div>

      {list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Users className="size-8" />}
          title="No students found"
          description={
            Object.values(values).some(Boolean)
              ? 'Try other filters.'
              : 'Students are imported from the Students tab of a generation’s spreadsheet.'
          }
        />
      ) : (
        <>
          {selected.size ? (
            <p className="mb-2 text-sm text-muted-foreground" aria-live="polite">
              {selected.size} selected ·{' '}
              <button type="button" className="underline" onClick={() => setSelected(new Map())}>
                Clear selection
              </button>
            </p>
          ) : null}
          <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allOnPage}
                      onCheckedChange={(on) => rows.forEach((s) => toggle(s, on === true))}
                      aria-label="Select all students on this page"
                    />
                  </TableHead>
                  <TableHead>Student</TableHead>
                  <TableHead className="hidden sm:table-cell">Generation · class</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="hidden lg:table-cell">Last sign-in</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.id} data-state={selected.has(s.id) ? 'selected' : undefined}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(s.id)}
                        onCheckedChange={(on) => toggle(s, on === true)}
                        aria-label={`Select ${s.fullName}`}
                      />
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <Link
                        href={`/admin/students/${s.id}`}
                        className="font-medium hover:underline"
                      >
                        {s.fullName}
                      </Link>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {s.studentCode}
                      </span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {s.generation.code}
                      <span className="text-muted-foreground"> · {s.className ?? 'no class'}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <AccountStatusPill status={s.account.status} />
                        {s.account.locked ? (
                          <span className="text-xs text-destructive">Locked</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {s.account.lastLoginAt ? formatDateTime(s.account.lastLoginAt) : 'Never'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination {...list.data.meta} onPage={(p) => set({ page: p })} />
        </>
      )}
    </>
  );
}

export default function StudentsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <StudentsList />
    </Suspense>
  );
}
