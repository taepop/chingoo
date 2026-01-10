# AI_PIPELINE.md — Chingoo (v0.1 Final, Behavior-Locked)

> Locked Stack (v0.1)
> - Mobile: React Native + Expo (TypeScript)
> - API: NestJS 10 (Stable) + Fastify (Node 20 LTS)
> - Auth: AWS Cognito (JWT)
> - DB: Postgres (source of truth) + Prisma
> - Vector DB: Qdrant (managed; vectors only)
> - Queue/Scheduler: Redis + BullMQ (workers: embeddings, retention, backfills)

This document is the single source of truth for AI behavior and pipeline execution:
**ingest → route → orchestrate → retrieve → plan → prompt → LLM → quality gates → writeback (messages/relationship/memory/vectors)**

---

## 0) Purpose & Scope
For every user message (one **turn**), the system must:
1) Persist incoming message (idempotent).
2) Route based on intent + safety + user state + memory policy.
3) Execute a recipe (orchestration).
4) Retrieve profile, relationship state, and relevant memories.
5) Optionally retrieve semantic memory via vector search.
6) Plan a human-like response.
7) Apply persona constraints (not “prompt vibes”).
8) Call the LLM.
9) Post-process for safety, anti-repetition, persona constraints, and anti-creepiness.
10) Write back assistant message + relationship update + selective memory (and enqueue embeddings).

This spec locks:
- persona creation constraints
- relationship progression rules
- memory extraction/dedup/correction rules
- retention caps and user controls
- onboarding state transition rule

---

## 1) Non-Negotiable Principles
1. **Idempotency**
   - Same `message_id` MUST NOT be processed twice.
   - Duplicate requests replay the stored assistant response.
2. **Decision vs Execution**
   - Router decides policies + pipeline recipe.
   - Orchestrator executes the recipe.
3. **Cost & Latency Control**
   - Heuristics first.
   - LLM usage is bounded (router LLM only on ambiguity; memory extractor LLM gated).
   - Vector search is gated (OFF / ON_DEMAND) and never accidental ALWAYS.
4. **Human-Likeness**
   - Stable persona constraints every turn.
   - Relationship stage gating.
   - Response planning layer + anti-repetition.
5. **Anti-Creepiness**
   - No unsolicited dumping of personal facts.
   - Retention obeys strict caps + quiet hours + user controls.
6. **Safety**
   - Not an erotic/explicit adult chat app.
   - Refuse sexual roleplay/explicit erotica.
   - Strong self-harm / harassment / dependency safeguards.

---

## 2) Data Objects (Pipeline Contracts)

### 2.1 TurnPacket (normalized incoming turn)
- `trace_id` (uuid)
- `message_id` (uuid) — idempotency key
- `user_id` (uuid)
- `ai_friend_id` (uuid)
- `conversation_id` (uuid)
- `user_state` = `CREATED | ONBOARDING | ACTIVE`
- `source` = `chat | retention`
- `user_text_raw` (string)
- `user_text_norm` (string) — normalized for routing and heuristics
- `received_at` (timestamp)
- `client_locale` (string, optional)
- `client_timezone` (IANA string)
- `age_band` (enum from onboarding; required once known)

### 2.2 RoutingDecision (router output)
- `pipeline` = `ONBOARDING_CHAT | FRIEND_CHAT | EMOTIONAL_SUPPORT | INFO_QA | REFUSAL`
- `safety_policy` = `ALLOW | SOFT_REFUSE | HARD_REFUSE`
- `memory_read_policy` = `NONE | LIGHT | FULL`
- `vector_search_policy` = `OFF | ON_DEMAND`
- `memory_write_policy` = `NONE | SELECTIVE`
- `relationship_update_policy` = `ON | OFF` (OFF only for hard refusals)
- `retention_policy` (only for retention source): `SEND | SKIP`
- `retrieval_query_text` (optional)
- `notes` (optional; for logs)

### 2.3 PersonaTemplate (constraint set; not a prompt)
Persisted per (user_id, ai_friend_id) as `persona_template_id` + derived params.

Fields (behavioral contract):
- `core_archetype` (enum)
- `speech_style`:
  - `sentence_length_bias` = `short|medium|long`
  - `emoji_usage` = `none|light|frequent`
  - `punctuation_quirks` (0–2 quirks)
- `lexicon_bias`:
  - `language_cleanliness` = `clean|slang|internet_shorthand`
  - `hint_tokens` (0–12 tokens; hints only)
- `humor_mode` = `none|light_sarcasm|frequent_jokes|deadpan`
- `emotional_expression_level` = `restrained|normal|expressive`
- `taboo_soft_bounds` (topic list; avoid unless user initiates)
- `friend_energy` = `passive|balanced|proactive`

### 2.4 StableStyleParams (derived, frozen after onboarding)
- `msg_length_pref` = `short|medium|long`
- `emoji_freq` = `none|light|frequent`
- `humor_mode` = `none|light_sarcasm|frequent_jokes|deadpan`
- `directness_level` = `soft|balanced|blunt`
- `followup_question_rate` = `low|medium`
- `lexicon_bias` = `clean|slang|internet_shorthand`
- `punctuation_quirks` (0–2)

### 2.5 RelationshipState (per user + ai_friend)
- `relationship_stage` = `STRANGER | ACQUAINTANCE | FRIEND | CLOSE_FRIEND`
- `rapport_score` (0–100)
- `last_interaction_at` (timestamp)
- `last_stage_promotion_at` (timestamp or null)
- `sessions_count` (int; total sessions)
- `last_session_at` (timestamp)

