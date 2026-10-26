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
  Res,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { requestMeta } from '../common/request-meta.js';
import {
  IssueCredentialsDto,
  ListStudentsQueryDto,
  UpdateStudentStatusDto,
} from './students.dto.js';
import { StudentsService } from './students.service.js';

@ApiTags('admin: students')
@ApiCookieAuth()
@Roles('ADMIN')
@Controller('admin/students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get()
  list(@Query() query: ListStudentsQueryDto) {
    return this.students.list(query);
  }

  /**
   * Issues temporary passwords in bulk and downloads them as CSV. This is the only time the
   * passwords exist in plain text; the response is never cached (Cache-Control: no-store).
   */
  @Post('issue-credentials')
  @HttpCode(HttpStatus.OK)
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'CSV: student_id, student_name, class, temporary_password, expires_at',
  })
  async issueCredentials(
    @Body() dto: IssueCredentialsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const result = await this.students.issueCredentials(dto, user, requestMeta(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Issued-Count', String(result.count));
    return result.csv;
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.students.get(id);
  }

  @Patch(':id/status')
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudentStatusDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.students.setStatus(id, dto, user, requestMeta(req));
  }

  /** Returns the temporary password once. Responses are `Cache-Control: no-store`. */
  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: '{ studentCode, temporaryPassword, expiresAt }; shown only once' })
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.students.resetPassword(id, user, requestMeta(req));
  }
}
