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

/**
 * Count words in a string
 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Split text into sentences for staggered display.
 * Handles common sentence endings (. ! ?) while preserving edge cases.
 * Merges short sentences (2 words or less) with the next sentence for natural feel.
 */
function splitIntoSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by space or end of string
  // This regex captures sentences ending with . ! or ?
  const rawSentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  
  // If no sentences found (no punctuation), return the whole text as one
  if (rawSentences.length === 0) return [text];
  
  // Merge short sentences (2 words or less) with the next sentence
  const mergedSentences: string[] = [];
  let buffer = '';
  
  for (let i = 0; i < rawSentences.length; i++) {
    const sentence = rawSentences[i];
    const wordCount = countWords(sentence);
    
    if (wordCount <= 2) {
      // Short sentence - add to buffer to merge with next
      buffer = buffer ? `${buffer} ${sentence}` : sentence;
    } else {
      // Long enough sentence (3+ words)
      if (buffer) {
        // Merge buffer with this sentence
        mergedSentences.push(`${buffer} ${sentence}`);
        buffer = '';
      } else {
        mergedSentences.push(sentence);
      }
    }
  }
  
  // Handle remaining buffer (if last sentences were all short)
  if (buffer) {
    if (mergedSentences.length > 0) {
      // Append to last sentence
      mergedSentences[mergedSentences.length - 1] += ` ${buffer}`;
    } else {
      // All sentences were short, just return as one
      mergedSentences.push(buffer);
    }
  }
  
  return mergedSentences.length > 0 ? mergedSentences : [text];
}

/**
 * Returns a random delay between 2000ms and 3000ms
 */
function getRandomDelay(): number {
  return 2000 + Math.random() * 1000;
}

/**
 * Async sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const isMountedRef = useRef(true);

  // State
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initLoading, setInitLoading] = useState(true);
  const [isTyping, setIsTyping] = useState(false); // Shows "typing" indicator

  // Idempotency testing state
  const [lastSent, setLastSent] = useState<LastSentPayload | null>(null);
  const [replayStatus, setReplayStatus] = useState<string | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Fetch conversation_id on mount via GET /user/me, then load chat history
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

        // Load chat history
        try {
          const historyResponse = await api.getHistory(
            token,
            userProfile.conversation_id,
            undefined, // no before_timestamp - get most recent
            50, // limit
          );

          if (historyResponse.messages && historyResponse.messages.length > 0) {
            // Transform history: split assistant messages into sentence bubbles
            const transformedMessages: Message[] = [];
            
            for (const msg of historyResponse.messages) {
              if (msg.role === 'assistant') {
                // Split assistant messages into sentences (same as live display)
                const sentences = splitIntoSentences(msg.content);
                sentences.forEach((sentence, idx) => {
                  transformedMessages.push({
                    id: `${msg.id}-${idx}`,
                    role: 'assistant',
                    content: sentence,
                    created_at: msg.created_at,
                  });
                });
              } else {
                // Keep user messages as-is
                transformedMessages.push(msg);
              }
            }
            
            setMessages(transformedMessages);
            // Scroll to bottom after loading history
            setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: false }), 100);
          }
        } catch (historyErr) {
          // History loading failed, but we can still chat
          console.warn('Failed to load chat history:', historyErr);
        }
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

      // Split assistant response into sentences for staggered display
      const sentences = splitIntoSentences(response.assistant_message.content);
      
      // Show typing indicator while displaying sentences
      setIsTyping(true);
      
      // Add each sentence as a separate bubble with delay
      for (let i = 0; i < sentences.length; i++) {
        // Wait before showing each sentence (except the first one)
        if (i > 0) {
          await sleep(getRandomDelay());
        }
        
        // Check if component is still mounted
        if (!isMountedRef.current) break;
        
        const sentenceMsg: Message = {
          id: `${response.assistant_message.id}-${i}`,
          role: 'assistant',
          content: sentences[i],
          created_at: response.assistant_message.created_at,
        };
        
        setMessages((prev) => [...prev, sentenceMsg]);
        
        // Scroll to bottom after each sentence
        setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 100);
      }
      
      // Hide typing indicator
      if (isMountedRef.current) {
        setIsTyping(false);
      }
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
        {/* Typing indicator */}
        {isTyping && (
          <View style={[styles.messageBubble, styles.assistantBubble, styles.typingBubble]}>
            <Text style={styles.typingText}>...</Text>
          </View>
        )}
      </ScrollView>

      {/* Error display */}
      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
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

/**
 * Notion-inspired Design Tokens
 */
