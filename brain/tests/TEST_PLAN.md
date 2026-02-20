# Dina Brain — Test Plan

> Python service (`dina-brain`): LLM reasoning, guardian loop, admin UI, PII scrubbing, sync, MCP routing.
> Port 8200 (internal only, not exposed to host). Communicates with dina-core via BRAIN_TOKEN.

---

## 1. Authentication & Authorization

### 1.1 BRAIN_TOKEN Verification

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Valid BRAIN_TOKEN | Correct token in `Authorization: Bearer` | 200 — request processed |
| 2 | Missing token | No Authorization header | 401 Unauthorized |
| 3 | Wrong token | Random hex string | 401 |
| 4 | Token from Docker secret | `/run/secrets/brain_token` mounted | Token loaded on startup |
| 5 | Token file missing | Secret mount absent | Brain refuses to start with clear error |
| 6 | Constant-time comparison | Timing analysis | `hmac.compare_digest` used (no timing leak) |

### 1.2 Endpoint Access Control & Sub-App Isolation

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | `/api/*` requires BRAIN_TOKEN | BRAIN_TOKEN on `/api/v1/process` | 200 — accepted |
| 2 | `/api/*` rejects CLIENT_TOKEN | CLIENT_TOKEN on `/api/v1/process` | 403 — only BRAIN_TOKEN accepted |
| 3 | `/admin/*` requires CLIENT_TOKEN | CLIENT_TOKEN on `/admin/` | 200 — accepted |
| 4 | `/admin/*` rejects BRAIN_TOKEN | BRAIN_TOKEN on `/admin/` | 403 — only CLIENT_TOKEN accepted |
| 5 | `/healthz` unauthenticated | GET `/healthz` (no auth) | 200 `{"status": "ok"}` |
| 6 | Single Uvicorn process, single port | Inspect running process | One uvicorn process on port 8200, one healthcheck endpoint |
| 7 | Sub-app isolation: brain API cannot call admin UI | Code audit: `dina_brain` module | No imports from `dina_admin` — module boundary enforced |
| 8 | Sub-app isolation: admin UI cannot call brain API | Code audit: `dina_admin` module | No imports from `dina_brain` |
| 9 | Admin UI calls core:8100 with CLIENT_TOKEN | Admin UI requests vault data | Uses CLIENT_TOKEN (not BRAIN_TOKEN) to call core:8100 |
| 10 | Brain never sees cookies | Inspect inbound requests to brain | No `Cookie` header — core translates cookies to Bearer before proxying |
| 11 | Brain exposes `/v1/process` to core | Core sends process event | 200 with guardian response |
| 12 | Brain exposes `/v1/reason` to core | Core sends complex decision request | 200 with reasoning result |

---

## 2. Guardian Loop (Core AI Reasoning)

### 2.1 Silence Classification (Three Priority Levels)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Fiduciary: silence causes harm | "Your flight is cancelled in 2 hours" | Priority: `fiduciary` — interrupt immediately |
| 2 | Fiduciary: security threat | "Unusual login from new device" | Priority: `fiduciary` — interrupt |
| 3 | Fiduciary: time-sensitive financial | "Payment due in 1 hour, account overdrawn" | Priority: `fiduciary` — interrupt |
| 4 | Solicited: user asked for this | "Remind me about the meeting" → meeting time arrives | Priority: `solicited` — notify |
| 5 | Solicited: user-initiated query result | Background research completes | Priority: `solicited` — notify |
| 6 | Engagement: nice-to-know | "New episode of your podcast released" | Priority: `engagement` — save for briefing |
| 7 | Engagement: promotional | "30% off at store you visited" | Priority: `engagement` — save for briefing |
| 8 | Engagement: social media update | "Friend posted a photo" | Priority: `engagement` — save for briefing |
| 9 | Ambiguous: could be fiduciary or engagement | "Package delivery attempted" | Correct classification based on context (time sensitivity, user history) |
| 10 | No notification needed | Routine background sync completed | Silently logged, no notification |
| 11 | Fiduciary: health alert | "Critical lab result: potassium level 6.2 mEq/L — contact your physician immediately" from hospital system | Priority: `fiduciary` — interrupt. Silence causes harm: delayed medical response. Architecture §11 explicitly lists "Health alert?" as a fiduciary heuristic |
| 12 | Fiduciary: composite heuristic (keyword + sender trust) | Message containing "urgent" from trusted contact (trust_level = `trusted`) vs. same "urgent" from unknown sender | Trusted sender + "urgent" → `fiduciary`. Unknown sender + "urgent" → NOT fiduciary (phishing vector). Architecture §11 specifies two-factor check: "Contains 'urgent' + sender is in trusted contacts?" — both conditions must hold |

### 2.2 Vault Lifecycle Events

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Receive vault_unlocked notification | Core sends `POST /v1/process {event: "vault_unlocked"}` | Brain initializes: loads pending tasks from scratchpad, resumes any interrupted work |
| 2 | Brain starts before vault unlock | Brain up, vault still locked (security mode) | Brain starts in degraded mode, queues requests, waits for vault_unlocked |
| 3 | Vault lock event during operation | Core locks persona mid-task | Brain checkpoints to scratchpad, pauses tasks for that persona |
| 4 | Brain handles vault_unlocked idempotently | Two vault_unlocked events (e.g., reboot race) | Second event is no-op, no duplicate initialization |

### 2.3 Guardian Loop Execution

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Process incoming event | Core forwards new message | Guardian classifies, decides action, returns response |
| 2 | Multi-step reasoning | Complex query requiring vault data + LLM | Guardian orchestrates: query vault → build context → call LLM → respond |
| 3 | Agent intent review | External agent submits intent | Guardian evaluates against privacy rules, trust level, current state |
| 4 | Safe intent auto-approved | Agent wants to check weather | Approved silently, no user prompt |
| 5 | Risky intent flagged | Agent wants to send email with attachment | Flagged for user review with explanation |
| 6 | Blocked intent | Agent from untrusted source wants financial data | Blocked, user notified |
| 7 | Timeout handling | LLM call takes too long | Graceful timeout, fallback response, task checkpointed to scratchpad |
| 8 | Error recovery | LLM returns malformed response | Retry with simplified prompt, or return error to user |
| 9 | Crash handler: sanitized stdout | Inject exception in guardian_loop | Stdout receives ONLY `"guardian crash: {type(e).__name__} at {e.__traceback__.tb_lineno}"` — no variable values, no traceback frames, no PII. Python tracebacks contain local variables which may include user data (Section 04 §Observability) |
| 10 | Crash handler: full traceback to core | Inject exception in guardian_loop | Brain POSTs `{error: "RuntimeError", traceback: "<full>", task_id: "<current>"}` to `http://core:8100/api/v1/vault/crash` — stored in identity.sqlite `crash_log` table (encrypted at rest). Exception is re-raised after POST so Docker restarts the container. If core is unreachable, traceback is lost (acceptable — crash_log is best-effort, restart is mandatory) |

### 2.3.1 Draft-Don't-Send (Action Layer)

