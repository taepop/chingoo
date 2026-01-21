import { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter, Link } from 'expo-router';
import { api, ApiError } from '../../src/api/api';
import { tokenStorage } from '../../src/storage/token-storage';
import { UserState } from '@chingoo/shared';

/**
 * Login Screen
 * Route: /(auth)/login
 * 
 * Authenticates user with email and password.
 * On success, navigates to onboarding or chat based on user state.
 */
export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const handleLogin = async () => {
    // Basic validation
    if (!email.trim()) {
      setError('Please enter your email');
      return;
    }
    if (!password) {
      setError('Please enter your password');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Step 1: Call POST /auth/login with email + password
      const authResponse = await api.login(email.trim(), password);

      // Step 2: Persist access_token
      await tokenStorage.saveToken(authResponse.access_token);

      // Step 3: Navigate based on user state
      if (authResponse.state === UserState.CREATED || authResponse.state === UserState.ONBOARDING) {
        router.replace('/(onboarding)');
      } else if (authResponse.state === UserState.ACTIVE) {
        router.replace('/(chat)');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.logo}>친구</Text>
          <Text style={styles.appName}>Chingoo</Text>
          <Text style={styles.tagline}>Your AI friend, always here for you</Text>
        </View>

        {/* Form */}
        <View style={styles.form}>
          <Text style={styles.title}>Go talk with your friend!</Text>
          <Text style={styles.subtitle}>Sign in to continue</Text>

          {/* Error display */}
          {error && (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {/* Email input */}
          <View style={styles.inputContainer}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor="#787774"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              editable={!loading}
            />
          </View>

          {/* Password input */}
          <View style={styles.inputContainer}>
            <Text style={styles.label}>Password</Text>
            <View style={styles.passwordContainer}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Enter your password"
                placeholderTextColor="#787774"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                textContentType="password"
                autoComplete="password"
                editable={!loading}
              />
              <TouchableOpacity
                style={styles.showPasswordButton}
                onPress={() => setShowPassword(!showPassword)}
              >
                <Text style={styles.showPasswordText}>
                  {showPassword ? 'Hide' : 'Show'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Forgot password link */}
          <TouchableOpacity style={styles.forgotPassword}>
            <Text style={styles.forgotPasswordText}>Forgot password?</Text>
          </TouchableOpacity>

          {/* Sign in button */}
          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Sign In</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Sign up link */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Don't have an account? </Text>
          <Link href="/(auth)/signup" asChild>
            <TouchableOpacity>
              <Text style={styles.linkText}>Sign Up</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </ScrollView>
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
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: NotionTheme.spacing.padding,
  },
  header: {
    alignItems: 'center',
    marginBottom: 40,
  },
  logo: {
    fontSize: 56,
    marginBottom: 8,
  },
  appName: {
    fontSize: 32,
    fontWeight: '600',
    color: NotionTheme.colors.textPrimary,
    letterSpacing: -0.5,
  },
  tagline: {
    fontSize: NotionTheme.typography.fontSizeBody,
    color: NotionTheme.colors.textSecondary,
    marginTop: 8,
  },
  form: {
    backgroundColor: NotionTheme.colors.background,
    borderRadius: NotionTheme.spacing.borderRadius,
    borderWidth: 1,
    borderColor: NotionTheme.colors.border,
    padding: 24,
  },
  title: {
    fontSize: NotionTheme.typography.fontSizeHeading,
    fontWeight: '600',
    color: NotionTheme.colors.textPrimary,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: NotionTheme.typography.fontSizeBody,
    color: NotionTheme.colors.textSecondary,
    marginBottom: 24,
  },
  errorContainer: {
    backgroundColor: NotionTheme.colors.backgroundMuted,
    borderWidth: 1,
    borderColor: NotionTheme.colors.error,
    borderRadius: NotionTheme.spacing.borderRadius,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    color: NotionTheme.colors.error,
    fontSize: 14,
    textAlign: 'center',
  },
  inputContainer: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: NotionTheme.colors.textSecondary,
    marginBottom: 8,
  },
  input: {
    backgroundColor: NotionTheme.colors.background,
    borderWidth: 1,
    borderColor: NotionTheme.colors.border,
    borderRadius: NotionTheme.spacing.borderRadius,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: NotionTheme.typography.fontSizeBody,
    color: NotionTheme.colors.textPrimary,
  },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: NotionTheme.colors.background,
    borderWidth: 1,
    borderColor: NotionTheme.colors.border,
    borderRadius: NotionTheme.spacing.borderRadius,
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: NotionTheme.typography.fontSizeBody,
    color: NotionTheme.colors.textPrimary,
  },
  showPasswordButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  showPasswordText: {
    color: NotionTheme.colors.textSecondary,
    fontSize: 14,
    fontWeight: '500',
  },
  forgotPassword: {
    alignSelf: 'flex-end',
    marginBottom: 24,
  },
  forgotPasswordText: {
    color: NotionTheme.colors.link,
    fontSize: 14,
  },
  button: {
    backgroundColor: NotionTheme.colors.accent,
    borderRadius: NotionTheme.spacing.borderRadius,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    backgroundColor: NotionTheme.colors.textSecondary,
    opacity: 0.6,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: NotionTheme.typography.fontSizeBody,
    fontWeight: '500',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 32,
  },
  footerText: {
    color: NotionTheme.colors.textSecondary,
    fontSize: 15,
  },
  linkText: {
    color: NotionTheme.colors.link,
    fontSize: 15,
    fontWeight: '500',
  },
});