### 2.6 MemoryRecord (structured memory)
- `memory_id` (uuid)
- `type` = `FACT | PREFERENCE | RELATIONSHIP_EVENT | EMOTIONAL_PATTERN`
- `memory_key` (string; canonical)
- `memory_value` (string; canonical)
- `confidence` (float 0.0–1.0)
- `status` = `ACTIVE | SUPERSEDED | INVALID`
- `superseded_by` (uuid nullable)
- `invalid_reason` (string nullable)
- `created_at`, `last_confirmed_at`
- `source_message_ids` (list of message_id)

### 2.7 UserControls (retention + topic suppression)
- `proactive_messages_enabled` (bool)
- `mute_until` (timestamp nullable; if set, retention blocked)
- `suppressed_topics` (list of strings)
- `suppressed_memory_keys` (list of strings) — for “don’t remember that” invalidation

## 2.8 Canonical IDs (Shared Across Pipeline)

### TopicID (v0.1, canonical)
All topic-related controls and taboo lists MUST use these exact IDs.

- POLITICS
- RELIGION
- SEXUAL_CONTENT
- SEXUAL_JOKES
- MENTAL_HEALTH
- SELF_HARM
- SUBSTANCES
- GAMBLING
- VIOLENCE
- ILLEGAL_ACTIVITY
- HATE_HARASSMENT
- MEDICAL_HEALTH
- PERSONAL_FINANCE
- RELATIONSHIPS
- FAMILY
- WORK_SCHOOL
- TRAVEL
- ENTERTAINMENT
- TECH_GAMING

### Topic Mention Semantics (v0.1)
- "User-initiated topic": A topic is user-initiated in a turn iff the user's current message has TopicMatch confidence >= 0.70 for that TopicID.
- "Unsolicited mention": The assistant introduces a TopicID that was NOT user-initiated in (a) the current user message OR (b) either of the previous 2 user messages.

### Suppressed Topics Semantics (single list, v0.1)
`UserControls.suppressed_topics` applies to BOTH:
1) Retention/proactive messaging (never mention suppressed topics)
2) Unsolicited mentions in normal chat (must not introduce suppressed topics unless the user initiates them in that turn)

If the user initiates a suppressed topic in their message:
- The assistant may respond ONLY to what the user asked (no expansions), and must avoid follow-up questions that re-open the topic.

### User Text Normalization (user_text_norm)
Normalization MUST be deterministic and stable:
1) Unicode NFKC
2) strip zero-width chars
3) collapse whitespace to single spaces
4) trim leading/trailing spaces
5) lowercase ASCII letters only (do NOT lowercase non-Latin scripts)
6) keep punctuation; create an additional `norm_no_punct` for keyword matching (remove punctuation except apostrophes)

Outputs:
- `user_text_norm` (for logs/debug)
- `norm_no_punct` (for keyword/regex matching)


---

## 3) Onboarding Persona Assignment (Behavior-Locked)

### 3.1 When it runs
During ONBOARDING, after required questions are answered, before first message is sent.

### 3.2 Library size
- PersonaTemplate library size: **24** templates.

### 3.2.1 Persona Template Library (v0.1, 24 entries)

Each template defines:
- fixed: `core_archetype`, `emotional_expression_level`, `taboo_soft_bounds`, `lexicon_bias.language_cleanliness`
- defaults used for sampling: `speech_style`, `humor_mode`, `friend_energy`, `hint_tokens`, `punctuation_quirks`

StableStyleParams derivation:
- Start with template defaults
- Apply sampling mutations (see Sampling Mutations below)
- Freeze results as `stable_style_params`

Sampling Mutations (deterministic with persona_seed):
- Choose exactly 2 modifier categories to mutate from {speech_style, humor_mode, friend_energy}
- Mutation rule: choose a value != template default, using persona_seed PRNG
- Third mutation category is applied if and only if anti-cloning cap would be violated

### [NEW – CLARIFICATION] PT11–PT24 MUST match PRODUCT.md exactly
PT11–PT24 YAML entries MUST be copied verbatim from PRODUCT.md 6.2.1. Any mismatch is a build-time error.

# PT11–PT24: repeat the archetypes but rotate combo_key uniqueness:
# core_archetype ∈ {Calm Listener, Warm Caregiver, Blunt Honest, Dry Humor, Playful Tease,
# Chaotic Internet Friend, Gentle Coach, Soft Nerd, Hype Bestie, Low-Key Companion}
# Ensure each template's default (humor_mode, friend_energy) differs so combo_key coverage is broad.


### 3.3 Sampling
- Sample 1 `core_archetype`
- Sample 2–3 modifiers among `speech_style`, `humor_mode`, `friend_energy`
- Derive `StableStyleParams`
- Persist:
  - `persona_template_id`
  - `persona_seed` (random 32-bit int)
  - `stable_style_params`

### 3.4 Anti-cloning cap (hard enforcement)
- combo key: `(core_archetype, humor_mode, friend_energy)`
- rolling 24-hour cap: no combo key > **7%** of new assignments
- if cap would be exceeded, resample until compliant

### 3.4.1 Anti-Cloning Cap Math (v0.1, Deterministic)

Window definition:
- Let the rolling window contain assignments with `assigned_at >= now - 24h` and `< now` (exclude the candidate assignment).
- Let `N_prev` = total assignments in window.
- Let `k_prev(combo_key)` = assignments in window for the candidate combo_key.

Candidate inclusion:
- Evaluate the cap using `N_new = N_prev + 1` and `k_new = k_prev + 1`.

Rounding rule (authoritative):
- `max_allowed(N) = max(1, floor(0.07 * N))`

