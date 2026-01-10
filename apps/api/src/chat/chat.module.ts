import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';

/**
 * Chat Module
 * Endpoints:
 * - POST /chat/send
 * - GET /chat/history
 */
@Module({
  controllers: [ChatController],
})
export class ChatModule {}
