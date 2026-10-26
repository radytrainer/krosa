import {
  Body,
  Controller,
  Get,
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
  CreateCourseDto,
  CreateOfferingDto,
  ListCoursesQueryDto,
  ListOfferingsQueryDto,
  UpdateCourseDto,
  UpdateOfferingDto,
} from './courses.dto.js';
import { CoursesService } from './courses.service.js';

@ApiTags('admin: courses')
@ApiCookieAuth()
@Roles('ADMIN')
@Controller('admin')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get('courses')
  listCourses(@Query() query: ListCoursesQueryDto) {
    return this.courses.listCourses(query);
  }

  @Post('courses')
  createCourse(@Body() dto: CreateCourseDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.courses.createCourse(dto, user, requestMeta(req));
  }

  @Patch('courses/:id')
  updateCourse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCourseDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.courses.updateCourse(id, dto, user, requestMeta(req));
  }

  @Get('offerings')
  listOfferings(@Query() query: ListOfferingsQueryDto) {
    return this.courses.listOfferings(query);
  }

  @Post('offerings')
  createOffering(
    @Body() dto: CreateOfferingDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.courses.createOffering(dto, user, requestMeta(req));
  }

  @Get('offerings/:id')
  getOffering(@Param('id', ParseUUIDPipe) id: string) {
    return this.courses.getOffering(id);
  }

  @Patch('offerings/:id')
  updateOffering(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOfferingDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.courses.updateOffering(id, dto, user, requestMeta(req));
  }
}
