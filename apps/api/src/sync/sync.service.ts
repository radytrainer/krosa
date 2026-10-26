import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma, SyncJob } from '@ssrs/database';
import { failJob } from '@ssrs/sync';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RateLimiter } from '../auth/login-rate-limiter.js';
import {
  paginated,
  skipTake,
  type Paginated,
  type PaginationQueryDto,
} from '../common/pagination.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { RateLimitedException } from '../common/rate-limited.exception.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';
import { SyncQueueService } from './sync-queue.service.js';
import type { ListSyncErrorsQueryDto, ListSyncJobsQueryDto, RequestSyncDto } from './sync.dto.js';

const SYNC_REQUEST_LIMIT = { limit: 10, windowSeconds: 60 };
const RETRYABLE = new Set(['FAILED', 'SUCCEEDED_WITH_ERRORS']);

const JOB_INCLUDE = {
  source: { select: { id: true, label: true, spreadsheetId: true } },
  generation: { select: { id: true, code: true, name: true } },
  requestedBy: { select: { id: true, username: true } },
} satisfies Prisma.SyncJobInclude;

type JobRow = Prisma.SyncJobGetPayload<{ include: typeof JOB_INCLUDE }>;

export interface SyncJobView {
  id: string;
  scope: SyncJob['scope'];
  status: SyncJob['status'];
  phase: string | null;
  progress: { current: number; total: number };
  counts: unknown;
  errorCount: number;
  warningCount: number;
  failureCode: string | null;
  failureMessage: string | null;
  source: { id: string; label: string; spreadsheetId: string } | null;
  generation: { id: string; code: string; name: string } | null;
  requestedBy: { id: string; username: string };
  parentId: string | null;
  retryOfId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function toView(j: JobRow): SyncJobView {
  return {
    id: j.id,
    scope: j.scope,
    status: j.status,
    phase: j.phase,
    progress: { current: j.progressCurrent, total: j.progressTotal },
    counts: j.counts,
    errorCount: j.errorCount,
    warningCount: j.warningCount,
    failureCode: j.failureCode,
    failureMessage: j.failureMessage,
    source: j.source,
    generation: j.generation,
    requestedBy: j.requestedBy,
    parentId: j.parentId,
    retryOfId: j.retryOfId,
    queuedAt: j.queuedAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}

interface Target {
  scope: 'SOURCE' | 'GENERATION' | 'ALL';
  sourceId?: string | null;
  generationId?: string | null;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: SyncQueueService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
  ) {}

  async request(
    dto: RequestSyncDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<{ jobId: string }> {
    const limit = await this.limiter.hit('sync:request', actor.userId, SYNC_REQUEST_LIMIT);
    if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds);
    return this.start(
      { scope: dto.scope, sourceId: dto.sourceId, generationId: dto.generationId },
      actor,
      meta,
      null,
    );
  }

  async retry(jobId: string, actor: AuthUser, meta: RequestMeta): Promise<{ jobId: string }> {
    const job = await this.prisma.client.syncJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sync job not found' });
    if (!RETRYABLE.has(job.status)) {
      throw new ConflictException({
        code: 'JOB_NOT_RETRYABLE',
        message: 'Only failed or partially failed jobs can be retried.',
      });
    }
    return this.start(job, actor, meta, job.id);
  }

  /** Creates the job rows, then enqueues per-source jobs (after commit, so the worker sees them). */
  private async start(
    target: Target,
    actor: AuthUser,
    meta: RequestMeta,
    retryOfId: string | null,
  ): Promise<{ jobId: string }> {
    const db = this.prisma.client;
    if (target.scope === 'SOURCE') {
      const source = await db.googleSheetSource.findUnique({
        where: { id: target.sourceId ?? '' },
        include: { generation: { select: { status: true } } },
      });
      if (!source)
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Spreadsheet source not found' });
      if (source.status !== 'ACTIVE') {
        throw new ConflictException({
          code: 'SOURCE_DISABLED',
          message: 'This spreadsheet source is disabled.',
        });
      }
      if (source.generation.status !== 'ACTIVE') {
        throw new ConflictException({
          code: 'GENERATION_ARCHIVED',
          message: 'The generation is archived.',
        });
      }
      const job = await this.createSourceJob(source.id, actor.userId, null, retryOfId);
      if (!job.ok) {
        throw new ConflictException({
          code: 'SYNC_IN_PROGRESS',
          message: 'A sync of this spreadsheet is already queued or running.',
          jobId: job.activeJobId,
        });
      }
      await this.recordRequest(job.id, target, actor, meta, retryOfId);
      await this.enqueueOrFail([job.id]);
      return { jobId: job.id };
    }

    if (target.scope === 'GENERATION') {
      const generation = await db.generation.findUnique({
        where: { id: target.generationId ?? '' },
      });
      if (!generation)
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Generation not found' });
      if (generation.status !== 'ACTIVE') {
        throw new ConflictException({
          code: 'GENERATION_ARCHIVED',
          message: 'The generation is archived.',
        });
      }
    }
    const sources = await db.googleSheetSource.findMany({
      where: {
        status: 'ACTIVE',
        generation: { status: 'ACTIVE' },
        ...(target.scope === 'GENERATION' ? { generationId: target.generationId ?? '' } : {}),
      },
      select: { id: true, label: true },
      orderBy: { createdAt: 'asc' },
    });
    if (sources.length === 0) {
      throw new UnprocessableEntityException({
        code: 'NO_SOURCES',
        message: 'There are no active spreadsheets to synchronize.',
      });
    }

    // Each child is committed independently (SYNC-06); busy sources are skipped and reported.
    const parent = await db.syncJob.create({
      data: {
        scope: target.scope,
        generationId: target.scope === 'GENERATION' ? target.generationId : null,
        requestedById: actor.userId,
        retryOfId,
        progressTotal: sources.length,
      },
    });
    const childIds: string[] = [];
    const busy: { id: string; label: string; activeJobId: string | null }[] = [];
    for (const source of sources) {
      const child = await this.createSourceJob(source.id, actor.userId, parent.id, null);
      if (child.ok) childIds.push(child.id);
      else busy.push({ id: source.id, label: source.label, activeJobId: child.activeJobId });
    }
    if (childIds.length === 0) {
      await db.syncJob.delete({ where: { id: parent.id } });
      throw new ConflictException({
        code: 'SYNC_IN_PROGRESS',
        message: 'Every spreadsheet already has a sync queued or running.',
      });
    }
    if (busy.length > 0) {
      await db.syncError.createMany({
        data: busy.map((b) => ({
          jobId: parent.id,
          severity: 'WARNING' as const,
          code: 'SOURCE_BUSY',
          message: `Spreadsheet "${b.label}" was skipped because a sync of it is already queued or running.`,
        })),
      });
    }
    await db.syncJob.update({
      where: { id: parent.id },
      data: { progressTotal: childIds.length, warningCount: busy.length },
    });
    await this.recordRequest(parent.id, target, actor, meta, retryOfId, {
      sources: childIds.length,
      skipped: busy.length,
    });
    await this.enqueueOrFail(childIds);
    return { jobId: parent.id };
  }

  private async createSourceJob(
    sourceId: string,
    requestedById: string,
    parentId: string | null,
    retryOfId: string | null,
  ): Promise<{ ok: true; id: string } | { ok: false; activeJobId: string | null }> {
    try {
      const job = await this.prisma.client.syncJob.create({
        data: { scope: 'SOURCE', sourceId, requestedById, parentId, retryOfId },
      });
      return { ok: true, id: job.id };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const active = await this.prisma.client.syncJob.findFirst({
        where: { scope: 'SOURCE', sourceId, finishedAt: null },
        select: { id: true },
      });
      return { ok: false, activeJobId: active?.id ?? null };
    }
  }

  private async recordRequest(
    jobId: string,
    target: Target,
    actor: AuthUser,
    meta: RequestMeta,
    retryOfId: string | null,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.audit.record({
      action: retryOfId ? 'sync.retried' : 'sync.requested',
      actorUserId: actor.userId,
      entityType: 'sync_job',
      entityId: jobId,
      metadata: {
        scope: target.scope,
        sourceId: target.sourceId ?? null,
        generationId: target.generationId ?? null,
        retryOfId,
        ...extra,
      },
      context: meta,
    });
  }

  /** A job that cannot be queued must not stay QUEUED forever (it would also block its source). */
  private async enqueueOrFail(jobIds: string[]): Promise<void> {
    const failed: string[] = [];
    for (const id of jobIds) {
      try {
        await this.queue.enqueue(id);
      } catch (err) {
        this.logger.error(
          `Failed to enqueue sync job ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        await failJob(
          this.prisma.client,
          id,
          'ENQUEUE_FAILED',
          'The job queue is unavailable. Try again later.',
        );
        failed.push(id);
      }
    }
    if (failed.length === jobIds.length) {
      throw new ServiceUnavailableException({
        code: 'QUEUE_UNAVAILABLE',
        message: 'The job queue is unavailable. Try again later.',
      });
    }
  }

  async list(query: ListSyncJobsQueryDto): Promise<Paginated<SyncJobView>> {
    const where: Prisma.SyncJobWhereInput = {
      ...(query.includeChildren ? {} : { parentId: null }),
      ...(query.status ? { status: query.status } : {}),
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.sourceId ? { sourceId: query.sourceId } : {}),
      ...(query.generationId
        ? {
            OR: [
              { generationId: query.generationId },
              { source: { generationId: query.generationId } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.syncJob.findMany({
        where,
        include: JOB_INCLUDE,
        orderBy: { queuedAt: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.client.syncJob.count({ where }),
    ]);
    return paginated(rows.map(toView), total, query);
  }

  async get(id: string): Promise<SyncJobView & { children: SyncJobView[] }> {
    const job = await this.prisma.client.syncJob.findUnique({
      where: { id },
      include: { ...JOB_INCLUDE, children: { include: JOB_INCLUDE, orderBy: { queuedAt: 'asc' } } },
    });
    if (!job) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sync job not found' });
    return { ...toView(job), children: job.children.map(toView) };
  }

  async errors(id: string, query: ListSyncErrorsQueryDto) {
    const exists = await this.prisma.client.syncJob.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sync job not found' });
    const where: Prisma.SyncErrorWhereInput = {
      jobId: id,
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.code ? { code: query.code } : {}),
      ...(query.sheetTab ? { sheetTab: query.sheetTab } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.syncError.findMany({
        where,
        orderBy: [
          { severity: 'asc' },
          { sheetTab: 'asc' },
          { rowNumber: 'asc' },
          { createdAt: 'asc' },
        ],
        ...skipTake(query),
      }),
      this.prisma.client.syncError.count({ where }),
    ]);
    return paginated(
      rows.map(({ jobId: _jobId, ...e }) => ({ ...e, createdAt: e.createdAt.toISOString() })),
      total,
      query,
    );
  }

  async sourceHistory(
    sourceId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<SyncJobView>> {
    const source = await this.prisma.client.googleSheetSource.findUnique({
      where: { id: sourceId },
      select: { id: true },
    });
    if (!source)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Spreadsheet source not found' });
    const listQuery: ListSyncJobsQueryDto = {
      page: query.page,
      pageSize: query.pageSize,
      sourceId,
      includeChildren: true,
    };
    return this.list(listQuery);
  }
}
