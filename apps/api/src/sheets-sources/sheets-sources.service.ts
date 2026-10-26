import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@ssrs/database';
import {
  checkTemplate,
  parseSpreadsheetUrl,
  readWorkbook,
  type SheetsReader,
  type TemplateIssue,
  type WorkbookStats,
} from '@ssrs/sheets';
import { AcademicGuardService } from '../academic/academic-guard.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';
import { toHttpError } from './sheets-errors.js';
import { SHEETS_READER } from './sheets-reader.provider.js';
import type { CreateSourceDto, UpdateSourceDto } from './sheets-sources.dto.js';

/** Issues returned by the preview endpoint are capped to keep responses bounded. */
export const PREVIEW_ISSUE_LIMIT = 500;

const SOURCE_INCLUDE = {
  generation: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, username: true } },
  _count: { select: { offerings: true } },
} satisfies Prisma.GoogleSheetSourceInclude;

type SourceRow = Prisma.GoogleSheetSourceGetPayload<{ include: typeof SOURCE_INCLUDE }>;

export interface SourceView {
  id: string;
  generation: { id: string; code: string; name: string };
  spreadsheetId: string;
  spreadsheetUrl: string;
  label: string;
  spreadsheetTitle: string | null;
  status: 'ACTIVE' | 'DISABLED';
  lastSyncedAt: string | null;
  lastSyncJobId: string | null;
  ownedOfferings: number;
  createdBy: { id: string; username: string };
  createdAt: string;
}

export interface SourcePreview {
  spreadsheetTitle: string;
  /** True when a file-level error would make a sync of this source fail without writing. */
  fatal: boolean;
  stats: WorkbookStats;
  issues: TemplateIssue[];
  issuesTruncated: boolean;
  courses: {
    courseKey: string;
    termNumber: number;
    title: string;
    criteria: number;
    rows: number;
    schemeValid: boolean;
  }[];
}

function toView(s: SourceRow): SourceView {
  return {
    id: s.id,
    generation: s.generation,
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

  /**
   * Registers a spreadsheet for a generation (GS-01…03): valid URL, readable by the service
   * account, template tabs present and `_meta.generation_code` matching. Nothing else is read.
   */
  async create(
    generationId: string,
    dto: CreateSourceDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SourceView> {
    const parsed = parseSpreadsheetUrl(dto.url);
    if (!parsed.ok)
      throw new UnprocessableEntityException({ code: parsed.code, message: parsed.message });

    const generation = await this.prisma.client.generation.findUnique({
      where: { id: generationId },
    });
    if (!generation)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Generation not found' });
    await this.guard.assertGenerationEditable(generationId);

    const existing = await this.prisma.client.googleSheetSource.findUnique({
      where: { spreadsheetId: parsed.spreadsheetId },
      include: { generation: { select: { code: true } } },
    });
    if (existing) {
      throw new ConflictException({
        code: 'SOURCE_EXISTS',
        message: `This spreadsheet is already connected to generation ${existing.generation.code}.`,
      });
    }

    let check;
    try {
      check = await checkTemplate(this.reader, parsed.spreadsheetId, generation.code);
    } catch (err) {
      throw toHttpError(err);
    }
    if (!check.ok) {
      const first = check.issues.find((i) => i.severity === 'ERROR');
      throw new UnprocessableEntityException({
        code: first?.code ?? 'TEMPLATE_INVALID',
        message: first?.message ?? 'The spreadsheet does not follow the template.',
        details: check.issues.map((i) => ({ field: i.sheetTab, message: i.message })),
      });
    }

    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        const source = await tx.googleSheetSource.create({
          data: {
            generationId,
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
              generationCode: generation.code,
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
          message: 'This spreadsheet is already connected.',
        });
      }
      throw err;
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
    await this.prisma.client.$transaction(async (tx) => {
      await tx.googleSheetSource.update({
        where: { id },
        data: {
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
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

  /**
   * Dry run: reads and validates the whole workbook exactly as a sync would, without writing
   * academic data. Lets staff fix the sheet before synchronizing.
   */
  async preview(id: string): Promise<SourcePreview> {
    const source = await this.prisma.client.googleSheetSource.findUnique({
      where: { id },
      include: { generation: { select: { code: true } } },
    });
    if (!source)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Spreadsheet source not found' });

    let result;
    try {
      result = await readWorkbook(this.reader, source.spreadsheetId, source.generation.code);
    } catch (err) {
      throw toHttpError(err);
    }
    if (result.spreadsheetTitle && result.spreadsheetTitle !== source.spreadsheetTitle) {
      await this.prisma.client.googleSheetSource.update({
        where: { id },
        data: { spreadsheetTitle: result.spreadsheetTitle },
      });
    }
    return {
      spreadsheetTitle: result.spreadsheetTitle,
      fatal: result.fatal,
      stats: result.stats,
      issues: result.issues.slice(0, PREVIEW_ISSUE_LIMIT),
      issuesTruncated: result.issues.length > PREVIEW_ISSUE_LIMIT,
      courses: result.courses.map((c) => ({
        courseKey: c.courseKey,
        termNumber: c.termNumber,
        title: c.courseName,
        criteria: c.criteria.length,
        rows: c.rows.length,
        schemeValid: c.schemeValid,
      })),
    };
  }
}
