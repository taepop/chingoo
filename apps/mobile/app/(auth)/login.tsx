import { View, Text, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';

/**
 * Login Screen
 * Route: /(auth)/login
 * 
 * Per API_CONTRACT.md: POST /auth/login (or Signup)
 * Per SPEC_PATCH.md: /auth/signup is NOT implemented as a separate endpoint in v0.1.
 */

// Import from @chingoo/shared to verify monorepo resolution
// This will be used when DTOs are implemented
// import { AuthRequestDto, AuthResponseDto } from '@chingoo/shared';

export default function LoginScreen() {
  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Login</Text>
      <Text style={styles.subtitle}>Auth screen - not yet implemented</Text>
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
