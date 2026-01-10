# SCHEMA.md

## A) Entity Inventory

| Entity | Purpose (Spec Mapping) |
|--------|------------------------|
| `users` | Core user account; holds lifecycle state (CREATED/ONBOARDING/ACTIVE) per §4. |
| `user_onboarding_answers` | Required onboarding answers per §5.1 (preferred_name, age_band, country, occupation, timezone). |
| `user_controls` | User-level toggles and suppression lists per §2.7 (proactive_messages_enabled, mute_until, suppressed_topics, suppressed_memory_keys). |
| `ai_friends` | Single AI friend per user in v0.1; holds persona assignment per §6. |
| `persona_templates` | Static library of 24 templates per §6.2.1; seed data. |
| `conversations` | Chat thread between user and AI friend. |
| `messages` | Individual chat messages; idempotency key is `id` (message_id); status tracks RECEIVED/PROCESSING/COMPLETED per §4.1. |
| `memories` | Structured user memories per §8 and §12; supports dedup, conflict, correction, and vector sync. |
| `relationships` | Relationship state per §7 and §11 (stage, rapport_score, sessions_count, promotion tracking). |
| `retention_attempts` | Proactive message tracking per §14 (eligibility, delivery, acknowledgment, backoff). |
| `app_open_events` | Client-reported app opens for retention attribution per §9.3.1/§14.2. |
| `decision_traces` | Audit/debug log of routing decisions and key pipeline outputs per §16. |
| `persona_assignment_log` | Rolling window log for anti-cloning cap enforcement per §6.4.1/§3.4.1. |

---

## B) Relational Schema (Postgres)

### B.1 `users`
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| cognito_sub | VARCHAR(128) | NOT NULL | - | Cognito subject; unique |
| state | VARCHAR(16) | NOT NULL | 'CREATED' | Enum: CREATED, ONBOARDING, ACTIVE |
| created_at | TIMESTAMPTZ | NOT NULL | now() | |
| updated_at | TIMESTAMPTZ | NOT NULL | now() | |

**Constraints:**
- PK: `id`
- UNIQUE: `cognito_sub`
- CHECK: `state IN ('CREATED', 'ONBOARDING', 'ACTIVE')`

**Indexes:**
- `idx_users_cognito_sub` on `cognito_sub` (lookup by JWT)
- `idx_users_state` on `state` (retention worker queries ACTIVE users)

---

### B.2 `user_onboarding_answers`
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| user_id | UUID | NOT NULL | - | FK → users.id |
| preferred_name | VARCHAR(64) | NOT NULL | - | Required per §5.1 |
| age_band | VARCHAR(8) | NOT NULL | - | Enum: 13-17, 18-24, 25-34, 35-44, 45+ |
| country_or_region | VARCHAR(8) | NOT NULL | - | ISO 3166-1 alpha-2 |
| occupation_category | VARCHAR(16) | NOT NULL | - | Enum: student, working, between_jobs, other |
| client_timezone | VARCHAR(64) | NOT NULL | - | IANA timezone string |
| created_at | TIMESTAMPTZ | NOT NULL | now() | |
| updated_at | TIMESTAMPTZ | NOT NULL | now() | |

**Constraints:**
- PK: `id`
- UNIQUE: `user_id` (one row per user)
- FK: `user_id` → `users.id` ON DELETE CASCADE
- CHECK: `age_band IN ('13-17', '18-24', '25-34', '35-44', '45+')`
- CHECK: `occupation_category IN ('student', 'working', 'between_jobs', 'other')`

**Indexes:**
- `idx_user_onboarding_user_id` on `user_id`

---

### B.3 `user_controls`
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| user_id | UUID | NOT NULL | - | FK → users.id |
| proactive_messages_enabled | BOOLEAN | NOT NULL | true | Default ON per §5.1 |
| mute_until | TIMESTAMPTZ | NULL | - | If set, retention blocked until this time |
| suppressed_topics | JSONB | NOT NULL | '[]' | Array of TopicId strings |
| suppressed_memory_keys | JSONB | NOT NULL | '[]' | Array of memory_key strings |
| created_at | TIMESTAMPTZ | NOT NULL | now() | |
| updated_at | TIMESTAMPTZ | NOT NULL | now() | |

**Constraints:**
- PK: `id`
- UNIQUE: `user_id`
- FK: `user_id` → `users.id` ON DELETE CASCADE

**Indexes:**
- `idx_user_controls_user_id` on `user_id`

---

### B.4 `ai_friends`
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| user_id | UUID | NOT NULL | - | FK → users.id |
| persona_template_id | VARCHAR(8) | NULL | - | PT01..PT24; null until assigned |
| persona_seed | INTEGER | NULL | - | 32-bit int; null until assigned |
| stable_style_params | JSONB | NULL | - | Frozen StableStyleParams; null until assigned |
| taboo_soft_bounds | JSONB | NOT NULL | '[]' | Array of TopicId from template |
| assigned_at | TIMESTAMPTZ | NULL | - | When persona was assigned |
| created_at | TIMESTAMPTZ | NOT NULL | now() | |
| updated_at | TIMESTAMPTZ | NOT NULL | now() | |

**Constraints:**
- PK: `id`
- UNIQUE: `user_id` (one AI friend per user in v0.1)
- FK: `user_id` → `users.id` ON DELETE CASCADE

**Indexes:**
- `idx_ai_friends_user_id` on `user_id`

---

