import { Injectable } from '@nestjs/common';
import { TopicId } from '@chingoo/shared';

/**
 * TopicMatchResult interface per ARCHITECTURE.md §C.7
 * 
 * Readers: router, orchestrator, postprocessor, retention
 * Writers: topicmatch module
 */
export interface TopicMatchResult {
  topic_id: TopicId;
  confidence: number;     // 0.0–1.0
  hit_count: number;
  is_user_initiated: boolean;  // confidence >= 0.70
}

/**
 * TopicMatchService
 * 
 * Implements deterministic topic detection per AI_PIPELINE.md §5.1
 * 
 * Formula: Confidence = min(1.0, 0.35 + 0.15 * hit_count)
 * - hit_count = number of DISTINCT keyword/phrase hits for that TopicID
 * - User-initiated iff confidence >= 0.70 (requires 3+ hits)
 * 
 * Keyword lists from AI_PIPELINE.md §5.1 minimum lists.
 * 
 * CRITICAL: This service is PURE DETERMINISTIC.
 * - No Date.now(), Math.random(), network calls, or LLM calls.
 * - Same input always produces identical output.
 */
@Injectable()
export class TopicMatchService {
  /**
   * Keyword lists per AI_PIPELINE.md §5.1
   * These are the minimum required lists for v0.1
   */
  private readonly keywordLists: Map<TopicId, string[]> = new Map([
    [TopicId.POLITICS, [
      'election', 'president', 'parliament', 'government',
      '민주당', '국민의힘', '보수', '진보', '정치'
    ]],
    [TopicId.RELIGION, [
      'church', 'bible', 'jesus', 'islam', 'muslim', 'hindu', 'buddhism',
      '기독교', '불교', '이슬람', '종교'
    ]],
    [TopicId.SEXUAL_CONTENT, [
      'sex', 'sexual', 'nude', 'porn', 'fetish', 'intercourse',
      '에로', '야동', '성관계'
    ]],
    [TopicId.SEXUAL_JOKES, [
      'horny', 'thirst', "that's what she said",
      '19금', '드립'
    ]],
    [TopicId.MENTAL_HEALTH, [
      'depressed', 'depression', 'anxiety', 'panic', 'therapy', 'therapist',
      '우울', '불안', '공황'
    ]],
    [TopicId.SELF_HARM, [
      'suicide', 'kill myself', 'self harm', 'cut', 'overdose',
      '자살', '자해'
    ]],
    [TopicId.SUBSTANCES, [
      'alcohol', 'drunk', 'weed', 'cannabis', 'cocaine', 'vaping',
      '술', '대마', '마약'
    ]],
    [TopicId.GAMBLING, [
      'casino', 'bet', 'sportsbook', 'slots',
      '도박'
    ]],
    [TopicId.VIOLENCE, [
      'kill', 'murder', 'assault', 'gun', 'stabbing',
      '폭력', '살인'
    ]],
    [TopicId.ILLEGAL_ACTIVITY, [
      'hack', 'fraud', 'steal', 'piracy', 'counterfeit',
      '불법', '사기'
    ]],
    [TopicId.HATE_HARASSMENT, [
      'hate', 'nazi',
      '인종차별'
    ]],
    [TopicId.MEDICAL_HEALTH, [
      'diagnosis', 'symptoms', 'medicine',
      '병원', '진단', '약'
    ]],
    [TopicId.PERSONAL_FINANCE, [
      'debt', 'loan', 'credit card', 'investing', 'stock advice',
      '빚', '대출', '투자'
    ]],
    [TopicId.RELATIONSHIPS, [
      'breakup', 'ex', 'dating', 'girlfriend', 'boyfriend',
      '연애', '이별'
    ]],
    [TopicId.FAMILY, [
      'mom', 'dad', 'parents', 'family',
      '엄마', '아빠', '부모'
    ]],
    [TopicId.WORK_SCHOOL, [
      'exam', 'interview', 'job', 'boss',
      '학교', '시험', '면접'
    ]],
    [TopicId.TRAVEL, [
      'flight', 'hotel', 'itinerary',
      '여행'
    ]],
    [TopicId.ENTERTAINMENT, [
      'movie', 'drama', 'kpop', 'game',
      '영화', '드라마'
    ]],
    [TopicId.TECH_GAMING, [
      'code', 'programming', 'pc build', 'fps',
      '롤', '발로란트', '코딩'
    ]],
  ]);