const NotionTheme = {
  colors: {
    background: '#FFFFFF',
    backgroundMuted: '#F7F7F5',
    textPrimary: '#37352F',
    textSecondary: '#787774',
    border: '#E9E9E7',
    accent: '#37352F',
    link: '#2EAADC',
    error: '#EB5757',
    success: '#6FCF97',
  },
  spacing: {
    borderRadius: 4,
    padding: 16,
  },
  typography: {
    fontSizeHeading: 24,
    fontSizeBody: 16,
  },
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: NotionTheme.colors.background,
  },
  centerContainer: {
    flex: 1,
    backgroundColor: NotionTheme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  header: {
    paddingTop: 50,
    paddingBottom: 12,
    paddingHorizontal: NotionTheme.spacing.padding,
    borderBottomWidth: 1,
    borderBottomColor: NotionTheme.colors.border,
    backgroundColor: NotionTheme.colors.background,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: NotionTheme.colors.textPrimary,
  },
  headerSubtitle: {
    fontSize: 12,
    color: NotionTheme.colors.textSecondary,
    marginTop: 2,
  },
  messagesContainer: {
    flex: 1,
    backgroundColor: NotionTheme.colors.backgroundMuted,
  },
  messagesContent: {
    padding: NotionTheme.spacing.padding,
    paddingBottom: 8,
  },
  emptyText: {
    textAlign: 'center',
    color: NotionTheme.colors.textSecondary,
    marginTop: 40,
    fontSize: NotionTheme.typography.fontSizeBody,
  },
  messageBubble: {
    maxWidth: '80%',
    padding: 12,
    borderRadius: NotionTheme.spacing.borderRadius,
    marginBottom: 8,
  },
  userBubble: {
    backgroundColor: NotionTheme.colors.accent,
    alignSelf: 'flex-end',
  },
  assistantBubble: {
    backgroundColor: NotionTheme.colors.background,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: NotionTheme.colors.border,
  },
  messageText: {
    fontSize: NotionTheme.typography.fontSizeBody,
    lineHeight: 22,
  },
  userText: {
    color: '#FFFFFF',
  },
  assistantText: {
    color: NotionTheme.colors.textPrimary,
  },
  typingBubble: {
    paddingHorizontal: 16,
  },
  typingText: {
    color: NotionTheme.colors.textSecondary,
    fontSize: 20,
    letterSpacing: 2,
  },
  debugContainer: {
    backgroundColor: NotionTheme.colors.backgroundMuted,
    padding: 8,
    marginHorizontal: NotionTheme.spacing.padding,
    borderRadius: NotionTheme.spacing.borderRadius,
    borderWidth: 1,
    borderColor: NotionTheme.colors.border,
  },
  debugText: {
    fontSize: 10,
    color: NotionTheme.colors.textSecondary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  errorContainer: {
    backgroundColor: NotionTheme.colors.backgroundMuted,
    padding: 8,
    marginHorizontal: NotionTheme.spacing.padding,
    borderRadius: NotionTheme.spacing.borderRadius,
    borderWidth: 1,
    borderColor: NotionTheme.colors.error,
  },
  errorText: {
    color: NotionTheme.colors.error,
    fontSize: 14,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: NotionTheme.colors.error,
    marginBottom: 8,
  },
  replayContainer: {
    backgroundColor: NotionTheme.colors.backgroundMuted,
    padding: 8,
    marginHorizontal: NotionTheme.spacing.padding,
    borderRadius: NotionTheme.spacing.borderRadius,
    marginTop: 4,
    borderWidth: 1,
    borderColor: NotionTheme.colors.success,
  },
  replayText: {
    color: NotionTheme.colors.success,
    fontSize: 12,
  },
  resendButton: {
    backgroundColor: NotionTheme.colors.backgroundMuted,
    padding: 8,
    marginHorizontal: NotionTheme.spacing.padding,
    marginTop: 8,
    borderRadius: NotionTheme.spacing.borderRadius,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: NotionTheme.colors.border,
  },
  resendButtonText: {
    color: NotionTheme.colors.textSecondary,
    fontSize: 12,
  },
  retryButton: {
    backgroundColor: NotionTheme.colors.accent,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: NotionTheme.spacing.borderRadius,
    marginTop: 16,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: NotionTheme.colors.border,
    alignItems: 'flex-end',
    backgroundColor: NotionTheme.colors.background,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: NotionTheme.colors.border,
    borderRadius: NotionTheme.spacing.borderRadius,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: NotionTheme.typography.fontSizeBody,
    marginRight: 8,
    color: NotionTheme.colors.textPrimary,
    backgroundColor: NotionTheme.colors.background,
  },
  sendButton: {
    backgroundColor: NotionTheme.colors.accent,
    width: 60,
    height: 40,
    borderRadius: NotionTheme.spacing.borderRadius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: NotionTheme.colors.border,
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontWeight: '500',
  },
  loadingText: {
    fontSize: NotionTheme.typography.fontSizeBody,
    color: NotionTheme.colors.textSecondary,
  },
});
