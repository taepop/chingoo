# ARCHITECTURE.md

## A) System Overview

### A.1 Components

| Component | Role |
|-----------|------|
| **Mobile Client** | React Native (Matched to SDK) + Expo SDK 54. TypeScript. |
| **Mobile Client** | React Native (Matched to SDK) + Expo SDK 55. TypeScript. |
| **Backend API** | NestJS 10 (Stable) + Fastify (Node 20 LTS). REST/GraphQL endpoints for auth, chat, user-state, persona, settings. |
| **Workers** | BullMQ (v5.x). Redis (v7.x). Jobs: embedding enqueue, retention tick, decay tick. |
| **Postgres** | Source-of-truth for users, conversations, messages, memories, relationships, personas, controls. |
| **Qdrant** | Vector DB for semantic memory retrieval (derived/cache; Postgres is authoritative). |
| **Redis** | BullMQ backing store, session cache, anti-clone rolling window cache. |
| **Observability** | Structured JSON logs (trace_id, message_id), metrics (Prometheus-style), error tracking. |

### A.2 Data Flow Diagrams

#### A.2.1 Chat Turn Processing (ACTIVE user)
```
1. Client → POST /chat/send { message_id, conversation_id, text }
2. API Auth (Cognito JWT) → extract user_id
3. Idempotency check → SELECT * FROM messages WHERE id = :message_id
   ├─ if EXISTS and status=COMPLETED → return stored assistant_content
   └─ else continue
4. INSERT message (status=RECEIVED)
5. Build TurnPacket (normalize text, attach user_state, timezone, age_band)
6. RouterService.route(turnPacket) → RoutingDecision
7. OrchestratorService.execute(turnPacket, routingDecision):
   a. Load profile, controls, persona, relationship
   b. MemoryService.read(policy) → memories (exclude suppressed, INVALID)
   c. if vector_search_policy=ON_DEMAND and trigger met → QdrantService.search()
   d. EmotionAnalyzerService.analyze(text)
   e. SafetyService.classify(text, age_band)
   f. ResponsePlannerService.plan(context, persona) → ResponsePlan
   g. PromptBuilderService.build(context, plan)
   h. LlmService.generate(prompt) → raw_response
   i. PostProcessorService.enforce(raw_response, persona, relationship) → final_response
   j. Transaction BEGIN:
      - UPDATE messages SET content=final_response, status=COMPLETED, surfaced_memory_ids
      - RelationshipService.update(delta)
      - MemoryService.extractAndPersist(user_text)
      - COMMIT
   k. QueueService.enqueue('embedding', { memory_ids })
8. Return { assistant_message }
```

#### A.2.2 Onboarding → ACTIVE Transition
```
1. User completes required onboarding answers (stored in user_onboarding_answers)
2. PersonaService.assign(user_id) → persona_template_id, persona_seed, stable_style_params
3. Client navigates to chat, user sends first message
4. API receives first message with user_state=ONBOARDING
5. Transaction BEGIN:
   a. Re-validate: required answers exist, persona exists
   b. INSERT message (idempotent by message_id)
   c. UPDATE users SET state=ACTIVE
   d. COMMIT
6. On failure → rollback, return ONBOARDING_CHAT with missing fields
```

#### A.2.3 Retention Worker Tick
```
1. Cron job runs hourly
2. For each user in ACTIVE state:
   a. Check local time in [10:00, 21:00]
   b. Check proactive_messages_enabled=true, mute_until=null or passed
   c. Check stage-based caps (see §14.1)
   d. Check minimum inactivity (48h/24h/12h × backoff_multiplier)
   e. If all pass → enqueue retention turn
3. For each eligible user:
   a. Build TurnPacket with source=retention
   b. Route (retention_policy=SEND)
   c. ContentSelector.select(stage, memories, suppressed_topics)
   d. Generate, post-process, persist
   e. Deliver push notification
   f. Record retention_attempt (delivered_at, notification_id)
4. 24h later: evaluate acknowledgment (reply or attributed app-open)
   └─ if ignored → set backoff_multiplier ×= 2
```

---

## B) Repo / Folder Structure

