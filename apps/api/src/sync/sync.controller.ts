import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { PaginationQueryDto } from '../common/pagination.js';
import { requestMeta } from '../common/request-meta.js';
import { ListSyncErrorsQueryDto, ListSyncJobsQueryDto, RequestSyncDto } from './sync.dto.js';
import { SyncService } from './sync.service.js';

@ApiTags('admin: synchronization')
@ApiCookieAuth()
@Roles('ADMIN')
@Controller('admin')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('sync')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ description: '{ jobId } — poll GET /admin/sync/:jobId for progress' })
  request(@Body() dto: RequestSyncDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.sync.request(dto, user, requestMeta(req));
  }

  @Get('sync')
  list(@Query() query: ListSyncJobsQueryDto) {
    return this.sync.list(query);
  }

  /** Generation and Term options for the sync form. */
  @Get('sync/targets')
  targets() {
    return this.sync.targets();
  }

  @Get('sync/:jobId')
  get(@Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.sync.get(jobId);
  }

  @Get('sync/:jobId/errors')
  errors(@Param('jobId', ParseUUIDPipe) jobId: string, @Query() query: ListSyncErrorsQueryDto) {
    return this.sync.errors(jobId, query);
  }

  @Post('sync/:jobId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retry(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.sync.retry(jobId, user, requestMeta(req));
  }

  @Get('sources/:id/sync-history')
  history(@Param('id', ParseUUIDPipe) sourceId: string, @Query() query: PaginationQueryDto) {
    return this.sync.sourceHistory(sourceId, query);
  }
}
