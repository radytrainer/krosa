import {
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Clock,
  Loader2,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { humanize } from '@/lib/format';
import type { AccountStatus, CourseStatus, SyncStatus } from '@/lib/types';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONES: Record<Tone, string> = {
  success: 'bg-success/10 text-success ring-success/25',
  warning: 'bg-warning/10 text-warning ring-warning/25',
  danger: 'bg-destructive/10 text-destructive ring-destructive/25',
  info: 'bg-primary/5 text-foreground ring-foreground/15',
  neutral: 'bg-muted text-muted-foreground ring-foreground/10',
};

/** Status pill: always text + icon, never color alone. */
export function StatusPill({
  tone,
  icon,
  children,
  className,
}: {
  tone: Tone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap ring-1 ring-inset [&_svg]:size-3.5',
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

const SYNC: Record<SyncStatus, { tone: Tone; icon: ReactNode }> = {
  QUEUED: { tone: 'neutral', icon: <Clock aria-hidden /> },
  RUNNING: { tone: 'info', icon: <Loader2 className="animate-spin" aria-hidden /> },
  SUCCEEDED: { tone: 'success', icon: <CheckCircle2 aria-hidden /> },
  SUCCEEDED_WITH_ERRORS: { tone: 'warning', icon: <TriangleAlert aria-hidden /> },
  FAILED: { tone: 'danger', icon: <XCircle aria-hidden /> },
  CANCELLED: { tone: 'neutral', icon: <CircleSlash aria-hidden /> },
};

export function SyncStatusPill({ status }: { status: SyncStatus }) {
  const s = SYNC[status];
  return (
    <StatusPill tone={s.tone} icon={s.icon}>
      {humanize(status)}
    </StatusPill>
  );
}

export function isActiveJob(status: SyncStatus): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

const COURSE: Record<CourseStatus, { tone: Tone; icon: ReactNode; label: string }> = {
  COMPLETE: { tone: 'success', icon: <CheckCircle2 aria-hidden />, label: 'Complete' },
  INCOMPLETE: { tone: 'neutral', icon: <CircleDashed aria-hidden />, label: 'In progress' },
  NEEDS_REVIEW: { tone: 'warning', icon: <TriangleAlert aria-hidden />, label: 'Under review' },
  NOT_CONFIGURED: { tone: 'neutral', icon: <Clock aria-hidden />, label: 'Not graded yet' },
};

export function CourseStatusPill({ status }: { status: CourseStatus }) {
  const s = COURSE[status];
  return (
    <StatusPill tone={s.tone} icon={s.icon}>
      {s.label}
    </StatusPill>
  );
}

const ACCOUNT: Record<AccountStatus, { tone: Tone; label: string }> = {
  PENDING: { tone: 'warning', label: 'Pending' },
  ACTIVE: { tone: 'success', label: 'Active' },
  DISABLED: { tone: 'danger', label: 'Disabled' },
};

export function AccountStatusPill({ status }: { status: AccountStatus }) {
  const s = ACCOUNT[status];
  return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
}

export function ActivePill({
  active,
  on = 'Active',
  off = 'Disabled',
}: {
  active: boolean;
  on?: string;
  off?: string;
}) {
  return <StatusPill tone={active ? 'success' : 'neutral'}>{active ? on : off}</StatusPill>;
}
