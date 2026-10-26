import { Module } from '@nestjs/common';
import { GradingSchemesController } from './grading-schemes.controller.js';
import { GradingSchemesService } from './grading-schemes.service.js';

@Module({
  controllers: [GradingSchemesController],
  providers: [GradingSchemesService],
  exports: [GradingSchemesService],
})
export class GradingSchemesModule {}
