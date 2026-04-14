# The Dina Brain: A Walk Through the Guardian Angel

## Act I: Waking Up — The Composition Root

The brain is a Python FastAPI sidecar that provides Dina with the ability to *think*. It cannot act — it cannot sign data, open vaults, or send encrypted messages. It can only reason, classify, scrub, and advise. All authority remains with the Go core.

<details>
<summary><strong>Design Decision — Why a separate Python sidecar instead of embedding LLM logic in Go?</strong></summary>
<br>

Go excels at I/O-bound, low-latency work: HTTP routing, crypto operations, database queries. But the LLM ecosystem — Presidio pattern recognizers, OpenAI/Gemini/Claude SDKs, NLP pipelines — is overwhelmingly Python. Embedding all of this in Go would mean maintaining FFI bridges or re-implementing complex pipelines in a language with no ML ecosystem. The sidecar pattern gives us the best of both worlds: Go handles crypto and storage at native speed, Python handles reasoning and NLP with the full ML toolkit. The two processes authenticate via Ed25519 service keys — each service has its own keypair derived from the master seed at install time via SLIP-0010, and requests are signed with `X-DID`, `X-Timestamp`, and `X-Signature` headers. If the brain crashes, core continues to serve — your vault stays open, your identity stays valid. The brain is disposable; your data is not.

</details>

When the brain starts, `create_app()` in `brain/src/main.py:118` runs the same pattern as Go's `main.go`: explicit, top-to-bottom dependency construction. No dependency injection framework, no service locator, no magic. The docstring at lines 1-18 makes this law visible:

> *"This is the ONLY file that imports from `adapter/`. Services and routes depend only on port protocols and domain types."*

<details>
<summary><strong>Design Decision — Why explicit construction instead of a DI framework like FastAPI's Depends everywhere?</strong></summary>
<br>

FastAPI's `Depends()` is used for per-request concerns like authentication (`app.py:65-81`). But for application-level singletons — the LLM router, the guardian loop, the entity vault — explicit construction in `main.py` is clearer. You can read lines 150-332 top-to-bottom and see every dependency relationship. A DI framework would scatter this across decorators and class annotations, making the wiring invisible until runtime. 

</details>

### Step 1: Configuration (line 138)

`load_brain_config()` reads environment variables and returns a frozen dataclass (`infra/config.py:37`). The `frozen=True` flag means the config is immutable after construction — no one can accidentally mutate it mid-request. The primary authentication mechanism is Ed25519 service keys, configured via `DINA_SERVICE_KEY_DIR` (defaults to `/run/secrets/service_keys`). Private keys are isolated by separate Docker bind mounts — Brain's container sees its own private key at `/run/secrets/service_keys/private/brain_ed25519_private.pem` and both services' public keys at `/run/secrets/service_keys/public/`. Core's private key never exists in Brain's container filesystem.

<details>
<summary><strong>Design Decision — Why Ed25519 service keys instead of a shared bearer token?</strong></summary>
<br>

The shared-brain-token model required both core and brain to know the same static secret. That creates key distribution and attribution problems. Ed25519 service keys solve this: each service's keypair is derived deterministically from the master seed at install time via SLIP-0010 (`provision_derived_service_keys.py`), loaded at runtime via `ServiceIdentity.ensure_key()`. Each service reads only its peer's *public* key from a shared directory, and signs every request with a canonical payload (`{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{SHA256(BODY)}`). Requests carry `X-DID`, `X-Timestamp`, and `X-Signature` headers. The timestamp window (5 minutes) prevents replay attacks. The DID (`did:key:z{base58(0xed01 + pubkey)}`) gives each service a stable identity that can be logged and audited.

</details>

### Step 2: Adapter Construction (lines 150-251)

The composition root first initializes a `ServiceIdentity` — the brain's Ed25519 keypair (`adapter/signing.py`). `ensure_key()` loads the existing keypair from `/run/secrets/service_keys/private/brain_ed25519_private.pem` (provisioned at install time by `install.sh`) and fails if the file is missing — no runtime key generation occurs. It then loads core's public key via `load_peer_key_with_retry()` from `/run/secrets/service_keys/public/core_ed25519_public.pem`. Two `CoreHTTPClient` instances are built — the primary one authenticated with the brain's `ServiceIdentity` (Ed25519 signed requests), and an optional admin client authenticated with `CLIENT_TOKEN` (for admin UI calls that proxy through core). Then it walks through every possible LLM provider:

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