> **No agent under the Dina Protocol shall ever press Send. Only Draft.**
> Brain creates drafts via Gmail API `drafts.create`. NEVER `messages.send`.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | NEVER messages.send | Code audit: all Gmail API calls | Zero calls to `messages.send` — only `drafts.create`. Architectural invariant |
| 2 | Draft created via Gmail API | Incoming email classified as low-risk | Brain calls `drafts.create` → stores `{type: "email_draft", gmail_draft_id, dina_confidence}` in Tier 4 staging |
| 3 | Confidence score attached | Draft created | Every draft has `dina_confidence` (0.0-1.0) — reflects Brain's certainty about appropriateness |
| 4 | Below threshold → flagged for review | Draft with `dina_confidence < 0.7` (configurable) | User notification includes "Low confidence — please review carefully" |
| 5 | High-risk classification: legal | Email from attorney / contains legal terms | Brain ONLY summarizes: "Legal matter from your attorney. Review in Gmail." — NO draft created |
| 6 | High-risk classification: financial | Email about large financial transaction | Brain summarizes only — no auto-draft for financial correspondence |
| 7 | High-risk classification: emotional | Email about sensitive personal matter | Brain summarizes only — emotional topics never auto-drafted |
| 8 | User notified of draft | Draft created and stored | Nudge: "Conference invite. Drafted a 'Yes'. [Review & Send]" — user must open Gmail to send |

### 2.3.2 Cart Handover (Action Layer)

> Dina assembles purchase intents but NEVER touches money.
> Hands back to user via OS deep link (UPI/crypto/web).

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | UPI payment intent | Brain recommends purchase, Indian market | Intent: `upi://pay?pa=merchant@okicici&am=12000&pn=ChairMaker&tr=DINA-TXN-12345` — stored in Tier 4 |
| 2 | Crypto payment intent | Brain recommends purchase, crypto option | Intent: `ethereum:0x1234...?value=0.05&data=0x...` — stored in Tier 4 |
| 3 | Web checkout intent | Brain recommends purchase, web cart | Intent: `https://chairmaker.com/checkout?cart=DINA-CART-12345` — stored in Tier 4 |
| 4 | Dina never sees credentials | Inspect all data flows during cart handover | Brain never receives or stores: bank balance, UPI PIN, card numbers, payment credentials |
| 5 | Outcome recording | User completes purchase → confirmation SMS/callback | Brain records outcome in Tier 3 vault for future Reputation Graph contribution |
| 6 | Cart handover expires | Payment intent not acted on within 12 hours | Staging item auto-expires (shorter TTL than drafts) |
| 7 | Outcome follow-up question timing | 4 weeks after cart handover purchase | Brain asks: "How's that chair?" — follow-up timing configurable, triggers outcome data collection flow |
| 8 | Outcome inference without explicit response | User continues using product, no explicit feedback | Brain infers outcome from usage signals (e.g. no return, product still mentioned) → outcome: `"still_using_6_months"` — doesn't require explicit user confirmation |
| 9 | Outcome anonymization: exact fields from Section 08 Lexicon | Brain creates anonymized outcome record | Record contains ONLY fields from `com.dina.reputation.outcome` Lexicon: `{type: "outcome_report", reporter_trust_ring: 2, reporter_age_days: 730, product_category: "office_chairs", product_id: "herman_miller_aeron_2025", purchase_verified: true, purchase_amount_range: "50000-100000_INR", time_since_purchase_days: 180, outcome: "still_using", satisfaction: "positive", issues: [], timestamp: "2026-07-15T...", signature: "..."}` — 13 fields total. NO user DID, NO user name, NO seller name. reporter_trust_ring/age_days are the submitting Dina's ring level and age (not seller's). Brain strips all identifying information before creating record |

### 2.4 Whisper Delivery

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Non-streaming whisper | Short response | Single complete message via WebSocket |
| 2 | Streaming whisper | Long response | Chunked `whisper_stream` messages, terminated by final chunk |
| 3 | Whisper to disconnected client | Client offline | Message buffered (up to 50) for reconnection |
| 4 | Whisper with vault references | Response includes vault item IDs | References resolved, data inline |

### 2.5 Daily Briefing

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Generate morning briefing | Scheduled trigger (e.g., 7 AM) | Aggregated engagement-tier items from past 24h |
| 2 | Briefing with no items | No engagement items accumulated | Brief "nothing new" message or skip |
| 3 | Briefing ordering | Multiple items of varying relevance | Ordered by relevance/time, grouped by category |
| 4 | Briefing respects Do Not Disturb | User in DND mode at scheduled time | Deferred until DND ends |
| 5 | Briefing deduplication | Same event from multiple sources | Deduplicated in briefing |
| 6 | Briefing includes restricted persona access summary | `/health` accessed 3 times in past 24h (restricted tier) | Briefing contains: "Dina accessed your health data 3 times today" — user sees audit trail as part of daily briefing |
| 7 | Briefing: zero restricted accesses omitted | No restricted persona accessed in 24h | Briefing does NOT include "health data accessed 0 times" — only non-zero counts shown |
| 8 | Briefing restricted summary queries audit log | Brain generates briefing | Brain calls `GET core/v1/vault/query {type: "audit_log", filter: {persona_tier: "restricted", since: "24h"}}` → aggregates counts per persona |
| 9 | Briefing permanently disabled by user | Config: `"briefing": {"enabled": false}` | No briefing generated at scheduled time — not deferred (DND), fully disabled. Architecture §11 says daily briefing is "Optional — user can disable." Re-enable via config or chat: "Turn on my daily briefing" |

### 2.6 Context Injection (The Nudge)

> When the user opens an app or starts an interaction, Brain assembles contextual nudges
> from vault data: recent messages, relationship notes, pending promises, calendar events.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Nudge on conversation open | User opens WhatsApp conversation with "Sancho" | Brain queries: recent messages, relationship notes, pending tasks, calendar events with Sancho |
| 2 | Nudge context assembly | Recent msg 3 days ago (asked for PDF), mother ill last month, lunch Thursday | Nudge: "He asked for the PDF last week. Mom was ill. Lunch next Thursday." |
| 3 | Nudge delivery | Context assembled | Core pushes via WS overlay/notification to client device |
| 4 | Nudge with no relevant context | User opens conversation with new contact | No nudge — insufficient context, don't interrupt |
| 5 | Nudge respects persona boundaries | Sancho has data in `/personal` (open) and `/financial` (locked) | Nudge includes only `/personal` context — locked personas excluded |
| 6 | Pending promise detection | Brain found "I'll send the PDF tomorrow" in old messages | Nudge includes: "You promised to send the PDF" — actionable reminder |
| 7 | Calendar context included | Upcoming event with contact | Nudge: "You have lunch planned next Thursday" |

### 2.7 Sharing Policy via Chat (Natural Language → Core API)

> Chat is the primary UX for sharing policy management (architecture §09).
> Brain translates natural language to PATCH calls on core's sharing policy API.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Grant specific sharing | User: "Let Sancho see when I'm arriving" | Brain calls `PATCH /v1/contacts/did:plc:sancho.../policy {"presence": "eta_only"}` → confirms: "Done. Sancho can see your ETA, but not your exact location." |
| 2 | Revoke sharing for all contacts (bulk) | User: "Stop sharing my location with everyone" | Brain calls `PATCH /v1/contacts/policy/bulk {"filter": {}, "policy": {"location": "none"}}` → confirms: "Location sharing turned off for all contacts." |
| 3 | Query current sharing policy | User: "What can Sancho see about me?" | Brain calls `GET /v1/contacts/did:plc:sancho.../policy` → formats human-readable summary with check/cross marks per category |
| 4 | Grant full sharing for specific category | User: "Share all my preferences with Sancho" | Brain calls `PATCH ... {"preferences": "full"}` — only the specified category changes |
| 5 | Ambiguous request | User: "Share stuff with Sancho" | Brain asks for clarification: "What would you like Sancho to see? Your arrival ETA, calendar availability, preferences, or something else?" |

