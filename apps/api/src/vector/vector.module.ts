import { Module } from '@nestjs/common';
import { VectorService } from './vector.service';

/**
 * VectorModule
 * 
 * Provides semantic vector search capabilities using Qdrant.
 * Per AI_PIPELINE.md §13 - Vector Retrieval (Qdrant) - Gated
 * 
 * Exports VectorService for use by MemoryService and ChatService.
 */
@Module({
  providers: [VectorService],
  exports: [VectorService],
})
export class VectorModule {}