The V1 scrubber follows a two-tier fallback chain: **Presidio patterns** (best, deterministic recognizers + allow-list) → **None** (degraded, Tier 1 regex only via core). spaCy NER is **disabled** in V1 — it produced too many false positives on real data (B12 tagged as ORG, biryani as PERSON, Raju as ORG, pet names as PERSON). The brain never fails to start because a scrubber is missing — it just logs a warning and proceeds with reduced capability. But here is the critical invariant: **if the scrubber is `None` and a cloud LLM call needs PII scrubbing, the call is refused** (`entity_vault.py:131-139`). The system degrades gracefully but never degrades *unsafely*.

<details>
<summary><strong>Design Decision — Why two tiers of PII scrubbing (Go regex + Python patterns) instead of one?</strong></summary>
<br>

Tier 1 (Go regex in core, `POST /v1/pii/scrub`) catches structured PII with deterministic patterns: email addresses, phone numbers, credit card numbers, Aadhaar/PAN numbers, IP addresses. These are fast, accurate, and have near-zero false positives. Tier 2 (Presidio pattern recognizers — EmailRecognizer, PhoneRecognizer, CreditCardRecognizer, SSN, Aadhaar, PAN, IFSC, UPI, EU IDs) catches additional structured patterns that Go regex may miss, with an allow-list (`brain/config/pii_allowlist.yaml`) post-filtering false positives from medical terms, food names, and technical acronyms. Running Tier 1 first means Tier 2 sees `[EMAIL_1]` instead of `rajmohan@example.com`, avoiding duplicate detection and keeping entity numbering consistent (`entity_vault.py:245-286`). The two tiers are complementary, not redundant. **V1 known gap:** names and addresses in free text are NOT detected — accepted trade-off until V2 (GLiNER local model for contextual NER).

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

