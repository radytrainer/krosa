'use client';

import type { GradeScaleInfo, MonitoringLevel, MonitoringSubjectSummaryView } from '@ssrs/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { trimDecimal } from '@/lib/format';
import { LEVEL_LABEL } from './level-labels';
import { LevelBars } from './level-bars';
import { GradeScaleNotice } from './term-badges';
import { percent } from './text';

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {hint ? <dd className="text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}

/** Which letters make each level, from the API's scale. Never named in code (M3). */
export function LevelLegend({ scale }: { scale: GradeScaleInfo }) {
  if (!scale.usable || scale.levels.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Levels:{' '}
      {scale.levels.map((l, i) => (
        <span key={l.level}>
          {i > 0 ? ' · ' : ''}
          <span className="text-foreground">{LEVEL_LABEL[l.level]}</span> {l.letters.join(', ')}
        </span>
      ))}
      {' · '}
      <span className="text-foreground">Incomplete</span> any result not complete
    </p>
  );
}

/** Subject figures and the level chart. Clicking a level toggles the table's level filter. */
export function LevelSummary({
  summary,
  level,
  onLevel,
}: {
  summary: MonitoringSubjectSummaryView;
  level: MonitoringLevel | null;
  onLevel(level: MonitoringLevel | null): void;
}) {
  const { stats, gradeScale } = summary;
  const total = (v: string | null) => (v === null ? '-' : trimDecimal(v));
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Card size="sm">
        <CardHeader>
          <CardTitle>Figures</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Students" value={stats.students} hint="Enrolled, withdrawn excluded" />
            <Stat label="Complete" value={stats.complete} />
            <Stat label="Incomplete" value={stats.incomplete} />
            <Stat
              label="Needs review"
              value={stats.needsReview}
              hint="Also counted as incomplete"
            />
            <Stat label="Pass rate" value={percent(stats.passRate)} hint="Of complete results" />
            <Stat label="Average total" value={total(stats.averageTotal)} hint="Complete only" />
            <Stat label="Highest total" value={total(stats.highestTotal)} />
            <Stat label="Lowest total" value={total(stats.lowestTotal)} />
          </dl>
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle>Students by level</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {stats.levels === null || !gradeScale.usable ? (
            <GradeScaleNotice />
          ) : stats.students === 0 ? (
            <p className="text-sm text-muted-foreground">No enrolled students to count.</p>
          ) : (
            <>
              <LevelBars
                levels={stats.levels}
                gradeScale={gradeScale}
                selected={level}
                onSelect={onLevel}
              />
              <p className="text-xs text-muted-foreground">
                Select a level to list only those students; select it again to show all.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
