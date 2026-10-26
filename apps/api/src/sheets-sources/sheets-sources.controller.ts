import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { requestMeta } from '../common/request-meta.js';
import { CreateSourceDto, UpdateSourceDto } from './sheets-sources.dto.js';
import { SheetsSourcesService } from './sheets-sources.service.js';

@ApiTags('admin: spreadsheet sources')
@ApiCookieAuth()
@Roles('ADMIN')
@Controller('admin')
export class SheetsSourcesController {
  constructor(private readonly sources: SheetsSourcesService) {}

  /** The email administrators must share spreadsheets with (Viewer access). */
  @Get('sources/service-account')
  serviceAccount() {
    return this.sources.serviceAccount();
  }

  @Get('generations/:id/sources')
  list(@Param('id', ParseUUIDPipe) generationId: string) {
    return this.sources.list(generationId);
  }

  @Post('generations/:id/sources')
  create(
    @Param('id', ParseUUIDPipe) generationId: string,
    @Body() dto: CreateSourceDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.sources.create(generationId, dto, user, requestMeta(req));
  }

  @Get('sources/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sources.get(id);
  }

  @Patch('sources/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSourceDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.sources.update(id, dto, user, requestMeta(req));
  }

  /** Validates the whole spreadsheet without importing anything. */
  @Post('sources/:id/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Validation report: stats, issues (≤ 500), courses found' })
  preview(@Param('id', ParseUUIDPipe) id: string) {
    return this.sources.preview(id);
  }
}