Cap rule:
- Candidate is allowed iff `k_new <= max_allowed(N_new)`.

Minimum cohort size behavior:
- The above rule applies for ALL N (including small N) because `max(1, ...)` prevents impossible caps.
- This implies early-stage behavior allows at most 1 assignment per combo_key until N is large enough that floor(0.07*N) >= 2.

Fallback logic (prevents infinite loops):
- Resample up to `MAX_RESAMPLES = 50`.
- If still no compliant sample exists:
  - choose the combo_key with the smallest `k_prev` in the window
  - tie-break deterministically using `persona_seed` PRNG order over the candidate list


---

## 4) Turn Lifecycle (End-to-End)

### 4.1 API ingress (chat turn)
1) Receive request with `message_id`, `user_id`, `conversation_id`, `text`
2) Idempotency check:
   - if message_id already completed → return stored assistant response
3) Persist user message (`RECEIVED` → `PROCESSING`)
4) Build TurnPacket (normalize text, attach user_state, timezone)
5) Router → RoutingDecision
5.5) If `user_state=ONBOARDING` and this is the **first** user message in the friend chat:
   - verify required onboarding answers exist
   - verify persona exists
   - after persisting this turn, transition user_state → **ACTIVE**

6) Orchestrator executes recipe:
   - load profile + controls + persona + relationship state
   - memory load (policy)
   - optional vector retrieval (policy)
   - emotion + safety analysis
   - response planning (with persona constraints)
   - prompt construction
   - LLM call
   - post-processing quality gates (persona constraints enforced)
   - write assistant message
   - relationship update
   - memory extraction + dedup/correction
   - enqueue embedding jobs (if any)
7) Persist assistant message (`COMPLETED`)
8) Return assistant response

### 4.1.1 Required Onboarding Answers (v0.1, Canonical Mirror)

The router/orchestrator MUST treat the following as required answers for ONBOARDING → ACTIVE:

1) preferred_name (string)
2) age_band (enum: 13–17 | 18–24 | 25–34 | 35–44 | 45+)
3) country_or_region (enum/ISO)
4) occupation_category (enum: student | working | between_jobs | other)
5) client_timezone (IANA string)
6) proactive_messages_enabled (bool; default ON)
7) suppressed_topics (list of TopicID; default empty)

This list is a canonical mirror of PRODUCT.md §5.1. Any mismatch between the two documents MUST be treated as a spec error and blocked from release.

### 4.1.2 ONBOARDING → ACTIVE Atomic Commit (v0.1)

If `user_state=ONBOARDING` and the incoming turn is the first chat message:

The system MUST execute the following in a single DB transaction:

1) Insert the user message row keyed by `message_id` (idempotency key).
2) Re-check required onboarding answers exist (see §4.1.1).
3) Re-check persona assignment exists (`persona_template_id` + `stable_style_params`).
4) If checks pass:
   - set `user_state=ACTIVE`
   - update `relationships` set `last_interaction_at = NOW()` (ensures retention doesn't fire immediately for old accounts)
   - commit transaction
5) If checks fail:
   - rollback transaction
   - do NOT produce a friend response
   - return routing outcome `ONBOARDING_CHAT` describing missing fields

### Technical Implementation Note (Crucial)
This transition MUST use a **Prisma Interactive Transaction** (`prisma.$transaction`). 
- **Code Requirement:** The insertion of the first message and the update of User Status to 'ACTIVE' must happen within the same closure. 
- **Failure Condition:** If the message insert succeeds but the user update fails (or vice versa), the database must roll back to pre-insert state. Orphaned messages in ONBOARDING state are not allowed.

Idempotency rule:
- If `message_id` already exists as COMPLETED, the server MUST return the previously stored assistant response and MUST NOT apply the state transition again.


### 4.2 Retention ingress (synthetic turn)
1) Retention worker selects eligible users (Section 14)
2) Creates TurnPacket with `source=retention`
3) Routes + orchestrates using same pipeline with strict constraints
4) Sends message if allowed; writes retention state

---

## 5) Stage A — Preprocess (Normalization + Heuristics)
- Normalize whitespace, strip zero-width chars
- Lowercase copy for routing heuristics (keep raw for generation)
- Token count estimate (fast)
- Regex triggers:
  - preference (“i like”, “i love”, “i hate”, “my favorite”)
  - fact (“i’m from”, “i live in”, “my job is”, “i’m a”)
  - event (“i broke up”, “my exam”, “i’m traveling”, “interview”)
  - correction (“that’s not true”, “don’t remember that”, “don’t bring this topic up again”)

Outputs:
- `user_text_norm`
- `heuristic_flags` (booleans)
- `token_estimate`

### 5.1 Topic detection (deterministic)
Compute `topic_matches`: list of (TopicID, confidence 0..1) using keyword rules.
Confidence = min(1.0, 0.35 + 0.15 * hit_count), where hit_count is number of distinct keyword hits for that TopicID.

Keyword hits use `norm_no_punct` and whole-word / phrase matching.

