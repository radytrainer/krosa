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
  Query,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { requestMeta } from '../common/request-meta.js';
import {
  CreateGenerationDto,
  ListGenerationsQueryDto,
  ReleaseTermDto,
  UpdateGenerationDto,
  UpdateTermDto,
} from './generations.dto.js';
import { GenerationsService } from './generations.service.js';

@ApiTags('admin: generations')
@ApiCookieAuth()
@Roles('ADMIN')
@Controller('admin')
export class GenerationsController {
  constructor(private readonly generations: GenerationsService) {}

  @Get('generations')
  list(@Query() query: ListGenerationsQueryDto) {
    return this.generations.list(query);
  }

  @Post('generations')
  create(@Body() dto: CreateGenerationDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.generations.create(dto, user, requestMeta(req));
  }

  @Get('generations/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.generations.get(id);
  }

  @Patch('generations/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGenerationDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.generations.update(id, dto, user, requestMeta(req));
  }

  @Post('generations/:id/archive')
  @HttpCode(HttpStatus.OK)
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.generations.setStatus(id, 'ARCHIVED', user, requestMeta(req));
  }

  @Post('generations/:id/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.generations.setStatus(id, 'ACTIVE', user, requestMeta(req));
  }

  @Get('generations/:id/terms')
  terms(@Param('id', ParseUUIDPipe) id: string) {
    return this.generations.listTerms(id);
  }

  /** Shows (`visible: true`) or hides every subject of the term to students. */
  @Post('terms/:id/release')
  @HttpCode(HttpStatus.OK)
  release(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReleaseTermDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.generations.setTermRelease(id, dto.visible, user, requestMeta(req));
  }

  @Patch('terms/:id')
  updateTerm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTermDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.generations.updateTerm(id, dto, user, requestMeta(req));
  }
}
