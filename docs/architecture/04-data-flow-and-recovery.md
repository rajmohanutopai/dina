> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

### Data Flow: Who Touches What

The core principle: **Go owns the file. Python owns the thinking. Core is the gatekeeper.**

```
WHO TOUCHES SQLITE?

  dina-core (Go)     ← ONLY process that opens identity.sqlite + persona .sqlite files
  dina-brain (Python) ← NEVER touches SQLite. Talks to core via HTTP API.
                        Core decides which persona databases brain can access (gatekeeper.go).
  llama (optional)   ← Stateless. No database access.
```

#### Writing

**1. Ingestion (brain orchestrates via MCP, core stores)**

**Content routing is brain's job.** Contacts don't belong to personas — people span contexts. Dr. Patel sends lab results (→ `/health`) AND cricket chat (→ `/social`). Brain classifies each piece of content by its subject matter, not by who sent it. Phase 1: everything goes to `/personal` (single persona). Phase 2: brain uses LLM classification.

```
Brain → MCP → OpenClaw: "fetch emails since last sync cursor"
  → OpenClaw calls Gmail API → returns structured JSON
  → Brain classifies each email by content:
      Subject: "Your lab results"     → persona='health'
      Subject: "Team standup notes"   → persona='professional'
      Subject: "Dinner Friday?"       → persona='social'
      Subject: "Your order shipped"   → persona='consumer'
      (Phase 1: all → persona='personal')
  → Brain → POST core:8100/v1/vault/store (persona=<classified>)
  → Brain → PUT core:8100/v1/vault/kv/gmail_cursor {timestamp: "..."}

Brain → MCP → OpenClaw: "fetch calendar events"
  → OpenClaw calls Calendar API → returns structured JSON
  → Brain → POST core:8100/v1/vault/store (persona='professional', or 'personal' in Phase 1)

Telegram → Home Node connector receives via Bot API → core writes to social.sqlite (or personal.sqlite in Phase 1)
  → Core notifies brain: POST brain:8200/v1/process {item_id, source, type}
```

**2. Brain-generated data (brain asks core to write)**
```
Brain generates a draft     → POST core:8100/v1/vault/store {type: "draft", ...}
Brain creates staging item  → POST core:8100/v1/vault/store {type: "payment_intent", ...}
Brain extracts relationship → POST core:8100/v1/vault/store {type: "relationship", ...}
```

**3. Embeddings (brain generates, core stores)**
```
Brain ingests new item via MCP
  → brain generates 768-dim embedding:
      With llama: calls llama:8080 (EmbeddingGemma, local)
      Without llama: calls gemini-embedding-001 (cloud API)
  → brain sends text + embedding to core: POST core:8100/v1/vault/store
      {type: "note", body_text: "...", embedding: [...768 floats...]}
  → core stores text + embedding BLOB in same SQLCipher row (encrypted at rest)
  → core inserts vector into in-memory HNSW index (if persona is unlocked)
```

Brain generates the embedding because it already has the LLM routing logic and knows which model to use. Core stores the embedding as a BLOB in the same `vault_items` row as the text — encrypted by SQLCipher. If the persona is unlocked, the vector is also inserted into the in-memory HNSW index for immediate searchability.

#### Reading

**4. Simple search (core handles alone — fast path)**
```
Client: "find emails from Sancho"
  → client WebSocket → core
  → core runs FTS5 query: SELECT * FROM documents_fts WHERE body_text MATCH 'Sancho'
  → core returns results to client

  Brain is not involved. This is a fast-path lookup.
```

**5. Semantic search (core executes, brain orchestrates)**
```
Client: "what was that deal Sancho was worried about?"
  → client WebSocket → core
  → core sees this needs reasoning → POST brain:8200/v1/reason {query: "..."}
  → brain's agentic reasoning loop (ReasoningAgent) autonomously decides what to search:
      LLM calls list_personas → sees available vaults + recent summaries
      LLM calls search_vault("personal", "Sancho deal") →
        brain generates 768-dim query embedding via llama:8080 (or cloud API)
        brain sends to core: POST core:8100/v1/vault/query {text: "Sancho deal", embedding: [...]}
        core runs hybrid search: FTS5 keyword match + in-memory HNSW cosine similarity
        score = 0.4 × FTS5_rank + 0.6 × cosine_similarity
        core returns merged top-K results to brain
  → LLM reasons over combined context from all vault queries
  → brain returns answer to core
  → core pushes to client
```