### B.5 `persona_templates` (Seed Data)
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | VARCHAR(8) | NOT NULL | - | PK; PT01..PT24 |
| core_archetype | VARCHAR(32) | NOT NULL | - | Enum: Calm_Listener, Warm_Caregiver, etc. |
| speech_style | JSONB | NOT NULL | - | {sentence_length_bias, emoji_usage, punctuation_quirks} |
| lexicon_bias | JSONB | NOT NULL | - | {language_cleanliness, hint_tokens} |
| humor_mode | VARCHAR(16) | NOT NULL | - | Enum: none, light_sarcasm, frequent_jokes, deadpan |
| emotional_expression_level | VARCHAR(16) | NOT NULL | - | Enum: restrained, normal, expressive |
| taboo_soft_bounds | JSONB | NOT NULL | - | Array of TopicId |
| friend_energy | VARCHAR(16) | NOT NULL | - | Enum: passive, balanced, proactive |

**Constraints:**
- PK: `id`

**Notes:** This table is seeded at deploy time with 24 rows matching PRODUCT.md §6.2.1.

---

### B.6 `conversations`
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| user_id | UUID | NOT NULL | - | FK → users.id |
| ai_friend_id | UUID | NOT NULL | - | FK → ai_friends.id |
| created_at | TIMESTAMPTZ | NOT NULL | now() | |
| updated_at | TIMESTAMPTZ | NOT NULL | now() | Last message time |

**Constraints:**
- PK: `id`
- UNIQUE: `(user_id, ai_friend_id)` (one conversation per user-friend pair in v0.1)
- FK: `user_id` → `users.id` ON DELETE CASCADE
- FK: `ai_friend_id` → `ai_friends.id` ON DELETE CASCADE

**Indexes:**
- `idx_conversations_user_ai_friend` on `(user_id, ai_friend_id)`

---

### B.7 `messages`
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | - | PK; idempotency key (message_id) |
| conversation_id | UUID | NOT NULL | - | FK → conversations.id |
| user_id | UUID | NOT NULL | - | FK → users.id (denorm for queries) |
| ai_friend_id | UUID | NOT NULL | - | FK → ai_friends.id (denorm) |
| role | VARCHAR(16) | NOT NULL | - | 'user' or 'assistant' |
| content | TEXT | NOT NULL | - | Message text (raw for user, final for assistant) |
| content_norm | TEXT | NULL | - | Normalized user text for logs |
| status | VARCHAR(16) | NOT NULL | 'RECEIVED' | RECEIVED, PROCESSING, COMPLETED |
| source | VARCHAR(16) | NOT NULL | 'chat' | 'chat' or 'retention' |
| surfaced_memory_ids | JSONB | NOT NULL | '[]' | Array of memory_id used in assistant response |
| extracted_memory_candidate_ids | JSONB | NOT NULL | '[]' | Array of memory_id created/updated from this message |
| opener_norm | VARCHAR(256) | NULL | - | First 12 tokens normalized (for repetition detection) |
| trace_id | UUID | NOT NULL | - | Correlation ID |
| created_at | TIMESTAMPTZ | NOT NULL | now() | |
| updated_at | TIMESTAMPTZ | NOT NULL | now() | |

**Constraints:**
- PK: `id`
- FK: `conversation_id` → `conversations.id` ON DELETE CASCADE
- FK: `user_id` → `users.id` ON DELETE CASCADE
- FK: `ai_friend_id` → `ai_friends.id` ON DELETE CASCADE
- CHECK: `role IN ('user', 'assistant')`
- CHECK: `status IN ('RECEIVED', 'PROCESSING', 'COMPLETED')`
- CHECK: `source IN ('chat', 'retention')`

**Indexes:**
- `idx_messages_conversation_created` on `(conversation_id, created_at DESC)` (chat history)
- `idx_messages_user_created` on `(user_id, created_at DESC)` (user message history)
- `idx_messages_status` on `status` (find PROCESSING for recovery)
- `idx_messages_conversation_role_created` on `(conversation_id, role, created_at DESC)` (last N assistant messages for repetition)
- `idx_messages_surfaced_memories` on `surfaced_memory_ids` USING GIN (Required for efficient correction targeting)

---

### B.8 `memories`
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| user_id | UUID | NOT NULL | - | FK → users.id |
| ai_friend_id | UUID | NOT NULL | - | FK → ai_friends.id |
| type | VARCHAR(24) | NOT NULL | - | FACT, PREFERENCE, RELATIONSHIP_EVENT, EMOTIONAL_PATTERN |
| memory_key | VARCHAR(128) | NOT NULL | - | Canonical key per §12.3.1 |
| memory_value | TEXT | NOT NULL | - | Value; for PREFERENCE: "like\|X" or "dislike\|X" |
| confidence | DECIMAL(3,2) | NOT NULL | - | 0.00–1.00 |
| status | VARCHAR(16) | NOT NULL | 'ACTIVE' | ACTIVE, SUPERSEDED, INVALID |
| superseded_by | UUID | NULL | - | FK → memories.id if SUPERSEDED |
| invalid_reason | VARCHAR(64) | NULL | - | e.g., 'user_correction' |
| source_message_ids | JSONB | NOT NULL | '[]' | Array of message_id |
| embedding_job_id | UUID | NULL | - | BullMQ job ID if pending |
| qdrant_point_id | UUID | NULL | - | Qdrant point ID if indexed |
| created_at | TIMESTAMPTZ | NOT NULL | now() | |
| last_confirmed_at | TIMESTAMPTZ | NOT NULL | now() | Updated on reconfirmation |
| updated_at | TIMESTAMPTZ | NOT NULL | now() | |

**Constraints:**
- PK: `id`
- FK: `user_id` → `users.id` ON DELETE CASCADE
- FK: `ai_friend_id` → `ai_friends.id` ON DELETE CASCADE
- FK: `superseded_by` → `memories.id` ON DELETE SET NULL
- CHECK: `type IN ('FACT', 'PREFERENCE', 'RELATIONSHIP_EVENT', 'EMOTIONAL_PATTERN')`
- CHECK: `status IN ('ACTIVE', 'SUPERSEDED', 'INVALID')`
- CHECK: `confidence >= 0 AND confidence <= 1`