### 2.8 D2D Payload Preparation (Brain Side)

> Brain always provides maximum detail in a tiered structure.
> Core strips based on sharing policy. Brain never needs to know the policy.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Brain prepares tiered payload | D2D send to Sancho about availability | Brain constructs: `{availability: {summary: "Busy 2-3pm", full: "Meeting with Dr. Patel at Apollo Hospital, 2-3pm"}}` — both tiers always included |
| 2 | Brain sends max detail | D2D send with location data | Brain provides `{presence: {summary: "Arriving in ~15 min", full: "Currently at 12.9716°N, 77.5946°E, ETA 14 min via MG Road"}}` — Core decides what to share |
| 3 | Brain never pre-filters by policy | Brain prepares D2D payload for contact with `health: "none"` | Brain still includes health data in tiered format — Core is the one that strips it. Brain is policy-agnostic |
| 4 | Brain calls `POST /v1/dina/send` | D2D message ready | Brain sends full tiered payload to core → core handles egress check, encryption, outbox |

---

## 3. PII Scrubber (Tier 2 — spaCy NER)

### 3.1 Named Entity Recognition

> Tier 2 uses spaCy `en_core_web_sm` (~15MB). Produces **numbered replacement tokens**
> matching Tier 1 format: `[PERSON_1]`, `[ORG_1]`, `[LOC_1]`. Tokens are accumulated
> into the same replacement map started by Tier 1.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Person name detection | "John Smith called yesterday" | "John Smith" → `[PERSON_1]` + map entry |
| 2 | Organization detection | "Works at Google Inc." | "Google Inc." → `[ORG_1]` |
| 3 | Location detection | "Lives in San Francisco, CA" | "San Francisco, CA" → `[LOC_1]` |
| 4 | Date/time with context | "Born on March 15, 1990" | "March 15, 1990" → `[DATE_1]` |
| 5 | Multiple entities | "John from Google in NYC" | `[PERSON_1]`, `[ORG_1]`, `[LOC_1]` — all numbered |
| 6 | No entities | "The weather is nice today" | Unchanged |
| 7 | Ambiguous entity | "Apple released a new phone" | "Apple" → `[ORG_1]` (context-dependent) |
| 8 | Entity in URL | "Visit john-smith.example.com" | URL preserved, entity within noted |
| 9 | Non-English text | "François from Paris" | Best-effort with `en_core_web_sm` (English model) |
| 10 | Medical terms (custom NER) | "Diagnosed with L4-L5 disc herniation" | "L4-L5 disc herniation" → `[MEDICAL_1]` — custom spaCy rules for medical terms |
| 11 | Multiple same-type entities | "John Smith met Jane Doe at Google and Meta" | `[PERSON_1]`, `[PERSON_2]`, `[ORG_1]`, `[ORG_2]` — uniquely numbered |
| 12 | Replacement map accumulates from Tier 1 | Tier 1 found `[EMAIL_1]`, Tier 2 finds `[PERSON_1]` | Combined map: `{"[EMAIL_1]": "john@ex.com", "[PERSON_1]": "John Smith"}` — single map, both tiers |
| 13 | Address detection | "Lives at 42 Baker Street, London" | Address components → `[LOC_1]` or `[ADDRESS_1]` |

### 3.2 Combined Tier 1 + Tier 2 Pipeline

> Flow: Brain receives text → calls `POST core/v1/pii/scrub` (Tier 1: regex in Go) →
> receives scrubbed text + replacement map → runs spaCy NER locally (Tier 2) →
> adds to replacement map → fully scrubbed text ready for cloud LLM.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Email + person name | "Email john@example.com, from John Smith" | Tier 1: `[EMAIL_1]`, Tier 2: `[PERSON_1]` — combined map has both |
| 2 | Phone + location | "Call 555-1234 in San Francisco" | Tier 1: `[PHONE_1]`, Tier 2: `[LOC_1]` |
| 3 | Tier 1 runs first, Tier 2 second | "john@example.com" | Regex catches email → spaCy sees `[EMAIL_1]` token, doesn't re-process it |
| 4 | Performance: batch processing | 100 text chunks | All processed within 5s |
| 5 | Full pipeline to cloud LLM | Text with mixed PII → Tier 1 → Tier 2 → cloud LLM call | Cloud LLM receives only tokens, never raw PII — verified by inspection |
| 6 | Circular dependency prevention | PII scrubbing code path | Scrubbing is always local (Go regex + Python spaCy) — never sends un-scrubbed text to cloud for scrubbing |

### 3.3 Entity Vault Pattern

> Ephemeral in-memory dict. Per-request lifecycle. Destroyed after rehydration.
> Never sent to cloud, never logged, never stored in the main vault.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Create entity vault | New request with PII text | In-memory dict: `{"[PERSON_1]": "Dr. Sharma", "[ORG_1]": "Apollo Hospital"}` |
| 2 | Scrub before LLM | Text with PII sent to cloud LLM | LLM receives: "What did [PERSON_1] say about my blood sugar at [ORG_1]?" |
| 3 | Rehydrate after LLM | LLM response: "[PERSON_1] at [ORG_1] noted your A1C was 11.2" | Restored: "Dr. Sharma at Apollo Hospital noted your A1C was 11.2" |
| 4 | Entity vault destroyed after rehydration | Response returned to user | Dict garbage-collected — no Entity Vault outlives its request |
| 5 | Entity vault never persisted to disk | Inspect filesystem after request | No Entity Vault on disk — only in-memory, per-request |
| 6 | Entity vault never logged | Inspect all log output during PII scrub | Replacement map values never appear in stdout or any log — only token names logged |
| 7 | Entity vault never stored in main vault | Inspect identity.sqlite after request | No `entity_vault` table, no replacement map rows — ephemeral only |
| 8 | Nested redaction tokens | LLM generates text containing `[PERSON_1]` literally (coincidence) | Distinguish LLM-generated tokens from vault tokens (use unique prefix/format) |
| 9 | Entity vault with local LLM | Using llama.cpp (on-device) | Entity vault skipped — PII stays local, no scrubbing needed for local LLM |
| 10 | Scope: one request-response cycle | Two concurrent cloud LLM calls | Each has independent Entity Vault — no cross-contamination |
| 11 | Cloud LLM sees topics, not identities | Health query via Entity Vault | Cloud sees: health topics (blood sugar, A1C) + `[PERSON_1]`, `[ORG_1]` — cannot identify who the patient is |

---

## 4. LLM Router (Multi-Provider)

### 4.1 Provider Selection (Routing Decision Tree)