```
chingoo/
├── apps/
│   ├── mobile/                          # React Native + Expo client
│   │   ├── src/
│   │   │   ├── navigation/
│   │   │   ├── screens/
│   │   │   │   ├── OnboardingScreen.tsx
│   │   │   │   ├── ChatScreen.tsx
│   │   │   │   └── SettingsScreen.tsx
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   ├── services/
│   │   │   │   ├── api.ts
│   │   │   │   └── push.ts
│   │   │   ├── stores/
│   │   │   └── types/
│   │   ├── app.json
│   │   └── package.json
│   │
│   ├── api/                             # NestJS backend
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   │
│   │   │   ├── auth/                    # Auth module (Cognito JWT)
│   │   │   │   ├── auth.module.ts
│   │   │   │   ├── auth.guard.ts
│   │   │   │   ├── auth.service.ts
│   │   │   │   └── jwt.strategy.ts
│   │   │   │
│   │   │   ├── user-state/              # User lifecycle + onboarding
│   │   │   │   ├── user-state.module.ts
│   │   │   │   ├── user-state.service.ts
│   │   │   │   ├── user-state.controller.ts
│   │   │   │   ├── onboarding.service.ts
│   │   │   │   └── onboarding-answer.validator.ts
│   │   │   │
│   │   │   ├── chat/                    # Chat turn ingestion + response
│   │   │   │   ├── chat.module.ts
│   │   │   │   ├── chat.controller.ts
│   │   │   │   ├── chat.service.ts
│   │   │   │   ├── idempotency.service.ts
│   │   │   │   ├── turn-packet.builder.ts
│   │   │   │   └── text-normalizer.ts
│   │   │   │
│   │   │   ├── router/                  # Routing decisions
│   │   │   │   ├── router.module.ts
│   │   │   │   ├── router.service.ts
│   │   │   │   ├── intent-classifier.ts
│   │   │   │   ├── safety-classifier.ts
│   │   │   │   └── policy-resolver.ts
│   │   │   │
│   │   │   ├── orchestrator/            # Recipe execution
│   │   │   │   ├── orchestrator.module.ts
│   │   │   │   ├── orchestrator.service.ts
│   │   │   │   └── context-loader.ts
│   │   │   │
│   │   │   ├── persona/                 # Persona template + assignment
│   │   │   │   ├── persona.module.ts
│   │   │   │   ├── persona.service.ts
│   │   │   │   ├── persona-sampler.ts
│   │   │   │   ├── anti-clone.service.ts
│   │   │   │   ├── stable-style-params.builder.ts
│   │   │   │   └── persona-templates.data.ts
│   │   │   │
│   │   │   ├── relationship/            # Stage/score tracking
│   │   │   │   ├── relationship.module.ts
│   │   │   │   ├── relationship.service.ts
│   │   │   │   ├── evidence-detector.ts
│   │   │   │   ├── score-updater.ts
│   │   │   │   └── session-tracker.ts
│   │   │   │
│   │   │   ├── memory/                  # Memory extraction, dedup, correction
│   │   │   │   ├── memory.module.ts
│   │   │   │   ├── memory.service.ts
│   │   │   │   ├── heuristic-extractor.ts
│   │   │   │   ├── llm-extractor.ts
│   │   │   │   ├── memory-key-canonicalizer.ts
│   │   │   │   ├── dedup-conflict.service.ts
│   │   │   │   ├── correction-handler.ts
│   │   │   │   └── qdrant.service.ts
│   │   │   │
│   │   │   ├── retention/               # Proactive messaging
│   │   │   │   ├── retention.module.ts
│   │   │   │   ├── retention.service.ts
│   │   │   │   ├── eligibility-checker.ts
│   │   │   │   ├── content-selector.ts
│   │   │   │   ├── anti-repetition.service.ts
│   │   │   │   └── backoff-tracker.ts
│   │   │   │
│   │   │   ├── safety/                  # Safety + refusal routing
│   │   │   │   ├── safety.module.ts
│   │   │   │   ├── safety.service.ts
│   │   │   │   └── crisis-handler.ts
│   │   │   │
│   │   │   ├── topicmatch/              # Topic detection + scoring
│   │   │   │   ├── topicmatch.module.ts
│   │   │   │   ├── topicmatch.service.ts
│   │   │   │   └── keyword-lists.data.ts
│   │   │   │
│   │   │   ├── postprocessor/           # Quality gates
│   │   │   │   ├── postprocessor.module.ts
│   │   │   │   ├── postprocessor.service.ts
│   │   │   │   ├── emoji-enforcer.ts
│   │   │   │   ├── length-enforcer.ts
│   │   │   │   ├── repetition-detector.ts
│   │   │   │   ├── personal-fact-counter.ts
│   │   │   │   └── rewriter.service.ts
│   │   │   │
│   │   │   ├── planner/                 # Response planning
│   │   │   │   ├── planner.module.ts
│   │   │   │   ├── response-planner.service.ts
│   │   │   │   └── persona-constraint-engine.ts
│   │   │   │
│   │   │   ├── prompt/                  # Prompt construction
│   │   │   │   ├── prompt.module.ts
│   │   │   │   └── prompt-builder.service.ts
│   │   │   │
│   │   │   ├── llm/                     # LLM gateway
│   │   │   │   ├── llm.module.ts
│   │   │   │   └── llm.service.ts
│   │   │   │
│   │   │   ├── emotion/                 # Emotion analysis
│   │   │   │   ├── emotion.module.ts
│   │   │   │   └── emotion-analyzer.service.ts
│   │   │   │
│   │   │   ├── controls/                # User controls (toggle, mute, suppression)
│   │   │   │   ├── controls.module.ts
│   │   │   │   ├── controls.service.ts
│   │   │   │   └── controls.controller.ts
│   │   │   │
│   │   │   ├── audit/                   # Telemetry + logging
│   │   │   │   ├── audit.module.ts
│   │   │   │   ├── audit.service.ts
│   │   │   │   ├── decision-trace.service.ts
│   │   │   │   └── correlation.interceptor.ts
│   │   │   │
│   │   │   ├── common/                  # Cross-cutting
│   │   │   │   ├── filters/
│   │   │   │   ├── interceptors/
│   │   │   │   ├── decorators/
│   │   │   │   └── utils/
│   │   │   │       ├── prng.ts
│   │   │   │       └── slug.ts
│   │   │   │
│   │   │   └── prisma/
│   │   │       ├── prisma.module.ts
│   │   │       └── prisma.service.ts
│   │   │
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   │
│   │   ├── test/
│   │   │   └── (see Section F)
│   │   │
│   │   └── package.json
│   │
│   └── workers/                         # BullMQ worker processes
│       ├── src/
│       │   ├── main.ts
│       │   ├── embedding.worker.ts
│       │   ├── retention.worker.ts
│       │   ├── decay.worker.ts
│       │   └── backfill.worker.ts
│       └── package.json
│
├── packages/
│   └── shared/                          # Shared types + enums
│       ├── src/
│       │   ├── index.ts
│       │   ├── enums/
│       │   │   ├── user-state.enum.ts
│       │   │   ├── relationship-stage.enum.ts
│       │   │   ├── memory-type.enum.ts
│       │   │   ├── memory-status.enum.ts
│       │   │   ├── topic-id.enum.ts
│       │   │   ├── pipeline.enum.ts
│       │   │   ├── safety-policy.enum.ts
│       │   │   ├── memory-read-policy.enum.ts
│       │   │   ├── memory-write-policy.enum.ts
│       │   │   ├── vector-search-policy.enum.ts
│       │   │   ├── age-band.enum.ts
│       │   │   ├── occupation-category.enum.ts
│       │   │   ├── core-archetype.enum.ts
│       │   │   ├── sentence-length-bias.enum.ts
│       │   │   ├── emoji-usage.enum.ts
│       │   │   ├── humor-mode.enum.ts
│       │   │   ├── friend-energy.enum.ts
│       │   │   ├── lexicon-bias.enum.ts
│       │   │   ├── directness-level.enum.ts
│       │   │   ├── followup-question-rate.enum.ts
│       │   │   └── retention-status.enum.ts
│       │   │
│       │   ├── dto/
│       │   │   ├── turn-packet.dto.ts
│       │   │   ├── routing-decision.dto.ts
│       │   │   ├── memory-record.dto.ts
│       │   │   ├── relationship-state.dto.ts
│       │   │   ├── persona-assignment.dto.ts
│       │   │   ├── stable-style-params.dto.ts
│       │   │   ├── user-controls.dto.ts
│       │   │   ├── response-plan.dto.ts
│       │   │   ├── retention-attempt.dto.ts
│       │   │   ├── retention-eligibility.dto.ts
│       │   │   └── topic-match-result.dto.ts
│       │   │
│       │   └── constants/
│       │       ├── relationship-thresholds.ts
│       │       ├── retention-caps.ts
│       │       ├── quiet-hours.ts
│       │       ├── memory-confidence.ts
│       │       └── anti-clone-cap.ts
│       │
│       ├── package.json
│       └── tsconfig.json
│
├── docs/
│   ├── PRODUCT.md
│   ├── AI_PIPELINE.md
│   ├── ARCHITECTURE.md
│   └── SCHEMA.md
│
├── docker-compose.yml
├── turbo.json                           # Turborepo (monorepo orchestration)
├── package.json
└── tsconfig.base.json
```

