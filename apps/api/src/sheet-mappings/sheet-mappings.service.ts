import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@ssrs/database';
import { validateScheme } from '@ssrs/shared';
import { previewSource, type PreviewSummary } from '@ssrs/sync';
import {
  cleanLabel,
  detectTermWorkbook,
  guessCategory,
  keyFromName,
  parseLabelWeight,
  TERM_WORKBOOK_MAX_MARK,
  type CrossCheck,
  type SheetsReader,
  type TabLayout,
  type TemplateIssue,
  type TermMeta,
} from '@ssrs/sheets';
import { AcademicGuardService } from '../academic/academic-guard.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';
import { toHttpError } from '../sheets-sources/sheets-errors.js';
import { SHEETS_READER } from '../sheets-sources/sheets-reader.provider.js';
import { DETECT_ISSUE_LIMIT } from '../sheets-sources/sheets-sources.service.js';
import type { ConfirmMappingDto } from './sheet-mappings.dto.js';

const MAPPING_INCLUDE = {
  columns: { orderBy: { columnIndex: 'asc' } },
} satisfies Prisma.SheetTabMappingInclude;

type MappingRow = Prisma.SheetTabMappingGetPayload<{ include: typeof MAPPING_INCLUDE }>;

export interface ColumnMappingView {
  columnIndex: number;
  headerLabel: string | null;
  groupLabel: string | null;
  role: MappingRow['columns'][number]['role'];
  criterionId: string | null;
  proposedName: string | null;
  proposedWeight: string | null;
}

export interface SheetPreviewView {
  id: string;
  createdAt: string;
  confirmedAt: string | null;
  summary: PreviewSummary;
}

export interface TabMappingView {
  id: string;
  tabName: string;
  status: 'DRAFT' | 'CONFIRMED' | 'IGNORED';
  version: number;
  headerRow: number;
  offeringId: string | null;
  confirmedAt: string | null;
  columns: ColumnMappingView[];
  /** Pending sheets: the same-named tab of the active sheet, offered as a starting point. */
  carriedFrom: { subject: string; headersMatch: boolean } | null;
}

export interface DetectedTab {
  tabName: string;
  /** The stored mapping after detection (a fresh DRAFT unless it was confirmed or ignored). */
  mapping: TabMappingView | null;
  /** null when the tab has no STUDENT ID header (not a subject tab). */
  detected: {
    headerRow: number;
    totalWeight: string | null;
    studentRows: number;
    unknownStudents: number;
    crossCheck: CrossCheck | null;
    /** A confirmed mapping whose headers changed since confirmation: it must be re-confirmed. */
    headersChanged: boolean;
  } | null;
}

export interface DetectionView {
  spreadsheetTitle: string;
  fatal: boolean;
  meta: TermMeta | null;
  rosterTab: string | null;
  rosterStudents: number;
  issues: TemplateIssue[];
  issuesTruncated: boolean;
  tabs: DetectedTab[];
}

function toView(m: MappingRow, carried: TabMappingView['carriedFrom'] = null): TabMappingView {
  return {
    carriedFrom: carried,
    id: m.id,
    tabName: m.tabName,
    status: m.status,
    version: m.version,
    headerRow: m.headerRow,
    offeringId: m.offeringId,
    confirmedAt: m.confirmedAt?.toISOString() ?? null,
    columns: m.columns.map((c) => ({
      columnIndex: c.columnIndex,
      headerLabel: c.headerLabel,
      groupLabel: c.groupLabel,
      role: c.role,
      criterionId: c.criterionId,
      proposedName: c.proposedName,
      proposedWeight: c.proposedWeight?.toString() ?? null,
    })),
  };
}

type ActiveTab = Prisma.SheetTabMappingGetPayload<{
  include: typeof MAPPING_INCLUDE & { offering: { select: { title: true } } };
}>;

