'use client';

import { useId, type ComponentProps, type ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface ControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  required?: boolean;
}

/**
 * Label + control + hint/error, wired with ids so screen readers announce hints and errors.
 * `children` receives the props to spread on the control.
 */
export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: (props: ControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="text-destructive" aria-hidden>
            *
          </span>
        ) : null}
      </Label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        required,
      })}
      {hint && !error ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Styled native select: accessible and comfortable on touch devices. */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30',
        className,
      )}
      {...props}
    />
  );
}

/** Field-level messages from an API validation error (`details[].field`). */
export function fieldErrors(error: unknown): Record<string, string> {
  const details = (error as { details?: { field?: string; message: string }[] } | null)?.details;
  const out: Record<string, string> = {};
  for (const d of details ?? []) if (d.field && !out[d.field]) out[d.field] = d.message;
  return out;
}

/**
 * Wraps a submit handler so forms never do a full-page POST. The form element is passed too, so
 * handlers can `reset()` it: Next keeps visited pages mounted (hidden), so a form left filled in
 * would still hold its values, passwords included, when the user comes back.
 */
export function onSubmit(handler: (data: FormData, form: HTMLFormElement) => void) {
  return (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handler(new FormData(event.currentTarget), event.currentTarget);
  };
}
