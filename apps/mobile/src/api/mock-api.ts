/**
 * Mock API Module
 * 
 * [MINIMAL DEVIATION] Mock API responses for development when API is not fully implemented.
 * This is isolated to this module and controlled by USE_MOCK_API environment variable (default OFF).
 * 
 * Scope: Only used when USE_MOCK_API=true. Does not affect production code paths.
 * Reason: Allows mobile app to boot and screens to render before API is fully implemented.
 */

const USE_MOCK_API = process.env.EXPO_PUBLIC_USE_MOCK_API === 'true';

/**
 * Mock API client that returns placeholder responses
 * Only active when USE_MOCK_API is enabled
 */
export const mockApi = {
  async login(identityToken: string, email?: string) {
    if (!USE_MOCK_API) {
      throw new Error('Mock API is disabled. Set EXPO_PUBLIC_USE_MOCK_API=true to enable.');
    }
    return {
      access_token: 'mock-token',
      user_id: 'mock-user-id',
      state: 'CREATED' as const,
    };
  },

  async onboarding(data: any) {
    if (!USE_MOCK_API) {
      throw new Error('Mock API is disabled. Set EXPO_PUBLIC_USE_MOCK_API=true to enable.');
    }
    return {
      user_id: 'mock-user-id',
      state: 'ONBOARDING' as const,
      conversation_id: 'mock-conversation-id',
      updated_at: new Date().toISOString(),
    };
  },

  async getMe() {
    if (!USE_MOCK_API) {
      throw new Error('Mock API is disabled. Set EXPO_PUBLIC_USE_MOCK_API=true to enable.');
    }
    return {
      user_id: 'mock-user-id',
      preferred_name: 'Mock User',
      state: 'ACTIVE' as const,
      conversation_id: 'mock-conversation-id',
    };
  },

  async sendMessage(data: any) {
    if (!USE_MOCK_API) {
      throw new Error('Mock API is disabled. Set EXPO_PUBLIC_USE_MOCK_API=true to enable.');
    }
    return {
      message_id: data.message_id,
      user_state: 'ACTIVE' as const,
      assistant_message: {
        id: 'mock-assistant-message-id',
        content: 'Mock assistant response',
        created_at: new Date().toISOString(),
      },
    };
  },

  async getHistory(conversationId: string) {
    if (!USE_MOCK_API) {
      throw new Error('Mock API is disabled. Set EXPO_PUBLIC_USE_MOCK_API=true to enable.');
    }
    return {
      messages: [],
    };
  },
};
