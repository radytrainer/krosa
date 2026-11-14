import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller.js';
import { MonitoringService } from './monitoring.service.js';
import { SubjectStudentsService } from './subject-students.service.js';

@Module({
  controllers: [MonitoringController],
  providers: [MonitoringService, SubjectStudentsService],
  exports: [SubjectStudentsService],
})
export class MonitoringModule {}
