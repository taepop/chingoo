import { Module } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { PrismaModule } from '../prisma/prisma.module';import { VectorModule } from '../vector/vector.module';

/**
 * Memory Module
 * 
 * Provides memory extraction, surfacing, and correction handling
 * per AI_PIPELINE.md §12 (Stage H - Memory Extraction, Dedup, Correction).
 * 
 * Q11: Memory MVP implementation with heuristic extraction only.
 * No LLM calls for determinism requirement.
 * 
 * Integrates VectorModule for semantic search per AI_PIPELINE.md §13.
 */
@Module({
  imports: [PrismaModule, VectorModule],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
