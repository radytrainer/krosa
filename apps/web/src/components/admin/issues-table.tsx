import { CircleAlert, TriangleAlert } from 'lucide-react';
import { StatusPill } from '@/components/app/status';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { SheetIssue } from '@/lib/types';

/** Where in the sheet an issue is: `Tab · row 12 · column Q1`. */
export function issueLocation(i: SheetIssue & { source?: { label: string } | null }): string {
  if (i.source === null) return 'Whole job';
  const parts = [
    i.sheetTab,
    i.rowNumber ? `row ${i.rowNumber}` : null,
    i.columnKey ? `column ${i.columnKey}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'File';
}

export function IssuesTable({
  issues,
  showWorkbook = false,
}: {
  issues: (SheetIssue & { source?: { label: string } | null })[];
  /** Adds the workbook to each location, for jobs that cover several workbooks. */
  showWorkbook?: boolean;
}) {
  const location = (i: (typeof issues)[number]) =>
    showWorkbook && i.source ? `${i.source.label} · ${issueLocation(i)}` : issueLocation(i);
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-28">Severity</TableHead>
            <TableHead>Problem</TableHead>
            <TableHead className="hidden md:table-cell">Location</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {issues.map((i, index) => (
            <TableRow key={index} className="align-top">
              <TableCell>
                {i.severity === 'ERROR' ? (
                  <StatusPill tone="danger" icon={<CircleAlert aria-hidden />}>
                    Error
                  </StatusPill>
                ) : (
                  <StatusPill tone="warning" icon={<TriangleAlert aria-hidden />}>
                    Warning
                  </StatusPill>
                )}
              </TableCell>
              <TableCell className="whitespace-normal">
                <p>{i.message}</p>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {i.code}
                  {i.studentCode ? ` · ${i.studentCode}` : ''}
                  {i.courseKey ? ` · ${i.courseKey}` : ''}
                  {i.criterionKey ? ` · ${i.criterionKey}` : ''}
                  {i.rawValue ? ` · value "${i.rawValue}"` : ''}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground md:hidden">{location(i)}</p>
              </TableCell>
              <TableCell className="hidden text-muted-foreground md:table-cell">
                {location(i)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
