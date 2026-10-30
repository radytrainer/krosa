import type { Prisma, PrismaClient } from '@ssrs/database';
import type { ConfirmedTab, CriterionCategory } from '@ssrs/sheets';

/** Tab mappings as a sync or a preview needs them. */
export const TAB_MAPPINGS_INCLUDE = {
  columns: { include: { criterion: true }, orderBy: { columnIndex: 'asc' } },
  offering: { select: { externalKey: true, title: true } },
} satisfies Prisma.SheetTabMappingInclude;

type TabRow = Prisma.SheetTabMappingGetPayload<{ include: typeof TAB_MAPPINGS_INCLUDE }>;

export function confirmedTabs(tabs: readonly TabRow[]): ConfirmedTab[] {
  return tabs.flatMap((tab) =>
    tab.status === 'CONFIRMED' && tab.offeringId && tab.offering
      ? [
          {
            offeringId: tab.offeringId,
            courseKey: tab.offering.externalKey,
            title: tab.offering.title,
            tabName: tab.tabName,
            sheetTabId: tab.sheetTabId,
            headerRow: tab.headerRow,
            headerSignature: tab.headerSignature,
            columns: tab.columns.map((c) => ({
              columnIndex: c.columnIndex,
              role: c.role,
              criterion:
                c.role === 'CRITERION' && c.criterion
                  ? {
                      key: c.criterion.key,
                      name: c.criterion.name,
                      category: c.criterion.category as CriterionCategory,
                      weight: c.proposedWeight?.toString() ?? '0',
                      order: c.criterion.displayOrder,
                    }
                  : null,
            })),
          },
        ]
      : [],
  );
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