---

## C) Interfaces / Contracts

### C.0 API Wire Contracts (HTTP JSON)
These DTOs define the strict JSON shape for client-server communication.

**POST /auth/signup**
```typescript
{
  "cognito_sub": string,
  "email": string
}

**POST /user/onboarding**
```typescript
{
  "preferred_name": string,
  "age_band": AgeBand, // "13-17", etc.
  "country_or_region": string, // ISO code
  "occupation_category": OccupationCategory,
  "client_timezone": string, // "Asia/Seoul"
  "proactive_messages_enabled": boolean,
  "suppressed_topics": TopicId[]
}

**POST /chat/send**
```typescript
// Request
{
  "message_id": string, // UUID v4 generated by client
  "conversation_id": string, // UUID
  "text": string,
  "local_sent_at": string // ISO 8601
}

// Response (Success)
{
  "message_id": string,
  "assistant_message": {
    "id": string,
    "content": string,
    "created_at": string
  }
}

**PATCH /user/timezone**
```typescript
{
  "client_timezone": string
}


### C.1 TurnPacket
```typescript
// Owner: chat module
// Readers: router, orchestrator, memory, relationship, postprocessor, audit
// Writers: chat module (build only)

interface TurnPacket {
  trace_id: string;                       // uuid, created per request
  message_id: string;                     // uuid, idempotency key
  user_id: string;                        // uuid
  ai_friend_id: string;                   // uuid
  conversation_id: string;                // uuid
  user_state: UserState;                  // CREATED | ONBOARDING | ACTIVE
  source: TurnSource;                     // 'chat' | 'retention'
  user_text_raw: string;
  user_text_norm: string;                 // normalized per §2.8
  norm_no_punct: string;                  // additional variant for keyword matching
  received_at: Date;
  client_locale: string | null;
  client_timezone: string;                // IANA string
  age_band: AgeBand | null;
  heuristic_flags: HeuristicFlags;
  token_estimate: number;
  topic_matches: TopicMatchResult[];
}

interface HeuristicFlags {
  has_preference_trigger: boolean;
  has_fact_trigger: boolean;
  has_event_trigger: boolean;
  has_correction_trigger: boolean;
  is_question: boolean;
  has_personal_pronoun: boolean;
  has_distress: boolean;
  asks_for_comfort: boolean;
}
```

