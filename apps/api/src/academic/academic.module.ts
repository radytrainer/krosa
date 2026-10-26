import { Global, Module } from '@nestjs/common';
import { AcademicGuardService } from './academic-guard.service.js';

@Global()
@Module({
  providers: [AcademicGuardService],
  exports: [AcademicGuardService],
})
export class AcademicModule {}