Minimum keyword lists (v0.1):
- POLITICS: election, president, parliament, government, 민주당, 국민의힘, 보수, 진보, 정치
- RELIGION: church, bible, jesus, islam, muslim, hindu, buddhism, 기독교, 불교, 이슬람, 종교
- SEXUAL_CONTENT: sex, sexual, nude, porn, fetish, intercourse, 에로, 야동, 성관계
- SEXUAL_JOKES: horny, thirst, "that's what she said", 19금, 드립 (sexual context)
- MENTAL_HEALTH: depressed, depression, anxiety, panic, therapy, therapist, 우울, 불안, 공황
- SELF_HARM: suicide, kill myself, self harm, cut, overdose, 자살, 자해
- SUBSTANCES: alcohol, drunk, weed, cannabis, cocaine, vaping, 술, 대마, 마약
- GAMBLING: casino, bet, sportsbook, slots, 도박
- VIOLENCE: kill, murder, assault, gun, stabbing, 폭력, 살인
- ILLEGAL_ACTIVITY: hack, fraud, steal, piracy, counterfeit, 불법, 사기
- HATE_HARASSMENT: slurs list placeholder (use policy library), hate, nazi, 인종차별
- MEDICAL_HEALTH: diagnosis, symptoms, medicine, 병원, 진단, 약
- PERSONAL_FINANCE: debt, loan, credit card, investing, stock advice, 빚, 대출, 투자
- RELATIONSHIPS: breakup, ex, dating, girlfriend, boyfriend, 연애, 이별
- FAMILY: mom, dad, parents, family, 엄마, 아빠, 부모
- WORK_SCHOOL: exam, interview, job, boss, 학교, 시험, 면접
- TRAVEL: flight, hotel, itinerary, 여행
- ENTERTAINMENT: movie, drama, kpop, game (general), 영화, 드라마
- TECH_GAMING: code, programming, PC build, FPS, 롤, 발로란트, 코딩

User-initiated topic:
- A topic is user-initiated iff `confidence >= 0.70` for that TopicID in the CURRENT user message.

### Distinct hit counting (v0.1)
A "distinct keyword hit" means:
- at most 1 count per keyword/phrase entry per TopicID, even if it appears multiple times in the message.


---

## 6) Stage B — Router (User State + Intent + Safety + Policies)

### 6.1 User-state gating (authoritative)
- If `user_state` is `CREATED`: route to `REFUSAL` with message “please complete onboarding” (no chat).
- If `user_state` is `ONBOARDING`: route to `ONBOARDING_CHAT` (memory_read_policy=LIGHT, vector=OFF).
- If `user_state` is `ACTIVE`: proceed with normal intent routing.

### 6.1.1 CREATED Chat Attempt Handling (v0.1)
If `user_state=CREATED` and a chat send is attempted:
- Router outcome MUST be `pipeline=REFUSAL`, `memory_write_policy=NONE`, `relationship_update_policy=OFF`.
- The system MUST NOT append the user message to the visible conversation history for that conversation.
- The refusal response MUST instruct completion of onboarding.

### 6.2 Safety classification (hard rules)
- Erotic/explicit sexual content or sexual roleplay → `HARD_REFUSE`
- If `age_band=13–17`: any sexual content beyond basic safety/education → `HARD_REFUSE`
- Sexual-health education questions (non-erotic) → `INFO_QA` (ALLOW), but keep neutral tone and avoid explicit detail beyond necessity.
- Self-harm intent → `EMOTIONAL_SUPPORT` with crisis-safe flow
- Harassment/hate → `SOFT_REFUSE` or `HARD_REFUSE` per policy
- If `HARD_REFUSE`: `relationship_update_policy=OFF`, `memory_write_policy=NONE`

### 6.2.1 Age Band Unknown (Hard Default, v0.1)
If `age_band` is missing/unknown:
- Treat the user as age_band=13–17 for the purpose of sexual-content safety gating.
- Do NOT block normal FRIEND_CHAT / INFO_QA topics solely due to unknown age.
- If the content is sexual in nature:
  - route HARD_REFUSE
  - do not write memory
  - do not update relationship

### 6.3 Memory policies by pipeline
- ONBOARDING_CHAT:
  - `memory_read_policy=LIGHT` (profile + a few onboarding fields)
  - `memory_write_policy=SELECTIVE` (allow first preferences/events)
  - `vector_search_policy=OFF`
- FRIEND_CHAT:
  - `memory_read_policy=FULL`
  - `vector_search_policy=ON_DEMAND`
  - `memory_write_policy=SELECTIVE`
- EMOTIONAL_SUPPORT:
  - `memory_read_policy=LIGHT` (avoid dumping history)
  - `vector_search_policy=OFF` (v0.1)
  - `memory_write_policy=SELECTIVE` (store EMOTIONAL_PATTERN summaries)
- INFO_QA:
  - `memory_read_policy=NONE` unless user asks personal
  - `vector_search_policy=OFF`
  - `memory_write_policy=NONE`
  

### 6.4 Topic enforcement (hard)
Before planning:
- If a topic is in `UserControls.suppressed_topics` AND it is NOT user-initiated this turn:
  - The assistant must not mention it.
- If a topic is in persona `taboo_soft_bounds` AND it is NOT user-initiated this turn:
  - The assistant must avoid it; if necessary, redirect to a neutral adjacent topic.

### 6.5 Intent routing (deterministic, v0.1)

Default intent is FRIEND_CHAT unless a stronger rule matches.

Compute these boolean flags from `norm_no_punct`:
- is_question = contains "?" OR starts with {what, why, how, when, where, explain, define} OR matches "how do i"
- has_personal_pronoun = contains {"i ", "i'm", "im ", "my ", "me "}
- has_distress = contains any of:
  { "i can't", "i feel hopeless", "i'm panicking", "i'm so anxious", "i'm depressed", "overwhelmed",
    "so stressed", "i hate myself", "nothing matters", "i want to disappear",
    "우울", "불안", "공황", "힘들어", "죽고싶" }
- asks_for_comfort = contains {"can you stay", "talk to me", "i need someone", "please help me calm down", "위로"}
- is_pure_fact_q = is_question AND NOT has_distress AND NOT asks_for_comfort AND token_estimate <= 60

