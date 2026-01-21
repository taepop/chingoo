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
 * Sign Up Screen
 * Route: /(auth)/signup
 * 
 * Creates a new user account with email and password.
 * On success, navigates to onboarding.
 */
export default function SignupScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [constraints, setConstraints] = useState<string[]>([]);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Password strength indicators
  const hasMinLength = password.length >= 8;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const passwordsMatch = password === confirmPassword && confirmPassword !== '';

  const handleSignup = async () => {
    // Client-side validation
    setError(null);
    setConstraints([]);

    if (!email.trim()) {
      setError('Please enter your email');
      return;
    }
    if (!password) {
      setError('Please enter a password');
      return;
    }
    if (!confirmPassword) {
      setError('Please confirm your password');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);

    try {
      // Call POST /auth/signup
      const authResponse = await api.signup(email.trim(), password, confirmPassword);

      // Persist access_token
      await tokenStorage.saveToken(authResponse.access_token);

      // Navigate to onboarding (new users always start here)
      router.replace('/(onboarding)');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.constraints) {
          setConstraints(err.constraints);
        }
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
          <Text style={styles.tagline}>Create your account</Text>
        </View>

        {/* Form */}
        <View style={styles.form}>
          <Text style={styles.title}>Get Started</Text>
          <Text style={styles.subtitle}>Join and find your AI friend</Text>

          {/* Error display */}
          {error && (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{error}</Text>
              {constraints.map((c, i) => (
                <Text key={i} style={styles.constraintText}>• {c}</Text>
              ))}
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
                placeholder="Create a password"
                placeholderTextColor="#787774"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                textContentType="newPassword"
                autoComplete="new-password"
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

            {/* Password strength indicators */}
            {password.length > 0 && (
              <View style={styles.strengthContainer}>
                <View style={styles.strengthItem}>
                  <View style={[styles.strengthDot, hasMinLength && styles.strengthDotValid]} />
                  <Text style={[styles.strengthText, hasMinLength && styles.strengthTextValid]}>
                    8+ characters
                  </Text>
                </View>
                <View style={styles.strengthItem}>
                  <View style={[styles.strengthDot, hasLetter && styles.strengthDotValid]} />
                  <Text style={[styles.strengthText, hasLetter && styles.strengthTextValid]}>
                    One letter
                  </Text>
                </View>
                <View style={styles.strengthItem}>
                  <View style={[styles.strengthDot, hasNumber && styles.strengthDotValid]} />
                  <Text style={[styles.strengthText, hasNumber && styles.strengthTextValid]}>
                    One number
                  </Text>
                </View>
              </View>
            )}
          </View>

          {/* Confirm password input */}
          <View style={styles.inputContainer}>
            <Text style={styles.label}>Confirm Password</Text>
            <View style={styles.passwordContainer}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Confirm your password"
                placeholderTextColor="#787774"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry={!showConfirmPassword}
                textContentType="newPassword"
                editable={!loading}
              />
              <TouchableOpacity
                style={styles.showPasswordButton}
                onPress={() => setShowConfirmPassword(!showConfirmPassword)}
              >
                <Text style={styles.showPasswordText}>
                  {showConfirmPassword ? 'Hide' : 'Show'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Password match indicator */}
            {confirmPassword.length > 0 && (
              <View style={styles.matchContainer}>
                <View style={[styles.strengthDot, passwordsMatch && styles.strengthDotValid]} />
                <Text style={[styles.strengthText, passwordsMatch && styles.strengthTextValid]}>
                  {passwordsMatch ? 'Passwords match' : 'Passwords do not match'}
                </Text>
              </View>
            )}
          </View>

          {/* Sign up button */}
          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleSignup}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Create Account</Text>
            )}
          </TouchableOpacity>

          {/* Terms notice */}
          <Text style={styles.termsText}>
            By signing up, you agree to our{' '}
            <Text style={styles.termsLink}>Terms of Service</Text> and{' '}
            <Text style={styles.termsLink}>Privacy Policy</Text>
          </Text>
        </View>

        {/* Sign in link */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have an account? </Text>
          <Link href="/(auth)/login" asChild>
            <TouchableOpacity>
              <Text style={styles.linkText}>Sign In</Text>
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
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: NotionTheme.spacing.padding,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  logo: {
    fontSize: 48,
    marginBottom: 4,
  },
  appName: {
    fontSize: 28,
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
  constraintText: {
    color: NotionTheme.colors.error,
    fontSize: 13,
    marginTop: 4,
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
  strengthContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
    gap: 12,
  },
  strengthItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  strengthDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: NotionTheme.colors.border,
    marginRight: 6,
  },
  strengthDotValid: {
    backgroundColor: NotionTheme.colors.success,
  },
  strengthText: {
    fontSize: 12,
    color: NotionTheme.colors.textSecondary,
  },
  strengthTextValid: {
    color: NotionTheme.colors.success,
  },
  matchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  button: {
    backgroundColor: NotionTheme.colors.accent,
    borderRadius: NotionTheme.spacing.borderRadius,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
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
  termsText: {
    fontSize: 12,
    color: NotionTheme.colors.textSecondary,
    textAlign: 'center',
    marginTop: 16,
    lineHeight: 18,
  },
  termsLink: {
    color: NotionTheme.colors.link,
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
