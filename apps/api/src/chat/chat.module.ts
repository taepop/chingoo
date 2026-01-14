import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TraceModule } from '../trace/trace.module';

/**
 * Chat Module
 * 
 * Endpoints per API_CONTRACT.md:
 * - POST /chat/send
 * - GET /chat/history
 */
@Module({
  imports: [PrismaModule, TraceModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
