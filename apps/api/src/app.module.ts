import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AcademicModule } from './academic/academic.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { buildLoggerParams } from './common/logger.js';
import type { ApiEnv } from './config/env.js';
import { EnvModule } from './config/env.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { GenerationsModule } from './generations/generations.module.js';
import { HealthModule } from './health/health.module.js';
import { InfraModule } from './infra/infra.module.js';
import { ResultsModule } from './results/results.module.js';
import { SheetMappingsModule } from './sheet-mappings/sheet-mappings.module.js';
import { SheetsSourcesModule } from './sheets-sources/sheets-sources.module.js';
import { SyncModule } from './sync/sync.module.js';
import { StudentsModule } from './students/students.module.js';

@Module({})
export class AppModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.forRoot(env),
        LoggerModule.forRoot(buildLoggerParams(env)),
        InfraModule,
        AuditModule,
        AuthModule,
        AcademicModule,
        HealthModule,
        GenerationsModule,
        StudentsModule,
        ResultsModule,
        SheetsSourcesModule,
        SheetMappingsModule,
        SyncModule,
        DashboardModule,
      ],
    };
  }
}