  /**
   * Compute topic matches for normalized text.
   * 
   * Per AI_PIPELINE.md §5.1:
   * - Input: norm_no_punct (normalized, punctuation removed except apostrophes)
   * - Uses whole-word/phrase matching
   * - Counts DISTINCT keyword hits (max 1 per keyword per topic)
   * - Confidence = min(1.0, 0.35 + 0.15 * hit_count)
   * - is_user_initiated = confidence >= 0.70
   * 
   * @param normNoPunct - Normalized text without punctuation
   * @returns Array of TopicMatchResult for all topics
   */
  computeTopicMatches(normNoPunct: string): TopicMatchResult[] {
    const results: TopicMatchResult[] = [];
    const textLower = normNoPunct.toLowerCase();

    for (const topicId of Object.values(TopicId)) {
      const keywords = this.keywordLists.get(topicId) || [];
      const hitCount = this.countDistinctHits(textLower, keywords);
      const confidence = this.calculateConfidence(hitCount);
      
      results.push({
        topic_id: topicId,
        hit_count: hitCount,
        confidence,
        is_user_initiated: confidence >= 0.70,
      });
    }

    return results;
  }

  /**
   * Count distinct keyword hits in text.
   * 
   * Per AI_PIPELINE.md §5.1:
   * "at most 1 count per keyword/phrase entry per TopicID, even if it appears multiple times"
   * 
   * @param text - Lowercase text to search
   * @param keywords - Keywords to match
   * @returns Number of distinct keywords found (0 to keywords.length)
   */
  private countDistinctHits(text: string, keywords: string[]): number {
    let hitCount = 0;

    for (const keyword of keywords) {
      // For Korean characters, we don't need word boundaries
      // For English, we use word boundary matching
      const hasNonLatin = /[^\u0000-\u007F]/.test(keyword);
      
      if (hasNonLatin) {
        // Korean/non-Latin: simple includes check
        if (text.includes(keyword.toLowerCase())) {
          hitCount++;
        }
      } else {
        // English: whole word match using word boundaries
        const regex = new RegExp(`\\b${this.escapeRegex(keyword)}\\b`, 'i');
        if (regex.test(text)) {
          hitCount++;
        }
      }
    }

    return hitCount;
  }

  /**
   * Calculate confidence from hit count.
   * 
   * Per AI_PIPELINE.md §5.1:
   * Confidence = min(1.0, 0.35 + 0.15 * hit_count)
   * 
   * Note: We round to 2 decimal places to avoid floating-point precision issues.
   * 
   * @param hitCount - Number of distinct keyword hits
   * @returns Confidence value (0.0 to 1.0)
   */
  private calculateConfidence(hitCount: number): number {
    if (hitCount === 0) {
      return 0;
    }
    // Round to 2 decimal places to avoid floating-point precision issues
    const rawConfidence = 0.35 + 0.15 * hitCount;
    return Math.min(1.0, Math.round(rawConfidence * 100) / 100);
  }

  /**
   * Escape special regex characters in keyword.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Get topics that are user-initiated (confidence >= 0.70).
   * Helper method for other modules.
   * 
   * @param results - Array of TopicMatchResult
   * @returns Array of TopicId that are user-initiated
   */
  getUserInitiatedTopics(results: TopicMatchResult[]): TopicId[] {
    return results
      .filter(r => r.is_user_initiated)
      .map(r => r.topic_id);
  }
}
