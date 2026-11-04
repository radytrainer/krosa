import type { Prisma, PrismaClient } from '@ssrs/database';
import {
  guessCategory,
  keyFromName,
  parseLabelWeight,
  type ConfirmedTab,
  type CriterionCategory,
} from '@ssrs/sheets';
import { newOfferingId } from './promote.js';

/** Tab mappings as a sync or a preview needs them. */
export const TAB_MAPPINGS_INCLUDE = {
  columns: { include: { criterion: true }, orderBy: { columnIndex: 'asc' } },
  offering: { select: { externalKey: true, title: true } },
} satisfies Prisma.SheetTabMappingInclude;

type TabRow = Prisma.SheetTabMappingGetPayload<{ include: typeof TAB_MAPPINGS_INCLUDE }>;

type ColumnRow = TabRow['columns'][number];

/** What a column feeds: the live criterion, or a pending sheet's reviewed one (not applied yet). */
function criterionOf(tab: TabRow, column: ColumnRow, order: number) {
  if (column.role !== 'CRITERION') return null;
  const weight = column.proposedWeight?.toString() ?? '0';
  if (tab.proposedTitle !== null && column.proposedKey) {
    const name = column.proposedName ?? column.proposedKey;
    const group = column.groupLabel ? parseLabelWeight(column.groupLabel).name : null;
    return { key: column.proposedKey, name, category: guessCategory(name, group), weight, order };
  }
  const { criterion } = column;
  return criterion
    ? {
        key: criterion.key,
        name: criterion.name,
        category: criterion.category as CriterionCategory,
        weight,
        order: criterion.displayOrder,
      }
    : null;
}

export function confirmedTabs(tabs: readonly TabRow[]): ConfirmedTab[] {
  return tabs.flatMap((tab) => {
    const title = tab.proposedTitle ?? tab.offering?.title;
    if (tab.status !== 'CONFIRMED' || !title) return [];
    let order = 0;
    return [
      {
        offeringId: tab.offeringId ?? newOfferingId(tab.id),
        courseKey: tab.offering?.externalKey ?? keyFromName(title),
        title,
        tabName: tab.tabName,
        sheetTabId: tab.sheetTabId,
        headerRow: tab.headerRow,
        headerSignature: tab.headerSignature,
        columns: tab.columns.map((c) => ({
          columnIndex: c.columnIndex,
          role: c.role,
          criterion: criterionOf(tab, c, c.role === 'CRITERION' ? ++order : order),
        })),
      },
    ];
  });
}

export interface TabAudienceRow {
  /** The tab mapping, to save a guessed audience on. */
  id: string;
  audience: 'SHARED' | 'PROGRAM' | null;
  audienceProgramId: string | null;
}

/** The confirmed audience of each tab, by the course key `confirmedTabs` gives it. */
export function audienceByCourseKey(tabs: readonly TabRow[]): Map<string, TabAudienceRow> {
  const out = new Map<string, TabAudienceRow>();
  for (const tab of tabs) {
    const title = tab.proposedTitle ?? tab.offering?.title;
    if (tab.status !== 'CONFIRMED' || !title) continue;
    const key = (tab.offering?.externalKey ?? keyFromName(title)).toUpperCase();
    out.set(key, {
      id: tab.id,
      audience: tab.audience,
      audienceProgramId: tab.audienceProgramId,
    });
  }
  return out;
}

export function mappingVersions(tabs: readonly TabRow[]): Record<string, number> {
  return Object.fromEntries(
    tabs
      .filter((t) => t.status === 'CONFIRMED')
      .map((t) => [t.id, t.version] as const)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

export type PreviewGate = { code: 'PREVIEW_REQUIRED' | 'PREVIEW_STALE'; message: string } | null;

/**
 * A pending sheet may sync only with a confirmed preview of exactly what would be imported.
 * The fingerprint is known once the sheet is read, so the API checks without it.
 */
export async function previewGate(
  prisma: Pick<PrismaClient, 'sheetPreview' | 'sheetTabMapping'>,
  sourceId: string,
  fingerprint: string | null,
): Promise<PreviewGate> {
  const preview = await prisma.sheetPreview.findFirst({
    where: { sourceId, invalidatedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!preview?.confirmedAt) {
    return {
      code: 'PREVIEW_REQUIRED',
      message: 'Run a preview of this sheet and confirm it before syncing.',
    };
  }
  const tabs = await prisma.sheetTabMapping.findMany({
    where: { sourceId },
    include: TAB_MAPPINGS_INCLUDE,
  });
  const sameMappings =
    JSON.stringify(preview.mappingVersions) === JSON.stringify(mappingVersions(tabs));
  if (!sameMappings || (fingerprint !== null && fingerprint !== preview.fingerprint)) {
    return {
      code: 'PREVIEW_STALE',
      message: 'The sheet or its tab mappings changed since the preview. Run a new preview.',
    };
  }
  return null;
}

/**
 * What an active sheet's job may rely on: the preview it names, still confirmed, for the mappings
 * it was run on. Marks may change after a preview, so the fingerprint is not compared here; the
 * engine compares the removed subjects instead.
 */
export async function activePreviewGate(
  prisma: Pick<PrismaClient, 'sheetPreview' | 'sheetTabMapping'>,
  sourceId: string,
  previewId: string,
): Promise<PreviewGate> {
  const preview = await prisma.sheetPreview.findFirst({
    where: { id: previewId, sourceId, invalidatedAt: null, confirmedAt: { not: null } },
  });
  const tabs = await prisma.sheetTabMapping.findMany({
    where: { sourceId },
    include: TAB_MAPPINGS_INCLUDE,
  });
  if (
    !preview ||
    JSON.stringify(preview.mappingVersions) !== JSON.stringify(mappingVersions(tabs))
  ) {
    return {
      code: 'PREVIEW_STALE',
      message: 'The sheet or its tab mappings changed since the preview. Run a new preview.',
    };
  }
  return null;
}

/** The removals an admin confirmed: on the job's preview, or a pending sheet's newest one. */
export async function confirmedRemovals(
  prisma: Pick<PrismaClient, 'sheetPreview'>,
  sourceId: string,
  previewId: string | null,
): Promise<{ offeringId: string }[]> {
  const preview = await prisma.sheetPreview.findFirst({
    where: { sourceId, invalidatedAt: null, ...(previewId ? { id: previewId } : {}) },
    orderBy: { createdAt: 'desc' },
    select: { summary: true },
  });
  const summary = preview?.summary as {
    comparison?: { removed?: { offeringId: string }[] };
  } | null;
  return summary?.comparison?.removed ?? [];
}
