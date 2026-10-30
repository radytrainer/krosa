import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@ssrs/database';
import { checkTermWorkbook, parseSpreadsheetUrl, type SheetsReader } from '@ssrs/sheets';
import { AcademicGuardService } from '../academic/academic-guard.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';
import { toHttpError } from './sheets-errors.js';
import { SHEETS_READER } from './sheets-reader.provider.js';
import type {
  ChangeSheetDto,
  CheckSheetDto,
  CreateTermSourceDto,
  UpdateSourceDto,
} from './sheets-sources.dto.js';

/** Issues returned by tab detection are capped to keep responses bounded. */
export const DETECT_ISSUE_LIMIT = 500;

const SOURCE_INCLUDE = {
  generation: { select: { id: true, code: true, name: true } },
  term: { select: { id: true, number: true, name: true } },
  createdBy: { select: { id: true, username: true } },
  _count: { select: { offerings: true } },
} satisfies Prisma.GoogleSheetSourceInclude;

type SourceRow = Prisma.GoogleSheetSourceGetPayload<{ include: typeof SOURCE_INCLUDE }>;

export interface SourceView {
  id: string;
  generation: { id: string; code: string; name: string };
  term: { id: string; number: number; name: string };
  rosterTab: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  label: string;
  spreadsheetTitle: string | null;
  status: 'ACTIVE' | 'PENDING' | 'DISABLED';
  lastSyncedAt: string | null;
  lastSyncJobId: string | null;
  ownedOfferings: number;
  createdBy: { id: string; username: string };
  createdAt: string;
}

export interface SheetCheck {
  spreadsheetId: string;
  spreadsheetTitle: string;
  tabs: string[];
}

export interface TermWorkbooksView {
  generation: { id: string; code: string; name: string };
  term: { id: string; number: number; name: string };
  active: SourceView | null;
  pending: (SourceView & { previewState: 'NONE' | 'NOT_CONFIRMED' | 'CONFIRMED' }) | null;
  /** Earlier sheets of this term, newest first. */
  history: SourceView[];
  /** The sync queued or running for this term, if any. */
  runningJobId: string | null;
}

const SHEET_ID_IN_USE = {
  code: 'SOURCE_EXISTS',
  message: 'This spreadsheet is connected to another term.',
};

