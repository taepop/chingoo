import { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { api, ApiError } from '../../src/api/api';
import { tokenStorage } from '../../src/storage/token-storage';
import { UserState } from '@chingoo/shared';

/**
 * Login Screen
 * Route: /(auth)/login
 * 
 * Per API_CONTRACT.md: POST /auth/login (or Signup)
 * Per SPEC_PATCH.md: /auth/signup is NOT implemented as a separate endpoint in v0.1.
 */
export default function LoginScreen() {
  const router = useRouter();
  const [identityToken, setIdentityToken] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!identityToken.trim()) {
      Alert.alert('Error', 'Please enter an identity token');
      return;
    }

    setLoading(true);
    try {
      // Step 1: Call POST /auth/login with AuthRequestDto { identity_token }
      const authResponse = await api.login(identityToken);

      // Step 2: Persist access_token from AuthResponseDto
      await tokenStorage.saveToken(authResponse.access_token);

      // Step 3: Call GET /user/me to verify token and get current user state
      const userProfile = await api.getMe(authResponse.access_token);

      // Step 4: Navigate based on UserProfileResponseDto.state
      if (userProfile.state === UserState.CREATED || userProfile.state === UserState.ONBOARDING) {
        router.replace('/(onboarding)');
      } else if (userProfile.state === UserState.ACTIVE) {
        router.replace('/(chat)');
      }
    } catch (error) {
      if (error instanceof ApiError) {
        Alert.alert('Login Failed', error.message);
      } else {
        Alert.alert('Error', 'An unexpected error occurred');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Login</Text>
      <Text style={styles.subtitle}>
        Enter your Cognito identity token{'\n'}
        (Dev mode: any token string works with AUTH_DEV_BYPASS=true)
      </Text>
      
      <TextInput
        style={styles.input}
        placeholder="Identity Token"
        value={identityToken}
        onChangeText={setIdentityToken}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />

      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handleLogin}
        disabled={loading}
      >
        <Text style={styles.buttonText}>
          {loading ? 'Logging in...' : 'Login'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginBottom: 24,
  },
  input: {
    width: '100%',
    height: 50,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 16,
    marginBottom: 16,
    fontSize: 16,
  },
  button: {
    width: '100%',
    height: 50,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#ccc',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
