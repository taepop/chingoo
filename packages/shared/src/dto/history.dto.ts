// History DTOs (packages/shared/src/dto/history.dto.ts)
// Endpoint: GET /chat/history
// Per API_CONTRACT.md §5

export interface GetHistoryRequestDto {
  conversation_id: string;
  /**
   * Pagination: fetch messages older than this date.
   */
  before_timestamp?: string;
  limit?: number; // Default 20
}

export interface HistoryResponseDto {
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
  }>;
}
