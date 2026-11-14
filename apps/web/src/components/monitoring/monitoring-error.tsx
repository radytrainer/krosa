'use client';

import { AlertCircle } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ErrorState } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { errorCode } from '@/lib/api';

/** Ways out of a failed request; each is offered only for the errors it can fix. */
export interface MonitoringErrorActions {
  clearProgram?(): void;
  clearClass?(): void;
  clearSort?(): void;
  resetFilters?(): void;
  /** Where "Back to subjects" goes on a missing subject or term. */
  backHref?: string;
}

/**
 * Error state for the monitoring endpoints. Known codes (apps/api/src/monitoring) get a plain
 * explanation and a button that fixes the URL, e.g. a bookmarked class that no longer exists.
 * Buttons only change the URL; nothing else runs. Anything else falls back to the generic state.
 */
export function MonitoringError({
  error,
  onRetry,
  actions = {},
}: {
  error: unknown;
  onRetry?: () => void;
  actions?: MonitoringErrorActions;
}) {
  const code = errorCode(error);
  const fix = (label: string, run?: () => void) =>
    run ? (
      <Button variant="outline" size="sm" onClick={run}>
        {label}
      </Button>
    ) : null;
  const back = actions.backHref ? (
    <Link href={actions.backHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      Back to subjects
    </Link>
  ) : null;

  let title: string;
  let text: string;
  let action: ReactNode;
  switch (code) {
    case 'NOT_FOUND':
      title = 'Not found';
      text = 'This generation or term does not exist, or it was removed.';
      action = back;
      break;
    case 'SUBJECT_NOT_IN_TERM':
      title = 'Subject not in this term';
      text = 'This subject is not taught in the chosen generation and term. The link may be old.';
      action = back;
      break;
    case 'PROGRAM_NOT_OFFERED':
      title = 'Program filter no longer applies';
      text = 'This subject is not offered to the program in the filter.';
      action = fix('Clear program filter', actions.clearProgram);
      break;
    case 'CLASS_NOT_IN_TERM':
      title = 'Class filter no longer applies';
      text =
        "The class in the filter is not in this term's class list. It may have been renamed or removed.";
      action = fix('Clear class filter', actions.clearClass);
      break;
    case 'CLASS_NOT_IN_PROGRAM':
      title = 'Class and program do not match';
      text = 'The class in the filter belongs to another program.';
      action = fix('Clear class filter', actions.clearClass);
      break;
    case 'UNKNOWN_CRITERION':
      title = 'Sort column no longer exists';
      text =
        "The table was sorted by a mark column that is no longer in this subject's grading scheme.";
      action = fix('Reset sorting', actions.clearSort);
      break;
    case 'VALIDATION_FAILED':
      title = 'This link has invalid values';
      text = 'Some values in the address are not valid (for example a malformed id or sort).';
      action = (
        <>
          {fix('Reset filters', actions.resetFilters)}
          {back}
        </>
      );
      break;
    default:
      return <ErrorState error={error} onRetry={onRetry} />;
  }

  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{text}</p>
        {action ? <div className="mt-2 flex flex-wrap gap-2">{action}</div> : null}
      </AlertDescription>
    </Alert>
  );
}
