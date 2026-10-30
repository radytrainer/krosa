import { Module } from '@nestjs/common';
import { SheetsSourcesModule } from '../sheets-sources/sheets-sources.module.js';
import { SheetMappingsController } from './sheet-mappings.controller.js';
import { SheetMappingsService } from './sheet-mappings.service.js';

@Module({
  imports: [SheetsSourcesModule],
  controllers: [SheetMappingsController],
  providers: [SheetMappingsService],
})
export class SheetMappingsModule {}
