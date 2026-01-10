# SPEC_INDEX.md — Canonical Reference Checklist

> **BINDING TRUTH:** This file extracts verbatim information from the binding documentation:
> - PRODUCT.md
> - AI_PIPELINE.md
> - ARCHITECTURE.md
> - SCHEMA.md
> - MONOREPO_SETUP.md
> - API_CONTRACT.md
> - VERSIONS.md
> - SPEC_PATCH.md
>
> **CANONICAL RULES:**
> - Do not add any endpoint paths not present in API_CONTRACT.md (and SPEC_PATCH.md additions).
> - Do not add/rename DTO fields beyond API_CONTRACT.md (and SPEC_PATCH.md additions).
> - Do not add/rename DB entities/columns beyond SCHEMA.md (and SPEC_PATCH.md changes).
> - If ARCHITECTURE.md conflicts with SPEC_PATCH.md, SPEC_PATCH wins.
> - If any doc conflicts with API naming, API_CONTRACT wins (SPEC_PATCH strict terminology).

---

## 1. API Endpoints (Method + Path)

### 1.1 Authentication
- **POST /auth/login** (or Signup)
  - Request DTO: `AuthRequestDto`
  - Response DTO: `AuthResponseDto`
  - Error DTO: `ApiErrorDto`
  - Note: `/auth/signup` is NOT implemented as a separate endpoint in v0.1 (ARCHITECTURE.md override per SPEC_PATCH.md)

### 1.2 User Management
- **POST /user/onboarding**
  - Request DTO: `OnboardingRequestDto`
  - Response DTO: `OnboardingResponseDto`
  - Error DTO: `ApiErrorDto`

- **GET /user/me**
  - Request DTO: None (query params only)
  - Response DTO: `UserProfileResponseDto`
  - Error DTO: `ApiErrorDto`

- **PATCH /user/timezone**
  - Request DTO: `UpdateTimezoneDto`
  - Response DTO: `SuccessResponseDto`
  - Error DTO: `ApiErrorDto`

- **POST /user/device** (SPEC_PATCH.md addition)
  - Request DTO: `RegisterDeviceDto`
  - Response DTO: `SuccessResponseDto` (implied)
  - Error DTO: `ApiErrorDto`

- **DELETE /user/me** (SPEC_PATCH.md addition)
  - Request DTO: None (no body required)
  - Response DTO: HTTP 200 OK on success
  - Error DTO: `ApiErrorDto`

### 1.3 Chat
- **POST /chat/send**
  - Request DTO: `ChatRequestDto`
  - Response DTO: `ChatResponseDto`
  - Error DTO: `ApiErrorDto`

- **GET /chat/history**
  - Request DTO: `GetHistoryRequestDto`
  - Response DTO: `HistoryResponseDto`
  - Error DTO: `ApiErrorDto`

---

## 2. DTO Definitions (Verbatim from API_CONTRACT.md + SPEC_PATCH.md)

### 2.1 Auth DTOs
```typescript
export interface AuthRequestDto {
  identity_token: string;
  email?: string;
}

export interface AuthResponseDto {
  access_token: string;
  user_id: string;
  state: UserState;
}
```

### 2.2 Onboarding DTOs
```typescript
export interface OnboardingRequestDto {
  preferred_name: string; // Min 1, Max 64 chars
  age_band: AgeBand;
  country_or_region: string; // ISO 3166-1 alpha-2
  occupation_category: OccupationCategory;
  client_timezone: string; // IANA timezone string
  proactive_messages_enabled: boolean; // Default: true
  suppressed_topics: TopicId[];
}

export interface OnboardingResponseDto {
  user_id: string;
  state: UserState; // Will be ONBOARDING until first message sent
  conversation_id: string;
  updated_at: string;
}
```

### 2.3 Chat DTOs
```typescript
export interface ChatRequestDto {
  message_id: string; // UUID v4, client-generated for idempotency
  conversation_id: string;
  user_message: string; // Max 4000 chars
  local_timestamp: string; // ISO 8601 (NOT persisted in v0.1, telemetry only)
  user_timezone: string;
}

export interface ChatResponseDto {
  message_id: string;
  user_state: UserState;
  assistant_message: {
    id: string;
    content: string;
    created_at: string;
  };
}
```

### 2.4 Settings DTOs
```typescript
export interface UpdateTimezoneDto {
  timezone: string; // IANA timezone string
}

export interface SuccessResponseDto {
  success: boolean;
}
```

### 2.5 Device Registration DTO (SPEC_PATCH.md)
```typescript
export interface RegisterDeviceDto {
  push_token: string; // Push notification token
  platform: 'ios' | 'android';
}
```