Routing:
1) Safety hard rules (existing) override everything.
2) If has_distress OR asks_for_comfort => EMOTIONAL_SUPPORT
3) Else if is_pure_fact_q => INFO_QA
4) Else => FRIEND_CHAT

Tie-breaker:
- If both is_question and has_personal_pronoun (e.g., "what should I do about my breakup?"):
  - route FRIEND_CHAT (not INFO_QA)

---

## 7) Stage C — Orchestrator (Recipe Execution)

### 7.1 Recipe skeleton (all chat pipelines)
1) Load:
   - Profile + UserControls
   - PersonaTemplate + StableStyleParams
   - RelationshipState
2) Memory load:
   - Based on memory_read_policy
   - Exclude `status!=ACTIVE`
   - Exclude keys in `suppressed_memory_keys`
3) Optional vector retrieval (ON_DEMAND):
   Trigger if any:
   - user references “remember/you said”
   - user asks follow-up requiring past context
   - heuristic “topic continuity” low but conversation_id has recent turns
4) Emotion + safety analysis
5) Response planning (Stage D)
6) Prompt construction (Stage E)
7) LLM call
8) Post-processing (Stage F)
9) Writeback:
   - assistant message
   - relationship update (Stage G)
   - memory extraction + dedup/correction (Stage H)
   - enqueue embeddings

---

## 8) Stage D — Response Planning (Human-like + Persona Constraints)

### 8.1 Core output plan
Create a `ResponsePlan` with:
- `ack_style` (brief / none)
- `answer_outline` (bullets or short paragraphs)
- `followup_question` (0 or 1; allowed only if helpful)
- `emotional_tone` (supportive / playful / calm / blunt) bounded by persona
- `taboo_guard` (topics to avoid unless user initiated)

### 8.2 PersonaConstraintEngine (planning-time)
Inputs:
- PersonaTemplate + StableStyleParams
- RelationshipStage
- UserControls (suppressed topics)

Definition: a taboo topic is considered **user-initiated** if the router’s intent/topic classifier flags that topic in the user’s current message.

Outputs (hard constraints):
- allowed emoji frequency
- allowed sentence length range
- allowed slang level
- follow-up question rate cap
- intimacy cap (by stage)
- taboo topics list for unsolicited mention

**Hard rule:** PersonaTemplate is a constraint set; planner must generate the plan within constraints.

---

## 9) Stage E — Prompt Construction (Structured, Guardrailed)
Prompt contains:
- System rules (safety + anti-creepiness + no erotica)
- Persona constraints (as explicit dos/don’ts and parameter targets)
- RelationshipStage instructions (intimacy cap)
- Memory snippets (limited; never dump many)
- Conversation recent turns
- ResponsePlan (outline)

**Important:** Prompt is supportive scaffolding. It does not replace constraint enforcement.

---

## 10) Stage F — Post-Processing & Quality Gates (Hard)
PostProcessor must enforce:
1) Safety (no erotica/explicit content, no self-harm encouragement, no hate)
2) Persona constraints:
   - emoji frequency within allowed band
   - sentence length bias within allowed band
   - lexicon level (clean/slang/shorthand) within band
   - punctuation quirks limited to allowed
3) Relationship intimacy cap:
   - STRANGER: avoid overly intimate language
   - CLOSE_FRIEND: warmer allowed, but still no dependency/exclusivity
4) Anti-repetition:
   - detect repeated openers/phrases within last 20 assistant messages
5) Anti-creepiness:
   - do not mention >2 personal facts in one message unless user asked
   - do not surface sensitive memories uninvited

If violations:
- perform a single constrained rewrite pass (one extra LLM call max).
- if still failing, fall back to a safe, shorter response.

### 10.1 Personal Fact Counting (v0.1, Deterministic)

Definition:
- A "personal fact surfaced" is counted ONLY when the assistant message includes a `memory_id` in `assistant_message.surfaced_memory_ids`.

Counting rule:
- `personal_fact_count = number of DISTINCT memory_id values in surfaced_memory_ids`.

Enforcement:
- In normal chat: if `personal_fact_count > 2` AND the user did not explicitly ask for recall ("remember/you said/last time") in the current turn:
  - rewrite to reduce surfaced_memory_ids to at most 2.
- In retention: enforce `personal_fact_count <= 1` always.

### 10.2 Repeated Opener Detection (v0.1)

Opener extraction:
- Compute `opener_norm` as the first 12 tokens of the assistant message after:
  1) stripping leading emojis
  2) lowercasing ASCII only
  3) collapsing whitespace
  4) removing punctuation except apostrophes

Repeat rule:
- If `opener_norm` exactly matches any `opener_norm` from the last 20 assistant messages in the conversation:
  - rewrite the opener (single rewrite pass allowed by §10) while preserving meaning.

### 10.3 Similarity Measure for Anti-Repetition (v0.1, Cheap + Deterministic)

Message similarity is evaluated using token 3-gram Jaccard similarity on `norm_no_punct`:

- Let `G(msg)` be the set of 3-grams over tokens (min 3 tokens; otherwise empty).
- Jaccard = `|G(a) ∩ G(b)| / |G(a) ∪ G(b)|`.

Threshold:
- If similarity with ANY of the last 20 assistant messages is >= 0.70, the response is considered repetitive and MUST be rewritten shorter and with a different structure.

### 10.4 Emoji Band Enforcement (v0.1)

Define `emoji_count` as the count of Unicode emoji codepoints in the assistant message.

