import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type {
  MonitoringGenerationsView,
  MonitoringStudentsPage,
  MonitoringSubjectSummaryView,
  MonitoringTermSubjectsView,
} from '@ssrs/shared';
import { Roles } from '../auth/decorators.js';
import {
  SubjectQueryDto,
  SubjectStudentsQueryDto,
  TermNumberPipe,
  TermSubjectsQueryDto,
} from './monitoring.dto.js';
import { MonitoringService } from './monitoring.service.js';

/** Subject monitoring: read-only, never cached, not audited (docs/api-specification.md). */
@ApiTags('admin: monitoring')
@ApiCookieAuth()
@Roles('ADMIN')
@Controller('admin/monitoring')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('generations')
  generations(): Promise<MonitoringGenerationsView> {
    return this.monitoring.generations();
  }

  @Get('terms/:generationId/:termNumber/subjects')
  termSubjects(
    @Param('generationId', ParseUUIDPipe) generationId: string,
    @Param('termNumber', TermNumberPipe) termNumber: number,
    @Query() query: TermSubjectsQueryDto,
  ): Promise<MonitoringTermSubjectsView> {
    return this.monitoring.termSubjects(
      generationId,
      termNumber,
      query.includeArchived,
      query.sort,
    );
  }

  @Get('subjects/summary')
  subjectSummary(@Query() query: SubjectQueryDto): Promise<MonitoringSubjectSummaryView> {
    return this.monitoring.subjectSummary(query);
  }

  @Get('subjects/students')
  subjectStudents(@Query() query: SubjectStudentsQueryDto): Promise<MonitoringStudentsPage> {
    return this.monitoring.subjectStudents(query);
  }
}
