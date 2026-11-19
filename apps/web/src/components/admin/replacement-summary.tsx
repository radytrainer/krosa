'use client';

import { TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import { PagedTable } from '@/components/admin/paged-issues';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Replacement } from '@/lib/types';

/** The typed label matches: exact and case sensitive, ignoring spaces around it (as the API). */
export function termLabelMatches(typed: string, replacement: Replacement | null | undefined) {
  return Boolean(replacement) && typed.trim() === replacement!.termLabel;
}

const PROTECTED_REASON: Record<string, string> = {
  LOGGED_IN: 'Has logged in',
  NAME_EDITED: 'Name edited',
};

function n(value: number, one: string, many: string) {
  return `${value.toLocaleString()} ${value === 1 ? one : many}`;
}

function NameList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <p className="text-sm">
      <span className="font-medium">
        {title} ({items.length}):
      </span>{' '}
      {items.join(', ')}
    </p>
  );
}

/**
 * What a replacement deletes for good: every subject and student it touches, with counts. Used on
 * the preview and again in the dialog that confirms it.
 */
export function ReplacementSummary({ replacement }: { replacement: Replacement }) {
  const { subjects, students, counts, termLabel } = replacement;
  const protectedAccounts = students.accountsProtected ?? [];
  return (
    <div className="space-y-4" data-slot="replacement-summary">
      <Alert variant="destructive">
        <TriangleAlert aria-hidden />
        <AlertTitle>
          This sheet permanently deletes the data of {termLabel}. This cannot be undone.
        </AlertTitle>
        <AlertDescription>
          <p>
            It is a different spreadsheet, so after the sync {termLabel} holds exactly what this
            sheet holds. Earlier scores, score history and teacher comments of this term are
            deleted, not archived. Other terms do not change.
          </p>
          <ul className="mt-2 list-disc pl-4 tabular-nums">
            <li>{n(counts.subjects, 'subject', 'subjects')} deleted</li>
            <li>{n(counts.scoreRows, 'score row', 'score rows')}</li>
            <li>{n(counts.scoreHistoryRows, 'score history row', 'score history rows')}</li>
            <li>{n(counts.comments, 'teacher comment', 'teacher comments')}</li>
            <li>{n(counts.enrollments, 'subject enrollment', 'subject enrollments')}</li>
            <li>{n(counts.termEnrollments, 'term enrollment', 'term enrollments')}</li>
            <li>{n(counts.accounts, 'student account', 'student accounts')}</li>
            {counts.accountsProtected !== undefined ? (
              <li>
                Accounts kept (logged in or name edited):{' '}
                {counts.accountsProtected.toLocaleString()}
              </li>
            ) : null}
          </ul>
        </AlertDescription>
      </Alert>

      <section className="space-y-2" aria-label="Subjects">
        <h4 className="text-sm font-medium">
          Subjects: {subjects.kept.length} kept · {subjects.added.length} added ·{' '}
          {subjects.deleted.length} deleted
        </h4>
        <NameList
          title="Kept (the subject stays, its student data is replaced)"
          items={subjects.kept}
        />
        <NameList title="Added" items={subjects.added} />
        {subjects.deleted.length ? (
          <PagedTable
            label="Subjects deleted"
            rows={subjects.deleted}
            rowKey={(s) => s.offeringId}
            noun={['subject', 'subjects']}
            columns={[
              { header: 'Deleted subject', cell: (s) => s.subject },
              { header: 'Students', cell: (s) => s.students, align: 'right' },
              { header: 'Score rows', cell: (s) => s.scores, align: 'right' },
              { header: 'Comments', cell: (s) => s.comments, align: 'right' },
            ]}
          />
        ) : null}
      </section>

      <section className="space-y-2" aria-label="Students">
        <h4 className="text-sm font-medium tabular-nums">
          Students: {students.kept} kept · {students.added} added · {students.dataRemoved.length}{' '}
          lose this term&apos;s data · {students.accountsDeleted.length} accounts deleted · Accounts
          kept (logged in or name edited): {protectedAccounts.length}
        </h4>
        {students.dataRemoved.length ? (
          <div className="space-y-1.5">
            <p className="text-sm">
              <span className="font-medium">Data removed ({students.dataRemoved.length}):</span>{' '}
              their data in this term is deleted; the account stays.
            </p>
            <PagedTable
              label="Students whose data in this term is deleted"
              rows={students.dataRemoved}
              rowKey={(s) => s.studentCode}
              noun={['student', 'students']}
              columns={[
                {
                  header: 'Student ID',
                  cell: (s) => <span className="font-mono">{s.studentCode}</span>,
                },
                { header: 'Name', cell: (s) => s.fullName },
              ]}
            />
          </div>
        ) : null}
        {students.accountsDeleted.length ? (
          <div className="space-y-1.5">
            <p className="text-sm">
              <span className="font-medium">
                Accounts deleted ({students.accountsDeleted.length}):
              </span>{' '}
              the student exists only in this term&apos;s old sheet. They are signed out and the
              account is deleted. If the new sheet lists the ID, a new account is created without a
              password.
            </p>
            <PagedTable
              label="Student accounts deleted"
              rows={students.accountsDeleted}
              rowKey={(s) => s.studentCode}
              noun={['account', 'accounts']}
              columns={[
                {
                  header: 'Student ID',
                  cell: (s) => <span className="font-mono">{s.studentCode}</span>,
                },
                { header: 'Name', cell: (s) => s.fullName },
              ]}
            />
          </div>
        ) : null}
        {protectedAccounts.length ? (
          <div className="space-y-1.5">
            <p className="text-sm">
              <span className="font-medium">
                Accounts kept (logged in or name edited): {protectedAccounts.length}.
              </span>{' '}
              These accounts are not deleted. Their data in this term is still replaced.
            </p>
            <PagedTable
              label="Student accounts kept (logged in or name edited)"
              rows={protectedAccounts}
              rowKey={(s) => s.studentCode}
              noun={['account', 'accounts']}
              columns={[
                {
                  header: 'Student ID',
                  cell: (s) => <span className="font-mono">{s.studentCode}</span>,
                },
                { header: 'Name', cell: (s) => s.fullName },
                { header: 'Reason', cell: (s) => PROTECTED_REASON[s.reason] ?? s.reason },
              ]}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** "Type GEN2027 Term 1 to confirm": the confirm button stays disabled until it matches. */
export function TermLabelInput({
  termLabel,
  value,
  onChange,
  disabled,
}: {
  termLabel: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const id = useId();
  const typed = value.trim();
  const wrong = typed.length > 0 && typed !== termLabel;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Type {termLabel} to confirm</Label>
      <Input
        id={id}
        value={value}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-invalid={wrong || undefined}
        aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.value)}
      />
      <p
        id={`${id}-hint`}
        className={wrong ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
      >
        {wrong ? `Does not match. Type exactly ${termLabel}.` : 'Case sensitive.'}
      </p>
    </div>
  );
}