### 2.6 History DTOs
```typescript
export interface GetHistoryRequestDto {
  conversation_id: string;
  before_timestamp?: string; // Pagination
  limit?: number; // Default 20
}

export interface HistoryResponseDto {
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
  }>;
}
```

### 2.7 User Profile DTO
```typescript
export interface UserProfileResponseDto {
  user_id: string;
  preferred_name: string;
  state: UserState; // CREATED | ONBOARDING | ACTIVE
  conversation_id?: string; // Null if not yet created
}
```

### 2.8 Error DTO (SPEC_PATCH.md)
```typescript
export interface ApiErrorDto {
  statusCode: number;
  message: string;
  error: string;
  constraints?: string[]; // Included only for validation errors (400)
}
```

**Explicit Status Codes (SPEC_PATCH.md):**
- 400 Bad Request: Validation failed (e.g., missing fields in Onboarding)
- 401 Unauthorized: Invalid or missing Auth Token
- 403 Forbidden: User state is CREATED (accessing chat) or Safety Ban
- 409 Conflict: Idempotency key collision (if handled as error) or unique constraint violation

---

## 3. Canonical Enums (Verbatim from API_CONTRACT.md)

### 3.1 UserState
```typescript
export enum UserState {
  CREATED = "CREATED",
  ONBOARDING = "ONBOARDING",
  ACTIVE = "ACTIVE"
}
```

### 3.2 AgeBand
```typescript
export enum AgeBand {
  AGE_13_17 = "13-17",
  AGE_18_24 = "18-24",
  AGE_25_34 = "25-34",
  AGE_35_44 = "35-44",
  AGE_45_PLUS = "45+"
}
```

### 3.3 OccupationCategory
```typescript
export enum OccupationCategory {
  STUDENT = "student",
  WORKING = "working",
  BETWEEN_JOBS = "between_jobs",
  OTHER = "other"
}
```

### 3.4 TopicId
```typescript
export enum TopicId {
  POLITICS = "POLITICS",
  RELIGION = "RELIGION",
  SEXUAL_CONTENT = "SEXUAL_CONTENT",
  SEXUAL_JOKES = "SEXUAL_JOKES",
  MENTAL_HEALTH = "MENTAL_HEALTH",
  SELF_HARM = "SELF_HARM",
  SUBSTANCES = "SUBSTANCES",
  GAMBLING = "GAMBLING",
  VIOLENCE = "VIOLENCE",
  ILLEGAL_ACTIVITY = "ILLEGAL_ACTIVITY",
  HATE_HARASSMENT = "HATE_HARASSMENT",
  MEDICAL_HEALTH = "MEDICAL_HEALTH",
  PERSONAL_FINANCE = "PERSONAL_FINANCE",
  RELATIONSHIPS = "RELATIONSHIPS",
  FAMILY = "FAMILY",
  WORK_SCHOOL = "WORK_SCHOOL",
  TRAVEL = "TRAVEL",
  ENTERTAINMENT = "ENTERTAINMENT",
  TECH_GAMING = "TECH_GAMING"
}
```

### 3.5 Message Status (from SCHEMA.md)
- `RECEIVED` — Initial status when message is inserted
- `PROCESSING` — Message is being processed
- `COMPLETED` — Message processing is complete (assistant response persisted)

---

## 4. Required Onboarding Fields (Verbatim from AI_PIPELINE.md §4.1.1)

The router/orchestrator MUST treat the following as required answers for ONBOARDING → ACTIVE:

1. **preferred_name** (string)
2. **age_band** (enum: 13–17 | 18–24 | 25–34 | 35–44 | 45+)
3. **country_or_region** (enum/ISO)
4. **occupation_category** (enum: student | working | between_jobs | other)
5. **client_timezone** (IANA string)
6. **proactive_messages_enabled** (bool; default ON)
7. **suppressed_topics** (list of TopicID; default empty)

> **Note:** This list is a canonical mirror of PRODUCT.md §5.1. Any mismatch between the two documents MUST be treated as a spec error and blocked from release.

---

## 5. Chat Idempotency Semantics (Verbatim from SPEC_PATCH.md + API_CONTRACT.md)

### 5.1 POST /chat/send — Idempotency Replay Semantics (v0.1)

Given `ChatRequestDto.message_id`:

**1) If this `message_id` has already been processed to completion:**
- Return HTTP 200
- Return the **same** `assistant_message` content and id that was persisted previously.

**2) If this `message_id` exists but is not completed (server previously accepted it and is still processing):**
- Return HTTP 409
- Response body: `ChatResponseDto` with `assistant_message.content` set to a deterministic "request in progress, retry" message.
- Server MUST NOT enqueue a second pipeline execution.

