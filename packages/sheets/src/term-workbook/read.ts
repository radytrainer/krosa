import { createHash } from 'node:crypto';
import type { Grid, SheetsReader } from '../reader.js';
import { cellText, parseIntegerCell } from '../template/cells.js';
import { LIMITS } from '../template/constants.js';
import { IssueLog, rawValue, type TemplateIssue } from '../template/issues.js';
import {
  detectTabLayout,
  headerSignature,
  TERM_WORKBOOK_MAX_MARK,
  type TabLayout,
} from './layout.js';
import { parseRoster, type RosterStudent } from './roster.js';
import { parseSubjectRows } from './subject-rows.js';
import type { ColumnRole } from './labels.js';
import type { ParsedCourse, ParsedCriterion } from './types.js';

export const TERM_META_TAB = '_meta';
export const DEFAULT_ROSTER_TAB = 'ALL';

export const normalizeTitle = (title: string) => title.trim().toLowerCase();

export interface TermWorkbookOptions {
  /** The generation the source belongs to; checked against `_meta.generation_code`. */
  generationCode: string;
  /** The term the source belongs to; checked against `_meta.education_term`. */
  termNumber: number;
  rosterTab?: string;
  /** Extra tabs to skip (tabs starting with "_" are always skipped). */
  ignoredTabs?: readonly string[];
}

export interface TermMeta {
  generationCode: string | null;
  termNumber: number | null;
}

export interface TabProposal {
  tabName: string;
  sheetTabId: number;
  /** null when the tab could not be read as a subject (see issues for that tab). */
  layout: TabLayout | null;
  /** Rows whose student ID is not in the roster. */
  unknownStudents: number;
}

export interface TermWorkbookDetection {
  spreadsheetTitle: string;
  /** FILE-level error: nothing may be synced until it is fixed. Proposals are still listed. */
  fatal: boolean;
  meta: TermMeta | null;
  rosterTab: string | null;
  roster: RosterStudent[];
  tabs: TabProposal[];
  issues: TemplateIssue[];
}

/** Optional `_meta` tab (key/value). Present values must match the source (decision A2). */
export function parseTermMeta(grid: Grid, options: TermWorkbookOptions, log: IssueLog): TermMeta {
  const values = new Map<string, Grid[number][number]>();
  for (const row of grid) {
    const key = cellText(row[0])?.toLowerCase();
    if (key) values.set(key, row[1] ?? null);
  }
  const generationCode = cellText(values.get('generation_code'));
  const termCell = values.get('education_term') ?? values.get('term');
  const termNumber = termCell === undefined ? null : parseIntegerCell(termCell, 1, 99);
  if (generationCode && generationCode.toUpperCase() !== options.generationCode.toUpperCase()) {
    log.error(
      'FILE',
      'GENERATION_MISMATCH',
      `_meta says generation ${generationCode}, but this source belongs to ${options.generationCode}.`,
      { sheetTab: TERM_META_TAB, rawValue: generationCode },
    );
  }
  if (termCell !== undefined && termNumber !== options.termNumber) {
    log.error(
      'FILE',
      'TERM_MISMATCH',
      `_meta says term ${rawValue(termCell) ?? '(empty)'}, but this source is for term ${options.termNumber}.`,
      { sheetTab: TERM_META_TAB, rawValue: rawValue(termCell) },
    );
  }
  return { generationCode, termNumber };
}

function tooLarge(grid: Grid): boolean {
  return grid.length > LIMITS.maxRowsPerTab || grid.some((r) => r.length > LIMITS.maxColumnsPerTab);
}

/**
 * Reads a term workbook (one tab per subject) and proposes a mapping for every subject tab.
 * One metadata request plus one batched values request. Writes nothing.
 */
