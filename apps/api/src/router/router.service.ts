import { Injectable } from '@nestjs/common';
import { TopicId, UserState, AgeBand } from '@chingoo/shared';
import { TopicMatchResult } from '../topicmatch/topicmatch.service';
import { SafetyClassifierService, SafetyClassificationResult, SafetyPolicyType, PipelineType } from './safety-classifier';

/**
 * Local type definitions for routing
 * Using string literals for cross-package compatibility with Jest
 * These match the enums in packages/shared/src/enums.ts
 */
export type Pipeline = PipelineType;
export type SafetyPolicy = SafetyPolicyType;

/**
 * Memory read policy per AI_PIPELINE.md §2.2
 */
export type MemoryReadPolicy = 'NONE' | 'LIGHT' | 'FULL';

/**
 * Memory write policy per AI_PIPELINE.md §2.2
 */
export type MemoryWritePolicy = 'NONE' | 'SELECTIVE';

/**
 * Vector search policy per AI_PIPELINE.md §2.2
 */
export type VectorSearchPolicy = 'OFF' | 'ON_DEMAND';

/**
 * Relationship update policy per AI_PIPELINE.md §2.2
 */
export type RelationshipUpdatePolicy = 'ON' | 'OFF';

/**
 * HeuristicFlags per ARCHITECTURE.md §C.1
 */
export interface HeuristicFlags {
  has_preference_trigger: boolean;
  has_fact_trigger: boolean;
  has_event_trigger: boolean;
  has_correction_trigger: boolean;
  is_question: boolean;
  has_personal_pronoun: boolean;
  has_distress: boolean;
  asks_for_comfort: boolean;
}

/**
 * Router input parameters
 */
export interface RouterInput {
  user_state: UserState;
  norm_no_punct: string;
  token_estimate: number;
  topic_matches: TopicMatchResult[];
  age_band: AgeBand | null;
}

/**
 * RouterDecision - Internal decision object
 * 
 * Per task requirement B:
 * - topic_id
 * - confidence  
 * - route/handler key
 * - optional reason/debug fields (internal only)
 * 
 * Plus RoutingDecision fields from AI_PIPELINE.md §2.2
 */
export interface RouterDecision {
  // Task B requirements: internal decision fields
  topic_id: TopicId | null;
  confidence: number;
  route: string;  // handler key

  // RoutingDecision fields per AI_PIPELINE.md §2.2
  pipeline: PipelineType;
  safety_policy: SafetyPolicyType;
  memory_read_policy: MemoryReadPolicy;
  memory_write_policy: MemoryWritePolicy;
  vector_search_policy: VectorSearchPolicy;
  relationship_update_policy: RelationshipUpdatePolicy;
  retrieval_query_text: string | null;
  notes: string | null;

  // Computed heuristic flags
  heuristic_flags?: HeuristicFlags;

  // Safety classification result per AI_PIPELINE.md §6.2
  safety_classification?: SafetyClassificationResult;

  // Crisis flow flag per AI_PIPELINE.md §6.2
  requires_crisis_flow: boolean;

  // Debug fields (internal only)
  _debug?: {
    age_band_effective: AgeBand;
    routing_reason: string;
    safety_reason?: string;
  };
}

/**
 * RouterService
 * 
 * Implements routing per AI_PIPELINE.md §6:
 * - User-state gating (§6.1)
 * - Safety classification (§6.2) - BEFORE intent routing, can override pipeline
 * - Age band gating (§6.2.1)
 * - Self-harm crisis flow (§6.2)
 * - Explicit content refusal (§6.2 + PRODUCT.md §10)
 * - Intent routing (§6.5)
 * 
 * Per AI_PIPELINE.md §6.2:
 * "Safety classification runs BEFORE intent routing and can override the pipeline."
 * 
 * Routing Priority (AI_PIPELINE.md §6.5):
 * 1) Safety hard rules → HARD_REFUSE or SOFT_REFUSE (overrides everything)
 * 2) has_distress OR asks_for_comfort → EMOTIONAL_SUPPORT
 * 3) is_pure_fact_q → INFO_QA
 * 4) Default → FRIEND_CHAT
 * 
 * CRITICAL: This service is PURE DETERMINISTIC.
 * - No Date.now(), Math.random(), network calls, or LLM calls.
 * - Same input always produces identical output.
 * 
 * Per ARCHITECTURE.md:
 * - Router may import from: topicmatch, safety, shared
 * - NO module may import from orchestrator or chat
 */