function toView(s: SourceRow): SourceView {
  return {
    id: s.id,
    generation: s.generation,
    term: s.term,
    rosterTab: s.rosterTab,
    spreadsheetId: s.spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit`,
    label: s.label,
    spreadsheetTitle: s.spreadsheetTitle,
    status: s.status,
    lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
    lastSyncJobId: s.lastSyncJobId,
    ownedOfferings: s._count.offerings,
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
  };
}

@Injectable()
export class SheetsSourcesService {
  constructor(
    @Inject(SHEETS_READER) private readonly reader: SheetsReader,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly guard: AcademicGuardService,
  ) {}

  serviceAccount(): { configured: boolean; email: string | null } {
    return {
      configured: this.reader.serviceAccountEmail !== null,
      email: this.reader.serviceAccountEmail,
    };
  }

  async list(generationId: string): Promise<SourceView[]> {
    const generation = await this.prisma.client.generation.findUnique({
      where: { id: generationId },
      select: { id: true },
    });
    if (!generation)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Generation not found' });
    const rows = await this.prisma.client.googleSheetSource.findMany({
      where: { generationId },
      include: SOURCE_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toView);
  }

  async get(id: string): Promise<SourceView> {
    const row = await this.prisma.client.googleSheetSource.findUnique({
      where: { id },
      include: SOURCE_INCLUDE,
    });
    if (!row)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Spreadsheet source not found' });
    return toView(row);
  }

  /** Every term of the active generations with its current, pending and earlier sheets. */
  async byTerm(): Promise<TermWorkbooksView[]> {
    const db = this.prisma.client;
    const [terms, sources, previews, jobs] = await Promise.all([
      db.term.findMany({
        where: { generation: { status: 'ACTIVE' } },
        include: { generation: { select: { id: true, code: true, name: true } } },
        orderBy: [{ generation: { startDate: 'desc' } }, { number: 'asc' }],
      }),
      db.googleSheetSource.findMany({
        where: { generation: { status: 'ACTIVE' } },
        include: SOURCE_INCLUDE,
        orderBy: { updatedAt: 'desc' },
      }),
      db.sheetPreview.findMany({
        where: { invalidatedAt: null, source: { status: 'PENDING' } },
        orderBy: { createdAt: 'desc' },
        distinct: ['sourceId'],
      }),
      db.syncJob.findMany({
        where: { scope: 'SOURCE', finishedAt: null, termId: { not: null } },
        select: { id: true, termId: true },
      }),
    ]);
    const previewBySource = new Map(previews.map((p) => [p.sourceId, p]));
    return terms.map((term) => {
      const own = sources.filter((s) => s.termId === term.id);
      const active = own.find((s) => s.status === 'ACTIVE');
      const pending = own.find((s) => s.status === 'PENDING');
      const preview = pending && previewBySource.get(pending.id);
      return {
        generation: term.generation,
        term: { id: term.id, number: term.number, name: term.name },
        active: active ? toView(active) : null,
        pending: pending
          ? {
              ...toView(pending),
              previewState: preview
                ? preview.confirmedAt
                  ? ('CONFIRMED' as const)
                  : ('NOT_CONFIRMED' as const)
                : ('NONE' as const),
            }
          : null,
        history: own.filter((s) => s.status === 'DISABLED').map(toView),
        runningJobId: jobs.find((j) => j.termId === term.id)?.id ?? null,
      };
    });
  }

  private async sheetCheck(termId: string, url: string, rosterTab: string) {
    const parsed = parseSpreadsheetUrl(url);
    if (!parsed.ok)
      throw new UnprocessableEntityException({ code: parsed.code, message: parsed.message });
    const term = await this.prisma.client.term.findUnique({
      where: { id: termId },
      include: { generation: { select: { id: true, code: true, name: true } } },
    });
    if (!term) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Term not found' });
    await this.guard.assertGenerationEditable(term.generationId);
    let check;
    try {
      check = await checkTermWorkbook(this.reader, parsed.spreadsheetId, {
        generationCode: term.generation.code,
        termNumber: term.number,
        rosterTab,
      });
    } catch (err) {
      throw toHttpError(err);
    }
    if (!check.ok) {
      const first = check.issues.find((i) => i.severity === 'ERROR');
      throw new UnprocessableEntityException({
        code: first?.code ?? 'TEMPLATE_INVALID',
        message: first?.message ?? 'The spreadsheet cannot be used as a term workbook.',
        details: check.issues.map((i) => ({ field: i.sheetTab, message: i.message })),
      });
    }
    return { spreadsheetId: parsed.spreadsheetId, term, check };
  }

  /** Validates a new sheet for a term and shows what it holds. Changes nothing. */
  async checkSheet(termId: string, dto: CheckSheetDto): Promise<SheetCheck> {
    const { spreadsheetId, check } = await this.sheetCheck(termId, dto.url, dto.rosterTab ?? 'ALL');
    const other = await this.prisma.client.googleSheetSource.findUnique({
      where: { spreadsheetId },
      select: { termId: true },
    });
    if (other && other.termId !== termId) throw new ConflictException(SHEET_ID_IN_USE);
    return { spreadsheetId, spreadsheetTitle: check.spreadsheetTitle, tabs: check.tabs };
  }

  private async assertTermIdle(termId: string): Promise<void> {
    const running = await this.prisma.client.syncJob.findFirst({
      where: { termId, finishedAt: null },
      select: { id: true },
    });
    if (running) {
      throw new ConflictException({
        code: 'SYNC_IN_PROGRESS',
        message: 'A sync of this term is queued or running. Wait until it finishes.',
        jobId: running.id,
      });
    }
  }

  /**
   * Connects a different sheet to a term as PENDING. Nothing that students see changes: scores
   * only move when a reviewed sync of this sheet completes, which also makes it active. Going
   * back to an earlier sheet takes the same path, reusing that sheet's record.
   */
  async changeSheet(
    termId: string,
    dto: ChangeSheetDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SourceView> {
    const rosterTab = dto.rosterTab ?? 'ALL';
    const { spreadsheetId, term, check } = await this.sheetCheck(termId, dto.url, rosterTab);
    await this.assertTermIdle(termId);
    const db = this.prisma.client;
    const known = await db.googleSheetSource.findUnique({ where: { spreadsheetId } });
    if (known && known.termId !== termId) throw new ConflictException(SHEET_ID_IN_USE);
    if (known?.status === 'ACTIVE') {
      throw new ConflictException({
        code: 'SAME_SHEET',
        message: 'This sheet is already the active sheet of this term.',
      });
    }
    const active = await db.googleSheetSource.findFirst({
      where: { termId, status: 'ACTIVE' },
      select: { spreadsheetId: true },
    });

    const sourceId = await db.$transaction(async (tx) => {
      // A sheet that was pending until now goes back to the history.
      await tx.googleSheetSource.updateMany({
        where: { termId, status: 'PENDING', id: { not: known?.id } },
        data: { status: 'DISABLED' },
      });
      const source = known
        ? await tx.googleSheetSource.update({
            where: { id: known.id },
            data: { status: 'PENDING', label: dto.label, rosterTab },
          })
        : await tx.googleSheetSource.create({
            data: {
              generationId: term.generationId,
              termId,
              rosterTab,
              spreadsheetId,
              label: dto.label,
              spreadsheetTitle: check.spreadsheetTitle || null,
              status: 'PENDING',
              createdById: actor.userId,
            },
          });
      // Every earlier review of this sheet is void: it must be reviewed again.
      await tx.sheetPreview.updateMany({
        where: { sourceId: source.id, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      });
      await tx.sheetTabMapping.updateMany({
        where: { sourceId: source.id, status: 'CONFIRMED' },
        data: { status: 'DRAFT' },
      });
      await this.audit.record(
        {
          action: 'source.switched',
          actorUserId: actor.userId,
          entityType: 'source',
          entityId: source.id,
          metadata: {
            termId,
            generationCode: term.generation.code,
            termNumber: term.number,
            oldSpreadsheetId: active?.spreadsheetId ?? null,
            newSpreadsheetId: spreadsheetId,
          },
          context: meta,
        },
        tx,
      );
      return source.id;
    });
    return this.get(sourceId);
  }

  /** Gives up on a pending sheet. It joins the term's history; nothing else changes. */
  async discardPending(id: string, actor: AuthUser, meta: RequestMeta): Promise<SourceView> {
    const source = await this.prisma.client.googleSheetSource.findUnique({ where: { id } });
    if (!source)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Spreadsheet source not found' });
    if (source.status !== 'PENDING') {
      throw new ConflictException({ code: 'NOT_PENDING', message: 'This sheet is not pending.' });
    }
    await this.assertTermIdle(source.termId);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.googleSheetSource.update({ where: { id }, data: { status: 'DISABLED' } });
      await tx.sheetPreview.updateMany({
        where: { sourceId: id, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      });
      await this.audit.record(
        {
          action: 'source.pending.discarded',
          actorUserId: actor.userId,
          entityType: 'source',
          entityId: id,
          metadata: { termId: source.termId, spreadsheetId: source.spreadsheetId },
          context: meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /**
   * Connects a term workbook (one spreadsheet per term, one tab per subject): valid URL,
   * readable, roster tab present, `_meta` (when present) naming this generation and term. One
   * active workbook per term. Subject tabs are mapped afterwards (`POST /sources/:id/detect`).
   */
  async createForTerm(
    termId: string,
    dto: CreateTermSourceDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SourceView> {
    const parsed = parseSpreadsheetUrl(dto.url);
    if (!parsed.ok)
      throw new UnprocessableEntityException({ code: parsed.code, message: parsed.message });

    const term = await this.prisma.client.term.findUnique({
      where: { id: termId },
      include: { generation: { select: { id: true, code: true } } },
    });
    if (!term) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Term not found' });
    await this.guard.assertGenerationEditable(term.generationId);

    const existing = await this.prisma.client.googleSheetSource.findUnique({
      where: { spreadsheetId: parsed.spreadsheetId },
      include: { generation: { select: { code: true } } },
    });
    // A sheet removed from this same term can come back; its record is reused below.
    if (existing && (existing.termId !== termId || existing.status !== 'DISABLED')) {
      throw new ConflictException({
        code: 'SOURCE_EXISTS',
        message: `This spreadsheet is already connected to generation ${existing.generation.code}.`,
      });
    }
    await this.assertNeverSynced(termId);
    const termSource = await this.prisma.client.googleSheetSource.findFirst({
      where: { termId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (termSource) {
      throw new ConflictException({
        code: 'TERM_SOURCE_EXISTS',
        message: 'This term already has an active workbook. Disable it before connecting another.',
        sourceId: termSource.id,
      });
    }

    const rosterTab = dto.rosterTab ?? 'ALL';
    let check;
    try {
      check = await checkTermWorkbook(this.reader, parsed.spreadsheetId, {
        generationCode: term.generation.code,
        termNumber: term.number,
        rosterTab,
      });
    } catch (err) {
      throw toHttpError(err);
    }
    if (!check.ok) {
      const first = check.issues.find((i) => i.severity === 'ERROR');
      throw new UnprocessableEntityException({
        code: first?.code ?? 'TEMPLATE_INVALID',
        message: first?.message ?? 'The spreadsheet cannot be used as a term workbook.',
        details: check.issues.map((i) => ({ field: i.sheetTab, message: i.message })),
      });
    }

    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        const source = existing
          ? await tx.googleSheetSource.update({
              where: { id: existing.id },
              data: { status: 'ACTIVE', label: dto.label, rosterTab },
            })
          : await tx.googleSheetSource.create({
              data: {
                generationId: term.generationId,
                termId,
                rosterTab,
                spreadsheetId: parsed.spreadsheetId,
                label: dto.label,
                spreadsheetTitle: check.spreadsheetTitle || null,
                createdById: actor.userId,
              },
            });
        await this.audit.record(
          {
            action: 'source.created',
            actorUserId: actor.userId,
            entityType: 'source',
            entityId: source.id,
            metadata: {
              generationCode: term.generation.code,
              termNumber: term.number,
              spreadsheetId: source.spreadsheetId,
              label: source.label,
            },
            context: meta,
          },
          tx,
        );
        return source;
      });
      return this.get(created.id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'SOURCE_EXISTS',
          message: 'This spreadsheet or term already has a connected workbook.',
        });
      }
      throw err;
    }
  }

  /** A term with synced scores changes sheets only through the reviewed path. */
  private async assertNeverSynced(termId: string): Promise<void> {
    const synced = await this.prisma.client.googleSheetSource.count({
      where: { termId, lastSyncedAt: { not: null } },
    });
    if (synced > 0) {
      throw new ConflictException({
        code: 'USE_CHANGE_SHEET',
        message: 'This term already has synced scores. Connect a new sheet from Edit term.',
      });
    }
  }

  /** Removing a sheet disconnects it: synced scores stay, and students keep seeing them. */
  private async assertRemovable(termId: string): Promise<void> {
    await this.assertTermIdle(termId);
    const pending = await this.prisma.client.googleSheetSource.count({
      where: { termId, status: 'PENDING' },
    });
    if (pending > 0) {
      throw new ConflictException({
        code: 'PENDING_SHEET_EXISTS',
        message: 'This term has a new sheet waiting. Discard it or sync it first.',
      });
    }
  }

  async update(
    id: string,
    dto: UpdateSourceDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SourceView> {
    const source = await this.prisma.client.googleSheetSource.findUnique({ where: { id } });
    if (!source)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Spreadsheet source not found' });
    await this.guard.assertGenerationEditable(source.generationId);
    if (dto.status !== undefined && dto.status !== source.status) {
      if (source.status === 'PENDING') {
        throw new ConflictException({
          code: 'NOT_PENDING',
          message: 'A pending sheet becomes active through its sync, or can be discarded.',
        });
      }
      if (dto.status === 'ACTIVE') await this.assertNeverSynced(source.termId);
      else await this.assertRemovable(source.termId);
    }
    await this.prisma.client.$transaction(async (tx) => {
      try {
        await tx.googleSheetSource.update({
          where: { id },
          data: {
            ...(dto.label !== undefined ? { label: dto.label } : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
          },
        });
      } catch (err) {
        // google_sheet_sources_one_active_per_term
        if (isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'TERM_SOURCE_EXISTS',
            message: 'This term already has an active workbook. Disable it first.',
          });
        }
        throw err;
      }
      await this.audit.record(
        {
          action:
            dto.status && dto.status !== source.status
              ? `source.${dto.status === 'DISABLED' ? 'disabled' : 'enabled'}`
              : 'source.updated',
          actorUserId: actor.userId,
          entityType: 'source',
          entityId: id,
          metadata: { changes: dto },
          context: meta,
        },
        tx,
      );
    });
    return this.get(id);
  }
}