**6. Agentic multi-step search (brain drives, core serves)**
```
Sancho's Dina sends "arriving in 15 minutes"
  → core receives via DIDComm → POST brain:8200/v1/process

  Brain runs guardian angel loop (Google ADK agent):
    Step 1: brain → core: /v1/vault/query {text: "Sancho", type: "relationship"}
            → gets: last interaction 3 weeks ago, mother was ill
    Step 2: brain → core: /v1/vault/query {text: "Sancho", type: "message", limit: 5}
            → gets: recent message history
    Step 3: brain → core: /v1/vault/query {text: "Sancho", type: "event", upcoming: true}
            → gets: no upcoming calendar events
    Step 4: brain → LLM (llama:8080 or cloud): "Given this context, assemble a nudge"
            → generates: "Sancho is 15 min away. Mother was ill. Likes strong chai."
    Step 5: brain → core: POST /v1/notify {type: "nudge", text: "...", client: "phone"}
            → core pushes to phone via WebSocket
```

#### Ownership Summary

```
┌─────────────────────────────────────────────────────────┐
│  dina-core (Go) — THE VAULT KEEPER                      │
│                                                         │
│  OWNS:                                                  │
│  - identity.sqlite + persona .sqlite files (open/close/read/write/backup) │
│  - SQLCipher encryption/decryption                      │
│  - FTS5 queries                                         │
│  - HNSW vector queries (given embedding, find neighbors) │
│  - WebSocket to clients                                 │
│  - DIDComm endpoint                                     │
│  - Gatekeeper RBAC (persona access, egress filtering)   │
│                                                         │
│  DOES NOT:                                              │
│  - Generate embeddings                                  │
│  - Decide what to search for                            │
│  - Reason over results                                  │
│  - Classify urgency                                     │
│  - Assemble nudges                                    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  dina-brain (Python + ADK) — THE ANALYST                │
│                                                         │
│  OWNS:                                                  │
│  - MCP orchestration (OpenClaw — fetch email, calendar) │
│  - Sync scheduling (morning routine, hourly checks)     │
│  - Search strategy (what to query, in what order)       │
│  - Embedding generation (calls llama or cloud)          │
│  - LLM reasoning (calls llama or cloud)                 │
│  - Silence classification (Tier 1/2/3)                  │
│  - Nudge assembly                                       │
│  - Agent orchestration (multi-step, ADK agents)         │
│                                                         │
│  DOES NOT:                                              │
│  - Open SQLite files                                    │
│  - Manage encryption keys                               │
│  - Talk to clients directly                             │
│  - Handle DIDComm                                       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  llama (llama.cpp) — THE HIRED CALCULATOR  [optional]   │
│                                                         │
│  OWNS:                                                  │
│  - Model inference (Gemma 3n, FunctionGemma, embeddings)│
│                                                         │
│  Called by BOTH core and brain (when present):           │
│  - Core calls it for: PII Tier 3 (LLM NER fallback)     │
│  - Brain calls it for: reasoning, classification,       │
│    embeddings, Tier 3 PII scrubbing                     │
│                                                         │
│  Stateless. No database. No business logic.             │
│  Without llama: brain uses cloud APIs + spaCy NER,      │
│  core uses regex. PII scrubbing: Tier 1+2 (no Tier 3). │
└─────────────────────────────────────────────────────────┘
```