function carriedFrom(
  tab: { tabName: string; headerSignature: string },
  active: ReadonlyMap<string, ActiveTab>,
): TabMappingView['carriedFrom'] {
  const match = active.get(cleanLabel(tab.tabName).toLowerCase());
  return match
    ? {
        subject: match.offering?.title ?? tab.tabName,
        headersMatch: match.headerSignature === tab.headerSignature,
      }
    : null;
}

function toPreviewView(p: {
  id: string;
  createdAt: Date;
  confirmedAt: Date | null;
  summary: unknown;
}): SheetPreviewView {
  return {
    id: p.id,
    createdAt: p.createdAt.toISOString(),
    confirmedAt: p.confirmedAt?.toISOString() ?? null,
    summary: p.summary as PreviewSummary,
  };
}

const fail = (code: string, message: string) => new UnprocessableEntityException({ code, message });

function columnRows(layout: TabLayout) {
  return layout.columns
    .filter((c) => c.label !== null)
    .map((c) => ({
      columnIndex: c.columnIndex,
      headerLabel: c.label,
      groupLabel: c.group?.label ?? null,
      role: c.role,
      proposedName: c.criterion?.name ?? null,
      proposedWeight: c.criterion?.weight ?? null,
    }));
}

/**
 * Tab and column mappings of term workbooks (docs/delivery-plan-2027.md B.1). Detection reads
 * the workbook and stores a DRAFT proposal per subject tab; confirmed and ignored mappings are
 * never overwritten by detection.
 */
@Injectable()
export class SheetMappingsService {
  constructor(
    @Inject(SHEETS_READER) private readonly reader: SheetsReader,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly guard: AcademicGuardService,
  ) {}

  private async termSource(id: string) {
    const source = await this.prisma.client.googleSheetSource.findUnique({
      where: { id },
      include: {
        generation: { select: { code: true } },
        term: { select: { number: true } },
      },
    });
    if (!source)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Spreadsheet source not found' });
    return source;
  }

  private async tabOf(sourceId: string, tabMappingId: string) {
    const tab = await this.prisma.client.sheetTabMapping.findFirst({
      where: { id: tabMappingId, sourceId },
      include: MAPPING_INCLUDE,
    });
    if (!tab) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tab mapping not found' });
    return tab;
  }

