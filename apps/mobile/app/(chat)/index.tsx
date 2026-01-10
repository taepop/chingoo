import { View, Text, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';

/**
 * Chat Screen
 * Route: /(chat)/index
 * 
 * Per API_CONTRACT.md: POST /chat/send, GET /chat/history
 */

// Import from @chingoo/shared to verify monorepo resolution
// This will be used when DTOs are implemented
// import { ChatRequestDto, ChatResponseDto } from '@chingoo/shared';

// Verify @chingoo/shared import works (even if just importing the package)
import '@chingoo/shared';

export default function ChatScreen() {
  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Chat</Text>
      <Text style={styles.subtitle}>Chat screen - not yet implemented</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
  },
});