The analogy: **core is the vault keeper** (stores, retrieves, encrypts, never interprets, never calls external APIs). **Brain is the orchestrator** (thinks, searches strategically, reasons, delegates fetching to OpenClaw via MCP, never holds keys). **OpenClaw is the senses** (fetches email, calendar, web — returns structured data, holds no memory). **llama is the hired calculator** (computes what it's asked, remembers nothing — optional, replaceable by cloud APIs).

#### Core ↔ Brain API Contract

The internal API between core and brain. All endpoints require `Authorization: Bearer <BRAIN_TOKEN>`. Admin endpoints use `CLIENT_TOKEN` (admin web UI) or Ed25519 signatures (CLI). All requests/responses are JSON. Core enforces gatekeeper access tiers before any query executes.

**`POST /v1/vault/query` — Search the vault**

```json
// Request
{
  "persona": "/social",                // required — gatekeeper checks access tier
  "q": "meeting with Sancho",          // search query (FTS5 and/or embedding)
  "mode": "hybrid",                    // "fts5" | "semantic" | "hybrid" (default)
  "filters": {
    "types": ["email", "calendar"],    // optional — filter by item_type
    "after": "2026-01-01T00:00:00Z",   // optional — time range start
    "before": null                     // optional — time range end (null = now)
  },
  "include_content": false,            // default false — summary only (safe path)
  "limit": 20,                         // default 20, max 100
  "offset": 0                          // pagination
}

// Response (200 OK)
{
  "status": "ok",
  "items": [
    {
      "id": "vault_a1b2c3",
      "type": "email",
      "persona": "/social",
      "summary": "Meeting confirmed with Sancho for Thursday 3pm",
      "source": "gmail:msg:18d4f2a1b3",
      "timestamp": "2026-02-18T10:30:00Z",
      "relevance": 0.87,
      "metadata": {
        "from": "sancho@example.com",
        "subject": "Re: Thursday meeting",
        "has_attachment": true
      }
    }
  ],
  "pagination": {
    "has_more": true,
    "next_offset": 20
  }
}

// Response (403 — persona locked)
{
  "error": "persona_locked",
  "message": "/financial requires authentication",
  "code": 403
}
```

**Search modes:**

| Mode | Engine | Best for | `relevance` field |
|------|--------|----------|-------------------|
| `fts5` | SQLite FTS5 (`unicode61` tokenizer) | Exact keyword matching, fast | FTS5 rank score (normalized) |
| `semantic` | In-memory HNSW cosine similarity (768-dim, `coder/hnsw`) | Fuzzy meaning-based matching | Cosine similarity 0.0–1.0 |
| `hybrid` (default) | Both, merged + deduplicated | Most queries | `0.4 × fts5_rank + 0.6 × cosine_similarity` |

**`include_content` design decision:** Default is `false` — brain gets `summary` only (LLM-generated at ingestion, already scrubbed). This makes the safe path the default. Setting `include_content: true` returns the raw `body_text` — brain is then responsible for PII scrubbing before sending to any cloud LLM. This flag is a signal to the developer that they're opting into a higher-trust path.

**`POST /v1/vault/store` — Write processed data**

```json
// Request
{
  "persona": "/social",
  "type": "email",                     // "email", "message", "event", "relationship", "draft", "scratchpad", etc.
  "source": "gmail:msg:18d4f2a1b3",
  "summary": "Meeting with Sancho confirmed for Thursday 3pm",
  "embedding": [0.012, -0.034, ...],   // 768-dim vector (optional — for semantic search)
  "metadata": { "from": "sancho@example.com", "subject": "Re: Thursday meeting" },
  "timestamp": "2026-02-18T10:30:00Z"
}

// Response (201 Created)
{ "status": "ok", "id": "vault_a1b2c3" }
```

**`GET /v1/vault/item/:id` — Retrieve single item**

**`DELETE /v1/vault/item/:id` — Delete single item (right to forget)**

**`POST /v1/vault/crash` — Store crash traceback (encrypted)**

```json
{
  "error": "RuntimeError at line 142",
  "traceback": "...",
  "task_id": "task_abc123"
}
```

**What brain NEVER gets via this API:** encryption keys, raw attachment blobs, other users' data (managed hosting). Brain gets summaries and metadata. Raw content stays in source (Gmail, Telegram). The vault API enforces this — `gatekeeper.go` routes queries to the correct persona database (if open) or returns `403 Persona Locked` (if the DEK isn't in RAM). (Note: OAuth tokens live in OpenClaw, not in Dina — Core never holds external API credentials.)

