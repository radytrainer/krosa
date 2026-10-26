import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { ResultsQueryDto } from './results.dto.js';
import { ResultsService } from './results.service.js';

/** STU-01: the student is always the session's user; no route takes a student identifier. */
@ApiTags('student')
@ApiCookieAuth()
@Roles('STUDENT')
@Controller('student/me')
export class StudentResultsController {
  constructor(private readonly results: ResultsService) {}

  @Get()
  profile(@CurrentUser() user: AuthUser) {
    return this.results.profile(user.userId);
  }

  @Get('results')
  async allResults(@CurrentUser() user: AuthUser, @Query() query: ResultsQueryDto) {
    const view = await this.results.forStudentUser(user.userId);
    if (query.term === undefined) return view;
    return { ...view, terms: view.terms.filter((t) => t.number === query.term) };
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.results.summary(user.userId);
  }

  @Get('courses')
  courses(@CurrentUser() user: AuthUser) {
    return this.results.courses(user.userId);
  }

  @Get('courses/:offeringId')
  course(@CurrentUser() user: AuthUser, @Param('offeringId', ParseUUIDPipe) offeringId: string) {
    return this.results.course(user.userId, offeringId);
  }
}