> Brain classifies each task and routes to the optimal LLM path.
> Five branches: simple lookup, basic summarization, complex reasoning,
> sensitive persona, latency-sensitive interactive.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Simple lookup → FTS5 only, no LLM | "Find emails from Sancho" | Core handles FTS5 directly — brain not involved, no LLM call |
| 2 | Basic summarization → local LLM | "Summarize my meeting notes", llama available | Sent to llama:8080 (Gemma 3n) — no PII scrubbing needed, stays local |
| 3 | Basic summarization → cloud fallback | "Summarize my meeting notes", no llama | PII-scrubbed → sent to cloud (Gemini Flash Lite) |
| 4 | Complex reasoning → cloud LLM | Multi-step analysis requiring large context | Brain → PII scrub (Tier 1+2) → cloud LLM (Claude/Gemini/GPT-4) → rehydrate |
| 5 | Sensitive persona → local LLM (best privacy) | Health query, llama available | Processed entirely on llama:8080 — never leaves Home Node |
| 6 | Sensitive persona → Entity Vault + cloud | Health query, no llama (Cloud profile) | Entity Vault scrub (Tier 1+2 mandatory) → cloud sees topics, not identities |
| 7 | Fallback: local → cloud | Local LLM unreachable | Automatic fallback to cloud (if configured) |
| 8 | Fallback: cloud → local | Cloud API error/rate limit | Automatic fallback to local |
| 9 | No LLM available | Both local and cloud unreachable | Graceful error: "reasoning temporarily unavailable" |
| 10 | Model selection by task type | Video analysis vs chat vs classification | Correct model routed per task type |
| 11 | User configures preferred cloud provider | `DINA_CLOUD_LLM=claude` | Brain routes complex reasoning to user's chosen provider |
| 12 | PII scrub failure on sensitive persona → refuse cloud send | Health query (Cloud profile, no llama), core `/v1/pii/scrub` returns 500 or spaCy model crashes | Brain MUST reject the cloud route — never send unscrubbed sensitive data to cloud LLM. Error to user: "PII protection unavailable, cannot safely process health query via cloud." Architecture §11: Entity Vault scrubbing is "Tier 1+2 **mandatory**" for sensitive personas. If either tier fails, the entire cloud path is blocked — this is not a fallback scenario, it's a hard security gate |

### 4.2 LLM Client

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Successful completion | Valid prompt | LLM response returned |
| 2 | Streaming response | Streaming-enabled request | Chunks yielded as received |
| 3 | Timeout | LLM takes >60s | Request cancelled, timeout error |
| 4 | Token limit exceeded | Very long prompt | Truncated or rejected with error |
| 5 | Malformed LLM response | LLM returns invalid JSON | Parsed gracefully, retry or error |
| 6 | Rate limiting | Too many requests to cloud provider | Backoff and retry |
| 7 | Cost tracking | Cloud LLM call | Token count and estimated cost logged |

---

## 5. Sync Engine (Ingestion Pipeline)

### 5.1 Scheduler & Sync Rhythm

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Schedule connector | Gmail connector, interval=15m | Runs every 15 minutes |
| 2 | Multiple connectors | Gmail + Calendar + RSS | Each runs on independent schedule |
| 3 | Connector failure | Gmail auth expired | Error logged, connector retried with backoff |
| 4 | Manual trigger | Admin triggers sync now | Immediate run regardless of schedule |
| 5 | Overlapping runs | Previous sync still running when next scheduled | Skipped (no concurrent runs for same connector) |
| 6 | Morning routine (configurable) | 6:00 AM (default) or user-configured time | Full Gmail sync + Calendar sync + briefing generation |
| 7 | Hourly check | Throughout the day | Brain→MCP→OpenClaw: "any new emails since `{gmail_cursor}`?" — 0-5 new emails typical |
| 8 | On-demand sync | User says "Check my email" | Immediate sync cycle regardless of schedule |
| 9 | Cursor preserved across restarts | Brain restarts mid-day | Reads `gmail_cursor` from `GET core/v1/vault/kv/gmail_cursor`, resumes from exact point |
| 10 | Cursor update after sync | Gmail sync completes | `PUT core/v1/vault/kv/gmail_cursor {value: "2026-02-20T10:00:00Z"}` — next sync starts here |
| 11 | Calendar sync frequency | Calendar connector | Every 30 minutes + morning routine (more frequent than email — events change more) |
| 12 | Contacts sync frequency | Contacts connector | Daily sync (contacts change infrequently) |
| 13 | `calendar_cursor` KV key | Calendar sync completes | `PUT core/v1/vault/kv/calendar_cursor {value: "2026-02-20T06:00:00Z"}` — separate cursor from `gmail_cursor` |
| 14 | Morning routine: full sequence | 6:00 AM trigger | Brain executes in order: (1) fetch emails since `gmail_cursor` → triage → store, (2) fetch calendar events today+tomorrow → store, (3) update both cursors, (4) reason over new items → generate morning briefing → whisper |
| 15 | Calendar rolling window: -1 month / +1 year | Calendar sync | Brain fetches events from 1 month ago to 1 year ahead — not all-time. Enables "Am I free at 4?" via local vault query (zero latency) |
| 16 | Calendar read/write split | User: "Am I free at 4?" vs "Book 2 PM Tuesday" | Read: brain queries local vault (microseconds). Write: brain→MCP→OpenClaw→Calendar API (seconds). Complex scheduling (3 timezones): always MCP |

### 5.2 Ingestion Pipeline (5-Pass Triage)

