> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Layer 6: Intelligence

Where Dina thinks. This is the most complex layer.

**Sidecar mapping:** Layer 6 is split across dina-core and dina-brain. The PII scrubber has three tiers: Tier 1 (regex) runs in dina-core (Go — fast, no external calls); Tier 2 (spaCy NER) runs in dina-brain (Python — always available, ~15MB model); Tier 3 (LLM NER via Gemma 3n) runs on llama when available. Silence classification, context assembly, nudge generation, and all agent reasoning run in dina-brain (Python + Google ADK). In the default Cloud profile, brain calls Gemini Flash Lite for text and Deepgram Nova-3 for voice STT. With `--profile local-llm`, brain routes text inference to llama:8080.

### The PII Scrubber

Before any text leaves the device for LLM processing, it passes through local sanitization. The scrubber has three tiers — the first two are always available, the third requires llama.

```
Raw text from Vault
        ↓
┌─────────────────────────────────────┐
│  Tier 1: Regex (Go core)            │  ← Always. Fast hot path.
│  POST /v1/pii/scrub                 │
│                                     │
│  - Credit card numbers              │
│  - Phone numbers                    │
│  - Aadhaar / SSN                    │
│  - Email addresses                  │
│  - Bank account numbers             │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│  Tier 2: spaCy NER (Python brain)   │  ← Always. ~15MB model, milliseconds.
│  Local, runs in brain container      │
│                                     │
│  en_core_web_sm (or _md for better  │
│  accuracy, ~50MB):                  │
│  - Person names       (PERSON)      │
│  - Organizations      (ORG)         │
│  - Locations           (GPE/LOC)    │
│  - Addresses                        │
│  - Medical terms       (custom)     │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│  Tier 3: LLM NER (llama)           │  ← Optional. --profile local-llm.
│  Gemma 3n via llama:8080            │
│                                     │
│  Catches highly indirect references │
│  that spaCy misses:                 │
│  - "The CEO of [ORG] who wrote a   │
│     novel about AI in 2017"         │
│  - Coded language, paraphrasing     │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│  Replacement map (all tiers):       │
│  "Sancho" → [PERSON_1]             │
│  "4111-2222" → [CC_NUM]            │
│  "Infosys" → [ORG_1]              │
│  "sancho@email" → [EMAIL_1]        │
│  "Bengaluru" → [LOC_1]            │
└──────────────┬──────────────────────┘
               ↓
Sanitized text → sent to LLM for reasoning
               ↓
Response received
               ↓
┌─────────────────────────────────────┐
│  De-sanitizer (Local)               │
│  [PERSON_1] → "Sancho"             │
│  [ORG_1] → "Infosys"              │
│  [EMAIL_1] → "sancho@email"        │
└─────────────────────────────────────┘
               ↓
Final response with real names restored
```

**The flow:** Brain gets a task requiring cloud LLM → calls `core:/v1/pii/scrub` (Tier 1: regex) → runs spaCy NER locally (Tier 2: contextual entities) → optionally calls llama for LLM NER (Tier 3: ambiguous cases) → sends fully scrubbed text to cloud LLM. Tiers 1 and 2 are always available. Tier 3 requires `--profile local-llm`.

**Tier 1 — Regex (Go core, always available):** Fast pattern matching in Go. Catches structured PII: credit cards, phone numbers, Aadhaar/SSN, emails, bank accounts. Sub-millisecond. Runs as `POST /v1/pii/scrub` endpoint.

**Tier 2 — spaCy NER (Python brain, always available):** spaCy's statistical NER model runs in the brain container. `en_core_web_sm` (~15MB) for Phase 1, upgrade to `en_core_web_md` (~50MB) for better accuracy. Catches contextual PII that regex cannot: person names, organizations, locations, addresses. Runs in milliseconds on CPU. No llama, no GPU, no extra container required. This is the default NER layer for all deployment profiles.

**Tier 3 — LLM NER (llama, optional):** For edge cases where spaCy misses highly indirect or paraphrased references. Runs Gemma 3n via llama:8080. Only available with `--profile local-llm`. Options:
- **Phase 1: `Gemma 3n E2B`** (2B active params, ~2GB RAM). Prompt: "Extract all PII entities from this text." General-purpose — no fine-tuning needed.
- **Phase 1 fallback: `FunctionGemma 270M`** (270M params, ~529MB). Fine-tuned for structured extraction. 2500+ tok/sec.
- **Phase 2: Fine-tuned Gemma 3n E4B** (4B active, ~3GB RAM). Custom PII-detection fine-tuning for highest accuracy.

**PII scrubbing by deployment profile:**

