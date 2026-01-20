import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HeuristicFlags } from '../router/router.service';
import { TopicMatchResult } from '../topicmatch/topicmatch.service';
import { VectorService, VectorSearchResult } from '../vector/vector.service';

/**
 * Memory types per AI_PIPELINE.md §12.1
 */
export type MemoryType = 'FACT' | 'PREFERENCE' | 'RELATIONSHIP_EVENT' | 'EMOTIONAL_PATTERN';

/**
 * MemoryCandidate - extracted memory before persistence
 * 
 * Per AI_PIPELINE.md §2.6:
 * - type = FACT | PREFERENCE | RELATIONSHIP_EVENT | EMOTIONAL_PATTERN
 * - memory_key (string; canonical per §12.3.1)
 * - memory_value (string; canonical)
 * - confidence (float 0.0–1.0)
 */
export interface MemoryCandidate {
  type: MemoryType;
  memoryKey: string;
  memoryValue: string;
  confidence: number;
}

/**
 * CorrectionResult - result of correction handling
 */
export interface CorrectionResult {
  invalidated_memory_ids: string[];
  needs_clarification: boolean;
  suppressed_keys_added: string[];
}

/**
 * Input for memory extraction
 */
export interface ExtractionInput {
  userMessage: string;
  normNoPunct: string;
  heuristicFlags: HeuristicFlags;
}

/**
 * Input for correction handling
 */
export interface CorrectionInput {
  userId: string;
  aiFriendId: string;
  conversationId: string;
  normNoPunct: string;
  heuristicFlags: HeuristicFlags;
}

/**
 * Input for memory surfacing selection
 */
export interface SurfacingInput {
  userId: string;
  aiFriendId: string;
  userMessage: string;
  topicMatches: TopicMatchResult[];
}

/**
 * Input for persisting a memory candidate
 */
export interface PersistInput {
  userId: string;
  aiFriendId: string;
  messageId: string;
  candidate: MemoryCandidate;
}