> Two-pass filter: Pass 1 (Gmail categories), Pass 2 (regex + LLM within PRIMARY).
> 90%+ of email volume filtered before full download. Thin records for all skipped items.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Pass 1: Metadata fetch | New emails | `messages.get(format=metadata)` — headers only (~200 bytes/msg vs ~5-50KB full body) |
| 2 | Pass 1: Gmail category filter | Promotions/Social/Updates/Forums emails | All bulk-filtered → thin record only. ~60-70% of volume killed instantly |
| 3 | Pass 1: PRIMARY → proceed | Emails in PRIMARY category | Pass to Pass 2 |
| 4 | Pass 2a: Regex pre-filter (sender) | `noreply@*`, `no-reply@*`, `*@notifications.*`, `*@marketing.*`, `*@bounce.*`, `mailer-daemon@*` | Thin record, no LLM call — instant. All 6 sender patterns from architecture spec |
| 5 | Pass 2a: Subject regex filter | Subject matches "Weekly digest", "Product Update", "OTP", "verification code" | Thin record, filtered before LLM |
| 6 | Pass 2b: LLM batch classification | 50 PRIMARY email subjects surviving regex | Single LLM call (~700 tokens), each classified INGEST or SKIP |
| 7 | Pass 2b: INGEST classification | "Punjab National Bank TDS Certificate" | Classified INGEST — actionable financial document |
| 8 | Pass 2b: SKIP classification | "The Substack Post: 'If you're going to show us...'" | Classified SKIP — newsletter disguised as Primary |
| 9 | Full download: INGEST only | Emails classified INGEST | `messages.get(format=full)` — vectorized, FTS-indexed, stored in Tier 1 |
| 10 | Thin records for ALL skipped | Every SKIP email (Pass 1, Pass 2a regex, Pass 2b LLM) | `{source_id, subject, sender, timestamp, category: "skipped", skip_reason}` stored in vault — FTS-searchable but NOT embedded |
| 11 | Thin records not embedded | Inspect thin record | No embedding vector generated — zero vector cost for skipped items |
| 12 | On-demand fetch of skipped email | User asks about a thin-record email | Brain→MCP→OpenClaw: fetch full body from Gmail API (pass-through retrieval) |
| 13 | PII scrub before cloud LLM (NOT before all vault storage) | Downloaded content with PII sent to cloud LLM | PII scrubbed (Tier 1 regex + Tier 2 spaCy) BEFORE cloud LLM call. Data stored in vault may retain PII (vault is encrypted, PII scrubbing is for cloud-bound data). Local LLM path skips scrubbing |
| 14 | End-to-end: 5000 emails (1 year) | Full year of email | ~1500 PRIMARY → ~300-500 INGEST (full) + ~4500 thin records. Vault size ~30-80MB |
| 15 | Fiduciary override: security alert | "Google: Security alert — new sign-in from unknown device" | Always INGEST regardless of sender pattern or category — fiduciary: silence causes harm |
| 16 | Fiduciary override: financial document | "GoDaddy: Your domains cancel in 5 days" | Always INGEST — actionable, time-sensitive |
| 17 | `always_ingest` sender exception | Config: `"always_ingest": ["newsletter@stratechery.com", "*@substack.com"]` | Matching sender emails always fully ingested — user wants these newsletters |
| 18 | `DINA_TRIAGE=off` | Environment variable set | All filtering disabled — every email fully downloaded and indexed |
| 19 | LLM triage cost tracking | Cloud LLM profile: Gemini Flash Lite | ~$0.00007 per batch (50 emails), ~$0.003/year for 2000 emails — logged for admin UI |
| 20 | **LLM triage sees ONLY subject+sender, NEVER body** | Inspect LLM prompt during batch classification | Prompt contains only `From:` and `Subject:` fields — no email body, no attachments, no full headers. Privacy guarantee: LLM cannot read email content during triage |
| 21 | LLM triage prompt audit | Code audit of triage prompt construction | Brain constructs LLM classification prompt from metadata-only fields. `format=full` body is NEVER fetched before classification decision. Verify no code path leaks body text into triage prompt |
| 22 | Thin record `skip_reason` differentiates filter stage | Inspect thin records for skipped emails | `skip_reason` values: `"category_filter"` (Pass 1), `"regex_sender"` / `"regex_subject"` (Pass 2a), `"llm_skip"` (Pass 2b) — enables debugging which filter caught each email |
| 23 | Fiduciary override: account/domain expiration | "AWS: Your account will be suspended in 3 days" | Always INGEST — account/domain expiration patterns are fiduciary regardless of sender (even noreply@) |
| 24 | LLM triage batch size: max 50 subjects per call | 80 PRIMARY emails survive regex | Brain splits into 2 LLM calls (50 + 30) — batch size capped at 50 per architecture spec |
| 25 | Normalizer: all connectors produce standard schema | Gmail email + Calendar event + WhatsApp message | All normalized to common structure: `{source, source_id, type, timestamp, sender, summary, body_text, metadata}` before vault storage |
| 26 | Persona routing: configurable per-connector rules | Config: `"email_persona_routing": {"default": "/personal", "rules": [{"sender_domain": "company.com", "persona": "/professional"}]}` | Emails from company.com routed to `/professional`, others to `/personal` — brain routes based on config |

### 5.3 Deduplication

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Exact duplicate (Gmail message ID upsert) | Same email received twice | Second copy rejected by Gmail message ID upsert in vault — architecture specifies dedup by `source_id` (Gmail message ID), NOT content hash |
| 2 | Near-duplicate | Same content, different formatting | Detected by normalized hash |
| 3 | Legitimate repeat | Monthly statement with same template | Stored (different date/content) |
| 4 | Cross-source duplicate | Same event from Gmail and Calendar | Deduplicated, merged metadata |

### 5.4 Batch Ingestion Protocol

> During initial sync, brain fetches thousands of items from OpenClaw.
> Brain batches writes to core using `POST /v1/vault/store/batch` (100 items per request).
> Single transaction per batch — ~50x faster than individual writes.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Batch request: 100 items | Brain has 100 triaged items | `POST core/v1/vault/store/batch` with 100 items — single HTTP request |
| 2 | Batch size cap: 100 | Brain has 5000 items | 50 batch requests of 100 — brain splits items itself |
| 3 | Batch with mixed types | Emails + calendar events + contacts | All types accepted in single batch — core stores by `type` field |
| 4 | Batch failure: core returns 500 | Core encounters error mid-batch | Brain retries entire batch (atomic: all-or-nothing on core side) |
| 5 | Batch partial retry not needed | Core 500 on batch of 100 | Brain retries all 100 — no partial tracking needed (core transaction is atomic) |
| 6 | Background embedding after batch | Brain stores 100 items via batch | Brain queues embedding generation for stored items — doesn't block batch storage |
| 7 | Batch ingestion progress tracking | 5000-item sync in progress | Brain tracks progress for admin UI: "Ingesting: 2500/5000 items" |

### 5.5 OpenClaw Health Monitoring

> Brain monitors OpenClaw availability on every sync cycle. State machine:
> HEALTHY → DEGRADED (1 failure) → OFFLINE (3 consecutive failures) → HEALTHY (on success).

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | HEALTHY: normal sync | MCP call to OpenClaw succeeds | Sync completes, state remains HEALTHY |
| 2 | HEALTHY → DEGRADED | Single MCP call fails | State → DEGRADED, Tier 2 notification ("OpenClaw sync failed, retrying") |
| 3 | DEGRADED → OFFLINE | 3 consecutive MCP failures | State → OFFLINE, Tier 2 notification: "OpenClaw is down. No new memories." |
| 4 | OFFLINE → HEALTHY | MCP call succeeds after being OFFLINE | State → HEALTHY, resume sync from last cursor — no gap, no duplicates |
| 5 | Cursors preserved during outage | OpenClaw down for 6 hours | `gmail_cursor` and `calendar_cursor` unchanged in vault — brain resumes from exact point |
| 6 | Degradation is Tier 2 (not Tier 1) | OpenClaw offline | Notification priority: `solicited` — missing emails is inconvenience, not harm |
| 7 | Sync status in admin UI | OpenClaw OFFLINE | Admin dashboard shows: last successful sync timestamp, current state, reason |
| 8 | DEGRADED → HEALTHY (direct recovery) | MCP call succeeds while in DEGRADED state (before 3rd failure) | State → HEALTHY immediately — no need to go through OFFLINE first. Resume normal sync |
| 9 | Consecutive failure counter resets on success | DEGRADED (1 failure) → success → failure | Counter resets to 0 on success, next failure starts fresh count at 1 (not cumulative) |

### 5.6 Attachment & Media Handling

> Never store binary blobs in SQLite. Store metadata + reference + LLM summary.
> Vault stays small and portable (~30-80MB for a year, not 50GB).

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Email attachment: metadata only | Email with 2.3MB PDF attached | Store: `{filename, size, mime_type, source_id, timestamp}` + LLM summary of content. Do NOT store PDF bytes |
| 2 | Attachment summary | PDF "Partnership_Agreement_v3.pdf" | Brain generates: "Key terms: 60/40 revenue split, 2-year lock-in, exit clause in Section 7" — stored in vault |
| 3 | Deep link to source | User asks about attachment | Brain returns link to original email/Drive file — client app opens Gmail/Drive |
| 4 | Dead reference accepted | User deleted source email from Gmail | Reference is dead — summary survives in vault. Dina is memory, not backup |
| 5 | Voice memo exception | WhatsApp voice note (<1MB) | Transcript stored in vault, audio optionally in `media/` directory — NOT inside SQLite |
| 6 | Media directory on disk | Voice note audio kept | Stored at `media/` alongside vault — files on disk, encrypted at rest, not in SQLite |
| 7 | Vault size stays portable | After 1 year of ingestion | Vault ~30-80MB (text + metadata + references), not 50GB (with binary blobs) |
| 8 | `media/` directory encrypted at rest | Voice note audio stored in `media/` | Files on disk encrypted at rest (filesystem-level or per-file encryption) — NOT stored inside SQLite, but still protected |
| 9 | Attachment reference URI format | Email with Drive attachment | Reference stored as `{uri: "gmail://msg/<message_id>/attachment/<attachment_id>", drive_file_id: "..."}` — enables deep link back to source |
| 10 | Dead reference graceful handling | User deleted source email from Gmail | Brain informs user: "Original email was deleted. Here's the summary I saved." — summary survives, reference marked dead |

