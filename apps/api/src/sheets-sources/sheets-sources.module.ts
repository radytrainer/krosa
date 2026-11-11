import { Module } from '@nestjs/common';
import { sheetsReaderProvider, SHEETS_READER } from './sheets-reader.provider.js';
import { SheetsSourcesController } from './sheets-sources.controller.js';
import { SheetsSourcesService } from './sheets-sources.service.js';
import { SourceReleaseService } from './source-release.service.js';

@Module({
  controllers: [SheetsSourcesController],
  providers: [sheetsReaderProvider, SheetsSourcesService, SourceReleaseService],
  exports: [SHEETS_READER, SheetsSourcesService],
})
export class SheetsSourcesModule {}
