'use client';

import { Library, Pencil, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Field, fieldErrors, onSubmit } from '@/components/app/form';
import { PageHeader } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
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
import { Textarea } from '@/components/ui/textarea';
import { apiFetch, errorCode } from '@/lib/api';
import { json, qs, useApi, useApiMutation } from '@/lib/query';
import type { Course, Paginated } from '@/lib/types';

/** Create (no `course`) or edit a catalog course. The code is immutable once created. */
function CourseDialog({ course }: { course?: Course }) {
  const [open, setOpen] = useState(false);
  const save = useApiMutation(
    (body: Record<string, string>) =>
      course
        ? apiFetch(`/admin/courses/${course.id}`, json(body, 'PATCH'))
        : apiFetch('/admin/courses', json(body)),
    {
      success: course ? 'Course updated.' : 'Course added to the catalog.',
      invalidate: ['/admin/courses'],
      onSuccess: () => setOpen(false),
    },
  );
  const errors = fieldErrors(save.error);
  if (errorCode(save.error) === 'COURSE_CODE_EXISTS')
    errors.code = 'This code is already in the catalog.';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={course ? <Button variant="ghost" size="sm" /> : <Button />}>
        {course ? <Pencil aria-hidden /> : <Plus aria-hidden />}
        {course ? (
          <>
            <span className="sr-only sm:not-sr-only">Edit</span>
            <span className="sr-only"> {course.code}</span>
          </>
        ) : (
          'New course'
        )}
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={onSubmit((d) => {
            const body: Record<string, string> = {
              name: String(d.get('name')).trim(),
              description: String(d.get('description') ?? '').trim(),
            };
            if (!course) body.code = String(d.get('code')).trim();
            save.mutate(body);
          })}
        >
          <DialogHeader>
            <DialogTitle>{course ? `Edit ${course.code}` : 'New catalog course'}</DialogTitle>
            <DialogDescription>
              Catalog courses are shared by every generation. Titles shown to students are set per
              offering.
            </DialogDescription>
          </DialogHeader>
          {course ? null : (
            <Field
              label="Code"
              required
              hint="Letters, digits, _ or -, e.g. MATH101. Cannot be changed later."
              error={errors.code}
            >
              {(p) => (
                <Input {...p} name="code" maxLength={32} pattern="[A-Za-z0-9_\-]{1,32}" autoFocus />
              )}
            </Field>
          )}
          <Field label="Name" required error={errors.name}>
            {(p) => <Input {...p} name="name" defaultValue={course?.name} maxLength={160} />}
          </Field>
          <Field label="Description" error={errors.description}>
            {(p) => (
              <Textarea
                {...p}
                name="description"
                defaultValue={course?.description ?? ''}
                maxLength={2000}
                rows={3}
              />
            )}
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={save.isPending}>
              {course ? 'Save changes' : 'Add course'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function CoursesPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const { data, error, isPending, refetch } = useApi<Paginated<Course>>(
    `/admin/courses${qs({ page, pageSize: 25, q: q.trim() })}`,
    { keepPrevious: true },
  );

  return (
    <>
      <PageHeader
        title="Course catalog"
        description="Courses that can be offered in a term. Sync adds missing ones automatically."
        actions={<CourseDialog />}
      />
      <div className="relative mb-4 sm:max-w-xs">
        <Search
          className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          aria-label="Search courses"
          placeholder="Search code or name"
          className="pl-8"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isPending ? (
        <LoadingRows />
      ) : data.data.length === 0 ? (
        <EmptyState
          icon={<Library className="size-8" />}
          title={q ? 'No courses match' : 'The catalog is empty'}
          description={
            q
              ? 'Try another search.'
              : 'Add a course, or run a sync to import courses from a spreadsheet.'
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
                  <TableHead className="hidden md:table-cell">Description</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono font-medium">{c.code}</TableCell>
                    <TableCell>{c.name}</TableCell>
                    <TableCell className="hidden max-w-md truncate text-muted-foreground md:table-cell">
                      {c.description || '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <CourseDialog course={c} />
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