@Injectable()
export class RouterService {
  constructor(
    private readonly safetyClassifier: SafetyClassifierService,
  ) {}
  /**
   * Distress keywords per AI_PIPELINE.md §6.5
   */
  private readonly distressKeywords = [
    "i can't", "i feel hopeless", "i'm panicking", "i'm so anxious",
    "i'm depressed", "overwhelmed", "so stressed", "i hate myself",
    "nothing matters", "i want to disappear",
    // Korean
    "우울", "불안", "공황", "힘들어", "죽고싶"
  ];

  /**
   * Comfort request keywords per AI_PIPELINE.md §6.5
   */
  private readonly comfortKeywords = [
    "can you stay", "talk to me", "i need someone", "please help me calm down",
    // Korean
    "위로"
  ];

  /**
   * Question starters per AI_PIPELINE.md §6.5
   */
  private readonly questionStarters = [
    'what', 'why', 'how', 'when', 'where', 'explain', 'define'
  ];

  /**
   * Personal pronouns per AI_PIPELINE.md §6.5
   */
  private readonly personalPronouns = ["i ", "i'm", "im ", "my ", "me "];

  /**
   * Route a turn packet to produce a deterministic routing decision.
   * 
   * Per AI_PIPELINE.md §6:
   * 1. User-state gating (§6.1)
   * 2. Safety classification (§6.2) - BEFORE intent routing, can override pipeline
   * 3. Intent routing (§6.5)
   * 
   * Per AI_PIPELINE.md §6.5 - Routing Priority:
   * 1) Safety hard rules → HARD_REFUSE or SOFT_REFUSE (overrides everything)
   * 2) has_distress OR asks_for_comfort → EMOTIONAL_SUPPORT
   * 3) is_pure_fact_q → INFO_QA
   * 4) Default → FRIEND_CHAT
   * 
   * @param input - Router input with user state, normalized text, etc.
   * @returns RouterDecision - deterministic decision object
   */
  route(input: RouterInput): RouterDecision {
    // Step 1: Determine effective age band (§6.2.1)
    // If age_band is missing/unknown, treat as 13-17 for safety gating
    const ageBandEffective = input.age_band ?? AgeBand.AGE_13_17;

    // Step 2: Compute heuristic flags per AI_PIPELINE.md §6.5
    const heuristicFlags = this.computeHeuristicFlags(input.norm_no_punct, input.token_estimate);

    // Step 3: User-state gating per AI_PIPELINE.md §6.1
    if (input.user_state === UserState.CREATED) {
      return this.createRefusalDecision(input, heuristicFlags, ageBandEffective);
    }

    if (input.user_state === UserState.ONBOARDING) {
      return this.createOnboardingDecision(input, heuristicFlags, ageBandEffective);
    }

    // Step 4: Safety classification BEFORE intent routing per AI_PIPELINE.md §6.2
    // "Safety classification runs BEFORE intent routing and can override the pipeline."
    const safetyResult = this.safetyClassifier.classify({
      norm_no_punct: input.norm_no_punct,
      age_band: input.age_band,
      topic_matches: input.topic_matches,
      token_estimate: input.token_estimate,
    });

    // Step 5: Safety hard rules override everything (Priority 1)
    // Per AI_PIPELINE.md §6.2: "If HARD_REFUSE: relationship_update_policy=OFF, memory_write_policy=NONE"
    if (safetyResult.safety_policy === 'HARD_REFUSE') {
      return this.createSafetyRefusalDecision(input, heuristicFlags, ageBandEffective, safetyResult);
    }

    // Step 6: Crisis flow check - Self-harm routes to EMOTIONAL_SUPPORT
    // Per AI_PIPELINE.md §6.2: "Self-harm intent → EMOTIONAL_SUPPORT with crisis-safe flow"
    if (safetyResult.requires_crisis_flow) {
      return this.createCrisisFlowDecision(input, heuristicFlags, ageBandEffective, safetyResult);
    }

    // Step 7: ACTIVE user - proceed with intent routing per §6.5
    // Pass safety result to potentially adjust policies
    return this.routeActiveUser(input, heuristicFlags, ageBandEffective, safetyResult);
  }