  /**
   * Locks in a tab: creates or reuses the subject, its term offering and the assessment columns.
   * The weights given here are what the next sync publishes.
   */
  async confirm(
    sourceId: string,
    tabMappingId: string,
    dto: ConfirmMappingDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<TabMappingView> {
    const source = await this.termSource(sourceId);
    await this.guard.assertGenerationEditable(source.generationId);
    const tab = await this.tabOf(sourceId, tabMappingId);
    const stored = new Map(tab.columns.map((c) => [c.columnIndex, c]));

    for (const column of dto.columns) {
      if (!stored.has(column.columnIndex)) {
        throw fail('INVALID_COLUMN', `Column ${column.columnIndex} is not part of this tab.`);
      }
    }
    if (dto.columns.filter((c) => c.role === 'STUDENT_ID').length !== 1) {
      throw fail('STUDENT_ID_COLUMN_REQUIRED', 'Exactly one column must be the student ID.');
    }
    const criteria = dto.columns.filter((c) => c.role === 'CRITERION');
    if (criteria.length === 0) throw fail('NO_CRITERIA', 'At least one column must hold marks.');
    if (criteria.some((c) => !c.name?.trim() || !c.weight)) {
      throw fail('MISSING_WEIGHT', 'Every mark column needs a name and a weight.');
    }
    const scheme = validateScheme(
      criteria.map((c) => ({
        criterionId: String(c.columnIndex),
        maxMark: TERM_WORKBOOK_MAX_MARK,
        weight: c.weight ?? '0',
      })),
    );
    const firstIssue = scheme.issues[0];
    if (firstIssue) throw fail(firstIssue.code, firstIssue.message);

    const term = await this.prisma.client.term.findUniqueOrThrow({ where: { id: source.termId } });
    const subjectName = cleanLabel(dto.subjectName);
    const saved = await this.prisma.client.$transaction(async (tx) => {
      const alias = await tx.courseAlias.findFirst({
        where: { alias: { in: [cleanLabel(tab.tabName), subjectName] } },
      });
      const code = keyFromName(subjectName);
      const course = alias
        ? await tx.course.findUniqueOrThrow({ where: { id: alias.courseId } })
        : await tx.course.upsert({
            where: { code },
            create: { code, name: subjectName },
            update: {},
          });
      await tx.courseAlias.createMany({
        data: [...new Set([cleanLabel(tab.tabName), subjectName])].map((name) => ({
          alias: name,
          courseId: course.id,
        })),
        skipDuplicates: true,
      });

      const courseKey = `T${term.number}-${course.code}`;
      const current = await tx.courseOffering.findUnique({
        where: { termId_courseId: { termId: term.id, courseId: course.id } },
      });
      const offering = current
        ? await tx.courseOffering.update({
            where: { id: current.id },
            data: { title: subjectName, sourceId, sheetTab: tab.tabName },
          })
        : await tx.courseOffering.create({
            data: {
              termId: term.id,
              generationId: source.generationId,
              courseId: course.id,
              externalKey: courseKey,
              title: subjectName,
              sourceId,
              sheetTab: tab.tabName,
            },
          });
      const sharing = await tx.sheetTabMapping.findFirst({
        where: { sourceId, offeringId: offering.id, id: { not: tab.id } },
      });
      if (sharing) {
        throw new ConflictException({
          code: 'SUBJECT_ALREADY_MAPPED',
          message: `Tab "${sharing.tabName}" is already mapped to ${subjectName}.`,
        });
      }

      const existing = await tx.assessmentCriterion.findMany({
        where: { offeringId: offering.id },
      });
      const byId = new Map(existing.map((c) => [c.id, c]));
      const byKey = new Map(existing.map((c) => [c.key.toUpperCase(), c]));
      const used = new Set<string>();
      const criterionIds = new Map<number, string>();
      for (const [order, column] of criteria.entries()) {
        const name = cleanLabel(column.name ?? '');
        const previous = stored.get(column.columnIndex);
        const base = keyFromName(name);
        let key = base;
        for (let n = 2; used.has(key); n++) key = `${base.slice(0, 29)}_${n}`;
        const match =
          (previous?.criterionId ? byId.get(previous.criterionId) : undefined) ?? byKey.get(key);
        used.add(match ? match.key.toUpperCase() : key);
        const group = previous?.groupLabel ? parseLabelWeight(previous.groupLabel).name : null;
        const data = {
          name,
          category: guessCategory(name, group),
          displayOrder: order + 1,
        };
        const criterion = match
          ? await tx.assessmentCriterion.update({ where: { id: match.id }, data })
          : await tx.assessmentCriterion.create({
              data: { ...data, offeringId: offering.id, key },
            });
        criterionIds.set(column.columnIndex, criterion.id);
      }

      // Cleared first: (tab, criterion) is unique and columns may swap criteria.
      await tx.sheetColumnMapping.updateMany({
        where: { tabMappingId: tab.id },
        data: { criterionId: null },
      });
      for (const column of dto.columns) {
        await tx.sheetColumnMapping.updateMany({
          where: { tabMappingId: tab.id, columnIndex: column.columnIndex },
          data: {
            role: column.role,
            criterionId: criterionIds.get(column.columnIndex) ?? null,
            proposedName: column.role === 'CRITERION' ? cleanLabel(column.name ?? '') : null,
            proposedWeight: column.role === 'CRITERION' ? column.weight : null,
          },
        });
      }
      await this.invalidatePreviews(tx, sourceId);
      const confirmed = await tx.sheetTabMapping.update({
        where: { id: tab.id },
        data: {
          status: 'CONFIRMED',
          offeringId: offering.id,
          version: { increment: 1 },
          confirmedAt: new Date(),
          confirmedById: actor.userId,
        },
        include: MAPPING_INCLUDE,
      });
      await this.audit.record(
        {
          action: 'mapping.confirmed',
          actorUserId: actor.userId,
          entityType: 'tab_mapping',
          entityId: tab.id,
          metadata: {
            tab: tab.tabName,
            subject: subjectName,
            version: confirmed.version,
            columns: criteria.map((c) => ({ name: c.name, weight: c.weight })),
          },
          context: meta,
        },
        tx,
      );
      return confirmed;
    });
    return toView(saved);
  }

  /** Marks a tab as not a subject; sync skips it without a warning. */
  async ignore(
    sourceId: string,
    tabMappingId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<TabMappingView> {
    const source = await this.termSource(sourceId);
    await this.guard.assertGenerationEditable(source.generationId);
    const tab = await this.tabOf(sourceId, tabMappingId);
    return this.setStatus(tab.id, 'IGNORED', { offeringId: null }, 'mapping.ignored', actor, meta);
  }

  /** Reopens a confirmed or ignored tab for review; run detect next to refresh its columns. */
  async reopen(
    sourceId: string,
    tabMappingId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<TabMappingView> {
    const source = await this.termSource(sourceId);
    await this.guard.assertGenerationEditable(source.generationId);
    const tab = await this.tabOf(sourceId, tabMappingId);
    return this.setStatus(tab.id, 'DRAFT', {}, 'mapping.reopened', actor, meta);
  }

  private async setStatus(
    id: string,
    status: 'DRAFT' | 'IGNORED',
    extra: Prisma.SheetTabMappingUncheckedUpdateInput,
    action: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<TabMappingView> {
    const saved = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.sheetTabMapping.update({
        where: { id },
        data: { status, ...extra },
        include: MAPPING_INCLUDE,
      });
      await this.invalidatePreviews(tx, row.sourceId);
      await this.audit.record(
        {
          action,
          actorUserId: actor.userId,
          entityType: 'tab_mapping',
          entityId: id,
          metadata: { tab: row.tabName },
          context: meta,
        },
        tx,
      );
      return row;
    });
    return toView(saved);
  }

  async list(sourceId: string): Promise<TabMappingView[]> {
    const source = await this.termSource(sourceId);
    const rows = await this.prisma.client.sheetTabMapping.findMany({
      where: { sourceId },
      include: MAPPING_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    const active = await this.activeTabs(source);
    return rows.map((m) => toView(m, carriedFrom(m, active)));
  }

  /** Tabs for a pending sheet to start from: the active sheet's, else the last one synced. */
  private async activeTabs(source: { status: string; termId: string }) {
    if (source.status !== 'PENDING') return new Map<string, ActiveTab>();
    const previous = await this.prisma.client.googleSheetSource.findFirst({
      where: {
        termId: source.termId,
        OR: [{ status: 'ACTIVE' }, { status: 'DISABLED', lastSyncedAt: { not: null } }],
      },
      orderBy: { lastSyncedAt: { sort: 'desc', nulls: 'first' } },
      select: { id: true },
    });
    if (!previous) return new Map<string, ActiveTab>();
    const tabs = await this.prisma.client.sheetTabMapping.findMany({
      where: { status: 'CONFIRMED', sourceId: previous.id },
      include: { ...MAPPING_INCLUDE, offering: { select: { title: true } } },
    });
    return new Map(tabs.map((t) => [cleanLabel(t.tabName).toLowerCase(), t]));
  }

  private async invalidatePreviews(tx: Prisma.TransactionClient, sourceId: string) {
    await tx.sheetPreview.updateMany({
      where: { sourceId, invalidatedAt: null },
      data: { invalidatedAt: new Date() },
    });
  }

  /** Newest usable preview of a sheet, or null. */
  async latestPreview(sourceId: string): Promise<SheetPreviewView | null> {
    await this.termSource(sourceId);
    const preview = await this.prisma.client.sheetPreview.findFirst({
      where: { sourceId, invalidatedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return preview ? toPreviewView(preview) : null;
  }

  /** Compares a pending sheet with the database. Replaces any earlier preview; imports nothing. */
  async preview(sourceId: string, actor: AuthUser, meta: RequestMeta): Promise<SheetPreviewView> {
    const source = await this.termSource(sourceId);
    if (source.status !== 'PENDING') {
      throw new ConflictException({
        code: 'NOT_PENDING',
        message: 'Only a sheet waiting to replace the active one is previewed.',
      });
    }
    let result;
    try {
      result = await previewSource(this.prisma.client, this.reader, sourceId);
    } catch (err) {
      throw toHttpError(err);
    }
    const saved = await this.prisma.client.$transaction(async (tx) => {
      await this.invalidatePreviews(tx, sourceId);
      const preview = await tx.sheetPreview.create({
        data: {
          sourceId,
          fingerprint: result.fingerprint,
          mappingVersions: result.mappingVersions,
          summary: result.summary as unknown as Prisma.InputJsonValue,
          runById: actor.userId,
        },
      });
      await this.audit.record(
        {
          action: 'source.preview.run',
          actorUserId: actor.userId,
          entityType: 'source',
          entityId: sourceId,
          metadata: { previewId: preview.id, canConfirm: result.summary.canConfirm },
          context: meta,
        },
        tx,
      );
      return preview;
    });
    return toPreviewView(saved);
  }

  /** The admin accepts what a preview showed, which is what allows the sync to start. */
  async confirmPreview(
    sourceId: string,
    previewId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SheetPreviewView> {
    await this.termSource(sourceId);
    const preview = await this.prisma.client.sheetPreview.findFirst({
      where: { id: previewId, sourceId },
    });
    if (!preview) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Preview not found' });
    if (preview.invalidatedAt) {
      throw new ConflictException({
        code: 'PREVIEW_STALE',
        message: 'This preview is out of date. Run a new one.',
      });
    }
    if (!(preview.summary as unknown as PreviewSummary).canConfirm) {
      throw new UnprocessableEntityException({
        code: 'PREVIEW_HAS_ERRORS',
        message: 'Fix the errors in this preview first: a sync of this sheet would be refused.',
      });
    }
    const saved = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.sheetPreview.update({
        where: { id: previewId },
        data: { confirmedAt: new Date(), confirmedById: actor.userId },
      });
      await this.audit.record(
        {
          action: 'source.preview.confirmed',
          actorUserId: actor.userId,
          entityType: 'source',
          entityId: sourceId,
          metadata: { previewId },
          context: meta,
        },
        tx,
      );
      return row;
    });
    return toPreviewView(saved);
  }

  async detect(sourceId: string, actor: AuthUser, meta: RequestMeta): Promise<DetectionView> {
    const source = await this.termSource(sourceId);
    if (source.status === 'DISABLED') {
      throw new ConflictException({
        code: 'SOURCE_DISABLED',
        message: 'This spreadsheet source is disabled.',
      });
    }
    await this.guard.assertGenerationEditable(source.generationId);

    let detection;
    try {
      detection = await detectTermWorkbook(this.reader, source.spreadsheetId, {
        generationCode: source.generation.code,
        termNumber: source.term.number,
        rosterTab: source.rosterTab,
        ignoredTabs: source.ignoredTabs,
      });
    } catch (err) {
      throw toHttpError(err);
    }

    const active = await this.activeTabs(source);
    const tabs = await this.prisma.client.$transaction(async (tx) => {
      const existing = new Map(
        (await tx.sheetTabMapping.findMany({ where: { sourceId }, include: MAPPING_INCLUDE })).map(
          (m) => [m.tabName, m],
        ),
      );
      const result: DetectedTab[] = [];
      const detectable = new Set<string>();
      for (const tab of detection.tabs) {
        const previous = existing.get(tab.tabName);
        const layout = tab.layout;
        if (!layout) {
          result.push({ tabName: tab.tabName, mapping: null, detected: null });
          continue;
        }
        detectable.add(tab.tabName);
        let mapping: MappingRow;
        if (previous && previous.status !== 'DRAFT') {
          mapping = await tx.sheetTabMapping.update({
            where: { id: previous.id },
            data: { sheetTabId: tab.sheetTabId },
            include: MAPPING_INCLUDE,
          });
        } else {
          const data = {
            sheetTabId: tab.sheetTabId,
            headerRow: layout.headerRow,
            headerSignature: layout.headerSignature,
          };
          const saved = previous
            ? await tx.sheetTabMapping.update({ where: { id: previous.id }, data })
            : await tx.sheetTabMapping.create({
                data: { ...data, sourceId, tabName: tab.tabName, status: 'DRAFT' },
              });
          await tx.sheetColumnMapping.deleteMany({ where: { tabMappingId: saved.id } });
          // A reopened tab keeps what was confirmed for the columns that are still there.
          const fromActive = active.get(cleanLabel(tab.tabName).toLowerCase());
          const kept = new Map(
            [...(fromActive?.columns ?? []), ...(previous?.columns ?? [])].map((c) => [
              c.headerLabel,
              c,
            ]),
          );
          await tx.sheetColumnMapping.createMany({
            data: columnRows(layout).map((c) => {
              const old = kept.get(c.headerLabel);
              return {
                ...c,
                tabMappingId: saved.id,
                ...(old?.criterionId
                  ? {
                      criterionId: old.criterionId,
                      proposedName: old.proposedName,
                      proposedWeight: old.proposedWeight,
                    }
                  : {}),
              };
            }),
          });
          mapping = await tx.sheetTabMapping.findUniqueOrThrow({
            where: { id: saved.id },
            include: MAPPING_INCLUDE,
          });
        }
        result.push({
          tabName: tab.tabName,
          mapping: toView(mapping, carriedFrom(mapping, active)),
          detected: {
            headerRow: layout.headerRow,
            totalWeight: layout.totalWeight,
            studentRows: layout.studentRows,
            unknownStudents: tab.unknownStudents,
            crossCheck: layout.crossCheck,
            headersChanged:
              mapping.status === 'CONFIRMED' && mapping.headerSignature !== layout.headerSignature,
          },
        });
      }
      // Drafts for tabs that vanished or stopped looking like subjects are stale proposals.
      const stale = [...existing.values()].filter(
        (m) => m.status === 'DRAFT' && !detectable.has(m.tabName),
      );
      if (stale.length > 0) {
        await tx.sheetTabMapping.deleteMany({ where: { id: { in: stale.map((m) => m.id) } } });
      }
      await this.invalidatePreviews(tx, sourceId);
      if (detection.spreadsheetTitle && detection.spreadsheetTitle !== source.spreadsheetTitle) {
        await tx.googleSheetSource.update({
          where: { id: sourceId },
          data: { spreadsheetTitle: detection.spreadsheetTitle },
        });
      }
      await this.audit.record(
        {
          action: 'source.tabs.detected',
          actorUserId: actor.userId,
          entityType: 'source',
          entityId: sourceId,
          metadata: {
            fatal: detection.fatal,
            tabs: result.map((t) => ({ tab: t.tabName, status: t.mapping?.status ?? null })),
            errors: detection.issues.filter((i) => i.severity === 'ERROR').length,
            warnings: detection.issues.filter((i) => i.severity === 'WARNING').length,
          },
          context: meta,
        },
        tx,
      );
      return result;
    });

    return {
      spreadsheetTitle: detection.spreadsheetTitle,
      fatal: detection.fatal,
      meta: detection.meta,
      rosterTab: detection.rosterTab,
      rosterStudents: detection.roster.length,
      issues: detection.issues.slice(0, DETECT_ISSUE_LIMIT),
      issuesTruncated: detection.issues.length > DETECT_ISSUE_LIMIT,
      tabs,
    };
  }
}
