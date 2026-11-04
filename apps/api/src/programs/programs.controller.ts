import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { requestMeta } from '../common/request-meta.js';
import {
  AssignStudentTermDto,
  ListStudentIssuesQueryDto,
  SetTermClassesDto,
} from './programs.dto.js';
import { ProgramsService } from './programs.service.js';

@ApiTags('admin: programs and term enrollments')
@ApiCookieAuth()
@Roles('ADMIN')
@Controller('admin')
export class ProgramsController {
  constructor(private readonly programs: ProgramsService) {}

  @Get('programs')
  list() {
    return this.programs.programs();
  }

  /** The term's programs and their classes, with how many students each class has. */
  @Get('terms/:id/classes')
  classes(@Param('id', ParseUUIDPipe) termId: string) {
    return this.programs.classes(termId);
  }

  /** Replaces the term's programs and classes. A class with students cannot be removed. */
  @Put('terms/:id/classes')
  setClasses(
    @Param('id', ParseUUIDPipe) termId: string,
    @Body() dto: SetTermClassesDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.programs.setClasses(termId, dto, user, requestMeta(req));
  }

  /** Students the sync could not enroll, and program switches waiting for a decision. */
  @Get('terms/:id/student-issues')
  issues(@Param('id', ParseUUIDPipe) termId: string, @Query() query: ListStudentIssuesQueryDto) {
    return this.programs.issues(termId, query);
  }

  @Post('student-issues/:id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id', ParseUUIDPipe) issueId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.programs.approveSwitch(issueId, user, requestMeta(req));
  }

  @Post('student-issues/:id/reverse')
  @HttpCode(HttpStatus.OK)
  reverse(
    @Param('id', ParseUUIDPipe) issueId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.programs.reverseSwitch(issueId, user, requestMeta(req));
  }

  /** An admin sets the student's program and class for one term. */
  @Put('students/:id/terms/:termId')
  assign(
    @Param('id', ParseUUIDPipe) studentId: string,
    @Param('termId', ParseUUIDPipe) termId: string,
    @Body() dto: AssignStudentTermDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.programs.assign(studentId, termId, dto, user, requestMeta(req));
  }
}
