# The Dina Brain: A Walk Through the Guardian Angel

## Act I: Waking Up — The Composition Root

The brain is a Python FastAPI sidecar that provides Dina with the ability to *think*. It cannot act — it cannot sign data, open vaults, or send encrypted messages. It can only reason, classify, scrub, and advise. All authority remains with the Go core.

<details>
<summary><strong>Design Decision — Why a separate Python sidecar instead of embedding LLM logic in Go?</strong></summary>
<br>

Go excels at I/O-bound, low-latency work: HTTP routing, crypto operations, database queries. But the LLM ecosystem — Presidio NER, spaCy models, OpenAI/Gemini/Claude SDKs, Faker for synthetic data — is overwhelmingly Python. Embedding all of this in Go would mean maintaining FFI bridges or re-implementing complex NLP pipelines in a language with no ML ecosystem. The sidecar pattern gives us the best of both worlds: Go handles crypto and storage at native speed, Python handles reasoning and NLP with the full ML toolkit. The two processes communicate over a single authenticated HTTP channel (`BRAIN_TOKEN`). If the brain crashes, core continues to serve — your vault stays open, your identity stays valid. The brain is disposable; your data is not.

</details>

When the brain starts, `create_app()` in `brain/src/main.py:118` runs the same pattern as Go's `main.go`: explicit, top-to-bottom dependency construction. No dependency injection framework, no service locator, no magic. The docstring at lines 1-18 makes this law visible:

> *"This is the ONLY file that imports from `adapter/`. Services and routes depend only on port protocols and domain types."*

<details>
<summary><strong>Design Decision — Why explicit construction instead of a DI framework like FastAPI's Depends everywhere?</strong></summary>
<br>

FastAPI's `Depends()` is used for per-request concerns like authentication (`app.py:65-81`). But for application-level singletons — the LLM router, the guardian loop, the entity vault — explicit construction in `main.py` is clearer. You can read lines 150-332 top-to-bottom and see every dependency relationship. A DI framework would scatter this across decorators and class annotations, making the wiring invisible until runtime. When debugging a production issue at 3am, you want to grep one file, not chase a decorator chain across twenty modules.

</details>

### Step 1: Configuration (line 138)

`load_brain_config()` reads environment variables and returns a frozen dataclass (`infra/config.py:37`). The `frozen=True` flag means the config is immutable after construction — no one can accidentally mutate it mid-request. The token can come from `DINA_BRAIN_TOKEN` (env var) or `DINA_BRAIN_TOKEN_FILE` (Docker Secrets path at line 66-78). If neither is set, the process refuses to start (`config.py:104-108`).

<details>
<summary><strong>Design Decision — Why Docker Secrets support for the brain token?</strong></summary>
<br>

In Docker Compose and Swarm, secrets are mounted as files at `/run/secrets/`. Passing tokens as environment variables is convenient but insecure — `docker inspect` exposes env vars to anyone with container access. The `DINA_BRAIN_TOKEN_FILE` pattern (`config.py:66-78`) reads the token from the mounted file, strips whitespace (a trailing newline would break constant-time comparison), and fails loudly if the file doesn't exist. This is the same pattern used by PostgreSQL, MySQL, and Redis Docker images. The env var fallback exists for local development where Docker Secrets aren't available.

</details>

### Step 2: Adapter Construction (lines 150-251)

The composition root builds two `CoreHTTPClient` instances — one authenticated with `BRAIN_TOKEN` (for brain API calls to core), and one with `CLIENT_TOKEN` (for admin UI calls). Then it walks through every possible LLM provider:

- **Llama** (line 161-169) — Local, on-device. `is_local = True`. PII never leaves the Home Node.
- **Gemini** (line 171-180) — Google cloud. Requires `GEMINI_API_KEY` or `GOOGLE_API_KEY`.
- **Claude** (line 182-191) — Anthropic cloud. Requires `ANTHROPIC_API_KEY`.
- **OpenAI** (line 193-203) — OpenAI cloud. Requires `OPENAI_API_KEY`.
- **OpenRouter** (line 205-222) — Unified gateway to any model. Requires `OPENROUTER_API_KEY`.

Each provider is wrapped in a try/except. If the API key is set but the provider fails to initialize (bad key, missing SDK), the brain logs a warning and continues. This is **graceful degradation** — the brain works with zero, one, or five providers.

<details>
<summary><strong>Design Decision — Why support five LLM providers instead of picking one?</strong></summary>
<br>

Dina's design philosophy is sovereignty — the user chooses their tools, not us. Some users want everything local (Llama only). Some want Gemini for video analysis but Claude for reasoning. Some are behind corporate firewalls that only allow OpenAI. OpenRouter provides a single API key to access hundreds of models. By supporting all five, we let the user configure what works for their threat model, budget, and capabilities. The LLM Router (`service/llm_router.py`) handles the selection logic so the rest of the system never needs to know which provider is active.

</details>

### Step 3: PII Scrubber (lines 236-251)

The scrubber follows a three-tier fallback chain: **Presidio** (best, full NER with synthetic data replacement) → **spaCy** (good, basic NER) → **None** (degraded, Tier 1 regex only via core). The brain never fails to start because a scrubber is missing — it just logs a warning and proceeds with reduced capability. But here is the critical invariant: **if the scrubber is `None` and a cloud LLM call needs PII scrubbing, the call is refused** (`entity_vault.py:131-139`). The system degrades gracefully but never degrades *unsafely*.

<details>
<summary><strong>Design Decision — Why two tiers of PII scrubbing (Go regex + Python NER) instead of one?</strong></summary>
<br>

Tier 1 (Go regex in core, `POST /v1/pii/scrub`) catches structured PII with deterministic patterns: email addresses, phone numbers, credit card numbers, Aadhaar/PAN numbers, IP addresses. These are fast, accurate, and have near-zero false positives. But regex cannot catch *names*. "Dr. Sharma prescribed insulin" — regex sees nothing suspicious. Tier 2 (Presidio wrapping spaCy NER) catches named entities: PERSON, ORG, LOC. It's slower and has false positives (it might tag "Apple" the fruit as ORG), but it catches what regex cannot. Running Tier 1 first means Tier 2 sees `[EMAIL_1]` instead of `rajmohan@example.com`, avoiding duplicate detection and keeping entity numbering consistent (`entity_vault.py:245-286`). The two tiers are complementary, not redundant.

</details>

### Step 4: Service Construction (lines 253-332)

Services are built in dependency order, each receiving only the ports it needs:

1. **LLMRouter** (line 254) — Routes tasks to the optimal LLM provider.
2. **EntityVaultService** (line 321) — Orchestrates PII scrub-call-rehydrate for cloud LLM calls.
3. **NudgeAssembler** (line 322) — Context-injection for conversations.
4. **ScratchpadService** (line 323) — Crash-recovery checkpointing.
5. **SyncEngine** (line 324) — Periodic data ingestion from external sources.
6. **GuardianLoop** (line 325) — The central event processor. Gets all of the above injected.