### Brain Crash Recovery

When brain OOMs or crashes mid-reasoning, Docker restarts it. But what happens to in-flight operations? If brain was mid-way through assembling a Sancho nudge (Step 3 of 5), the operation state is gone from RAM. Two mechanisms ensure nothing is lost:

**1. Task Queue (Outbox Pattern — in core)**

Core does not fire-and-forget when sending events to brain. It treats brain as an unreliable worker.

```
Core → Brain task lifecycle:

  Core receives event (ingestion, DIDComm message, client query)
      │
      ▼
  Core writes to dina_tasks table:
    {id: ulid, type: "process", payload: {...}, status: "pending", created_at: now()}
      │
      ▼
  Core sends to brain: POST brain:8200/api/v1/process {task_id: "...", ...}
  Core updates: status = "processing", timeout_at = now() + 5 minutes
      │
      ├── Brain succeeds → ACKs: POST core:8100/v1/task/ack {task_id: "..."}
      │   Core deletes task from dina_tasks. Done.
      │
      └── Brain crashes → no ACK → timeout expires
          Core's watchdog (background goroutine) resets: status = "pending"
          Restarted brain picks up the task on next poll/push.
```

```sql
-- In identity.sqlite (shared task queue — not persona-partitioned)
CREATE TABLE dina_tasks (
    id TEXT PRIMARY KEY,              -- ULID
    type TEXT NOT NULL,               -- 'process', 'reason', 'embed'
    payload_json TEXT NOT NULL,       -- event data (item_id, source, etc.)
    status TEXT NOT NULL DEFAULT 'pending',  -- pending → processing → done
    attempts INTEGER DEFAULT 0,       -- retry count
    timeout_at INTEGER,               -- unix timestamp, NULL when pending
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_tasks_status ON dina_tasks(status, timeout_at);
```

**Dead letter:** After 3 failed attempts, task moves to `status = 'dead'`. Core injects a Tier 2 notification: "Brain failed to process an event 3 times. Check crash logs." No silent data loss.

**2. Scratchpad (Cognitive Checkpointing — in brain)**

For multi-step agentic operations (the Sancho nudge is 5 steps), brain checkpoints intermediate reasoning to the vault. On restart, brain checks "did I already start this?" and resumes from the last checkpoint.

```
Brain receives retried task from core:
      │
      ▼
  Check scratchpad: POST core:8100/v1/vault/query
    {type: "scratchpad", task_id: "..."}
      │
      ├── No scratchpad → start fresh (Step 1)
      │
      └── Scratchpad found:
          {task_id: "abc", step: 3, context: {relationship: "...", messages: [...]}}
          → Resume from Step 3 (skip 1 & 2)
```

```python
# brain/src/guardian.py — checkpoint during multi-step reasoning
async def assemble_nudge(task_id: str, event: dict):
    # Step 1: Get relationship context
    scratchpad = await core.vault_query(type="scratchpad", task_id=task_id)
    if scratchpad and scratchpad["step"] >= 1:
        relationship = scratchpad["context"]["relationship"]
    else:
        relationship = await core.vault_query(text=event["from"], type="relationship")
        await core.vault_store(type="scratchpad", task_id=task_id,
                               data={"step": 1, "context": {"relationship": relationship}})

    # Step 2: Get recent messages (skip if already checkpointed)
    if scratchpad and scratchpad["step"] >= 2:
        messages = scratchpad["context"]["messages"]
    else:
        messages = await core.vault_query(text=event["from"], type="message", limit=5)
        await core.vault_store(type="scratchpad", task_id=task_id,
                               data={"step": 2, "context": {"relationship": relationship,
                                                              "messages": messages}})

    # Steps 3-5: Continue with checkpointed context...
    # On completion: delete scratchpad
    await core.vault_store(type="scratchpad_delete", task_id=task_id)
```

Scratchpad entries are stored in identity.sqlite (Tier 4 staging tables) and auto-expire after 24 hours — stale reasoning from yesterday's crash is not useful today.