### C.2 RoutingDecision
```typescript
// Owner: router module
// Readers: orchestrator, audit
// Writers: router module only

interface RoutingDecision {
  pipeline: Pipeline;                     // ONBOARDING_CHAT | FRIEND_CHAT | EMOTIONAL_SUPPORT | INFO_QA | REFUSAL
  safety_policy: SafetyPolicy;            // ALLOW | SOFT_REFUSE | HARD_REFUSE
  memory_read_policy: MemoryReadPolicy;   // NONE | LIGHT | FULL
  vector_search_policy: VectorSearchPolicy; // OFF | ON_DEMAND
  memory_write_policy: MemoryWritePolicy; // NONE | SELECTIVE
  relationship_update_policy: RelationshipUpdatePolicy; // ON | OFF
  retention_policy: RetentionPolicy | null; // SEND | SKIP (only for source=retention)
  retrieval_query_text: string | null;
  notes: string | null;                   // debug/logging
}
```

### C.3 MemoryRecord
```typescript
// Owner: memory module
// Readers: orchestrator, postprocessor, retention, audit
// Writers: memory module only

interface MemoryRecord {
  memory_id: string;                      // uuid
  user_id: string;
  ai_friend_id: string;
  type: MemoryType;                       // FACT | PREFERENCE | RELATIONSHIP_EVENT | EMOTIONAL_PATTERN
  memory_key: string;                     // canonical format per §12.3.1
  memory_value: string;                   // for PREFERENCE: "like|X" or "dislike|X"
  confidence: number;                     // 0.0–1.0
  status: MemoryStatus;                   // ACTIVE | SUPERSEDED | INVALID
  superseded_by: string | null;           // memory_id if status=SUPERSEDED
  invalid_reason: string | null;
  created_at: Date;
  last_confirmed_at: Date;
  source_message_ids: string[];           // message_ids that contributed
  embedding_job_id: string | null;
}
```

### C.4 RelationshipState
```typescript
// Owner: relationship module
// Readers: orchestrator, router, postprocessor, retention
// Writers: relationship module only

interface RelationshipState {
  user_id: string;
  ai_friend_id: string;
  relationship_stage: RelationshipStage;  // STRANGER | ACQUAINTANCE | FRIEND | CLOSE_FRIEND
  rapport_score: number;                  // 0–100
  last_interaction_at: Date;
  last_stage_promotion_at: Date | null;
  sessions_count: number;
  last_session_at: Date;
  current_session_short_reply_count: number; // for disengaged detection
}
```

