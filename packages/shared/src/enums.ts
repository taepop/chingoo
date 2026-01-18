// Shared Enums (packages/shared/src/enums.ts)
// Per API_CONTRACT.md §1 and ARCHITECTURE.md §E.2

export enum UserState {
  CREATED = "CREATED",
  ONBOARDING = "ONBOARDING",
  ACTIVE = "ACTIVE"
}

export enum AgeBand {
  AGE_13_17 = "13-17",
  AGE_18_24 = "18-24",
  AGE_25_34 = "25-34",
  AGE_35_44 = "35-44",
  AGE_45_PLUS = "45+"
}

export enum OccupationCategory {
  STUDENT = "student",
  WORKING = "working",
  BETWEEN_JOBS = "between_jobs",
  OTHER = "other"
}

export enum TopicId {
  POLITICS = "POLITICS",
  RELIGION = "RELIGION",
  SEXUAL_CONTENT = "SEXUAL_CONTENT",
  SEXUAL_JOKES = "SEXUAL_JOKES",
  MENTAL_HEALTH = "MENTAL_HEALTH",
  SELF_HARM = "SELF_HARM",
  SUBSTANCES = "SUBSTANCES",
  GAMBLING = "GAMBLING",
  VIOLENCE = "VIOLENCE",
  ILLEGAL_ACTIVITY = "ILLEGAL_ACTIVITY",
  HATE_HARASSMENT = "HATE_HARASSMENT",
  MEDICAL_HEALTH = "MEDICAL_HEALTH",
  PERSONAL_FINANCE = "PERSONAL_FINANCE",
  RELATIONSHIPS = "RELATIONSHIPS",
  FAMILY = "FAMILY",
  WORK_SCHOOL = "WORK_SCHOOL",
  TRAVEL = "TRAVEL",
  ENTERTAINMENT = "ENTERTAINMENT",
  TECH_GAMING = "TECH_GAMING"
}

// ─────────────────────────────────────────────────────────────
// PERSONA ENUMS (Per ARCHITECTURE.md §E.2 and PRODUCT.md §6)
// ─────────────────────────────────────────────────────────────

/**
 * Core Archetype per PRODUCT.md §6.1 and §6.2.1
 * 10 unique archetypes used across 24 templates
 */
export enum CoreArchetype {
  CALM_LISTENER = "Calm_Listener",
  WARM_CAREGIVER = "Warm_Caregiver",
  BLUNT_HONEST = "Blunt_Honest",
  DRY_HUMOR = "Dry_Humor",
  PLAYFUL_TEASE = "Playful_Tease",
  CHAOTIC_INTERNET_FRIEND = "Chaotic_Internet_Friend",
  GENTLE_COACH = "Gentle_Coach",
  SOFT_NERD = "Soft_Nerd",
  HYPE_BESTIE = "Hype_Bestie",
  LOW_KEY_COMPANION = "Low_Key_Companion"
}

/**
 * Sentence length bias per AI_PIPELINE.md §2.3
 */
export enum SentenceLengthBias {
  SHORT = "short",
  MEDIUM = "medium",
  LONG = "long"
}

/**
 * Emoji usage per AI_PIPELINE.md §2.3
 */
export enum EmojiUsage {
  NONE = "none",
  LIGHT = "light",
  FREQUENT = "frequent"
}

/**
 * Humor mode per AI_PIPELINE.md §2.3 and PRODUCT.md §6.1
 */
export enum HumorMode {
  NONE = "none",
  LIGHT_SARCASM = "light_sarcasm",
  FREQUENT_JOKES = "frequent_jokes",
  DEADPAN = "deadpan"
}

/**
 * Friend energy per AI_PIPELINE.md §2.3 and PRODUCT.md §6.1
 */
export enum FriendEnergy {
  PASSIVE = "passive",
  BALANCED = "balanced",
  PROACTIVE = "proactive"
}

/**
 * Lexicon bias per AI_PIPELINE.md §2.3 and PRODUCT.md §6.1
 */
export enum LexiconBias {
  CLEAN = "clean",
  SLANG = "slang",
  INTERNET_SHORTHAND = "internet_shorthand"
}

/**
 * Emotional expression level per AI_PIPELINE.md §2.3
 */
export enum EmotionalExpressionLevel {
  RESTRAINED = "restrained",
  NORMAL = "normal",
  EXPRESSIVE = "expressive"
}

/**
 * Directness level per AI_PIPELINE.md §2.4
 */
export enum DirectnessLevel {
  SOFT = "soft",
  BALANCED = "balanced",
  BLUNT = "blunt"
}

/**
 * Follow-up question rate per AI_PIPELINE.md §2.4
 */
export enum FollowupQuestionRate {
  LOW = "low",
  MEDIUM = "medium"
}

/**
 * Relationship stage per PRODUCT.md §7.1
 */
export enum RelationshipStage {
  STRANGER = "STRANGER",
  ACQUAINTANCE = "ACQUAINTANCE",
  FRIEND = "FRIEND",
  CLOSE_FRIEND = "CLOSE_FRIEND"
}

/**
 * Pipeline types per AI_PIPELINE.md §2.2
 */
export enum Pipeline {
  ONBOARDING_CHAT = "ONBOARDING_CHAT",
  FRIEND_CHAT = "FRIEND_CHAT",
  EMOTIONAL_SUPPORT = "EMOTIONAL_SUPPORT",
  INFO_QA = "INFO_QA",
  REFUSAL = "REFUSAL"
}

/**
 * Safety policy per AI_PIPELINE.md §2.2
 */
export enum SafetyPolicy {
  ALLOW = "ALLOW",
  SOFT_REFUSE = "SOFT_REFUSE",
  HARD_REFUSE = "HARD_REFUSE"
}

/**
 * Memory type per AI_PIPELINE.md §2.6 and PRODUCT.md §8.1
 */
export enum MemoryType {
  FACT = "FACT",
  PREFERENCE = "PREFERENCE",
  RELATIONSHIP_EVENT = "RELATIONSHIP_EVENT",
  EMOTIONAL_PATTERN = "EMOTIONAL_PATTERN"
}

/**
 * Memory status per AI_PIPELINE.md §2.6
 */
export enum MemoryStatus {
  ACTIVE = "ACTIVE",
  SUPERSEDED = "SUPERSEDED",
  INVALID = "INVALID"
}
