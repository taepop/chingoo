/**
 * Persona Types
 * 
 * Per AI_PIPELINE.md §2.3, §2.4 and PRODUCT.md §6.1, §6.5, §6.6
 * These interfaces define the persona system's core data structures.
 */

import {
  CoreArchetype,
  SentenceLengthBias,
  EmojiUsage,
  HumorMode,
  FriendEnergy,
  LexiconBias,
  EmotionalExpressionLevel,
  DirectnessLevel,
  FollowupQuestionRate,
  TopicId,
} from '@chingoo/shared';

/**
 * Speech style configuration per AI_PIPELINE.md §2.3
 */
export interface SpeechStyle {
  sentence_length_bias: SentenceLengthBias;
  emoji_usage: EmojiUsage;
  punctuation_quirks: string[];
}

/**
 * Lexicon bias configuration per AI_PIPELINE.md §2.3
 */
export interface LexiconBiasConfig {
  language_cleanliness: LexiconBias;
  hint_tokens: string[];
}

/**
 * PersonaTemplate per AI_PIPELINE.md §2.3 and PRODUCT.md §6.1, §6.2.1
 * 
 * This is a constraint set applied at:
 * - Response planning (structure and intent)
 * - Post-processing (style enforcement)
 * 
 * It is NOT a prompt - the system must not rely on "prompt vibes" alone.
 */
export interface PersonaTemplate {
  /** Template ID (PT01..PT24) */
  id: string;
  
  /** Core personality archetype */
  core_archetype: CoreArchetype;
  
  /** Speech style configuration */
  speech_style: SpeechStyle;
  
  /** Lexicon bias configuration */
  lexicon_bias: LexiconBiasConfig;
  
  /** Humor mode */
  humor_mode: HumorMode;
  
  /** Emotional expression level */
  emotional_expression_level: EmotionalExpressionLevel;
  
  /** Topics to avoid unless user initiates */
  taboo_soft_bounds: TopicId[];
  
  /** Friend energy level */
  friend_energy: FriendEnergy;
}

/**
 * StableStyleParams per AI_PIPELINE.md §2.4 and PRODUCT.md §6.6
 * 
 * Derived from PersonaTemplate at creation and frozen forever.
 * Used every turn for response generation constraints.
 */
export interface StableStyleParams {
  /** Message length preference (maps from speech_style.sentence_length_bias) */
  msg_length_pref: SentenceLengthBias;
  
  /** Emoji frequency (maps from speech_style.emoji_usage) */
  emoji_freq: EmojiUsage;
  
  /** Humor mode (may be mutated from template default) */
  humor_mode: HumorMode;
  
  /** Directness level (derived during mutation) */
  directness_level: DirectnessLevel;
  
  /** Follow-up question rate (derived during mutation) */
  followup_question_rate: FollowupQuestionRate;
  
  /** Lexicon bias (maps from lexicon_bias.language_cleanliness) */
  lexicon_bias: LexiconBias;
  
  /** Punctuation quirks (from speech_style) */
  punctuation_quirks: string[];
}

/**
 * Persona assignment result per AI_PIPELINE.md §3.3
 * This is what gets persisted to the ai_friends table.
 */
export interface PersonaAssignment {
  /** Template ID (PT01..PT24) */
  persona_template_id: string;
  
  /** Random 32-bit seed for deterministic operations */
  persona_seed: number;
  
  /** Derived and frozen style parameters */
  stable_style_params: StableStyleParams;
  
  /** Topics to avoid from template */
  taboo_soft_bounds: TopicId[];
  
  /** Combo key for anti-cloning: "{core_archetype}:{humor_mode}:{friend_energy}" */
  combo_key: string;
}

/**
 * Combo key components for anti-cloning cap
 * Per AI_PIPELINE.md §3.4: combo_key = (core_archetype, humor_mode, friend_energy)
 */
export interface ComboKeyComponents {
  core_archetype: CoreArchetype;
  humor_mode: HumorMode;
  friend_energy: FriendEnergy;
}

/**
 * Mutation categories that can be modified during persona derivation
 * Per AI_PIPELINE.md §3.2.1: "Choose exactly 2 modifier categories to mutate"
 */
export type MutationCategory = 'speech_style' | 'humor_mode' | 'friend_energy';

/**
 * Anti-cloning cap statistics for a combo key
 * Per AI_PIPELINE.md §3.4.1
 */
export interface ComboKeyStats {
  combo_key: string;
  count: number;
}

/**
 * Anti-cloning cap check result
 * Per AI_PIPELINE.md §3.4.1
 */
export interface AntiCloneCheckResult {
  is_allowed: boolean;
  n_prev: number;
  n_new: number;
  k_prev: number;
  k_new: number;
  max_allowed: number;
}