| | **Cloud LLM** (default, Phase 1) | **Local LLM** / **Hybrid** |
|---|---|---|
| **Method** | Regex (Go) + spaCy NER (Python) | Regex (Go) + spaCy NER (Python) + LLM NER (llama) |
| **Catches** | Structured PII + contextual PII (names, orgs, locations, addresses) | All of the above + highly indirect references, coded language |
| **Misses** | Highly indirect references: "The person who founded that Bangalore software company and wrote fiction about AI" — no explicit entity for spaCy to tag | Near-zero misses. LLM understands paraphrasing and context. |
| **Sensitive personas** | Health/financial queries scrubbed via **Entity Vault** (Tier 1+2 mandatory) then routed to cloud. Cloud sees topics but cannot identify who. | Best privacy — processed entirely on llama, never leaves Home Node |
| **Model size** | spaCy `en_core_web_sm`: ~15MB (included in brain image) | spaCy + Gemma 3n E4B: ~3GB |
| **Latency** | Regex: <1ms. spaCy: ~5-20ms. | Regex: <1ms. spaCy: ~5-20ms. LLM NER: ~500ms-2s. |

**Why not use a cloud LLM for PII scrubbing?** Circular dependency: to scrub PII from text before sending it to a cloud LLM, you would have to send the un-scrubbed text to a cloud LLM first. The routing itself constitutes the leak. PII scrubbing must always be local. Dina will never route data to a cloud API for the purpose of PII detection.

**Residual risk (all profiles):** Even with three tiers, PII scrubbing cannot guarantee zero leakage for extremely indirect references. Mitigations:
1. **spaCy NER closes the biggest gap** — person names, organizations, and locations are the most common contextual PII. With Tier 1 + Tier 2, the vast majority of identifying information is caught in all profiles.
2. **The Entity Vault pattern** (see below) ensures the cloud LLM processes reasoning logic without observing the underlying entities. It sees health/financial **topics** but cannot identify **who**.
3. **Users handling highly sensitive non-persona data** (e.g., confidential business communications) should use Local LLM or Hybrid profile for LLM NER as a third layer.

### The Entity Vault Pattern

**Challenge:** In the Cloud LLM profile (Phase 1 default), managed hosting users on thin clients (browser, glasses, watch) have no local LLM and no on-device LLM. Without a policy for sensitive personas, health/financial queries would be rejected — making Dina unusable for the most common deployment scenario.

**Solution:** The Python brain container implements a mandatory, local NLP pipeline that scrubs all identifying entities before any data reaches a cloud LLM. The cloud LLM processes **reasoning logic** without ever observing the **underlying sensitive entities**.

**Mechanism — the Entity Vault:**

```
User query: "What did Dr. Sharma say about my blood sugar at Apollo Hospital?"
        │
        ▼
┌─────────────────────────────────────────────────────┐
│  Stage 1: Regex (Go core, /v1/pii/scrub)            │
│  No structured PII found in this query.             │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  Stage 2: spaCy NER (Python brain, local)           │
│                                                     │
│  Detected entities:                                 │
│    "Dr. Sharma"      → PERSON  → [PERSON_1]        │
│    "Apollo Hospital" → ORG     → [ORG_1]           │
│                                                     │
│  Entity Vault (ephemeral, in-memory dict):          │
│    { "[PERSON_1]": "Dr. Sharma",                    │
│      "[ORG_1]": "Apollo Hospital" }                 │
│                                                     │
│  Scrubbed query:                                    │
│    "What did [PERSON_1] say about my blood sugar    │
│     at [ORG_1]?"                                    │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  Cloud LLM (Gemini / Claude / GPT-4)                │
│                                                     │
│  Sees: "What did [PERSON_1] say about my blood      │
│         sugar at [ORG_1]?"                          │
│                                                     │
│  Processes reasoning. Returns:                      │
│  "[PERSON_1] at [ORG_1] noted your A1C was 11.2.   │
│   This is above the target range of 7.0..."         │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  Rehydration (Python brain, local)                  │
│                                                     │
│  Reads Entity Vault, replaces tokens:               │
│    [PERSON_1] → "Dr. Sharma"                        │
│    [ORG_1]    → "Apollo Hospital"                   │
│                                                     │
│  Final response to user:                            │
│  "Dr. Sharma at Apollo Hospital noted your A1C was  │
│   11.2. This is above the target range of 7.0..."   │
└─────────────────────────────────────────────────────┘
```

**What the cloud LLM sees vs. what it doesn't:**

| Cloud LLM sees | Cloud LLM does NOT see |
|---|---|
| Health **topics** (blood sugar, A1C, medication) | **Who** the patient is (name, email, location) |
| Financial **concepts** (portfolio, tax, returns) | **Whose** finances (name, account numbers, SSN) |
| Reasoning **logic** (compare, analyze, summarize) | **Which** doctor, hospital, bank, employer |
| Placeholder tokens: `[PERSON_1]`, `[ORG_1]` | The real entities behind those tokens |

**Why this is safe enough for Phase 1:**
1. The cloud LLM cannot link `[PERSON_1]`'s blood sugar to any real human. There is no name, no email, no location, no account number in the query.
2. This is **strictly better** than the alternative — if Dina rejects health queries, the user types the same question directly into ChatGPT with **zero scrubbing**.
3. Health/financial **topics** are not PII. Millions of people ask cloud LLMs about blood sugar and tax returns. The privacy risk is in the **identity**, which is scrubbed.