The **LLM hot-reload callback** (lines 261-320) deserves special attention. When the admin UI changes API keys, this closure rebuilds all LLM providers from KV-stored keys without restarting the brain process. It's wired into the admin settings route so the user can add a Gemini key and immediately start using it.

### Step 5: Sub-Apps and Mounting (lines 334-389)

The brain creates two FastAPI sub-apps:

- **Brain API** (`/api/*`) — Authenticated with `BRAIN_TOKEN`. Only core talks to this.
- **Admin UI** (`/admin/*`) — Authenticated with `CLIENT_TOKEN`. Only the user's browser talks to this.

<details>
<summary><strong>Design Decision — Why two separate sub-apps with different tokens?</strong></summary>
<br>

The brain API and admin UI serve fundamentally different callers with different trust levels. Core calls `/api/v1/process` with the `BRAIN_TOKEN` — a machine-to-machine secret shared between two processes on the same host. The admin UI is accessed by the user's browser with a `CLIENT_TOKEN` that may cross the network. Separating them means: (1) a compromised admin token cannot call brain API endpoints (and vice versa), (2) module isolation is enforced at the import level (`dina_brain` never imports from `dina_admin`, line 12-13 of `main.py`), and (3) the admin UI can be disabled entirely by not setting `CLIENT_TOKEN` (line 381-388). The admin UI is convenience; the brain API is infrastructure.

</details>

A background task runs the **sync engine** every 5 minutes (lines 335-353), periodically ingesting data from MCP-connected sources. The lifespan context manager ensures the sync task is cleanly cancelled on shutdown.

### Step 6: Health Check (lines 392-421)

The `/healthz` endpoint is unauthenticated (anyone can hit it — load balancers need this). It checks three components: core connectivity, LLM availability, and scrubber status. If any is down, the response is `"degraded"` but the endpoint still returns 200 — the brain is running, just not at full capacity.

---

## Act II: The Guardian Angel Loop — Where Events Are Judged

The `GuardianLoop` in `service/guardian.py` is the brain's central nervous system. Every event from core flows through it. The class is 719 lines, but the mental model is simple: **classify, process, checkpoint, ACK**.

<details>
<summary><strong>Design Decision — Why a single event loop instead of separate handlers per event type?</strong></summary>
<br>

A microservices approach would create separate endpoints for each event type: `/process/message`, `/process/intent`, `/process/alert`. The guardian loop consolidates them for two reasons. First, **cross-cutting concerns** — silence classification, crash recovery, task ACK — apply to every event type. A single entry point (`process_event`, line 240) ensures these are never forgotten. Second, **state coherence** — the guardian tracks which personas are unlocked (line 159), maintains the engagement briefing buffer (line 162), and manages scratchpad checkpoints. Distributing this state across separate handlers would require a shared store and synchronization. A single loop with in-memory state is simpler and faster.

</details>

### The Four Laws in Code

The guardian loop's docstring (lines 1-26) codifies the Four Laws as code constraints:

- **Silence First** (line 15): Default to `"engagement"` when classification is ambiguous. Never push content unless it's fiduciary.
- **Anti-Her** (line 18): Never simulate emotional intimacy. Never call `messages.send` — only draft.
- **Cart Handover** (line 20): Never touch money. Hand control back to the user.

### Silence Classification (lines 168-234)

When an event arrives, the first question is: *should Dina even speak?* The `classify_silence` method implements a priority waterfall:

1. **Background sync** → `"silent"` (log only, no notification).
2. **Explicit `priority: fiduciary`** hint → `"fiduciary"` (interrupt immediately).
3. **Source-based** (line 201) → security, health_system, bank, emergency → `"fiduciary"`.
4. **Keyword-based** (line 205) → regex match on "cancel", "security alert", "overdraft", etc. But with a composite heuristic: if the keyword matches but the sender is unknown, it's downgraded to `"solicited"` (line 209). This prevents spam-as-fiduciary attacks — a phishing email saying "your account is suspended" shouldn't trigger an interrupt.
5. **Solicited** → reminders, search results the user asked for.
6. **Engagement** → social media, podcasts, promos → saved for the morning briefing.
7. **Default** → `"engagement"` (line 233). When in doubt, stay quiet.

<details>
<summary><strong>Design Decision — Why heuristic silence classification instead of LLM-based?</strong></summary>
<br>

An LLM could classify priority more accurately — it understands context, tone, and urgency. But silence classification runs on *every single event*, including background sync items that arrive in bursts of hundreds. An LLM call per event would add 500ms-2s latency and cloud API costs that scale linearly with event volume. The heuristic approach (regex + frozensets) runs in microseconds and handles 99% of cases correctly. The remaining 1% — ambiguous events — default to `"engagement"` (Silence First). False negatives (missing a fiduciary event) are mitigated by the fiduciary keyword and source lists being continuously expanded. False positives (upgrading a non-urgent event to fiduciary) are mitigated by the composite heuristic that requires both keyword match *and* trusted source.

</details>

### Event Processing Pipeline (lines 240-361)

After classification, `process_event` branches:

**Vault lifecycle events** (lines 263-268) — `vault_unlocked`, `vault_locked`, `persona_unlocked`. These update the guardian's in-memory persona tracking. When a vault locks, all engagement items for that persona are flushed (lines 591-595) to prevent stale context from leaking after re-lock.

**Agent intent review** (line 274) — Autonomous agents submit their intent *before acting*. The guardian classifies the risk.

**Reason events** (line 278) — Complex LLM queries routed through the LLM router with PII scrubbing.

**DIDComm messages** (line 281) — Dina-to-Dina protocol messages routed by type prefix.

**Standard events** (lines 284-343) — The common path. After classification:
- **Silent** → log and ACK.
- **Engagement** → save to briefing buffer and ACK.
- **Fiduciary/Solicited** → checkpoint step 1, assemble nudge, checkpoint step 2, deliver via core, ACK, clear scratchpad.

The checkpoint pattern (lines 302-317) is critical. Each step is written to core's scratchpad before proceeding to the next. If the brain crashes between steps, the next restart can `resume()` from the last checkpoint instead of re-running completed work.

<details>
<summary><strong>Design Decision — Why checkpoint to core's KV store instead of local disk?</strong></summary>
<br>

The brain runs in a Docker container. Containers are ephemeral — they can be killed, restarted, or rescheduled to a different host at any time. Local disk writes would be lost on container restart (unless volumes are mounted, but that adds operational complexity). By checkpointing to core's encrypted KV store (`write_scratchpad` → `PUT /v1/vault/kv/scratchpad:{task_id}`), the data survives container restarts and is automatically encrypted at rest (SQLCipher). Core's sweeper auto-expires scratchpad entries after 24 hours, so stale checkpoints don't accumulate.

</details>

### Agent Intent Review — The Safety Layer (lines 367-441)

This is the Agent Safety Layer in action. When an autonomous agent (a calendar bot, a shopping bot, an email agent) wants to *do something*, it submits an intent to Dina first. The guardian classifies the risk into four tiers:

- **BLOCKED** (lines 391-402) — Untrusted agents or actions that read vault data. Denied immediately. No user prompt needed.
- **HIGH** (lines 404-416) — `transfer_money`, `share_data`, `delete_data`, `sign_contract`. Flagged for user review.
- **MODERATE** (lines 418-430) — `send_email`, `pay_upi`, `share_location`, `calendar_create`. Flagged for user review.
- **SAFE** (lines 432-441) — `fetch_weather`, `search`. Auto-approved.

Every BLOCKED and HIGH intent writes an audit trail to core's KV store (lines 660-679), recording the agent DID, action, decision, and reason. This is the paper trail that proves Dina did her job.

<details>
<summary><strong>Design Decision — Why categorical action lists instead of LLM-based risk assessment?</strong></summary>
<br>

An LLM could theoretically assess intent risk with more nuance — "send_email to your doctor about test results" is different from "send_email to a marketing list." But for safety-critical decisions, determinism trumps nuance. A static frozenset of `_BLOCKED_ACTIONS` (line 83) *always* blocks vault reads by untrusted agents. An LLM might be prompt-injected into approving one. The frozenset is auditable, testable, and cannot be fooled. The tradeoff is rigidity — but rigidity in a safety layer is a feature, not a bug. Future versions may add LLM-assisted risk refinement *within* the flagged-for-review tier (suggesting a risk reason to the user), but the categorical deny/approve gates will remain static.

</details>

### Daily Briefing (lines 447-517)

Engagement-tier events are accumulated in `_briefing_items` throughout the day. When `generate_briefing()` is called (typically by a scheduled task or user request), it:

1. Deduplicates by body text (lines 464-470).
2. Sorts by source priority — finance first, podcasts last (lines 474-486).
3. Fetches a fiduciary recap from core's vault (lines 490-501) — even though fiduciary events were already delivered in real-time, the briefing includes a summary for the user's awareness.
4. Clears the buffer (line 510).

This is Silence First in action: engagement items are never pushed. They wait until the user asks for them (or the morning briefing runs).

### Crash Handling (lines 685-719)

When the guardian loop catches an unrecoverable exception, it follows the crash protocol:

1. **Sanitised one-liner to stdout** (lines 698-701) — `"guardian crash: ValueError at line 542"`. No PII, no variable values, no traceback frames. This is safe for Docker logs, CloudWatch, Datadog.
2. **Full traceback to encrypted vault** (lines 703-714) — The unsanitized traceback (which may contain PII like `query="find emails about my cancer diagnosis"`) is written to core's scratchpad via the encrypted KV store. Only someone who can unlock the vault can read it.
3. **No ACK** — The task is not acknowledged. Core will requeue it after the 5-minute timeout, giving the brain another chance after restart.

<details>
<summary><strong>Design Decision — Why not write crash tracebacks to a log file?</strong></summary>
<br>

Python tracebacks include local variable values. If the brain crashes mid-reasoning, the traceback could contain: `query="find emails about Dr. Sharma's cancer diagnosis"`, `prompt="My Aadhaar number is 1234-5678-9012"`, or `vault_item={"body_text": "Lab results: HIV positive"}`. Writing this to a log file, stdout, or a centralized logging service violates the fundamental privacy guarantee. The crash handler (`infra/crash_handler.py`) solves this by splitting the output: the one-liner to stderr contains only the error type and line number (safe for any logging pipeline), while the full traceback goes to the encrypted vault where it's protected by the same SQLCipher encryption as all other personal data. If core is also down, the traceback is lost — but that's preferable to leaking PII.

</details>

---

## Act III: The LLM Router — Choosing Who Thinks

The `LLMRouter` in `service/llm_router.py` decides *which* LLM handles each task. It's a decision tree, not a load balancer.

### The Decision Tree (lines 85-215)

The `route()` method follows this priority order:

1. **FTS-only tasks** (line 141) — `fts_lookup`, `keyword_search`. These bypass the LLM entirely and return an empty response with `route: "fts5"`. The caller uses core's FTS5 full-text search directly. No API cost, no latency.

2. **Explicit provider** (line 153) — If the caller specified a provider (e.g., `provider="gemini"`), use it.

3. **Provider selection** (line 156) — The `_select_provider` method (lines 248-292) implements the privacy-first decision tree:
   - **Sensitive persona** (restricted/locked) → prefer local. If no local is available, fall back to cloud (with mandatory PII scrubbing).
   - **Complex reasoning** → prefer cloud (more capable). If no cloud is available, fall back to local.
   - **Everything else** → prefer local for privacy.

4. **Cloud consent gate** (lines 160-170) — For sensitive personas routed to cloud, the user must have explicitly acknowledged cloud consent. Without the `cloud_llm_consent` flag, the request raises `CloudConsentError`. This is not a technical gate — PII scrubbing would work fine — it's a *consent* gate. The user must know and agree that their data (even scrubbed) is leaving the Home Node.

<details>
<summary><strong>Design Decision — Why require explicit cloud consent instead of just scrubbing automatically?</strong></summary>
<br>

PII scrubbing is good but not perfect. Presidio might miss a name in an unusual format. A medical term might be specific enough to identify a patient ("the only insulin-dependent Type 1 diabetic in Kodagu district"). Entity Vault scrubbing replaces `Dr. Sharma` with `[PERSON_1]`, but the *context* around the token may still be identifying. The consent gate ensures the user makes a conscious decision: "I understand my scrubbed data will be processed by Google/Anthropic/OpenAI." This is the same principle as GDPR consent — explicit, informed, and revocable. Without consent, only the local LLM is used, and data never leaves the machine.

</details>

5. **Execution with fallback** (lines 182-215) — If the selected provider fails (timeout, rate limit, connection error), the router tries the opposite direction: local failure → try cloud, cloud failure → try local. If both fail, `LLMError` is raised.

### Hot Reload (lines 217-238)

The `reconfigure()` method replaces all providers and re-partitions into local/cloud without restarting the brain process. Called by the admin settings route when the user changes API keys. The LLM router is the only service that supports hot reload — all others are stateless or read from core's KV on each request.

---

## Act IV: The Entity Vault — PII's Disappearing Act

The `EntityVaultService` in `service/entity_vault.py` is the most security-critical service in the brain. Its job: make PII invisible to cloud LLMs, then make it visible again in the response.

### The Full Cycle (lines 71-169)

`scrub_and_call()` orchestrates the complete Entity Vault flow:

1. **Classify** (lines 96-115) — The domain classifier determines sensitivity. If the content is `LOCAL_ONLY`, the cloud send is refused outright with `PIIScrubError`.

2. **Two-tier scrub** (lines 121-142) — For each message in the conversation:
   - **Tier 1**: `POST /v1/pii/scrub` to core (Go regex) catches emails, phones, IDs.
   - **Tier 2**: Presidio NER (Python, in-process) catches names, orgs, locations.
   - If *either tier fails*, `PIIScrubError` is raised and the cloud call is blocked. This is the hard security gate.

3. **Build vault** (line 145) — An in-memory dict mapping tokens to originals: `{"[PERSON_1]": "Dr. Sharma", "[ORG_1]": "Apollo Hospital"}`.

4. **Call cloud LLM** (lines 155-161) — Send scrubbed messages. If the LLM fails, the vault is cleared immediately (line 160).