### C.5 PersonaAssignment + StableStyleParams
```typescript
// Owner: persona module
// Readers: orchestrator, planner, postprocessor, retention
// Writers: persona module (once during onboarding)

interface PersonaAssignment {
  user_id: string;
  ai_friend_id: string;
  persona_template_id: string;            // PT01..PT24
  persona_seed: number;                   // 32-bit int
  stable_style_params: StableStyleParams;
  taboo_soft_bounds: TopicId[];
  created_at: Date;
}

interface StableStyleParams {
  msg_length_pref: SentenceLengthBias;    // short | medium | long
  emoji_freq: EmojiUsage;                 // none | light | frequent
  humor_mode: HumorMode;                  // none | light_sarcasm | frequent_jokes | deadpan
  directness_level: DirectnessLevel;      // soft | balanced | blunt
  followup_question_rate: FollowupQuestionRate; // low | medium
  lexicon_bias: LexiconBias;              // clean | slang | internet_shorthand
  punctuation_quirks: string[];           // 0–2 quirks
}
```

### C.6 RetentionAttempt / RetentionEligibility
```typescript
// Owner: retention module
// Readers: audit
// Writers: retention module

interface RetentionAttempt {
  retention_id: string;                   // uuid
  user_id: string;
  ai_friend_id: string;
  message_id: string | null;              // null if not sent
  notification_id: string | null;
  status: RetentionStatus;                // SCHEDULED | DELIVERED | ACKNOWLEDGED | IGNORED | SKIPPED
  delivered_at: Date | null;
  acknowledged_at: Date | null;
  acknowledged_by: AcknowledgmentType | null; // REPLY | APP_OPEN_NOTIFICATION | APP_OPEN_INFERRED
  created_at: Date;
}

interface RetentionEligibility {
  user_id: string;
  is_eligible: boolean;
  block_reason: string | null;            // 'proactive_disabled' | 'muted' | 'quiet_hours' | 'cap_exceeded' | 'recently_active' | 'stranger'
  next_allowed_at: Date | null;
  backoff_multiplier: number;
}
```

### C.7 TopicMatchResult
```typescript
// Owner: topicmatch module
// Readers: router, orchestrator, postprocessor, retention
// Writers: topicmatch module

interface TopicMatchResult {
  topic_id: TopicId;
  confidence: number;                     // 0.0–1.0
  hit_count: number;
  is_user_initiated: boolean;             // confidence >= 0.70
}
```

### C.8 ResponsePlan
```typescript
// Owner: planner module
// Readers: prompt, postprocessor
// Writers: planner module

interface ResponsePlan {
  ack_style: 'brief' | 'none';
  answer_outline: string[];
  followup_question: string | null;
  emotional_tone: 'supportive' | 'playful' | 'calm' | 'blunt';
  taboo_guard: TopicId[];
  allowed_emoji_band: [number, number];
  allowed_sentence_count_band: [number, number];
  allowed_avg_words_band: [number, number];
}
```

### C.9 Circular Dependency Prevention
All DTOs and enums live in `packages/shared`. Domain modules import from shared only.

**Import rules:**
- `orchestrator` may import from: `router`, `persona`, `relationship`, `memory`, `retention`, `safety`, `topicmatch`, `postprocessor`, `planner`, `prompt`, `llm`, `emotion`, `controls`, `audit`, `shared`.
- `router` may import from: `topicmatch`, `safety`, `shared`.
- `postprocessor` may import from: `memory`, `persona`, `relationship`, `shared`.
- `retention` may import from: `relationship`, `memory`, `controls`, `persona`, `topicmatch`, `shared`.
- `memory` may import from: `shared`.
- `persona` may import from: `shared`.
- `relationship` may import from: `shared`.
- `user-state` may import from: `shared`, `auth`.
- NO module may import from `orchestrator` or `chat` (they are top-level aggregators).

---

## D) Execution Pipelines

