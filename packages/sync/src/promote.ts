import type { Prisma } from '@ssrs/database';
import { cleanLabel, keyFromName, type ParsedCourse } from '@ssrs/sheets';

type Tx = Prisma.TransactionClient;

const NEW_OFFERING = 'new:';

/** Stands in for the offering of a subject that a pending sheet will create when it syncs. */
export const newOfferingId = (tabMappingId: string) => `${NEW_OFFERING}${tabMappingId}`;
export const isNewOffering = (offeringId: string) => offeringId.startsWith(NEW_OFFERING);

/** A new subject follows its term: once the term is released, it is visible like the others. */
export async function termVisibility(
  tx: Pick<Tx, 'courseOffering'>,
  termId: string,
): Promise<{ visibility: 'VISIBLE'; visibilityOverridden: true } | Record<string, never>> {
  const released = await tx.courseOffering.count({ where: { termId, visibility: 'VISIBLE' } });
  return released > 0 ? { visibility: 'VISIBLE', visibilityOverridden: true } : {};
}

/**
 * Confirming a tab of a pending sheet writes only its mapping, so reviewing or discarding the
 * sheet changes nothing students see. The sync that promotes the sheet applies those decisions
 * here, inside its all-or-nothing transaction: it creates new subjects and returns the courses
 * pointing at real offerings. Names follow through the normal apply steps.
 */
export async function prepareSubjects(
  tx: Tx,
  source: { id: string; generationId: string; termId: string; term: { number: number } },
  courses: readonly ParsedCourse[],
): Promise<ParsedCourse[]> {
  const tabs = await tx.sheetTabMapping.findMany({
    where: { sourceId: source.id, status: 'CONFIRMED', proposedTitle: { not: null } },
  });
  const offeringIds = new Map<string, string>();
  for (const tab of tabs) {
    const title = tab.proposedTitle ?? tab.tabName;
    const names = [...new Set([cleanLabel(tab.tabName), title])];
    const alias = await tx.courseAlias.findFirst({ where: { alias: { in: names } } });
    const code = keyFromName(title);
    const course = alias
      ? await tx.course.findUniqueOrThrow({ where: { id: alias.courseId } })
      : await tx.course.upsert({
          where: { code },
          create: { code, name: title },
          update: {},
        });
    await tx.courseAlias.createMany({
      data: names.map((name) => ({ alias: name, courseId: course.id })),
      skipDuplicates: true,
    });
    const current = await tx.courseOffering.findUnique({
      where: { termId_courseId: { termId: source.termId, courseId: course.id } },
    });
    const offeringId =
      tab.offeringId ??
      current?.id ??
      (
        await tx.courseOffering.create({
          data: {
            termId: source.termId,
            generationId: source.generationId,
            courseId: course.id,
            externalKey: `T${source.term.number}-${course.code}`,
            title,
            sourceId: source.id,
            sheetTab: tab.tabName,
            ...(await termVisibility(tx, source.termId)),
          },
        })
      ).id;
    await tx.sheetTabMapping.update({
      where: { id: tab.id },
      data: { offeringId, proposedTitle: null },
    });
    offeringIds.set(newOfferingId(tab.id), offeringId);
  }
  return courses.map((c) => ({ ...c, offeringId: offeringIds.get(c.offeringId) ?? c.offeringId }));
}

/** Points the sheet's columns at the criteria the promoting sync created or matched. */
export async function linkCriteria(tx: Tx, sourceId: string): Promise<void> {
  const columns = await tx.sheetColumnMapping.findMany({
    where: { tabMapping: { sourceId }, proposedKey: { not: null }, missingFromSheet: false },
    include: { tabMapping: { select: { offeringId: true } } },
  });
  for (const column of columns) {
    const { offeringId } = column.tabMapping;
    const criterion =
      offeringId && column.proposedKey
        ? await tx.assessmentCriterion.findUnique({
            where: { offeringId_key: { offeringId, key: column.proposedKey } },
          })
        : null;
    await tx.sheetColumnMapping.update({
      where: { id: column.id },
      data: { criterionId: criterion?.id ?? column.criterionId, proposedKey: null },
    });
  }
}
