import { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { api, ApiError } from '../../src/api/api';
import { tokenStorage } from '../../src/storage/token-storage';
import { ChatRequestDto, ChatResponseDto } from '@chingoo/shared';

/**
 * Chat Screen
 * Route: /(chat)/index
 *
 * Per API_CONTRACT.md: POST /chat/send
 * Idempotency per SPEC_INDEX.md §5:
 * - COMPLETED replay returns same assistant reply (200)
 * - RECEIVED/PROCESSING returns 409 with deterministic in-progress message
 */

/**
 * Generate UUID v4 without external dependencies.
 * Uses crypto.randomUUID() if available, else fallback implementation.
 */
function generateUUID(): string {
  // Try native crypto.randomUUID() first (available in modern environments)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: manual UUID v4 implementation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

interface LastSentPayload {
  message_id: string;
  conversation_id: string;
  user_message: string;
  local_timestamp: string;
  user_timezone: string;
  response?: ChatResponseDto;
}

export default function ChatScreen() {
  const router = useRouter();
  const scrollViewRef = useRef<ScrollView>(null);

  // State
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initLoading, setInitLoading] = useState(true);

  // Idempotency testing state
  const [lastSent, setLastSent] = useState<LastSentPayload | null>(null);
  const [replayStatus, setReplayStatus] = useState<string | null>(null);

  // Fetch conversation_id on mount via GET /user/me
  useEffect(() => {
    const init = async () => {
      try {
        const token = await tokenStorage.getToken();
        if (!token) {
          setError('Not authenticated. Please login again.');
          router.replace('/(auth)/login');
          return;
        }

        // GET /user/me to retrieve conversation_id
        const userProfile = await api.getMe(token);

        if (!userProfile.conversation_id) {
          setError('conversation_id is missing. Please complete onboarding first.');
          return;
        }

        setConversationId(userProfile.conversation_id);
      } catch (err) {
        if (err instanceof ApiError) {
          setError(`Failed to load: ${err.message}`);
        } else {
          setError('An unexpected error occurred');
        }
      } finally {
        setInitLoading(false);
      }
    };

    init();
  }, [router]);

  const handleSend = async () => {
    if (!inputText.trim() || !conversationId) return;

    const userMessage = inputText.trim();
    setInputText('');
    setLoading(true);
    setError(null);
    setReplayStatus(null);

    try {
      const token = await tokenStorage.getToken();
      if (!token) {
        setError('Not authenticated');
        return;
      }

      // Build ChatRequestDto with EXACT fields from API_CONTRACT.md
      const request: ChatRequestDto = {
        message_id: generateUUID(),
        conversation_id: conversationId,
        user_message: userMessage,
        local_timestamp: new Date().toISOString(),
        user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
      };

      // Add user message to UI
      const userMsg: Message = {
        id: request.message_id,
        role: 'user',
        content: userMessage,
        created_at: request.local_timestamp,
      };
      setMessages((prev) => [...prev, userMsg]);

      // Call POST /chat/send
      const response = await api.sendMessage(token, request);

      // Save for replay testing
      setLastSent({ ...request, response });

      // Add assistant message to UI
      const assistantMsg: Message = {
        id: response.assistant_message.id,
        role: 'assistant',
        content: response.assistant_message.content,
        created_at: response.assistant_message.created_at,
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // Scroll to bottom
      setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 409) {
          // In-progress per idempotency semantics
          setError('Message is being processed. Please wait.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Failed to send message');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!lastSent) return;

    setLoading(true);
    setError(null);
    setReplayStatus(null);

    try {
      const token = await tokenStorage.getToken();
      if (!token) {
        setError('Not authenticated');
        return;
      }

      // Re-send EXACT same payload (same message_id)
      const request: ChatRequestDto = {
        message_id: lastSent.message_id,
        conversation_id: lastSent.conversation_id,
        user_message: lastSent.user_message,
        local_timestamp: lastSent.local_timestamp,
        user_timezone: lastSent.user_timezone,
      };

      const response = await api.sendMessage(token, request);

      // Compare with previous response for idempotency verification
      if (lastSent.response) {
        const prevAssistant = lastSent.response.assistant_message;
        const currAssistant = response.assistant_message;

        if (
          prevAssistant.id === currAssistant.id &&
          prevAssistant.content === currAssistant.content
        ) {
          setReplayStatus('Replay OK - identical response');
        } else {
          setReplayStatus(
            `Replay mismatch! prev_id=${prevAssistant.id}, curr_id=${currAssistant.id}`,
          );
        }
      } else {
        setReplayStatus('Replay completed (no previous response to compare)');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 409) {
          // In-progress per idempotency semantics
          setReplayStatus('In progress - message still processing (409)');
        } else {
          setError(err.message);
        }
      } else {
        setError('Failed to resend message');
      }
    } finally {
      setLoading(false);
    }
  };

  // Loading state
  if (initLoading) {
    return (
      <View style={styles.centerContainer}>
        <StatusBar style="auto" />
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  // Error state (no conversation_id)
  if (!conversationId) {
    return (
      <View style={styles.centerContainer}>
        <StatusBar style="auto" />
        <Text style={styles.errorTitle}>Error</Text>
        <Text style={styles.errorText}>{error || 'conversation_id unavailable'}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => router.replace('/(onboarding)')}
        >
          <Text style={styles.retryButtonText}>Go to Onboarding</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      <StatusBar style="auto" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Chat</Text>
        <Text style={styles.headerSubtitle}>conv: {conversationId.slice(0, 8)}...</Text>
      </View>

      {/* Messages */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.messagesContainer}
        contentContainerStyle={styles.messagesContent}
      >
        {messages.length === 0 && (
          <Text style={styles.emptyText}>Send a message to start chatting!</Text>
        )}
        {messages.map((msg) => (
          <View
            key={msg.id}
            style={[
              styles.messageBubble,
              msg.role === 'user' ? styles.userBubble : styles.assistantBubble,
            ]}
          >
            <Text
              style={[
                styles.messageText,
                msg.role === 'user' ? styles.userText : styles.assistantText,
              ]}
            >
              {msg.content}
            </Text>
          </View>
        ))}
      </ScrollView>

      {/* Debug: surfaced_memory_ids display */}
      {lastSent?.response && (
        <View style={styles.debugContainer}>
          <Text style={styles.debugText}>
            surfaced_memory_ids:{' '}
            {(lastSent.response as any).surfaced_memory_ids
              ? JSON.stringify((lastSent.response as any).surfaced_memory_ids)
              : '(not present in response)'}
          </Text>
        </View>
      )}

      {/* Error display */}
      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Replay status */}
      {replayStatus && (
        <View style={styles.replayContainer}>
          <Text style={styles.replayText}>{replayStatus}</Text>
        </View>
      )}

      {/* Resend button for idempotency testing */}
      {lastSent && (
        <TouchableOpacity
          style={styles.resendButton}
          onPress={handleResend}
          disabled={loading}
        >
          <Text style={styles.resendButtonText}>
            Resend last message_id ({lastSent.message_id.slice(0, 8)}...)
          </Text>
        </TouchableOpacity>
      )}

      {/* Input */}
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          placeholder="Type a message..."
          value={inputText}
          onChangeText={setInputText}
          multiline
          maxLength={4000}
          editable={!loading}
        />
        <TouchableOpacity
          style={[styles.sendButton, loading && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={loading || !inputText.trim()}
        >
          <Text style={styles.sendButtonText}>{loading ? '...' : 'Send'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  centerContainer: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  header: {
    paddingTop: 50,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#999',
    marginTop: 2,
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    padding: 16,
    paddingBottom: 8,
  },
  emptyText: {
    textAlign: 'center',
    color: '#999',
    marginTop: 40,
  },
  messageBubble: {
    maxWidth: '80%',
    padding: 12,
    borderRadius: 16,
    marginBottom: 8,
  },
  userBubble: {
    backgroundColor: '#007AFF',
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: '#F0F0F0',
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  userText: {
    color: '#fff',
  },
  assistantText: {
    color: '#333',
  },
  debugContainer: {
    backgroundColor: '#F5F5F5',
    padding: 8,
    marginHorizontal: 16,
    borderRadius: 4,
  },
  debugText: {
    fontSize: 10,
    color: '#666',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  errorContainer: {
    backgroundColor: '#FFEBEE',
    padding: 8,
    marginHorizontal: 16,
    borderRadius: 4,
  },
  errorText: {
    color: '#C62828',
    fontSize: 14,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#C62828',
    marginBottom: 8,
  },
  replayContainer: {
    backgroundColor: '#E8F5E9',
    padding: 8,
    marginHorizontal: 16,
    borderRadius: 4,
    marginTop: 4,
  },
  replayText: {
    color: '#2E7D32',
    fontSize: 12,
  },
  resendButton: {
    backgroundColor: '#FFF3E0',
    padding: 8,
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 4,
    alignItems: 'center',
  },
  resendButtonText: {
    color: '#E65100',
    fontSize: 12,
  },
  retryButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 16,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    marginRight: 8,
  },
  sendButton: {
    backgroundColor: '#007AFF',
    width: 60,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#ccc',
  },
  sendButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  loadingText: {
    fontSize: 16,
    color: '#666',
  },
});
