'use client';

import { ScrollText } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { useUrlState } from '@/components/admin/use-url-state';
import { NativeSelect } from '@/components/app/form';
import { PageHeader } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
import { EmptyState, ErrorState, LoadingRows, PageLoading } from '@/components/app/states';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { qs, useApi } from '@/lib/query';
import type { AuditEntry, Paginated } from '@/lib/types';

const ACTION_GROUPS = [
  ['', 'All actions'],
  ['auth.', 'Sign-in and sessions'],
  ['student.', 'Student accounts'],
  ['generation.', 'Generations'],
  ['term.', 'Terms'],
  ['source.', 'Sheet sources'],
  ['sync.', 'Synchronization'],
  ['course.', 'Course catalog'],
  ['offering.', 'Offerings'],
  ['criterion.', 'Criteria'],
  ['criteria.', 'Criteria order'],
  ['scheme.', 'Grading schemes'],
  ['admin.', 'Administrators'],
] as const;

/** `2026-10-26` (local date input) → ISO timestamp at local midnight, or the next day for `to`. */
function dayBoundary(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T00:00:00`);
  if (endOfDay) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

function AuditLog() {
  const { values, page, set } = useUrlState([
    'action',
    'entityType',
    'entityId',
    'from',
    'to',
  ] as const);
  const [entityId, setEntityId] = useState(values.entityId);
  useEffect(() => {
    const t = setTimeout(() => {
      if (entityId !== values.entityId) set({ entityId: entityId.trim() });
    }, 300);
    return () => clearTimeout(t);
  }, [entityId, values.entityId, set]);

  const list = useApi<Paginated<AuditEntry>>(
    `/admin/audit-logs${qs({
      action: values.action,
      entityType: values.entityType,
      entityId: values.entityId,
      from: dayBoundary(values.from, false),
      to: dayBoundary(values.to, true),
      page,
      pageSize: 50,
    })}`,
    { keepPrevious: true },
  );

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every sign-in, account change and configuration change, newest first. Entries cannot be edited."
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[14rem_minmax(0,16rem)_10rem_10rem]">
        <NativeSelect
          aria-label="Action"
          value={values.action}
          onChange={(e) => set({ action: e.target.value })}
        >
          {ACTION_GROUPS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
        <Input
          aria-label="Entity ID"
          placeholder="Entity ID"
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
        />
        <Input
          aria-label="From date"
          type="date"
          value={values.from}
          onChange={(e) => set({ from: e.target.value })}
        />
        <Input
          aria-label="To date"
          type="date"
          value={values.to}
          onChange={(e) => set({ to: e.target.value })}
        />
      </div>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <LoadingRows />
      ) : list.data.data.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="size-8" />}
          title="No entries"
          description="Nothing matches these filters."
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead className="hidden md:table-cell">Actor</TableHead>
                  <TableHead className="hidden lg:table-cell">Entity</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.data.map((e) => (
                  <TableRow key={e.id} className="align-top">
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(e.createdAt)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.action}</TableCell>
                    <TableCell className="hidden md:table-cell">
                      {e.actor ? e.actor.username : e.actorType === 'SYSTEM' ? 'System' : '—'}
                      {e.ip ? (
                        <span className="block text-xs text-muted-foreground">{e.ip}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {e.entityType ? (
                        <button
                          type="button"
                          className="text-left text-xs hover:underline"
                          onClick={() => {
                            setEntityId(e.entityId ?? '');
                            set({ entityId: e.entityId });
                          }}
                          title="Show only this entity"
                        >
                          {e.entityType}
                          <span className="block font-mono text-muted-foreground">
                            {e.entityId?.slice(0, 13)}…
                          </span>
                        </button>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="max-w-xs">
                      {Object.keys(e.metadata).length ? (
                        <details>
                          <summary className="cursor-pointer text-xs text-muted-foreground">
                            {Object.keys(e.metadata).slice(0, 3).join(', ')}
                          </summary>
                          <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
                            {JSON.stringify(e.metadata, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
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

export default function AuditPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <AuditLog />
    </Suspense>
  );
}