**External memory services:** If the scratchpad pattern proves insufficient for complex multi-agent reasoning, Mem0 or SuperMemory can be evaluated as a managed memory layer. For Phase 1, the vault-backed scratchpad keeps things simple.

### Observability & Self-Healing

A sovereign node must stay alive without human intervention. A process can be "running" (PID exists) while the SQLite database is locked or a goroutine is deadlocked — Docker won't restart it because the container hasn't crashed. That's a zombie, not an agent.

**Health endpoints** (on dina-core, port 8100 — internal only, never exposed to the internet):

| Endpoint | Type | What It Checks | Cost |
|----------|------|---------------|------|
| `GET /healthz` | Liveness | HTTP server is responding | Near-zero — returns `200 OK` immediately |
| `GET /readyz` | Readiness | SQLite vault is reachable and queryable | One `db.PingContext()` call with strict timeout |

If `/healthz` times out, the Go runtime is likely deadlocked. If `/readyz` fails, the vault is locked or corrupted. Either way, Docker kills and restarts the container.

**docker-compose healthcheck:**

```yaml
services:
  dina-core:
    restart: always
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8100/readyz"]
      interval: 60s        # Check every minute
      timeout: 5s          # Fail if response takes >5s
      retries: 3           # Restart after 3 consecutive failures (3 min of downtime)
      start_period: 20s    # Grace period for boot + vault unlock

  dina-brain:
    restart: always
    depends_on:
      dina-core:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8200/healthz"]
      interval: 60s
      timeout: 5s
      retries: 3
      start_period: 30s

  llama:
    restart: always
    profiles: ["local-llm"]
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 60s
      timeout: 10s         # Model loading can be slow
      retries: 3
      start_period: 60s    # Gemma 3n takes ~30-45s to load
```

**Why `wget`?** Minimal Alpine-based images include `wget` but not `curl`. Works on the smallest possible containers.

**Dependency chain:** dina-brain starts only after dina-core is healthy. This prevents the brain from crashing on startup because the vault isn't ready yet.

**Structured logging** — all containers emit JSON to stdout via Go's `slog` and Python's `structlog`:

```
{"time":"2026-02-17T10:30:00Z","level":"ERROR","msg":"vault query failed","module":"storage","error":"database is locked","persona":"consumer"}
```

- **No file logs.** Prevents storage exhaustion over years of unattended runtime.
- **Docker log rotation.** Capped via daemon.json or compose `logging` driver (max 10MB, 3 files).
- **Future-proof.** If you ever add Dozzle or Loki, structured JSON is parsed automatically — search and filtering for free.

**Logging policy — PII MUST NOT reach stdout:**

Log messages MUST NOT contain vault content, user queries, or PII. Only metadata is logged: persona name, query type, error code, item counts, latency. This policy is enforced by code review — any log statement containing user-supplied strings is rejected.

```
NEVER log:
  - Vault content (email bodies, calendar events, contact details)
  - User queries ("find emails about my divorce")
  - Brain reasoning output ("user appears to have health concerns about...")
  - NaCl message plaintext
  - Passphrase or derived keys
  - API tokens or credentials (OAuth tokens live in OpenClaw, not in Dina)

ALWAYS log:
  - Timestamps, endpoint called, persona name
  - Item counts ("returned 5 results")
  - Error codes (401, 403, 500)
  - Connector status ("gmail: sync complete, 12 new items")
  - Performance metrics ("query took 150ms")
```

```go
// BAD — PII in log output:
log.Info("processing query", "query", userQuery)

// GOOD — metadata only:
log.Info("processing query", "persona", "/social", "type", "fts5", "results", len(results))
```

**Brain crash tracebacks:** Python tracebacks include local variable values. If brain crashes mid-reasoning, the traceback could contain `query="find emails about my cancer diagnosis"`. Fix: wrap the main loop in a catch-all that logs only the exception type and line number to stdout. Full tracebacks go into identity.sqlite via core's API — never to a plain text file on disk.

