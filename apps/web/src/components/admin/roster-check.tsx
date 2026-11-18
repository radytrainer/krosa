'use client';

import { TriangleAlert, Users } from 'lucide-react';
import { useId } from 'react';
import { PagedTable } from '@/components/admin/paged-issues';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { NameIssue, RosterCheck, SheetPreview, StudentConflict } from '@/lib/types';

/** True when the roster check lists anyone, so the admin must tick "I have checked". */
export function rosterCheckNeeded(check: RosterCheck | null | undefined): boolean {
  return Boolean(check && (check.missing.length > 0 || check.new.length > 0));
}

function termList(terms: number[]): string {
  if (terms.length === 0) return 'earlier terms';
  const names = terms.map((t) => `Term ${t}`);
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Terms 2–5: students of earlier terms missing from this sheet's ALL tab, and students listed for
 * the first time. Nothing shows when both lists are empty. The tick is required to sync.
 */
export function RosterCheckSection({
  check,
  checked,
  onCheckedChange,
  disabled,
}: {
  check: RosterCheck | null | undefined;
  checked: boolean;
  onCheckedChange(value: boolean): void;
  disabled?: boolean;
}) {
  const id = useId();
  if (!check || !rosterCheckNeeded(check)) return null;
  const reused = check.new.filter((s) => s.existingAccount).length;
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3" data-slot="roster-check">
      <Alert>
        <Users aria-hidden />
        <AlertTitle id={`${id}-title`}>
          Check the roster against {termList(check.earlierTerms)}
        </AlertTitle>
        <AlertDescription>
          {check.missing.length} missing from this sheet · {check.new.length} new in this sheet.
          Students are matched by student ID only.
        </AlertDescription>
      </Alert>
      {check.missing.length ? (
        <div className="space-y-1.5">
          <h4 className="text-sm font-medium">
            Missing ({check.missing.length}): in an earlier term, not in this sheet&apos;s ALL tab
          </h4>
          <p className="text-xs text-muted-foreground">
            They get no enrollment in this term. Their earlier terms do not change.
          </p>
          <PagedTable
            label="Students missing from this sheet"
            rows={check.missing}
            rowKey={(s) => s.studentCode}
            noun={['student', 'students']}
            columns={[
              {
                header: 'Student ID',
                cell: (s) => <span className="font-mono">{s.studentCode}</span>,
              },
              { header: 'Name', cell: (s) => s.fullName },
              { header: 'Last term', cell: (s) => `Term ${s.lastTerm}` },
            ]}
          />
        </div>
      ) : null}
      {check.new.length ? (
        <div className="space-y-1.5">
          <h4 className="text-sm font-medium">
            New ({check.new.length}): in this sheet, in no earlier term
          </h4>
          <p className="text-xs text-muted-foreground">
            They are enrolled in this term only.
            {reused
              ? ` ${reused} already have an account in this generation, which is reused.`
              : ''}{' '}
            The others get a new account without a password.
          </p>
          <PagedTable
            label="Students new in this sheet"
            rows={check.new}
            rowKey={(s) => s.studentCode}
            noun={['student', 'students']}
            columns={[
              {
                header: 'Student ID',
                cell: (s) => <span className="font-mono">{s.studentCode}</span>,
              },
              { header: 'Name', cell: (s) => s.fullName },
              {
                header: 'Account',
                cell: (s) => (s.existingAccount ? 'Existing, reused' : 'New'),
              },
            ]}
          />
        </div>
      ) : null}
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onCheckedChange(value === true)}
        />
        <Label htmlFor={id} className="font-normal">
          I have checked these students
        </Label>
      </div>
    </section>
  );
}

const CONFLICT_LABEL: Record<StudentConflict['code'], string> = {
  STUDENT_IN_OTHER_GENERATION: 'ID belongs to a student of another generation',
  STUDENT_ID_CONFLICT: 'ID is used by an admin account',
};

/**
 * Students the sync skips (name differs from the system, ID taken elsewhere) and names that only
 * differ in order. Names are plain text.
 */
export function StudentNameIssues({ summary }: { summary: SheetPreview['summary'] }) {
  const mismatches: NameIssue[] = summary.nameMismatches ?? [];
  const order: NameIssue[] = summary.nameOrderWarnings ?? [];
  const conflicts: StudentConflict[] = summary.studentConflicts ?? [];
  if (!mismatches.length && !order.length && !conflicts.length) return null;
  const nameColumns = [
    { header: 'Tab', cell: (n: NameIssue) => n.sheetTab },
    { header: 'Row', cell: (n: NameIssue) => n.rowNumber, align: 'right' as const },
    {
      header: 'Student ID',
      cell: (n: NameIssue) => <span className="font-mono">{n.studentCode}</span>,
    },
    { header: 'Name in the sheet', cell: (n: NameIssue) => n.sheetName },
    { header: 'Name in the system', cell: (n: NameIssue) => n.systemName },
  ];
  return (
    <div className="space-y-4" data-slot="student-name-issues">
      {mismatches.length ? (
        <div className="space-y-1.5">
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertTitle>
              {mismatches.length} {mismatches.length === 1 ? 'student is' : 'students are'} skipped:
              the name differs from the system
            </AlertTitle>
            <AlertDescription>
              Nothing is imported or changed for them; everyone else syncs. Correct the sheet, or
              use Edit name on the student&apos;s page if the system is wrong, then preview again.
            </AlertDescription>
          </Alert>
          <PagedTable
            label="Name mismatches"
            rows={mismatches}
            rowKey={(n) => `${n.sheetTab}:${n.rowNumber}:${n.studentCode}`}
            noun={['student', 'students']}
            columns={nameColumns}
          />
        </div>
      ) : null}
      {conflicts.length ? (
        <div className="space-y-1.5">
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertTitle>
              {conflicts.length} {conflicts.length === 1 ? 'student is' : 'students are'} skipped:
              the ID is already used
            </AlertTitle>
            <AlertDescription>Nothing is created for them; everyone else syncs.</AlertDescription>
          </Alert>
          <PagedTable
            label="Student ID conflicts"
            rows={conflicts}
            rowKey={(c) => `${c.sheetTab}:${c.rowNumber}:${c.studentCode}`}
            noun={['student', 'students']}
            columns={[
              { header: 'Tab', cell: (c) => c.sheetTab },
              { header: 'Row', cell: (c) => c.rowNumber, align: 'right' },
              {
                header: 'Student ID',
                cell: (c) => <span className="font-mono">{c.studentCode}</span>,
              },
              { header: 'Problem', cell: (c) => CONFLICT_LABEL[c.code] ?? c.code },
            ]}
          />
        </div>
      ) : null}
      {order.length ? (
        <div className="space-y-1.5">
          <h4 className="text-sm font-medium">
            Name order differs ({order.length}): imported, the name in the system is kept
          </h4>
          <PagedTable
            label="Name order warnings"
            rows={order}
            rowKey={(n) => `${n.sheetTab}:${n.rowNumber}:${n.studentCode}`}
            noun={['student', 'students']}
            columns={nameColumns}
          />
        </div>
      ) : null}
    </div>
  );
}
