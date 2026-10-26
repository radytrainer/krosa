'use client';

import { CalendarRange, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Field, NativeSelect, fieldErrors, onSubmit } from '@/components/app/form';
import { PageHeader } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
import { StatusPill } from '@/components/app/status';
import { EmptyState, ErrorState, LoadingRows } from '@/components/app/states';
import { Button } from '@/components/ui/button';
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
import { formatDate } from '@/lib/format';
import { json, qs, useApi, useApiMutation } from '@/lib/query';
import type { Generation, GenerationDetail, Paginated } from '@/lib/types';

function CreateGenerationDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const create = useApiMutation(
    (body: Record<string, string>) => apiFetch<GenerationDetail>('/admin/generations', json(body)),
    {
      success: (g) => `Generation ${g.code} created with five terms.`,
      invalidate: ['/admin/generations', '/admin/dashboard'],
      onSuccess: (g) => router.push(`/admin/generations/${g.id}`),
    },
  );
  const errors = fieldErrors(create.error);
  const code = errorCode(create.error);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus aria-hidden />
        New generation
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={onSubmit((d) => {
            const endDate = String(d.get('endDate') ?? '');
            create.mutate({
              code: String(d.get('code')).trim(),
              name: String(d.get('name')).trim(),
              startDate: String(d.get('startDate')),
              ...(endDate ? { endDate } : {}),
            });
          })}
        >
          <DialogHeader>
            <DialogTitle>New generation</DialogTitle>
            <DialogDescription>
              A cohort of students. Five terms are created automatically.
            </DialogDescription>
          </DialogHeader>
          <Field
            label="Code"
            required
            hint="Must match generation_code in the spreadsheet's _meta tab, e.g. GEN2026."
            error={
              errors.code ??
              (code === 'GENERATION_CODE_EXISTS' ? 'This code is already used.' : null)
            }
          >
            {(p) => (
              <Input {...p} name="code" pattern="[A-Za-z0-9_\-]{2,32}" maxLength={32} autoFocus />
            )}
          </Field>
          <Field label="Name" required error={errors.name}>
            {(p) => <Input {...p} name="name" maxLength={120} placeholder="Generation 2026" />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start date" required error={errors.startDate}>
              {(p) => <Input {...p} name="startDate" type="date" />}
            </Field>
            <Field
              label="End date"
              error={
                errors.endDate ??
                (code === 'INVALID_DATE_RANGE' ? 'Must be on or after the start date.' : null)
              }
            >
              {(p) => <Input {...p} name="endDate" type="date" />}
            </Field>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Create generation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function GenerationsPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const { data, error, isPending, refetch } = useApi<Paginated<Generation>>(
    `/admin/generations${qs({ page, pageSize: 25, q: q.trim(), status })}`,
    { keepPrevious: true },
  );

  return (
    <>
      <PageHeader
        title="Generations"
        description="Each generation is a cohort with five terms, its own students, courses and sheet sources."
        actions={<CreateGenerationDialog />}
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative sm:max-w-xs sm:flex-1">
          <Search
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search generations"
            placeholder="Search code or name"
            className="pl-8"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <NativeSelect
          aria-label="Status"
          className="sm:w-40"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="ARCHIVED">Archived</option>
        </NativeSelect>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isPending ? (
        <LoadingRows />
      ) : data.data.length === 0 ? (
        <EmptyState
          icon={<CalendarRange className="size-8" />}
          title={q || status ? 'No generations match' : 'No generations yet'}
          description={
            q || status
              ? 'Try a different search or status.'
              : 'Create the first generation, then connect its Google Sheet.'
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Period</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((g) => (
                  <TableRow key={g.id} className="relative">
                    <TableCell className="font-mono font-medium">
                      <Link
                        href={`/admin/generations/${g.id}`}
                        className="after:absolute after:inset-0 hover:underline"
                      >
                        {g.code}
                      </Link>
                    </TableCell>
                    <TableCell>{g.name}</TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {formatDate(g.startDate)} – {g.endDate ? formatDate(g.endDate) : 'ongoing'}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={g.status === 'ACTIVE' ? 'success' : 'neutral'}>
                        {g.status === 'ACTIVE' ? 'Active' : 'Archived'}
                      </StatusPill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination {...data.meta} onPage={setPage} />
        </>
      )}
    </>
  );
}
