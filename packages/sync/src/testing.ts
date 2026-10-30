import type { PrismaClient } from '@ssrs/database';
import { detectTermWorkbook, type SheetsReader } from '@ssrs/sheets';

/** MsOffice has no weights in its headers; these reproduce its TOTAL column. */
const MISSING_WEIGHTS: Record<string, string> = {
  PARTICIPATIONS: '10',
  MS_WORD: '30',
  MS_POWERPOINT: '30',
  MS_EXCEL: '30',
};

/**
 * Test helper: detects a term workbook and confirms every subject tab, as an admin would on the
 * mapping screen. Tabs named in `skip` stay unconfirmed.
 */
export async function confirmAllTabs(
  prisma: PrismaClient,
  reader: SheetsReader,
  sourceId: string,
  skip: readonly string[] = [],
): Promise<void> {
  const source = await prisma.googleSheetSource.findUniqueOrThrow({
    where: { id: sourceId },
    include: { generation: true, term: true },
  });
  const detection = await detectTermWorkbook(reader, source.spreadsheetId, {
    generationCode: source.generation.code,
    termNumber: source.term.number,
    rosterTab: source.rosterTab,
  });
  for (const tab of detection.tabs) {
    const layout = tab.layout;
    if (!layout) continue;
    const mapping = {
      sourceId,
      tabName: tab.tabName,
      sheetTabId: tab.sheetTabId,
      headerRow: layout.headerRow,
      headerSignature: layout.headerSignature,
    };
    if (skip.includes(tab.tabName)) {
      await prisma.sheetTabMapping.create({ data: mapping });
      continue;
    }
    const code = tab.tabName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const course = await prisma.course.upsert({
      where: { code },
      create: { code, name: tab.tabName },
      update: {},
    });
    const offering = await prisma.courseOffering.create({
      data: {
        termId: source.termId,
        generationId: source.generationId,
        courseId: course.id,
        externalKey: `T${source.term.number}-${code}`,
        title: tab.tabName,
        sourceId,
        sheetTab: tab.tabName,
      },
    });
    const saved = await prisma.sheetTabMapping.create({
      data: {
        ...mapping,
        offeringId: offering.id,
        status: 'CONFIRMED',
        version: 1,
        confirmedAt: new Date(),
      },
    });
    let order = 0;
    for (const column of layout.columns) {
      if (column.label === null) continue;
      const parsed = column.criterion;
      const criterion = parsed
        ? await prisma.assessmentCriterion.create({
            data: {
              offeringId: offering.id,
              key: parsed.key,
              name: parsed.name,
              category: parsed.category,
              displayOrder: ++order,
            },
          })
        : null;
      await prisma.sheetColumnMapping.create({
        data: {
          tabMappingId: saved.id,
          columnIndex: column.columnIndex,
          headerLabel: column.label,
          groupLabel: column.group?.label ?? null,
          role: column.role,
          criterionId: criterion?.id ?? null,
          proposedName: parsed?.name ?? null,
          proposedWeight: parsed ? (parsed.weight ?? MISSING_WEIGHTS[parsed.key] ?? null) : null,
        },
      });
    }
  }
}