5. **Rehydrate** (line 164) — Replace tokens in the LLM response with original values.

6. **Destroy vault** (line 167) — `vault.clear()`. Belt and suspenders — the dict is emptied explicitly, not left for garbage collection.

<details>
<summary><strong>Design Decision — Why an ephemeral in-memory vault instead of a persistent entity map?</strong></summary>
<br>

A persistent map would let the brain remember past scrubbing results: "We already know `[PERSON_1]` is Dr. Sharma from the last call." But persistence creates risk: the map is a PII-to-token lookup table. If it's stored in a database, it's a target. If it's cached in Redis, it might be exposed via `MONITOR`. If it's written to disk, it might survive a container restart. The ephemeral approach eliminates all of these risks. Each cloud LLM call creates a fresh vault, uses it for exactly one request-response cycle, and destroys it. The tradeoff is that the brain re-scrubs text it's seen before — but scrubbing is fast (regex + NER over a few KB of text), and the security guarantee is worth the microseconds.

</details>

### Sensitivity-Aware Scrubbing (lines 245-286)

The `_two_tier_scrub` method adjusts intensity based on sensitivity level:

- **GENERAL** → Tier 1 + Tier 2 `scrub_patterns_only` (emails, phones, IDs — but not names). A casual question like "what's the weather?" doesn't need NER.
- **ELEVATED / SENSITIVE** → Full pipeline. Tier 1 + Tier 2 full NER. Every name, organization, and location is scrubbed.

The ordering matters: Tier 1 runs first (line 268), so Tier 2 sees `[EMAIL_1]` instead of `rajmohan@example.com`. This prevents Presidio from double-detecting the email as both an EMAIL_ADDRESS and a PERSON (some email addresses contain names).

---

## Act V: The Domain Layer — Truth in Frozen Dataclasses

The `domain/` package contains the brain's vocabulary: the types, enums, and errors that every other layer speaks in.

### Types (domain/types.py)

Every domain type is a `frozen=True, slots=True` dataclass. Frozen means immutable — no accidental mutation. Slots means memory-efficient — no `__dict__` overhead.

The key types:
- **VaultItem** (line 24) — A single item in the encrypted vault. Matches core's schema.
- **SearchResult** (line 43) — A hybrid search hit with both FTS5 rank and cosine similarity, merged into a single `relevance` score: `0.4 * fts5_rank + 0.6 * cosine_similarity`.
- **NudgePayload** (line 63) — The context-injection package delivered to the user. Includes `tier` for Silence-First priority and `sources` for deep-link attribution.
- **TaskEvent** (line 88) — An event from core's task queue with retry tracking (`attempt` field) and timeout info.
- **ScrubResult** (line 113) — The output of the PII pipeline: scrubbed text, detected entities, and the replacement map.
- **Classification** (line 136) — Domain sensitivity classification with confidence score.

<details>
<summary><strong>Design Decision — Why frozen dataclasses instead of Pydantic models or TypedDicts?</strong></summary>
<br>

Pydantic models are used at the API boundary (route request/response schemas in `routes/process.py:29-72`) where validation and serialization matter. But domain types are internal — they're created by services, passed between services, and never serialized to JSON. Frozen dataclasses are faster (no validation overhead), lighter (slots eliminate per-instance dicts), and enforce immutability at the Python level. TypedDicts were rejected because they're just type hints on plain dicts — they don't prevent mutation, don't enforce field presence at runtime, and don't support `__eq__` or `__hash__` out of the box. The domain layer is the one place where we want strong guarantees, not just hints.

</details>

### Enums (domain/enums.py)

Six enumerations define closed sets:

- **Priority** (line 12) — `FIDUCIARY=1`, `SOLICITED=2`, `ENGAGEMENT=3`. The numeric values encode urgency order.
- **SilenceDecision** (line 25) — `INTERRUPT`, `NOTIFY`, `SILENT`. Maps priority to delivery action.
- **LLMProvider** (line 36) — `LLAMA`, `GEMINI`, `CLAUDE`. The known provider backends.
- **IntentRisk** (line 49) — `SAFE`, `MODERATE`, `HIGH`, `BLOCKED`. The four-tier agent safety classification.
- **TaskType** (line 64) — `PROCESS`, `REASON`. The two task types in the guardian loop.
- **Sensitivity** (line 75) — `GENERAL`, `ELEVATED`, `SENSITIVE`, `LOCAL_ONLY`. Controls PII scrub intensity. Note that `Sensitivity` extends `str, Enum` (line 75) — this means it can be used directly as a string in JSON serialization without `.value`.

### Errors (domain/errors.py)

Seven typed exceptions, all inheriting from `DinaError` (line 13):

- **PersonaLockedError** (line 20) — Core returned 403. The guardian whispers an unlock request.
- **CoreUnreachableError** (line 28) — Core is down. After retries, brain enters degraded mode.
- **LLMError** (line 37) — Provider failure. Triggers fallback logic in the router.
- **MCPError** (line 46) — MCP agent delegation failed. Falls back to local processing.
- **PIIScrubError** (line 55) — **Hard security gate.** Cloud send is refused.
- **ConfigError** (line 64) — Missing or invalid config. Process dies at startup.
- **CloudConsentError** (line 73) — User hasn't consented to cloud LLM usage.

<details>
<summary><strong>Design Decision — Why typed exceptions instead of error codes or Result types?</strong></summary>
<br>

Go uses error values and `if err != nil` — that's idiomatic Go. Python's exception system is more expressive: typed exceptions carry semantic meaning, can be caught at any level of the call stack, and automatically include traceback context for debugging. Each Dina exception maps to a specific architectural failure mode. The guardian's `process_event` method (lines 345-361) catches `PersonaLockedError` and returns `whisper_unlock_request`, catches `CoreUnreachableError` and returns `degraded_mode`. This is cleaner than checking error codes because the handler is co-located with the failure type, not scattered across the call chain. Result types (like Rust's `Result<T, E>`) were considered but rejected — they're not idiomatic Python and would require every caller to unwrap, which conflicts with Python's "ask forgiveness, not permission" philosophy.

</details>

---

## Act VI: The Port Layer — Contracts Between Worlds

The `port/` package defines four protocol interfaces that form the dependency inversion boundary.

### CoreClient (port/core_client.py)

A `@runtime_checkable` protocol with 13 async methods (lines 16-104). Every method maps to exactly one core REST endpoint. The docstring at lines 20-26 specifies the error classification contract:

- HTTP 401 → fatal `ConfigError` (bad `BRAIN_TOKEN`), no retry.
- HTTP 403 → `PersonaLockedError`, no retry.
- HTTP 5xx → retry with exponential backoff (max 3 attempts).
- Timeout → `asyncio.TimeoutError` after 30 seconds.

This contract is implemented by `CoreHTTPClient` in `adapter/core_http.py`.

### LLMProvider (port/llm.py)

Three methods + two properties (lines 16-71):

