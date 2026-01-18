import { Injectable } from '@nestjs/common';
import { TopicId, AgeBand } from '@chingoo/shared';
import { TopicMatchResult } from '../topicmatch/topicmatch.service';

/**
 * Local type definitions for safety classification
 * Using string literals for cross-package compatibility with Jest
 * These match the enums in packages/shared/src/enums.ts
 */
export type SafetyPolicyType = 'ALLOW' | 'SOFT_REFUSE' | 'HARD_REFUSE';
export type PipelineType = 
  | 'ONBOARDING_CHAT' 
  | 'FRIEND_CHAT' 
  | 'EMOTIONAL_SUPPORT' 
  | 'INFO_QA' 
  | 'REFUSAL';

/**
 * SafetyClassificationResult - Output of safety classification
 * 
 * Per AI_PIPELINE.md §6.2:
 * - safety_policy: ALLOW | SOFT_REFUSE | HARD_REFUSE
 * - classification_reason: Debug info for audit logs
 * - requires_crisis_flow: True if self-harm crisis handling needed
 * - suggested_pipeline: Override pipeline if safety violation detected
 */
export interface SafetyClassificationResult {
  safety_policy: SafetyPolicyType;
  classification_reason: string;
  requires_crisis_flow: boolean;
  suggested_pipeline: PipelineType | null;
  memory_write_allowed: boolean;
  relationship_update_allowed: boolean;
}

/**
 * SafetyClassificationInput - Input for safety classification
 */
export interface SafetyClassificationInput {
  norm_no_punct: string;
  age_band: AgeBand | null;
  topic_matches: TopicMatchResult[];
  token_estimate: number;
}

/**
 * SafetyClassifierService
 * 
 * Implements safety classification per AI_PIPELINE.md §6.2:
 * - Erotic/explicit sexual content or sexual roleplay → HARD_REFUSE
 * - Age band gating (§6.2.1): 13-17 or unknown → stricter rules
 * - Sexual-health education questions (non-erotic) → INFO_QA (ALLOW)
 * - Self-harm intent → EMOTIONAL_SUPPORT with crisis-safe flow
 * - Harassment/hate → SOFT_REFUSE or HARD_REFUSE per policy
 * 
 * Per PRODUCT.md §10 (Adult-Content Stance):
 * - Chingoo is NOT an erotic/explicit adult chat product
 * - AI must refuse erotic sexual content, sexual roleplay, explicit descriptions
 * 
 * CRITICAL: This service is PURE DETERMINISTIC.
 * - No Date.now(), Math.random(), network calls, or LLM calls.
 * - Same input always produces identical output.
 * 
 * Per ARCHITECTURE.md §E.1:
 * - Safety module may import from: shared
 */
@Injectable()
export class SafetyClassifierService {
  /**
   * Explicit/Erotic content keywords per AI_PIPELINE.md §6.2 and PRODUCT.md §10
   * These trigger HARD_REFUSE for any age band
   */
  private readonly explicitContentKeywords = [
    // English explicit terms
    'roleplay', 'erotic', 'explicit', 'pornographic', 'porn', 'nsfw',
    'sexting', 'dirty talk', 'spicy roleplay', 'sexual fantasy',
    'write me an erotic', 'explicit story', 'describe sex',
    'naked', 'undress', 'strip', 'nude photo', 'nudes',
    // Korean explicit terms  
    '야설', '음란', '성인물', '야한 이야기', '에로 소설',
  ];

  /**
   * Sexual roleplay request patterns
   * Per PRODUCT.md §10: "AI must refuse erotic sexual content, sexual roleplay"
   */
  private readonly sexualRoleplayPatterns = [
    'roleplay something spicy',
    'lets roleplay',
    "let's roleplay",
    'be my girlfriend',
    'be my boyfriend',
    'pretend youre my',
    "pretend you're my",
    'act like my lover',
    'flirt with me',
    'seduce me',
    // Korean patterns
    '역할극 해줘',
    '야한 역할극',
    '연인 역할',
  ];

