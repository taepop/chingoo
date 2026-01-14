import { Test, TestingModule } from '@nestjs/testing';
import { RouterService, RouterDecision, HeuristicFlags } from './router.service';
import { TopicMatchService, TopicMatchResult } from '../topicmatch/topicmatch.service';
import { TopicId, UserState, AgeBand } from '@chingoo/shared';

/**
 * RouterService Unit Tests
 * 
 * TEST GATE #5 — Determinism Tests
 * 
 * Per AI_PIPELINE.md §6:
 * - User state gating (§6.1): CREATED→REFUSAL, ONBOARDING→ONBOARDING_CHAT, ACTIVE→normal routing
 * - Intent routing (§6.5): EMOTIONAL_SUPPORT, INFO_QA, FRIEND_CHAT
 * 
 * These tests verify:
 * 1) Router produces different outcomes based on user_state (ONBOARDING vs ACTIVE)
 * 2) Same decision on repeated runs (determinism)
 * 3) Safety rules override intent routing
 */
describe('RouterService', () => {
  let routerService: RouterService;
  let topicMatchService: TopicMatchService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RouterService, TopicMatchService],
    }).compile();

    routerService = module.get<RouterService>(RouterService);
    topicMatchService = module.get<TopicMatchService>(TopicMatchService);
  });

  describe('user state gating tests (golden tests)', () => {
    /**
     * TEST: CREATED user should be routed to REFUSAL
     * Per AI_PIPELINE.md §6.1: If user_state is CREATED: route to REFUSAL
     */
    it('should route CREATED user to REFUSAL pipeline', () => {
      const result = routerService.route({
        user_state: UserState.CREATED,
        norm_no_punct: 'hello there',
        token_estimate: 5,
        topic_matches: [],
        age_band: AgeBand.AGE_18_24,
      });

      expect(result.pipeline).toBe('REFUSAL');
      expect(result.safety_policy).toBe('ALLOW');
      expect(result.memory_write_policy).toBe('NONE');
      expect(result.relationship_update_policy).toBe('OFF');
    });

    /**
     * TEST: ONBOARDING user should be routed to ONBOARDING_CHAT
     * Per AI_PIPELINE.md §6.1: If user_state is ONBOARDING: route to ONBOARDING_CHAT
     */
    it('should route ONBOARDING user to ONBOARDING_CHAT pipeline', () => {
      const result = routerService.route({
        user_state: UserState.ONBOARDING,
        norm_no_punct: 'hello there',
        token_estimate: 5,
        topic_matches: [],
        age_band: AgeBand.AGE_18_24,
      });

      expect(result.pipeline).toBe('ONBOARDING_CHAT');
      expect(result.memory_read_policy).toBe('LIGHT');
      expect(result.vector_search_policy).toBe('OFF');
    });

    /**
     * TEST: ACTIVE user should proceed with normal intent routing
     * Per AI_PIPELINE.md §6.1: If user_state is ACTIVE: proceed with normal intent routing
     */
    it('should route ACTIVE user through normal intent routing (FRIEND_CHAT default)', () => {
      const result = routerService.route({
        user_state: UserState.ACTIVE,
        norm_no_punct: 'hello there how are you',
        token_estimate: 10,
        topic_matches: [],
        age_band: AgeBand.AGE_18_24,
      });

      expect(result.pipeline).toBe('FRIEND_CHAT');
      expect(result.memory_read_policy).toBe('FULL');
      expect(result.vector_search_policy).toBe('ON_DEMAND');
    });
  });

  describe('intent routing tests (ACTIVE users)', () => {
    /**
     * TEST: has_distress should route to EMOTIONAL_SUPPORT
     * Per AI_PIPELINE.md §6.5: If has_distress OR asks_for_comfort => EMOTIONAL_SUPPORT
     */
    it('should route distress message to EMOTIONAL_SUPPORT', () => {
      const result = routerService.route({
        user_state: UserState.ACTIVE,
        norm_no_punct: 'i feel hopeless and i cant go on',
        token_estimate: 15,
        topic_matches: [],
        age_band: AgeBand.AGE_18_24,
      });

      expect(result.pipeline).toBe('EMOTIONAL_SUPPORT');
      expect(result.heuristic_flags?.has_distress).toBe(true);
    });

    /**
     * TEST: asks_for_comfort should route to EMOTIONAL_SUPPORT
     */
    it('should route comfort request to EMOTIONAL_SUPPORT', () => {
      const result = routerService.route({
        user_state: UserState.ACTIVE,
        norm_no_punct: 'can you stay with me please',
        token_estimate: 10,
        topic_matches: [],
        age_band: AgeBand.AGE_18_24,
      });

      expect(result.pipeline).toBe('EMOTIONAL_SUPPORT');
      expect(result.heuristic_flags?.asks_for_comfort).toBe(true);
    });

    /**
     * TEST: Pure fact question should route to INFO_QA
     * Per AI_PIPELINE.md §6.5: is_pure_fact_q = is_question AND NOT has_distress AND NOT asks_for_comfort AND token_estimate <= 60
     */
    it('should route pure fact question to INFO_QA', () => {
      const result = routerService.route({
        user_state: UserState.ACTIVE,
        norm_no_punct: 'what is the capital of france',
        token_estimate: 10,
        topic_matches: [],
        age_band: AgeBand.AGE_18_24,
      });

      expect(result.pipeline).toBe('INFO_QA');
      expect(result.heuristic_flags?.is_question).toBe(true);
      expect(result.heuristic_flags?.has_personal_pronoun).toBe(false);
    });

    /**
     * TEST: Question with personal pronoun should route to FRIEND_CHAT (tie-breaker)
     * Per AI_PIPELINE.md §6.5 Tie-breaker: If both is_question and has_personal_pronoun => FRIEND_CHAT
     */
    it('should route personal question to FRIEND_CHAT (tie-breaker)', () => {
      const result = routerService.route({
        user_state: UserState.ACTIVE,
        norm_no_punct: 'what should i do about my breakup',
        token_estimate: 15,
        topic_matches: [],
        age_band: AgeBand.AGE_18_24,
      });

      expect(result.pipeline).toBe('FRIEND_CHAT');
      expect(result.heuristic_flags?.is_question).toBe(true);
      expect(result.heuristic_flags?.has_personal_pronoun).toBe(true);
    });
  });

  describe('determinism tests (same input = same output)', () => {
    /**
     * TEST: "No randomness" determinism test for Router
     * Per task requirement: same input run twice returns byte-identical decision fields
     */
    it('should return identical RouterDecision on repeated runs', () => {
      const input = {
        user_state: UserState.ACTIVE,
        norm_no_punct: 'i feel really depressed today and i need help',
        token_estimate: 20,
        topic_matches: [],
        age_band: AgeBand.AGE_18_24,
      };

      // Run 1
      const result1 = routerService.route(input);
      // Run 2
      const result2 = routerService.route(input);

      // All fields must be identical
      expect(result1.pipeline).toBe(result2.pipeline);
      expect(result1.safety_policy).toBe(result2.safety_policy);
      expect(result1.memory_read_policy).toBe(result2.memory_read_policy);
      expect(result1.memory_write_policy).toBe(result2.memory_write_policy);
      expect(result1.vector_search_policy).toBe(result2.vector_search_policy);
      expect(result1.relationship_update_policy).toBe(result2.relationship_update_policy);
      
      // topic_id, confidence, route must be byte-identical
      expect(result1.topic_id).toBe(result2.topic_id);
      expect(result1.confidence).toBe(result2.confidence);
      expect(result1.route).toBe(result2.route);
    });

    /**
     * TEST: Different user states produce different outcomes
     * Demonstrates routing outcome differs correctly based on user state
     */
    it('should produce different outcomes for ONBOARDING vs ACTIVE', () => {
      const baseInput = {
        norm_no_punct: 'hello there how are you',
        token_estimate: 10,
        topic_matches: [],
        age_band: AgeBand.AGE_18_24,
      };

      const onboardingResult = routerService.route({
        ...baseInput,
        user_state: UserState.ONBOARDING,
      });

      const activeResult = routerService.route({
        ...baseInput,
        user_state: UserState.ACTIVE,
      });

      // Different pipelines
      expect(onboardingResult.pipeline).toBe('ONBOARDING_CHAT');
      expect(activeResult.pipeline).toBe('FRIEND_CHAT');

      // Different memory policies
      expect(onboardingResult.memory_read_policy).toBe('LIGHT');
      expect(activeResult.memory_read_policy).toBe('FULL');
    });

    /**
     * TEST: Verify internal decision object structure
     * The Router must return a deterministic internal decision object with:
     * topic_id, confidence, route/handler key, optional reason/debug fields
     */
    it('should produce complete internal decision object', () => {
      const result = routerService.route({
        user_state: UserState.ACTIVE,
        norm_no_punct: 'tell me about politics',
        token_estimate: 10,
        topic_matches: [
          { topic_id: TopicId.POLITICS, confidence: 0.5, hit_count: 1, is_user_initiated: false },
        ],
        age_band: AgeBand.AGE_18_24,
      });

      // Required fields per task spec B
      expect(result.topic_id).toBeDefined();
      expect(typeof result.confidence).toBe('number');
      expect(result.route).toBeDefined();
      
      // RoutingDecision fields from spec
      expect(result.pipeline).toBeDefined();
      expect(result.safety_policy).toBeDefined();
      expect(result.memory_read_policy).toBeDefined();
      expect(result.vector_search_policy).toBeDefined();
      expect(result.memory_write_policy).toBeDefined();
      expect(result.relationship_update_policy).toBeDefined();
    });
  });

  describe('Korean language support', () => {
    /**
     * TEST: Korean distress keywords should trigger EMOTIONAL_SUPPORT
     * Per AI_PIPELINE.md §6.5: has_distress includes "우울", "불안", "공황", "힘들어", "죽고싶"
     */
    it('should detect Korean distress keywords', () => {
      const result = routerService.route({
        user_state: UserState.ACTIVE,
        norm_no_punct: '요즘 너무 우울해요',
        token_estimate: 10,
        topic_matches: [],
        age_band: AgeBand.AGE_18_24,
      });

      expect(result.pipeline).toBe('EMOTIONAL_SUPPORT');
      expect(result.heuristic_flags?.has_distress).toBe(true);
    });

    /**
     * TEST: Korean comfort request should trigger EMOTIONAL_SUPPORT
     * Per AI_PIPELINE.md §6.5: asks_for_comfort includes "위로"
     */
    it('should detect Korean comfort request', () => {
      const result = routerService.route({
        user_state: UserState.ACTIVE,
        norm_no_punct: '위로가 필요해요',
        token_estimate: 8,
        topic_matches: [],
        age_band: AgeBand.AGE_18_24,
      });

      expect(result.pipeline).toBe('EMOTIONAL_SUPPORT');
      expect(result.heuristic_flags?.asks_for_comfort).toBe(true);
    });
  });

  describe('age band safety gating', () => {
    /**
     * TEST: Unknown age_band should be treated as 13-17 for safety
     * Per AI_PIPELINE.md §6.2.1: If age_band is missing/unknown, treat as 13-17
     */
    it('should treat null age_band as minor for sexual content safety', () => {
      const result = routerService.route({
        user_state: UserState.ACTIVE,
        norm_no_punct: 'hello there',
        token_estimate: 5,
        topic_matches: [],
        age_band: null,
      });

      // Should still route normally for non-sexual content
      expect(result.pipeline).toBe('FRIEND_CHAT');
      // But _age_band_effective should be 13-17
      expect(result._debug?.age_band_effective).toBe(AgeBand.AGE_13_17);
    });
  });
});
