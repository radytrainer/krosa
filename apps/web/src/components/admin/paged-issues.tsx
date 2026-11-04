'use client';

import { useState, type ReactNode } from 'react';
import { IssuesTable } from '@/components/admin/issues-table';
import { NativeSelect } from '@/components/app/form';
import { Pagination } from '@/components/app/pagination';
import type { SheetIssue } from '@/lib/types';

/** Issues per page on every issue list: sync jobs, previews and tab detection. */
export const ISSUES_PAGE_SIZE = 5;

type Issue = SheetIssue & { source?: { label: string } | null };

/**
 * One page of issues and the total. Page controls and the "1–5 of 23" range appear only when
 * there is more than one page. Server-paged lists pass the page they fetched; lists held in
 * memory use `useIssuePage`, so both look and behave the same.
 */
export function PagedIssues({
  issues,
  total,
  page,
  onPage,
  showWorkbook,
}: {
  issues: Issue[];
  total: number;
  page: number;
  onPage(page: number): void;
  showWorkbook?: boolean;
}) {
  return (
    <div>
      <IssuesTable issues={issues} showWorkbook={showWorkbook} />
      {total > ISSUES_PAGE_SIZE ? (
        <Pagination page={page} pageSize={ISSUES_PAGE_SIZE} total={total} onPage={onPage} />
      ) : (
        <p className="pt-3 text-sm text-muted-foreground">
          {total === 1 ? '1 issue' : `${total} issues`}
        </p>
      )}
    </div>
  );
}

/**
 * Pages a list held in memory. The page goes back to 1 whenever `resetKey` changes (new results
 * or another filter), without an effect.
 */
export function useIssuePage<T>(items: readonly T[], resetKey: string) {
  const [state, setState] = useState({ key: resetKey, page: 1 });
  const pages = Math.max(1, Math.ceil(items.length / ISSUES_PAGE_SIZE));
  const page = state.key === resetKey ? Math.min(state.page, pages) : 1;
  const start = (page - 1) * ISSUES_PAGE_SIZE;
  return {
    page,
    total: items.length,
    items: items.slice(start, start + ISSUES_PAGE_SIZE),
    setPage: (next: number) => setState({ key: resetKey, page: next }),
  };
}

export interface IssueFilterValues {
  severity: string;
  sheetTab: string;
}

/** Tab and severity filters. Every change goes back to page 1 (the caller resets it). */
export function IssueFilters({
  value,
  tabs,
  onChange,
  children,
}: {
  value: IssueFilterValues;
  tabs: readonly string[];
  onChange(value: IssueFilterValues): void;
  /** Extra filters shown first, such as the workbook of a multi-source job. */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {children}
      <NativeSelect
        aria-label="Tab"
        className="w-40"
        value={value.sheetTab}
        onChange={(e) => onChange({ ...value, sheetTab: e.target.value })}
      >
        <option value="">All tabs</option>
        {tabs.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Severity"
        className="w-40"
        value={value.severity}
        onChange={(e) => onChange({ ...value, severity: e.target.value })}
      >
        <option value="">Errors and warnings</option>
        <option value="ERROR">Errors only</option>
        <option value="WARNING">Warnings only</option>
      </NativeSelect>
    </div>
  );
}