  /**
   * Self-harm keywords per AI_PIPELINE.md §5.1 (SELF_HARM topic)
   * These trigger EMOTIONAL_SUPPORT with crisis-safe flow
   */
  private readonly selfHarmKeywords = [
    // English
    'suicide', 'kill myself', 'self harm', 'self-harm', 'cut myself',
    'overdose', 'end my life', 'ending it all', 'want to die',
    'hurt myself', 'harm myself', 'suicidal',
    // Korean
    '자살', '자해', '죽고싶', '죽고 싶', '목숨을 끊',
  ];

  /**
   * Hate speech/harassment keywords per AI_PIPELINE.md §5.1
   * These trigger HARD_REFUSE for severe cases, SOFT_REFUSE for borderline
   */
  private readonly hateSpeechKeywords = [
    // Note: Using placeholder patterns - real implementation would have comprehensive slur list
    'nazi', 'kill all', 'death to', 'genocide',
    // Korean
    '인종차별', '혐오',
  ];

  /**
   * Borderline harassment patterns (SOFT_REFUSE)
   */
  private readonly borderlineHarassmentPatterns = [
    'hate you', 'youre stupid', "you're stupid", 'youre an idiot',
    "you're an idiot", 'shut up', 'go away',
  ];

  /**
   * Sexual health education patterns (ALLOW for 18+)
   * Per AI_PIPELINE.md §6.2: "Sexual-health education questions (non-erotic) → INFO_QA (ALLOW)"
   */
  private readonly sexualHealthEducationPatterns = [
    'how does birth control', 'what is contraception', 'how to use condom',
    'what is std', 'what are stis', 'what is hiv', 'is it normal to',
    'sex education', 'reproductive health', 'menstrual', 'puberty',
    'questions about sex', 'curious about sex', 'how does pregnancy',
    // Korean
    '피임', '생리', '사춘기', '임신 방법', '성교육',
  ];

  /**
   * Illegal activity patterns per AI_PIPELINE.md §5.1
   */
  private readonly illegalActivityPatterns = [
    'how to hack', 'how to steal', 'how to commit fraud',
    'make a bomb', 'buy drugs', 'counterfeit', 'forge documents',
    // Korean
    '해킹 방법', '사기 치는 법', '마약 구매',
  ];