- **Brain API** (`/api/*`) — Authenticated via Ed25519 signed requests (core's service key). Only trusted internal callers talk to this.
- **Admin UI** (`/admin/*`) — Authenticated with `CLIENT_TOKEN`. Only the user's browser talks to this.

<details>
<summary><strong>Design Decision — Why two separate sub-apps with different tokens?</strong></summary>
<br>

The brain API and admin UI serve fundamentally different callers with different trust levels. Core calls `/api/v1/process` with Ed25519 signed requests — each request carries `X-DID`, `X-Timestamp`, and `X-Signature` headers verified against core's pinned public key. The admin UI is accessed by the user's browser with `CLIENT_TOKEN`-backed session auth on the admin app surface. Separating them means: (1) a compromised admin session cannot forge Ed25519-signed brain API requests (and vice versa), (2) module isolation is enforced at the import level (`dina_brain` never imports from `dina_admin`, line 12-13 of `main.py`), and (3) the admin UI can be disabled entirely by not setting `CLIENT_TOKEN` (line 381-388). The admin UI is convenience; the brain API is infrastructure.

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

**Staging drain** (line 930) — The `staging_drain` event is fired by Core as a non-blocking goroutine after every ingest. The guardian delegates to `staging_processor.process_pending(limit=5)`, which claims and classifies pending staged items immediately so the user doesn't have to wait for the next sync cycle. The 5-minute periodic sync in the lifespan background task (lines 609-613) serves as a safety net, calling the same processor with `limit=20` in case any drain events are missed or the brain was restarting.

**Session-scoped access control** — When resolving staged items, the staging processor extracts `session` and `origin_did` from item metadata and forwards them as `X-Session` and `X-Agent-DID` headers on `staging_resolve` and `staging_resolve_multi` calls (`core_http.py:390-394`, `424-427`). Core's `AccessPersona()` uses these headers to enforce session-scoped grant checks — an agent can only write to personas it was granted access to for the current session.

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
   - **Tier 2**: Presidio pattern recognizers (Python, in-process) catch additional structured PII. NER is disabled in V1; an allow-list filters false positives.
   - If *either tier fails*, `PIIScrubError` is raised and the cloud call is blocked. This is the hard security gate.

3. **Build vault** (line 145) — An in-memory dict mapping tokens to originals: `{"[PERSON_1]": "Dr. Sharma", "[ORG_1]": "Apollo Hospital"}`.

4. **Call cloud LLM** (lines 155-161) — Send scrubbed messages. If the LLM fails, the vault is cleared immediately (line 160).

5. **Rehydrate** (line 164) — Replace tokens in the LLM response with original values.

6. **Destroy vault** (line 167) — `vault.clear()`. Belt and suspenders — the dict is emptied explicitly, not left for garbage collection.

<details>
<summary><strong>Design Decision — Why an ephemeral in-memory vault instead of a persistent entity map?</strong></summary>
<br>

A persistent map would let the brain remember past scrubbing results: "We already know `[PERSON_1]` is Dr. Sharma from the last call." But persistence creates risk: the map is a PII-to-token lookup table. If it's stored in a database, it's a target. If it's cached in Redis, it might be exposed via `MONITOR`. If it's written to disk, it might survive a container restart. The ephemeral approach eliminates all of these risks. Each cloud LLM call creates a fresh vault, uses it for exactly one request-response cycle, and destroys it. The tradeoff is that the brain re-scrubs text it's seen before — but scrubbing is fast (regex + patterns over a few KB of text), and the security guarantee is worth the microseconds.

</details>

### Sensitivity-Aware Scrubbing (lines 245-286)

The `_two_tier_scrub` method adjusts intensity based on sensitivity level:

- **GENERAL** → Tier 1 + Tier 2 `scrub_patterns_only` (emails, phones, IDs). V1 uses patterns only at all levels since NER is disabled.
- **ELEVATED / SENSITIVE** → Full pattern pipeline. Tier 1 + Tier 2 patterns with allow-list filtering. In V2 (GLiNER), these levels will add contextual NER for names, organizations, and locations.

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
- **ApprovalRequiredError** (line 32) — Core returned HTTP 403 with `approval_required`. The approval request has already been created by Core (and a notification sent to the user via WebSocket + Telegram). Brain does **not** call `staging_fail` — the item is already marked `pending_unlock` by Core. The CLI should inform the user and exit; retrying the same query after approval succeeds.

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

- HTTP 401 → fatal `ConfigError` (service authentication failed — bad signature or expired timestamp), no retry.
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

### Service Query Handling

Guardian dispatches `service.*` messages via `_DIDCOMM_HANDLERS`:

**Provider side** (`ServiceHandler`):
1. Receives `service.query` from D2D
2. Looks up capability in local `CAPABILITY_REGISTRY` (allowlist)
3. Validates params with per-capability Pydantic model
4. Calls MCP: `call_tool(config.mcp_server, config.mcp_tool, validated_params)`
5. Validates result with per-capability Pydantic model
6. Sends `service.response` back via Core D2D

**Requester side** (`ServiceQueryOrchestrator`):
1. User asks "when does bus 42 arrive?"
2. Searches AppView: `search_services(capability, lat, lng)`
3. Sends `service.query` to best-ranked candidate
4. Tracks pending query with timeout (60s)
5. On response: notifies user ("Route 42 AC Bus — 45 minutes away")
6. On timeout: notifies user ("No response yet from Route 42.")

**Capability models** (`brain/src/service/capabilities/eta_query.py`):
- `EtaQueryParams`: `{location: {lat, lng}}`
- `EtaQueryResult`: `{eta_minutes, vehicle_type, route_name, current_location?}`

---

## Act VII: The Adapter Layer — Where Protocols Meet Reality

### CoreHTTPClient (adapter/core_http.py)

The HTTP adapter implements the `CoreClient` protocol. The `_request` helper is the workhorse:

- **Lazy client** — `httpx.AsyncClient` is created on first use and reused. If it's closed (e.g., after a shutdown), a new one is created transparently.
- **Ed25519 signed auth** — When constructed with a `ServiceIdentity`, every request is signed via `_sign_headers()`: the canonical payload (`{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{SHA256(BODY)}`) is signed with the brain's Ed25519 private key, and the request carries `X-DID`, `X-Timestamp`, and `X-Signature` headers. Falls back to `Authorization: Bearer {token}` when constructed with only a `brain_token` (used by the admin client).
- **Retry with exponential backoff** — 3 attempts with 1s, 2s, 4s delays. Connection errors and 5xx responses are retried. 401 and 403 are not.
- **Error classification** — 401 → `ConfigError` (fatal — service authentication failed, won't retry). 403 → `PersonaLockedError` (the persona vault is locked, the guardian should whisper an unlock request) or `AuthorizationError` for other access denials.

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

At 622 lines, this is the largest adapter. In V1, it wraps Microsoft Presidio's **deterministic pattern recognizers only** — spaCy NER is disabled. Three important design choices:

1. **SAFE_ENTITIES whitelist** (lines 46-64) — DATE, TIME, MONEY, PERCENT, CARDINAL, etc. are never scrubbed. These are essential for LLM reasoning ("the payment of $500 is due on March 15") and don't identify anyone.

2. **Allow-list post-filter** (`brain/config/pii_allowlist.yaml`) — All Presidio results are filtered against an allow-list of medical terms (B12, A1C, HbA1c, CBC...), financial abbreviations, immigration codes, technical acronyms, and food names. This eliminates the false positives that made NER unusable in V1 (B12 tagged as ORG, biryani as PERSON, Raju as ORG, pet names as PERSON).

3. **India-specific recognizers** — Aadhaar numbers, PAN card numbers, IFSC codes, UPI IDs. Plus EU recognizers for German Steuer-ID, French NIR/NIF, Dutch BSN, SWIFT/BIC.

4. **Opaque token replacement** — PII is replaced with indexed tokens: `Dr. Sharma` → `[PERSON_1]`, not Faker synthetic names. Exact-match rehydration works reliably with opaque tokens. Rehydration matches both bracketed `[PERSON_1]` and bare `PERSON_1` forms (LLMs sometimes strip brackets).

<details>
<summary><strong>Design Decision — Why opaque tokens instead of Faker synthetic data in V1?</strong></summary>
<br>

Faker-based synthetic replacement (`Dr. Sharma` → `Dr. Meera Patel`) produces natural-looking text but creates fragile rehydration: the LLM might paraphrase "Dr. Meera Patel" as "Dr. Patel" or "Meera", breaking the reverse mapping. Opaque tokens (`[PERSON_1]`) are ugly but reliable — exact-match rehydration works consistently. V1 prioritizes correctness over LLM reasoning quality. The rehydrator matches both bracketed and bare forms to handle LLMs that strip brackets. V2 may revisit synthetic replacement once GLiNER provides more reliable entity boundaries.

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

### StagingProcessor (service/staging_processor.py)

The staging processor is the publication pipeline for ingested items (503 lines). Items arrive in Core's staging inbox from connectors (push) or Brain's MCP sync (pull). The processor claims pending items and runs a 7-step pipeline:

1. **Claim** — `staging_claim(limit)` atomically leases up to `limit` items from Core's staging inbox.
2. **Classify persona** — `_classify_personas()` determines one or more target personas. Resolution order: domain classifier (keyword/source-based) → PersonaSelector (LLM, constrained to installed personas) → deterministic type-based fallback → `"general"`. Multi-persona routing ranks secondaries by sensitivity (`_SENSITIVITY_RANK`: health=5 > financial=4 > work=3 > social/consumer=1 > general=0).
3. **Score trust** — `TrustScorer.score()` assigns sender trust, source type, confidence, and retrieval policy based on contact ring and ingress provenance.
4. **Build classified VaultItem** — Merge item metadata, trust provenance, original timestamp, and routing metadata into a VaultItem template ready for enrichment.
5. **Enrich** — `EnrichmentService.enrich_raw()` generates L0 summary, L1 entities, and embedding vector. A lease heartbeat task (VT6) extends the staging lease every 5 minutes during this slow LLM step. If enrichment fails, the item is marked failed via `staging_fail` and stays in staging for retry (Core's sweeper requeues items with `retry_count <= 3`).
6. **Resolve via Core** — Single-persona items call `staging_resolve`; multi-persona items call `staging_resolve_multi`. Both forward `X-Session` and `X-Agent-DID` headers for session-scoped access control. Core atomically decides `stored` vs `pending_unlock` (for locked personas). `ApprovalRequiredError` is caught but not re-failed — Core has already marked the item as `pending_unlock` and created an approval request.
7. **Post-processing** — On successful storage: extract events/reminders via `EventExtractor.extract_and_create()`, update contact `last_contact` timestamp, and surface routing ambiguity to the daily briefing via Core's KV store.

### DomainClassifier (service/domain_classifier.py)

A four-layer classifier that determines content sensitivity (249 lines):

- **Layer 1: Persona override** (lines 167-186) — Uses `PersonaRegistry.tier()` (dynamic, from Core) first, mapping `sensitive`/`locked` tiers → SENSITIVE, `standard` → ELEVATED, `default` → GENERAL via `_TIER_SENSITIVITY` (line 143). Falls back to the static `_PERSONA_MAP` only when the registry is unavailable or the persona is unknown. Short-circuits on SENSITIVE/LOCAL_ONLY.
  The static `_PERSONA_MAP` (lines 35-45) also contains legacy alias entries for backward compatibility with older classifiers: `personal` → GENERAL (maps to general), `social` → GENERAL (maps to general), `financial` → ELEVATED (synonym for finance), and `medical` → SENSITIVE (synonym for health).
- **Layer 2: Keyword signals** (lines 188-189, function at lines 87-128) — Regex patterns for health (diagnosis, prescription, blood sugar), finance (bank account, credit card, IFSC), and legal (lawsuit, subpoena, deposition). Each domain is scored by strong and weak keyword counts.
- **Layer 3: Vault context** (lines 192-216) — If the source is `health_system` or the item type is `medical_record`, the sensitivity is SENSITIVE regardless of keywords.
- **Layer 4: LLM fallback** (line 241) — Skipped in the current implementation. Defaults to GENERAL with low confidence (0.3).

The selection rule (lines 218-239): highest confidence wins. On ties, higher sensitivity wins. This ensures that a health keyword (confidence 0.6) + a vault source match (confidence 0.9) resolves to the vault source's SENSITIVE classification.

### PersonaRegistry (service/persona_registry.py)

A cached metadata store for installed personas (154 lines). Queries Core's `GET /v1/personas` at startup, caches the result as frozen `PersonaInfo` dataclasses, and refreshes on persona-related events or periodic poll. Provides synchronous lookups: `exists()`, `tier()`, `locked()`, `all_names()`. Falls back to a conservative hardcoded set (general, work, health, finance) when Core is unreachable at first load — but keeps the last known good cache on subsequent refresh failures. `update_locked()` handles event-driven lock/unlock state changes without a full refresh.

### PersonaSelector (service/persona_selector.py)

Uses a constrained LLM to suggest which persona an incoming item belongs to, choosing only from the set of installed personas (`PersonaRegistry.all_names()`). The system prompt declares the available personas with their tiers and instructs the LLM to respond with a JSON `SelectionResult` (primary, secondary, confidence, reason). The selector validates the LLM's answer against the registry — any hallucinated persona name is rejected.

Returns `SelectionResult` or `None`. This is an important contract: the AI *suggests*, it is never authoritative. When the selector returns `None` (no LLM available, low confidence, or invalid answer), the caller falls back to the deterministic type-based resolution in `StagingProcessor._resolve_fallback()`. The staging processor's `_classify_persona` method tries the domain classifier first (keyword/source-based hint), then PersonaSelector (LLM), then deterministic fallback, then `"general"` — the AI layer sits in the middle of a deterministic sandwich.

---

## Act IX: The API Surface — Three Endpoints

The brain API exposes exactly three endpoints, all behind `verify_service_auth()` authentication.

### Authentication (dina_brain/app.py)

Every brain API request is verified by `verify_service_auth()`:

**Path 1: Ed25519 signed requests** (primary) — Core sends `X-DID`, `X-Timestamp`, and `X-Signature` headers. The dependency calls `ServiceIdentity.verify_request()` with core's pinned public key, reconstructing the canonical signing payload (`{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{SHA256(BODY)}`) and verifying the Ed25519 signature. The timestamp must be within a 5-minute window to prevent replay attacks. If the core public key is not loaded (startup race), the request is rejected with 401.

Ed25519 signatures provide no shared secret, explicit service identity, and replay resistance via timestamps.

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

Exposes Tier 2 pattern-based PII scrubbing directly. In V1, this uses Presidio's deterministic pattern recognizers (no NER). If no scrubber is available (Presidio not installed), returns the text unchanged with an empty entity list. This endpoint is used by core for ad-hoc scrubbing needs outside the standard LLM pipeline.

### CLI Communication via MsgBox

The CLI communicates with Core through the MsgBox relay using encrypted RPC envelopes. Brain is not directly involved in CLI transport — it's a Core-level concern. Brain interacts with CLI indirectly: CLI sends RPC requests (e.g., `/api/v1/remember`, `/api/v1/ask`) which Core routes through the handler chain to Brain's `/v1/process` endpoint.

The MsgBox transport is transparent to Brain — from Brain's perspective, a request from a CLI device via MsgBox is identical to a direct HTTPS request.

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

A module that loads all brain config from environment variables. The `BrainConfig` dataclass is `frozen=True, slots=True` — immutable and memory-efficient. Key features:

- **Service key directory** — `DINA_SERVICE_KEY_DIR` points to the base directory for Ed25519 service keys (default `/run/secrets/service_keys`). Brain generates its private key in the `private/` subdirectory and its public key in the `public/` subdirectory. It reads core's public key from `public/`. Private keys are isolated by separate Docker bind mounts — Brain's `private/` directory contains only Brain's private key (Core's private key is never in Brain's filesystem).
- **Service keys** — `DINA_SERVICE_KEY_DIR` points to the Ed25519 key material for Core↔Brain signed requests.
- **URL validation** — `CORE_URL` is checked against a regex pattern. Invalid URLs fail at startup, not at first request.
- **Graceful optionals** — `LLM_URL`, `CLOUD_LLM`, and `CLIENT_TOKEN` are all optional. The brain works with zero optional config — it just has fewer capabilities.

---

## Act XI: The Six Stories — Proving the Brain

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

### Story 04: The Persona Wall (11 tests)

**Brain capability:** Cross-persona disclosure control — the guardian's most sensitive operation.

A shopping agent (consumer persona) asks brain: "Does the user have any health conditions that affect chair selection?" Brain's guardian (`service/guardian.py`) processes this as a `cross_persona_request` event.

**Step 1: Deterministic Tier Gate**
The guardian checks the source persona's tier. Health is `restricted` → automatic block. No LLM involved. This is a boolean decision, not a probabilistic one.

**Step 2: Minimal Disclosure Proposal**
The guardian queries the health persona's vault and classifies each sentence:

- **Medical PII detection** uses Presidio pattern recognizers with allow-list filtering. In V1, NER is disabled; detection relies on deterministic patterns for structured medical identifiers (health insurance IDs, etc.) plus regex fallback (`_MEDICAL_PII_REGEX_FALLBACK`) for medical terms (herniation, ibuprofen, MRI, etc.). V2 plan: GLiNER (`urchade/gliner_multi_pii-v1` model) for contextual medical NER.

- Sentences containing medical entities are **withheld**: "L4-L5 disc herniation", "Dr. Sharma at Apollo Hospital", "Ibuprofen 400mg twice daily."
- General health terms are **safe to share**: "chronic back pain", "needs lumbar support", "avoid prolonged standing."

**Step 3: Human Approval**
The proposal is returned with `requires_approval=True`. The user sees what will be shared and what is withheld. They approve, modify, or reject.

**Step 4: Final PII Audit**
After approval, the guardian runs `_classify_sentence_medical()` on the approved text one more time. If any medical PII slipped through (the user manually typed something sensitive), it's caught. The audit result — `medical_patterns_found: [], clean: true` — is written to core's KV store.

<details>
<summary><strong>Design Decision — Why deterministic patterns + allow-list in V1 instead of GLiNER?</strong></summary>
<br>

spaCy NER produced too many false positives on real data: B12 tagged as ORG, biryani as PERSON, Raju as ORG, pet names as PERSON. V1 uses deterministic Presidio pattern recognizers plus an allow-list (`brain/config/pii_allowlist.yaml`) for medical terms, food names, and technical acronyms. The regex fallback (`_MEDICAL_PII_REGEX_FALLBACK`) catches terms we thought to list: "herniation", "ibuprofen", "MRI", etc. V1 known gap: names and addresses in free text are NOT detected. V2 plan: GLiNER (`urchade/gliner_multi_pii-v1`, ~300M params, local CPU) for contextual NER with an LLM adjudicator for ambiguous cases.

</details>

**Key brain components:** Guardian (tier gate + proposal builder + PII audit), PII scrubber with Presidio patterns + allow-list (V1), entity vault (cross-persona query), Deterministic Sandwich (deterministic block → LLM proposal → deterministic audit).

### Story 05: The Agent Gateway (10 tests)

**Brain capability:** Guardian's deterministic intent classification — the decision tree that routes agent intents to auto_approve, flag_for_review, or deny.

An external agent (OpenClaw, Claude, or any custom bot) pairs with the Home Node via `dina configure` (Ed25519 keypair + 6-digit code → `POST /v1/pair/complete`) and submits every intended action via `dina validate`, which calls Core's `POST /v1/agent/validate`. Core authenticates the device (Ed25519 or bearer token) and proxies to brain's guardian via `BrainClient.ProcessEvent()` — no shared brain secret on the client. This follows the same pattern used for admin traffic (`core/internal/handler/admin.go`).

**Intent Classification Pipeline** (`service/guardian.py → review_intent()`):

The guardian extracts `action`, `trust_level`, and `risk_level` from the event and applies a deterministic decision tree (no LLM):

1. **Trust gate:** If `trust_level == "untrusted"` → `deny`, risk `BLOCKED`. Full stop.
2. **Blocked actions:** If `action ∈ _BLOCKED_ACTIONS` (`read_vault`, `export_data`, `access_keys`) → `deny`, risk `BLOCKED`. Even verified agents are denied.
3. **High risk:** If `action ∈ _HIGH_ACTIONS` (`transfer_money`, `share_data`, `delete_data`, `sign_contract`) → `flag_for_review`, risk `HIGH`, `requires_approval=True`.
4. **Moderate risk:** If `action ∈ _MODERATE_ACTIONS` (`send_email`, `draft_email`, `pay_upi`, `pay_crypto`, `web_checkout`) → `flag_for_review`, risk `MODERATE`, `requires_approval=True`.
5. **Otherwise:** → `auto_approve`, risk `SAFE`, `approved=True`.

Every decision is audited via `_audit_intent()` which writes to the KV store.

The tests verify all five classification buckets, plus persona isolation (health vault data invisible from consumer context) and device revocation (revoked token → immediate 401).

**Key brain components:** Guardian (`review_intent()` — deterministic action classification), `_BLOCKED_ACTIONS` / `_HIGH_ACTIONS` / `_MODERATE_ACTIONS` (frozen action sets), audit trail (KV store via core HTTP).

### Story 06: The License Renewal (10 tests)

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

**Key brain components:** LLM extraction (confidence scoring), PII scrubber with Presidio patterns (pre-storage), vault enrichment (reminder context), schema-strict generation (DelegationRequest), guardian (risk classification + constraint enforcement).

---

## Epilogue: The Contract Between Core and Brain

The relationship between core and brain is asymmetric by design:

| Concern | Core (Go) | Brain (Python) |
|---------|-----------|----------------|
| Identity | Holds the keys | Cannot sign without core |
| Storage | Encrypts and stores | Reads and writes via HTTP |
| Auth | Verifies Ed25519 signatures + issues internal tokens | Signs requests with service key |
| Crypto | NaCl seal/unseal, Ed25519 | None — delegates to core |
| Reasoning | None | Full LLM pipeline |
| PII scrubbing | Tier 1 (regex) | Tier 2 (Presidio patterns + allow-list) |
| Event processing | Queues and dispatches | Classifies and decides |
| Agent safety | Enforces gatekeeper rules | Classifies intent risk |

Brain is the advisor. Core is the enforcer. Brain says "this is risky." Core blocks the action. Brain says "scrub this PII." Core executes the regex. Brain says "store this checkpoint." Core encrypts and writes it.

If brain dies, core continues to serve authenticated requests, manage vaults, and handle encrypted D2D messages. If core dies, brain enters degraded mode — it can still classify events locally but cannot store, retrieve, or communicate. The system is designed so that the *more critical* component (core, which holds keys and data) is also the *more resilient* component (Go, single binary, no runtime dependencies).

This is the architecture of agency: the brain *thinks*, but only the core *acts*.