### 5.2 Replay Semantics (AI_PIPELINE.md §4.1.X)

If a turn arrives with an existing `message_id`:

- If the existing user message row is `COMPLETED`, return the **previously persisted assistant reply** for that turn.
- If the existing user message row is `RECEIVED` or `PROCESSING`, do not re-run the pipeline. Return a deterministic "in-progress" response (see API_CONTRACT.md Error / Refusal Semantics).
- A `message_id` MUST NOT produce more than one assistant message.

### 5.3 Idempotency Rule (AI_PIPELINE.md §4.1.2)

- If `message_id` already exists as COMPLETED, the server MUST return the previously stored assistant response and MUST NOT apply the state transition again.

---

## 6. SPEC_PATCH Override: Assistant Message Persistence (Verbatim from SPEC_PATCH.md)

### 6.1 Chat Turn Persistence Model Correction

**Replace the "Writeback" logic in Step 6j and Step 7 with:**

j. Transaction BEGIN:
   - **INSERT** new `messages` row for Assistant Response:
     - `id`: generate new UUID
     - `role`: 'assistant'
     - `content`: final_response
     - `status`: COMPLETED
     - `surfaced_memory_ids`: [list]
     - `trace_id`: same as user message trace_id
   - RelationshipService.update(delta)
   - MemoryService.extractAndPersist(user_text)
   - COMMIT
k. QueueService.enqueue('embedding', { memory_ids })

7) Return `assistant_message` object (id, content, created_at) to client.

> **CRITICAL:** Assistant message is a **new row INSERT**, NOT an UPDATE to the user message row.

---

## 7. Canonical API Terminology (SPEC_PATCH.md)

**STRICT TERMINOLOGY:** If variable names in this document differ from `API_CONTRACT.md`, `API_CONTRACT.md` is the **Canonical Source of Truth**.
- Use `user_message` (not `text`).
- Use `local_timestamp` (not `local_sent_at`).

---

## 8. Storage Rules (SPEC_PATCH.md)

**Storage rule (v0.1):**
`local_timestamp` is used only for telemetry/heuristics and is NOT persisted in Postgres in v0.1.
If provided, it may be logged in structured logs keyed by `message_id`.

---

## 9. Trace ID Requirement (SPEC_PATCH.md)

- `trace_id` (uuid) — generated by server at ingress per request/turn.
  - MUST be stable for all writes performed for that turn (messages, decision trace, memory writes).
  - Used to correlate the user message row and assistant message row for idempotency replay and audit.

---

## 10. Checklist for Implementation

### Before Coding:
- [ ] Quote exact relevant spec lines you are implementing (copy snippets into response)
- [ ] Verify endpoint path matches API_CONTRACT.md or SPEC_PATCH.md
- [ ] Verify DTO field names match API_CONTRACT.md exactly
- [ ] Verify enum values match API_CONTRACT.md exactly
- [ ] Check for SPEC_PATCH.md overrides that apply

### After Coding:
- [ ] **Spec Compliance Report:**
  - [ ] Endpoints added/changed (must match API_CONTRACT paths)
  - [ ] DTOs touched (must match API_CONTRACT names/fields)
  - [ ] Prisma schema touched (must match SCHEMA + SPEC_PATCH)
  - [ ] Any [MINIMAL DEVIATION] (must include reason + exact scope)

---

## 11. Database Schema Additions (SPEC_PATCH.md)

### 11.1 Push Token Storage
**Update `users` table in SCHEMA.md (B.1):**
| Column | Type | Nullable | Default | Notes |
| push_token | VARCHAR(256) | NULL | - | Push Token for Retention |

**Update Prisma Model (User):**
```prisma
model User {
  ...
  pushToken String? @map("push_token") @db.VarChar(256)
  ...
}
```

---

## 12. ONBOARDING → ACTIVE Atomic Commit (AI_PIPELINE.md §4.1.2)

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

**Technical Implementation Note (Crucial):**
This transition MUST use a **Prisma Interactive Transaction** (`prisma.$transaction`). 
- **Code Requirement:** The insertion of the first message and the update of User Status to 'ACTIVE' must happen within the same closure. 
- **Failure Condition:** If the message insert succeeds but the user update fails (or vice versa), the database must roll back to pre-insert state. Orphaned messages in ONBOARDING state are not allowed.

[MINIMAL DEVIATION] Qdrant healthcheck removed
MONOREPO_SETUP compose uses curl for Qdrant healthcheck, but the official qdrant/qdrant:v1.9.0 image does not include curl/wget/nc, causing the healthcheck to fail. We removed the healthcheck. Verify Qdrant with host request to http://localhost:6333/healthz (or /health if applicable).