**Entity Vault lifecycle:**
- **Created** per-request in brain's memory. Not persisted to disk.
- **Scope:** one request-response cycle. Each cloud LLM call gets its own vault.
- **Destroyed** after rehydration. No Entity Vault outlives its request.
- **Never sent** to cloud, never logged, never stored in the main vault.

**With llama available (Local LLM / Hybrid profile):** Health/financial queries skip the Entity Vault entirely — processed on llama, never leave the Home Node. This is the best privacy option. The Entity Vault is a **pragmatic fallback** for Cloud LLM profile users who don't have llama.

**User consent:** During initial setup, Cloud LLM profile users see: *"Health and financial queries will be processed by your configured cloud LLM (e.g., Gemini). All identifying information (names, organizations, locations) is scrubbed before sending. The cloud provider sees health/financial topics but cannot identify you. For maximum privacy, enable the Local LLM profile."* User must explicitly acknowledge this.

### LLM Routing

Not all tasks need the same model. The dina-brain routes intelligently based on available infrastructure.

```
Task Classification (dina-brain)
        │
        ├── Simple lookup / search
        │   → dina-core: SQLite FTS5 query. No LLM needed.
        │
        ├── Basic summarization / drafting
        │   → llama:8080 if available (Gemma 3n E4B, local)
        │   → Cloud API if no llama (Gemini Flash Lite, PII-scrubbed)
        │
        ├── Complex reasoning / multi-step analysis
        │   → Cloud LLM via PII scrubber (dina-brain → dina-core scrub → cloud API)
        │   → Options: Claude, Gemini, GPT-4, self-hosted
        │   → User configures which provider they trust
        │
        ├── Sensitive persona (health, financial)
        │   → llama:8080 if available (best privacy — never leaves Home Node)
        │   → Without llama: Entity Vault scrubbing (Tier 1+2 mandatory),
        │     then cloud LLM. Cloud sees topics, not identities.
        │   → On-device LLM on rich client as alternative local path.
        │
        └── Latency-sensitive interactive (user actively chatting)
            → Rich client on-device LLM (LiteRT-LM / llama.cpp)
            → Instant response, no round-trip to Home Node
            → Falls back to Home Node for complex queries
```

**Home Node model specs (Gemma 3n, 2025):**
- **E2B**: 5B total / 2B active params (~2GB RAM). Runs on a $5 VPS.
- **E4B**: 8B total / 4B active params (~3GB RAM). Runs on Raspberry Pi 5 8GB.
- MatFormer architecture: E4B contains E2B — switch dynamically based on task complexity.
- Multimodal (text + image + audio + video), 32K context, 1.5x faster prefill via KV Cache Sharing.
- Crosses 1300 on LMArena (E4B) — first sub-10B model to do so.
- **FunctionGemma 270M** (529MB): structured function calls at 2500+ tok/sec for intent routing and query classification.

Architecture remains model-agnostic. When Gemma 4n or equivalent arrives, swap in.

### Context Injection (The Nudge)

When the user opens an app or starts an interaction, Dina searches the Vault for relevant context.

```
Trigger: User opens WhatsApp conversation with "Sancho"
        ↓
Dina queries Vault:
  - Recent messages with Sancho (Tier 1)
  - Relationship notes (Tier 1)
  - Pending promises/tasks involving Sancho (Tier 2 inferences)
  - Calendar: any upcoming events with Sancho
        ↓
Context assembled:
  "Last message: 3 days ago, he asked for the PDF"
  "His mother was ill last month"
  "You have lunch planned next Thursday"
        ↓
Nudge delivered:
  Overlay/notification: "He asked for the PDF last week. Mom was ill."
```

**Platform implementations:**
- **Android:** Accessibility Service reads current screen context. Dina runs query in background, pushes floating overlay or notification.
- **iOS:** Limited. No Accessibility Service equivalent. Options: Siri Intents (limited), keyboard extension, Share sheet. Full nudge capability requires Android or desktop.
- **Desktop:** Browser extension reads current tab/app. Dina runs as background service.

### Interrupt Classification (Silence Protocol)

Every incoming notification/event passes through the Silence Filter. The filter assigns one of three **priority levels** (not to be confused with storage tiers 0-5):

```
Incoming signal (email, notification, calendar alert, etc.)
        ↓
┌─────────────────────────────────────┐
│  Silence Filter                     │
│                                     │
│  1. Is this Priority 1 (Fiduciary)? │
│     Heuristics + local LLM check:  │
│     - Contains "urgent" + sender   │
│       is in trusted contacts?      │
│     - Financial alert from bank?   │
│     - Security warning?            │
│     - Health alert?                │
│     → YES: Interrupt immediately   │
│                                     │
│  2. Is this Priority 2 (Solicited)?│
│     Check user's pre-authorized    │
│     notification rules:            │
│     - "Alert me if Bitcoin > $100K"│
│     - "Wake me at 7 AM"           │
│     → YES: Notify                  │
│                                     │
│  3. Everything else = Priority 3   │
│     → SILENT. Queue for briefing.  │
└─────────────────────────────────────┘
```

The daily briefing summarizes queued Priority 3 items. Optional — user can disable.

---

