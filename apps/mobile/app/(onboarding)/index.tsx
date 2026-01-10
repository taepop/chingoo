import { View, Text, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';

/**
 * Onboarding Screen
 * Route: /(onboarding)/index
 * 
 * Per API_CONTRACT.md: POST /user/onboarding
 */

// Import from @chingoo/shared to verify monorepo resolution
// This will be used when DTOs are implemented
// import { OnboardingRequestDto, OnboardingResponseDto } from '@chingoo/shared';

export default function OnboardingScreen() {
  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Onboarding</Text>
      <Text style={styles.subtitle}>Onboarding screen - not yet implemented</Text>
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
