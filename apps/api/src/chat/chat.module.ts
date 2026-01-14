import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TraceModule } from '../trace/trace.module';
import { RouterModule } from '../router/router.module';
import { TopicMatchModule } from '../topicmatch/topicmatch.module';

/**
 * Chat Module
 * 
 * Endpoints per API_CONTRACT.md:
 * - POST /chat/send
 * - GET /chat/history
 * 
 * Q10: Integrates Router + TopicMatch for deterministic routing decisions.
 */
@Module({
  imports: [PrismaModule, TraceModule, RouterModule, TopicMatchModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