  /**
   * Classify content safety and determine response policy.
   * 
   * Per AI_PIPELINE.md §6.2:
   * This runs BEFORE intent routing and can override the pipeline.
   * 
   * @param input - SafetyClassificationInput with normalized text, age band, topic matches
   * @returns SafetyClassificationResult with policy and flags
   */
  classify(input: SafetyClassificationInput): SafetyClassificationResult {
    const textLower = input.norm_no_punct.toLowerCase();
    
    // Determine effective age band per AI_PIPELINE.md §6.2.1
    // If age_band is missing/unknown, treat as 13-17 for safety gating
    const effectiveAgeBand = input.age_band ?? AgeBand.AGE_13_17;
    const isMinor = effectiveAgeBand === AgeBand.AGE_13_17;
    const isAgeUnknown = input.age_band === null;

    // Step 1: Check for explicit/erotic content (HARD_REFUSE for all ages)
    const explicitCheck = this.checkExplicitContent(textLower);
    if (explicitCheck.isExplicit) {
      return {
        safety_policy: 'HARD_REFUSE',
        classification_reason: `Explicit content detected: ${explicitCheck.reason}`,
        requires_crisis_flow: false,
        suggested_pipeline: 'REFUSAL',
        memory_write_allowed: false,
        relationship_update_allowed: false,
      };
    }

    // Step 2: Check for sexual roleplay requests (HARD_REFUSE for all ages)
    // Per PRODUCT.md §10: "AI must refuse erotic sexual content, sexual roleplay"
    const roleplayCheck = this.checkSexualRoleplay(textLower);
    if (roleplayCheck.isRoleplay) {
      return {
        safety_policy: 'HARD_REFUSE',
        classification_reason: `Sexual roleplay request detected: ${roleplayCheck.reason}`,
        requires_crisis_flow: false,
        suggested_pipeline: 'REFUSAL',
        memory_write_allowed: false,
        relationship_update_allowed: false,
      };
    }

    // Step 3: Check for self-harm intent → EMOTIONAL_SUPPORT with crisis-safe flow
    // Per AI_PIPELINE.md §6.2: "Self-harm intent → EMOTIONAL_SUPPORT with crisis-safe flow"
    const selfHarmCheck = this.checkSelfHarm(textLower, input.topic_matches);
    if (selfHarmCheck.hasSelfHarmIntent) {
      return {
        safety_policy: 'ALLOW',
        classification_reason: `Self-harm detected: ${selfHarmCheck.reason}. Routing to crisis-safe flow.`,
        requires_crisis_flow: true,
        suggested_pipeline: 'EMOTIONAL_SUPPORT',
        memory_write_allowed: true, // May store EMOTIONAL_PATTERN summaries, not explicit details
        relationship_update_allowed: true,
      };
    }

    // Step 4: Check for hate speech/harassment
    const hateCheck = this.checkHateSpeech(textLower);
    if (hateCheck.isHateSpeech) {
      return {
        safety_policy: 'HARD_REFUSE',
        classification_reason: `Hate speech detected: ${hateCheck.reason}`,
        requires_crisis_flow: false,
        suggested_pipeline: 'REFUSAL',
        memory_write_allowed: false,
        relationship_update_allowed: false,
      };
    }

    // Step 4b: Check for borderline harassment (SOFT_REFUSE)
    const borderlineCheck = this.checkBorderlineHarassment(textLower);
    if (borderlineCheck.isBorderline) {
      return {
        safety_policy: 'SOFT_REFUSE',
        classification_reason: `Borderline harassment detected: ${borderlineCheck.reason}`,
        requires_crisis_flow: false,
        suggested_pipeline: null, // Let router decide, but with SOFT_REFUSE policy
        memory_write_allowed: true,
        relationship_update_allowed: true,
      };
    }

    // Step 5: Age-gated sexual content check
    // Per AI_PIPELINE.md §6.2.1: 13-17 or unknown → stricter rules
    const sexualContentCheck = this.checkSexualContent(textLower, input.topic_matches);
    
    if (sexualContentCheck.hasSexualContent) {
      // Check if it's sexual health education (allowed for adults)
      const isEducational = this.checkSexualHealthEducation(textLower);
      
      if (isMinor || isAgeUnknown) {
        // Per AI_PIPELINE.md §6.2: "If age_band=13-17: any sexual content beyond basic safety/education → HARD_REFUSE"
        if (isEducational.isEducational) {
          // Allow very limited clinical education for minors
          return {
            safety_policy: 'ALLOW',
            classification_reason: 'Sexual health education (limited/clinical for minor)',
            requires_crisis_flow: false,
            suggested_pipeline: 'INFO_QA',
            memory_write_allowed: false,
            relationship_update_allowed: true,
          };
        }
        
        return {
          safety_policy: 'HARD_REFUSE',
          classification_reason: `Sexual content for minor/unknown age: ${sexualContentCheck.reason}`,
          requires_crisis_flow: false,
          suggested_pipeline: 'REFUSAL',
          memory_write_allowed: false,
          relationship_update_allowed: false,
        };
      }
      
      // Adult (18+) with sexual content
      if (isEducational.isEducational) {
        // Per AI_PIPELINE.md §6.2: "Sexual-health education questions (non-erotic) → INFO_QA (ALLOW)"
        return {
          safety_policy: 'ALLOW',
          classification_reason: 'Sexual health education (neutral response for adult)',
          requires_crisis_flow: false,
          suggested_pipeline: 'INFO_QA',
          memory_write_allowed: false,
          relationship_update_allowed: true,
        };
      }
      
      // Non-educational sexual content for adult - still refuse explicit
      // Per PRODUCT.md §10: App is not adult/erotic
      return {
        safety_policy: 'SOFT_REFUSE',
        classification_reason: 'Sexual content beyond education scope',
        requires_crisis_flow: false,
        suggested_pipeline: null,
        memory_write_allowed: false,
        relationship_update_allowed: true,
      };
    }

    // Step 6: Check for illegal activity requests
    const illegalCheck = this.checkIllegalActivity(textLower, input.topic_matches);
    if (illegalCheck.isIllegal) {
      return {
        safety_policy: 'HARD_REFUSE',
        classification_reason: `Illegal activity request: ${illegalCheck.reason}`,
        requires_crisis_flow: false,
        suggested_pipeline: 'REFUSAL',
        memory_write_allowed: false,
        relationship_update_allowed: false,
      };
    }

    // Step 7: Default - content is safe
    return {
      safety_policy: 'ALLOW',
      classification_reason: 'No safety violations detected',
      requires_crisis_flow: false,
      suggested_pipeline: null,
      memory_write_allowed: true,
      relationship_update_allowed: true,
    };
  }

