import { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Switch,
  ScrollView,
  Alert,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { api, ApiError } from '../../src/api/api';
import { tokenStorage } from '../../src/storage/token-storage';
import {
  AgeBand,
  OccupationCategory,
  TopicId,
  OnboardingRequestDto,
} from '@chingoo/shared';

/**
 * Onboarding Screen
 * Route: /(onboarding)/index
 *
 * Per API_CONTRACT.md: POST /user/onboarding
 * Required fields per SPEC_INDEX.md §4 (AI_PIPELINE.md §4.1.1):
 * - preferred_name, age_band, country_or_region, occupation_category,
 *   client_timezone, proactive_messages_enabled, suppressed_topics
 */

// Enum display labels
const AGE_BAND_OPTIONS: { value: AgeBand; label: string }[] = [
  { value: AgeBand.AGE_13_17, label: '13-17' },
  { value: AgeBand.AGE_18_24, label: '18-24' },
  { value: AgeBand.AGE_25_34, label: '25-34' },
  { value: AgeBand.AGE_35_44, label: '35-44' },
  { value: AgeBand.AGE_45_PLUS, label: '45+' },
];

const OCCUPATION_OPTIONS: { value: OccupationCategory; label: string }[] = [
  { value: OccupationCategory.STUDENT, label: 'Student' },
  { value: OccupationCategory.WORKING, label: 'Working' },
  { value: OccupationCategory.BETWEEN_JOBS, label: 'Between Jobs' },
  { value: OccupationCategory.OTHER, label: 'Other' },
];

// Subset of topics for UI (keeping it minimal)
const TOPIC_OPTIONS: { value: TopicId; label: string }[] = [
  { value: TopicId.POLITICS, label: 'Politics' },
  { value: TopicId.RELIGION, label: 'Religion' },
  { value: TopicId.MENTAL_HEALTH, label: 'Mental Health' },
  { value: TopicId.RELATIONSHIPS, label: 'Relationships' },
  { value: TopicId.PERSONAL_FINANCE, label: 'Personal Finance' },
];

export default function OnboardingScreen() {
  const router = useRouter();

  // Form state - all required fields from OnboardingRequestDto
  const [preferredName, setPreferredName] = useState('');
  const [ageBand, setAgeBand] = useState<AgeBand | null>(null);
  const [countryOrRegion, setCountryOrRegion] = useState('');
  const [occupationCategory, setOccupationCategory] =
    useState<OccupationCategory | null>(null);
  const [proactiveMessagesEnabled, setProactiveMessagesEnabled] = useState(true);
  const [suppressedTopics, setSuppressedTopics] = useState<TopicId[]>([]);

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [constraints, setConstraints] = useState<string[]>([]);

  const toggleTopic = (topic: TopicId) => {
    setSuppressedTopics((prev) =>
      prev.includes(topic) ? prev.filter((t) => t !== topic) : [...prev, topic],
    );
  };

  const handleSubmit = async () => {
    // Basic validation
    if (!preferredName.trim()) {
      setError('Please enter your preferred name');
      return;
    }
    if (!ageBand) {
      setError('Please select your age range');
      return;
    }
    if (!countryOrRegion.trim()) {
      setError('Please enter your country/region code');
      return;
    }
    if (!occupationCategory) {
      setError('Please select your occupation');
      return;
    }

    setLoading(true);
    setError(null);
    setConstraints([]);

    try {
      // Get stored token
      const token = await tokenStorage.getToken();
      if (!token) {
        setError('Not authenticated. Please login again.');
        router.replace('/(auth)/login');
        return;
      }

      // Build OnboardingRequestDto with exact fields from API_CONTRACT.md
      const request: OnboardingRequestDto = {
        preferred_name: preferredName.trim(),
        age_band: ageBand,
        country_or_region: countryOrRegion.trim().toUpperCase(),
        occupation_category: occupationCategory,
        client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
        proactive_messages_enabled: proactiveMessagesEnabled,
        suppressed_topics: suppressedTopics,
      };

      // Call POST /user/onboarding
      await api.onboarding(token, request);

      // Success: Navigate to chat
      router.replace('/(chat)');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        // Display constraints if available (ApiErrorDto.constraints)
        if ((err as any).constraints) {
          setConstraints((err as any).constraints);
        }
      } else {
        setError('An unexpected error occurred');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView style={styles.scrollView} contentContainerStyle={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Welcome!</Text>
      <Text style={styles.subtitle}>Tell us a bit about yourself</Text>

      {/* Error display */}
      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          {constraints.map((c, i) => (
            <Text key={i} style={styles.constraintText}>
              • {c}
            </Text>
          ))}
        </View>
      )}

      {/* preferred_name */}
      <Text style={styles.label}>What should we call you?</Text>
      <TextInput
        style={styles.input}
        placeholder="Preferred name"
        value={preferredName}
        onChangeText={setPreferredName}
        maxLength={64}
        autoCapitalize="words"
      />

      {/* age_band */}
      <Text style={styles.label}>Age range</Text>
      <View style={styles.optionRow}>
        {AGE_BAND_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[
              styles.optionButton,
              ageBand === opt.value && styles.optionButtonSelected,
            ]}
            onPress={() => setAgeBand(opt.value)}
          >
            <Text
              style={[
                styles.optionText,
                ageBand === opt.value && styles.optionTextSelected,
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* country_or_region */}
      <Text style={styles.label}>Country/Region (ISO code, e.g. US, KR)</Text>
      <TextInput
        style={styles.input}
        placeholder="US"
        value={countryOrRegion}
        onChangeText={setCountryOrRegion}
        maxLength={2}
        autoCapitalize="characters"
      />

      {/* occupation_category */}
      <Text style={styles.label}>Occupation</Text>
      <View style={styles.optionRow}>
        {OCCUPATION_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[
              styles.optionButton,
              occupationCategory === opt.value && styles.optionButtonSelected,
            ]}
            onPress={() => setOccupationCategory(opt.value)}
          >
            <Text
              style={[
                styles.optionText,
                occupationCategory === opt.value && styles.optionTextSelected,
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* proactive_messages_enabled */}
      <View style={styles.switchRow}>
        <Text style={styles.label}>Enable proactive messages</Text>
        <Switch
          value={proactiveMessagesEnabled}
          onValueChange={setProactiveMessagesEnabled}
        />
      </View>

      {/* suppressed_topics */}
      <Text style={styles.label}>Topics to avoid (optional)</Text>
      <View style={styles.topicGrid}>
        {TOPIC_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[
              styles.topicButton,
              suppressedTopics.includes(opt.value) && styles.topicButtonSelected,
            ]}
            onPress={() => toggleTopic(opt.value)}
          >
            <Text
              style={[
                styles.topicText,
                suppressedTopics.includes(opt.value) && styles.topicTextSelected,
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Submit */}
      <TouchableOpacity
        style={[styles.submitButton, loading && styles.submitButtonDisabled]}
        onPress={handleSubmit}
        disabled={loading}
      >
        <Text style={styles.submitButtonText}>
          {loading ? 'Saving...' : 'Continue'}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
    backgroundColor: '#fff',
  },
  container: {
    padding: 20,
    paddingTop: 60,
    paddingBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 8,
  },
  input: {
    height: 50,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 16,
    fontSize: 16,
  },
  optionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 20,
    marginBottom: 8,
  },
  optionButtonSelected: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  optionText: {
    fontSize: 14,
    color: '#333',
  },
  optionTextSelected: {
    color: '#fff',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
  },
  topicGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  topicButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 16,
    marginBottom: 8,
  },
  topicButtonSelected: {
    backgroundColor: '#FF3B30',
    borderColor: '#FF3B30',
  },
  topicText: {
    fontSize: 12,
    color: '#333',
  },
  topicTextSelected: {
    color: '#fff',
  },
  submitButton: {
    height: 50,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 32,
  },
  submitButtonDisabled: {
    backgroundColor: '#ccc',
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  errorContainer: {
    backgroundColor: '#FFEBEE',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  errorText: {
    color: '#C62828',
    fontSize: 14,
  },
  constraintText: {
    color: '#C62828',
    fontSize: 12,
    marginTop: 4,
  },
});
