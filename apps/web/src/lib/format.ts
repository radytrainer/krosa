const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatDateTime(value: string | null | undefined): string {
  return value ? dateTime.format(new Date(value)) : '—';
}

/** `YYYY-MM-DD` values are calendar dates; format them in UTC so they never shift a day. */
export function formatDate(value: string | null | undefined): string {
  return value ? dateOnly.format(new Date(`${value.slice(0, 10)}T00:00:00Z`)) : '—';
}

export function formatDuration(from: string | null, to: string | null): string {
  if (!from) return '—';
  const ms = (to ? new Date(to) : new Date()).getTime() - new Date(from).getTime();
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** `SUCCEEDED_WITH_ERRORS` → `Succeeded with errors`. */
export function humanize(value: string): string {
  const text = value.replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Drops trailing zeros of API decimal strings for compact display: `20.000` → `20`. */
export function trimDecimal(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
