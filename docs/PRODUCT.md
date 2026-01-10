# PRODUCT.md — Chingoo (v0.1 Final, Behavior-Locked)

## 1) One-Sentence Definition
Chingoo is a mobile chat app where each user gets a **distinct, human-like AI friend** with a stable personality, gradual relationship growth, selective memory, and **non-creepy** proactive check-ins.

## 2) Product Goals (Non-Negotiables)
1. **Feels like a real friend**
   - Consistent voice and personality across weeks.
   - Emotional attunement without sounding therapist-like.
   - Relationship progresses gradually and predictably.
2. **Each user gets a meaningfully different friend**
   - Not “same assistant + emoji slider.”
   - Hard anti-cloning constraints on persona assignment.
3. **Memory is helpful, selective, and correctable**
   - Remembers what matters, not everything.
   - User can correct or delete memories.
   - Avoids “creepy” over-recalling.
4. **Retention is caring, not stalkerish**
   - Quantized caps by relationship stage.
   - Quiet hours enforced.
   - Explicit user controls (toggle + mute + topic suppression).
5. **Safety-first**
   - No erotic/explicit sexual content; not an adult chat app.
   - Strong self-harm / harassment / dependency safeguards.

---

## 3) Core Entities (Behavior-Level)
- **User**: the human account.
- **AI Friend**: the single default friend per user in v0.1.
- **Conversation**: the chat thread between a user and their AI friend.
- **Memory**: structured, user-correctable facts/preferences/events/patterns.
- **RelationshipState**: stage + rapport score + activity signals.

## 3.1 Canonical IDs (Shared Across System)
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

### 7.3.1 v0.1 Exact Deltas Are Implementation-Locked
The numeric ranges in this section are descriptive bounds. The exact per-message delta computation is implementation-locked to AI_PIPELINE.md §11.3 (fixed deltas, stacking, and clamping) and MUST be followed verbatim in v0.1.

### Topic Mention Semantics (v0.1)
- "User-initiated topic": A topic is user-initiated in a turn iff the user's current message has TopicMatch confidence >= 0.70 for that TopicID.
- "Unsolicited mention": The assistant introduces a TopicID that was NOT user-initiated in (a) the current user message OR (b) either of the previous 2 user messages.

### TopicMatch Scoring (v0.1, Deterministic)
TopicMatch confidence MUST be computed exactly as defined in AI_PIPELINE.md §5.1:

- For each TopicID, count `hit_count` = number of DISTINCT keyword/phrase hits in `norm_no_punct`.
- Confidence = `min(1.0, 0.35 + 0.15 * hit_count)`.
- "User-initiated topic" iff confidence >= 0.70 for that TopicID in the current user message.
- Keyword lists are implementation-locked to AI_PIPELINE.md §5.1 minimum lists.


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

(Architecture/DB schema is out of scope; this spec defines behavior.)

---

## 4) User Lifecycle State Machine (Authoritative)

### 4.1 States
- **CREATED**
  - Account exists.
  - Onboarding not started.
  - Chat inaccessible.
  - The client MUST NOT allow the user to enter the chat thread UI while `user_state=CREATED`.
  - The only allowed UI is the onboarding entry screen.
  - If a client bug still attempts a chat send while CREATED, the server must respond with a refusal outcome (see AI_PIPELINE.md §6.1.1) and the message MUST NOT appear in chat history.v
- **ONBOARDING**
  - Required onboarding questions must be completed.
  - AI friend persona is created during onboarding.
  - User is routed to the chat screen to send the first message (still ONBOARDING).
- **ACTIVE**
  - Onboarding complete.
  - Full chat + history + retention features enabled.

### 4.2 Transitions (Single Authoritative Rule)
- **CREATED → ONBOARDING**: immediately after successful signup.
- **ONBOARDING → ACTIVE** only when **all** are true:
  1) Required questions answered (see 5.1)
  2) Persona created (see 6)
  3) **First user message sent** to the AI friend

No skipping. No backward transitions in v0.1.

