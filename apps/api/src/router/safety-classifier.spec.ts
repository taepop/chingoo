import { Test, TestingModule } from '@nestjs/testing';
import { SafetyClassifierService, SafetyClassificationInput, SafetyPolicyType, PipelineType } from './safety-classifier';
import { TopicId, AgeBand } from '@chingoo/shared';

/**
 * SafetyClassifierService Unit Tests
 * 
 * Per AI_PIPELINE.md §6.2:
 * - Safety classification runs BEFORE intent routing
 * - HARD_REFUSE: Erotic/explicit sexual content, sexual roleplay, hate speech
 * - SOFT_REFUSE: Borderline harassment
 * - Crisis flow: Self-harm intent → EMOTIONAL_SUPPORT
 * 
 * Per AI_PIPELINE.md §6.2.1:
 * - Age band gating: 13-17 or unknown → stricter rules
 * 
 * Per PRODUCT.md §10:
 * - Chingoo is NOT an erotic/explicit adult chat product
 */
describe('SafetyClassifierService', () => {
  let safetyClassifier: SafetyClassifierService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SafetyClassifierService],
    }).compile();

    safetyClassifier = module.get<SafetyClassifierService>(SafetyClassifierService);
  });

  describe('explicit content detection', () => {
    /**
     * TEST: Erotic content should trigger HARD_REFUSE
     * Per AI_PIPELINE.md §6.2: Erotic/explicit sexual content → HARD_REFUSE
     */
    it('should classify erotic content as HARD_REFUSE', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'write me an erotic story about two people',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 15,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('HARD_REFUSE');
      expect(result.suggested_pipeline).toBe('REFUSAL');
      expect(result.memory_write_allowed).toBe(false);
      expect(result.relationship_update_allowed).toBe(false);
      expect(result.requires_crisis_flow).toBe(false);
    });

    /**
     * TEST: Pornographic content should trigger HARD_REFUSE
     */
    it('should classify pornographic request as HARD_REFUSE', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'send me some porn links please',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 10,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('HARD_REFUSE');
      expect(result.suggested_pipeline).toBe('REFUSAL');
    });

    /**
     * TEST: NSFW content should trigger HARD_REFUSE
     */
    it('should classify NSFW request as HARD_REFUSE', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'describe something nsfw for me',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 8,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('HARD_REFUSE');
    });
  });

  describe('sexual roleplay detection', () => {
    /**
     * TEST: Sexual roleplay request should trigger HARD_REFUSE
     * Per PRODUCT.md §10: AI must refuse sexual roleplay
     */
    it('should classify sexual roleplay as HARD_REFUSE', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'lets roleplay something spicy tonight',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 10,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('HARD_REFUSE');
      expect(result.suggested_pipeline).toBe('REFUSAL');
    });

    /**
     * TEST: "Be my girlfriend" roleplay should trigger HARD_REFUSE
     */
    it('should classify romantic roleplay request as HARD_REFUSE', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'be my girlfriend and flirt with me',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 12,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('HARD_REFUSE');
    });
  });

  describe('self-harm crisis flow', () => {
    /**
     * TEST: Self-harm intent should trigger crisis flow
     * Per AI_PIPELINE.md §6.2: Self-harm intent → EMOTIONAL_SUPPORT with crisis-safe flow
     */
    it('should detect self-harm intent and trigger crisis flow', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'i want to kill myself i cant go on',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [
          { topic_id: TopicId.SELF_HARM, confidence: 0.65, hit_count: 2, is_user_initiated: false },
        ],
        token_estimate: 15,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('ALLOW');
      expect(result.requires_crisis_flow).toBe(true);
      expect(result.suggested_pipeline).toBe('EMOTIONAL_SUPPORT');
      expect(result.memory_write_allowed).toBe(true);
    });

    /**
     * TEST: Suicide keyword should trigger crisis flow
     */
    it('should detect suicide keyword and trigger crisis flow', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'thinking about suicide lately',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 8,
      };

      const result = safetyClassifier.classify(input);

      expect(result.requires_crisis_flow).toBe(true);
      expect(result.suggested_pipeline).toBe('EMOTIONAL_SUPPORT');
    });

    /**
     * TEST: Korean self-harm keywords should trigger crisis flow
     */
    it('should detect Korean self-harm keywords', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: '자살 생각이 나요 죽고싶어',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [
          { topic_id: TopicId.SELF_HARM, confidence: 0.65, hit_count: 2, is_user_initiated: false },
        ],
        token_estimate: 10,
      };

      const result = safetyClassifier.classify(input);

      expect(result.requires_crisis_flow).toBe(true);
    });
  });

  describe('hate speech detection', () => {
    /**
     * TEST: Hate speech should trigger HARD_REFUSE
     * Per AI_PIPELINE.md §6.2: Harassment/hate → HARD_REFUSE
     */
    it('should classify hate speech as HARD_REFUSE', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'i support nazi ideology',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 8,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('HARD_REFUSE');
      expect(result.suggested_pipeline).toBe('REFUSAL');
    });

    /**
     * TEST: "Death to" pattern should trigger HARD_REFUSE
     */
    it('should classify violent hate speech as HARD_REFUSE', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'death to all those people',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 10,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('HARD_REFUSE');
    });
  });

  describe('borderline harassment detection', () => {
    /**
     * TEST: Borderline harassment should trigger SOFT_REFUSE
     * Per AI_PIPELINE.md §6.2: Borderline harassment → SOFT_REFUSE
     */
    it('should classify borderline harassment as SOFT_REFUSE', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'youre stupid and i hate you',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 10,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('SOFT_REFUSE');
      expect(result.suggested_pipeline).toBeNull(); // Let router decide
      expect(result.memory_write_allowed).toBe(true);
    });
  });

  describe('age band gating (§6.2.1)', () => {
    /**
     * TEST: Minor should be blocked from sexual content
     * Per AI_PIPELINE.md §6.2: If age_band=13-17: any sexual content → HARD_REFUSE
     */
    it('should block sexual content for minors', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'tell me about sex stuff',
        age_band: AgeBand.AGE_13_17,
        topic_matches: [
          { topic_id: TopicId.SEXUAL_CONTENT, confidence: 0.65, hit_count: 2, is_user_initiated: false },
        ],
        token_estimate: 8,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('HARD_REFUSE');
    });

    /**
     * TEST: Unknown age band should be treated as minor
     * Per AI_PIPELINE.md §6.2.1: If age_band is missing, treat as 13-17
     */
    it('should treat unknown age band as minor for sexual content', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'tell me about sex stuff',
        age_band: null,
        topic_matches: [
          { topic_id: TopicId.SEXUAL_CONTENT, confidence: 0.65, hit_count: 2, is_user_initiated: false },
        ],
        token_estimate: 8,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('HARD_REFUSE');
    });

    /**
     * TEST: Adult should be allowed sexual health education
     * Per AI_PIPELINE.md §6.2: Sexual-health education (non-erotic) → INFO_QA (ALLOW)
     */
    it('should allow sexual health education for adults', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'how does birth control work',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [
          { topic_id: TopicId.SEXUAL_CONTENT, confidence: 0.5, hit_count: 1, is_user_initiated: false },
        ],
        token_estimate: 8,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('ALLOW');
      expect(result.suggested_pipeline).toBe('INFO_QA');
    });

    /**
     * TEST: Minor can get limited sexual health education
     * Per AI_PIPELINE.md §6.2: Sexual-health education allowed but limited for minors
     */
    it('should allow limited sexual health education for minors', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'how does birth control work',
        age_band: AgeBand.AGE_13_17,
        topic_matches: [
          { topic_id: TopicId.SEXUAL_CONTENT, confidence: 0.60, hit_count: 2, is_user_initiated: false },
        ],
        token_estimate: 8,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('ALLOW');
      expect(result.suggested_pipeline).toBe('INFO_QA');
    });
  });

  describe('illegal activity detection', () => {
    /**
     * TEST: Illegal activity request should trigger HARD_REFUSE
     */
    it('should classify illegal activity request as HARD_REFUSE', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'how to hack into someones account',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [
          { topic_id: TopicId.ILLEGAL_ACTIVITY, confidence: 0.80, hit_count: 3, is_user_initiated: false },
        ],
        token_estimate: 10,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('HARD_REFUSE');
    });

    /**
     * TEST: Drug buying request should trigger HARD_REFUSE
     */
    it('should classify drug buying request as HARD_REFUSE', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'where can i buy drugs illegally',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 10,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('HARD_REFUSE');
    });
  });

  describe('safe content detection', () => {
    /**
     * TEST: Normal conversation should be allowed
     */
    it('should allow normal conversation', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'hello how are you doing today',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 10,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('ALLOW');
      expect(result.suggested_pipeline).toBeNull();
      expect(result.memory_write_allowed).toBe(true);
      expect(result.relationship_update_allowed).toBe(true);
      expect(result.requires_crisis_flow).toBe(false);
    });

    /**
     * TEST: Discussion of personal issues should be allowed
     */
    it('should allow discussion of personal issues', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'my friend keeps insulting me and i dont know what to do',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 20,
      };

      const result = safetyClassifier.classify(input);

      expect(result.safety_policy).toBe('ALLOW');
      expect(result.memory_write_allowed).toBe(true);
    });
  });

  describe('crisis guidelines helper', () => {
    /**
     * TEST: getCrisisGuidelines should return proper guidelines
     */
    it('should return crisis response guidelines', () => {
      const guidelines = safetyClassifier.getCrisisGuidelines();

      expect(guidelines.mustDo).toContain('Express care and concern');
      expect(guidelines.mustDo).toContain('Stay present and supportive');
      expect(guidelines.mustNot).toContain('Lecture or judge');
      expect(guidelines.mustNot).toContain('Provide method information even if asked');
      expect(guidelines.toneGuidance).toBeDefined();
    });
  });

  describe('determinism tests', () => {
    /**
     * TEST: Same input should produce identical output
     */
    it('should produce identical results on repeated calls', () => {
      const input: SafetyClassificationInput = {
        norm_no_punct: 'write me an erotic story please',
        age_band: AgeBand.AGE_18_24,
        topic_matches: [],
        token_estimate: 10,
      };

      const result1 = safetyClassifier.classify(input);
      const result2 = safetyClassifier.classify(input);

      expect(result1.safety_policy).toBe(result2.safety_policy);
      expect(result1.classification_reason).toBe(result2.classification_reason);
      expect(result1.requires_crisis_flow).toBe(result2.requires_crisis_flow);
      expect(result1.suggested_pipeline).toBe(result2.suggested_pipeline);
      expect(result1.memory_write_allowed).toBe(result2.memory_write_allowed);
      expect(result1.relationship_update_allowed).toBe(result2.relationship_update_allowed);
    });
  });
});