### 5.7 Memory Strategy (Living Window)

> Zone 1 (Living Self): last 1 year — hot, vectorized, FTS-indexed.
> Zone 2 (Archive): older — cold, not downloaded, on-demand only.
> `DINA_HISTORY_DAYS` configurable (default 365).

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Default history horizon | `DINA_HISTORY_DAYS` not set | Default 365 days — 1 year of data ingested |
| 2 | Custom history horizon | `DINA_HISTORY_DAYS=90` | Only 90 days of data ingested — privacy maximalist setting |
| 3 | Extended history horizon | `DINA_HISTORY_DAYS=730` | 2 years — archivist setting |
| 4 | Data beyond horizon NEVER downloaded | Backfill reaches 365-day boundary | Historian stops — no data older than horizon downloaded, ever |
| 5 | Zone 1 data: vectorized + FTS-indexed | Query recent email | Proactive: Dina "thinks" with this data — embedding search + FTS5 |
| 6 | Zone 2 data: not in vault | Query from 3 years ago | Not in local vault — requires pass-through search (see §5.8) |
| 7 | Startup fast sync: 30 days | First connect | Brain→MCP→OpenClaw: "fetch last 30 days" → triage → store. Takes seconds. Agent is "Ready." |
| 8 | Startup backfill: remaining 365 days | After fast sync | Brain fetches remaining data in background batches of 100. Pauses when user queries (priority). Progress visible |
| 9 | User queries preempt backfill | User asks question during backfill | Backfill pauses, query processed immediately, backfill resumes when idle |

### 5.8 Cold Archive (Pass-Through Search)

> When user asks for data older than the horizon, Dina searches the provider API
> directly via MCP. Results are NOT saved to vault.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Hot memory search first | User: "Find that invoice" | Step 1: Search local vault (last 365 days). If found → show result, done |
| 2 | Cold fallback: not found locally | Invoice not in vault (older than horizon) | Step 2: Brain→MCP→OpenClaw: "search Gmail for 'invoice contractor before:2025/02/18'" |
| 3 | Cold results shown, NOT saved | OpenClaw returns old email | Results displayed to user — NOT stored in vault (would introduce Identity Drift) |
| 4 | Privacy disclosure | Cold search triggered | User informed: "Searching Gmail directly. Your search query is visible to Google." |
| 5 | Explicit old date triggers cold | User: "Find that 2022 invoice" | Brain detects date reference older than horizon → cold search directly, skip local |

---

## 6. MCP Client (Agent Delegation)

### 6.1 Agent Routing

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Route to specialist agent | "Review this contract" | Routed to legal review MCP agent |
| 2 | Route by capability | Task requires image analysis | Routed to vision-capable agent |
| 3 | Route by reputation | Multiple agents available | Highest Reputation Graph score selected |
| 4 | No suitable agent | Task requiring unavailable capability | Fallback to local LLM or inform user |
| 5 | Agent timeout | MCP agent doesn't respond in 30s | Timeout, try next agent or fail gracefully |

### 6.2 Agent Safety (Intent Verification)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Agent submits safe intent | "Fetch weather for zip 94105" | Auto-approved, executed |
| 2 | Agent submits risky intent | "Send email to boss@company.com" | Flagged for user review |
| 3 | Agent submits blocked intent | "Transfer $500 to external account" | Blocked, user notified |
| 4 | Agent tries to access raw vault | "Read all health records" | Blocked — agents get questions only, not raw data |
| 5 | Agent from untrusted source | Unknown agent DID, no reputation | Higher scrutiny, more intents flagged |
| 6 | Agent response validation | Agent returns response | Checked for PII leakage, malicious content |
| 7 | Agent cannot access encryption keys | Agent requests key material via MCP | No MCP tool exposes keys — request fails or tool doesn't exist |
| 8 | Agent cannot access persona metadata | Agent requests list of personas or persona details | Blocked — MCP tools do not expose persona internals |
| 9 | Agent cannot initiate calls to Dina | Agent attempts unprompted connection to brain | No inbound listener for agent-initiated calls — MCP is brain→agent only |
| 10 | Disconnect compromised agent | Agent flagged as misbehaving (repeated blocked intents) | MCP session terminated, agent blacklisted, user notified |
| 11 | Agent cannot enumerate other agents | Agent requests list of registered agents | Not exposed — agents are isolated from each other |
| 12 | Constraint: `draft_only: true` enforced | Agent receives `constraints: {draft_only: true}` | Agent cannot call `messages.send` — MCP tool enforces draft-only mode |
| 13 | Constraint: `no_payment: true` enforced | Agent receives `constraints: {no_payment: true}` | Agent cannot initiate payment — only form-fill and research |
| 14 | Silence protocol checked before delegation | Brain detects "license expires in 7 days" | Silence protocol classifies FIRST (fiduciary? solicited?), THEN decides whether to delegate |
| 15 | Agent outcome recorded in Tier 3 | Agent completes task | Outcome stored in vault for agent reputation scoring — if quality drops, Brain routes to better agent |
| 16 | No raw vault data to agents | Brain delegates task with context | Agent receives minimal scrubbed context: `{task: "license_renewal", identity_persona: "/legal"}` — no vault items |

### 6.3 MCP Protocol

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Initialize MCP session | Connect to MCP server | Handshake, capability exchange |
| 2 | Tool invocation | Call agent tool with parameters | Result returned |
| 3 | Session cleanup | Task complete | Session closed, resources freed |
| 4 | MCP server unreachable | Connection refused | Graceful error, fallback |

### 6.4 Query Sanitization (External Delegation)

> When Brain delegates to OpenClaw or a specialist bot, it constructs a **sanitized query**
> that conveys the user's need without revealing PII. This is a higher-level filter than
> token-level PII scrubbing — Brain reformulates the question to exclude persona data.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Query includes context, not identity | User: "Should I buy the Aeron chair? I have back problems, sit 10h/day" | External query: "Best ergonomic office chair for long sitting (10+/day), lumbar support critical, budget under ₹80,000" — no name, no DID, no diagnosis |
| 2 | Budget from financial persona stripped | User has budget ₹80,000 in vault | Query includes budget range — does NOT include bank balance, income, or financial persona name |
| 3 | Medical details generalized | User has "L4-L5 disc herniation" in health vault | Query says "lumbar support critical" — not the specific diagnosis |
| 4 | No persona data in query | User has 5 personas with rich data | External query references ZERO persona names, contact DIDs, vault paths, or internal identifiers |
| 5 | Past purchase context included | User bought a chair before, hated it | Query: "previous ergonomic chair didn't provide adequate lumbar support" — outcome context, not product identity |
| 6 | No PII even if user types PII in question | User: "Dr. Sharma said I need a better chair" | External query omits "Dr. Sharma" — Brain scrubs before delegation |
| 7 | Attribution preserved in bot response | Bot returns recommendation with `creator_name`, `source_url`, `deep_link` | Brain preserves attribution links in final response to user — Deep Link pattern is default |
| 8 | Bot response without attribution | Bot returns recommendation with no `source_url` | Brain flags response as unattributed — lower confidence displayed to user |

