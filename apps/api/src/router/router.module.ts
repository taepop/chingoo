import { Module } from '@nestjs/common';
import { RouterService } from './router.service';
import { SafetyClassifierService } from './safety-classifier';
import { TopicMatchModule } from '../topicmatch/topicmatch.module';

/**
 * RouterModule
 * 
 * Per ARCHITECTURE.md §B:
 * Location: apps/api/src/router/
 * 
 * Components:
 * - RouterService: Main routing logic per AI_PIPELINE.md §6
 * - SafetyClassifierService: Safety classification per AI_PIPELINE.md §6.2
 * 
 * Imports: TopicMatchModule
 * Exports: RouterService, SafetyClassifierService for use by orchestrator
 * 
 * Per ARCHITECTURE.md §E.1:
 * Router may import from: topicmatch, safety, shared
 */
@Module({
  imports: [TopicMatchModule],
  providers: [RouterService, SafetyClassifierService],
  exports: [RouterService, SafetyClassifierService],
})
export class RouterModule {}