### D.1 Chat Turn Pipeline (step-by-step)
| Step | Module | Action |
|------|--------|--------|
| 1 | chat | Receive request; extract message_id, user_id, conversation_id, text |
| 2 | chat/idempotency | Query `messages` by message_id; if COMPLETED, return stored response |
| 3 | chat | INSERT message row with status=RECEIVED |
| 4 | chat/turn-packet.builder | Normalize text (NFKC, strip zero-width, collapse WS, lowercase ASCII, keep punct) |
| 5 | chat/turn-packet.builder | Attach user_state, client_timezone, age_band from user/onboarding tables |
| 6 | topicmatch | Compute topic_matches using keyword lists and norm_no_punct |
| 7 | chat/turn-packet.builder | Compute heuristic_flags, token_estimate |
| 8 | router | Classify intent (is_question, has_distress, asks_for_comfort, is_pure_fact_q) |
| 9 | router/safety | Classify safety (ALLOW / SOFT_REFUSE / HARD_REFUSE) based on content + age_band |
| 10 | router/policy | Determine memory/vector/relationship policies per pipeline |
| 11 | router | Return RoutingDecision |
| 12 | orchestrator | Load profile + UserControls + PersonaAssignment + RelationshipState |
| 13 | memory | Load memories per memory_read_policy; exclude status!=ACTIVE, suppressed keys |
| 14 | orchestrator | If vector_search_policy=ON_DEMAND and trigger met → call Qdrant search |
| 15 | emotion | Analyze emotion intensity (valence, arousal) |
| 16 | planner | Build ResponsePlan with persona constraints |
| 17 | prompt | Construct prompt (system rules, persona constraints, stage instructions, memories, recent turns, plan) |
| 18 | llm | Call LLM; receive raw_response |
| 19 | postprocessor | Enforce emoji band, length band, repetition, personal fact count |
| 20 | postprocessor | If violations, call rewriter (1 extra LLM call max); fallback to safe response if still failing |
| 21 | chat | Begin transaction |
| 22 | chat | UPDATE message SET assistant_content, status=COMPLETED, surfaced_memory_ids |
| 23 | relationship | Compute delta (evidence detectors); clamp [-2, +5]; update rapport_score; check promotion |
| 24 | memory | Run extractors; dedup/conflict; persist new/updated memories |
| 25 | chat | COMMIT transaction |
| 26 | audit | Write decision trace log (trace_id, message_id, routing_decision, delta, memories_extracted) |
| 27 | chat | Enqueue embedding jobs for new memories |
| 28 | chat | Return assistant_message to client |

### D.2 ONBOARDING → ACTIVE Atomic Commit
| Step | Module | Action |
|------|--------|--------|
| 1 | chat | Receive first message with user_state=ONBOARDING |
| 2 | chat | Begin transaction |
| 3 | user-state/onboarding | Validate required answers exist (preferred_name, age_band, country_or_region, occupation_category, client_timezone, proactive_messages_enabled, suppressed_topics) |
| 4 | persona | Validate persona_template_id + stable_style_params exist |
| 5 | chat | INSERT message row (idempotent by message_id) |
| 6 | user-state | UPDATE users SET state=ACTIVE |
| 7 | chat | COMMIT transaction |
| 8 | chat | If checks failed → ROLLBACK; return ONBOARDING_CHAT with missing_fields |

### D.3 Retention Worker Tick
| Step | Module | Action |
|------|--------|--------|
| 1 | worker | Cron fires hourly |
| 2 | retention/eligibility | Query all ACTIVE users |
| 3 | retention/eligibility | For each user: check local_time in [10:00, 21:00] |
| 4 | retention/eligibility | Check proactive_messages_enabled=true |
| 5 | retention/eligibility | Check mute_until is null or <= now |
| 6 | retention/eligibility | Check stage != STRANGER |
| 7 | retention/eligibility | Check stage cap not exceeded (count retention in local day) |
| 8 | retention/eligibility | Check minimum inactivity threshold met (48h/24h/12h × backoff_multiplier) |
| 9 | retention | For eligible users: build TurnPacket with source=retention |
| 10 | retention/content-selector | Select content per ladder (FOLLOW-UP > LIGHT_CONTEXT_NUDGE > GENERIC-SAFE) |
| 11 | retention/anti-repetition | Check last_10_retention_openers; rerender if match (up to 5 tries) |
| 12 | orchestrator | Execute retention pipeline (prompt, LLM, postprocessor with personal_fact_count<=1) |
| 13 | retention | INSERT retention_attempt (status=DELIVERED, delivered_at=now, notification_id) |
| 14 | retention | Send push notification |
| 15 | worker | Schedule evaluation job at delivered_at + 24h |
| 16 | retention | Evaluate acknowledgment (reply? app-open?) → set status ACKNOWLEDGED or IGNORED |
| 17 | retention/backoff | If IGNORED → multiply backoff_multiplier ×2 |