  /**
   * Check for explicit/erotic content
   */
  private checkExplicitContent(text: string): { isExplicit: boolean; reason: string } {
    for (const keyword of this.explicitContentKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        return { isExplicit: true, reason: `matched keyword: ${keyword}` };
      }
    }
    return { isExplicit: false, reason: '' };
  }

  /**
   * Check for sexual roleplay requests
   */
  private checkSexualRoleplay(text: string): { isRoleplay: boolean; reason: string } {
    for (const pattern of this.sexualRoleplayPatterns) {
      if (text.includes(pattern.toLowerCase())) {
        return { isRoleplay: true, reason: `matched pattern: ${pattern}` };
      }
    }
    return { isRoleplay: false, reason: '' };
  }

  /**
   * Check for self-harm intent
   * Per AI_PIPELINE.md §6.2: "Self-harm intent → EMOTIONAL_SUPPORT with crisis-safe flow"
   */
  private checkSelfHarm(text: string, topicMatches: TopicMatchResult[]): { 
    hasSelfHarmIntent: boolean; 
    reason: string 
  } {
    // Check topic matches first (more reliable)
    const selfHarmTopic = topicMatches.find(t => t.topic_id === TopicId.SELF_HARM);
    if (selfHarmTopic && selfHarmTopic.confidence >= 0.5) {
      return { 
        hasSelfHarmIntent: true, 
        reason: `SELF_HARM topic confidence: ${selfHarmTopic.confidence}` 
      };
    }

    // Check keywords
    for (const keyword of this.selfHarmKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        return { hasSelfHarmIntent: true, reason: `matched keyword: ${keyword}` };
      }
    }

    return { hasSelfHarmIntent: false, reason: '' };
  }

  /**
   * Check for hate speech
   */
  private checkHateSpeech(text: string): { isHateSpeech: boolean; reason: string } {
    for (const keyword of this.hateSpeechKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        return { isHateSpeech: true, reason: `matched keyword: ${keyword}` };
      }
    }
    return { isHateSpeech: false, reason: '' };
  }

  /**
   * Check for borderline harassment
   */
  private checkBorderlineHarassment(text: string): { isBorderline: boolean; reason: string } {
    for (const pattern of this.borderlineHarassmentPatterns) {
      if (text.includes(pattern.toLowerCase())) {
        return { isBorderline: true, reason: `matched pattern: ${pattern}` };
      }
    }
    return { isBorderline: false, reason: '' };
  }

  /**
   * Check for sexual content using topic matches
   */
  private checkSexualContent(text: string, topicMatches: TopicMatchResult[]): {
    hasSexualContent: boolean;
    reason: string;
  } {
    const sexualContentTopic = topicMatches.find(t => t.topic_id === TopicId.SEXUAL_CONTENT);
    const sexualJokesTopic = topicMatches.find(t => t.topic_id === TopicId.SEXUAL_JOKES);

    if (sexualContentTopic && sexualContentTopic.confidence >= 0.5) {
      return { 
        hasSexualContent: true, 
        reason: `SEXUAL_CONTENT topic confidence: ${sexualContentTopic.confidence}` 
      };
    }

    if (sexualJokesTopic && sexualJokesTopic.confidence >= 0.5) {
      return { 
        hasSexualContent: true, 
        reason: `SEXUAL_JOKES topic confidence: ${sexualJokesTopic.confidence}` 
      };
    }

    return { hasSexualContent: false, reason: '' };
  }

  /**
   * Check if the sexual content is educational health information
   * Per AI_PIPELINE.md §6.2: "Sexual-health education questions (non-erotic) → INFO_QA"
   */
  private checkSexualHealthEducation(text: string): { isEducational: boolean; reason: string } {
    for (const pattern of this.sexualHealthEducationPatterns) {
      if (text.includes(pattern.toLowerCase())) {
        return { isEducational: true, reason: `educational pattern: ${pattern}` };
      }
    }
    return { isEducational: false, reason: '' };
  }

  /**
   * Check for illegal activity requests
   */
  private checkIllegalActivity(text: string, topicMatches: TopicMatchResult[]): {
    isIllegal: boolean;
    reason: string;
  } {
    // Check topic matches
    const illegalTopic = topicMatches.find(t => t.topic_id === TopicId.ILLEGAL_ACTIVITY);
    if (illegalTopic && illegalTopic.confidence >= 0.7) {
      return { 
        isIllegal: true, 
        reason: `ILLEGAL_ACTIVITY topic confidence: ${illegalTopic.confidence}` 
      };
    }

    // Check patterns
    for (const pattern of this.illegalActivityPatterns) {
      if (text.includes(pattern.toLowerCase())) {
        return { isIllegal: true, reason: `matched pattern: ${pattern}` };
      }
    }

    return { isIllegal: false, reason: '' };
  }

  /**
   * Helper method to determine if content should trigger crisis flow
   * Used by router to determine if special crisis handling is needed
   */
  isCrisisContent(input: SafetyClassificationInput): boolean {
    const textLower = input.norm_no_punct.toLowerCase();
    const selfHarmCheck = this.checkSelfHarm(textLower, input.topic_matches);
    return selfHarmCheck.hasSelfHarmIntent;
  }

  /**
   * Get crisis-safe response guidelines
   * Per AI_PIPELINE.md §6.2: Special handling for self-harm intent
   * 
   * Response MUST:
   * - Express care and concern
   * - NOT lecture or judge
   * - NOT provide method information
   * - Gently suggest professional resources
   * - Stay present and supportive
   * 
   * Response MUST NOT:
   * - Panic or overreact
   * - Provide suicide hotline numbers unsolicited
   * - Ignore the distress
   * - Encourage harmful behavior
   */
  getCrisisGuidelines(): {
    mustDo: string[];
    mustNot: string[];
    toneGuidance: string;
  } {
    return {
      mustDo: [
        'Express care and concern',
        'Stay present and supportive',
        'Validate their feelings without judgment',
        'Ask gentle, open questions to understand more',
        'Offer to continue the conversation',
      ],
      mustNot: [
        'Lecture or judge',
        'Provide method information even if asked',
        'Dump crisis hotline numbers unsolicited',
        'Panic or overreact',
        'Ignore or minimize the distress',
        'Store explicit crisis details as facts',
      ],
      toneGuidance: 'Warm, present, human-like friendship. Not clinical or distant.',
    };
  }
}