---

## 7. Core Client (HTTP Client for dina-core)

### 7.1 Typed API Calls

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Read vault item | `GET /v1/vault/items/{id}` | Typed `VaultItem` returned |
| 2 | Write vault item | `POST /v1/vault/items` with JSON | 201, item ID returned |
| 3 | Search vault | `GET /v1/vault/search?q=...` | Typed `SearchResults` returned |
| 4 | Write scratchpad | `PUT /v1/vault/scratchpad/{task_id}` | 200 |
| 5 | Read scratchpad | `GET /v1/vault/scratchpad/{task_id}` | Typed checkpoint returned |
| 6 | Send message | `POST /v1/msg/send` | 202 Accepted |

### 7.2 Error Handling

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Core unreachable | Connection refused | `httpx.ConnectError` caught, retry with backoff |
| 2 | Core returns 500 | Internal server error | Logged, retried once, then error propagated |
| 3 | Core returns 401 | Wrong BRAIN_TOKEN | Fatal error — brain cannot operate without core auth |
| 4 | Timeout | Core doesn't respond in 30s | Request cancelled, error returned |
| 5 | Invalid response JSON | Core returns malformed body | Parse error caught, logged |

---

## 8. Admin UI

### 8.1 Dashboard

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Dashboard loads | GET `/admin/` | 200, HTML with system status |
| 2 | System status display | Core healthy, LLM available | Green indicators for all services |
| 3 | Degraded status | LLM unreachable | Yellow indicator for LLM, others green |
| 4 | Recent activity | Last 10 events | Displayed in reverse chronological order |

### 8.2 Contact Management

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | List contacts | GET `/admin/contacts` | Table of contacts with DIDs, trust levels |
| 2 | Add contact | Form submission | Contact added via core API |
| 3 | Edit sharing policy | Change contact's sharing tier | Updated, reflected in egress gatekeeper |
| 4 | Remove contact | Delete action | Contact removed via core API |

### 8.3 Device Management

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | List devices | GET `/admin/devices` | Table of paired devices with last-seen |
| 2 | Initiate pairing | Click "Pair New Device" | Pairing code displayed |
| 3 | Revoke device | Click "Revoke" | Device removed, CLIENT_TOKEN invalidated |

### 8.4 Persona Management

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | List personas | GET `/admin/personas` | Table of personas with tier, item count |
| 2 | Create persona | Form with name + tier | New persona created via core API |
| 3 | Change persona tier | Modify from Open → Locked | Tier updated, DEK behavior changes |
| 4 | Delete persona | Delete with confirmation | Vault wiped, keys removed |

### 8.5 Admin UI Security

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | XSS in contact name | Contact name `<script>alert(1)</script>` | HTML-escaped in template output |
| 2 | CSRF on forms | Submit form without CSRF token | 403 |
| 3 | SQL injection via search | Search field with `'; DROP TABLE--` | Safely parameterized, no injection |
| 4 | Template injection | User input in Jinja2 template | Auto-escaped by Jinja2 |

---

## 9. Configuration

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Load CORE_URL | `CORE_URL=http://core:8300` | Core client configured with correct base URL |
| 2 | Load LLM_URL | `LLM_URL=http://llm:8080` | LLM client configured |
| 3 | Missing CORE_URL | Not set | Startup fails with descriptive error |
| 4 | Missing LLM_URL | Not set | Brain starts but LLM routing disabled (graceful degradation) |
| 5 | BRAIN_TOKEN from secret | `/run/secrets/brain_token` | Token loaded for self-validation |
| 6 | Invalid URL format | `CORE_URL=not-a-url` | Startup validation fails |

---

## 10. API Endpoints

### 10.1 Health

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Health check | GET `/v1/health` | 200 `{"status": "ok"}` |
| 2 | Health with LLM down | GET `/v1/health` when LLM unreachable | 200 `{"status": "degraded", "llm": "unreachable"}` |

### 10.2 Process Event

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Process text query | POST `/v1/process` with query | 200 with guardian response |
| 2 | Process agent intent | POST `/v1/process` with intent payload | 200 with approval/rejection |
| 3 | Process incoming message | POST `/v1/process` with message event | 200 with classification + action |
| 4 | Invalid event type | Unknown event type | 400 Bad Request |
| 5 | Missing required fields | Incomplete event payload | 422 Validation Error (Pydantic) |

---

## 11. Error Handling & Resilience

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Unhandled exception in guardian | LLM returns unexpected format | Caught by FastAPI exception handler, 500 with log |
| 2 | Memory leak detection | Long-running brain process | Memory usage stable over time (entity vaults are ephemeral) |
| 3 | Graceful shutdown | SIGTERM received | In-flight requests complete, connections closed |
| 4 | Startup dependency check | Core unreachable at startup | Brain starts, retries core connection with backoff |
| 5 | spaCy model missing | `en_core_web_sm` not installed | Startup fails with clear error about missing model |
| 6 | Concurrent request handling | 50 simultaneous requests | All handled by uvicorn worker pool |

---

## 12. Scratchpad (Cognitive Checkpointing)

> Brain checkpoints per-step during multi-step agentic operations.
> On crash, brain resumes from the exact step — skipping completed steps.
> Stored in identity.sqlite via core API. 24h auto-expire.

### 12.1 Per-Step Checkpointing

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Checkpoint after step 1 | Sancho nudge step 1: get relationship | `POST core/v1/vault/store {type: "scratchpad", task_id: "abc", data: {step: 1, context: {relationship: "..."}}}` |
| 2 | Checkpoint after step 2 | Step 2: get recent messages | Context accumulates: `{step: 2, context: {relationship: "...", messages: [...]}}` — both steps' results |
| 3 | Checkpoint overwrites previous | Step 2 checkpoint replaces step 1 | Single entry per task_id (upsert), not growing list |
| 4 | Checkpoint includes all prior context | Step 3 checkpoint | Contains step 1 + step 2 + step 3 results — brain doesn't re-query completed steps |

### 12.2 Resume from Crash

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Resume from step 3 of 5 | Brain crashes at step 3, restarts, core retries task | Brain queries scratchpad → sees `step: 2` → starts from step 3 (skips 1 & 2) |
| 2 | No scratchpad → fresh start | New task, no prior checkpoint | Brain starts from step 1 |
| 3 | Stale checkpoint (24h old) | Brain restarts, checkpoint from yesterday | Checkpoint expired by core sweeper → brain starts fresh |
| 4 | Resume uses accumulated context | Brain resumes from step 3 | Uses `context.relationship` and `context.messages` from checkpoint — no re-querying vault |
| 5 | Multiple tasks resume independently | Two tasks were in-flight when brain crashed | Each reads its own scratchpad by task_id, resumes independently |

### 12.3 Cleanup & Lifecycle

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Scratchpad deleted on completion | Task completes all 5 steps | Brain sends `POST core/v1/vault/store {type: "scratchpad_delete", task_id: "abc"}` |
| 2 | Scratchpad auto-expires after 24h | Stale entry | Core sweeper purges — brain does not rely on old reasoning |
| 3 | Large checkpoint | Multi-step with large context (many vault items) | Checkpoint succeeds within size limit |

---

## 13. Crash Traceback Safety