  /**
   * Compute heuristic flags from normalized text.
   * Per AI_PIPELINE.md §6.5 - Intent routing flags
   */
  private computeHeuristicFlags(normNoPunct: string, tokenEstimate: number): HeuristicFlags {
    const textLower = normNoPunct.toLowerCase();

    const is_question = this.detectQuestion(textLower);
    const has_personal_pronoun = this.detectPersonalPronoun(textLower);
    const has_distress = this.detectDistress(textLower);
    const asks_for_comfort = this.detectComfortRequest(textLower);

    // Basic trigger detection (for future memory extraction)
    const has_preference_trigger = this.detectPreferenceTrigger(textLower);
    const has_fact_trigger = this.detectFactTrigger(textLower);
    const has_event_trigger = this.detectEventTrigger(textLower);
    const has_correction_trigger = this.detectCorrectionTrigger(textLower);

    return {
      is_question,
      has_personal_pronoun,
      has_distress,
      asks_for_comfort,
      has_preference_trigger,
      has_fact_trigger,
      has_event_trigger,
      has_correction_trigger,
    };
  }

  /**
   * Detect question per AI_PIPELINE.md §6.5:
   * is_question = contains "?" OR starts with {what, why, how, when, where, explain, define} 
   *               OR matches "how do i"
   */
  private detectQuestion(text: string): boolean {
    if (text.includes('?')) {
      return true;
    }

    const words = text.split(/\s+/);
    if (words.length > 0 && this.questionStarters.includes(words[0])) {
      return true;
    }

    if (text.includes('how do i')) {
      return true;
    }

    return false;
  }

