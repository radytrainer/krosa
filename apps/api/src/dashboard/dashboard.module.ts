import { Module } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module.js';
import { DashboardController } from './dashboard.controller.js';

@Module({
  imports: [SyncModule],
  controllers: [DashboardController],
})
export class DashboardModule {}