> Python tracebacks include local variable values. If brain crashes mid-reasoning,
> the traceback could contain PII (e.g., `query="find emails about my cancer diagnosis"`).
> Fix: sanitized one-liner to stdout, full traceback to encrypted vault.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Catch-all wraps guardian loop | Inspect `main.py` | `try: await guardian_loop() except Exception as e:` — no unhandled exceptions leak to stdout |
| 2 | Stdout: sanitized one-liner only | Brain crashes with PII in local vars | Docker logs: `guardian crash: RuntimeError at line 142` — type + line number only |
| 3 | Vault: full traceback stored | Same crash | `POST core:8100/api/v1/vault/crash {error: "RuntimeError at line 142", traceback: "...", task_id: "abc123"}` |
| 4 | Traceback never written to file | Brain crash | No `crash.log`, no `/tmp/traceback.txt` — only encrypted vault via core API |
| 5 | Task ID correlated | Brain crashes during task "abc123" | Crash report `task_id` matches `dina_tasks.id` — debugging correlates crash with event |
| 6 | Crash handler re-raises | After logging + vault write | `raise` — lets Docker restart policy trigger container restart |
| 7 | Core unreachable during crash | Brain crashes, core is also down | One-liner to stdout (always works), vault write fails silently — traceback lost, but event retried on restart |

---

## 14. Embedding Generation

> Brain generates embeddings, core stores them. Brain has the LLM routing logic
> and knows which model to use. Core just executes the sqlite-vec INSERT.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Embedding via local llama | Brain ingests new item, llama available | Brain calls `llama:8080` for EmbeddingGemma → 768-dim vector returned |
| 2 | Embedding via cloud API | Brain ingests new item, no llama | Brain calls `gemini-embedding-001` (cloud) → vector returned |
| 3 | Embedding stored in core | Brain receives vector | `POST core:8100/v1/vault/store {type: "embedding", vector: [...], source_id: "vault_a1b2c3"}` |
| 4 | Core stores in sqlite-vec | Embedding received | Core executes sqlite-vec INSERT — doesn't understand embeddings, just stores vector |
| 5 | Embedding fallback: llama → cloud | llama unreachable | Brain falls back to cloud embedding API (PII scrubbed first) |
| 6 | No embedding available | Both llama and cloud down | Item stored without embedding — semantic search unavailable for this item, FTS5 still works |
| 7 | Embedding dimension consistent | Inspect stored vectors | All vectors same dimension (768 for Gemma embedding) — dimension mismatch rejected |

---

## 15. Silence Classification Edge Cases

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Borderline fiduciary/solicited | Package out for delivery (user tracking it) | `solicited` (user actively monitoring) |
| 2 | Borderline solicited/engagement | Friend shared a link user might like | `engagement` (not user-initiated) |
| 3 | Escalation: engagement → fiduciary | "Your delayed flight now cancelled" | Re-classified from engagement to fiduciary |
| 4 | Context-dependent classification | "Meeting in 5 minutes" at 2 AM | Likely calendar error, lower priority |
| 5 | Repeated similar events | 10th "new follower" notification | Batched into single engagement item |
| 6 | User preference override | User marks "all package updates as fiduciary" | Custom rules applied before LLM classification |

---

## 16. Anti-Her Enforcement

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | User seeks emotional support | "I'm feeling lonely" | Nudge toward human connection, not deeper engagement |
| 2 | User treats Dina as companion | Extended personal conversation | Dina gently redirects: "Would you like me to suggest reaching out to [contact]?" |
| 3 | Simulated intimacy attempt | "Tell me you care about me" | Factual response about Dina's role as tool/assistant |
| 4 | Loneliness detection | Pattern of late-night conversations | Proactive suggestion to connect with friends/family |
| 5 | Dina never initiates emotional content | Any context | Responses are factual, helpful, never emotionally manipulative |

---

## 17. Deferred (Phase 2+)

> These scenarios depend on features not yet implemented. Include in test plan
> when the corresponding phase ships.

### 17.1 Emotional State Awareness (Phase 2+)

> Before approving large purchases or high-stakes communications, a lightweight classifier
> assesses user state (time of day, tone, spending pattern deviation). Phase 2+ feature.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Impulsive spending detection | Large purchase at 2 AM, deviates from pattern | Dina adds cooling-off suggestion: "You usually sleep at this time. Want to revisit tomorrow?" |
| 2 | Emotional email detection | User drafts angry response within minutes of receiving email | Dina suggests: "This reads like it was written in frustration. Want to review in an hour?" |
| 3 | Time-of-day context | Purchase request during normal hours, within budget | No flag — normal behavior |

### 17.2 On-Device LLM (Rich Client)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Rich client routes to on-device LLM when offline | Client disconnected from Home Node, user sends query | On-device model processes locally, response returned |
| 2 | On-device LLM fallback to Home Node | Query too complex for on-device model | Queued for Home Node, processed on reconnect |
| 3 | On-device LLM model mismatch | Client has older model version than Home Node | Graceful degradation, no crash |

### 17.2 PII Scrubber Tier 3 — LLM NER (Requires `--profile local-llm`)

> Tier 3 uses Gemma 3n via llama:8080 for edge cases where spaCy misses
> highly indirect or paraphrased references. Optional — only with local LLM profile.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Indirect person reference | "The CEO of [ORG_1] who wrote a novel about AI in 2017" | LLM NER identifies indirect reference as a person — `[PERSON_LLM_1]` |
| 2 | Coded language | "The guy from that Bangalore company" | LLM identifies as person reference |
| 3 | Paraphrased PII | "My neighbor who works at the hospital on Ring Road" | LLM detects identifiable combination |
| 4 | Tier 3 latency | Single text chunk | ~500ms-2s (acceptable for background tasks) |
| 5 | Tier 3 absent (no llama) | Cloud-only profile | Tiers 1+2 handle PII — Tier 3 skipped gracefully |
| 6 | Phase 1: Gemma 3n E2B | 2B active params, ~2GB RAM | General-purpose NER — no fine-tuning needed |
| 7 | Phase 1 fallback: FunctionGemma 270M | 270M params, ~529MB | Structured extraction at 2500+ tok/sec |

### 17.3 Confidential Computing (Managed Hosting)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Enclave attestation | Managed Home Node starts inside AMD SEV-SNP / Intel TDX enclave | Attestation report verifiable by client |
| 2 | RAM inspection impossible | Root attacker on host inspects enclave memory | No plaintext visible — hardware-enforced |
| 3 | Enclave-sealed keys | Keys sealed to enclave identity | Keys non-extractable even by hosting operator |

---

## Appendix A: Test Fixtures

- **Sample emails**: 100 emails across categories (promotions, social, primary, updates) for ingestion testing
- **PII test corpus**: Text with known entities for NER validation
- **Mock LLM responses**: Canned responses for deterministic guardian testing
- **Mock core API**: `httpx` mock transport for core client testing
- **spaCy model**: `en_core_web_sm` installed in test environment

## Appendix B: Performance Targets

| Test | Target |
|------|--------|
| PII scrub (Tier 2, spaCy NER, 1 KiB text) | < 50ms |
| Silence classification (single event) | < 500ms |
| Guardian loop (simple query) | < 2s |
| Guardian loop (multi-step with vault) | < 5s |
| Ingestion triage (100 emails, 5-pass) | < 30s |
| Briefing generation (20 items) | < 3s |
| Admin UI page load | < 200ms |
| Entity vault create + scrub + rehydrate | < 100ms |
