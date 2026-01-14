import { Module } from '@nestjs/common';
import { TopicMatchService } from './topicmatch.service';

/**
 * TopicMatchModule
 * 
 * Per ARCHITECTURE.md §B:
 * Location: apps/api/src/topicmatch/
 * 
 * Exports TopicMatchService for use by:
 * - router (topic classification for routing)
 * - orchestrator (topic context)
 * - postprocessor (taboo topic enforcement)
 * - retention (sensitive topic detection)
 */
@Module({
  providers: [TopicMatchService],
  exports: [TopicMatchService],
})
export class TopicMatchModule {}