- `complete(messages)` — Chat completion. Returns a uniform dict regardless of provider.
- `embed(text)` — Embedding vector generation.
- `classify(text, categories)` — Zero-shot classification for triage.
- `model_name` — Human-readable identifier (e.g., `"llama-3.2-3b"`).
- `is_local` — The critical property. `True` means data never leaves the Home Node. The LLM router checks this property to decide whether PII scrubbing is needed.

### PIIScrubber + EntityVault (port/scrubber.py)

Two protocols in one file. `PIIScrubber` (lines 17-59) defines `scrub()`, `detect()`, and `rehydrate()`. `EntityVault` (lines 63-107) defines the ephemeral vault lifecycle: `create()`, `rehydrate()`, `destroy()`. The invariant is stated in the docstring (lines 69-77): the vault is NEVER persisted, NEVER logged, and NEVER stored in the encrypted vault.

### MCPClient (port/mcp.py)

Three methods: `call_tool()`, `list_tools()`, `disconnect()`. MCP (Model Context Protocol) is the standard for delegating work to external agent servers. The brain uses it to talk to data connectors (Gmail, Calendar, etc.) via JSON-RPC over stdio.

<details>
<summary><strong>Design Decision — Why MCP over stdio instead of HTTP for data connectors?</strong></summary>
<br>

MCP servers are child processes managed by the brain — they're not network services. Using stdio (stdin/stdout) instead of HTTP means: (1) no port allocation conflicts, (2) no TLS certificate management, (3) the connection dies when the child process dies (clean lifecycle), and (4) no network exposure — the connector can't be reached from outside the container. HTTP would make sense for remote MCP servers, but for local connectors running as child processes, stdio is simpler and more secure. The `MCPStdioClient` (`adapter/mcp_stdio.py`) manages the child processes and multiplexes JSON-RPC messages over stdin/stdout.

</details>

---

## Act VII: The Adapter Layer — Where Protocols Meet Reality

### CoreHTTPClient (adapter/core_http.py)

The HTTP adapter implements the `CoreClient` protocol in 441 lines. The `_request` helper (lines 108-188) is the workhorse:

- **Lazy client** (line 78-86) — `httpx.AsyncClient` is created on first use and reused. If it's closed (e.g., after a shutdown), a new one is created transparently.
- **Bearer auth** (line 83) — Every request carries `Authorization: Bearer {brain_token}`.
- **Retry with exponential backoff** (lines 121-183) — 3 attempts with 1s, 2s, 4s delays. Connection errors and 5xx responses are retried. 401 and 403 are not.
- **Error classification** (lines 132-140) — 401 → `ConfigError` (fatal, won't retry). 403 → `PersonaLockedError` (the persona vault is locked, the guardian should whisper an unlock request).

<details>
<summary><strong>Design Decision — Why httpx instead of aiohttp or requests?</strong></summary>
<br>

The brain is fully async (FastAPI + uvicorn), so synchronous `requests` is out. Between `aiohttp` and `httpx`, `httpx` was chosen because: (1) it has a familiar `requests`-like API, (2) it supports both sync and async clients from the same library, (3) it handles HTTP/2 transparently, and (4) it's the default HTTP client for FastAPI's test client. The lazy client pattern (create on first use, recreate if closed) avoids the "event loop not running" error that plagues eager async client construction at module import time.

</details>

### LLM Adapters

Five adapters, one per provider, all implementing the same `LLMProvider` protocol:

- **LlamaProvider** (`adapter/llm_llama.py`) — Calls the OpenAI-compatible API exposed by `llama-server`. The only adapter where `is_local = True` (line 72). Data never leaves the machine. Supports completion, embedding, and classification (via structured prompt, lines 204-242).

- **GeminiProvider** (`adapter/llm_gemini.py`) — Wraps `google.genai` SDK. Unique advantage: native `VideoUrl` support for video analysis without transcript extraction. Lazy library import to avoid crashing if the SDK isn't installed.

- **ClaudeProvider** (`adapter/llm_claude.py`) — Wraps `anthropic` library's async Messages API. Embedding and classification are `NotImplementedError` — Claude doesn't support them natively.

- **OpenAIProvider** (`adapter/llm_openai.py`) — Wraps `openai` library. Standard chat completions.

- **OpenRouterProvider** (`adapter/llm_openrouter.py`) — Unified gateway. OpenAI-compatible API that routes to any model on OpenRouter's platform via a single API key.

<details>
<summary><strong>Design Decision — Why OpenAI-compatible API format as the common denominator?</strong></summary>
<br>

Every cloud LLM provider has converged on the OpenAI chat completions format: `{"messages": [{"role": "user", "content": "..."}]}`. Even non-OpenAI providers (Gemini via Vertex, Claude via Amazon Bedrock, local models via llama-server) expose OpenAI-compatible endpoints. By using this format internally, the `LLMProvider` protocol's `complete()` method accepts the same `messages` list regardless of which adapter handles it. The adapters translate to provider-specific formats only when necessary (e.g., Gemini separates system messages from conversation, Claude requires `max_tokens` to be explicit). This means adding a new provider is a single-file change — implement the protocol, register in `main.py`.

</details>

### PresidioScrubber (adapter/scrubber_presidio.py)

At 622 lines, this is the largest adapter. It wraps Microsoft Presidio + spaCy NER with three important additions:

1. **SAFE_ENTITIES whitelist** (lines 46-64) — DATE, TIME, MONEY, PERCENT, CARDINAL, etc. are never scrubbed. These are essential for LLM reasoning ("the payment of $500 is due on March 15") and don't identify anyone.

2. **Country-level GPE filter** (lines 70-83) — "India" is not PII. "Bengaluru" might be. The `COUNTRY_NAMES` frozenset passes country-level GPE through while scrubbing city/state/locality GPE.

3. **Synthetic data replacement** — When Faker is available, PII is replaced with realistic fake values: `Dr. Sharma` → `Dr. Meera Patel`, not `[PERSON_1]`. LLMs reason measurably better with natural language than with token tags. The same real value always maps to the same fake value within a single `scrub()` call (consistent fakes), so the LLM sees coherent references.

4. **India-specific recognizers** — Aadhaar numbers, PAN card numbers, IFSC codes, UPI IDs. Plus EU recognizers for German Steuer-ID, French NIR/NIF, Dutch BSN, SWIFT/BIC.

<details>
<summary><strong>Design Decision — Why Faker-based synthetic data instead of simple token tags?</strong></summary>
<br>

Research shows that LLMs perform significantly worse when PII is replaced with tags like `[PERSON_1]`. The model sees a conversation where "Dr. [PERSON_1] at [ORG_1] prescribed [PERSON_1] medication for..." — the references are confusing, the grammar is broken, and the model's attention mechanism treats `[PERSON_1]` as an unknown token rather than a name. By replacing with synthetic but realistic values ("Dr. Meera Patel at Fortis Hospital prescribed..."), the LLM sees grammatically correct, contextually coherent text and produces better responses. The replacement is consistent within a single scrub call (the same real name always maps to the same fake name), so cross-references work. After the LLM responds, the Entity Vault rehydrates by replacing fake names back to real ones. The tradeoff is a Faker dependency, which is optional — the scrubber falls back to numbered tags if Faker isn't installed.

</details>

---

## Act VIII: The Supporting Cast

### NudgeAssembler (service/nudge.py)

When the user opens a conversation with a contact, the nudge assembler gathers relevant context from the vault (lines 69-185):

1. **Recent messages** with the contact (line 111).
2. **Relationship notes** (line 114).
3. **Pending promises** (line 119) — Scans message text for patterns like "I'll send the PDF tomorrow" using regex (`_PROMISE_PATTERNS`, lines 35-38).
4. **Calendar events** (line 122).

If no relevant context exists, the method returns `None` (line 130). This is Silence First — Dina doesn't nudge you just to show she's paying attention.

The nudge assembler also handles **D2D payload preparation** (lines 187-241). When Dina sends a message to another Dina, the payload is structured in tiers: `summary` (always included) and `full` (stripped by core based on the contact's sharing policy). Brain always includes both tiers — it's core's job to enforce sharing policies before encryption.

<details>
<summary><strong>Design Decision — Why does brain prepare both tiers but let core enforce policy?</strong></summary>
<br>

Brain knows what the user wants to share but doesn't know the contact's sharing policy. Core knows the policy (it's stored in the encrypted vault alongside the contact directory) but doesn't know how to summarize or tier the data. By having brain prepare all tiers and core strip based on policy, each component does what it's good at. If brain tried to check sharing policies, it would need to query core for the policy, then decide what to include — introducing a round-trip and duplicating policy logic. The current design keeps policy enforcement in one place (core) and content preparation in another (brain).

</details>

### ScratchpadService (service/scratchpad.py)

A thin wrapper around core's KV store that provides cognitive checkpointing (105 lines). Three methods:

- **checkpoint** (line 45) — Write accumulated context for a task step. Each call upserts the single entry for that `task_id`.
- **resume** (line 73) — Read the latest checkpoint. Returns `None` for a fresh start (no prior checkpoint, or checkpoint expired by core's 24-hour sweeper).
- **clear** (line 94) — Write a sentinel (`{"__deleted": True}`) to signal deletion. Core interprets step 0 + empty context as a delete.

### SyncEngine (service/sync_engine.py)

The periodic data ingestion pipeline (321 lines). `run_sync_cycle()` (lines 167-257) drives a six-step process:

1. **Read cursor** from core KV (line 187).
2. **Fetch** new items via MCP → OpenClaw connectors (lines 191-206).
3. **Triage** each item (lines 220-233) through a multi-pass filter:
   - **Fiduciary override** (line 275) — Security alerts and financial alerts always INGEST, regardless of sender or category.
   - **Pass 1** (line 279) — Gmail category filter. PROMOTIONS, SOCIAL, UPDATES, FORUMS → SKIP.
   - **Pass 2a** (lines 283-288) — Regex sender filter (`noreply@`, `@notifications.`) and subject filter (`weekly digest`, `OTP`, `verification code`) → SKIP.
4. **Store** in batches of 100 (lines 230-233).
5. **Update cursor** (lines 241-248).
6. **Return stats** (lines 250-257).

<details>
<summary><strong>Design Decision — Why a three-pass triage pipeline instead of a single LLM classifier?</strong></summary>
<br>

The triage pipeline processes potentially thousands of emails per sync cycle. An LLM classifier (even a local one) would add ~100ms per item — 100 seconds for 1000 emails. The three-pass approach uses heuristics that run in microseconds: Pass 1 eliminates ~60% of items by Gmail category (one frozenset lookup). Pass 2a eliminates another ~20% by sender/subject regex. The remaining ~20% — genuine messages from real people — are stored as PRIMARY. A future Pass 2b could use batch LLM classification for edge cases, but the heuristic passes handle the vast majority of items at zero API cost. The fiduciary override ensures that security alerts from `noreply@bank.com` are never skipped — even though the sender matches the no-reply regex, the subject keyword "security alert" triggers the override.

</details>

### DomainClassifier (service/domain_classifier.py)

A four-layer classifier that determines content sensitivity (249 lines):

- **Layer 1: Persona override** (lines 167-186) — The `health` persona automatically maps to SENSITIVE. The `financial` persona maps to ELEVATED. Short-circuits on SENSITIVE/LOCAL_ONLY.
- **Layer 2: Keyword signals** (lines 188-189, function at lines 87-128) — Regex patterns for health (diagnosis, prescription, blood sugar), finance (bank account, credit card, IFSC), and legal (lawsuit, subpoena, deposition). Each domain is scored by strong and weak keyword counts.
- **Layer 3: Vault context** (lines 192-216) — If the source is `health_system` or the item type is `medical_record`, the sensitivity is SENSITIVE regardless of keywords.
- **Layer 4: LLM fallback** (line 241) — Skipped in the current implementation. Defaults to GENERAL with low confidence (0.3).

The selection rule (lines 218-239): highest confidence wins. On ties, higher sensitivity wins. This ensures that a health keyword (confidence 0.6) + a vault source match (confidence 0.9) resolves to the vault source's SENSITIVE classification.

---

## Act IX: The API Surface — Three Endpoints

The brain API exposes exactly three endpoints, all behind `BRAIN_TOKEN` authentication.

### Authentication (dina_brain/app.py:65-81)

Every brain API request must carry `Authorization: Bearer {BRAIN_TOKEN}`. The token comparison uses `hmac.compare_digest()` (line 78) — a constant-time comparison that prevents timing side-channel attacks. An attacker cannot determine how many bytes of the token they've guessed correctly by measuring response time.

<details>
<summary><strong>Design Decision — Why constant-time comparison for a machine-to-machine token?</strong></summary>
<br>

The `BRAIN_TOKEN` is shared between core and brain on the same host, so a remote timing attack is unlikely. But defense-in-depth means assuming the worst. If brain is exposed through a misconfigured reverse proxy, or if an attacker has local access and can measure response times with nanosecond precision (speculative execution attacks), constant-time comparison closes the vulnerability. The cost is negligible — `hmac.compare_digest` is a single function call. The alternative (plain `==`) would save zero measurable time but open a theoretical attack vector. In security code, theoretical risks are treated as real risks.

</details>

### POST /v1/process (routes/process.py:93-149)

The main event ingestion endpoint. Accepts a `ProcessEventRequest` (Pydantic model, lines 29-54) with fields for every event type: `type`, `task_id`, `persona_id`, `source`, `body`, `priority`, agent intent fields (`agent_did`, `action`, `risk_level`), and a freeform `payload` dict.

Delegates to `GuardianLoop.process_event()` and translates the returned dict into a typed `ProcessEventResponse` (lines 140-149). Error handling is careful: `ValueError` → 400, guardian errors → 500, and the special `action: "error"` response from the guardian is translated to a 500 with the error type in the detail.

### POST /v1/reason (routes/reason.py:76-127)

Complex LLM reasoning queries. The request carries a `prompt`, optional `persona_id` and `persona_tier` (for privacy-aware routing), and optional `provider` (to force a specific LLM). The route wraps the request as a `reason` event and delegates to `GuardianLoop.process_event()`, which routes to `_handle_reason()` (guardian.py:523-565).

The reason pipeline uses **agentic vault context assembly** — the LLM autonomously decides which persona vaults to query and what search terms to use, via function calling:

```
User: "I need a new office chair"
  ↓
_handle_reason()
  ↓
1. PII scrub (if sensitive persona) — Entity Vault created
  ↓
2. Agentic reasoning loop (VaultContextAssembler → ReasoningAgent):
   ├─ LLM receives prompt + tool declarations (list_personas, browse_vault, search_vault)
   ├─ LLM calls list_personas → returns persona names + recent summaries + item types
   ├─ LLM calls browse_vault("personal") → sees "Chronic lower back pain from office work"
   ├─ LLM calls search_vault("personal", "chronic lower back pain") → full item details
   ├─ LLM calls search_vault("consumer", "office chair") → product reviews
   └─ LLM generates personalized response using all gathered vault context
  ↓
3. Rehydrate PII tokens → return {content, model, vault_context_used: true}
```

The key insight: **the LLM is the agent.** Python doesn't do keyword matching or intent classification — it declares tools, executes them when the LLM asks, and feeds results back. The system prompt teaches the LLM a discovery-first workflow: list personas (see what's available) → browse (see actual stored text) → search with exact terms from browse results (FTS5 is keyword-based). For semantic search, the `search_vault` tool generates a query embedding and Core searches its in-memory HNSW index, finding items by meaning rather than exact words.

Tool declarations are provider-agnostic dicts (`vault_context.VAULT_TOOLS`). The LLM router translates them into provider-specific formats (e.g., `google.genai.types.FunctionDeclaration` for Gemini). The agentic loop runs up to 6 tool-calling turns before forcing a text response.

### POST /v1/pii/scrub (routes/pii.py)

Exposes Tier 2 NER-based PII scrubbing directly. If no scrubber is available (Presidio not installed), returns the text unchanged with an empty entity list. This endpoint is used by core for ad-hoc scrubbing needs outside the standard LLM pipeline.

---

## Act X: Infrastructure — The Invisible Foundation

### Structured Logging (infra/logging.py)

The logging configuration enforces the **SS04 architecture rule** (docstring, lines 1-12): brain logs MUST NOT contain vault content, user queries, PII, reasoning output, NaCl plaintext, passphrases/keys, or API tokens. Only metadata is allowed: timestamps, endpoint, persona_id, query type, error codes, item counts, latency.

- **DEBUG mode** → colored console output (human-friendly for development).
- **Production** → JSON lines to stdout (machine-parseable for Docker, CloudWatch, Datadog).
- **Noisy loggers suppressed** (lines 82-83) — `httpx`, `httpcore`, `uvicorn.access` are silenced to WARNING level.
- **Request ID binding** (lines 86-97) — Each request gets a UUID4 bound to structlog's context, enabling distributed tracing across core ↔ brain.

### Crash Handler (infra/crash_handler.py)

A standalone module (117 lines) that can be called by any service, not just the guardian. The three-step crash protocol:

1. **Sanitised one-liner to stderr** (lines 32-48) — `_sanitize_oneliner()` extracts only the error type and deepest line number from the traceback. No local variables, no message text, no PII.
2. **Full traceback to encrypted vault** (lines 51-65, 96-113) — `_build_crash_report()` creates an unsanitized report. `handle_crash()` writes it to core's scratchpad at step 0 (reserved for crash data by convention).
3. **Re-raise** (line 116) — The error is re-raised so Docker's restart policy triggers a container restart. The brain is designed to be killed and restarted cleanly.

<details>
<summary><strong>Design Decision — Why re-raise instead of catching and continuing?</strong></summary>
<br>

An unrecoverable crash means the brain's internal state may be corrupted — a half-built entity vault, a partially processed event, a stale persona tracking set. Catching the error and continuing would leave the brain in an unknown state where subsequent requests might produce incorrect results (e.g., routing PII to a cloud LLM because the entity vault is in a bad state). Re-raising kills the process. Docker's restart policy (`restart: unless-stopped`) brings it back with clean state in seconds. Core's task queue requeues the in-flight task after the 5-minute timeout. The net effect is a few seconds of downtime versus an indefinite period of potentially unsafe behavior. In a system that guards personal data, the safe choice is always to restart.

</details>

### Configuration (infra/config.py)

A 148-line module that loads all brain config from environment variables. The `BrainConfig` dataclass (lines 37-58) is `frozen=True, slots=True` — immutable and memory-efficient. Key features:

- **Docker Secrets support** — `DINA_BRAIN_TOKEN_FILE` reads the token from a file, stripping whitespace (line 78).
- **URL validation** — `CORE_URL` is checked against a regex pattern (line 113). Invalid URLs fail at startup, not at first request.
- **Graceful optionals** — `LLM_URL`, `CLOUD_LLM`, and `CLIENT_TOKEN` are all optional. The brain works with zero optional config — it just has fewer capabilities.

---

## Act XI: The Five Stories — Proving the Brain

The user story tests (`tests/system/user_stories/`) run against a real multi-node stack with zero mocks. Each story exercises a different brain capability. Here's what the brain does in each.

### Story 01: The Purchase Journey (12 tests)

**Brain capability:** Vault-enriched, trust-weighted LLM reasoning.

The brain receives a reasoning request via `/api/v1/reason` with a query ("I need a chair") and trust-weighted review summaries from AppView. Before calling the LLM, it enriches the context by querying core's vault across multiple personas:

1. **Health persona** → "chronic back pain, L4-L5 issues" → needs lumbar support.
2. **Finance persona** → "budget ₹10-20K" → price filter.
3. **Work persona** → "WFH, 8+ hours sitting" → needs durability.

The LLM router (`service/llm_router.py`) selects the appropriate provider (light for chat, heavy for complex reasoning) and sends the enriched prompt. The response must reference specific trust signals: "3 verified reviewers (Ring 2) rate ErgoMax positively" vs "2 unverified reviewers liked CheapChair, but they lack attestations." The schema enforcer validates the output structure.

**Key brain components:** LLM router (provider selection), vault enrichment (multi-persona context assembly), trust signal formatting.

### Story 02: The Sancho Moment (7 tests)

**Brain capability:** DIDComm event routing → vault query → nudge assembly.

When core delivers a decrypted `dina/social/arrival` event to `/api/v1/process`, the brain's event router classifies it and dispatches to the nudge service (`service/nudge.py`). The nudge assembler:

1. **Queries vault by ContactDID** — searches for any stored context about Sancho's DID across all personas. Finds: "his mother had a fall last month", "likes cardamom tea with extra sugar."
2. **Applies Silence First** — classifies the nudge priority. An arriving friend with a sick mother is *Fiduciary* (silence causes social harm), not merely *Engagement*.
3. **Composes the nudge** — LLM generates 1-3 sentences: warm, actionable, with source attribution (Deep Link default). Under 1000 characters.

The nudge is returned to core, which delivers it via WebSocket to the user's device. The brain never sends the nudge directly — it advises, core acts.

**Key brain components:** Event router (DIDComm classification), nudge assembler (vault query + priority classification + LLM generation), Silence First enforcement.

### Story 03: The Dead Internet Filter (8 tests)

**Brain capability:** Trust-signal reasoning — identity-based content verification.

The brain receives two trust profiles from core's resolver and must reason about content authenticity. This is pure LLM reasoning with no vault enrichment (the query is about a creator, not about the user).

For Elena (Ring 3): the LLM sees `trust_score: 0.95, attestations: 200, vouches: 15, account_age: 2yr` and produces "authentic, trusted creator — 200 attestations from verified peers over 2 years."

For BotFarm (Ring 1): the LLM sees `trust_score: 0.0, attestations: 0, vouches: 0, account_age: 3d` and produces "unverified, no history — check other sources."

The side-by-side comparison test verifies that the LLM identifies **identity and history** as the deciding factor, not pixel forensics or metadata analysis. This is the Dead Internet thesis: in a world of perfect deepfakes, trust comes from who you are (attestation history), not what the content looks like.

**Key brain components:** LLM router (reasoning mode), trust profile formatting, schema-validated output.

### Story 04: The License Renewal (10 tests)

**Brain capability:** The Deterministic Sandwich — LLM extraction bookended by deterministic checks.

This story exercises four brain services in sequence:

**1. Document Ingestion** (`/api/v1/process`, event: `document_ingest`):
The LLM extracts fields from a license scan with per-field confidence scores. Critical fields (license_number, expiry_date) require ≥0.95 confidence. The PII scrubber runs *before* storage — the license number goes into encrypted metadata, the searchable summary says only "driving license, expires April 2026."

**2. Reminder Composition** (triggered by core's deterministic scheduler):
When core fires the 30-day reminder, brain receives a `reminder_fired` event. It queries the vault for context (address near which RTO, insurance provider, previous renewal experience) and composes a notification. The trigger is deterministic (no LLM). The content is LLM-generated. This is the sandwich: deterministic trigger → LLM reasoning → deterministic audit.

**3. Delegation Generation** (`/api/v1/reason`):
Brain generates a `DelegationRequest` JSON for an RTO bot. The schema enforces `denied_fields` (PII the bot must not see) and `permitted_fields` (safe metadata). The LLM must produce valid JSON matching the strict schema — PydanticAI rejects malformed output.

**4. Guardian Enforcement** (`service/guardian.py`):
The guardian classifies the delegation as HIGH risk (interacts with government system, involves PII). Sets `requires_approval=True`. The constraints enforce `no_storage=True`, `no_forwarding=True`, `max_ttl_seconds ≤ 3600`. The bot gets a time-limited, non-storable, non-forwardable permission slip.

**Key brain components:** LLM extraction (confidence scoring), PII scrubber (pre-storage), vault enrichment (reminder context), schema-strict generation (DelegationRequest), guardian (risk classification + constraint enforcement).

### Story 05: The Persona Wall (11 tests)

**Brain capability:** Cross-persona disclosure control — the guardian's most sensitive operation.

A shopping agent (consumer persona) asks brain: "Does the user have any health conditions that affect chair selection?" Brain's guardian (`service/guardian.py`) processes this as a `cross_persona_request` event.

**Step 1: Deterministic Tier Gate**
The guardian checks the source persona's tier. Health is `restricted` → automatic block. No LLM involved. This is a boolean decision, not a probabilistic one.

**Step 2: Minimal Disclosure Proposal**
The guardian queries the health persona's vault and classifies each sentence:

- **Medical PII detection** uses a two-tier approach:
  - **Primary:** `PresidioScrubber.detect()` with optional GLiNER NER (`urchade/gliner_multi_pii-v1` model, opt-in via `DINA_GLINER=1`). Detects `MEDICAL_CONDITION`, `MEDICATION`, `BLOOD_TYPE`, `HEALTH_INSURANCE_ID`, and `PERSON` entity types.
  - **Fallback:** Regex (`_MEDICAL_PII_REGEX_FALLBACK`) when Presidio is unavailable.

- Sentences containing medical entities are **withheld**: "L4-L5 disc herniation", "Dr. Sharma at Apollo Hospital", "Ibuprofen 400mg twice daily."
- General health terms are **safe to share**: "chronic back pain", "needs lumbar support", "avoid prolonged standing."

**Step 3: Human Approval**
The proposal is returned with `requires_approval=True`. The user sees what will be shared and what is withheld. They approve, modify, or reject.

**Step 4: Final PII Audit**
After approval, the guardian runs `_classify_sentence_medical()` on the approved text one more time. If any medical PII slipped through (the user manually typed something sensitive), it's caught. The audit result — `medical_patterns_found: [], clean: true` — is written to core's KV store.

<details>
<summary><strong>Design Decision — Why GLiNER for medical NER?</strong></summary>
<br>

The regex fallback (`_MEDICAL_PII_REGEX_FALLBACK`) catches terms we thought to list: "herniation", "ibuprofen", "MRI", etc. But medical terminology is vast — thousands of conditions, medications, and procedures. GLiNER's `urchade/gliner_multi_pii-v1` model (F1 90.87%) detects 50+ PII entity types including `medical condition` and `medication` using a pre-trained transformer. It runs locally on CPU (~200MB model), requires no cloud calls, and catches terms the regex misses.

GLiNER is opt-in (`DINA_GLINER=1`) because the model is heavy for resource-constrained deployments. When disabled, the regex fallback still provides defense-in-depth. When enabled, GLiNER is the primary detector and the regex becomes the secondary safety net. Both paths satisfy the same test assertions — the Persona Wall works regardless of which detector is active.

</details>

**Key brain components:** Guardian (tier gate + proposal builder + PII audit), PII scrubber with GLiNER (medical NER), entity vault (cross-persona query), Deterministic Sandwich (deterministic block → LLM proposal → deterministic audit).

---

## Epilogue: The Contract Between Core and Brain

The relationship between core and brain is asymmetric by design:

| Concern | Core (Go) | Brain (Python) |
|---------|-----------|----------------|
| Identity | Holds the keys | Cannot sign without core |
| Storage | Encrypts and stores | Reads and writes via HTTP |
| Auth | Issues and validates tokens | Presents tokens |
| Crypto | NaCl seal/unseal, Ed25519 | None — delegates to core |
| Reasoning | None | Full LLM pipeline |
| PII scrubbing | Tier 1 (regex) | Tier 2 (NER) |
| Event processing | Queues and dispatches | Classifies and decides |
| Agent safety | Enforces gatekeeper rules | Classifies intent risk |

Brain is the advisor. Core is the enforcer. Brain says "this is risky." Core blocks the action. Brain says "scrub this PII." Core executes the regex. Brain says "store this checkpoint." Core encrypts and writes it.

If brain dies, core continues to serve authenticated requests, manage vaults, and handle encrypted D2D messages. If core dies, brain enters degraded mode — it can still classify events locally but cannot store, retrieve, or communicate. The system is designed so that the *more critical* component (core, which holds keys and data) is also the *more resilient* component (Go, single binary, no runtime dependencies).

This is the architecture of agency: the brain *thinks*, but only the core *acts*.