**Indexes:**
- `idx_memories_user_ai_friend_status` on `(user_id, ai_friend_id, status)` (retrieval excludes non-ACTIVE)
- `idx_memories_user_ai_friend_key_status` on `(user_id, ai_friend_id, memory_key, status)` (dedup/conflict lookup)
- `idx_memories_user_created` on `(user_id, created_at DESC)` (pattern suspicion: same key within 7 days)

---

### B.9 `relationships`
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| user_id | UUID | NOT NULL | - | FK → users.id |
| ai_friend_id | UUID | NOT NULL | - | FK → ai_friends.id |
| relationship_stage | VARCHAR(16) | NOT NULL | 'STRANGER' | STRANGER, ACQUAINTANCE, FRIEND, CLOSE_FRIEND |
| rapport_score | INTEGER | NOT NULL | 0 | 0–100 |
| last_interaction_at | TIMESTAMPTZ | NOT NULL | now() | Last user message time |
| last_stage_promotion_at | TIMESTAMPTZ | NULL | - | NULL until first promotion |
| sessions_count | INTEGER | NOT NULL | 0 | Total sessions |
| last_session_at | TIMESTAMPTZ | NULL | - | Start of current/last session |
| current_session_short_reply_count | INTEGER | NOT NULL | 0 | For disengaged detection |
| created_at | TIMESTAMPTZ | NOT NULL | now() | |
| updated_at | TIMESTAMPTZ | NOT NULL | now() | |

**Constraints:**
- PK: `id`
- UNIQUE: `(user_id, ai_friend_id)` (one relationship per pair)
- FK: `user_id` → `users.id` ON DELETE CASCADE
- FK: `ai_friend_id` → `ai_friends.id` ON DELETE CASCADE
- CHECK: `relationship_stage IN ('STRANGER', 'ACQUAINTANCE', 'FRIEND', 'CLOSE_FRIEND')`
- CHECK: `rapport_score >= 0 AND rapport_score <= 100`

**Indexes:**
- `idx_relationships_user_ai_friend` on `(user_id, ai_friend_id)`
- `idx_relationships_stage` on `relationship_stage` (retention eligibility by stage)
- `idx_relationships_last_interaction` on `last_interaction_at` (inactivity decay, retention eligibility)

---

### B.10 `retention_attempts`
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | gen_random_uuid() | PK (retention_id) |
| user_id | UUID | NOT NULL | - | FK → users.id |
| ai_friend_id | UUID | NOT NULL | - | FK → ai_friends.id |
| message_id | UUID | NULL | - | FK → messages.id if delivered |
| notification_id | UUID | NULL | - | Push notification ID |
| status | VARCHAR(16) | NOT NULL | 'SCHEDULED' | SCHEDULED, DELIVERED, ACKNOWLEDGED, IGNORED, SKIPPED |
| skip_reason | VARCHAR(32) | NULL | - | If SKIPPED: cap_exceeded, muted, quiet_hours, etc. |
| delivered_at | TIMESTAMPTZ | NULL | - | When push was sent |
| acknowledged_at | TIMESTAMPTZ | NULL | - | When ack detected |
| acknowledged_by | VARCHAR(24) | NULL | - | REPLY, APP_OPEN_NOTIFICATION, APP_OPEN_INFERRED |
| opener_norm | VARCHAR(256) | NULL | - | For anti-repetition (last 10) |
| content_selection_type | VARCHAR(24) | NULL | - | FOLLOW_UP, LIGHT_CONTEXT_NUDGE, GENERIC_SAFE |
| created_at | TIMESTAMPTZ | NOT NULL | now() | |
| updated_at | TIMESTAMPTZ | NOT NULL | now() | |

**Constraints:**
- PK: `id`
- FK: `user_id` → `users.id` ON DELETE CASCADE
- FK: `ai_friend_id` → `ai_friends.id` ON DELETE CASCADE
- FK: `message_id` → `messages.id` ON DELETE SET NULL
- CHECK: `status IN ('SCHEDULED', 'DELIVERED', 'ACKNOWLEDGED', 'IGNORED', 'SKIPPED')`

**Indexes:**
- `idx_retention_user_status` on `(user_id, status)` (find pending/delivered)
- `idx_retention_user_delivered` on `(user_id, delivered_at DESC)` (last 24h for attribution)
- `idx_retention_user_created_opener` on `(user_id, created_at DESC)` (last 10 for anti-repetition)

---

### B.11 `retention_backoff`
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| user_id | UUID | NOT NULL | - | FK → users.id |
| ai_friend_id | UUID | NOT NULL | - | FK → ai_friends.id |
| backoff_multiplier | INTEGER | NOT NULL | 1 | ×2 per ignored retention |
| last_ignored_at | TIMESTAMPTZ | NULL | - | When last IGNORED occurred |
| created_at | TIMESTAMPTZ | NOT NULL | now() | |
| updated_at | TIMESTAMPTZ | NOT NULL | now() | |

**Constraints:**
- PK: `id`
- UNIQUE: `(user_id, ai_friend_id)`
- FK: `user_id` → `users.id` ON DELETE CASCADE
- FK: `ai_friend_id` → `ai_friends.id` ON DELETE CASCADE

**Indexes:**
- `idx_retention_backoff_user_ai` on `(user_id, ai_friend_id)`

---

### B.12 `app_open_events`
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| user_id | UUID | NOT NULL | - | FK → users.id |
| opened_notification_id | UUID | NULL | - | If opened via notification tap |
| opened_at | TIMESTAMPTZ | NOT NULL | now() | |
| attributed_retention_id | UUID | NULL | - | FK → retention_attempts.id if attributed |
| created_at | TIMESTAMPTZ | NOT NULL | now() | |