### D.4 Memory Correction/Forget Flow
| Step | Module | Action |
|------|--------|--------|
| 1 | chat | User sends "That's not true" / "Don't remember that" / "Forget X" |
| 2 | chat | Detect correction trigger in heuristic_flags |
| 3 | memory/correction | Load surfaced_memory_ids from immediately previous assistant message |
| 4 | memory/correction | If empty → respond "Which part is wrong?" (no invalidation) |
| 5 | memory/correction | Else target = last memory_id in surfaced_memory_ids |
| 6 | memory/correction | UPDATE memory SET status=INVALID, invalid_reason='user_correction' |
| 7 | controls | INSERT memory_key into suppressed_memory_keys |
| 8 | memory | Future retrieval excludes INVALID and suppressed keys |

---

## E) Dependency & Boundary Rules

### E.1 Allowed Imports Matrix
| Module | May Read From | May Write To |
|--------|---------------|--------------|
| auth | shared | - |
| user-state | shared, auth | users, user_onboarding_answers |
| chat | shared, all domain modules | messages |
| router | shared, topicmatch, safety | - (returns decision only) |
| orchestrator | shared, all domain modules except chat | - (coordinates) |
| persona | shared | ai_friends (persona fields) |
| relationship | shared | relationships |
| memory | shared | memories |
| retention | shared, relationship, memory, controls, persona, topicmatch | retention_attempts |
| safety | shared | - |
| topicmatch | shared | - |
| postprocessor | shared, memory, persona, relationship | - |
| planner | shared, persona | - |
| prompt | shared | - |
| llm | shared | - |
| emotion | shared | - |
| controls | shared | user_controls |
| audit | shared | decision_traces |

### E.2 Cross-Cutting Enums Location
All enums defined in PRODUCT.md and AI_PIPELINE.md must be defined ONCE in:
`packages/shared/src/enums/`

These include:
- UserState (CREATED, ONBOARDING, ACTIVE)
- RelationshipStage (STRANGER, ACQUAINTANCE, FRIEND, CLOSE_FRIEND)
- MemoryType (FACT, PREFERENCE, RELATIONSHIP_EVENT, EMOTIONAL_PATTERN)
- MemoryStatus (ACTIVE, SUPERSEDED, INVALID)
- TopicId (POLITICS, RELIGION, ... all 18 canonical IDs)
- Pipeline (ONBOARDING_CHAT, FRIEND_CHAT, EMOTIONAL_SUPPORT, INFO_QA, REFUSAL)
- SafetyPolicy (ALLOW, SOFT_REFUSE, HARD_REFUSE)
- AgeBand (AGE_13_17, AGE_18_24, AGE_25_34, AGE_35_44, AGE_45_PLUS)
- OccupationCategory (student, working, between_jobs, other)
- CoreArchetype (Calm_Listener, Warm_Caregiver, ... all 10)
- SentenceLengthBias (short, medium, long)
- EmojiUsage (none, light, frequent)
- HumorMode (none, light_sarcasm, frequent_jokes, deadpan)
- FriendEnergy (passive, balanced, proactive)
- LexiconBias (clean, slang, internet_shorthand)
- DirectnessLevel (soft, balanced, blunt)
- FollowupQuestionRate (low, medium)

---

## F) Testing / Evaluation Harness

### F.1 Test Folder Structure
```
apps/api/test/
├── unit/
│   ├── router/
│   │   ├── intent-classifier.spec.ts
│   │   ├── safety-classifier.spec.ts
│   │   └── policy-resolver.spec.ts
│   ├── topicmatch/
│   │   └── topicmatch.service.spec.ts
│   ├── memory/
│   │   ├── heuristic-extractor.spec.ts
│   │   ├── memory-key-canonicalizer.spec.ts
│   │   ├── dedup-conflict.service.spec.ts
│   │   └── correction-handler.spec.ts
│   ├── postprocessor/
│   │   ├── emoji-enforcer.spec.ts
│   │   ├── length-enforcer.spec.ts
│   │   ├── repetition-detector.spec.ts
│   │   └── personal-fact-counter.spec.ts
│   ├── relationship/
│   │   ├── evidence-detector.spec.ts
│   │   ├── score-updater.spec.ts
│   │   └── session-tracker.spec.ts
│   ├── persona/
│   │   ├── anti-clone.service.spec.ts
│   │   └── stable-style-params.builder.spec.ts
│   └── retention/
│       ├── eligibility-checker.spec.ts
│       ├── content-selector.spec.ts
│       └── anti-repetition.service.spec.ts
│
├── integration/
│   ├── chat-turn.integration.spec.ts
│   ├── onboarding-transition.integration.spec.ts
│   └── retention-tick.integration.spec.ts
│
├── golden/
│   ├── router/
│   │   ├── router-golden.spec.ts
│   │   └── fixtures/
│   │       ├── intent-cases.json
│   │       └── safety-cases.json
│   ├── memory/
│   │   ├── extraction-golden.spec.ts
│   │   ├── dedup-conflict-golden.spec.ts
│   │   └── fixtures/
│   │       ├── extraction-cases.json
│   │       └── conflict-cases.json
│   └── postprocessor/
│       ├── postprocessor-golden.spec.ts
│       └── fixtures/
│           ├── emoji-band-cases.json
│           ├── length-band-cases.json
│           └── repeated-opener-cases.json
│
└── e2e/
    ├── onboarding-active-idempotency.e2e.spec.ts
    └── retention-anti-repetition.e2e.spec.ts
```