export async function detectTermWorkbook(
  reader: SheetsReader,
  spreadsheetId: string,
  options: TermWorkbookOptions,
): Promise<TermWorkbookDetection> {
  const log = new IssueLog();
  const metadata = await reader.getMetadata(spreadsheetId);
  const byNormalized = new Map(metadata.tabs.map((t) => [normalizeTitle(t.title), t]));
  const metaTab = byNormalized.get(normalizeTitle(TERM_META_TAB));
  const rosterTab = byNormalized.get(normalizeTitle(options.rosterTab ?? DEFAULT_ROSTER_TAB));
  const ignored = new Set((options.ignoredTabs ?? []).map(normalizeTitle));
  const subjects = metadata.tabs.filter(
    (t) =>
      !t.title.trim().startsWith('_') && t !== rosterTab && !ignored.has(normalizeTitle(t.title)),
  );
  if (!rosterTab) {
    log.error(
      'FILE',
      'ROSTER_TAB_MISSING',
      `The roster tab "${options.rosterTab ?? DEFAULT_ROSTER_TAB}" is missing. Add it or choose another roster tab.`,
      { sheetTab: options.rosterTab ?? DEFAULT_ROSTER_TAB },
    );
  }

  const titles = [
    ...(metaTab ? [metaTab.title] : []),
    ...(rosterTab ? [rosterTab.title] : []),
    ...subjects.map((t) => t.title),
  ];
  const grids = titles.length > 0 ? await reader.readTabs(spreadsheetId, titles) : [];
  let next = 0;
  const meta = metaTab ? parseTermMeta(grids[next++] ?? [], options, log) : null;

  let roster: RosterStudent[] = [];
  if (rosterTab) {
    const grid = grids[next++] ?? [];
    if (tooLarge(grid)) {
      log.error('FILE', 'TAB_TOO_LARGE', `Tab "${rosterTab.title}" is too large.`, {
        sheetTab: rosterTab.title,
      });
    } else {
      roster = parseRoster(grid, rosterTab.title, log) ?? [];
    }
  }
  const known = new Set(roster.map((s) => s.studentCode));

  const tabs: TabProposal[] = subjects.map((tab) => {
    const grid = grids[next++] ?? [];
    if (tooLarge(grid)) {
      log.error('COURSE', 'TAB_TOO_LARGE', `Tab "${tab.title}" is too large.`, {
        sheetTab: tab.title,
      });
      return { tabName: tab.title, sheetTabId: tab.sheetId, layout: null, unknownStudents: 0 };
    }
    const layout = detectTabLayout(grid, tab.title, log);
    let unknownStudents = 0;
    if (layout && rosterTab) {
      const idColumn = layout.columns.find((c) => c.role === 'STUDENT_ID')?.columnIndex ?? 0;
      for (const row of grid.slice(layout.headerRow)) {
        const id = cellText(row[idColumn])?.toUpperCase();
        if (id && !known.has(id)) unknownStudents++;
      }
    }
    return { tabName: tab.title, sheetTabId: tab.sheetId, layout, unknownStudents };
  });

  return {
    spreadsheetTitle: metadata.title,
    fatal: log.hasFileError,
    meta,
    rosterTab: rosterTab?.title ?? null,
    roster,
    tabs,
    issues: log.items,
  };
}

export interface TermWorkbookCheck {
  spreadsheetTitle: string;
  tabs: string[];
  ok: boolean;
  issues: TemplateIssue[];
}

/**
 * Quick check when a term workbook is connected: readable, roster tab present, `_meta` (if any)
 * names this generation and term. At most two requests; subject tabs are not read.
 */
export async function checkTermWorkbook(
  reader: SheetsReader,
  spreadsheetId: string,
  options: TermWorkbookOptions,
): Promise<TermWorkbookCheck> {
  const log = new IssueLog();
  const metadata = await reader.getMetadata(spreadsheetId);
  const titles = new Map(metadata.tabs.map((t) => [normalizeTitle(t.title), t.title]));
  const rosterTab = options.rosterTab ?? DEFAULT_ROSTER_TAB;
  if (!titles.has(normalizeTitle(rosterTab))) {
    log.error(
      'FILE',
      'ROSTER_TAB_MISSING',
      `The roster tab "${rosterTab}" is missing. Add it or choose another roster tab.`,
      { sheetTab: rosterTab },
    );
  }
  const metaTitle = titles.get(normalizeTitle(TERM_META_TAB));
  if (metaTitle) {
    const [grid] = await reader.readTabs(spreadsheetId, [metaTitle]);
    parseTermMeta(grid ?? [], options, log);
  }
  return {
    spreadsheetTitle: metadata.title,
    tabs: metadata.tabs.map((t) => t.title),
    ok: !log.hasFileError,
    issues: log.items,
  };
}

/** A confirmed tab mapping as stored in sheet_tab_mappings / sheet_column_mappings. */
export interface ConfirmedTab {
  offeringId: string;
  courseKey: string;
  title: string;
  tabName: string;
  /** Google's sheetId: finds the tab after a rename. */
  sheetTabId: number | null;
  headerRow: number;
  headerSignature: string;
  columns: {
    columnIndex: number;
    role: ColumnRole;
    criterion: Omit<ParsedCriterion, 'maxMark'> | null;
  }[];
}

export interface TermWorkbookRead {
  spreadsheetTitle: string;
  /** FILE-level error: nothing from this workbook may be applied. */
  fatal: boolean;
  rosterTab: string | null;
  roster: RosterStudent[];
  courses: ParsedCourse[];
  issues: TemplateIssue[];
  /** SHA-256 hex of every tab read, so a reviewed sheet can be told from an edited one. */
  fingerprint: string;
}

/**
 * Reads what a sync applies: the roster and every confirmed subject tab, in one metadata and
 * one batched values request. A tab whose headers changed since confirmation is skipped
 * (NEEDS_REMAP) rather than guessed at. Writes nothing.
 */
