import { Injectable } from '@nestjs/common';
import { TopicId, UserState, AgeBand } from '@chingoo/shared';
import { TopicMatchResult } from '../topicmatch/topicmatch.service';

/**
 * Pipeline enum per AI_PIPELINE.md §2.2
 */
export type Pipeline = 
  | 'ONBOARDING_CHAT' 
  | 'FRIEND_CHAT' 
  | 'EMOTIONAL_SUPPORT' 
  | 'INFO_QA' 
  | 'REFUSAL';

/**
 * Safety policy per AI_PIPELINE.md §2.2
 */
export type SafetyPolicy = 'ALLOW' | 'SOFT_REFUSE' | 'HARD_REFUSE';

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
  pipeline: Pipeline;
  safety_policy: SafetyPolicy;
  memory_read_policy: MemoryReadPolicy;
  memory_write_policy: MemoryWritePolicy;
  vector_search_policy: VectorSearchPolicy;
  relationship_update_policy: RelationshipUpdatePolicy;
  retrieval_query_text: string | null;
  notes: string | null;

  // Computed heuristic flags
  heuristic_flags?: HeuristicFlags;

  // Debug fields (internal only)
  _debug?: {
    age_band_effective: AgeBand;
    routing_reason: string;
  };
}

/**
 * RouterService
 * 
 * Implements routing per AI_PIPELINE.md §6:
 * - User-state gating (§6.1)
 * - Safety classification (§6.2)
 * - Intent routing (§6.5)
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
   * 2. Safety classification (§6.2) - basic implementation
   * 3. Intent routing (§6.5)
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

    // Step 4: ACTIVE user - proceed with intent routing per §6.5
    return this.routeActiveUser(input, heuristicFlags, ageBandEffective);
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
      "that's not true", "thats not true",
      "don't remember that", "dont remember that",
      "don't bring this topic up again", "dont bring this topic up again",
      "not true", "wrong"
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
      _debug: {
        age_band_effective: ageBandEffective,
        routing_reason: 'CREATED user state → REFUSAL',
      },
    };
  }

  /**
   * Create ONBOARDING_CHAT decision for ONBOARDING user state.
   * Per AI_PIPELINE.md §6.1: route to ONBOARDING_CHAT
   * Per AI_PIPELINE.md §6.3: memory_read_policy=LIGHT, vector=OFF
   */
  private createOnboardingDecision(
    input: RouterInput,
    heuristicFlags: HeuristicFlags,
    ageBandEffective: AgeBand,
  ): RouterDecision {
    const topicWithHighestConfidence = this.getTopicWithHighestConfidence(input.topic_matches);

    return {
      topic_id: topicWithHighestConfidence?.topic_id ?? null,
      confidence: topicWithHighestConfidence?.confidence ?? 0,
      route: 'onboarding_chat',
      pipeline: 'ONBOARDING_CHAT',
      safety_policy: 'ALLOW',
      memory_read_policy: 'LIGHT',
      memory_write_policy: 'SELECTIVE',
      vector_search_policy: 'OFF',
      relationship_update_policy: 'ON',
      retrieval_query_text: null,
      notes: 'User state is ONBOARDING',
      heuristic_flags: heuristicFlags,
      _debug: {
        age_band_effective: ageBandEffective,
        routing_reason: 'ONBOARDING user state → ONBOARDING_CHAT',
      },
    };
  }

  /**
   * Route ACTIVE user per AI_PIPELINE.md §6.5 intent routing.
   * 
   * Routing order:
   * 1) Safety hard rules override everything (not fully implemented yet)
   * 2) If has_distress OR asks_for_comfort => EMOTIONAL_SUPPORT
   * 3) Else if is_pure_fact_q => INFO_QA
   * 4) Else => FRIEND_CHAT
   * 
   * Tie-breaker: If both is_question and has_personal_pronoun => FRIEND_CHAT
   */
  private routeActiveUser(
    input: RouterInput,
    heuristicFlags: HeuristicFlags,
    ageBandEffective: AgeBand,
  ): RouterDecision {
    const topicWithHighestConfidence = this.getTopicWithHighestConfidence(input.topic_matches);
    let pipeline: Pipeline;
    let routingReason: string;

    // Rule 2: Distress or comfort request → EMOTIONAL_SUPPORT
    if (heuristicFlags.has_distress || heuristicFlags.asks_for_comfort) {
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
    const policies = this.getPoliciesForPipeline(pipeline);

    return {
      topic_id: topicWithHighestConfidence?.topic_id ?? null,
      confidence: topicWithHighestConfidence?.confidence ?? 0,
      route: this.getRouteKey(pipeline),
      pipeline,
      ...policies,
      retrieval_query_text: null,
      notes: routingReason,
      heuristic_flags: heuristicFlags,
      _debug: {
        age_band_effective: ageBandEffective,
        routing_reason: routingReason,
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
