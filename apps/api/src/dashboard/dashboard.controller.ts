import { Controller, Get } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators.js';
import { ListSyncJobsQueryDto } from '../sync/sync.dto.js';
import { SyncService, type SyncJobView } from '../sync/sync.service.js';
import { PrismaService } from '../infra/prisma.service.js';

const RECENT_JOBS = 5;
const FAILED_WINDOW_DAYS = 7;

export interface DashboardView {
  generations: { active: number; archived: number };
  students: { total: number; pending: number; active: number; disabled: number };
  sources: { active: number; disabled: number };
  offerings: { total: number; visible: number; withoutPublishedScheme: number };
  jobs: { active: number; failedRecently: number; failedWindowDays: number };
  recentJobs: SyncJobView[];
}

@ApiTags('admin: dashboard')
@ApiCookieAuth()
@Roles('ADMIN')
@Controller('admin/dashboard')
export class DashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: SyncService,
  ) {}

  @Get()
  async get(): Promise<DashboardView> {
    const db = this.prisma.client;
    const since = new Date(Date.now() - FAILED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const students = (status: 'PENDING' | 'ACTIVE' | 'DISABLED') =>
      db.user.count({ where: { role: 'STUDENT', status } });
    const [
      activeGenerations,
      archivedGenerations,
      pending,
      activeStudents,
      disabled,
      activeSources,
      disabledSources,
      offerings,
      visible,
      withoutPublishedScheme,
      activeJobs,
      failedRecently,
      recent,
    ] = await Promise.all([
      db.generation.count({ where: { status: 'ACTIVE' } }),
      db.generation.count({ where: { status: 'ARCHIVED' } }),
      students('PENDING'),
      students('ACTIVE'),
      students('DISABLED'),
      db.googleSheetSource.count({ where: { status: 'ACTIVE' } }),
      db.googleSheetSource.count({ where: { status: 'DISABLED' } }),
      db.courseOffering.count(),
      db.courseOffering.count({ where: { visibility: 'VISIBLE' } }),
      db.courseOffering.count({ where: { schemes: { none: { status: 'PUBLISHED' } } } }),
      db.syncJob.count({ where: { parentId: null, finishedAt: null } }),
      db.syncJob.count({ where: { parentId: null, status: 'FAILED', queuedAt: { gte: since } } }),
      this.sync.list(Object.assign(new ListSyncJobsQueryDto(), { page: 1, pageSize: RECENT_JOBS })),
    ]);

    return {
      generations: { active: activeGenerations, archived: archivedGenerations },
      students: {
        total: pending + activeStudents + disabled,
        pending,
        active: activeStudents,
        disabled,
      },
      sources: { active: activeSources, disabled: disabledSources },
      offerings: { total: offerings, visible, withoutPublishedScheme },
      jobs: { active: activeJobs, failedRecently, failedWindowDays: FAILED_WINDOW_DAYS },
      recentJobs: recent.data,
    };
  }
}
