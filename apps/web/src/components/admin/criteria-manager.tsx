'use client';

import { ArrowDown, ArrowUp, ListChecks, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Field, NativeSelect, fieldErrors, onSubmit } from '@/components/app/form';
import { Section } from '@/components/app/page-header';
import { ActivePill } from '@/components/app/status';
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
import { Switch } from '@/components/ui/switch';
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
import { humanize, trimDecimal } from '@/lib/format';
import { json, useApiMutation } from '@/lib/query';
import { CRITERION_CATEGORIES, type Criterion } from '@/lib/types';

function CriterionDialog({
  offeringId,
  criterion,
  disabled,
}: {
  offeringId: string;
  criterion?: Criterion;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(criterion?.isActive ?? true);
  const save = useApiMutation(
    (body: Record<string, unknown>) =>
      criterion
        ? apiFetch(`/admin/criteria/${criterion.id}`, json(body, 'PATCH'))
        : apiFetch(`/admin/offerings/${offeringId}/criteria`, json(body)),
    {
      success: criterion ? 'Criterion updated.' : 'Criterion added at the end.',
      invalidate: [`/admin/offerings/${offeringId}`],
      onSuccess: () => setOpen(false),
    },
  );
  const errors = fieldErrors(save.error);
  const code = errorCode(save.error);
  if (code === 'CRITERION_KEY_EXISTS') errors.key = 'This key already exists in the offering.';
  const inPublished = code === 'CRITERION_IN_PUBLISHED_SCHEME';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setActive(criterion?.isActive ?? true);
      }}
    >
      <DialogTrigger
        render={
          criterion ? (
            <Button variant="ghost" size="sm" disabled={disabled} />
          ) : (
            <Button variant="outline" disabled={disabled} />
          )
        }
      >
        {criterion ? <Pencil aria-hidden /> : <Plus aria-hidden />}
        {criterion ? <span className="sr-only">Edit {criterion.key}</span> : 'Add criterion'}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={onSubmit((d) => {
            const body: Record<string, unknown> = {
              name: String(d.get('name')).trim(),
              category: String(d.get('category')),
              description: String(d.get('description') ?? '').trim() || null,
              sheetColumnKey: String(d.get('sheetColumnKey') ?? '').trim() || null,
            };
            if (criterion) body.isActive = active;
            else body.key = String(d.get('key')).trim();
            if (!criterion && !body.description) delete body.description;
            if (!criterion && !body.sheetColumnKey) delete body.sheetColumnKey;
            save.mutate(body);
          })}
        >
          <DialogHeader>
            <DialogTitle>{criterion ? `Edit ${criterion.key}` : 'Add criterion'}</DialogTitle>
            <DialogDescription>
              Criteria are the columns of a course&apos;s mark sheet. Max marks and weights are set
              in the grading scheme.
            </DialogDescription>
          </DialogHeader>
          {criterion ? null : (
            <Field
              label="Key"
              required
              hint="Letter first, then letters, digits or _, e.g. Q1. Cannot change later."
              error={errors.key}
            >
              {(p) => (
                <Input
                  {...p}
                  name="key"
                  maxLength={32}
                  pattern="[A-Za-z][A-Za-z0-9_]{0,31}"
                  autoFocus
                />
              )}
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
            <Field label="Name shown to students" required error={errors.name}>
              {(p) => <Input {...p} name="name" defaultValue={criterion?.name} maxLength={120} />}
            </Field>
            <Field label="Category" error={errors.category}>
              {(p) => (
                <NativeSelect {...p} name="category" defaultValue={criterion?.category ?? 'OTHER'}>
                  {CRITERION_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {humanize(c)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
          <Field
            label="Sheet column"
            hint="Only when the column header in the sheet differs from the key."
            error={errors.sheetColumnKey}
          >
            {(p) => (
              <Input
                {...p}
                name="sheetColumnKey"
                defaultValue={criterion?.sheetColumnKey ?? ''}
                maxLength={32}
              />
            )}
          </Field>
          <Field label="Description" error={errors.description}>
            {(p) => (
              <Textarea
                {...p}
                name="description"
                rows={2}
                defaultValue={criterion?.description ?? ''}
                maxLength={500}
              />
            )}
          </Field>
          {criterion ? (
            <div className="flex items-start gap-3 rounded-lg border p-3">
              <Switch id="criterion-active" checked={active} onCheckedChange={setActive} />
              <div className="space-y-0.5">
                <label htmlFor="criterion-active" className="text-sm font-medium">
                  Active
                </label>
                <p className="text-xs text-muted-foreground">
                  Inactive criteria are dropped from the draft scheme. Stored marks are kept.
                </p>
                {inPublished ? (
                  <p className="text-xs text-destructive" role="alert">
                    It is part of the published scheme. Publish a scheme without it first.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={save.isPending}>
              {criterion ? 'Save criterion' : 'Add criterion'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CriteriaManager({
  offeringId,
  criteria,
  error,
  onRetry,
  readOnly,
}: {
  offeringId: string;
  criteria: Criterion[] | undefined;
  error: unknown;
  onRetry(): void;
  readOnly: boolean;
}) {
  const reorder = useApiMutation(
    (criterionIds: string[]) =>
      apiFetch(`/admin/offerings/${offeringId}/criteria/order`, json({ criterionIds }, 'PUT')),
    { invalidate: [`/admin/offerings/${offeringId}`] },
  );

  const move = (index: number, delta: -1 | 1) => {
    if (!criteria) return;
    const ids = criteria.map((c) => c.id);
    const target = index + delta;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate(ids);
  };

  return (
    <Section
      title="Assessment criteria"
      description="Shown to students in this order. Order and names can change at any time; keys cannot."
      actions={<CriterionDialog offeringId={offeringId} disabled={readOnly} />}
    >
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : !criteria ? (
        <LoadingRows rows={3} />
      ) : criteria.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="size-8" />}
          title="No criteria yet"
          description="Add criteria such as quizzes and exams, or sync the spreadsheet that defines them."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Order</TableHead>
                <TableHead>Criterion</TableHead>
                <TableHead className="hidden md:table-cell">Category</TableHead>
                <TableHead className="hidden sm:table-cell">Published</TableHead>
                <TableHead className="hidden lg:table-cell">Marks</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {criteria.map((c, i) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <div className="flex">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={readOnly || i === 0 || reorder.isPending}
                        onClick={() => move(i, -1)}
                        aria-label={`Move ${c.key} up`}
                      >
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={readOnly || i === criteria.length - 1 || reorder.isPending}
                        onClick={() => move(i, 1)}
                        aria-label={`Move ${c.key} down`}
                      >
                        <ArrowDown aria-hidden />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <span className="font-medium">{c.name}</span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {c.key}
                      {c.sheetColumnKey ? ` · column ${c.sheetColumnKey}` : ''}
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{humanize(c.category)}</TableCell>
                  <TableCell className="hidden tabular-nums sm:table-cell">
                    {c.published
                      ? `${trimDecimal(c.published.weight)}% of ${trimDecimal(c.published.maxMark)}`
                      : '—'}
                  </TableCell>
                  <TableCell className="hidden tabular-nums lg:table-cell">
                    {c.scoreCount}
                  </TableCell>
                  <TableCell>
                    <ActivePill active={c.isActive} off="Inactive" />
                  </TableCell>
                  <TableCell className="text-right">
                    <CriterionDialog offeringId={offeringId} criterion={c} disabled={readOnly} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
}