export async function readTermWorkbook(
  reader: SheetsReader,
  spreadsheetId: string,
  options: TermWorkbookOptions,
  confirmed: readonly ConfirmedTab[],
): Promise<TermWorkbookRead> {
  const log = new IssueLog();
  const metadata = await reader.getMetadata(spreadsheetId);
  const byTitle = new Map(metadata.tabs.map((t) => [normalizeTitle(t.title), t]));
  const metaTab = byTitle.get(normalizeTitle(TERM_META_TAB));
  const rosterName = options.rosterTab ?? DEFAULT_ROSTER_TAB;
  const rosterTab = byTitle.get(normalizeTitle(rosterName));
  const fingerprint = new Map<string, Grid>();
  const result = (fatal: boolean, roster: RosterStudent[], courses: ParsedCourse[]) => ({
    fingerprint: createHash('sha256')
      .update(JSON.stringify([...fingerprint].toSorted(([a], [b]) => a.localeCompare(b))))
      .digest('hex'),
    spreadsheetTitle: metadata.title,
    fatal,
    rosterTab: rosterTab?.title ?? null,
    roster,
    courses,
    issues: log.items,
  });

  if (!rosterTab) {
    log.error('FILE', 'ROSTER_TAB_MISSING', `The roster tab "${rosterName}" is missing.`, {
      sheetTab: rosterName,
    });
  }
  if (confirmed.length === 0) {
    log.error('FILE', 'NO_CONFIRMED_TABS', 'Confirm at least one subject tab before syncing.');
  }

  const tabs = confirmed.flatMap((tab) => {
    const found =
      metadata.tabs.find((t) => t.sheetId === tab.sheetTabId) ??
      byTitle.get(normalizeTitle(tab.tabName));
    if (found) return [{ tab, title: found.title }];
    log.error(
      'COURSE',
      'WORKSHEET_NOT_FOUND',
      `Tab "${tab.tabName}" is no longer in the workbook.`,
      {
        sheetTab: tab.tabName,
        courseKey: tab.courseKey,
      },
    );
    return [];
  });
  const ignored = new Set((options.ignoredTabs ?? []).map(normalizeTitle));
  const used = new Set(tabs.map((t) => normalizeTitle(t.title)));
  for (const tab of metadata.tabs) {
    const title = normalizeTitle(tab.title);
    if (tab === rosterTab || title.startsWith('_') || ignored.has(title) || used.has(title)) {
      continue;
    }
    log.warn('UNMAPPED_TAB', `Tab "${tab.title}" is not confirmed yet, so it was skipped.`, {
      sheetTab: tab.title,
    });
  }

  const titles = [
    ...(metaTab ? [metaTab.title] : []),
    ...(rosterTab ? [rosterTab.title] : []),
    ...tabs.map((t) => t.title),
  ];
  const grids = titles.length > 0 ? await reader.readTabs(spreadsheetId, titles) : [];
  titles.forEach((title, i) => fingerprint.set(title, grids[i] ?? []));
  let next = 0;
  if (metaTab) parseTermMeta(grids[next++] ?? [], options, log);

  let roster: RosterStudent[] = [];
  if (rosterTab) {
    const grid = grids[next++] ?? [];
    if (tooLarge(grid)) {
      log.error('FILE', 'TAB_TOO_LARGE', `Tab "${rosterTab.title}" is too large.`, {
        sheetTab: rosterTab.title,
      });
    } else {
      roster = parseRoster(grid, rosterTab.title, log) ?? [];
    }
  }
  if (log.hasFileError) return result(true, roster, []);

  const rosterByCode = new Map(roster.map((s) => [s.studentCode, s]));
  const courses: ParsedCourse[] = [];
  for (const { tab, title } of tabs) {
    const grid = grids[next++] ?? [];
    const at = { sheetTab: title, courseKey: tab.courseKey };
    if (tooLarge(grid)) {
      log.error('COURSE', 'TAB_TOO_LARGE', `Tab "${title}" is too large.`, at);
      continue;
    }
    if (headerSignature(grid, tab.headerRow - 1) !== tab.headerSignature) {
      log.error(
        'COURSE',
        'NEEDS_REMAP',
        `The headers of tab "${title}" changed since it was confirmed. Review the tab again; its scores were not synced.`,
        at,
      );
      continue;
    }
    const rows = parseSubjectRows(
      grid,
      {
        tabName: title,
        headerRow: tab.headerRow,
        columns: tab.columns.map((c) => ({
          columnIndex: c.columnIndex,
          role: c.role,
          criterionKey: c.criterion?.key ?? null,
        })),
      },
      rosterByCode,
      log,
    );
    if (!rows) continue;
    courses.push({
      offeringId: tab.offeringId,
      courseKey: tab.courseKey,
      title: tab.title,
      worksheet: title,
      criteria: tab.columns.flatMap((c) =>
        c.criterion ? [{ ...c.criterion, maxMark: TERM_WORKBOOK_MAX_MARK }] : [],
      ),
      rows,
    });
  }
  return result(false, roster, courses);
}
