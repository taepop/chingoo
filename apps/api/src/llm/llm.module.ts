import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';

/**
 * LLM Module
 * 
 * Per ARCHITECTURE.md folder structure:
 * apps/api/src/llm/
 *   - llm.module.ts
 *   - llm.service.ts
 * 
 * Provides LLM gateway for generating assistant responses.
 * Per AI_PIPELINE.md §7.1: "LLM call" step in orchestrator recipe.
 */
@Module({
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