**Constraints:**
- PK: `id`
- FK: `user_id` → `users.id` ON DELETE CASCADE
- FK: `attributed_retention_id` → `retention_attempts.id` ON DELETE SET NULL

**Indexes:**
- `idx_app_open_user_opened` on `(user_id, opened_at DESC)` (last 24h for attribution)

---

### B.13 `decision_traces` (Audit)
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| trace_id | UUID | NOT NULL | - | Correlation ID |
| message_id | UUID | NOT NULL | - | FK → messages.id |
| user_id | UUID | NOT NULL | - | FK → users.id |
| routing_decision | JSONB | NOT NULL | - | Full RoutingDecision object |
| topic_matches | JSONB | NOT NULL | '[]' | Array of TopicMatchResult |
| heuristic_flags | JSONB | NOT NULL | - | HeuristicFlags object |
| memories_loaded_count | INTEGER | NOT NULL | - | |
| memories_extracted_count | INTEGER | NOT NULL | - | |
| relationship_delta | INTEGER | NOT NULL | - | |
| postprocessor_violations | JSONB | NOT NULL | '[]' | Array of violation types |
| rewrite_attempts | INTEGER | NOT NULL | 0 | |
| created_at | TIMESTAMPTZ | NOT NULL | now() | |

**Constraints:**
- PK: `id`
- FK: `message_id` → `messages.id` ON DELETE CASCADE
- FK: `user_id` → `users.id` ON DELETE CASCADE

**Indexes:**
- `idx_decision_traces_trace` on `trace_id`
- `idx_decision_traces_message` on `message_id`
- `idx_decision_traces_user_created` on `(user_id, created_at DESC)`

---

### B.14 `persona_assignment_log` (Anti-Clone Rolling Window)
| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| user_id | UUID | NOT NULL | - | FK → users.id |
| ai_friend_id | UUID | NOT NULL | - | FK → ai_friends.id |
| combo_key | VARCHAR(128) | NOT NULL | - | "{core_archetype}:{humor_mode}:{friend_energy}" |
| assigned_at | TIMESTAMPTZ | NOT NULL | now() | |

**Constraints:**
- PK: `id`
- UNIQUE: `(user_id, ai_friend_id)` (one assignment per pair)
- FK: `user_id` → `users.id` ON DELETE CASCADE
- FK: `ai_friend_id` → `ai_friends.id` ON DELETE CASCADE

**Indexes:**
- `idx_persona_log_combo_assigned` on `(combo_key, assigned_at DESC)` (rolling 24h count)
- `idx_persona_log_assigned` on `assigned_at` (window queries)

---

## C) Prisma Models

