import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { ResultsModule } from '../results/results.module.js';
import { StudentsController } from './students.controller.js';
import { StudentsService } from './students.service.js';

@Module({
  imports: [ResultsModule, AcademicModule],
  controllers: [StudentsController],
  providers: [StudentsService],
  exports: [StudentsService],
})
export class StudentsModule {}