/**
 * MemoryService
 * 
 * Implements Memory MVP per AI_PIPELINE.md §12:
 * - Heuristic extraction (no LLM)
 * - Dedup/conflict handling
 * - Correction targeting (surfaced-only safety)
 * - Memory surfacing for assistant messages
 * 
 * CRITICAL: This service is DETERMINISTIC for extraction.
 * No LLM calls, no randomness, no external services.
 * 
 * Per AI_PIPELINE.md §12.4 - Correction Targeting (Authoritative):
 * "A correction command MUST target memories ONLY through surfaced_memory_ids
 * from the immediately previous assistant message."
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  // Confidence initialization per AI_PIPELINE.md §12.3
  private readonly HEURISTIC_CONFIDENCE = 0.60;
  private readonly CONFIDENCE_INCREMENT = 0.15;
  private readonly MAX_CONFIDENCE = 1.0;

  // ============================================================================
  // COMPREHENSIVE MEMORY EXTRACTION PATTERNS
  // ============================================================================

  // Preference patterns - expanded to catch many ways users express likes/dislikes
  private readonly preferencePatterns = {
    like: [
      'i like', 'i love', 'i enjoy', 'i adore', "i'm into", 'im into',
      'my favorite', 'my fav', "i'm a fan of", 'im a fan of', 'i prefer',
      "i'm obsessed with", 'im obsessed with', "i'm really into", 'im really into',
      'i always enjoy', "i can't get enough of", 'cant get enough of',
      "i'm passionate about", 'im passionate about', 'i appreciate',
      // Korean
      '좋아', '사랑해', '최애', '좋아하는',
    ],
    dislike: [
      'i hate', 'i dislike', "i can't stand", 'cant stand', "i don't like", 'dont like',
      "i'm not a fan of", 'im not a fan of', "i'm not into", 'im not into',
      'i avoid', "i can't deal with", 'cant deal with', 'i detest',
      // Korean
      '싫어', '별로', '안 좋아',
    ],
    neutral_preference: [
      "i don't mind", 'dont mind', "i'm okay with", 'im okay with',
      "i'm fine with", 'im fine with', "it's alright", 'its alright',
    ],
  };

  // Fact patterns - massively expanded to catch personal information
  private readonly factPatterns = {
    // Location/Origin
    home_country: ["i'm from", "im from", 'i come from', 'i grew up in', 'i was raised in', 'originally from'],
    current_city: ['i live in', 'i moved to', 'i reside in', "i'm based in", 'im based in', 'i currently live'],
    hometown: ['my hometown is', 'i was born in', 'born and raised in'],
    
    // Work/Career
    occupation: ['my job is', "i'm a", "im a", 'i work as', 'my profession is', 'my career is', "i'm employed as", 'im employed as'],
    workplace: ['i work at', 'i work for', 'my company is', 'i got a job at', "i'm employed at", 'im employed at', 'i joined'],
    work_industry: ['i work in', "i'm in the", 'im in the', 'my industry is', 'my field is'],
    work_role: ['my role is', 'my position is', 'my title is', "i'm the", 'im the'],
    boss: ['my boss is', 'my manager is', 'i report to'],
    coworker: ['my coworker', 'my colleague', 'my team'],
    
    // Education
    school: ['i study at', 'i go to', 'my school is', 'i attend', "i'm enrolled at", 'im enrolled at', 'my university is', 'my college is'],
    major: ['i major in', 'my major is', "i'm studying", 'im studying', 'my degree is in', 'i study'],
    graduation: ['i graduated from', 'i finished', 'i completed'],
    grade: ['my grade is', "i'm in grade", 'im in grade', "i'm in year", 'im in year', "i'm a freshman", "i'm a sophomore", "i'm a junior", "i'm a senior"],
    
    // Personal Details
    birthday: ['my birthday is', 'my birthday in', 'born in', 'born on', 'i was born', 'my bday is'],
    age: ["i'm ", 'im ', 'i am ', 'my age is', 'years old', "i'm turning", 'im turning'],
    name: ['my name is', 'call me', "i'm called", 'im called', 'people call me', 'my nickname is', 'you can call me'],
    gender: ["i'm a guy", 'im a guy', "i'm a girl", 'im a girl', "i'm male", "i'm female", 'im male', 'im female', "i'm a man", "i'm a woman"],
    height: ["i'm tall", 'im tall', "i'm short", 'im short', 'my height is', "i'm about", 'im about'],
    zodiac: ['my sign is', "i'm a ", 'im a ', 'my zodiac is'],
    mbti: ['my mbti is', "i'm an ", 'im an ', "i'm intj", "i'm enfp"], // Common MBTI references
    
    // Pets
    pet_dog: ["my dog's name", "dog's name is", 'my dog is named', 'i have a dog named', 'i have a dog called', 'my dog', 'my puppy'],
    pet_cat: ["my cat's name", "cat's name is", 'my cat is named', 'i have a cat named', 'i have a cat called', 'my cat', 'my kitten'],
    pet_generic: ["my pet's name", "pet's name is", 'my pet is named', 'i have a pet', 'my pet'],
    
    // Family
    family_mom: ["my mom's name", 'my mom is', 'my mother is', "my mother's name", 'my mom works', 'my mother works'],
    family_dad: ["my dad's name", 'my dad is', 'my father is', "my father's name", 'my dad works', 'my father works'],
    family_sibling: ["my sister's name", "my brother's name", 'my sister is', 'my brother is', 'i have a sister', 'i have a brother', 'my sibling'],
    family_grandparent: ['my grandma', 'my grandpa', 'my grandmother', 'my grandfather'],
    family_child: ['my son', 'my daughter', 'my kid', 'my child', 'my kids', 'my children'],
    family_spouse: ['my husband', 'my wife', 'my spouse', 'my partner'],
    
    // Relationships
    relationship_status: ["i'm single", 'im single', "i'm married", 'im married', "i'm dating", 'im dating', "i'm engaged", 'im engaged', "i'm divorced", 'im divorced', 'i have a boyfriend', 'i have a girlfriend'],
    partner: ['my boyfriend', 'my girlfriend', 'my partner', 'my bf', 'my gf', "i'm seeing", 'im seeing', "i'm with"],
    crush: ['i have a crush on', 'i like someone', "i'm crushing on", 'im crushing on'],
    friend: ['my best friend', 'my close friend', 'my friend', 'my bff', 'my bestie'],
    
    // Health
    allergy: ["i'm allergic to", 'im allergic to', 'i have an allergy', 'my allergy is'],
    diet: ["i'm vegan", 'im vegan', "i'm vegetarian", 'im vegetarian', "i'm on a diet", "i don't eat", 'dont eat', "i can't eat", 'cant eat'],
    health_condition: ['i have', 'i suffer from', "i'm dealing with", 'im dealing with', 'diagnosed with'],
    exercise: ['i work out', 'i exercise', 'i go to the gym', 'i run', 'i jog', 'my workout'],
    sleep: ['i wake up at', 'i sleep at', 'i go to bed at', 'my bedtime is', 'i usually sleep'],
    
    // Skills/Abilities
    skill: ['i can', 'i know how to', "i'm good at", 'im good at', 'my skill is', "i'm skilled in", 'im skilled in'],
    language: ['i speak', 'i know', "i'm fluent in", 'im fluent in', "i'm learning", 'im learning', 'my native language'],
    instrument: ['i play', 'i can play', 'my instrument is'],
    
    // Possessions
    car: ['i drive a', 'my car is', 'i have a car', 'i own a'],
    phone: ['i have an iphone', 'i have a samsung', 'i use an', 'my phone is'],
    computer: ['i have a mac', 'i have a pc', 'i use a', 'my laptop is', 'my computer is'],
    
    // Routines/Habits
    morning_routine: ['every morning i', 'in the morning i', 'i start my day', 'my morning routine'],
    daily_routine: ['every day i', 'i usually', 'i always', 'my daily routine', 'i tend to'],
    weekend_routine: ['on weekends i', 'every weekend i', 'my weekends'],
    night_routine: ['every night i', 'before bed i', 'at night i'],
  };

  // Event patterns - for significant life events
  private readonly eventPatterns = {
    past_event: [
      'i went to', 'i visited', 'i attended', 'i saw', 'i watched',
      'i met', 'i talked to', 'i hung out with', 'yesterday i', 'last week i',
      'last month i', 'recently i', 'i just', 'i finally',
    ],
    upcoming_event: [
      "i'm going to", 'im going to', 'i will', "i'm planning to", 'im planning to',
      'i have plans to', 'next week i', 'tomorrow i', 'soon i will', "i'm about to", 'im about to',
    ],
    milestone: [
      'i graduated', 'i got promoted', 'i passed', 'i won', 'i achieved',
      'i completed', 'i finished', 'i earned', 'i received', 'i got accepted',
      'i got engaged', 'i got married', 'i had a baby', 'i bought', 'i moved',
    ],
    struggle: [
      "i'm struggling with", 'im struggling with', "i'm having trouble", 'im having trouble',
      'i failed', "i didn't get", 'didnt get', 'i lost', 'i broke up',
      "i'm stressed about", 'im stressed about', "i'm worried about", 'im worried about',
    ],
    started: [
      'i started', 'i began', "i'm starting", 'im starting', 'i picked up',
      "i've been", 'ive been', 'i recently started',
    ],
    stopped: [
      'i stopped', 'i quit', "i'm quitting", 'im quitting', 'i gave up',
      "i don't do anymore", 'i used to but',
    ],
  };

  // Goal/Plan patterns - for future aspirations
  private readonly goalPatterns = {
    want: ['i want to', 'i wanna', "i'd like to", 'id like to', 'i wish i could', 'i hope to'],
    plan: ['i plan to', "i'm planning", 'im planning', 'my plan is', "i'm going to", 'im going to'],
    goal: ['my goal is', "i'm trying to", 'im trying to', "i'm working on", 'im working on', 'my dream is'],
    saving: ["i'm saving for", 'im saving for', "i'm saving up", 'im saving up'],
    looking: ["i'm looking for", 'im looking for', "i'm searching for", 'im searching for', 'i need to find'],
  };

  // Hobby patterns - for activities and interests
  private readonly hobbyPatterns = {
    active_hobby: [
      'i play', 'i practice', 'i do', 'my hobby is', 'i spend time',
      'in my free time', 'on my days off', 'for fun i', 'i collect',
    ],
    watching: ['i watch', "i'm watching", 'im watching', 'i binge', "i've been watching", 'ive been watching'],
    reading: ['i read', "i'm reading", 'im reading', "i've been reading", 'ive been reading', 'my favorite book'],
    gaming: ['i play', "i'm playing", 'im playing', 'my favorite game', 'i game', 'i main'],
    music: ['i listen to', "i'm listening to", 'im listening to', 'my favorite song', 'my favorite artist', 'my favorite band'],
  };

  // ============================================================================
  // EMOTIONAL_PATTERN EXTRACTION PATTERNS
  // Per AI_PIPELINE.md §12.3.1 - Format: emotion:<pattern_id>
  // pattern_id (v0.1): baseline_mood, stress_trigger_school, stress_trigger_work,
  //                    coping_preference, social_energy
  // ============================================================================

  // Baseline mood patterns - general emotional disposition
  private readonly emotionalPatterns = {
    baseline_mood: {
      positive: [
        "i'm usually happy", 'im usually happy', "i'm generally happy", 'im generally happy',
        "i'm a happy person", 'im a happy person', "i'm an optimistic person", 'im an optimistic person',
        "i'm pretty cheerful", 'im pretty cheerful', "i'm a positive person", 'im a positive person',
        "i'm usually in a good mood", 'im usually in a good mood', "i'm a cheerful person", 'im a cheerful person',
        'i tend to be happy', 'i tend to be optimistic', 'i have a positive outlook',
        "i'm often happy", 'im often happy', "i'm generally optimistic", 'im generally optimistic',
        // Korean
        '보통 행복', '긍정적인 편', '밝은 편',
      ],
      negative: [
        "i'm usually sad", 'im usually sad', "i'm generally anxious", 'im generally anxious',
        "i'm a pessimistic person", 'im a pessimistic person', "i'm often stressed", 'im often stressed',
        "i'm usually worried", 'im usually worried', "i'm a nervous person", 'im a nervous person',
        "i'm often anxious", 'im often anxious', "i'm pretty anxious", 'im pretty anxious',
        "i'm always stressed", 'im always stressed', "i'm always worried", 'im always worried',
        "i'm a worrier", 'im a worrier', 'i tend to be anxious', 'i tend to worry',
        "i'm often depressed", 'im often depressed', "i'm usually down", 'im usually down',
        // Korean
        '우울한 편', '불안한 편', '걱정이 많', '스트레스 많',
      ],
      neutral: [
        "i'm usually calm", 'im usually calm', "i'm generally chill", 'im generally chill',
        "i'm a laid back person", 'im a laid back person', "i'm pretty relaxed", 'im pretty relaxed',
        "i'm even-keeled", 'im even-keeled', "i'm emotionally stable", 'im emotionally stable',
        "i'm usually mellow", 'im usually mellow', "i'm a calm person", 'im a calm person',
        // Korean
        '차분한 편', '침착한 편',
      ],
    },

    // Stress triggers related to school/academics
    stress_trigger_school: [
      // Direct stress mentions
      "school stresses me", 'school makes me stressed', 'school makes me anxious',
      "i get stressed about school", 'i get anxious about school',
      'i stress about exams', 'i stress about tests', 'i stress about grades',
      'exams make me anxious', 'tests make me anxious', 'grades make me anxious',
      "i'm stressed about homework", 'im stressed about homework',
      "i'm stressed about my grades", 'im stressed about my grades',
      "i'm stressed about assignments", 'im stressed about assignments',
      // Worry patterns
      'i worry about school', 'i worry about my grades', 'i worry about exams',
      'i worry about failing', 'school gives me anxiety', 'exams give me anxiety',
      // Struggle patterns
      "i'm struggling in school", 'im struggling in school',
      "i'm struggling with school", 'im struggling with school',
      'school is overwhelming', 'classes are overwhelming',
      // Korean
      '학교 스트레스', '시험 스트레스', '학업 스트레스', '성적 걱정',
    ],

    // Stress triggers related to work/career
    stress_trigger_work: [
      // Direct stress mentions
      "work stresses me", 'work makes me stressed', 'work makes me anxious',
      "i get stressed about work", 'i get anxious about work',
      'my job stresses me', 'my job makes me stressed',
      "i'm stressed about work", 'im stressed about work',
      "i'm stressed about my job", 'im stressed about my job',
      // Boss/colleagues
      'my boss stresses me', 'my manager stresses me', 'my boss makes me anxious',
      "i'm stressed about my boss", 'im stressed about my boss',
      // Deadlines/projects
      'deadlines stress me', 'deadlines make me anxious',
      "i'm stressed about deadlines", 'im stressed about deadlines',
      "i'm stressed about projects", 'im stressed about projects',
      // Work-life balance
      'work is overwhelming', 'too much work stress',
      'i worry about work', 'work gives me anxiety',
      // Korean
      '직장 스트레스', '일 스트레스', '업무 스트레스', '회사 스트레스',
    ],

    // Coping mechanisms and preferences
    coping_preference: {
      social: [
        'i talk to friends when stressed', 'i vent to friends',
        'talking helps me destress', 'i talk it out',
        'i call someone when stressed', 'i text friends when anxious',
        'i need to talk to someone', 'talking makes me feel better',
        'i cope by talking', 'sharing helps me cope',
        // Korean
        '친구한테 말해', '얘기하면 풀려',
      ],
      solitary: [
        'i need alone time', 'i need space when stressed',
        'i like being alone when stressed', 'i cope alone',
        'i prefer to be by myself', 'i need time alone',
        'i deal with stress alone', 'i process things alone',
        // Korean
        '혼자 있으면 풀려', '혼자 시간 필요',
      ],
      active: [
        'i exercise when stressed', 'i work out when anxious',
        'i go to the gym when stressed', 'i run when stressed',
        'exercise helps me destress', 'working out helps me cope',
        'i cope by exercising', 'physical activity helps',
        // Korean
        '운동하면 풀려', '운동으로 스트레스 해소',
      ],
      creative: [
        'i draw when stressed', 'i write when stressed',
        'i make music when anxious', 'i paint when stressed',
        'creating helps me destress', 'art helps me cope',
        'i cope by creating', 'creative activities help',
        // Korean
        '그림 그리면 풀려', '글 쓰면 풀려',
      ],
      relaxation: [
        'i sleep when stressed', 'i nap when anxious',
        'i meditate when stressed', 'i do yoga when stressed',
        'i take a bath when stressed', 'i relax when stressed',
        'meditation helps me', 'deep breathing helps',
        'i watch tv to destress', 'i watch shows to relax',
        'i play games to destress', 'gaming helps me relax',
        'i listen to music to destress', 'music helps me calm down',
        // Korean
        '자면 풀려', '명상하면 풀려', '음악 들으면 풀려',
      ],
      eating: [
        'i eat when stressed', 'i stress eat',
        'eating helps me cope', 'food makes me feel better',
        'i snack when anxious', 'comfort food helps',
        // Korean
        '먹으면 풀려', '스트레스 받으면 먹어',
      ],
    },

    // Social energy patterns - introvert/extrovert (only if explicitly stated)
    social_energy: {
      introvert: [
        "i'm an introvert", 'im an introvert', "i'm introverted", 'im introverted',
        "i'm a total introvert", 'im a total introvert',
        "i'm very introverted", 'im very introverted',
        "i'm pretty introverted", 'im pretty introverted',
        'i consider myself an introvert', 'i identify as an introvert',
        // Korean
        '나 인트로버트', '나는 내향적',
      ],
      extrovert: [
        "i'm an extrovert", 'im an extrovert', "i'm extroverted", 'im extroverted',
        "i'm a total extrovert", 'im a total extrovert',
        "i'm very extroverted", 'im very extroverted',
        "i'm pretty extroverted", 'im pretty extroverted',
        'i consider myself an extrovert', 'i identify as an extrovert',
        // Korean
        '나 엑스트로버트', '나는 외향적',
      ],
      ambivert: [
        "i'm an ambivert", 'im an ambivert',
        "i'm somewhere in between", 'im somewhere in between',
        "i'm both introverted and extroverted", 'im both introverted and extroverted',
        'depends on my mood', 'it depends on the situation',
        // Korean
        '나 앰비버트', '상황에 따라 달라',
      ],
    },

    // Additional emotional patterns - anxiety triggers, happiness triggers
    anxiety_triggers: [
      // General anxiety patterns
      'i get anxious when', 'i feel anxious about', 'i have anxiety about',
      'makes me anxious', 'gives me anxiety', 'triggers my anxiety',
      "i'm anxious about", 'im anxious about',
      // Specific common triggers
      'social situations make me anxious', 'crowds make me anxious',
      'public speaking makes me anxious', 'meeting new people makes me anxious',
      'i get anxious around people', 'i have social anxiety',
      // Korean
      '불안해', '걱정돼', '떨려',
    ],

    happiness_triggers: [
      // General happiness patterns
      'i feel happy when', 'i get happy when', 'makes me happy',
      'i love when', 'nothing makes me happier than',
      'i feel good when', 'i feel great when',
      // Korean
      '행복해질 때', '기분 좋아질 때',
    ],
  };

  // Food-related keywords for preference categorization (expanded)
  private readonly foodKeywords = [
    'pizza', 'sushi', 'burger', 'pasta', 'ramen', 'noodles', 'rice', 'soup', 'salad',
    'korean food', 'chinese food', 'mexican food', 'thai food', 'indian food', 'japanese food',
    'italian food', 'american food', 'vietnamese food', 'french food',
    'breakfast', 'lunch', 'dinner', 'brunch', 'snack', 'dessert',
    'coffee', 'tea', 'boba', 'bubble tea', 'milk tea', 'juice', 'smoothie', 'soda',
    'ice cream', 'chocolate', 'cake', 'cookies', 'fruit', 'vegetable', 'meat', 'seafood',
    'chicken', 'beef', 'pork', 'fish', 'shrimp', 'tofu', 'egg',
    'bread', 'sandwich', 'wrap', 'taco', 'burrito', 'wings', 'fries',
    'steak', 'bbq', 'fried rice', 'curry', 'pho', 'bibimbap', 'kimchi',
    // Korean
    '치킨', '피자', '라면', '삼겹살', '불고기', '김치찌개', '떡볶이', '순대',
  ];

  // Activity keywords for hobby categorization
  private readonly activityKeywords = {
    sports: ['soccer', 'football', 'basketball', 'baseball', 'tennis', 'golf', 'swimming', 'running', 'hiking', 'cycling', 'yoga', 'gym', 'workout', 'volleyball', 'badminton', '축구', '농구', '야구', '테니스'],
    gaming: ['game', 'games', 'gaming', 'video game', 'pc', 'console', 'playstation', 'xbox', 'nintendo', 'switch', 'lol', 'valorant', 'minecraft', 'fortnite', '게임', '롤', '발로란트'],
    music: ['music', 'song', 'album', 'band', 'artist', 'concert', 'kpop', 'k-pop', 'hip hop', 'rock', 'pop', 'jazz', 'classical', '음악', '노래', '케이팝'],
    movies_tv: ['movie', 'film', 'show', 'series', 'drama', 'kdrama', 'k-drama', 'anime', 'netflix', 'disney', 'marvel', '영화', '드라마', '애니메이션'],
    reading: ['book', 'novel', 'manga', 'comic', 'webtoon', 'reading', '책', '만화', '웹툰'],
    art: ['drawing', 'painting', 'art', 'sketch', 'photography', 'photo', '그림', '사진'],
    cooking: ['cooking', 'baking', 'recipe', 'cook', 'bake', '요리', '베이킹'],
    travel: ['travel', 'trip', 'vacation', 'flight', 'hotel', '여행', '휴가'],
  };

  // Correction trigger patterns per AI_PIPELINE.md §12.4
  private readonly correctionPatterns = {
    invalidate: [
      "that's not true", "thats not true", "not true", "wrong",
      "don't remember that", "dont remember that", "forget that",
    ],
    suppress_topic: [
      "don't bring this topic up again", "dont bring this topic up again",
      "don't mention", "dont mention",
    ],
  };

  constructor(
    private prisma: PrismaService,
    private vectorService: VectorService,
  ) {}

  /**
   * Extract memory candidates from user message using HEURISTICS ONLY.
   * 
   * Per AI_PIPELINE.md §12.2:
   * "Run heuristic extractor always."
   * 
   * Per task requirement:
   * "Determinism: Do NOT call any LLM or external service for memory extraction."
   * 
   * EXPANDED: Now attempts to extract all types of memories regardless of trigger flags,
   * to maximize capture of user information.
   * 
   * @param input - User message and heuristic flags
   * @returns Array of memory candidates
   */
  extractMemoryCandidates(input: ExtractionInput): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];
    const textLower = input.normNoPunct.toLowerCase();

    // ALWAYS try to extract all types of memories for comprehensive capture
    // The heuristic flags are now just hints, but we extract regardless

    // Extract preferences (likes, dislikes)
    const prefCandidates = this.extractPreferences(textLower, input.userMessage);
    candidates.push(...prefCandidates);

    // Extract facts (personal information)
    const factCandidates = this.extractFacts(textLower, input.userMessage);
    candidates.push(...factCandidates);

    // Extract events (life events, milestones, struggles)
    const eventCandidates = this.extractEvents(textLower, input.userMessage);
    candidates.push(...eventCandidates);

    // Extract goals and plans
    const goalCandidates = this.extractGoals(textLower, input.userMessage);
    candidates.push(...goalCandidates);

    // Extract hobbies and activities
    const hobbyCandidates = this.extractHobbies(textLower, input.userMessage);
    candidates.push(...hobbyCandidates);

    // Extract emotional patterns (baseline mood, stress triggers, coping, social energy)
    const emotionalCandidates = this.extractEmotionalPatterns(textLower, input.userMessage);
    candidates.push(...emotionalCandidates);

    // Deduplicate candidates by memoryKey
    const uniqueCandidates = this.deduplicateCandidates(candidates);

    return uniqueCandidates;
  }

  /**
   * Deduplicate memory candidates by memoryKey, keeping the highest confidence one.
   */
  private deduplicateCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
    const seen = new Map<string, MemoryCandidate>();
    for (const candidate of candidates) {
      const existing = seen.get(candidate.memoryKey);
      if (!existing || candidate.confidence > existing.confidence) {
        seen.set(candidate.memoryKey, candidate);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Extract PREFERENCE memories from text.
   * 
   * Per AI_PIPELINE.md §12.3.1:
   * Format: pref:<category>:<item_slug>
   * Categories: food, drink, music, movie, game, sport, hobby, etc.
   * 
   * Per AI_PIPELINE.md §12.3.2:
   * "PREFERENCE memory_value MUST be like|<value> or dislike|<value>."
   * 
   * EXPANDED: Now extracts multiple preferences per message and handles more patterns.
   */
  private extractPreferences(textLower: string, originalMessage: string): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    // Check for "like" patterns - extract ALL matches, not just first
    for (const pattern of this.preferencePatterns.like) {
      let searchStart = 0;
      let patternIndex = textLower.indexOf(pattern, searchStart);
      
      while (patternIndex !== -1) {
        const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
        const item = this.extractPreferenceItem(afterPattern);
        if (item && item.length >= 2) { // Minimum 2 chars for meaningful preference
          const category = this.categorizeItem(item);
          const slug = this.slugify(item);
          candidates.push({
            type: 'PREFERENCE',
            memoryKey: `pref:${category}:${slug}`,
            memoryValue: `like|${item}`,
            confidence: this.HEURISTIC_CONFIDENCE,
          });
        }
        searchStart = patternIndex + pattern.length;
        patternIndex = textLower.indexOf(pattern, searchStart);
      }
    }

    // Check for "dislike" patterns - extract ALL matches
    for (const pattern of this.preferencePatterns.dislike) {
      let searchStart = 0;
      let patternIndex = textLower.indexOf(pattern, searchStart);
      
      while (patternIndex !== -1) {
        const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
        const item = this.extractPreferenceItem(afterPattern);
        if (item && item.length >= 2) {
          const category = this.categorizeItem(item);
          const slug = this.slugify(item);
          candidates.push({
            type: 'PREFERENCE',
            memoryKey: `pref:${category}:${slug}`,
            memoryValue: `dislike|${item}`,
            confidence: this.HEURISTIC_CONFIDENCE,
          });
        }
        searchStart = patternIndex + pattern.length;
        patternIndex = textLower.indexOf(pattern, searchStart);
      }
    }

    return candidates;
  }

  /**
   * Extract a preference item from text (more generous than extractFirstItem).
   * Allows up to 5 words for multi-word preferences like "korean fried chicken".
   */
  private extractPreferenceItem(text: string): string | null {
    const cleaned = text.replace(/^[\s,.:;]+/, '').trim();
    const stopWords = ['and', 'but', 'because', 'so', 'when', 'if', 'or', 'too', 'also', 'really', 'very', 'much'];
    const words = cleaned.split(/\s+/);
    const itemWords: string[] = [];
    
    for (const word of words) {
      const cleanWord = word.replace(/[.,!?;:'"()]$/g, '').toLowerCase();
      if (stopWords.includes(cleanWord) || word.match(/[.,!?;:]$/)) {
        if (itemWords.length > 0) break;
        continue;
      }
      itemWords.push(cleanWord);
      // Allow up to 5 words for phrases like "korean fried chicken" or "playing video games"
      if (itemWords.length >= 5) break;
    }
    
    const item = itemWords.join(' ').trim();
    return item.length > 0 ? item : null;
  }

  /**
   * Extract FACT memories from text.
   * 
   * Per AI_PIPELINE.md §12.3.1:
   * FACT keys: fact:home_country, fact:home_city, fact:current_city, 
   * fact:timezone, fact:occupation, fact:school, fact:major, fact:language_primary
   * 
   * Extended with: fact:workplace, fact:birthday, fact:pet_dog, fact:pet_cat,
   * fact:family_mom, fact:family_dad, fact:family_sibling
   */
  private extractFacts(textLower: string, originalMessage: string): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    // Helper function to extract from patterns
    const extractFromPatterns = (patterns: string[], factKey: string): boolean => {
      for (const pattern of patterns) {
        const patternIndex = textLower.indexOf(pattern);
        if (patternIndex !== -1) {
          const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
          const value = this.extractFirstItem(afterPattern);
          if (value && value.length > 0) {
            candidates.push({
              type: 'FACT',
              memoryKey: `fact:${factKey}`,
              memoryValue: value,
              confidence: this.HEURISTIC_CONFIDENCE,
            });
            return true;
          }
        }
      }
      return false;
    };

    // Check for home_country patterns
    extractFromPatterns(this.factPatterns.home_country, 'home_country');

    // Check for current_city patterns
    extractFromPatterns(this.factPatterns.current_city, 'current_city');

    // Check for occupation patterns (role-based: "I'm a developer")
    extractFromPatterns(this.factPatterns.occupation, 'occupation');

    // Check for workplace patterns (company: "I work at Google")
    extractFromPatterns(this.factPatterns.workplace, 'workplace');

    // Check for school patterns
    extractFromPatterns(this.factPatterns.school, 'school');

    // Check for major patterns
    extractFromPatterns(this.factPatterns.major, 'major');

    // Check for birthday patterns
    extractFromPatterns(this.factPatterns.birthday, 'birthday');

    // Check for pet patterns
    extractFromPatterns(this.factPatterns.pet_dog, 'pet_dog');
    extractFromPatterns(this.factPatterns.pet_cat, 'pet_cat');
    extractFromPatterns(this.factPatterns.pet_generic, 'pet');

    // Check for family patterns
    extractFromPatterns(this.factPatterns.family_mom, 'family_mom');
    extractFromPatterns(this.factPatterns.family_dad, 'family_dad');
    extractFromPatterns(this.factPatterns.family_sibling, 'family_sibling');

    return candidates;
  }

  /**
   * Extract RELATIONSHIP_EVENT memories from text.
   * Basic implementation for v0.1 - minimal event detection.
   * 
   * Per AI_PIPELINE.md §12.3.1:
   * Format: event:<domain>:<yyyy_mm>:<event_slug>
   * Domains (v0.1): school, work, travel, relationship, family, health, other
   */
  /**
   * Extract RELATIONSHIP_EVENT memories from text.
   * 
   * Per AI_PIPELINE.md §12.3.1:
   * Format: event:<domain>:<yyyy_mm>:<event_slug>
   * Domains: school, work, travel, relationship, family, health, achievement, other
   * 
   * EXPANDED: Full implementation to capture life events, milestones, struggles, etc.
   */
  private extractEvents(textLower: string, originalMessage: string): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];
    const currentDate = new Date();
    const dateSlug = `${currentDate.getFullYear()}_${String(currentDate.getMonth() + 1).padStart(2, '0')}`;

    // Helper to extract event content and create candidate
    const extractEventFromPatterns = (patterns: string[], domain: string, eventType: string): void => {
      for (const pattern of patterns) {
        const patternIndex = textLower.indexOf(pattern);
        if (patternIndex !== -1) {
          const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
          const eventContent = this.extractEventContent(afterPattern);
          if (eventContent && eventContent.length >= 3) {
            const slug = this.slugify(`${eventType}_${eventContent}`);
            candidates.push({
              type: 'RELATIONSHIP_EVENT',
              memoryKey: `event:${domain}:${dateSlug}:${slug}`,
              memoryValue: `${eventType}|${pattern} ${eventContent}`,
              confidence: this.HEURISTIC_CONFIDENCE,
            });
          }
        }
      }
    };

    // Extract past events
    extractEventFromPatterns(this.eventPatterns.past_event, 'other', 'past');
    
    // Extract upcoming events
    extractEventFromPatterns(this.eventPatterns.upcoming_event, 'other', 'upcoming');
    
    // Extract milestones (achievements)
    extractEventFromPatterns(this.eventPatterns.milestone, 'achievement', 'milestone');
    
    // Extract struggles/challenges
    extractEventFromPatterns(this.eventPatterns.struggle, 'other', 'struggle');
    
    // Extract started activities
    extractEventFromPatterns(this.eventPatterns.started, 'other', 'started');
    
    // Extract stopped activities
    extractEventFromPatterns(this.eventPatterns.stopped, 'other', 'stopped');

    return candidates;
  }

  /**
   * Extract content following an event pattern.
   * More generous extraction - allows longer phrases for event descriptions.
   */
  private extractEventContent(text: string): string | null {
    const cleaned = text.replace(/^[\s,.:;]+/, '').trim();
    const endMarkers = ['.', '!', '?', ',', ';'];
    
    // Find the first sentence-ending marker
    let endIndex = cleaned.length;
    for (const marker of endMarkers) {
      const idx = cleaned.indexOf(marker);
      if (idx !== -1 && idx < endIndex) {
        endIndex = idx;
      }
    }
    
    const content = cleaned.substring(0, endIndex).trim();
    
    // Limit to 10 words max
    const words = content.split(/\s+/).slice(0, 10);
    const result = words.join(' ').toLowerCase();
    
    return result.length > 0 ? result : null;
  }

  /**
   * Extract goal/plan memories from text.
   * 
   * Format: goal:<category>:<goal_slug>
   * Categories: career, personal, financial, health, education, relationship
   */
  private extractGoals(textLower: string, originalMessage: string): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    const extractGoalFromPatterns = (patterns: string[], goalType: string): void => {
      for (const pattern of patterns) {
        const patternIndex = textLower.indexOf(pattern);
        if (patternIndex !== -1) {
          const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
          const goalContent = this.extractEventContent(afterPattern);
          if (goalContent && goalContent.length >= 3) {
            const category = this.categorizeGoal(goalContent);
            const slug = this.slugify(goalContent);
            candidates.push({
              type: 'PREFERENCE', // Using PREFERENCE type for goals as it's similar in nature
              memoryKey: `goal:${category}:${slug}`,
              memoryValue: `${goalType}|${goalContent}`,
              confidence: this.HEURISTIC_CONFIDENCE,
            });
          }
        }
      }
    };

    // Extract wants/desires
    extractGoalFromPatterns(this.goalPatterns.want, 'want');
    
    // Extract plans
    extractGoalFromPatterns(this.goalPatterns.plan, 'plan');
    
    // Extract goals
    extractGoalFromPatterns(this.goalPatterns.goal, 'goal');
    
    // Extract savings goals
    extractGoalFromPatterns(this.goalPatterns.saving, 'saving');
    
    // Extract searches/needs
    extractGoalFromPatterns(this.goalPatterns.looking, 'looking');

    return candidates;
  }

  /**
   * Categorize a goal into a category.
   */
  private categorizeGoal(goal: string): string {
    const goalLower = goal.toLowerCase();
    
    const careerKeywords = ['job', 'work', 'career', 'promotion', 'salary', 'boss', 'company', 'business'];
    const healthKeywords = ['weight', 'gym', 'exercise', 'health', 'diet', 'sleep', 'run', 'workout'];
    const educationKeywords = ['study', 'learn', 'school', 'degree', 'exam', 'course', 'skill'];
    const financialKeywords = ['money', 'save', 'buy', 'afford', 'invest', 'pay', 'debt'];
    const relationshipKeywords = ['date', 'marry', 'friend', 'relationship', 'meet', 'social'];
    
    if (careerKeywords.some(kw => goalLower.includes(kw))) return 'career';
    if (healthKeywords.some(kw => goalLower.includes(kw))) return 'health';
    if (educationKeywords.some(kw => goalLower.includes(kw))) return 'education';
    if (financialKeywords.some(kw => goalLower.includes(kw))) return 'financial';
    if (relationshipKeywords.some(kw => goalLower.includes(kw))) return 'relationship';
    
    return 'personal';
  }

  /**
   * Extract hobby/activity memories from text.
   * 
   * Format: hobby:<category>:<hobby_slug>
   */
  private extractHobbies(textLower: string, originalMessage: string): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    const extractHobbyFromPatterns = (patterns: string[], hobbyType: string): void => {
      for (const pattern of patterns) {
        const patternIndex = textLower.indexOf(pattern);
        if (patternIndex !== -1) {
          const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
          const hobbyContent = this.extractPreferenceItem(afterPattern);
          if (hobbyContent && hobbyContent.length >= 2) {
            const category = this.categorizeActivity(hobbyContent);
            const slug = this.slugify(hobbyContent);
            candidates.push({
              type: 'PREFERENCE',
              memoryKey: `hobby:${category}:${slug}`,
              memoryValue: `${hobbyType}|${hobbyContent}`,
              confidence: this.HEURISTIC_CONFIDENCE,
            });
          }
        }
      }
    };

    // Extract active hobbies
    extractHobbyFromPatterns(this.hobbyPatterns.active_hobby, 'does');
    
    // Extract watching habits
    extractHobbyFromPatterns(this.hobbyPatterns.watching, 'watches');
    
    // Extract reading habits
    extractHobbyFromPatterns(this.hobbyPatterns.reading, 'reads');
    
    // Extract gaming
    extractHobbyFromPatterns(this.hobbyPatterns.gaming, 'plays');
    
    // Extract music listening
    extractHobbyFromPatterns(this.hobbyPatterns.music, 'listens');

    return candidates;
  }

  /**
   * Extract EMOTIONAL_PATTERN memories from text.
   * 
   * Per AI_PIPELINE.md §12.3.1:
   * Format: emotion:<pattern_id>
   * pattern_id (v0.1): baseline_mood, stress_trigger_school, stress_trigger_work,
   *                    coping_preference, social_energy
   * 
   * EMOTIONAL_PATTERN memories are singleton-ish summaries about the user's
   * emotional disposition, stress triggers, and coping mechanisms.
   */
  private extractEmotionalPatterns(textLower: string, originalMessage: string): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    // -------------------------------------------------------------------------
    // 1. Baseline Mood Detection
    // -------------------------------------------------------------------------
    
    // Check for positive baseline mood
    for (const pattern of this.emotionalPatterns.baseline_mood.positive) {
      if (textLower.includes(pattern)) {
        candidates.push({
          type: 'EMOTIONAL_PATTERN',
          memoryKey: 'emotion:baseline_mood',
          memoryValue: 'positive|generally optimistic and happy',
          confidence: this.HEURISTIC_CONFIDENCE,
        });
        break; // Only one baseline mood
      }
    }

    // Check for negative baseline mood (only if no positive found)
    if (!candidates.some(c => c.memoryKey === 'emotion:baseline_mood')) {
      for (const pattern of this.emotionalPatterns.baseline_mood.negative) {
        if (textLower.includes(pattern)) {
          candidates.push({
            type: 'EMOTIONAL_PATTERN',
            memoryKey: 'emotion:baseline_mood',
            memoryValue: 'negative|tends toward anxiety or low mood',
            confidence: this.HEURISTIC_CONFIDENCE,
          });
          break;
        }
      }
    }

    // Check for neutral/calm baseline mood
    if (!candidates.some(c => c.memoryKey === 'emotion:baseline_mood')) {
      for (const pattern of this.emotionalPatterns.baseline_mood.neutral) {
        if (textLower.includes(pattern)) {
          candidates.push({
            type: 'EMOTIONAL_PATTERN',
            memoryKey: 'emotion:baseline_mood',
            memoryValue: 'neutral|generally calm and stable',
            confidence: this.HEURISTIC_CONFIDENCE,
          });
          break;
        }
      }
    }

    // -------------------------------------------------------------------------
    // 2. Stress Trigger Detection - School
    // -------------------------------------------------------------------------
    
    for (const pattern of this.emotionalPatterns.stress_trigger_school) {
      if (textLower.includes(pattern)) {
        // Extract what specifically triggers stress if possible
        const afterPattern = textLower.substring(textLower.indexOf(pattern) + pattern.length).trim();
        const triggerDetail = this.extractStressTriggerDetail(afterPattern) || 'academic pressure';
        
        candidates.push({
          type: 'EMOTIONAL_PATTERN',
          memoryKey: 'emotion:stress_trigger_school',
          memoryValue: `school_stress|${triggerDetail}`,
          confidence: this.HEURISTIC_CONFIDENCE,
        });
        break; // One school stress trigger per message
      }
    }

    // -------------------------------------------------------------------------
    // 3. Stress Trigger Detection - Work
    // -------------------------------------------------------------------------
    
    for (const pattern of this.emotionalPatterns.stress_trigger_work) {
      if (textLower.includes(pattern)) {
        const afterPattern = textLower.substring(textLower.indexOf(pattern) + pattern.length).trim();
        const triggerDetail = this.extractStressTriggerDetail(afterPattern) || 'work pressure';
        
        candidates.push({
          type: 'EMOTIONAL_PATTERN',
          memoryKey: 'emotion:stress_trigger_work',
          memoryValue: `work_stress|${triggerDetail}`,
          confidence: this.HEURISTIC_CONFIDENCE,
        });
        break;
      }
    }

    // -------------------------------------------------------------------------
    // 4. Coping Preference Detection
    // -------------------------------------------------------------------------
    
    // Check social coping
    for (const pattern of this.emotionalPatterns.coping_preference.social) {
      if (textLower.includes(pattern)) {
        candidates.push({
          type: 'EMOTIONAL_PATTERN',
          memoryKey: 'emotion:coping_preference',
          memoryValue: 'social|prefers talking to others when stressed',
          confidence: this.HEURISTIC_CONFIDENCE,
        });
        break;
      }
    }

    // Check solitary coping (only if no coping found yet)
    if (!candidates.some(c => c.memoryKey === 'emotion:coping_preference')) {
      for (const pattern of this.emotionalPatterns.coping_preference.solitary) {
        if (textLower.includes(pattern)) {
          candidates.push({
            type: 'EMOTIONAL_PATTERN',
            memoryKey: 'emotion:coping_preference',
            memoryValue: 'solitary|prefers alone time when stressed',
            confidence: this.HEURISTIC_CONFIDENCE,
          });
          break;
        }
      }
    }

    // Check active coping
    if (!candidates.some(c => c.memoryKey === 'emotion:coping_preference')) {
      for (const pattern of this.emotionalPatterns.coping_preference.active) {
        if (textLower.includes(pattern)) {
          candidates.push({
            type: 'EMOTIONAL_PATTERN',
            memoryKey: 'emotion:coping_preference',
            memoryValue: 'active|uses exercise/physical activity to cope',
            confidence: this.HEURISTIC_CONFIDENCE,
          });
          break;
        }
      }
    }

    // Check creative coping
    if (!candidates.some(c => c.memoryKey === 'emotion:coping_preference')) {
      for (const pattern of this.emotionalPatterns.coping_preference.creative) {
        if (textLower.includes(pattern)) {
          candidates.push({
            type: 'EMOTIONAL_PATTERN',
            memoryKey: 'emotion:coping_preference',
            memoryValue: 'creative|uses creative activities to cope',
            confidence: this.HEURISTIC_CONFIDENCE,
          });
          break;
        }
      }
    }

    // Check relaxation coping
    if (!candidates.some(c => c.memoryKey === 'emotion:coping_preference')) {
      for (const pattern of this.emotionalPatterns.coping_preference.relaxation) {
        if (textLower.includes(pattern)) {
          candidates.push({
            type: 'EMOTIONAL_PATTERN',
            memoryKey: 'emotion:coping_preference',
            memoryValue: 'relaxation|uses relaxation activities to cope',
            confidence: this.HEURISTIC_CONFIDENCE,
          });
          break;
        }
      }
    }

    // Check eating coping
    if (!candidates.some(c => c.memoryKey === 'emotion:coping_preference')) {
      for (const pattern of this.emotionalPatterns.coping_preference.eating) {
        if (textLower.includes(pattern)) {
          candidates.push({
            type: 'EMOTIONAL_PATTERN',
            memoryKey: 'emotion:coping_preference',
            memoryValue: 'eating|tends to eat when stressed',
            confidence: this.HEURISTIC_CONFIDENCE,
          });
          break;
        }
      }
    }

    // -------------------------------------------------------------------------
    // 5. Social Energy Detection (Introvert/Extrovert/Ambivert)
    // Per spec: "only if user states explicitly"
    // -------------------------------------------------------------------------
    
    // Check for introvert
    for (const pattern of this.emotionalPatterns.social_energy.introvert) {
      if (textLower.includes(pattern)) {
        candidates.push({
          type: 'EMOTIONAL_PATTERN',
          memoryKey: 'emotion:social_energy',
          memoryValue: 'introvert|self-identifies as introverted',
          confidence: this.HEURISTIC_CONFIDENCE,
        });
        break;
      }
    }

    // Check for extrovert (only if no social_energy found)
    if (!candidates.some(c => c.memoryKey === 'emotion:social_energy')) {
      for (const pattern of this.emotionalPatterns.social_energy.extrovert) {
        if (textLower.includes(pattern)) {
          candidates.push({
            type: 'EMOTIONAL_PATTERN',
            memoryKey: 'emotion:social_energy',
            memoryValue: 'extrovert|self-identifies as extroverted',
            confidence: this.HEURISTIC_CONFIDENCE,
          });
          break;
        }
      }
    }

    // Check for ambivert
    if (!candidates.some(c => c.memoryKey === 'emotion:social_energy')) {
      for (const pattern of this.emotionalPatterns.social_energy.ambivert) {
        if (textLower.includes(pattern)) {
          candidates.push({
            type: 'EMOTIONAL_PATTERN',
            memoryKey: 'emotion:social_energy',
            memoryValue: 'ambivert|somewhere between introvert and extrovert',
            confidence: this.HEURISTIC_CONFIDENCE,
          });
          break;
        }
      }
    }

    // -------------------------------------------------------------------------
    // 6. Additional: Anxiety Triggers (specific things that cause anxiety)
    // -------------------------------------------------------------------------
    
    for (const pattern of this.emotionalPatterns.anxiety_triggers) {
      const patternIndex = textLower.indexOf(pattern);
      if (patternIndex !== -1) {
        const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
        const triggerContent = this.extractStressTriggerDetail(afterPattern);
        
        if (triggerContent && triggerContent.length >= 3) {
          const slug = this.slugify(triggerContent);
          candidates.push({
            type: 'EMOTIONAL_PATTERN',
            memoryKey: `emotion:anxiety_trigger:${slug}`,
            memoryValue: `anxiety|${triggerContent}`,
            confidence: this.HEURISTIC_CONFIDENCE,
          });
          break;
        }
      }
    }

    // -------------------------------------------------------------------------
    // 7. Additional: Happiness Triggers (specific things that make user happy)
    // -------------------------------------------------------------------------
    
    for (const pattern of this.emotionalPatterns.happiness_triggers) {
      const patternIndex = textLower.indexOf(pattern);
      if (patternIndex !== -1) {
        const afterPattern = textLower.substring(patternIndex + pattern.length).trim();
        const triggerContent = this.extractStressTriggerDetail(afterPattern);
        
        if (triggerContent && triggerContent.length >= 3) {
          const slug = this.slugify(triggerContent);
          candidates.push({
            type: 'EMOTIONAL_PATTERN',
            memoryKey: `emotion:happiness_trigger:${slug}`,
            memoryValue: `happiness|${triggerContent}`,
            confidence: this.HEURISTIC_CONFIDENCE,
          });
          break;
        }
      }
    }

    return candidates;
  }

  /**
   * Extract detail about a stress/anxiety/happiness trigger.
   * Takes the content after the trigger pattern and extracts meaningful detail.
   */
  private extractStressTriggerDetail(text: string): string | null {
    const cleaned = text.replace(/^[\s,.:;]+/, '').trim();
    
    // Stop at sentence boundaries or certain conjunctions
    const endMarkers = ['.', '!', '?', ',', 'and', 'but', 'because', 'so'];
    let endIndex = cleaned.length;
    
    for (const marker of endMarkers) {
      const idx = cleaned.indexOf(marker);
      if (idx !== -1 && idx < endIndex) {
        endIndex = idx;
      }
    }
    
    const content = cleaned.substring(0, endIndex).trim();
    
    // Limit to 8 words max
    const words = content.split(/\s+/).slice(0, 8);
    const result = words.join(' ').toLowerCase();
    
    return result.length > 2 ? result : null;
  }

  /**
   * Categorize an activity into a hobby category.
   */
  private categorizeActivity(activity: string): string {
    const activityLower = activity.toLowerCase();
    
    for (const [category, keywords] of Object.entries(this.activityKeywords)) {
      if (keywords.some(kw => activityLower.includes(kw))) {
        return category;
      }
    }
    
    return 'general';
  }

  /**
   * Extract the first meaningful item/noun from text.
   * Simple extraction - takes words until a sentence boundary or common stop words.
   */
  private extractFirstItem(text: string): string | null {
    // Remove leading punctuation and extra spaces
    const cleaned = text.replace(/^[\s,.:;]+/, '').trim();
    
    // Stop words that indicate end of item
    const stopWords = ['and', 'but', 'because', 'so', 'when', 'if', 'or', 'is', 'are', 'was', 'were'];
    
    // Split by spaces and take words until stop word or punctuation
    const words = cleaned.split(/\s+/);
    const itemWords: string[] = [];
    
    for (const word of words) {
      const cleanWord = word.replace(/[.,!?;:]$/, '').toLowerCase();
      if (stopWords.includes(cleanWord) || word.match(/[.,!?;:]$/)) {
        break;
      }
      itemWords.push(cleanWord);
      // Limit to 3 words for item extraction
      if (itemWords.length >= 3) {
        break;
      }
    }
    
    const item = itemWords.join(' ').trim();
    return item.length > 0 ? item : null;
  }

  /**
   * Categorize an item into preference categories.
   * Per AI_PIPELINE.md §12.3.1:
   * Categories (v0.1): food, drink, music, movie_genre, game, sport, hobby, study_style
   */
  /**
   * Categorize an item into preference categories.
   * 
   * Expanded categories: food, drink, music, movies_tv, gaming, sports, reading, 
   * art, cooking, travel, fashion, tech, animal, person, place, other
   */
  private categorizeItem(item: string): string {
    const itemLower = item.toLowerCase();
    
    // Check for food keywords
    if (this.foodKeywords.some(kw => itemLower.includes(kw) || kw.includes(itemLower))) {
      return 'food';
    }
    
    // Check for drink keywords
    const drinkKeywords = ['coffee', 'tea', 'boba', 'bubble tea', 'milk tea', 'drink', 'soda', 'juice', 'smoothie', 'beer', 'wine', 'cocktail', '커피', '차', '음료'];
    if (drinkKeywords.some(kw => itemLower.includes(kw))) {
      return 'drink';
    }
    
    // Check activity keywords from the expanded set
    for (const [category, keywords] of Object.entries(this.activityKeywords)) {
      if (keywords.some(kw => itemLower.includes(kw) || kw.includes(itemLower))) {
        return category;
      }
    }
    
    // Check for fashion keywords
    const fashionKeywords = ['clothes', 'fashion', 'outfit', 'style', 'dress', 'shirt', 'shoes', 'sneakers', 'brand', '옷', '패션'];
    if (fashionKeywords.some(kw => itemLower.includes(kw))) {
      return 'fashion';
    }
    
    // Check for tech keywords
    const techKeywords = ['phone', 'computer', 'laptop', 'tech', 'app', 'software', 'gadget', 'device', '폰', '컴퓨터'];
    if (techKeywords.some(kw => itemLower.includes(kw))) {
      return 'tech';
    }
    
    // Check for animal keywords
    const animalKeywords = ['dog', 'cat', 'pet', 'animal', 'puppy', 'kitten', 'bird', 'fish', '강아지', '고양이', '동물'];
    if (animalKeywords.some(kw => itemLower.includes(kw))) {
      return 'animal';
    }
    
    // Check for place keywords
    const placeKeywords = ['place', 'city', 'country', 'restaurant', 'cafe', 'park', 'beach', 'mountain', '장소', '도시', '나라'];
    if (placeKeywords.some(kw => itemLower.includes(kw))) {
      return 'place';
    }
    
    // Check for people/celebrity keywords
    const personKeywords = ['actor', 'actress', 'singer', 'idol', 'celebrity', 'youtuber', 'streamer', '배우', '가수', '아이돌'];
    if (personKeywords.some(kw => itemLower.includes(kw))) {
      return 'person';
    }
    
    // Check for season/weather keywords
    const seasonKeywords = ['summer', 'winter', 'spring', 'fall', 'autumn', 'rain', 'snow', 'weather', '여름', '겨울', '봄', '가을'];
    if (seasonKeywords.some(kw => itemLower.includes(kw))) {
      return 'season';
    }
    
    // Check for color keywords
    const colorKeywords = ['color', 'colour', 'red', 'blue', 'green', 'black', 'white', 'pink', 'purple', '색', '빨강', '파랑'];
    if (colorKeywords.some(kw => itemLower.includes(kw))) {
      return 'color';
    }
    
    // Default to general/other
    return 'other';
  }

  /**
   * Slugify an item per AI_PIPELINE.md §12.3.1:
   * - Unicode NFKC, trim
   * - replace spaces with underscores
   * - remove punctuation except underscores
   * - keep non-Latin characters (do NOT romanize)
   * - max length 48 chars; truncate deterministically
   */
  private slugify(item: string): string {
    let slug = item
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^\w가-힣ㄱ-ㅎㅏ-ㅣ_]/g, '')
      .toLowerCase();
    
    // Truncate to 48 chars
    if (slug.length > 48) {
      slug = slug.substring(0, 48);
    }
    
    return slug;
  }

  /**
   * Handle user correction command.
   * 
   * Per AI_PIPELINE.md §12.4 - Correction Targeting (Authoritative, v0.1):
   * "A correction command MUST target memories ONLY through surfaced_memory_ids
   * from the immediately previous assistant message."
   * "If surfaced_memory_ids is empty: do NOT invalidate anything"
   * 
   * @param input - Correction handling input
   * @returns CorrectionResult with invalidated memory IDs
   */
  async handleCorrection(input: CorrectionInput): Promise<CorrectionResult> {
    const result: CorrectionResult = {
      invalidated_memory_ids: [],
      needs_clarification: false,
      suppressed_keys_added: [],
    };

    // Only process if correction trigger detected
    if (!input.heuristicFlags.has_correction_trigger) {
      return result;
    }

    // Step 1: Find the immediately previous assistant message
    // Per AI_PIPELINE.md §12.4: "from the immediately previous assistant message"
    const prevAssistantMsg = await this.prisma.message.findFirst({
      where: {
        conversationId: input.conversationId,
        role: 'assistant',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        surfacedMemoryIds: true,
      },
    });

    // If no previous assistant message, need clarification
    if (!prevAssistantMsg) {
      result.needs_clarification = true;
      return result;
    }

    // Get surfaced_memory_ids from previous assistant message
    const surfacedIds = (prevAssistantMsg.surfacedMemoryIds as string[]) || [];

    // Per AI_PIPELINE.md §12.4:
    // "If surfaced_memory_ids is empty: do NOT invalidate anything"
    if (surfacedIds.length === 0) {
      result.needs_clarification = true;
      return result;
    }

    // Determine correction type
    const textLower = input.normNoPunct.toLowerCase();
    const isInvalidation = this.correctionPatterns.invalidate.some(p => textLower.includes(p));
    const isTopicSuppression = this.correctionPatterns.suppress_topic.some(p => textLower.includes(p));

    if (isInvalidation) {
      // Per AI_PIPELINE.md §12.4:
      // "Target = the LAST memory_id in surfaced_memory_ids (most recent mention)"
      const targetMemoryId = surfacedIds[surfacedIds.length - 1];

      // Fetch the memory to get its key
      const memories = await this.prisma.memory.findMany({
        where: {
          id: { in: [targetMemoryId] },
          status: 'ACTIVE',
        },
      });

      if (memories.length > 0) {
        const memory = memories[0];

        // Invalidate the memory
        await this.prisma.memory.update({
          where: { id: targetMemoryId },
          data: {
            status: 'INVALID',
            invalidReason: 'user_correction',
          },
        });

        // Per SCHEMA.md §D.1: Delete invalidated memory from Qdrant
        await this.vectorService.deleteMemory(targetMemoryId);

        result.invalidated_memory_ids.push(targetMemoryId);

        // If "don't remember that" / "forget that", also add to suppressed_memory_keys
        if (textLower.includes('remember') || textLower.includes('forget')) {
          await this.addToSuppressedMemoryKeys(input.userId, memory.memoryKey);
          result.suppressed_keys_added.push(memory.memoryKey);
        }
      }
    }

    return result;
  }

  /**
   * Add a memory key to user's suppressed_memory_keys.
   * 
   * Per AI_PIPELINE.md §12.4:
   * "add its memory_key to UserControls.suppressed_memory_keys"
   */
  private async addToSuppressedMemoryKeys(userId: string, memoryKey: string): Promise<void> {
    const userControls = await this.prisma.userControls.findUnique({
      where: { userId },
      select: { suppressedMemoryKeys: true },
    });

    const currentKeys = (userControls?.suppressedMemoryKeys as string[]) || [];
    
    if (!currentKeys.includes(memoryKey)) {
      await this.prisma.userControls.update({
        where: { userId },
        data: {
          suppressedMemoryKeys: [...currentKeys, memoryKey],
        },
      });
    }
  }

  /**
   * Select which memories to surface for the assistant response.
   * 
   * Per AI_PIPELINE.md §12.4:
   * "Each assistant message must store surfaced_memory_ids
   * (memory IDs actually referenced or used in the answer)."
   * 
   * For v0.1 MVP: Simple relevance matching based on user message keywords.
   * Full implementation would integrate with LLM response generation.
   * 
   * @param input - Surfacing selection input
   * @returns Array of memory IDs to surface (empty array if none relevant)
   */
  async selectMemoriesForSurfacing(input: SurfacingInput): Promise<string[]> {
    // Fetch ACTIVE memories for the user (excluding suppressed keys)
    const userControls = await this.prisma.userControls.findUnique({
      where: { userId: input.userId },
      select: { suppressedMemoryKeys: true },
    });
    
    const suppressedKeys = (userControls?.suppressedMemoryKeys as string[]) || [];

    const memories = await this.prisma.memory.findMany({
      where: {
        userId: input.userId,
        aiFriendId: input.aiFriendId,
        status: 'ACTIVE',
        memoryKey: {
          notIn: suppressedKeys.length > 0 ? suppressedKeys : undefined,
        },
      },
      select: {
        id: true,
        memoryKey: true,
        memoryValue: true,
        type: true,
      },
    });

    // For v0.1 MVP: Simple keyword matching
    // Return empty array if no memories (must be [] not null per task requirement)
    if (memories.length === 0) {
      return [];
    }

    // Simple relevance check: look for keyword matches in user message
    const userMsgLower = input.userMessage.toLowerCase();
    const relevantIds: string[] = [];

    for (const memory of memories) {
      // Extract item from memory key/value for matching
      const valueParts = memory.memoryValue.split('|');
      const item = valueParts.length > 1 ? valueParts[1] : memory.memoryValue;
      
      // Check if user message mentions this item
      if (item && userMsgLower.includes(item.toLowerCase())) {
        relevantIds.push(memory.id);
      }
    }

    // Per AI_PIPELINE.md §10.1:
    // "In normal chat: if personal_fact_count > 2... rewrite to reduce surfaced_memory_ids to at most 2"
    // For v0.1, limit to 2 surfaced memories max
    return relevantIds.slice(0, 2);
  }

  /**
   * Persist a memory candidate with dedup/conflict handling.
   * 
   * Per AI_PIPELINE.md §12.3:
   * - if key exists with same value (ACTIVE): merge sources; increase confidence by +0.15 (cap 1.0)
   * - if key exists with different value (ACTIVE): create new ACTIVE record, mark old as SUPERSEDED
   * 
   * Per SCHEMA.md §D.1: "After memory INSERT/UPDATE with status=ACTIVE, enqueue embedding job"
   * For v0.1 MVP, we do synchronous embedding via VectorService.
   * 
   * @param input - Persist input with candidate and context
   * @returns Created or updated memory ID
   */
  async persistMemoryCandidate(input: PersistInput): Promise<string> {
    const { userId, aiFriendId, messageId, candidate } = input;

    // Check for existing memory with same key
    const existingMemory = await this.prisma.memory.findFirst({
      where: {
        userId,
        aiFriendId,
        memoryKey: candidate.memoryKey,
        status: 'ACTIVE',
      },
    });

    if (existingMemory) {
      // Same key exists - check if same value
      if (existingMemory.memoryValue === candidate.memoryValue) {
        // Same key + same value → merge sources, increase confidence
        const newConfidence = Math.min(
          Number(existingMemory.confidence) + this.CONFIDENCE_INCREMENT,
          this.MAX_CONFIDENCE,
        );

        const sourceIds = (existingMemory.sourceMessageIds as string[]) || [];
        if (!sourceIds.includes(messageId)) {
          sourceIds.push(messageId);
        }

        await this.prisma.memory.update({
          where: { id: existingMemory.id },
          data: {
            confidence: newConfidence,
            sourceMessageIds: sourceIds,
            lastConfirmedAt: new Date(),
          },
        });

        return existingMemory.id;
      } else {
        // Same key + different value
        // For FACT keys: supersede old
        // For PREFERENCE keys with opposite stance: supersede old
        if (candidate.type === 'FACT' || this.isOppositeStance(existingMemory.memoryValue, candidate.memoryValue)) {
          // Create new memory
          const newMemory = await this.prisma.memory.create({
            data: {
              userId,
              aiFriendId,
              type: candidate.type,
              memoryKey: candidate.memoryKey,
              memoryValue: candidate.memoryValue,
              confidence: candidate.confidence,
              status: 'ACTIVE',
              sourceMessageIds: [messageId],
            },
          });

          // Mark old as SUPERSEDED and delete from vector store
          await this.prisma.memory.update({
            where: { id: existingMemory.id },
            data: {
              status: 'SUPERSEDED',
              supersededBy: newMemory.id,
            },
          });
          
          // Per SCHEMA.md §D.1: Delete superseded memory from Qdrant
          await this.vectorService.deleteMemory(existingMemory.id);

          // Index new memory in vector store
          const qdrantPointId = await this.vectorService.upsertMemory({
            memoryId: newMemory.id,
            userId,
            aiFriendId,
            memoryType: candidate.type,
            memoryKey: candidate.memoryKey,
            memoryValue: candidate.memoryValue,
            createdAt: newMemory.createdAt,
          });

          // Update memory with Qdrant point ID if indexing succeeded
          if (qdrantPointId) {
            await this.prisma.memory.update({
              where: { id: newMemory.id },
              data: { qdrantPointId },
            });
          }

          return newMemory.id;
        }
      }
    }

    // No existing memory - create new
    const newMemory = await this.prisma.memory.create({
      data: {
        userId,
        aiFriendId,
        type: candidate.type,
        memoryKey: candidate.memoryKey,
        memoryValue: candidate.memoryValue,
        confidence: candidate.confidence,
        status: 'ACTIVE',
        sourceMessageIds: [messageId],
      },
    });

    // Index new memory in vector store per SCHEMA.md §D.1
    const qdrantPointId = await this.vectorService.upsertMemory({
      memoryId: newMemory.id,
      userId,
      aiFriendId,
      memoryType: candidate.type,
      memoryKey: candidate.memoryKey,
      memoryValue: candidate.memoryValue,
      createdAt: newMemory.createdAt,
    });

    // Update memory with Qdrant point ID if indexing succeeded
    if (qdrantPointId) {
      await this.prisma.memory.update({
        where: { id: newMemory.id },
        data: { qdrantPointId },
      });
    }

    return newMemory.id;
  }

  /**
   * Check if two preference values have opposite stances.
   * Per AI_PIPELINE.md §12.3.2:
   * "PREFERENCE memory_value MUST be like|<value> or dislike|<value>"
   */
  private isOppositeStance(value1: string, value2: string): boolean {
    const stance1 = value1.startsWith('like|') ? 'like' : value1.startsWith('dislike|') ? 'dislike' : null;
    const stance2 = value2.startsWith('like|') ? 'like' : value2.startsWith('dislike|') ? 'dislike' : null;

    if (!stance1 || !stance2) {
      return false;
    }

    return stance1 !== stance2;
  }

  /**
   * Extract and persist all memory candidates from a user message.
   * This is the main entry point for memory extraction in the chat pipeline.
   * 
   * @param params - Extraction parameters
   * @returns Array of extracted memory IDs
   */
  async extractAndPersist(params: {
    userId: string;
    aiFriendId: string;
    messageId: string;
    userMessage: string;
    normNoPunct: string;
    heuristicFlags: HeuristicFlags;
  }): Promise<string[]> {
    const candidates = this.extractMemoryCandidates({
      userMessage: params.userMessage,
      normNoPunct: params.normNoPunct,
      heuristicFlags: params.heuristicFlags,
    });

    const extractedIds: string[] = [];

    for (const candidate of candidates) {
      const memoryId = await this.persistMemoryCandidate({
        userId: params.userId,
        aiFriendId: params.aiFriendId,
        messageId: params.messageId,
        candidate,
      });
      extractedIds.push(memoryId);
    }

    return extractedIds;
  }

  /**
   * Get memories by their IDs.
   * 
   * Used by ChatService to fetch memory details for LLM context.
   * Per AI_PIPELINE.md §9: "Memory snippets (limited; never dump many)"
   * 
   * @param memoryIds - Array of memory IDs to fetch
   * @returns Array of memory records with key and value
   */
  async getMemoriesByIds(memoryIds: string[]): Promise<Array<{
    id: string;
    memoryKey: string;
    memoryValue: string;
    type: string;
  }>> {
    if (memoryIds.length === 0) {
      return [];
    }

    const memories = await this.prisma.memory.findMany({
      where: {
        id: { in: memoryIds },
        status: 'ACTIVE',
      },
      select: {
        id: true,
        memoryKey: true,
        memoryValue: true,
        type: true,
      },
    });

    return memories;
  }

  /**
   * Perform semantic search for relevant memories.
   * 
   * Per AI_PIPELINE.md §13 - Vector Retrieval (Qdrant) - Gated:
   * - query text = retrieval_query_text or user_text_norm
   * - topK = 4
   * - filter: user_id + ai_friend_id + status=ACTIVE + exclude suppressed keys
   * 
   * This method is called by ChatService when vector_search_policy is ON_DEMAND.
   * 
   * @param params - Search parameters
   * @returns Array of semantically relevant memory IDs
   */
  async searchSemantically(params: {
    userId: string;
    aiFriendId: string;
    queryText: string;
  }): Promise<string[]> {
    // Get suppressed memory keys for the user
    const userControls = await this.prisma.userControls.findUnique({
      where: { userId: params.userId },
      select: { suppressedMemoryKeys: true },
    });
    
    const suppressedKeys = (userControls?.suppressedMemoryKeys as string[]) || [];

    // Perform semantic search via VectorService
    const results: VectorSearchResult[] = await this.vectorService.searchMemories({
      userId: params.userId,
      aiFriendId: params.aiFriendId,
      queryText: params.queryText,
      suppressedMemoryKeys: suppressedKeys,
    });

    if (results.length > 0) {
      this.logger.debug(
        `Semantic search found ${results.length} memories for query: "${params.queryText.substring(0, 50)}..."`,
      );
    }

    // Return memory IDs sorted by relevance (already sorted by Qdrant)
    return results.map(r => r.memoryId);
  }

  /**
   * Check if vector search is enabled and ready.
   */
  isVectorSearchReady(): boolean {
    return this.vectorService.isReady();
  }
}
