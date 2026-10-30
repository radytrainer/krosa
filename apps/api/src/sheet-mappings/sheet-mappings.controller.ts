import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { requestMeta } from '../common/request-meta.js';
import { ConfirmMappingDto } from './sheet-mappings.dto.js';
import { SheetMappingsService } from './sheet-mappings.service.js';

@ApiTags('admin: term workbook mappings')
@ApiCookieAuth()
@Roles('ADMIN')
@Controller('admin/sources/:id')
export class SheetMappingsController {
  constructor(private readonly mappings: SheetMappingsService) {}

  @Get('mappings')
  list(@Param('id', ParseUUIDPipe) sourceId: string) {
    return this.mappings.list(sourceId);
  }

  @Post('mappings/:mappingId/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param('id', ParseUUIDPipe) sourceId: string,
    @Param('mappingId', ParseUUIDPipe) mappingId: string,
    @Body() dto: ConfirmMappingDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.mappings.confirm(sourceId, mappingId, dto, user, requestMeta(req));
  }

  @Post('mappings/:mappingId/ignore')
  @HttpCode(HttpStatus.OK)
  ignore(
    @Param('id', ParseUUIDPipe) sourceId: string,
    @Param('mappingId', ParseUUIDPipe) mappingId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.mappings.ignore(sourceId, mappingId, user, requestMeta(req));
  }

  @Post('mappings/:mappingId/reopen')
  @HttpCode(HttpStatus.OK)
  reopen(
    @Param('id', ParseUUIDPipe) sourceId: string,
    @Param('mappingId', ParseUUIDPipe) mappingId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.mappings.reopen(sourceId, mappingId, user, requestMeta(req));
  }

  /** The newest usable preview of this sheet, or null. */
  @Get('preview')
  latestPreview(@Param('id', ParseUUIDPipe) sourceId: string) {
    return this.mappings.latestPreview(sourceId);
  }

  /** Compares a pending sheet with the database. Imports nothing. */
  @Post('preview')
  preview(
    @Param('id', ParseUUIDPipe) sourceId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.mappings.preview(sourceId, user, requestMeta(req));
  }

  @Post('preview/:previewId/confirm')
  @HttpCode(HttpStatus.OK)
  confirmPreview(
    @Param('id', ParseUUIDPipe) sourceId: string,
    @Param('previewId', ParseUUIDPipe) previewId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.mappings.confirmPreview(sourceId, previewId, user, requestMeta(req));
  }

  /** Reads the term workbook and stores a DRAFT mapping proposal for every subject tab. */
  @Post('detect')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Detected tabs with proposed column roles and weights' })
  detect(
    @Param('id', ParseUUIDPipe) sourceId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.mappings.detect(sourceId, user, requestMeta(req));
  }
}
