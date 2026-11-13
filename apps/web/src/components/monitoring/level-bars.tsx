'use client';

import type { GradeScaleInfo, MonitoringLevel } from '@ssrs/shared';
import { LEVEL_LABEL, levelLetters } from './level-labels';
import { cn } from '@/lib/utils';

export interface LevelStat {
  level: MonitoringLevel;
  count: number;
  percent: string;
}

/**
 * Horizontal bars by level, made of plain divs. Each bar is a toggle button that sets the level
 * filter; label, count and percent are text, so nothing relies on colour. One calm colour for every
 * level (grade tones are deliberately not used here).
 */
export function LevelBars({
  levels,
  gradeScale,
  selected,
  onSelect,
  disabled,
}: {
  levels: LevelStat[];
  gradeScale: GradeScaleInfo;
  selected: MonitoringLevel | null;
  onSelect(level: MonitoringLevel | null): void;
  disabled?: boolean;
}) {
  const max = Math.max(1, ...levels.map((l) => l.count));
  return (
    <ul className="space-y-1.5" aria-label="Students by level">
      {levels.map((l) => {
        const on = selected === l.level;
        const letters = levelLetters(gradeScale, l.level);
        return (
          <li key={l.level}>
            <button
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onSelect(on ? null : l.level)}
              title={on ? 'Show all levels' : `Show only ${LEVEL_LABEL[l.level]}`}
              className={cn(
                'grid w-full cursor-pointer grid-cols-[6.5rem_minmax(0,1fr)_6.5rem] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
                on && 'bg-muted ring-1 ring-foreground/20',
              )}
            >
              <span className="min-w-0">
                <span className={cn('block', on && 'font-semibold')}>{LEVEL_LABEL[l.level]}</span>
                {letters ? (
                  <span className="block text-xs text-muted-foreground">{letters}</span>
                ) : null}
              </span>
              <span className="h-3 overflow-hidden rounded-full bg-muted" aria-hidden>
                <span
                  className={cn(
                    'block h-full rounded-full',
                    on ? 'bg-primary' : 'bg-foreground/35',
                  )}
                  style={{ width: `${(l.count / max) * 100}%` }}
                />
              </span>
              <span className="text-right tabular-nums">
                {l.count}
                <span className="text-muted-foreground"> · {l.percent}%</span>
                {on ? <span className="sr-only"> (filter on)</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
