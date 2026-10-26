'use client';

import { BookOpen, Eye, EyeOff, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useUrlState } from '@/components/admin/use-url-state';
import { Field, NativeSelect, fieldErrors, onSubmit } from '@/components/app/form';
import { PageHeader } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
import { StatusPill } from '@/components/app/status';
import { EmptyState, ErrorState, LoadingRows, PageLoading } from '@/components/app/states';
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
import { json, qs, useApi, useApiMutation } from '@/lib/query';
import type { Course, Generation, GenerationDetail, Offering, Paginated } from '@/lib/types';

function CreateOfferingDialog({ generationId }: { generationId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const generation = useApi<GenerationDetail>(open ? `/admin/generations/${generationId}` : null);
  const courses = useApi<Paginated<Course>>(open ? '/admin/courses?pageSize=100' : null);
  const create = useApiMutation(
    (body: Record<string, string>) => apiFetch<Offering>('/admin/offerings', json(body)),
    {
      success: 'Offering created. Add criteria and a grading scheme next.',
      invalidate: ['/admin/offerings', '/admin/dashboard'],
      onSuccess: (o) => router.push(`/admin/offerings/${o.id}`),
    },
  );
  const errors = fieldErrors(create.error);
  if (errorCode(create.error) === 'OFFERING_EXISTS') {
    errors.externalKey = 'This course is already offered in that term, or the key is already used.';
  }
  const archived = generation.data?.status === 'ARCHIVED';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus aria-hidden />
        New offering
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={onSubmit((d) =>
            create.mutate({
              termId: String(d.get('termId')),
              courseId: String(d.get('courseId')),
              externalKey: String(d.get('externalKey')).trim(),
              title: String(d.get('title')).trim(),
              credits: String(d.get('credits')).trim(),
            }),
          )}
        >
          <DialogHeader>
            <DialogTitle>New course offering</DialogTitle>
            <DialogDescription>
              Usually created by sync. Create one manually only for courses not managed in a
              spreadsheet.
            </DialogDescription>
          </DialogHeader>
          {archived ? (
            <p className="text-sm text-destructive">
              This generation is archived and cannot be changed.
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Term" required error={errors.termId}>
              {(p) => (
                <NativeSelect {...p} name="termId" disabled={!generation.data}>
                  {generation.data?.terms.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.number}. {t.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Catalog course" required error={errors.courseId}>
              {(p) => (
                <NativeSelect {...p} name="courseId" disabled={!courses.data}>
                  {courses.data?.data.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {c.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
          <Field
            label="Key"
            required
            hint="Stable identifier in this generation, e.g. T1-MATH101."
            error={errors.externalKey}
          >
            {(p) => (
              <Input {...p} name="externalKey" maxLength={40} pattern="[A-Za-z0-9_\-]{1,40}" />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <Field label="Title shown to students" required error={errors.title}>
              {(p) => <Input {...p} name="title" maxLength={160} />}
            </Field>
            <Field label="Credits" required error={errors.credits}>
              {(p) => (
                <Input
                  {...p}
                  name="credits"
                  inputMode="decimal"
                  defaultValue="3"
                  pattern="\d{1,3}(\.\d)?"
                />
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending || archived}>
              Create offering
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OfferingsList() {
  const { values, page, set } = useUrlState(['generationId', 'termNumber', 'q'] as const);
  const generations = useApi<Paginated<Generation>>('/admin/generations?pageSize=100');
  const [q, setQ] = useState(values.q);

  // Default to the newest active generation.
  const firstActive =
    generations.data?.data.find((g) => g.status === 'ACTIVE') ?? generations.data?.data[0];
  useEffect(() => {
    if (!values.generationId && firstActive) set({ generationId: firstActive.id });
  }, [values.generationId, firstActive, set]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (q !== values.q) set({ q });
    }, 300);
    return () => clearTimeout(t);
  }, [q, values.q, set]);

  const list = useApi<Paginated<Offering>>(
    values.generationId
      ? `/admin/offerings${qs({ generationId: values.generationId, termNumber: values.termNumber, q: values.q, page, pageSize: 25 })}`
      : null,
    { keepPrevious: true },
  );

  return (
    <>
      <PageHeader
        title="Course offerings"
        description="Courses taught in a term, with their criteria, grading scheme and visibility."
        actions={
          values.generationId ? <CreateOfferingDialog generationId={values.generationId} /> : null
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,14rem)_10rem_minmax(0,18rem)]">
        <NativeSelect
          aria-label="Generation"
          value={values.generationId}
          onChange={(e) => set({ generationId: e.target.value })}
        >
          {generations.data?.data.map((g) => (
            <option key={g.id} value={g.id}>
              {g.code}
              {g.status === 'ARCHIVED' ? ' (archived)' : ''}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Term"
          value={values.termNumber}
          onChange={(e) => set({ termNumber: e.target.value })}
        >
          <option value="">All terms</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              Term {n}
            </option>
          ))}
        </NativeSelect>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search offerings"
            placeholder="Search title, code or key"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {generations.data && generations.data.data.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="size-8" />}
          title="No generations yet"
          description="Offerings belong to a generation. Create one first."
          action={
            <Link href="/admin/generations" className="text-sm font-medium underline">
              Go to generations
            </Link>
          }
        />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <LoadingRows />
      ) : list.data.data.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="size-8" />}
          title="No offerings found"
          description={
            values.q || values.termNumber
              ? 'Try other filters.'
              : 'Run a sync of this generation to import its courses.'
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Course</TableHead>
                  <TableHead className="w-16">Term</TableHead>
                  <TableHead className="hidden md:table-cell">Criteria</TableHead>
                  <TableHead>Grading</TableHead>
                  <TableHead className="hidden sm:table-cell">Students see it</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.data.map((o) => (
                  <TableRow key={o.id} className="relative">
                    <TableCell className="whitespace-normal">
                      <Link
                        href={`/admin/offerings/${o.id}`}
                        className="font-medium after:absolute after:inset-0 hover:underline"
                      >
                        {o.title}
                      </Link>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {o.course.code} · {o.externalKey} · {o.credits} cr
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums">{o.term.number}</TableCell>
                    <TableCell className="hidden tabular-nums md:table-cell">
                      {o.criteriaCount}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {o.publishedSchemeVersion ? (
                          <StatusPill tone="success">
                            v{o.publishedSchemeVersion} published
                          </StatusPill>
                        ) : (
                          <StatusPill tone="warning">Not published</StatusPill>
                        )}
                        {o.hasDraftScheme ? <StatusPill tone="info">Draft</StatusPill> : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {o.visibility === 'VISIBLE' ? (
                        <StatusPill tone="success" icon={<Eye aria-hidden />}>
                          Visible
                        </StatusPill>
                      ) : (
                        <StatusPill tone="neutral" icon={<EyeOff aria-hidden />}>
                          Hidden
                        </StatusPill>
                      )}
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

export default function OfferingsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <OfferingsList />
    </Suspense>
  );
}
