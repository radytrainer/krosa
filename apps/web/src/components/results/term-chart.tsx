'use client';

import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { TermSummary } from '@/lib/types';

interface Point {
  term: string;
  value: number | null;
  provisional: boolean;
  summary: TermSummary;
}

function toPoints(terms: { name: string; summary: TermSummary }[]): Point[] {
  return terms.map((t) => {
    const raw = t.summary.average ?? t.summary.provisionalAverage;
    return {
      term: t.name,
      value: raw === null ? null : Number(raw),
      provisional: t.summary.average === null && raw !== null,
      summary: t.summary,
    };
  });
}

function describe(p: Point): string {
  if (p.value === null) return p.summary.totalCourses ? 'No completed course yet' : 'No courses';
  return p.provisional ? 'Provisional: not every course is complete' : 'Final term average';
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: Point }[] }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <p className="font-medium">{p.term}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">
        {p.value === null ? '—' : p.value.toFixed(2)}
      </p>
      <p className="text-muted-foreground">{describe(p)}</p>
      <p className="text-muted-foreground">
        {p.summary.completedCourses} of {p.summary.totalCourses} courses complete
      </p>
    </div>
  );
}

/** Rounded top, square base: data ends anchored to the baseline. Hatched when provisional. */
function TermBar(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: Point;
}) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  if (!payload || payload.value === null || height <= 0) return null;
  const r = Math.min(4, width / 2, height);
  const d = `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
  return (
    <g>
      <path d={d} fill="var(--series-1)" fillOpacity={payload.provisional ? 0.45 : 1} />
      {payload.provisional ? <path d={d} fill="url(#provisional-hatch)" /> : null}
    </g>
  );
}

/**
 * Term averages (0–100) for the student dashboard. One series, so no legend: the heading names it.
 * Provisional averages are hatched and labelled in the tooltip and table (never color alone).
 */
export function TermChart({ terms }: { terms: { name: string; summary: TermSummary }[] }) {
  const [asTable, setAsTable] = useState(false);
  const points = toPoints(terms);
  const hasProvisional = points.some((p) => p.provisional);

  return (
    <figure className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <figcaption className="text-sm text-muted-foreground">
          Credit-weighted average per term, out of 100.
          {hasProvisional ? ' Hatched bars are provisional.' : ''}
        </figcaption>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
        >
          {asTable ? 'Show chart' : 'Show as table'}
        </Button>
      </div>
      {asTable ? (
        <div className="overflow-x-auto rounded-lg ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Term</TableHead>
                <TableHead className="text-right">Average</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Courses complete</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {points.map((p) => (
                <TableRow key={p.term}>
                  <TableCell>{p.term}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.value === null ? '—' : p.value.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{describe(p)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.summary.completedCourses} / {p.summary.totalCourses}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div
          className="h-64 w-full"
          role="img"
          aria-label={`Term averages: ${points.map((p) => `${p.term} ${p.value === null ? 'none' : p.value.toFixed(2)}${p.provisional ? ' provisional' : ''}`).join(', ')}`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={points}
              margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
              barCategoryGap="30%"
            >
              <defs>
                <pattern
                  id="provisional-hatch"
                  width="6"
                  height="6"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <line x1="0" y1="0" x2="0" y2="6" stroke="var(--series-1)" strokeWidth="2" />
                </pattern>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis
                dataKey="term"
                tickLine={false}
                axisLine={{ stroke: 'var(--border)' }}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
                interval={0}
              />
              <YAxis
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--muted)', opacity: 0.6 }} />
              <Bar dataKey="value" maxBarSize={56} shape={<TermBar />} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </figure>
  );
}
