import { Module } from '@nestjs/common';
import { RouterService } from './router.service';
import { TopicMatchModule } from '../topicmatch/topicmatch.module';

/**
 * RouterModule
 * 
 * Per ARCHITECTURE.md §B:
 * Location: apps/api/src/router/
 * 
 * Imports: TopicMatchModule
 * Exports: RouterService for use by orchestrator
 * 
 * Per ARCHITECTURE.md §E.1:
 * Router may import from: topicmatch, safety, shared
 */
@Module({
  imports: [TopicMatchModule],
  providers: [RouterService],
  exports: [RouterService],
})
export class RouterModule {}