Limits by StableStyleParams.emoji_freq:
- none: emoji_count MUST be 0
- light: emoji_count MUST be in [0, 2]
- frequent: emoji_count MUST be in [1, 6]

If out of band:
- rewrite to bring into band without changing meaning.

### 10.5 Sentence Length Bias Enforcement (v0.1)

Sentence segmentation:
- Split on `.`, `!`, `?`, `…`, or Korean `.` equivalents, treating consecutive delimiters as one.
- Ignore empty segments.

Compute:
- `sentence_count`
- `avg_words_per_sentence` (tokenized on whitespace)

Bands by StableStyleParams.msg_length_pref:
- short: sentence_count in [1, 3] AND avg_words_per_sentence <= 14
- medium: sentence_count in [2, 5] AND avg_words_per_sentence in [10, 22]
- long: sentence_count in [3, 8] AND avg_words_per_sentence >= 15

If out of band:
- rewrite to match the nearest band while preserving content.


---

## 11) Stage G — Relationship Update (Behavior-Locked)

### 11.1 Session accounting
A new session starts if time since last user message > **4 hours**.
- Increment `sessions_count` only when a new session starts.

### 11.2 Evidence detectors (cheap-first)
- preference share: matched by heuristics or extractor output
- meaningful response: user reply ≥ 10 tokens and not in disengaged list
- emotional disclosure: emotion analyzer high intensity (abs(valence) ≥ 0.6) or tags include strong negative/positive
- past reference: phrases like “remember”, “like we said”, “last time”

Disengaged detection:
- short replies <4 tokens
- or exactly matches: “k”, “ok”, “idk”, “lol”, “sure”, repeated ≥3 times in a session

### 11.3 Score update rules (deterministic)
Compute `delta` from the user message using these exact rules (sum, then clamp):

Positive evidence (can stack):
- Preference share detected (≥1 preference): **+1**
  - If ≥2 distinct preferences in the same message: **+2** (instead of +1)
- Meaningful response to an AI question: **+1**
- Emotional disclosure (high intensity): **+4**
- References past conversation: **+4**

Negative evidence:
- Repeated disengaged replies condition met (≥3 short replies in a session): **−2**

Clamps:
- Clamp per-message delta to **[−2, +5]**
- Apply delta to `rapport_score`, then clamp `rapport_score` to **[0, 100]**

### [NEW – CLARIFICATION] Alignment note
This section is the authoritative numeric definition for v0.1. PRODUCT.md §7.3 ranges must remain consistent with these values.

### 11.4 Inactivity decay
A daily job (or on-demand check) applies:
- −1 rapport per 7 days inactivity
- floor at stage minimum:
  - STRANGER 0, ACQUAINTANCE 15, FRIEND 40, CLOSE_FRIEND 75

### 11.5 Stage promotion rule
Promote if all true:
1) rapport_score ≥ threshold (15/40/75)
2) sessions_count ≥ 3
3) last_stage_promotion_at is null OR now - last_stage_promotion_at ≥ 7 days
4) no skipping (only one stage at a time)

---

## 12) Stage H — Memory Extraction, Dedup, Correction (Behavior-Locked)

### 12.1 Memory types (explicit)
- FACT
- PREFERENCE
- RELATIONSHIP_EVENT
- EMOTIONAL_PATTERN

### 12.2 Hybrid extractor gating
Run heuristic extractor always.
Run LLM extractor only if:
- message length ≥ 200 characters, OR
- emotion intensity high (abs(valence) ≥ 0.6 OR strong emotion tags), OR
- same memory_key appeared twice within 7 days (pattern suspicion)

### 12.3 Dedup + conflict
For each candidate memory:
- canonicalize key/value
- if key exists with same value (ACTIVE):
  - merge sources; increase confidence by **+0.15** (cap 1.0)

Confidence initialization:
- heuristic-only: 0.60
- LLM-extracted: 0.75
- if key exists with different value (ACTIVE):
  - create new ACTIVE record
  - mark old ACTIVE as SUPERSEDED (superseded_by=new)
- never delete automatically; keep audit trail

### 12.3.1 MemoryKey Canonicalization (v0.1)

`memory_key` MUST be one of these formats:

A) FACT (singleton fields; new value supersedes old)
- fact:home_country
- fact:home_city
- fact:current_city
- fact:timezone
- fact:occupation
- fact:school
- fact:major
- fact:language_primary

B) PREFERENCE (multi-valued)
Format: pref:<category>:<item_slug>
Categories (v0.1): food, drink, music, movie_genre, game, sport, hobby, study_style

C) RELATIONSHIP_EVENT (multi; time-bucketed)
Format: event:<domain>:<yyyy_mm>:<event_slug>
Domains (v0.1): school, work, travel, relationship, family, health, other

D) EMOTIONAL_PATTERN (singleton-ish summaries)
Format: emotion:<pattern_id>
pattern_id (v0.1):
- baseline_mood
- stress_trigger_school
- stress_trigger_work
- coping_preference
- social_energy (introvert/extrovert-like, only if user states explicitly)

Slug rules (`item_slug` / `event_slug`):
- Unicode NFKC, trim
- replace spaces with underscores
- remove punctuation except underscores
- keep non-Latin characters (do NOT romanize)
- max length 48 chars; truncate deterministically

Extractor rule:
- If extracted info cannot map to one of the formats above, DO NOT store it in v0.1.

Conflict rules (tie into existing dedup spec):
- FACT keys are singleton:
  - New value => prior ACTIVE becomes SUPERSEDED