  /**
   * Detect personal pronoun per AI_PIPELINE.md §6.5:
   * has_personal_pronoun = contains {"i ", "i'm", "im ", "my ", "me "}
   */
  private detectPersonalPronoun(text: string): boolean {
    for (const pronoun of this.personalPronouns) {
      if (text.includes(pronoun)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detect distress per AI_PIPELINE.md §6.5
   */
  private detectDistress(text: string): boolean {
    for (const keyword of this.distressKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detect comfort request per AI_PIPELINE.md §6.5
   */
  private detectComfortRequest(text: string): boolean {
    for (const keyword of this.comfortKeywords) {
      if (text.includes(keyword.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detect preference trigger per AI_PIPELINE.md §5
   * Patterns: "i like", "i love", "i hate", "my favorite"
   */
  private detectPreferenceTrigger(text: string): boolean {
    const patterns = ['i like', 'i love', 'i hate', 'my favorite'];
    return patterns.some(p => text.includes(p));
  }

  /**
   * Detect fact trigger per AI_PIPELINE.md §5
   * Patterns: "i'm from", "i live in", "my job is", "i'm a"
   */
  private detectFactTrigger(text: string): boolean {
    const patterns = ["i'm from", 'i live in', 'my job is', "i'm a", "im from", "im a"];
    return patterns.some(p => text.includes(p));
  }

  /**
   * Detect event trigger per AI_PIPELINE.md §5
   * Patterns: "i broke up", "my exam", "i'm traveling", "interview"
   */
  private detectEventTrigger(text: string): boolean {
    const patterns = ['i broke up', 'my exam', "i'm traveling", "im traveling", 'interview'];
    return patterns.some(p => text.includes(p));
  }

  /**
   * Detect correction trigger per AI_PIPELINE.md §5
   * Patterns: "that's not true", "don't remember that", "don't bring this topic up again"
   */
  private detectCorrectionTrigger(text: string): boolean {
    const patterns = [
      // Direct memory correction phrases
      "that's not true", "thats not true", "that's not right", "thats not right",
      "that's wrong", "thats wrong", "you're wrong", "youre wrong",
      "that's incorrect", "thats incorrect",
      // Memory deletion phrases
      "don't remember that", "dont remember that", "forget that", "forget about that",
      // Topic suppression phrases
      "don't bring this topic up", "dont bring this topic up",
      "don't mention that", "dont mention that",
      // Explicit corrections
      "actually no", "no that"
    ];
    return patterns.some(p => text.includes(p));
  }

  /**
   * Create REFUSAL decision for CREATED user state.
   * Per AI_PIPELINE.md §6.1: route to REFUSAL with message "please complete onboarding"
   */
  private createRefusalDecision(
    input: RouterInput,
    heuristicFlags: HeuristicFlags,
    ageBandEffective: AgeBand,
  ): RouterDecision {
    return {
      topic_id: null,
      confidence: 0,
      route: 'refusal',
      pipeline: 'REFUSAL',
      safety_policy: 'ALLOW',
      memory_read_policy: 'NONE',
      memory_write_policy: 'NONE',
      vector_search_policy: 'OFF',
      relationship_update_policy: 'OFF',
      retrieval_query_text: null,
      notes: 'User state is CREATED - onboarding required',
      heuristic_flags: heuristicFlags,
      requires_crisis_flow: false,
      _debug: {
        age_band_effective: ageBandEffective,
        routing_reason: 'CREATED user state → REFUSAL',
      },
    };
  }

  /**
   * Create HARD_REFUSE decision for safety violations.
   * Per AI_PIPELINE.md §6.2: "If HARD_REFUSE: relationship_update_policy=OFF, memory_write_policy=NONE"
   */
  private createSafetyRefusalDecision(
    input: RouterInput,
    heuristicFlags: HeuristicFlags,
    ageBandEffective: AgeBand,
    safetyResult: SafetyClassificationResult,
  ): RouterDecision {
    const topicWithHighestConfidence = this.getTopicWithHighestConfidence(input.topic_matches);

    return {
      topic_id: topicWithHighestConfidence?.topic_id ?? null,
      confidence: topicWithHighestConfidence?.confidence ?? 0,
      route: 'refusal',
      pipeline: 'REFUSAL',
      safety_policy: 'HARD_REFUSE',
      memory_read_policy: 'NONE',
      memory_write_policy: 'NONE',
      vector_search_policy: 'OFF',
      relationship_update_policy: 'OFF', // Per §6.2: OFF for HARD_REFUSE
      retrieval_query_text: null,
      notes: `Safety violation: ${safetyResult.classification_reason}`,
      heuristic_flags: heuristicFlags,
      safety_classification: safetyResult,
      requires_crisis_flow: false,
      _debug: {
        age_band_effective: ageBandEffective,
        routing_reason: 'Safety HARD_REFUSE → REFUSAL',
        safety_reason: safetyResult.classification_reason,
      },
    };
  }

  /**
   * Create EMOTIONAL_SUPPORT decision for crisis flow (self-harm intent).
   * Per AI_PIPELINE.md §6.2: "Self-harm intent → EMOTIONAL_SUPPORT with crisis-safe flow"
   * 
   * Memory handling per §6.2:
   * - May store EMOTIONAL_PATTERN summary
   * - Do NOT store explicit crisis details as facts
   */
  private createCrisisFlowDecision(
    input: RouterInput,
    heuristicFlags: HeuristicFlags,
    ageBandEffective: AgeBand,
    safetyResult: SafetyClassificationResult,
  ): RouterDecision {
    const topicWithHighestConfidence = this.getTopicWithHighestConfidence(input.topic_matches);

    return {
      topic_id: topicWithHighestConfidence?.topic_id ?? null,
      confidence: topicWithHighestConfidence?.confidence ?? 0,
      route: 'emotional_support',
      pipeline: 'EMOTIONAL_SUPPORT',
      safety_policy: 'ALLOW',
      memory_read_policy: 'LIGHT', // Per §6.3: LIGHT for EMOTIONAL_SUPPORT
      memory_write_policy: 'SELECTIVE', // Per §6.3: SELECTIVE for EMOTIONAL_PATTERN summaries
      vector_search_policy: 'OFF', // Per §6.3: OFF for EMOTIONAL_SUPPORT in v0.1
      relationship_update_policy: 'ON',
      retrieval_query_text: null,
      notes: `Crisis flow: ${safetyResult.classification_reason}`,
      heuristic_flags: heuristicFlags,
      safety_classification: safetyResult,
      requires_crisis_flow: true,
      _debug: {
        age_band_effective: ageBandEffective,
        routing_reason: 'Self-harm intent → EMOTIONAL_SUPPORT (crisis-safe flow)',
        safety_reason: safetyResult.classification_reason,
      },
    };
  }

  /**
   * Create ONBOARDING_CHAT decision for ONBOARDING user state.
   * Per AI_PIPELINE.md §6.1: route to ONBOARDING_CHAT
   * Per AI_PIPELINE.md §6.3: memory_read_policy=LIGHT, vector=OFF
   * 
   * Note: Safety classification is also performed for ONBOARDING users
   * to ensure safety rules are enforced even during onboarding.
   */
  private createOnboardingDecision(
    input: RouterInput,
    heuristicFlags: HeuristicFlags,
    ageBandEffective: AgeBand,
  ): RouterDecision {
    const topicWithHighestConfidence = this.getTopicWithHighestConfidence(input.topic_matches);

    // Also run safety classification for ONBOARDING users
    const safetyResult = this.safetyClassifier.classify({
      norm_no_punct: input.norm_no_punct,
      age_band: input.age_band,
      topic_matches: input.topic_matches,
      token_estimate: input.token_estimate,
    });

    // If safety violation during onboarding, create refusal
    if (safetyResult.safety_policy === 'HARD_REFUSE') {
      return this.createSafetyRefusalDecision(input, heuristicFlags, ageBandEffective, safetyResult);
    }

    // If crisis content during onboarding, route to crisis flow
    if (safetyResult.requires_crisis_flow) {
      return this.createCrisisFlowDecision(input, heuristicFlags, ageBandEffective, safetyResult);
    }

    return {
      topic_id: topicWithHighestConfidence?.topic_id ?? null,
      confidence: topicWithHighestConfidence?.confidence ?? 0,
      route: 'onboarding_chat',
      pipeline: 'ONBOARDING_CHAT',
      safety_policy: safetyResult.safety_policy,
      memory_read_policy: 'LIGHT',
      memory_write_policy: 'SELECTIVE',
      vector_search_policy: 'OFF',
      relationship_update_policy: 'ON',
      retrieval_query_text: null,
      notes: 'User state is ONBOARDING',
      heuristic_flags: heuristicFlags,
      safety_classification: safetyResult,
      requires_crisis_flow: false,
      _debug: {
        age_band_effective: ageBandEffective,
        routing_reason: 'ONBOARDING user state → ONBOARDING_CHAT',
      },
    };
  }

  /**
   * Route ACTIVE user per AI_PIPELINE.md §6.5 intent routing.
   * 
   * Per AI_PIPELINE.md §6.5 - Routing Priority (after safety check):
   * 2) If has_distress OR asks_for_comfort => EMOTIONAL_SUPPORT
   * 3) Else if is_pure_fact_q => INFO_QA
   * 4) Else => FRIEND_CHAT
   * 
   * Tie-breaker: If both is_question and has_personal_pronoun => FRIEND_CHAT
   * 
   * @param input - Router input
   * @param heuristicFlags - Computed heuristic flags
   * @param ageBandEffective - Effective age band (default 13-17 if unknown)
   * @param safetyResult - Safety classification result from earlier check
   */
  private routeActiveUser(
    input: RouterInput,
    heuristicFlags: HeuristicFlags,
    ageBandEffective: AgeBand,
    safetyResult: SafetyClassificationResult,
  ): RouterDecision {
    const topicWithHighestConfidence = this.getTopicWithHighestConfidence(input.topic_matches);
    let pipeline: Pipeline;
    let routingReason: string;

    // Check if safety classification suggested a specific pipeline (e.g., INFO_QA for sexual health education)
    if (safetyResult.suggested_pipeline) {
      pipeline = safetyResult.suggested_pipeline;
      routingReason = `safety suggested → ${pipeline}`;
    }
    // Rule 2: Distress or comfort request → EMOTIONAL_SUPPORT
    else if (heuristicFlags.has_distress || heuristicFlags.asks_for_comfort) {
      pipeline = 'EMOTIONAL_SUPPORT';
      routingReason = heuristicFlags.has_distress
        ? 'has_distress → EMOTIONAL_SUPPORT'
        : 'asks_for_comfort → EMOTIONAL_SUPPORT';
    }
    // Rule 3: Pure fact question → INFO_QA
    // is_pure_fact_q = is_question AND NOT has_distress AND NOT asks_for_comfort AND token_estimate <= 60
    else if (this.isPureFactQuestion(heuristicFlags, input.token_estimate)) {
      // Tie-breaker: If both is_question and has_personal_pronoun => FRIEND_CHAT
      if (heuristicFlags.has_personal_pronoun) {
        pipeline = 'FRIEND_CHAT';
        routingReason = 'is_question + has_personal_pronoun (tie-breaker) → FRIEND_CHAT';
      } else {
        pipeline = 'INFO_QA';
        routingReason = 'is_pure_fact_q → INFO_QA';
      }
    }
    // Rule 4: Default → FRIEND_CHAT
    else {
      pipeline = 'FRIEND_CHAT';
      routingReason = 'default → FRIEND_CHAT';
    }

    // Determine policies based on pipeline per AI_PIPELINE.md §6.3
    const basePolicies = this.getPoliciesForPipeline(pipeline);

    // Apply safety result overrides
    // Per AI_PIPELINE.md §6.2: SOFT_REFUSE may adjust policies
    const memoryWritePolicy: MemoryWritePolicy = safetyResult.memory_write_allowed 
      ? basePolicies.memory_write_policy 
      : 'NONE';
    const relationshipUpdatePolicy: RelationshipUpdatePolicy = safetyResult.relationship_update_allowed
      ? basePolicies.relationship_update_policy
      : 'OFF';

    return {
      topic_id: topicWithHighestConfidence?.topic_id ?? null,
      confidence: topicWithHighestConfidence?.confidence ?? 0,
      route: this.getRouteKey(pipeline),
      pipeline,
      safety_policy: safetyResult.safety_policy,
      memory_read_policy: basePolicies.memory_read_policy,
      memory_write_policy: memoryWritePolicy,
      vector_search_policy: basePolicies.vector_search_policy,
      relationship_update_policy: relationshipUpdatePolicy,
      retrieval_query_text: null,
      notes: routingReason,
      heuristic_flags: heuristicFlags,
      safety_classification: safetyResult,
      requires_crisis_flow: false,
      _debug: {
        age_band_effective: ageBandEffective,
        routing_reason: routingReason,
        safety_reason: safetyResult.classification_reason,
      },
    };
  }

  /**
   * Check if message is a pure fact question.
   * Per AI_PIPELINE.md §6.5:
   * is_pure_fact_q = is_question AND NOT has_distress AND NOT asks_for_comfort AND token_estimate <= 60
   */
  private isPureFactQuestion(flags: HeuristicFlags, tokenEstimate: number): boolean {
    return (
      flags.is_question &&
      !flags.has_distress &&
      !flags.asks_for_comfort &&
      tokenEstimate <= 60
    );
  }

  /**
   * Get policies for a pipeline per AI_PIPELINE.md §6.3
   */
  private getPoliciesForPipeline(pipeline: Pipeline): {
    safety_policy: SafetyPolicy;
    memory_read_policy: MemoryReadPolicy;
    memory_write_policy: MemoryWritePolicy;
    vector_search_policy: VectorSearchPolicy;
    relationship_update_policy: RelationshipUpdatePolicy;
  } {
    switch (pipeline) {
      case 'ONBOARDING_CHAT':
        return {
          safety_policy: 'ALLOW',
          memory_read_policy: 'LIGHT',
          memory_write_policy: 'SELECTIVE',
          vector_search_policy: 'OFF',
          relationship_update_policy: 'ON',
        };
      case 'FRIEND_CHAT':
        return {
          safety_policy: 'ALLOW',
          memory_read_policy: 'FULL',
          memory_write_policy: 'SELECTIVE',
          vector_search_policy: 'ON_DEMAND',
          relationship_update_policy: 'ON',
        };
      case 'EMOTIONAL_SUPPORT':
        return {
          safety_policy: 'ALLOW',
          memory_read_policy: 'LIGHT',
          memory_write_policy: 'SELECTIVE',
          vector_search_policy: 'OFF',
          relationship_update_policy: 'ON',
        };
      case 'INFO_QA':
        return {
          safety_policy: 'ALLOW',
          memory_read_policy: 'NONE',
          memory_write_policy: 'NONE',
          vector_search_policy: 'OFF',
          relationship_update_policy: 'ON',
        };
      case 'REFUSAL':
        return {
          safety_policy: 'ALLOW',
          memory_read_policy: 'NONE',
          memory_write_policy: 'NONE',
          vector_search_policy: 'OFF',
          relationship_update_policy: 'OFF',
        };
    }
  }

  /**
   * Get route key (handler) from pipeline.
   */
  private getRouteKey(pipeline: Pipeline): string {
    return pipeline.toLowerCase();
  }

  /**
   * Get the topic with highest confidence from topic matches.
   */
  private getTopicWithHighestConfidence(
    topicMatches: TopicMatchResult[],
  ): TopicMatchResult | null {
    if (!topicMatches || topicMatches.length === 0) {
      return null;
    }

    let highest: TopicMatchResult | null = null;
    for (const match of topicMatches) {
      if (!highest || match.confidence > highest.confidence) {
        highest = match;
      }
    }
    return highest?.confidence > 0 ? highest : null;
  }
}
