import { Module } from '@nestjs/common';
import { PostProcessorService } from './postprocessor.service';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * PostProcessor module
 * 
 * Provides post-processing enforcement for assistant messages
 * per AI_PIPELINE.md §10 (Stage F — Post-Processing & Quality Gates)
 */
@Module({
  imports: [PrismaModule],
  providers: [PostProcessorService],
  exports: [PostProcessorService],
})
export class PostProcessorModule {}