- PREFERENCE keys are multi:
  - Contradictory preferences (e.g., "I hate sushi" vs "I love sushi") create two records with:
    - same key pref:food:sushi
    - memory_value includes stance {like|dislike}
    - conflict reduces confidence until re-confirmed

### 12.3.2 PREFERENCE Conflict Canonical Rule (v0.1)

This subsection is the execution-authoritative interpretation of PRODUCT 8.3.2 and MUST be implemented as-is.

Deterministic encoding:
- PREFERENCE `memory_value` MUST be `like|<value>` or `dislike|<value>`.

Conflict handling for same item key (`pref:<category>:<item_slug>`):
1) Same key + same memory_value:
   - merge sources; confidence += 0.15 (cap 1.0)

2) Same key + opposite stance:
   - create new record as ACTIVE
   - mark prior ACTIVE record for that key as SUPERSEDED (superseded_by=new)
   - set new confidence = min(init_conf, 0.55) where init_conf is 0.60 (heuristic) or 0.75 (LLM)


### 12.4 User correction handling (must work)
If user message contains correction triggers:

Tracking requirement (v0.1):
- Each assistant message must store `surfaced_memory_ids` (memory IDs actually referenced or used in the answer).
- Each user message must store `extracted_memory_candidate_ids` (IDs created/confirmed/superseded).
- Correction commands act on `surfaced_memory_ids` from the immediately previous assistant message.

- “That’s not true”:
  - invalidate the most recently referenced memory in the assistant’s last message (tracked in turn metadata)
- “Don’t remember that”:
  - invalidate the most recently referenced memory 

  ### Correction Targeting (Authoritative, v0.1)

A correction command MUST target memories ONLY through `surfaced_memory_ids` from the immediately previous assistant message.
The system MUST NOT invalidate "the last extracted memory" unless it was surfaced.

Definitions:
- "Surfaced memory": A memory is surfaced iff:
  (1) the assistant response content depends on it (personalization), AND
  (2) its `memory_id` is included in `assistant_message.surfaced_memory_ids`.

Hard rule:
- Correction commands act on `surfaced_memory_ids` from the immediately previous assistant message ONLY.

Command behaviors:
1) "That's not true" / "Not true" / "Wrong":
   - Target = the LAST memory_id in `surfaced_memory_ids` (most recent mention).
   - If `surfaced_memory_ids` is empty: do NOT invalidate anything; respond with a clarification prompt ("Which part is wrong?") without asking for extra personal details.

2) "Don't remember that" / "Forget that":
   - Target = the LAST memory_id in `surfaced_memory_ids`.
   - Actions:
     - set memory.status = INVALID
     - add its `memory_key` to `UserControls.suppressed_memory_keys`
     - future retrieval MUST exclude INVALID and suppressed keys

3) "Forget X" / "Don't remember X" (explicit target present):
   - Parse X into a candidate `memory_key` using MemoryKey Canonicalization rules.
   - If a matching ACTIVE memory exists for that key:
     - invalidate by key (all ACTIVE memories with that key)
     - add key to `suppressed_memory_keys`
   - Else fallback to behavior #2 (last surfaced).

Conflict corrections (user provides new value):
- If the user message contains an explicit correction of a FACT (pattern: "X, not Y" / "Actually X" where X maps to a singleton FACT key):
  - Create/Upsert new memory for that FACT key with new value
  - Mark prior ACTIVE memory for that key as SUPERSEDED (not INVALID)
  - Do NOT add to suppressed_memory_keys (unless user explicitly says "don't remember")

Status semantics:
- INVALID: user does not want it stored; never retrieve.
- SUPERSEDED: replaced by newer value; retrieval allowed only for audit/debug, never for generation.

- “Don’t bring this topic up again”:
  - add topic to `suppressed_topics` and prevent unsolicited mention + retention mention

Invalidation:
- set memory.status=INVALID
- add key to `suppressed_memory_keys`
- future retrieval must exclude it

---

## 13) Vector Retrieval (Qdrant) — Gated
Vector search is `ON_DEMAND` only (v0.1).
When triggered:
- query text = `retrieval_query_text` or `user_text_norm`
- topK = 4
- filter:
  - user_id + ai_friend_id
  - memory.status=ACTIVE
  - exclude suppressed_memory_keys
Return small snippets only; never flood the prompt.

---

## 14) Retention Pipeline (Proactive Messaging) — Behavior-Locked

### 14.0 When to Attempt Retention (v0.1, Deterministic)

Retention worker run cadence:
- The retention worker MUST evaluate eligibility once per hour (BullMQ cron/hourly).

Attempt window:
- Only attempt if local time is within 10:00–21:00 (local time). (Quiet hours 00:00–08:00 remain hard-blocked; this adds an attempt window to avoid late-night pings.)

Minimum inactivity before attempting (per stage):
- ACQUAINTANCE: last_interaction_at <= now - 48h
- FRIEND: last_interaction_at <= now - 24h
- CLOSE_FRIEND: last_interaction_at <= now - 12h

If the user interacted within the above window, retention_policy MUST be SKIP even if caps allow.

Backoff interaction:
- If the most recent retention was "ignored", multiply the minimum inactivity threshold by the existing backoff multiplier (×2 per ignore event, as already specified).

### 14.1 Eligibility (hard constraints)
Retention message can be scheduled only if:
- `proactive_messages_enabled = true`
- `mute_until` is null or now > mute_until
- local time NOT within 00:00–08:00
- stage-based caps satisfied:
  - STRANGER: 0/day
  - ACQUAINTANCE: max 1 per 3 days
  - FRIEND: max 1/day
  - CLOSE_FRIEND: max 2/day