```prisma
// schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─────────────────────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────────────────────

enum UserState {
  CREATED
  ONBOARDING
  ACTIVE
}

enum AgeBand {
  AGE_13_17   @map("13-17")
  AGE_18_24   @map("18-24")
  AGE_25_34   @map("25-34")
  AGE_35_44   @map("35-44")
  AGE_45_PLUS @map("45+")
}

enum OccupationCategory {
  student
  working
  between_jobs
  other
}

enum MessageRole {
  user
  assistant
}

enum MessageStatus {
  RECEIVED
  PROCESSING
  COMPLETED
}

enum MessageSource {
  chat
  retention
}

enum MemoryType {
  FACT
  PREFERENCE
  RELATIONSHIP_EVENT
  EMOTIONAL_PATTERN
}

enum MemoryStatus {
  ACTIVE
  SUPERSEDED
  INVALID
}

enum RelationshipStage {
  STRANGER
  ACQUAINTANCE
  FRIEND
  CLOSE_FRIEND
}

enum RetentionStatus {
  SCHEDULED
  DELIVERED
  ACKNOWLEDGED
  IGNORED
  SKIPPED
}

enum AcknowledgmentType {
  REPLY
  APP_OPEN_NOTIFICATION
  APP_OPEN_INFERRED
}

enum ContentSelectionType {
  FOLLOW_UP
  LIGHT_CONTEXT_NUDGE
  GENERIC_SAFE
}

// ─────────────────────────────────────────────────────────────
// MODELS
// ─────────────────────────────────────────────────────────────

model User {
  id                    String                  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  cognitoSub            String                  @unique @map("cognito_sub") @db.VarChar(128)
  state                 UserState               @default(CREATED)
  createdAt             DateTime                @default(now()) @map("created_at") @db.Timestamptz
  updatedAt             DateTime                @updatedAt @map("updated_at") @db.Timestamptz

  onboardingAnswers     UserOnboardingAnswers?
  controls              UserControls?
  aiFriends             AiFriend[]
  conversations         Conversation[]
  messages              Message[]
  memories              Memory[]
  relationships         Relationship[]
  retentionAttempts     RetentionAttempt[]
  retentionBackoff      RetentionBackoff[]
  appOpenEvents         AppOpenEvent[]
  decisionTraces        DecisionTrace[]
  personaAssignmentLogs PersonaAssignmentLog[]

  @@map("users")
}

model UserOnboardingAnswers {
  id                 String             @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId             String             @unique @map("user_id") @db.Uuid
  preferredName      String             @map("preferred_name") @db.VarChar(64)
  ageBand            AgeBand            @map("age_band")
  countryOrRegion    String             @map("country_or_region") @db.VarChar(8)
  occupationCategory OccupationCategory @map("occupation_category")
  clientTimezone     String             @map("client_timezone") @db.VarChar(64)
  createdAt          DateTime           @default(now()) @map("created_at") @db.Timestamptz
  updatedAt          DateTime           @updatedAt @map("updated_at") @db.Timestamptz

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("user_onboarding_answers")
}

model UserControls {
  id                       String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId                   String   @unique @map("user_id") @db.Uuid
  proactiveMessagesEnabled Boolean  @default(true) @map("proactive_messages_enabled")
  muteUntil                DateTime? @map("mute_until") @db.Timestamptz
  suppressedTopics         Json     @default("[]") @map("suppressed_topics") @db.JsonB
  suppressedMemoryKeys     Json     @default("[]") @map("suppressed_memory_keys") @db.JsonB
  createdAt                DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt                DateTime @updatedAt @map("updated_at") @db.Timestamptz

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("user_controls")
}

model AiFriend {
  id                 String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId             String    @unique @map("user_id") @db.Uuid
  personaTemplateId  String?   @map("persona_template_id") @db.VarChar(8)
  personaSeed        Int?      @map("persona_seed")
  stableStyleParams  Json?     @map("stable_style_params") @db.JsonB
  tabooSoftBounds    Json      @default("[]") @map("taboo_soft_bounds") @db.JsonB
  assignedAt         DateTime? @map("assigned_at") @db.Timestamptz
  createdAt          DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt          DateTime  @updatedAt @map("updated_at") @db.Timestamptz

  user                   User                   @relation(fields: [userId], references: [id], onDelete: Cascade)
  personaTemplate        PersonaTemplate?       @relation(fields: [personaTemplateId], references: [id])
  conversations          Conversation[]
  messages               Message[]
  memories               Memory[]
  relationships          Relationship[]
  retentionAttempts      RetentionAttempt[]
  retentionBackoff       RetentionBackoff[]
  personaAssignmentLogs  PersonaAssignmentLog[]

  @@map("ai_friends")
}

model PersonaTemplate {
  id                       String   @id @db.VarChar(8)
  coreArchetype            String   @map("core_archetype") @db.VarChar(32)
  speechStyle              Json     @map("speech_style") @db.JsonB
  lexiconBias              Json     @map("lexicon_bias") @db.JsonB
  humorMode                String   @map("humor_mode") @db.VarChar(16)
  emotionalExpressionLevel String   @map("emotional_expression_level") @db.VarChar(16)
  tabooSoftBounds          Json     @map("taboo_soft_bounds") @db.JsonB
  friendEnergy             String   @map("friend_energy") @db.VarChar(16)

  aiFriends AiFriend[]

  @@map("persona_templates")
}

model Conversation {
  id         String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId     String   @map("user_id") @db.Uuid
  aiFriendId String   @map("ai_friend_id") @db.Uuid
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz

  user     User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  aiFriend AiFriend  @relation(fields: [aiFriendId], references: [id], onDelete: Cascade)
  messages Message[]

  @@unique([userId, aiFriendId])
  @@index([userId, aiFriendId])
  @@map("conversations")
}

model Message {
  id                          String        @id @db.Uuid
  conversationId              String        @map("conversation_id") @db.Uuid
  userId                      String        @map("user_id") @db.Uuid
  aiFriendId                  String        @map("ai_friend_id") @db.Uuid
  role                        MessageRole
  content                     String        @db.Text
  contentNorm                 String?       @map("content_norm") @db.Text
  status                      MessageStatus @default(RECEIVED)
  source                      MessageSource @default(chat)
  surfacedMemoryIds           Json          @default("[]") @map("surfaced_memory_ids") @db.JsonB
  extractedMemoryCandidateIds Json          @default("[]") @map("extracted_memory_candidate_ids") @db.JsonB
  openerNorm                  String?       @map("opener_norm") @db.VarChar(256)
  traceId                     String        @map("trace_id") @db.Uuid
  createdAt                   DateTime      @default(now()) @map("created_at") @db.Timestamptz
  updatedAt                   DateTime      @updatedAt @map("updated_at") @db.Timestamptz

  conversation      Conversation       @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  user              User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  aiFriend          AiFriend           @relation(fields: [aiFriendId], references: [id], onDelete: Cascade)
  decisionTraces    DecisionTrace[]
  retentionAttempts RetentionAttempt[]

  @@index([conversationId, createdAt(sort: Desc)])
  @@index([userId, createdAt(sort: Desc)])
  @@index([status])
  @@index([conversationId, role, createdAt(sort: Desc)])
  @@index([surfacedMemoryIds], type: Gin) // GIN index for array containment queries
  @@map("messages")
}

model Memory {
  id               String       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId           String       @map("user_id") @db.Uuid
  aiFriendId       String       @map("ai_friend_id") @db.Uuid
  type             MemoryType
  memoryKey        String       @map("memory_key") @db.VarChar(128)
  memoryValue      String       @map("memory_value") @db.Text
  confidence       Decimal      @db.Decimal(3, 2)
  status           MemoryStatus @default(ACTIVE)
  supersededBy     String?      @map("superseded_by") @db.Uuid
  invalidReason    String?      @map("invalid_reason") @db.VarChar(64)
  sourceMessageIds Json         @default("[]") @map("source_message_ids") @db.JsonB
  embeddingJobId   String?      @map("embedding_job_id") @db.Uuid
  qdrantPointId    String?      @map("qdrant_point_id") @db.Uuid
  createdAt        DateTime     @default(now()) @map("created_at") @db.Timestamptz
  lastConfirmedAt  DateTime     @default(now()) @map("last_confirmed_at") @db.Timestamptz
  updatedAt        DateTime     @updatedAt @map("updated_at") @db.Timestamptz

  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  aiFriend          AiFriend @relation(fields: [aiFriendId], references: [id], onDelete: Cascade)
  supersedingMemory Memory?  @relation("MemorySupersession", fields: [supersededBy], references: [id], onDelete: SetNull)
  supersededMemories Memory[] @relation("MemorySupersession")

  @@index([userId, aiFriendId, status])
  @@index([userId, aiFriendId, memoryKey, status])
  @@index([userId, createdAt(sort: Desc)])
  @@map("memories")
}

model Relationship {
  id                           String            @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId                       String            @map("user_id") @db.Uuid
  aiFriendId                   String            @map("ai_friend_id") @db.Uuid
  relationshipStage            RelationshipStage @default(STRANGER) @map("relationship_stage")
  rapportScore                 Int               @default(0) @map("rapport_score")
  lastInteractionAt            DateTime          @default(now()) @map("last_interaction_at") @db.Timestamptz
  lastStagePromotionAt         DateTime?         @map("last_stage_promotion_at") @db.Timestamptz
  sessionsCount                Int               @default(0) @map("sessions_count")
  lastSessionAt                DateTime?         @map("last_session_at") @db.Timestamptz
  currentSessionShortReplyCount Int              @default(0) @map("current_session_short_reply_count")
  createdAt                    DateTime          @default(now()) @map("created_at") @db.Timestamptz
  updatedAt                    DateTime          @updatedAt @map("updated_at") @db.Timestamptz

  user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  aiFriend AiFriend @relation(fields: [aiFriendId], references: [id], onDelete: Cascade)

  @@unique([userId, aiFriendId])
  @@index([relationshipStage])
  @@index([lastInteractionAt])
  @@map("relationships")
}

model RetentionAttempt {
  id                   String               @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId               String               @map("user_id") @db.Uuid
  aiFriendId           String               @map("ai_friend_id") @db.Uuid
  messageId            String?              @map("message_id") @db.Uuid
  notificationId       String?              @map("notification_id") @db.Uuid
  status               RetentionStatus      @default(SCHEDULED)
  skipReason           String?              @map("skip_reason") @db.VarChar(32)
  deliveredAt          DateTime?            @map("delivered_at") @db.Timestamptz
  acknowledgedAt       DateTime?            @map("acknowledged_at") @db.Timestamptz
  acknowledgedBy       AcknowledgmentType?  @map("acknowledged_by")
  openerNorm           String?              @map("opener_norm") @db.VarChar(256)
  contentSelectionType ContentSelectionType? @map("content_selection_type")
  createdAt            DateTime             @default(now()) @map("created_at") @db.Timestamptz
  updatedAt            DateTime             @updatedAt @map("updated_at") @db.Timestamptz

  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  aiFriend   AiFriend  @relation(fields: [aiFriendId], references: [id], onDelete: Cascade)
  message    Message?  @relation(fields: [messageId], references: [id], onDelete: SetNull)
  appOpens   AppOpenEvent[]

  @@index([userId, status])
  @@index([userId, deliveredAt(sort: Desc)])
  @@index([userId, createdAt(sort: Desc)])
  @@map("retention_attempts")
}

model RetentionBackoff {
  id                String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId            String   @map("user_id") @db.Uuid
  aiFriendId        String   @map("ai_friend_id") @db.Uuid
  backoffMultiplier Int      @default(1) @map("backoff_multiplier")
  lastIgnoredAt     DateTime? @map("last_ignored_at") @db.Timestamptz
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt         DateTime @updatedAt @map("updated_at") @db.Timestamptz

  user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  aiFriend AiFriend @relation(fields: [aiFriendId], references: [id], onDelete: Cascade)

  @@unique([userId, aiFriendId])
  @@map("retention_backoff")
}

model AppOpenEvent {
  id                    String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId                String   @map("user_id") @db.Uuid
  openedNotificationId  String?  @map("opened_notification_id") @db.Uuid
  openedAt              DateTime @default(now()) @map("opened_at") @db.Timestamptz
  attributedRetentionId String?  @map("attributed_retention_id") @db.Uuid
  createdAt             DateTime @default(now()) @map("created_at") @db.Timestamptz

  user              User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  attributedRetention RetentionAttempt? @relation(fields: [attributedRetentionId], references: [id], onDelete: SetNull)

  @@index([userId, openedAt(sort: Desc)])
  @@map("app_open_events")
}

model DecisionTrace {
  id                     String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  traceId                String   @map("trace_id") @db.Uuid
  messageId              String   @map("message_id") @db.Uuid
  userId                 String   @map("user_id") @db.Uuid
  routingDecision        Json     @map("routing_decision") @db.JsonB
  topicMatches           Json     @default("[]") @map("topic_matches") @db.JsonB
  heuristicFlags         Json     @map("heuristic_flags") @db.JsonB
  memoriesLoadedCount    Int      @map("memories_loaded_count")
  memoriesExtractedCount Int      @map("memories_extracted_count")
  relationshipDelta      Int      @map("relationship_delta")
  postprocessorViolations Json    @default("[]") @map("postprocessor_violations") @db.JsonB
  rewriteAttempts        Int      @default(0) @map("rewrite_attempts")
  createdAt              DateTime @default(now()) @map("created_at") @db.Timestamptz

  message Message @relation(fields: [messageId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([traceId])
  @@index([messageId])
  @@index([userId, createdAt(sort: Desc)])
  @@map("decision_traces")
}

model PersonaAssignmentLog {
  id         String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId     String   @map("user_id") @db.Uuid
  aiFriendId String   @map("ai_friend_id") @db.Uuid
  comboKey   String   @map("combo_key") @db.VarChar(128)
  assignedAt DateTime @default(now()) @map("assigned_at") @db.Timestamptz

  user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  aiFriend AiFriend @relation(fields: [aiFriendId], references: [id], onDelete: Cascade)

  @@unique([userId, aiFriendId])
  @@index([comboKey, assignedAt(sort: Desc)])
  @@index([assignedAt])
  @@map("persona_assignment_log")
}
```

