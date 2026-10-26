import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { requestMeta } from '../common/request-meta.js';
import { CreateCriterionDto, ReorderCriteriaDto, UpdateCriterionDto } from './criteria.dto.js';
import { CriteriaService } from './criteria.service.js';

@ApiTags('admin: criteria')
@ApiCookieAuth()
@Roles('ADMIN')
@Controller('admin')
export class CriteriaController {
  constructor(private readonly criteria: CriteriaService) {}

  @Get('offerings/:id/criteria')
  list(@Param('id', ParseUUIDPipe) offeringId: string) {
    return this.criteria.list(offeringId);
  }

  @Post('offerings/:id/criteria')
  create(
    @Param('id', ParseUUIDPipe) offeringId: string,
    @Body() dto: CreateCriterionDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.criteria.create(offeringId, dto, user, requestMeta(req));
  }

  @Put('offerings/:id/criteria/order')
  reorder(
    @Param('id', ParseUUIDPipe) offeringId: string,
    @Body() dto: ReorderCriteriaDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.criteria.reorder(offeringId, dto, user, requestMeta(req));
  }

  @Patch('criteria/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCriterionDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.criteria.update(id, dto, user, requestMeta(req));
  }
}