### 14.2 Ignored definition (hard)
A sent retention message is “ignored” if:
- delivered, AND
- no user reply within 24h, AND
- no recorded app open event tied to it within 24h

Ignored → backoff multiplier ×2 for next attempt.

### Retention Attribution (v0.1, deterministic)

Each retention message has a `retention_id` and (if push) a `notification_id`.

A retention message is "acknowledged" within 24h if ANY of:
A) User replies in the same conversation within 24h after `delivered_at`
B) App open is recorded within 24h AND attribution succeeds by rule C

C) App-open attribution rules (priority order):
1) If app open includes `opened_notification_id` and it matches the retention message's `notification_id` => acknowledged.
2) Else, if exactly ONE retention message was delivered in the last 24h => attribute the app open to the most recently delivered retention message.
3) Else (multiple delivered, no notification match) => do NOT attribute.

"Ignored" definition:
- delivered_at exists AND
- NOT acknowledged by A/B/C within 24h

Ignored => backoff multiplier ×2 for the next retention attempt.


### 14.3 Content constraints
Retention messages must:
- avoid sensitive memories
- avoid mentioning >1 personal fact
- respect taboo_soft_bounds and suppressed_topics
- be short and non-demanding

### 14.4 User controls enforcement
- If user toggles proactive OFF: stop all retention immediately.
- If user mutes: stop until mute_until passes.
- If user suppresses a topic: do not mention it in retention.

### 14.5 Retention Content Selection (v0.1, Deterministic Ladder)

Goal: choose a short, non-demanding message that is relationship-stage appropriate and avoids generic repetition.

Inputs available to selection:
- relationship_stage
- last_interaction_at
- last 1 assistant message and last 1 user message (conversation history)
- UserControls.suppressed_topics + persona.taboo_soft_bounds
- non-sensitive ACTIVE memories (per §14.3 + Sensitive rules §14.6)

Selection ladder (first match wins):
1) FOLLOW-UP (only if safe):
   - If the last assistant message ended with exactly one question mark "?" AND the user has not replied for >= 24h:
     - send a single-sentence follow-up that restates the question in a softer way.
     - MUST NOT introduce new topics.
2) LIGHT CONTEXT NUDGE:
   - If there exists at least one non-sensitive ACTIVE FACT memory in the allowlist (see §14.6) AND stage is FRIEND or CLOSE_FRIEND:
     - reference at most one such fact (exactly one) to make it non-generic.
3) GENERIC-SAFE CHECK-IN (fallback):
   - Use a stage-specific canned intent (not fixed text) that is then rendered through PersonaTemplate hints:
     - ACQUAINTANCE: "low-pressure hello"
     - FRIEND: "quick check-in"
     - CLOSE_FRIEND: "warm check-in"
   - Rendering MUST:
     - be <= 2 sentences
     - include no more than 1 follow-up question
     - avoid any sensitive topic or memory

Anti-repetition for retention:
- Maintain `last_10_retention_openers` (normalized) and never repeat an opener within the last 10 retention messages.
- If a candidate opener repeats, re-render using different hint_tokens (persona_seed PRNG) up to 5 tries, else fall back to the shortest neutral opener.

### 14.6 Sensitive / Deeply Personal Classification (v0.1)

This classification is used for:
- retention message content selection
- unsolicited callbacks in normal chat (anti-creepiness gate)

#### Sensitive TopicIDs (always sensitive)
Any memory or content tied to these TopicIDs is sensitive:
- SEXUAL_CONTENT, SELF_HARM, MENTAL_HEALTH, MEDICAL_HEALTH, PERSONAL_FINANCE, HATE_HARASSMENT, ILLEGAL_ACTIVITY, VIOLENCE

#### Sensitive Memory Types (always sensitive for retention)
For retention/proactive messages:
- EMOTIONAL_PATTERN is ALWAYS sensitive (never surfaced proactively).
- RELATIONSHIP_EVENT with domain in {relationship, family, health} is ALWAYS sensitive.

#### Sensitive FACT keys (never proactively surfaced)
For retention/proactive messages, never surface these FACT keys:
- fact:home_city
- fact:current_city

#### Allowlist for non-sensitive FACT usage in retention (FRIEND/CLOSE_FRIEND only)
Only these FACT keys may be referenced in retention (max 1 per message):
- fact:occupation
- fact:school
- fact:major
- fact:timezone

All other FACT keys are treated as sensitive for retention.

#### Unsolicited callbacks in normal chat
Even in FRIEND_CHAT, the assistant MUST NOT unsolicitedly mention sensitive topics/memories as defined above unless the topic is user-initiated this turn per TopicMatch semantics.


---

## 15) v0.1 Defaults (Locked)
- Persona templates: 24
- Anti-clone cap: 7% per combo key (rolling 24h)
- Relationship:
  - thresholds: 15 / 40 / 75
  - promotion cooldown: 7 days
  - min sessions for promotion: 3
  - decay: −1 per 7 days inactivity
- Memory:
  - LLM extractor gating: ≥200 chars OR high emotion OR pattern suspicion
- Retention:
  - quiet hours: 00:00–08:00 local
  - caps: 0 / 1 per 3 days / 1 per day / 2 per day
  - ignored window: 24 hours
  - backoff multiplier: ×2

---

## 16) Implementation Notes (Cursor-proofing)
- Router must be deterministic given TurnPacket + lightweight signals.
- Orchestrator is the only component allowed to call heavy services (LLM, vector search).
- PostProcessor must be the final enforcement point for persona constraints and creepiness constraints.
- RelationshipState and MemoryRecord updates must be transactional with turn writeback to avoid drift.
