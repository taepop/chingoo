import { Controller, Post, Get, Body, Query } from '@nestjs/common';

/**
 * Chat Controller
 * 
 * Per API_CONTRACT.md:
 * - POST /chat/send
 * - GET /chat/history
 * 
 * TODO: Implement all endpoints with idempotency handling
 */
@Controller('chat')
export class ChatController {
  @Post('send')
  async sendMessage(@Body() body: any) {
    // TODO: Implement ChatRequestDto validation and ChatResponseDto response
    // Per SPEC_PATCH.md: Idempotency replay semantics for message_id
    return { message: 'Send message endpoint - not yet implemented' };
  }

  @Get('history')
  async getHistory(@Query() query: any) {
    // TODO: Implement GetHistoryRequestDto validation and HistoryResponseDto response
    return { message: 'Get history endpoint - not yet implemented' };
  }
}
