import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import {
  ChatRequestDto,
  ChatResponseDto,
  UserState,
} from '@chingoo/shared';

/**
 * Chat Controller
 * 
 * Per API_CONTRACT.md §3:
 * - POST /chat/send
 * - GET /chat/history
 */
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /**
   * POST /chat/send
   * 
   * Per API_CONTRACT.md §3 and SPEC_PATCH.md:
   * - Idempotency by message_id
   * - ONBOARDING → ACTIVE atomic transition (AI_PIPELINE.md §4.1.2)
   * - INSERT new assistant message row (SPEC_PATCH override)
   * - Returns ChatResponseDto { message_id, user_state, assistant_message: { id, content, created_at } }
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  async sendMessage(
    @Body() body: ChatRequestDto,
    @Req() req: any,
  ): Promise<ChatResponseDto> {
    // Extract user info from JWT (set by JwtAuthGuard via JwtStrategy.validate)
    const userId: string = req.user.userId;
    const userState: UserState = req.user.state;

    return this.chatService.sendMessage(userId, userState, body);
  }

  /**
   * GET /chat/history
   * 
   * Per API_CONTRACT.md §5 (GET /chat/history):
   * Returns HistoryResponseDto with paginated messages.
   * 
   * TODO: Implement with GetHistoryRequestDto validation
   */
  @Get('history')
  async getHistory(@Query() query: any) {
    // TODO: Implement GetHistoryRequestDto validation and HistoryResponseDto response
    return { message: 'Get history endpoint - not yet implemented' };
  }
}
