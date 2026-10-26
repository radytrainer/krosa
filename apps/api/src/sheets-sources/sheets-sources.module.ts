import { Module } from '@nestjs/common';
import { sheetsReaderProvider, SHEETS_READER } from './sheets-reader.provider.js';
import { SheetsSourcesController } from './sheets-sources.controller.js';
import { SheetsSourcesService } from './sheets-sources.service.js';

@Module({
  controllers: [SheetsSourcesController],
  providers: [sheetsReaderProvider, SheetsSourcesService],
  exports: [SHEETS_READER, SheetsSourcesService],
})
export class SheetsSourcesModule {}