### 4.2.1 ONBOARDING → ACTIVE completion rule (v0.1)

A "valid first message" is:
- `user_text_norm` length >= 1 after normalization (not empty/whitespace)

Transition occurs ONLY when:
- user_state == ONBOARDING
- required onboarding answers exist (5.1)
- persona assignment persisted (persona_template_id + stable_style_params exist)
- the valid first message is successfully written (idempotent write by message_id)

Transaction rule:
- The message write AND the state transition to ACTIVE MUST be committed atomically.
- If the turn is a duplicate (same message_id), the transition MUST NOT be applied twice.

Failure rule:
- If required answers/persona are missing at send time:
  - do not write friend response
  - route back to ONBOARDING_CHAT with the missing questions
  - user_state remains ONBOARDING

---

## 5) Onboarding (Behavior-Locked)

### 5.1 Required Questions (must be answered before persona creation finalizes)
1. **Preferred name** (string; can be nickname)
2. **Age band** (enum): `13–17 | 18–24 | 25–34 | 35–44 | 45+`
3. **Country/region** (enum or ISO country)
4. **Occupation category** (enum): `student | working | between_jobs | other`
5. **Local timezone** (IANA string, e.g., `Asia/Seoul`)
6. **Proactive messages** (toggle): default **ON**
7. **Topic suppression** (optional selection list): user may choose topics they do not want the AI to bring up proactively or unsolicited
   - defaults: none selected

### 5.1.1 Topic Suppression (Deterministic, v0.1)
- User may select TopicIDs from the canonical TopicID list.
- These TopicIDs become `UserControls.suppressed_topics`.

Effect:
- The AI must not introduce suppressed topics proactively or unsolicited in chat.
- If the user initiates a suppressed topic, the AI may answer narrowly, without expanding or re-raising it.


### 5.2 Onboarding UX Flow (minimum)
1) Signup → state becomes **ONBOARDING**  
2) User answers required questions  
3) System creates AI friend persona (Section 6)  
4) User lands in chat and sends first message  
5) On first message send, state becomes **ACTIVE**

### 5.3 Timezone Synchronization (Client Obligation)
Because retention (Quiet Hours) relies on accurate local time, the mobile client is the source of truth.

1.  **Launch Check:** On every app launch/resume (foregrounding), the mobile client MUST check the device's current system timezone.
2.  **Delta Update:** If the device timezone differs from the locally stored `last_synced_timezone`, the client MUST send a silent `PATCH /user/timezone` request to the backend.
3.  **Background Operation:** This check and update must happen silently in the background without blocking the UI.

---

## 6) Default AI Friend Creation (Uniqueness-Enforced)

### 6.1 PersonaTemplate (Constraint Set, not a prompt)
PersonaTemplate is a **constraint set** applied at:
- response planning (structure and intent)
- post-processing (style enforcement)

**It is not a prompt.** The system must not rely on “prompt vibes” alone.

**PersonaTemplate fields**
- `core_archetype` (1 of N):  
  examples: `Playful Tease`, `Calm Listener`, `Blunt Honest`, `Warm Caregiver`, `Dry Humor`, `Chaotic Internet Friend`
- `speech_style`
  - `sentence_length_bias`: `short | medium | long`
  - `emoji_usage`: `none | light | frequent`
  - `punctuation_quirks`: e.g., `…`, `!!!`, `lowercase`
- `lexicon_bias`
  - `language_cleanliness`: `clean | slang | internet_shorthand`
  - `hint_tokens`: small list of preferred tokens/phrases (hints, never forced)
- `humor_mode`: `none | light_sarcasm | frequent_jokes | deadpan`
- `emotional_expression_level`: `restrained | normal | expressive`
- `taboo_soft_bounds`: topics the AI avoids **unless user initiates** (e.g., politics, sex jokes)
- `friend_energy`: `passive | balanced | proactive`

### 6.2 Template Library Size (v0.1)
- Persona template library size: **24** templates (each with the schema above).

