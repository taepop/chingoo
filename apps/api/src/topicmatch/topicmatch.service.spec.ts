import { Test, TestingModule } from '@nestjs/testing';
import { TopicMatchService, TopicMatchResult } from './topicmatch.service';
import { TopicId } from '@chingoo/shared';

/**
 * TopicMatchService Unit Tests
 * 
 * TEST GATE #5 — Determinism Tests
 * 
 * Per AI_PIPELINE.md §5.1:
 * - Confidence = min(1.0, 0.35 + 0.15 * hit_count)
 * - A topic is user-initiated iff confidence >= 0.70
 * - hit_count is number of DISTINCT keyword/phrase hits for that TopicID
 * 
 * These tests verify:
 * 1) TopicMatch scoring formula produces exact expected confidence values (golden numbers)
 * 2) Same input run twice returns identical results (determinism)
 */
describe('TopicMatchService', () => {
  let service: TopicMatchService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TopicMatchService],
    }).compile();

    service = module.get<TopicMatchService>(TopicMatchService);
  });

  describe('confidence formula tests (golden numbers)', () => {
    /**
     * TEST: Zero hits should produce confidence = 0.35 + 0.15 * 0 = 0.35
     * Per AI_PIPELINE.md §5.1: Confidence = min(1.0, 0.35 + 0.15 * hit_count)
     */
    it('should return confidence 0.35 for exactly 1 keyword hit', () => {
      // Input: message with one POLITICS keyword
      const normNoPunct = 'the election was interesting';
      
      const results = service.computeTopicMatches(normNoPunct);
      const politicsResult = results.find(r => r.topic_id === TopicId.POLITICS);
      
      // Expected: hit_count = 1, confidence = 0.35 + 0.15 * 1 = 0.50
      expect(politicsResult).toBeDefined();
      expect(politicsResult!.hit_count).toBe(1);
      expect(politicsResult!.confidence).toBe(0.50);
      expect(politicsResult!.is_user_initiated).toBe(false); // 0.50 < 0.70
    });

    /**
     * TEST: Three distinct keyword hits should produce confidence = 0.35 + 0.15 * 3 = 0.80
     * This exceeds the 0.70 threshold, so is_user_initiated should be true
     */
    it('should return confidence 0.80 for exactly 3 keyword hits', () => {
      // Input: message with three POLITICS keywords
      const normNoPunct = 'the election and government and president are important';
      
      const results = service.computeTopicMatches(normNoPunct);
      const politicsResult = results.find(r => r.topic_id === TopicId.POLITICS);
      
      // Expected: hit_count = 3, confidence = 0.35 + 0.15 * 3 = 0.80
      expect(politicsResult).toBeDefined();
      expect(politicsResult!.hit_count).toBe(3);
      expect(politicsResult!.confidence).toBe(0.80);
      expect(politicsResult!.is_user_initiated).toBe(true); // 0.80 >= 0.70
    });

    /**
     * TEST: User-initiated threshold is exactly at 0.70
     * Per AI_PIPELINE.md §5.1: confidence >= 0.70 means user-initiated
     * To reach 0.70: 0.35 + 0.15 * hit_count >= 0.70 → hit_count >= 2.33... → need 3 hits
     * With 2 hits: 0.35 + 0.15 * 2 = 0.65 (not user-initiated)
     */
    it('should require at least 3 hits to be user-initiated (threshold 0.70)', () => {
      // Input: message with exactly 2 RELIGION keywords
      const normNoPunct = 'i went to church to read the bible';
      
      const results = service.computeTopicMatches(normNoPunct);
      const religionResult = results.find(r => r.topic_id === TopicId.RELIGION);
      
      // Expected: hit_count = 2, confidence = 0.35 + 0.15 * 2 = 0.65
      expect(religionResult).toBeDefined();
      expect(religionResult!.hit_count).toBe(2);
      expect(religionResult!.confidence).toBe(0.65);
      expect(religionResult!.is_user_initiated).toBe(false); // 0.65 < 0.70
    });

    /**
     * TEST: Confidence caps at 1.0
     * Per AI_PIPELINE.md §5.1: Confidence = min(1.0, ...)
     * With 5+ hits: 0.35 + 0.15 * 5 = 1.10, capped to 1.0
     */
    it('should cap confidence at 1.0 for 5+ keyword hits', () => {
      // Input: message with 5+ MENTAL_HEALTH keywords
      const normNoPunct = 'im depressed with depression and anxiety i need therapy for my therapist';
      
      const results = service.computeTopicMatches(normNoPunct);
      const mentalHealthResult = results.find(r => r.topic_id === TopicId.MENTAL_HEALTH);
      
      // Expected: hit_count >= 5, confidence = min(1.0, 0.35 + 0.15 * 5) = 1.0
      expect(mentalHealthResult).toBeDefined();
      expect(mentalHealthResult!.hit_count).toBeGreaterThanOrEqual(5);
      expect(mentalHealthResult!.confidence).toBe(1.0);
      expect(mentalHealthResult!.is_user_initiated).toBe(true);
    });
  });

  describe('distinct hit counting tests', () => {
    /**
     * TEST: Same keyword appearing multiple times counts as 1 hit
     * Per AI_PIPELINE.md §5.1: "at most 1 count per keyword/phrase entry per TopicID"
     */
    it('should count repeated keyword only once', () => {
      // Input: "election" appears 3 times but should count as 1 hit
      const normNoPunct = 'election election election';
      
      const results = service.computeTopicMatches(normNoPunct);
      const politicsResult = results.find(r => r.topic_id === TopicId.POLITICS);
      
      // Expected: hit_count = 1 (not 3), confidence = 0.50
      expect(politicsResult).toBeDefined();
      expect(politicsResult!.hit_count).toBe(1);
      expect(politicsResult!.confidence).toBe(0.50);
    });
  });

  describe('determinism tests (same input = same output)', () => {
    /**
     * TEST: "No randomness" determinism test
     * Per task requirement: same input run twice returns byte-identical decision fields
     */
    it('should return identical results on repeated runs', () => {
      const normNoPunct = 'i feel depressed and anxious about my exam interview and job';
      
      // Run 1
      const results1 = service.computeTopicMatches(normNoPunct);
      // Run 2
      const results2 = service.computeTopicMatches(normNoPunct);
      
      // Both runs must produce identical results
      expect(results1).toEqual(results2);
      
      // Verify specific fields are identical
      const mentalHealth1 = results1.find(r => r.topic_id === TopicId.MENTAL_HEALTH);
      const mentalHealth2 = results2.find(r => r.topic_id === TopicId.MENTAL_HEALTH);
      expect(mentalHealth1?.topic_id).toBe(mentalHealth2?.topic_id);
      expect(mentalHealth1?.confidence).toBe(mentalHealth2?.confidence);
      expect(mentalHealth1?.hit_count).toBe(mentalHealth2?.hit_count);
      expect(mentalHealth1?.is_user_initiated).toBe(mentalHealth2?.is_user_initiated);
    });

    /**
     * TEST: Order of keywords in message doesn't affect result
     */
    it('should produce same result regardless of keyword order', () => {
      const normNoPunct1 = 'election president government';
      const normNoPunct2 = 'government president election';
      
      const results1 = service.computeTopicMatches(normNoPunct1);
      const results2 = service.computeTopicMatches(normNoPunct2);
      
      const politics1 = results1.find(r => r.topic_id === TopicId.POLITICS);
      const politics2 = results2.find(r => r.topic_id === TopicId.POLITICS);
      
      expect(politics1?.confidence).toBe(politics2?.confidence);
      expect(politics1?.hit_count).toBe(politics2?.hit_count);
    });
  });

  describe('Korean keyword tests', () => {
    /**
     * TEST: Korean keywords are matched correctly
     * Per AI_PIPELINE.md §5.1 keyword lists include Korean terms
     */
    it('should match Korean MENTAL_HEALTH keywords', () => {
      // Input with Korean mental health keywords: 우울 (depressed), 불안 (anxiety)
      const normNoPunct = '요즘 너무 우울하고 불안해요';
      
      const results = service.computeTopicMatches(normNoPunct);
      const mentalHealthResult = results.find(r => r.topic_id === TopicId.MENTAL_HEALTH);
      
      // Expected: 2 hits (우울, 불안), confidence = 0.35 + 0.15 * 2 = 0.65
      expect(mentalHealthResult).toBeDefined();
      expect(mentalHealthResult!.hit_count).toBe(2);
      expect(mentalHealthResult!.confidence).toBe(0.65);
    });

    /**
     * TEST: Korean POLITICS keywords
     */
    it('should match Korean POLITICS keywords', () => {
      // Input with Korean politics keywords: 정치, 보수
      const normNoPunct = '정치와 보수 진보에 대해 이야기하고 싶어요';
      
      const results = service.computeTopicMatches(normNoPunct);
      const politicsResult = results.find(r => r.topic_id === TopicId.POLITICS);
      
      // Expected: 3 hits (정치, 보수, 진보), confidence = 0.35 + 0.15 * 3 = 0.80
      expect(politicsResult).toBeDefined();
      expect(politicsResult!.hit_count).toBe(3);
      expect(politicsResult!.confidence).toBe(0.80);
      expect(politicsResult!.is_user_initiated).toBe(true);
    });
  });

  describe('edge cases', () => {
    /**
     * TEST: Empty input returns empty results or all zeros
     */
    it('should handle empty input gracefully', () => {
      const normNoPunct = '';
      
      const results = service.computeTopicMatches(normNoPunct);
      
      // All topics should have hit_count = 0, confidence = 0 (or not be in results)
      results.forEach(r => {
        expect(r.hit_count).toBe(0);
        expect(r.confidence).toBe(0);
        expect(r.is_user_initiated).toBe(false);
      });
    });

    /**
     * TEST: No matching keywords returns empty/zero results
     */
    it('should return zero confidence for unrelated message', () => {
      const normNoPunct = 'the weather is nice today';
      
      const results = service.computeTopicMatches(normNoPunct);
      
      // All topics should have hit_count = 0
      results.forEach(r => {
        expect(r.hit_count).toBe(0);
        expect(r.confidence).toBe(0);
      });
    });
  });
});
