'use client';

import { ArrowRightLeft, ExternalLink, FileSpreadsheet, Info, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Confirm } from '@/components/app/confirm';
import { Field, fieldErrors, onSubmit } from '@/components/app/form';
import { StatusPill } from '@/components/app/status';
import { ErrorState, LoadingRows } from '@/components/app/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { json, useApi, useApiMutation } from '@/lib/query';
import type { SheetCheck, Source, TermWorkbooks } from '@/lib/types';

const INVALIDATE = ['/admin/term-workbooks', '/admin/sources', '/admin/generations'];

function SheetForm({
  termId,
  reviewed,
  replacing,
  onCancel,
}: {
  termId: string;
  /** Goes through review as a pending sheet instead of connecting straight away. */
  reviewed: boolean;
  replacing: boolean;
  onCancel?: () => void;
}) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const router = useRouter();
  const account = useApi<{ email: string | null }>('/admin/sources/service-account');
  const check = useApiMutation((body: { url: string }) =>
    apiFetch<SheetCheck>(`/admin/terms/${termId}/sources/check`, json(body)),
  );
  const connect = useApiMutation(
    (body: { url: string; label: string }) =>
      apiFetch<Source>(`/admin/terms/${termId}/sources${reviewed ? '/change' : ''}`, json(body)),
    {
      success: reviewed
        ? 'New sheet connected. Review its tabs next.'
        : 'Sheet connected. Detect its tabs next.',
      invalidate: INVALIDATE,
      onSuccess: (s) => router.push(`/admin/sources/${s.id}`),
    },
  );
  const checked = check.data;

  return (
    <form
      className="space-y-4"
      onSubmit={onSubmit(() =>
        checked
          ? connect.mutate({ url: url.trim(), label: label.trim() || checked.spreadsheetTitle })
          : check.mutate({ url: url.trim() }),
      )}
    >
      {account.data?.email ? (
        <Alert>
          <FileSpreadsheet aria-hidden />
          <AlertTitle>Share the file first</AlertTitle>
          <AlertDescription>
            Give <strong className="break-all">{account.data.email}</strong> Viewer access.
          </AlertDescription>
        </Alert>
      ) : null}
      <Field
        label={replacing ? 'New spreadsheet URL' : 'Spreadsheet URL'}
        required
        error={fieldErrors(check.error).url ?? check.error?.message ?? null}
      >
        {(p) => (
          <Input
            {...p}
            name="url"
            type="url"
            value={url}
            readOnly={Boolean(checked)}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
      </Field>
      {checked ? (
        <>
          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            <p className="font-medium">{checked.spreadsheetTitle}</p>
            <p className="text-muted-foreground">Tabs: {checked.tabs.join(', ')}</p>
          </div>
          <Field label="Label" hint="How the sheet appears in lists.">
            {(p) => (
              <Input
                {...p}
                name="label"
                maxLength={120}
                value={label}
                placeholder={checked.spreadsheetTitle}
                onChange={(e) => setLabel(e.target.value)}
              />
            )}
          </Field>
          {reviewed ? (
            <Alert>
              <Info aria-hidden />
              <AlertTitle>Student scores will not change yet</AlertTitle>
              <AlertDescription>
                Students keep seeing their current scores until the new sheet is reviewed and
                synced.
              </AlertDescription>
            </Alert>
          ) : null}
        </>
      ) : null}
      {connect.error ? (
        <p className="text-sm text-destructive" role="alert">
          {connect.error.message}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        {checked ? (
          <Button type="submit" disabled={connect.isPending}>
            {reviewed ? 'Connect new sheet' : 'Connect sheet'}
          </Button>
        ) : (
          <Button type="submit" disabled={check.isPending || !url.trim()}>
            {check.isPending ? 'Checking the file…' : 'Check sheet'}
          </Button>
        )}
      </div>
    </form>
  );
}

/** The Google Sheet of a term: its URL, and the way to replace or remove it. */
export function TermSheet({ term }: { term: { id: string; name: string } }) {
  const [replacing, setReplacing] = useState(false);
  const { data, error, refetch } = useApi<TermWorkbooks[]>('/admin/term-workbooks', {
    refetchOnMount: 'always',
    // A running sync locks the sheet, so keep watching until it ends.
    refetchInterval: (q) => (q.state.data?.some((r) => r.runningJobId) ? 3000 : false),
  });
  const remove = useApiMutation(
    (sourceId: string) =>
      apiFetch(`/admin/sources/${sourceId}`, json({ status: 'DISABLED' }, 'PATCH')),
    { success: 'Sheet removed. Existing scores stay as they are.', invalidate: INVALIDATE },
  );
  const discard = useApiMutation(
    (sourceId: string) => apiFetch(`/admin/sources/${sourceId}/discard`, { method: 'POST' }),
    { success: 'New sheet discarded.', invalidate: INVALIDATE },
  );

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (!data) return <LoadingRows rows={2} />;
  const row = data.find((r) => r.term.id === term.id);
  if (!row) return null;
  const { active, pending } = row;
  const busy = row.runningJobId !== null;
  const synced = [active, pending, ...row.history].some((s) => s?.lastSyncedAt);
  const empty = !active && !pending;

  return (
    <section className="space-y-3 border-t pt-4" aria-label="Google Sheet">
      <h3 className="text-sm font-medium">Google Sheet</h3>
      {active ? (
        <div className="text-sm">
          <p>{active.label}</p>
          <a
            href={active.spreadsheetUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-start gap-1 break-all text-muted-foreground hover:underline"
          >
            {active.spreadsheetUrl}
            <ExternalLink className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <p className="text-xs text-muted-foreground">
            Last sync {formatDateTime(active.lastSyncedAt)}
          </p>
        </div>
      ) : null}
      {pending ? (
        <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm">
          <StatusPill tone="warning">New sheet connected, not synced yet</StatusPill>
          <p>
            <Link href={`/admin/sources/${pending.id}`} className="hover:underline">
              {pending.label}
            </Link>
          </p>
          <a
            href={pending.spreadsheetUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="block break-all text-muted-foreground hover:underline"
          >
            {pending.spreadsheetUrl}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <Confirm
            trigger={
              <Button variant="outline" size="sm" disabled={busy}>
                Discard new sheet
              </Button>
            }
            title="Discard this new sheet?"
            description="It goes back to this term's history. Student scores do not change."
            confirmLabel="Discard"
            destructive
            onConfirm={() => discard.mutateAsync(pending.id)}
          />
        </div>
      ) : null}
      {empty ? (
        <p className="text-sm text-muted-foreground">
          {synced
            ? 'No sheet connected. Students keep their current scores.'
            : 'No sheet connected.'}
        </p>
      ) : null}
      {empty || replacing ? (
        <SheetForm
          termId={term.id}
          reviewed={synced || !empty}
          replacing={!empty}
          onCancel={empty ? undefined : () => setReplacing(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setReplacing(true)}>
            <ArrowRightLeft aria-hidden />
            Replace
          </Button>
          {active && !pending ? (
            <Confirm
              trigger={
                <Button variant="outline" size="sm" disabled={busy}>
                  <Trash2 aria-hidden />
                  Remove
                </Button>
              }
              title={`Remove this sheet from ${term.name}?`}
              description={
                synced
                  ? 'Syncing stops and students keep their current scores. You can connect a new sheet at any time.'
                  : 'The term goes back to having no sheet. You can connect it again at any time.'
              }
              confirmLabel="Remove sheet"
              destructive
              onConfirm={() => remove.mutateAsync(active.id)}
            />
          ) : null}
        </div>
      )}
      {busy ? (
        <p className="text-xs text-muted-foreground">
          A sync of this term is running. Wait until it finishes to change its sheet.
        </p>
      ) : null}
    </section>
  );
}
