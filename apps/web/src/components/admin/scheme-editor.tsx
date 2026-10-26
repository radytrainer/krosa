'use client';

import { CheckCircle2, CircleAlert, Save, Send, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/app/confirm';
import { Section } from '@/components/app/page-header';
import { StatusPill } from '@/components/app/status';
import { EmptyState } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { ApiError, apiFetch } from '@/lib/api';
import { fromMilli, HUNDRED_MILLI, toMilli } from '@/lib/decimal';
import { formatDateTime, trimDecimal } from '@/lib/format';
import { json, useApiMutation } from '@/lib/query';
import type { Criterion, Scheme, SchemeIssue } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Row {
  included: boolean;
  maxMark: string;
  weight: string;
}

function rowProblems(row: Row): { maxMark?: string; weight?: string } {
  if (!row.included) return {};
  const max = toMilli(row.maxMark);
  const weight = toMilli(row.weight);
  return {
    maxMark: max === null || max <= 0 ? 'Enter a number above 0 (max 3 decimals).' : undefined,
    weight:
      weight === null || weight <= 0 || weight > HUNDRED_MILLI
        ? 'Enter a weight above 0 and at most 100 (max 3 decimals).'
        : undefined,
  };
}

/** The live "weights must total 100%" indicator. */
function TotalIndicator({ totalMilli, included }: { totalMilli: number; included: number }) {
  const exact = totalMilli === HUNDRED_MILLI;
  const over = totalMilli > HUNDRED_MILLI;
  const diff = Math.abs(HUNDRED_MILLI - totalMilli);
  const pct = Math.min(100, totalMilli / 1000);
  return (
    <div className="space-y-2 rounded-xl border p-4" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Total weight</p>
        <p
          className={cn(
            'text-2xl font-semibold tabular-nums',
            exact ? 'text-success' : 'text-warning',
          )}
        >
          {fromMilli(totalMilli)}%
          <span className="text-base font-normal text-muted-foreground"> / 100%</span>
        </p>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Total weight"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Number(fromMilli(totalMilli))}
      >
        <div
          className={cn(
            'h-full rounded-full transition-all',
            exact ? 'bg-success' : over ? 'bg-destructive' : 'bg-warning',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p
        className={cn(
          'flex items-center gap-1.5 text-sm',
          exact ? 'text-success' : 'text-muted-foreground',
        )}
      >
        {exact ? (
          <CheckCircle2 className="size-4" aria-hidden />
        ) : (
          <CircleAlert className="size-4" aria-hidden />
        )}
        {included === 0
          ? 'Include at least one criterion.'
          : exact
            ? 'Weights total exactly 100%. Ready to publish.'
            : over
              ? `${fromMilli(diff)}% too much. Lower some weights.`
              : `${fromMilli(diff)}% still to assign.`}
      </p>
    </div>
  );
}

function initialRows(criteria: Criterion[], base: Scheme | null): Record<string, Row> {
  const items = new Map(base?.items.map((i) => [i.criterionId, i]));
  return Object.fromEntries(
    criteria.map((c) => {
      const item = items.get(c.id);
      return [
        c.id,
        {
          included: base ? Boolean(item) : true,
          maxMark: item ? trimDecimal(item.maxMark) : '',
          weight: item ? trimDecimal(item.weight) : '',
        },
      ];
    }),
  );
}

/**
 * Edits the offering's DRAFT scheme. Starts from the draft, else from the published version, so
 * publishing a change is "edit → save draft → publish". The parent re-mounts it (via `key`) when
 * the published version changes; saving a draft keeps the local state, which already matches.
 */
export function SchemeEditor({
  offeringId,
  criteria,
  schemes,
  readOnly,
}: {
  offeringId: string;
  criteria: Criterion[];
  schemes: Scheme[];
  readOnly: boolean;
}) {
  const draft = schemes.find((s) => s.status === 'DRAFT') ?? null;
  const published = schemes.find((s) => s.status === 'PUBLISHED') ?? null;
  const active = useMemo(() => criteria.filter((c) => c.isActive), [criteria]);
  const [rows, setRows] = useState(() => initialRows(active, draft ?? published));
  const base = draft ?? published;
  // Criteria added after mount start excluded when a scheme exists, included otherwise.
  const rowOf = (id: string): Row => rows[id] ?? { included: !base, maxMark: '', weight: '' };
  const [notes, setNotes] = useState(draft?.notes ?? '');
  const [dirty, setDirty] = useState(false);
  const [publishIssues, setPublishIssues] = useState<SchemeIssue[] | null>(null);
  const invalidate = [`/admin/offerings/${offeringId}`, '/admin/offerings', '/admin/dashboard'];

  const saveDraft = useApiMutation(
    () =>
      apiFetch<Scheme>(
        `/admin/offerings/${offeringId}/grading-schemes`,
        json({
          items: active
            .filter((c) => rowOf(c.id).included)
            .map((c) => ({
              criterionId: c.id,
              maxMark: rowOf(c.id).maxMark.trim(),
              weight: rowOf(c.id).weight.trim(),
            })),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      ),
    { invalidate },
  );
  const publish = useApiMutation(
    (id: string) => apiFetch<Scheme>(`/admin/grading-schemes/${id}/publish`, { method: 'POST' }),
    {
      success: (s) => `Version ${s.version} published. Students now see results computed with it.`,
      invalidate,
    },
  );
  const discard = useApiMutation(
    (id: string) => apiFetch(`/admin/grading-schemes/${id}`, { method: 'DELETE' }),
    {
      success: 'Draft discarded.',
      invalidate,
    },
  );

  const update = (id: string, patch: Partial<Row>) => {
    setRows((r) => ({ ...r, [id]: { ...rowOf(id), ...patch } }));
    setDirty(true);
    setPublishIssues(null);
  };

  const included = active.filter((c) => rowOf(c.id).included);
  const totalMilli = included.reduce((sum, c) => sum + (toMilli(rowOf(c.id).weight) ?? 0), 0);
  const hasRowErrors = included.some((c) => {
    const p = rowProblems(rowOf(c.id));
    return p.maxMark || p.weight;
  });
  const canPublish =
    !readOnly && included.length > 0 && !hasRowErrors && totalMilli === HUNDRED_MILLI;

  const save = async () => {
    const saved = await saveDraft.mutateAsync(undefined);
    setDirty(false);
    return saved;
  };

  const doPublish = async () => {
    setPublishIssues(null);
    try {
      const target = dirty || !draft ? await save() : draft;
      await publish.mutateAsync(target.id);
      setDirty(false);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.data.issues))
        setPublishIssues(err.data.issues as SchemeIssue[]);
    }
  };

  if (active.length === 0) {
    return (
      <Section title="Grading scheme">
        <EmptyState
          title="No active criteria"
          description="Add criteria before defining max marks and weights."
        />
      </Section>
    );
  }

  const criterionName = (id?: string) => criteria.find((c) => c.id === id)?.key;

  return (
    <Section
      title="Grading scheme"
      description={
        <>
          contribution = mark ÷ max mark × weight. Students&apos; results always use the published
          version
          {published ? ` (currently v${published.version})` : ''}.
        </>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {draft ? (
            <StatusPill tone="info">
              Draft v{draft.version}
              {draft.origin === 'SHEET' ? ' from sheet' : ''}
            </StatusPill>
          ) : null}
          {dirty ? <StatusPill tone="warning">Unsaved changes</StatusPill> : null}
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  <span className="sr-only">Include</span>
                </TableHead>
                <TableHead>Criterion</TableHead>
                <TableHead className="w-32">Max mark</TableHead>
                <TableHead className="w-32">Weight %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {active.map((c) => {
                const row = rowOf(c.id);
                const problems = rowProblems(row);
                return (
                  <TableRow key={c.id} className={cn('align-top', !row.included && 'opacity-60')}>
                    <TableCell className="pt-3">
                      <Checkbox
                        checked={row.included}
                        onCheckedChange={(v) => update(c.id, { included: v === true })}
                        disabled={readOnly}
                        aria-label={`Include ${c.key} in the scheme`}
                      />
                    </TableCell>
                    <TableCell className="pt-3 whitespace-normal">
                      <span className="font-medium">{c.name}</span>
                      <span className="block font-mono text-xs text-muted-foreground">{c.key}</span>
                    </TableCell>
                    {(['maxMark', 'weight'] as const).map((field) => (
                      <TableCell key={field}>
                        <Input
                          inputMode="decimal"
                          value={row[field]}
                          disabled={readOnly || !row.included}
                          onChange={(e) => update(c.id, { [field]: e.target.value })}
                          aria-label={`${field === 'maxMark' ? 'Max mark' : 'Weight'} for ${c.key}`}
                          aria-invalid={problems[field] ? true : undefined}
                          title={problems[field]}
                          className="tabular-nums"
                        />
                        {problems[field] && row[field] !== '' ? (
                          <span className="mt-1 block text-xs text-destructive">
                            {problems[field]}
                          </span>
                        ) : null}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <div className="space-y-4">
          <TotalIndicator totalMilli={totalMilli} included={included.length} />
          <div className="space-y-1.5">
            <label htmlFor="scheme-notes" className="text-sm font-medium">
              Notes <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="scheme-notes"
              rows={2}
              maxLength={500}
              value={notes}
              disabled={readOnly}
              onChange={(e) => {
                setNotes(e.target.value);
                setDirty(true);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              onClick={() => save().then(() => toast.success('Draft saved.'))}
              disabled={readOnly || !dirty || hasRowErrors || saveDraft.isPending}
            >
              <Save aria-hidden />
              Save draft
            </Button>
            <Confirm
              trigger={
                <Button disabled={!canPublish || publish.isPending}>
                  <Send aria-hidden />
                  Publish{dirty ? ' changes' : draft ? ` v${draft.version}` : ''}
                </Button>
              }
              title="Publish this grading scheme?"
              description={
                published
                  ? `Version ${published.version} will be archived. Every student's results in this course are recalculated with the new weights immediately.`
                  : 'Students will see results for this course computed with these weights (if the course is visible).'
              }
              confirmLabel="Publish"
              onConfirm={doPublish}
            />
            {draft ? (
              <Confirm
                trigger={
                  <Button variant="ghost" disabled={readOnly || discard.isPending}>
                    <Trash2 aria-hidden />
                    Discard draft
                  </Button>
                }
                title={`Discard draft v${draft.version}?`}
                description="The published version stays in use. The draft cannot be recovered."
                confirmLabel="Discard draft"
                destructive
                onConfirm={() =>
                  discard.mutateAsync(draft.id).then(() => {
                    setRows(initialRows(active, published));
                    setNotes('');
                    setDirty(false);
                  })
                }
              />
            ) : null}
          </div>
        </div>
      </div>

      {publishIssues?.length ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>The scheme cannot be published yet</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-4">
              {publishIssues.map((i, n) => (
                <li key={n}>
                  {criterionName(i.criterionId) ? (
                    <strong>{criterionName(i.criterionId)}: </strong>
                  ) : null}
                  {i.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : draft?.validation && !draft.validation.valid && !dirty ? (
        <Alert>
          <CircleAlert aria-hidden />
          <AlertTitle>The saved draft is not publishable yet</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-4">
              {draft.validation.issues.map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {schemes.length ? (
        <details className="rounded-xl border p-4 text-sm">
          <summary className="cursor-pointer font-medium">
            Version history ({schemes.length})
          </summary>
          <ul className="mt-3 divide-y">
            {schemes.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex items-center gap-2">
                  <span className="font-medium">v{s.version}</span>
                  <StatusPill
                    tone={
                      s.status === 'PUBLISHED'
                        ? 'success'
                        : s.status === 'DRAFT'
                          ? 'info'
                          : 'neutral'
                    }
                  >
                    {s.status === 'PUBLISHED'
                      ? 'Published'
                      : s.status === 'DRAFT'
                        ? 'Draft'
                        : 'Archived'}
                  </StatusPill>
                  <span className="text-muted-foreground">
                    {s.origin === 'SHEET' ? 'from sheet' : 'by admin'}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  {s.items.length} criteria · {trimDecimal(s.totalWeight)}% ·{' '}
                  {s.publishedAt
                    ? `published ${formatDateTime(s.publishedAt)}${s.publishedBy ? ` by ${s.publishedBy.username}` : ''}`
                    : `created ${formatDateTime(s.createdAt)}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}
