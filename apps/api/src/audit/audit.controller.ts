import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@ssrs/database';
import { IsISO8601, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { Roles } from '../auth/decorators.js';
import { paginated, PaginationQueryDto, skipTake } from '../common/pagination.js';
import { PrismaService } from '../infra/prisma.service.js';

export class ListAuditLogsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Exact action, or a prefix ending in "." (e.g. "auth.")' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z_.]{1,80}$/)
  action?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 40)
  entityType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 64)
  entityId?: string;

  @ApiPropertyOptional({ description: 'ISO 8601 timestamp (inclusive)' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO 8601 timestamp (exclusive)' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

@ApiTags('admin: audit')
@ApiCookieAuth()
@Roles('ADMIN')
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query() query: ListAuditLogsQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action
        ? query.action.endsWith('.')
          ? { action: { startsWith: query.action } }
          : { action: query.action }
        : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.auditLog.findMany({
        where,
        include: { actor: { select: { id: true, username: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.client.auditLog.count({ where }),
    ]);
    return paginated(
      rows.map((r) => ({
        id: r.id,
        action: r.action,
        actorType: r.actorType,
        actor: r.actor,
        entityType: r.entityType,
        entityId: r.entityId,
        metadata: r.metadata,
        ip: r.ip,
        userAgent: r.userAgent,
        requestId: r.requestId,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      query,
    );
  }
}