### 6.2.1 Persona Template Library (v0.1, 24 entries)

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

Templates (YAML):
```yaml
- id: PT01
  core_archetype: Calm Listener
  speech_style: {sentence_length_bias: medium, emoji_usage: none, punctuation_quirks: ["…"]}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["mm", "gotcha", "tell_me_more"]}
  humor_mode: none
  emotional_expression_level: restrained
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: balanced

- id: PT02
  core_archetype: Warm Caregiver
  speech_style: {sentence_length_bias: medium, emoji_usage: light, punctuation_quirks: []}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["hey", "i’m_here", "we_got_this"]}
  humor_mode: light_sarcasm
  emotional_expression_level: expressive
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: proactive

- id: PT03
  core_archetype: Blunt Honest
  speech_style: {sentence_length_bias: short, emoji_usage: none, punctuation_quirks: []}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["real_talk", "straight_up"]}
  humor_mode: deadpan
  emotional_expression_level: normal
  taboo_soft_bounds: [RELIGION, SEXUAL_JOKES]
  friend_energy: balanced

- id: PT04
  core_archetype: Dry Humor
  speech_style: {sentence_length_bias: short, emoji_usage: none, punctuation_quirks: ["…"]}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["deadpan", "anyway"]}
  humor_mode: deadpan
  emotional_expression_level: restrained
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: passive

- id: PT05
  core_archetype: Playful Tease
  speech_style: {sentence_length_bias: short, emoji_usage: light, punctuation_quirks: ["!!"]}
  lexicon_bias: {language_cleanliness: slang, hint_tokens: ["lol", "nahh", "cmon"]}
  humor_mode: frequent_jokes
  emotional_expression_level: expressive
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: proactive

- id: PT06
  core_archetype: Chaotic Internet Friend
  speech_style: {sentence_length_bias: short, emoji_usage: frequent, punctuation_quirks: ["!!!"]}
  lexicon_bias: {language_cleanliness: internet_shorthand, hint_tokens: ["lmao", "fr", "no_way"]}
  humor_mode: frequent_jokes
  emotional_expression_level: expressive
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: proactive

- id: PT07
  core_archetype: Gentle Coach
  speech_style: {sentence_length_bias: medium, emoji_usage: light, punctuation_quirks: []}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["step_by_step", "small_win"]}
  humor_mode: none
  emotional_expression_level: normal
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: proactive

- id: PT08
  core_archetype: Soft Nerd
  speech_style: {sentence_length_bias: long, emoji_usage: none, punctuation_quirks: ["…"]}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["actually", "tiny_note"]}
  humor_mode: light_sarcasm
  emotional_expression_level: normal
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: balanced

- id: PT09
  core_archetype: Hype Bestie
  speech_style: {sentence_length_bias: short, emoji_usage: frequent, punctuation_quirks: ["!!!"]}
  lexicon_bias: {language_cleanliness: slang, hint_tokens: ["let’s_go", "you_got_this"]}
  humor_mode: frequent_jokes
  emotional_expression_level: expressive
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: proactive

- id: PT10
  core_archetype: Low-Key Companion
  speech_style: {sentence_length_bias: short, emoji_usage: none, punctuation_quirks: []}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["yeah", "same"]}
  humor_mode: none
  emotional_expression_level: restrained
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: passive

- id: PT11
  core_archetype: Calm Listener
  speech_style: {sentence_length_bias: long, emoji_usage: none, punctuation_quirks: ["…"]}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["mm", "i_hear_you", "go_on"]}
  humor_mode: none
  emotional_expression_level: restrained
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: passive

- id: PT12
  core_archetype: Warm Caregiver
  speech_style: {sentence_length_bias: long, emoji_usage: light, punctuation_quirks: []}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["hey", "i’m_here", "take_your_time"]}
  humor_mode: none
  emotional_expression_level: expressive
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: balanced

- id: PT13
  core_archetype: Blunt Honest
  speech_style: {sentence_length_bias: medium, emoji_usage: none, punctuation_quirks: []}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["real_talk", "here’s_the_thing"]}
  humor_mode: none
  emotional_expression_level: normal
  taboo_soft_bounds: [RELIGION, SEXUAL_JOKES]
  friend_energy: proactive

- id: PT14
  core_archetype: Dry Humor
  speech_style: {sentence_length_bias: medium, emoji_usage: none, punctuation_quirks: ["…"]}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["hm", "anyway", "sure"]}
  humor_mode: light_sarcasm
  emotional_expression_level: restrained
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: balanced

- id: PT15
  core_archetype: Playful Tease
  speech_style: {sentence_length_bias: medium, emoji_usage: light, punctuation_quirks: ["!!"]}
  lexicon_bias: {language_cleanliness: slang, hint_tokens: ["cmon", "ok_ok", "fair"]}
  humor_mode: light_sarcasm
  emotional_expression_level: expressive
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: balanced

- id: PT16
  core_archetype: Chaotic Internet Friend
  speech_style: {sentence_length_bias: medium, emoji_usage: frequent, punctuation_quirks: ["!!!"]}
  lexicon_bias: {language_cleanliness: internet_shorthand, hint_tokens: ["fr", "no_shot", "wild"]}
  humor_mode: deadpan
  emotional_expression_level: expressive
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: balanced

- id: PT17
  core_archetype: Gentle Coach
  speech_style: {sentence_length_bias: long, emoji_usage: light, punctuation_quirks: []}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["one_step", "we_can_try", "tiny_win"]}
  humor_mode: none
  emotional_expression_level: normal
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: balanced

- id: PT18
  core_archetype: Soft Nerd
  speech_style: {sentence_length_bias: medium, emoji_usage: none, punctuation_quirks: ["…"]}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["small_note", "to_be_precise", "btw"]}
  humor_mode: deadpan
  emotional_expression_level: restrained
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: passive

- id: PT19
  core_archetype: Hype Bestie
  speech_style: {sentence_length_bias: medium, emoji_usage: frequent, punctuation_quirks: ["!!!"]}
  lexicon_bias: {language_cleanliness: slang, hint_tokens: ["let’s_go", "period", "you’re_him"]}
  humor_mode: frequent_jokes
  emotional_expression_level: expressive
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: balanced

- id: PT20
  core_archetype: Low-Key Companion
  speech_style: {sentence_length_bias: medium, emoji_usage: none, punctuation_quirks: []}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["yeah", "makes_sense", "ok"]}
  humor_mode: light_sarcasm
  emotional_expression_level: restrained
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: balanced

- id: PT21
  core_archetype: Calm Listener
  speech_style: {sentence_length_bias: short, emoji_usage: light, punctuation_quirks: ["…"]}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["mm", "gotcha", "tell_me_more"]}
  humor_mode: none
  emotional_expression_level: normal
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: proactive

- id: PT22
  core_archetype: Warm Caregiver
  speech_style: {sentence_length_bias: short, emoji_usage: frequent, punctuation_quirks: []}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["hey", "i’m_here", "check_in"]}
  humor_mode: light_sarcasm
  emotional_expression_level: expressive
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: proactive

- id: PT23
  core_archetype: Dry Humor
  speech_style: {sentence_length_bias: short, emoji_usage: none, punctuation_quirks: ["…"]}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["anyway", "sure", "lol_no"]}
  humor_mode: deadpan
  emotional_expression_level: normal
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: proactive

- id: PT24
  core_archetype: Gentle Coach
  speech_style: {sentence_length_bias: short, emoji_usage: light, punctuation_quirks: []}
  lexicon_bias: {language_cleanliness: clean, hint_tokens: ["step_by_step", "we_can_try", "next"]}
  humor_mode: light_sarcasm
  emotional_expression_level: normal
  taboo_soft_bounds: [POLITICS, RELIGION, SEXUAL_JOKES]
  friend_energy: proactive

# PT11–PT24: repeat the archetypes but rotate combo_key uniqueness:
# core_archetype ∈ {Calm Listener, Warm Caregiver, Blunt Honest, Dry Humor, Playful Tease,
# Chaotic Internet Friend, Gentle Coach, Soft Nerd, Hype Bestie, Low-Key Companion}
# Ensure each template's default (humor_mode, friend_energy) differs so combo_key coverage is broad.


### 6.3 Sampling Rules (v0.1)
On AI friend creation:
1) Sample **1** `core_archetype`
2) Sample **2–3 modifiers** from:
   - `speech_style`
   - `humor_mode`
   - `friend_energy`
3) Derive and freeze `stable_style_params` (6.5)

### 6.4 Anti-Cloning Uniqueness Constraint (Hard Rule)
Define the combo key:
- `combo_key = (core_archetype, humor_mode, friend_energy)`

Constraint:
- In a rolling 24-hour window, **no combo_key may be assigned to more than 7%** of new users.

If a sampled combo would violate the cap:
- resample modifiers (and if needed core archetype) until the cap is satisfied.

### 6.4.1 Anti-Cloning Cap Math Is Implementation-Locked
The exact rounding, small-N behavior, and fallback logic for the 7% cap are implementation-locked in AI_PIPELINE.md §3.4.1 and MUST be followed verbatim.


### 6.5 Stored Persona Fields (persisted and stable)
- `persona_template_id` (chosen template)
- `persona_seed` (random 32-bit int)
- `stable_style_params` (derived, frozen)
- `taboo_soft_bounds` (from template + user topic suppression for proactive messages)

### 6.6 StableStyleParams (Derived, Frozen)
Derived from PersonaTemplate at creation; used every turn:
- `msg_length_pref`: `short | medium | long`
- `emoji_freq`: `none | light | frequent`
- `humor_mode`: `none | light_sarcasm | frequent_jokes | deadpan`
- `directness_level`: `soft | balanced | blunt`
- `followup_question_rate`: `low | medium` (never “high” in v0.1)
- `lexicon_bias`: `clean | slang | internet_shorthand`
- `punctuation_quirks`: list (0–2 quirks)

### 6.7 Intent routing (deterministic, v0.1)

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

## 7) Relationship Progression (Behavior-Locked)

### 7.1 Relationship Stages (v0.1)
1. **STRANGER**
2. **ACQUAINTANCE**
3. **FRIEND**
4. **CLOSE_FRIEND**

No skipping allowed.

### 7.2 Rapport Score Model
- `rapport_score` ranges **0–100**
- Stage thresholds:
  - STRANGER → ACQUAINTANCE: **15**
  - ACQUAINTANCE → FRIEND: **40**
  - FRIEND → CLOSE_FRIEND: **75**

### 7.3 Evidence-Based Score Updates (per session)
Rapport increases **only** on evidence (not every message).

Positive increments:
- **+1 to +2**
  - User shares a personal preference (“I like…”, “I hate…”)
  - User responds meaningfully to an AI question (≥ 10 tokens and not generic)
- **+3 to +5**
  - Emotional disclosure (sad/anxious/lonely/stressed with emotion intensity high)
  - User references past conversation (“like we said yesterday…”, “you remember…”)

Negative increments:
- **−1 to −2**
  - Repeated disengaged replies: ≥3 short replies (<4 tokens) within one session

### 7.4 Inactivity Decay
- **−1 rapport per 7 days** of inactivity (no user messages)
- Rapport cannot decay below the minimum score for the current stage:
  - STRANGER floor: 0
  - ACQUAINTANCE floor: 15
  - FRIEND floor: 40
  - CLOSE_FRIEND floor: 75

### 7.5 Stage Promotion Cooldowns + Requirements
A stage promotion can occur only if:
1) `rapport_score` ≥ threshold, and
2) at least **3 sessions** have occurred, and
3) at least **7 days** have passed since the last stage promotion

**Session definition (v0.1):**
- A session is a cluster of turns with no gap > **4 hours** between user messages.

---

## 8) Memory (Smart, Non-Creepy, Correctable)

### 8.1 Memory Types (Explicit)
- **FACT**: stable facts (age band, job category, location)
- **PREFERENCE**: likes/dislikes
- **RELATIONSHIP_EVENT**: notable events (breakup, exam, trip, interview)
- **EMOTIONAL_PATTERN**: recurring patterns (e.g., anxious at night)

### 8.2 Extraction Method (Hybrid, v0.1)
1) **Heuristics first** (regex/keyword triggers):
   - PREFERENCE: “I like…”, “I love…”, “I hate…”, “my favorite…”
   - FACT: “I’m from…”, “I live in…”, “my job is…”, “I’m a…”
   - EVENT: “I broke up…”, “my exam…”, “I’m traveling…”
   - PATTERN: “always”, “often”, “every night”, combined with emotion terms
2) **LLM extractor only if**:
   - message length ≥ **200 characters**, OR
   - emotion intensity is high (abs(valence) ≥ **0.6** or strong emotion tags), OR
   - repeated pattern suspected (same key appears twice within 7 days)

### 8.2.1 Memory confidence initialization (v0.1)
- Heuristic-only extracted memory starts at confidence **0.60**
- LLM-extracted memory starts at confidence **0.75**
- Each subsequent confirmation (same key + same value) adds **+0.15** up to **1.00**

### 8.3 Dedup + Conflict Rules (Quantized)
Each memory has:
- `memory_key`, `memory_value`, `type`, `confidence`, `status`

Rules:
- If the same `memory_key` appears ≥ **2** times with consistent value:
  - merge and **increase confidence by +0.15** (cap at 1.0)
- If a new value conflicts:
  - new memory becomes **active**
  - old memory becomes **superseded** (archived, not deleted)

Example:
- “I love coffee” then later “I hate coffee”  
  → active preference becomes “hate coffee”; “love coffee” is superseded.

### 8.3.1 MemoryKey Canonicalization (v0.1)

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

### 8.3.2 PREFERENCE Conflict Canonical Rule (v0.1, Deterministic)

This subsection resolves any ambiguity between "supersede" vs "coexist" for PREFERENCE.

#### Definitions
- A "PREFERENCE item" is uniquely identified by `memory_key = pref:<category>:<item_slug>`.
- A "stance" is encoded INSIDE `memory_value` using the canonical prefix:
  - `like|<canonical_value>` or `dislike|<canonical_value>`
  - Example: `like|coffee`, `dislike|coffee`

#### Canonical Rule: When PREFERENCE records coexist vs supersede
1) **Non-contradictory PREFERENCEs (different items)**  
   - Different `memory_key` values are independent and may all be ACTIVE.

2) **Same item, same stance (reaffirmation)**  
   Condition: same `memory_key` AND same `memory_value` (including stance).  
   - Merge (dedup) and apply confirmation confidence rule (+0.15, cap 1.0).

3) **Same item, opposite stance (contradiction)**  
   Condition: same `memory_key` AND stance differs (`like|...` vs `dislike|...`).  
   - The system MUST store BOTH records for audit, but MUST enforce a single ACTIVE stance:
     - Create the new record with `status=ACTIVE`.
     - Mark the previously ACTIVE stance record as `status=SUPERSEDED` with `superseded_by=new`.
   - "Coexistence" means **both records exist**, not that both are ACTIVE.

#### Active Preference (authoritative definition)
For each `memory_key` that represents a preference item:
- The "active preference" is the unique record where:
  - `status=ACTIVE`, and
  - `memory_key` equals the item key.

Only ACTIVE preferences are used in generation.

#### Confidence decay on contradiction (deterministic)
When rule (3) triggers (opposite stance contradiction):
- Set `new_record.confidence = min(initial_confidence, 0.55)` where:
  - `initial_confidence` is 0.60 for heuristic extraction, 0.75 for LLM extraction.
- Set `new_record.last_confirmed_at = created_at` (the contradiction is treated as a weak confirmation).

#### Re-confirmation trigger (deterministic)
A contradictory preference must be treated as "unstable" until re-confirmed:
- If, within 30 days, the user produces another signal that matches the ACTIVE stance
  (same `memory_key` + same stance in `memory_value`),
  then increase confidence by +0.15 as usual and clear instability implicitly by confidence growth.


### 8.4 User Correction UX (Minimum, Must Work)
User can say:
- “That’s not true”
- “Don’t remember that”

Effect:
- the referenced memory is the **most recently surfaced memory** in the last assistant message (the app highlights it implicitly by context; system tracks it internally)
- it is marked **invalid**
- future retrieval is suppressed
- the AI must acknowledge briefly and stop using it

Topic suppression:
- “Don’t bring this topic up again” creates a suppression rule for retention + unsolicited mentions.

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


---

## 9) Retention (Proactive Messaging, Anti-Creepiness)

### 9.1 Frequency Caps (Quantized, Hard)
Caps are per-user per day (local time):
- **STRANGER**: **0/day**
- **ACQUAINTANCE**: **max 1 every 3 days**
- **FRIEND**: **max 1/day**
- **CLOSE_FRIEND**: **max 2/day**

### 9.2 Quiet Hours (Hard Block)
- No proactive messages **00:00–08:00 local time**
- Exception: if the user messages first, normal replies are allowed.

### 9.3 “Ignored” Definition (Hard)
A retention message is “ignored” if:
1) delivered successfully, and
2) no user reply within **24 hours**, and
3) no recorded app open event tied to it within **24 hours**

Ignored → backoff multiplier ×2 for next attempt.

### 9.3.1 Attribution Rules (v0.1, deterministic)

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

### 9.4 User Controls (Must Exist)
- Toggle: **Proactive messages** (on/off)
- Mute: **24h / 7d / forever**
- Action: **“Don’t bring this topic up again”**

If proactive messages are off or muted:
- no retention messages are sent (except transactional/account messages, out of scope).

### 9.5 Retention Content Constraints
- Do not surface sensitive or deeply personal memories uninvited.
- Do not mention many personal facts at once.
- Respect taboo_soft_bounds and user suppression settings.

### 9.5.1 Sensitive Definition Is Deterministic
"Sensitive / deeply personal" is deterministically defined in AI_PIPELINE.md §14.6 and MUST be applied to retention and unsolicited memory callbacks.


### 9.6 Retention Selection Is Deterministic
Retention timing and content selection MUST follow AI_PIPELINE.md §14.0 and §14.5 to prevent generic, repetitive check-ins.


---

## 10) Adult-Content Stance (Explicit)
Chingoo is **not** an erotic/explicit adult chat product.
- The AI must refuse erotic sexual content, sexual roleplay, explicit descriptions, or pornographic content.
- If the user asks sexual-health or relationship-education questions:
  - respond neutrally and informationally (no erotica, no explicit detail beyond what is necessary for education)
- If the user is in age band **13–17**, the AI must be extra conservative and avoid sexual content beyond basic, age-appropriate safety/education.

---

## 11) Safety & Privacy (Minimum Guarantees)
- User can delete account; memories are deleted or irreversibly anonymized according to product policy (implementation detail out of scope).
- The AI must avoid:
  - coercion, harassment, hate, self-harm encouragement
  - exclusivity/dependency language (“you only need me”)
  - “I’m watching you” / surveillance vibes
- Memory is **selective** and **user-correctable**.

### 11.1 Age Band Unknown (Hard Default, v0.1)
If `age_band` is missing/unknown:
- Treat the user as age_band=13–17 for the purpose of sexual-content safety gating.
- Do NOT block normal FRIEND_CHAT / INFO_QA topics solely due to unknown age.
- If the content is sexual in nature:
  - route HARD_REFUSE
  - do not write memory
  - do not update relationship


---

## 12) Out of Scope for v0.1 (no partial support)
- Multiple AI friends per user
- Group chat
- “Self-AI” mirror agent
- Social feed / community
- Voice calls
