import { Module } from '@nestjs/common';
import { SyncQueueService } from './sync-queue.service.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

@Module({
  controllers: [SyncController],
  providers: [SyncQueueService, SyncService],
  exports: [SyncQueueService],
})
export class SyncModule {}
