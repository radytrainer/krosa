import { Module } from '@nestjs/common';
import { ResultsService } from './results.service.js';
import { StudentResultsController } from './student-results.controller.js';

@Module({
  controllers: [StudentResultsController],
  providers: [ResultsService],
  exports: [ResultsService],
})
export class ResultsModule {}