---

## D) Qdrant Collection Schema

### D.1 Collection: `chingoo_memories`

**Purpose:** Semantic search over ACTIVE user memories for vector retrieval (ON_DEMAND policy).

**Vector config:**
- Dimension: 1536 (assuming OpenAI ada-002 or equivalent)
- Distance: Cosine

**Payload schema:**
| Field | Type | Notes |
|-------|------|-------|
| memory_id | uuid | Matches `memories.id` |
| user_id | uuid | |
| ai_friend_id | uuid | |
| memory_type | string | FACT, PREFERENCE, RELATIONSHIP_EVENT, EMOTIONAL_PATTERN |
| memory_key | string | Canonical key |
| memory_value | string | Value text |
| status | string | ACTIVE only (non-ACTIVE points are deleted/filtered) |
| created_at | datetime | |

**Payload indexes:**
- `user_id` (filter on retrieval)
- `ai_friend_id` (filter on retrieval)
- `status` (filter on retrieval; only ACTIVE)
- `memory_key` (for suppression filter)

**Sync strategy:**
1. Postgres `memories` table is source of truth.
2. After memory INSERT/UPDATE with status=ACTIVE, enqueue embedding job.
3. Worker computes embedding, upserts to Qdrant with `qdrant_point_id`.
4. On status change to SUPERSEDED/INVALID, delete point from Qdrant or update payload status.
5. Retrieval filters: `user_id`, `ai_friend_id`, `status=ACTIVE`, exclude `memory_key IN suppressed_memory_keys`.

