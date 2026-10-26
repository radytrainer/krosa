import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { requestMeta } from '../common/request-meta.js';
import { SaveDraftSchemeDto } from './grading-schemes.dto.js';
import { GradingSchemesService } from './grading-schemes.service.js';

@ApiTags('admin: grading schemes')
@ApiCookieAuth()
@Roles('ADMIN')
@Controller('admin')
export class GradingSchemesController {
  constructor(private readonly schemes: GradingSchemesService) {}

  @Get('offerings/:id/grading-schemes')
  list(@Param('id', ParseUUIDPipe) offeringId: string) {
    return this.schemes.list(offeringId);
  }

  /** Creates the draft or replaces its items. */
  @Post('offerings/:id/grading-schemes')
  saveDraft(
    @Param('id', ParseUUIDPipe) offeringId: string,
    @Body() dto: SaveDraftSchemeDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.schemes.saveDraft(offeringId, dto, user, requestMeta(req));
  }

  @Get('offerings/:id/grading-schemes/validate')
  validate(@Param('id', ParseUUIDPipe) offeringId: string) {
    return this.schemes.validateDraft(offeringId);
  }

  @Get('grading-schemes/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.schemes.get(id);
  }

  @Post('grading-schemes/:id/publish')
  @HttpCode(HttpStatus.OK)
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.schemes.publish(id, user, requestMeta(req));
  }

  @Delete('grading-schemes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    await this.schemes.deleteDraft(id, user, requestMeta(req));
  }
}