### F.2 Test Commands
```bash
# Unit tests
npm run test:unit

# Integration tests (requires test DB)
npm run test:integration

# Golden tests (deterministic behavior verification)
npm run test:golden

# E2E tests (full stack)
npm run test:e2e

# All tests
npm run test
```

### F.3 Golden Test Format
Each golden test fixture is a JSON array of test cases:
```json
[
  {
    "name": "distress_keyword_korean",
    "input": {
      "norm_no_punct": "오늘 너무 우울해요",
      "token_estimate": 8
    },
    "expected": {
      "pipeline": "EMOTIONAL_SUPPORT",
      "has_distress": true
    }
  }
]
```

---

## G) Operational Concerns

### G.1 Logging Fields
Every log entry must include:
- `trace_id` (from TurnPacket; propagated through all calls)
- `message_id` (idempotency key)
- `user_id`
- `timestamp`
- `level` (debug, info, warn, error)
- `module` (router, memory, postprocessor, etc.)

Decision-specific logs:
- Router: `routing_decision`, `intent_flags`, `safety_policy`, `topic_matches`
- Memory: `memories_loaded`, `memories_extracted`, `conflicts_detected`, `corrections_applied`
- Postprocessor: `emoji_count`, `sentence_count`, `avg_words`, `violations`, `rewrites_attempted`
- Relationship: `delta`, `new_rapport_score`, `promotion_applied`

### G.2 Correlation IDs
- `trace_id`: Generated at request ingress; passed through all service calls.
- `message_id`: Client-generated UUID; used as idempotency key.
- Both IDs must appear in:
  - All log entries
  - Error tracking events
  - Async job payloads (embedding, retention evaluation)

### G.3 Migration Policy
- All schema changes via Prisma migrations (`npx prisma migrate dev --name <name>`)
- Backward-compatible changes preferred (add columns nullable, then backfill, then make required)
- Breaking changes require coordination with client release
- Rollback strategy: keep previous migration as revert script

### G.4 Feature Flags
No feature flags are introduced in this spec. The spec describes locked v0.1 behavior. Feature flags may be added in future versions for:
- LLM model swaps (if needed for A/B testing)
- Memory extractor variants
- Retention content strategies

---

## H) Module Dependency Diagram (Text)
```
                    ┌──────────┐
                    │  mobile  │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │   auth   │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │   chat   │◄──────────┐
                    └────┬─────┘           │
                         │                 │
           ┌─────────────┼─────────────┐   │
           │             │             │   │
      ┌────▼────┐   ┌────▼────┐   ┌────▼───┴─┐
      │ router  │   │orchestr │   │idempotency│
      └────┬────┘   └────┬────┘   └───────────┘
           │             │
    ┌──────┴──────┐      │
    │             │      │
┌───▼───┐    ┌────▼───┐  │
│safety │    │topicmtc│  │
└───────┘    └────────┘  │
                         │
    ┌──────┬──────┬──────┼──────┬──────┬──────┐
    │      │      │      │      │      │      │
┌───▼──┐┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐
│persona││relat││memory││planner││prompt││llm  ││emotion│
└──────┘└─────┘└──────┘└──────┘└──────┘└─────┘└──────┘
                  │
              ┌───▼───┐
              │qdrant │
              └───────┘

    ┌─────────────┐
    │postprocessor│◄── from orchestrator after LLM
    └─────────────┘

    ┌─────────────┐
    │  retention  │◄── from worker (uses same orchestrator pipeline)
    └─────────────┘

    ┌─────────────┐
    │   controls  │◄── from user-state or controls controller
    └─────────────┘

    ┌─────────────┐
    │    audit    │◄── from all modules (write-only)
    └─────────────┘
```