---

## E) Nullability & Defaults Strategy

### E.1 Never-Nullable Fields (module lookup safety)
| Table | Field | Rationale |
|-------|-------|-----------|
| users | state | Router/orchestrator depends on state for gating |
| user_onboarding_answers | all fields except id/timestamps | Required per §5.1; must exist for ONBOARDING→ACTIVE |
| user_controls | proactive_messages_enabled | Boolean; default true per spec |
| user_controls | suppressed_topics | JSON array; default [] |
| user_controls | suppressed_memory_keys | JSON array; default [] |
| ai_friends | taboo_soft_bounds | JSON array; default [] |
| messages | role, status, source, surfaced_memory_ids, trace_id | Pipeline depends on these |
| memories | type, memory_key, memory_value, confidence, status | Retrieval/extraction logic depends on all |
| relationships | relationship_stage, rapport_score, last_interaction_at | Retention/routing depends on stage/score |

### E.2 Nullable Fields (valid business reasons)
| Table | Field | Reason |
|-------|-------|--------|
| ai_friends | persona_template_id, persona_seed, stable_style_params, assigned_at | NULL until persona assignment during onboarding |
| user_controls | mute_until | NULL if not muted |
| memories | superseded_by, invalid_reason, embedding_job_id, qdrant_point_id | Context-dependent |
| relationships | last_stage_promotion_at, last_session_at | NULL until first promotion/session |
| retention_attempts | message_id, notification_id, skip_reason, delivered_at, acknowledged_at, acknowledged_by | Depends on status |
| messages | content_norm, opener_norm | Only computed for certain roles/uses |

### E.3 Default Values
| Table | Field | Default |
|-------|-------|---------|
| users | state | 'CREATED' |
| user_controls | proactive_messages_enabled | true |
| user_controls | suppressed_topics | '[]' (empty JSON array) |
| user_controls | suppressed_memory_keys | '[]' (empty JSON array) |
| ai_friends | taboo_soft_bounds | '[]' |
| messages | status | 'RECEIVED' |
| messages | source | 'chat' |
| messages | surfaced_memory_ids | '[]' |
| messages | extracted_memory_candidate_ids | '[]' |
| memories | status | 'ACTIVE' |
| memories | source_message_ids | '[]' |
| relationships | relationship_stage | 'STRANGER' |
| relationships | rapport_score | 0 |
| relationships | sessions_count | 0 |
| relationships | current_session_short_reply_count | 0 |
| retention_attempts | status | 'SCHEDULED' |
| retention_backoff | backoff_multiplier | 1 |

---

## F) Transactional + Idempotency Requirements

### F.1 ONBOARDING → ACTIVE Atomic Commit
**Schema support:**
- `users.state` must be updated atomically with message INSERT.
- Transaction checks:
  1. `user_onboarding_answers` row exists with all required fields non-null.
  2. `ai_friends` row has `persona_template_id`, `persona_seed`, `stable_style_params` non-null.
  3. INSERT `messages` row with provided `id` (message_id).
  4. UPDATE `users SET state = 'ACTIVE' WHERE state = 'ONBOARDING'`.
- If any check fails, rollback entire transaction.
- If `messages.id` already exists with status=COMPLETED, return stored response without re-applying transition.

### F.2 Turn Idempotency
**Schema support:**
- `messages.id` is the PK and idempotency key (client-generated UUID).
- Before processing, check: `SELECT * FROM messages WHERE id = :message_id`.
- If row exists and `status = COMPLETED`, return `content` (stored assistant response).
- UNIQUE constraint on `id` prevents double-insert.

### F.3 surfaced_memory_ids Correctness
**Schema support:**
- `messages.surfaced_memory_ids` stores JSON array of `memory_id` values.
- Correction handler loads this array from the immediately previous assistant message.
- Query: `SELECT surfaced_memory_ids FROM messages WHERE conversation_id = :cid AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`.
- Index: `(conversation_id, role, created_at DESC)` supports this query efficiently.

### F.4 Anti-Cloning Rolling Window
**Schema support:**
- `persona_assignment_log` stores `combo_key` and `assigned_at`.
- Query for cap check: 
  ```sql
  SELECT combo_key, COUNT(*) as k
  FROM persona_assignment_log
  WHERE assigned_at >= NOW() - INTERVAL '24 hours'
  GROUP BY combo_key;
  ```
