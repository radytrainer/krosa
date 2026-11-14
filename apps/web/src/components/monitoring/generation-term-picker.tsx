'use client';

import type { MonitoringGenerationOption, MonitoringReleaseState } from '@ssrs/shared';
import { CircleSlash, EyeOff, type LucideIcon } from 'lucide-react';
import { Field, NativeSelect } from '@/components/app/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { KHMER_SAFE } from './text';

type TermOption = MonitoringGenerationOption['terms'][number];

export interface TermStatus {
  icon: LucideIcon;
  label: string;
}

/**
 * At most one status per term, first match wins: no subjects, then not (fully) released to
 * students. A released term has none. Admins see every term (M1).
 */
export function termStatus(t: {
  subjects: number;
  releaseState: MonitoringReleaseState;
}): TermStatus | null {
  if (t.subjects === 0) return { icon: CircleSlash, label: 'No subjects' };
  if (t.releaseState !== 'RELEASED') return { icon: EyeOff, label: 'Not released to students' };
  return null;
}

/** "Term 1, No subjects"; a released term is its name. */
export function termName(t: Parameters<typeof termStatus>[0] & { name: string }): string {
  const status = termStatus(t);
  return status ? `${t.name}, ${status.label}` : t.name;
}

/**
 * The term name and its status icon. The icon has a hover tooltip and, for screen readers, the
 * same words as hidden text (not colour alone). Options also carry `termName` as their label: the
 * hidden text alone would be read as "Term 1 , No subjects".
 */
function TermLabel({ term }: { term: TermOption }) {
  const status = termStatus(term);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={KHMER_SAFE}>
        {term.name}
        {status ? <span className="sr-only">, {status.label}</span> : null}
      </span>
      {status ? (
        <Tooltip>
          <TooltipTrigger
            render={<span />}
            className="inline-flex shrink-0 text-muted-foreground"
            data-term-status={status.label}
          >
            <status.icon className="size-4" aria-hidden />
          </TooltipTrigger>
          {/* Beside the icon and click-through, so it never covers the neighbouring option. */}
          <TooltipContent side="right" className="pointer-events-none">
            {status.label}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}

/**
 * Generation, then term. Changing the generation resets the term (the parent decides the
 * default). Archived generations are listed and labelled "Archived" (M8).
 */
export function GenerationTermPicker({
  generations,
  generationId,
  termNumber,
  onGeneration,
  onTerm,
  disabled,
}: {
  generations: MonitoringGenerationOption[];
  generationId: string;
  termNumber: number | null;
  onGeneration(id: string): void;
  onTerm(n: number): void;
  disabled?: boolean;
}) {
  const generation = generations.find((g) => g.id === generationId);
  const terms = generation?.terms ?? [];
  const selected = terms.find((t) => t.number === termNumber);
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,18rem)_minmax(0,14rem)]">
      <Field label="Generation">
        {(p) => (
          <NativeSelect
            {...p}
            value={generationId}
            disabled={disabled}
            onChange={(e) => onGeneration(e.target.value)}
          >
            {generation ? null : <option value="">Choose a generation</option>}
            {generations.map((g) => (
              <option key={g.id} value={g.id}>
                {g.code} · {g.name}
                {g.status === 'ARCHIVED' ? ' (Archived)' : ''}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label="Term">
        {(p) => (
          <Select<number>
            value={selected ? selected.number : null}
            disabled={disabled || !generation}
            itemToStringLabel={(n) => terms.find((t) => t.number === n)?.name ?? String(n)}
            onValueChange={(n) => {
              if (n !== null && n !== termNumber) onTerm(n);
            }}
          >
            <SelectTrigger
              id={p.id}
              aria-describedby={p['aria-describedby']}
              aria-invalid={p['aria-invalid']}
            >
              <SelectValue placeholder="Choose a term">
                {() => (selected ? <TermLabel term={selected} /> : 'Choose a term')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {terms.map((t) => (
                <SelectItem key={t.id} value={t.number} label={t.name} aria-label={termName(t)}>
                  <TermLabel term={t} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
    </div>
  );
}
