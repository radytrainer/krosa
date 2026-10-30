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
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { requestMeta } from '../common/request-meta.js';
import {
  ChangeSheetDto,
  CheckSheetDto,
  CreateTermSourceDto,
  UpdateSourceDto,
} from './sheets-sources.dto.js';
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

  /** Connects a term workbook: one spreadsheet per term, one tab per subject. */
  @Post('terms/:id/sources')
  createForTerm(
    @Param('id', ParseUUIDPipe) termId: string,
    @Body() dto: CreateTermSourceDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.sources.createForTerm(termId, dto, user, requestMeta(req));
  }

  /** Every term with its active, pending and earlier sheets. */
  @Get('term-workbooks')
  byTerm() {
    return this.sources.byTerm();
  }

  /** Validates a replacement sheet and shows its name and tabs. Changes nothing. */
  @Post('terms/:id/sources/check')
  @HttpCode(HttpStatus.OK)
  check(@Param('id', ParseUUIDPipe) termId: string, @Body() dto: CheckSheetDto) {
    return this.sources.checkSheet(termId, dto);
  }

  /** Connects a replacement sheet as pending. Student scores do not change. */
  @Post('terms/:id/sources/change')
  changeSheet(
    @Param('id', ParseUUIDPipe) termId: string,
    @Body() dto: ChangeSheetDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.sources.changeSheet(termId, dto, user, requestMeta(req));
  }

  @Post('sources/:id/discard')
  @HttpCode(HttpStatus.OK)
  discard(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.sources.discardPending(id, user, requestMeta(req));
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
}