- Index: `(combo_key, assigned_at DESC)` supports this query.
- `max_allowed(N) = max(1, floor(0.07 * N))` where N is total assignments in window + 1.

### F.5 Retention Anti-Repetition
**Schema support:**
- `retention_attempts.opener_norm` stores normalized opener.
- Query for last 10: 
  ```sql
  SELECT opener_norm FROM retention_attempts
  WHERE user_id = :uid AND opener_norm IS NOT NULL
  ORDER BY created_at DESC LIMIT 10;
  ```
- Index: `(user_id, created_at DESC)` supports this query.

---

## G) Future Expansion Hooks

### G.1 Audit/Versioning Fields (added)
- All tables include `created_at`, `updated_at` timestamps.
- `memories.superseded_by` enables audit trail for value changes.
- `memories.invalid_reason` enables audit of user corrections.
- `decision_traces` table captures full routing/pipeline decisions for debugging.

### G.2 Soft Delete Support (implicit)
- `memories.status = INVALID` acts as soft delete (never retrieved for generation).
- `memories.status = SUPERSEDED` retains historical values for audit.
- Physical deletion only on account deletion (out of scope for schema).

### G.3 Extension Points (not adding new features)
- `messages.metadata` (JSONB) could be added for future per-message flags without schema migration.
- `user_controls` JSONB fields allow adding new suppression lists without column changes.
- `persona_templates` as separate table allows adding templates without code deploy.

---

## H) Final Validation Checklist

| Check | Status |
|-------|--------|
| Every module's referenced field exists in schema | ✓ |
| `messages.id` is unique (idempotency key) | ✓ PK on id |
| `memories` supports status, confidence, superseded_by per §8/§12 | ✓ |
| `relationships` supports stage, rapport_score, sessions_count, promotion tracking per §7/§11 | ✓ |
| `user_controls` supports suppressed_topics, suppressed_memory_keys per §2.7 | ✓ |
| `ai_friends` supports persona_template_id, persona_seed, stable_style_params per §6 | ✓ |
| `retention_attempts` supports status, delivered_at, acknowledged tracking per §14 | ✓ |
| `retention_backoff` supports backoff_multiplier per §9.3/§14.2 | ✓ |
| `persona_assignment_log` supports rolling 24h cap per §3.4.1 | ✓ |
| `messages.surfaced_memory_ids` exists for correction targeting per §12.4 | ✓ |
| `messages.opener_norm` exists for repetition detection per §10.2 | ✓ |
| ONBOARDING→ACTIVE can be atomic (users.state + messages + FK checks) | ✓ |
| Indexes support key queries (chat history, retention eligibility, anti-clone window) | ✓ |
| No circular FK dependencies blocking inserts | ✓ (superseded_by self-ref uses SET NULL) |
| Prisma models compile logically (relations, indexes) | ✓ |
| Worker jobs can operate (retention_attempts, memories for embedding) | ✓ |
| Qdrant sync supported (qdrant_point_id, embedding_job_id) | ✓ |

---

## Assumptions & Risks

### Assumptions Made (safest deterministic interpretation)

1. **Single AI Friend per User (v0.1):** Schema uses UNIQUE constraint on `ai_friends.user_id`. Future multi-friend support requires removing this constraint and adjusting queries.

2. **Message ID is Client-Generated UUID:** Client must generate unique `message_id` before sending. Server rejects duplicate IDs with stored response replay.

3. **AgeBand Enum Mapping:** Prisma enum values use `@map()` to match spec strings ("13-17", etc.). Application code must handle conversion.

4. **TopicId Storage as JSON String Array:** `suppressed_topics` and `taboo_soft_bounds` store TopicId values as JSON string arrays. Application validates against canonical TopicId enum.

5. **Confidence Decimal Precision:** `DECIMAL(3,2)` supports 0.00–1.00 with two decimal places. All confidence arithmetic must be done with proper precision handling.

6. **Qdrant Point Deletion on Status Change:** When memory status changes from ACTIVE to SUPERSEDED/INVALID, the system must delete or filter out the Qdrant point. This is an application-level responsibility.

7. **Retention Attribution Window is 24 Hours:** `app_open_events` and `retention_attempts` queries use 24-hour windows. Index design assumes this is the only supported window size.

8. **PRNG Determinism for Persona Sampling:** `persona_seed` is a 32-bit integer. Application must use deterministic PRNG (e.g., seeded Mersenne Twister) for reproducible sampling.

9. **Embedding Dimension is 1536:** Qdrant collection assumes OpenAI ada-002 or compatible model. Different models require schema/config change.

10. **Transactional Isolation Level:** ONBOARDING→ACTIVE atomic commit assumes READ COMMITTED or stronger isolation. Application must explicitly use transactions with appropriate isolation.

### Risks

1. **Clock Skew for Rolling Windows:** Anti-clone 24h window and retention 24h attribution depend on server timestamps. Clock skew between servers could cause edge-case inconsistencies. Mitigation: use DB `now()` consistently.

2. **Qdrant Sync Lag:** Vector search may return stale results if embedding job is delayed. Risk is low for v0.1 since vector search is ON_DEMAND only.

3. **JSON Array Query Performance:** Filtering by `suppressed_memory_keys` or `suppressed_topics` membership is not indexed. If lists grow large, consider GIN indexes on JSONB or normalized junction tables.

4. **Retention Backoff Unbounded Growth:** `backoff_multiplier` doubles on each ignore without upper bound. After many ignores, minimum inactivity threshold could exceed reasonable values. Application should cap multiplier (e.g., at 16).

5. **opener_norm Collision:** 12-token normalized opener may have false-positive matches for very common phrases. Risk is low given personalization and persona variation.

6. **Memory Key Length Truncation:** 48-char slug truncation is deterministic but could cause collisions for very long, similar item names. Risk is low for expected preference/event names.