```sql
-- In identity.sqlite — crash log table (encrypted at rest by SQLCipher)
CREATE TABLE crash_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    error     TEXT,    -- exception type + line number (safe for Docker logs too)
    traceback TEXT,    -- full traceback with variables (PII risk — encrypted at rest)
    task_id   TEXT     -- which task was in-flight when crash occurred
);
```

```python
# brain/src/main.py — safe crash handler
try:
    await guardian_loop()
except Exception as e:
    # Docker logs get sanitized one-liner only (no PII)
    logger.error(f"guardian crash: {type(e).__name__} at {e.__traceback__.tb_lineno}")
    # Full traceback → encrypted vault via core API (PII-safe)
    requests.post("http://core:8100/api/v1/vault/crash", json={
        "error": f"{type(e).__name__} at {e.__traceback__.tb_lineno}",
        "traceback": traceback.format_exc(),
        "task_id": current_task_id
    }, headers={"Authorization": f"Bearer {BRAIN_TOKEN}"})
    raise
```

**Why identity.sqlite, not an encrypted file:** SQLCipher already encrypts the database. A plain `crash.log` sitting on disk is not encrypted — anyone with filesystem access reads it. Writing to a table in identity.sqlite means: zero new infrastructure, queryable ("show crashes from last week"), included in backup/migration automatically, and the admin UI can display crash history. **Retention:** 90-day rolling window, same as audit logs. Watchdog cleans old entries.

**CI enforcement — banned log patterns (linting, not runtime):**

```python
# In CI pipeline — catches bad habits before merge, zero runtime cost
BANNED_LOG_PATTERNS = [
    r'log\.\w+\(.*query.*=',      # logging query content
    r'log\.\w+\(.*content.*=',    # logging message content
    r'log\.\w+\(.*body.*=',       # logging request body
    r'log\.\w+\(.*plaintext.*=',  # logging decrypted content
    r'log\.\w+\(.*f".*{.*user',   # f-string with user data
]
```

No spaCy NER on log lines — wrong layer, expensive, unreliable. PII scrubbing belongs on the data path to cloud LLMs (`/v1/pii/scrub`), not on internal log output. Don't add runtime complexity for a problem solved by writing better code.

### Eight Layers

The layers are numbered 0-7 but the diagram reads **top-down** (7 → 0), like the OSI model — Layer 7 is closest to the user, Layer 0 is the cryptographic foundation. Layer 3 (Trust Network) sits to the side because it's a shared data layer that multiple upper layers query, not a step in the linear flow.

```
┌─────────────────────────────────────────────────────────────┐
│                    HUMAN INTERFACE                           │
│  (Voice, screen, glasses, whatever hardware exists)         │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│  Layer 7: ACTION LAYER                                      │
│  Draft-don't-send, Cart Handover, Payment Intents           │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│  Layer 6: INTELLIGENCE LAYER                                │
│  PII Scrubber, LLM Routing, Context Injection, Nudge      │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│  Layer 5: BOT INTERFACE                                     │
│  Query sanitization, Bot trust checks, Response verify      │
└──────┬──────────────┬───────────────────────────────────────┘
       │              │
       ▼              ▼
┌────────────┐ ┌─────────────────────────────────────────────┐
│ External   │ │  Layer 4: DINA-TO-DINA PROTOCOL             │
│ Bots       │ │  Mesh communication, Context exchange        │
│ (Review,   │ └─────────────────────────────────────────────┘
│  Legal,    │
│  Recipe)   │
└────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: TRUST NETWORK                                     │
│  Expert attestations, Outcome data, Bot scores, Trust Rings │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Layer 2: INGESTION LAYER                                   │
│  Gmail API, Telegram Bot API, Calendar, Contacts            │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│  Layer 1: STORAGE LAYER                                     │
│  Six-tier encrypted storage (Tier 0-5)                     │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│  Layer 0: IDENTITY LAYER                                    │
│  Keys, Personas, ZKP credentials, Root identity             │
└─────────────────────────────────────────────────────────────┘
```

All eight layers run on the Home Node. Rich client devices run a subset (cached storage, local LLM, local identity keys) for offline capability and latency-sensitive operations.

---

