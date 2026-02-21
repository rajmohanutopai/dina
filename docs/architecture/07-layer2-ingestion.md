> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Layer 2: Ingestion

How Dina pulls data from the outside world into the Vault.

### Where Data Comes From

Phase 1 uses the **MCP Delegation Pattern**: Brain orchestrates, OpenClaw fetches. No connector code in Core. API-based data sources (Gmail, Calendar, Contacts) are fetched by OpenClaw on Brain's schedule. Telegram runs on the Home Node via official Bot API, delegated through MCP like other connectors.

| Source | Fetched By | Mechanism |
|--------|-----------|-----------|
| Gmail | Brain → MCP → OpenClaw | OpenClaw calls Gmail API. Hourly sync + morning routine. |
| Calendar | Brain → MCP → OpenClaw | OpenClaw calls Calendar API. Every 30 min + morning routine. |
| Contacts | Brain → MCP → OpenClaw | OpenClaw calls People API/CardDAV. Daily sync. |
| Telegram | Home Node (MCP) | Telegram Bot API — webhook or long polling |
| Web search | Brain → MCP → OpenClaw | On-demand: user asks or brain needs context |
| SMS (Phase 2+) | Phone → Core (direct) | Android Content Provider → DIDComm push |
| Photos (Phase 2+) | Phone → Core (direct) | Local photo library scan → metadata push |

### Connectors

Each data source gets a connector — a small, isolated module that knows how to pull data from one service.

```
HOME NODE
┌──────────────────────────────────────┐
│         INGESTION LAYER              │
│                                      │
│ ┌──────────┐ ┌───────┐ ┌──────────┐ │
│ │ Gmail    │ │Calend.│ │ Telegram │ │
│ │Connector │ │Connect│ │Connector │ │
│ │(MCP)     │ │(MCP)  │ │(Bot API) │ │
│ └────┬─────┘ └───┬───┘ └────┬─────┘ │
│      │           │           │       │
│      ▼           ▼           ▼       │
│ ┌────────────────────────────────┐   │
│ │  Normalizer                    │   │
│ └────────────┬───────────────────┘   │
│              ▼                       │
│ ┌────────────────────────────────┐   │
│ │  Encryptor                     │   │
│ └────────────┬───────────────────┘   │
│              ▼                       │
│        Vault (Tier 1)                │
└──────────────────────────────────────┘
```

### Attachment & Media Storage: References, Not Copies

**Never store binary blobs in SQLite.** A single user's vault goes from 50MB to 50GB if you store email attachments, and everything breaks — backups, sync, portability, encryption overhead. The "copy your vault file and go" promise dies.

```
What Dina stores (in persona databases):
  - Metadata: filename, size, MIME type, source_id, timestamp
  - Reference: URI back to source (Gmail message ID, Drive file ID)
  - Context: LLM-generated summary of the attachment content

What Dina does NOT store:
  - The actual PDF, image, spreadsheet, video
```

**Why references beat copies:** The user already has the attachment — it's in Gmail, Drive, or their local filesystem. Duplicating it means encrypting 50GB with SQLCipher (slow), backing up 50GB to S3 (expensive), syncing 50GB to client devices (impossible on mobile), and the persona databases become unmovable.

**What brain actually needs:** Brain doesn't need the raw PDF to assemble a nudge. Brain needs: "Sancho sent a contract (PDF, 2.3MB) titled 'Partnership_Agreement_v3.pdf' on Feb 15. Key terms: 60/40 revenue split, 2-year lock-in, exit clause in Section 7." That summary is a few KB, fully searchable via FTS5, embeddable via sqlite-vec.

**When the user needs the file:** Brain returns a deep link to the source — the client app opens Gmail/Drive. The file was always there.

**Dead references:** If the user deletes the email from Gmail, the reference is dead. This is acceptable. Dina is memory and context, not a backup service. The summary survives in the vault even if the source is gone.

**Exception — voice memos and Telegram voice messages:** These are small (typically under 1MB), have no stable source URI to link back to, and the transcript is the valuable part. For these: store the transcript in the vault, discard the audio. If the user wants to keep audio, it goes to a `media/` directory alongside the vault — files on disk, not inside SQLite.

```
persona databases → text, metadata, references, summaries (small, portable)
media/           → optional voice notes, images user explicitly wants to keep
                   (not inside SQLite, just files on disk, encrypted at rest)
```

### Connectors & Senses (The MCP Delegation Pattern)

**Philosophy: Senses vs. Memory.** The Go Core is a strict cryptographic storage kernel and does not contain any third-party API clients, OAuth logic, or connector code. Dina relies entirely on **Model Context Protocol (MCP)** to interact with the outside world. OpenClaw is the sensory system — it fetches email, calendar, web. Brain is the orchestrator — it schedules syncs, triages results, and stores memories in the vault via Core's API.

```
Old (connector in core):  Gmail API → core/connectors/gmail.go → vault
New (MCP delegation):     Brain → MCP → OpenClaw → Gmail API → Brain → core API → vault
```

**What you gain:**
- No OAuth flow in Go core. No Gmail/Calendar API clients. No token refresh logic. No polling scheduler.
- Core becomes a pure sovereign kernel: vault, identity, keys, gatekeeper. Zero external API calls.
- OpenClaw already has Gmail/Calendar access. No duplicate auth.
- Clean separation: OpenClaw = senses, Brain = memory + reasoning, Core = encryption + storage.

**What you accept:**
- Sync frequency is hourly (MCP round-trip), not every 5 minutes (direct API polling).
- Hard dependency on OpenClaw for memory pipeline (OpenClaw down = no new memories).
- For Phase 1 developer audience: hourly is fine. Nobody expects a v0.1 to be instant.

**The sync rhythm:**

```
MORNING ROUTINE (6:00 AM or user-configured):
  Brain → MCP → OpenClaw: "fetch emails since {gmail_cursor}"
    → OpenClaw calls Gmail API → returns structured JSON
    → Brain triages (see Ingestion Triage below)
    → Brain stores in vault: POST core:8100/v1/vault/store
    → Brain updates cursor: PUT core:8100/v1/vault/kv/gmail_cursor
  Brain → MCP → OpenClaw: "fetch calendar events for today + tomorrow"
    → Brain stores in vault
    → Brain updates cursor: PUT core:8100/v1/vault/kv/calendar_cursor
  Brain reasons over new items → generates morning briefing
  Brain → whisper: "Good morning. Here's what's new..."

HOURLY CHECK (throughout the day):
  Brain → MCP → OpenClaw: "any new emails since {gmail_cursor}?"
    → OpenClaw returns 0-5 new emails
    → Brain triages, stores, checks for urgency
    → If urgent: whisper immediately ("Sancho confirmed dinner at 7")
    → If routine: save for next briefing

ON-DEMAND (user asks):
  User: "Check my email"
  Brain → MCP → OpenClaw: "fetch emails since {gmail_cursor}"
    → Immediate sync cycle
```

**Sync state management (the cursor):** Brain is stateless — it relies on the vault for memory. To prevent duplicate ingestion, sync cursors (timestamps, `historyId`s) are stored in Core via a key-value API:

```
PUT  /v1/vault/kv/:key    → store cursor value
GET  /v1/vault/kv/:key    → read cursor value
Authorization: Bearer <BRAIN_TOKEN>

Examples:
  PUT /v1/vault/kv/gmail_cursor    {"value": "2026-02-19T10:00:00Z"}
  PUT /v1/vault/kv/calendar_cursor {"value": "2026-02-19T06:00:00Z"}
  GET /v1/vault/kv/gmail_cursor    → {"value": "2026-02-19T10:00:00Z"}
```

```sql
-- In identity.sqlite — simple key-value store for sync state
CREATE TABLE kv_store (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Phase 2 evolution:** If real-time latency (5-minute polling) becomes a strict requirement, dedicated lightweight Go polling workers can be reintroduced to bypass MCP overhead. Phase 1 strictly relies on agentic delegation.

#### Gmail (via OpenClaw MCP)
- **Fetched by:** Brain → MCP → OpenClaw (Gmail API, `readonly` scope)
- **Auth:** OpenClaw manages OAuth credentials — Dina never touches Gmail tokens
- **Sync frequency:** Morning full sync + hourly light sync (configurable)
- **What's fetched:** Headers first, then full body only for emails that pass triage (see below). Attachments: metadata only. Only messages within `DINA_HISTORY_DAYS` (default 365).
- **Dedup:** By Gmail message ID (upsert in vault)
- **Persona routing:** Emails go to whatever persona the user configures (most go to /professional or /consumer)

#### Ingestion Triage (Two-Pass Filter)

Most email is noise — even in Primary. A typical Primary inbox contains newsletters (LessWrong, Substack), recruiter spam (Crossover), product updates (Google Cloud, AWS), storage alerts (iCloud), automated notifications (GitHub, Google security), and OTP codes — mixed in with the handful of emails that actually matter. Downloading, parsing, embedding, and indexing all of it wastes bandwidth, storage, CPU, and — most importantly — dilutes signal with noise.

**The fix: two-pass triage before full download.**

Gmail API supports `format=metadata` — returns only headers (Subject, From, Date, Labels) at a fraction of the cost of `format=full`. Dina uses this to decide what's worth ingesting.

```
INGESTION TRIAGE PROTOCOL:

  1. METADATA FETCH: messages.get(format=metadata)
     → Returns: Subject, From, To, Date, Gmail Labels/Categories
     → Cost: ~200 bytes per message vs ~5-50 KB for full body

  2. PASS 1 — GMAIL CATEGORY FILTER (free, instant, no LLM):
     Gmail Categories:
       PROMOTIONS  → Skip (thin record only)
       SOCIAL      → Skip (thin record only)
       UPDATES     → Skip (thin record only)
       FORUMS      → Skip (thin record only)
       PRIMARY     → Proceed to Pass 2

     This kills ~60-70% of total email volume immediately.

  3. PASS 2 — SUBJECT+SENDER TRIAGE (within PRIMARY):
     Gmail's Primary category is not enough. A real Primary inbox
     looks like this:

       LessWrong newsletter                    → not important
       Punjab National Bank TDS certificate     → important (tax document)
       iCloud "storage is full"                 → not important
       Substack newsletter                      → not important
       Crossover recruiter spam                 → not important
       no-reply@amazonaws "AWS credits"         → not important
       GoDaddy "domains cancel in 5 days"       → important (fiduciary!)
       GitHub "identity linked to account"      → low importance
       Google "Security alert"                  → important (fiduciary!)
       Google Cloud "Product Update"            → not important

     ~80% of PRIMARY is still noise. Two sub-passes handle this:

     3a. REGEX PRE-FILTER (instant, no LLM):
         Sender patterns:
           noreply@*, no-reply@*              → Thin record
           *@notifications.*, *@marketing.*   → Thin record
           *@bounce.*, mailer-daemon@*        → Thin record
         Subject patterns:
           "[Product Update]*", "Weekly digest" → Thin record
           "OTP", "verification code"           → Thin record

     3b. LLM BATCH CLASSIFICATION (cheap, batched):
         Remaining PRIMARY emails that survive regex are batched
         and classified by subject + sender in a single LLM call.

         Batch 50 subjects per call (~500 input tokens, ~200 output):
           "Classify each email as INGEST or SKIP:
            1. From: Punjab National Bank | Subject: TDS Certificate (Form 16A)
            2. From: The Substack Post | Subject: 'If you're going to show us...'
            3. From: GoDaddy Renewals | Subject: Your domains cancel in 5 days
            ..."

         Classification categories:
           INGEST    → Real human correspondence, important documents,
                       actionable items (renewals, security alerts, tax docs)
           SKIP      → Newsletters, automated notifications, recruiter spam,
                       product updates, marketing disguised as Primary

         Cost: ~50 emails classified per LLM call.
           Cloud LLM profile:  Gemini Flash Lite — ~700 tokens = $0.00007 per batch.
                         Classifying 2,000 emails/year = 40 batches = $0.003/year.
           Local LLM profile: Gemma 3n via llama:8080 — ~0.5 seconds per batch.

  4. FULL DOWNLOAD: Only PRIMARY emails classified as INGEST
     get messages.get(format=full).
     → These are vectorized, FTS-indexed, and stored in Tier 1.

  5. THIN RECORDS: All skipped emails (Pass 1, Pass 2 regex,
     Pass 2 LLM) still get a minimal record:
     {source_id, subject, sender, timestamp, category: "skipped", skip_reason}
     → Searchable by subject/sender via FTS5
     → If user later asks about a skipped email, Dina can fetch
       the full body on demand from Gmail API (pass-through retrieval)
     → NOT embedded (no vector cost)
     → Takes ~0.1% of the storage of a full record
```

**Why two passes, not just LLM:**
- Pass 1 (Gmail categories) is free and instant — kills 60-70% of volume before any processing.
- Pass 2 regex is free and instant — catches obvious automated senders within Primary.
- Pass 2 LLM only runs on the ~30% that survives both filters. Batched, it costs essentially nothing.
- The LLM sees only subject + sender (never the body at this stage) — no privacy concern, minimal tokens.

**Why this matters (real numbers):**

| Metric | Full Ingestion | With Triage |
|--------|---------------|-------------|
| Emails in inbox (1 year) | 5,000 | 5,000 |
| After Pass 1 (Gmail categories) | 5,000 | ~1,500 (Primary only) |
| After Pass 2 (regex + LLM) | 5,000 | ~300-500 |
| Full bodies downloaded | 5,000 | ~300-500 |
| API bandwidth | ~100-250 MB | ~10-20 MB |
| Embeddings generated | 5,000 | ~300-500 |
| Vector index size | 100% | ~8-10% |
| Ingestion time | 100% | ~15% |
| LLM triage cost (Cloud LLM profile) | $0 | ~$0.003/year |
| Signal-to-noise | Very low | High (real correspondence + actionable items) |

**User override:** The triage categories are configurable. If a user wants to index their newsletters (e.g., they subscribe to high-quality technical newsletters), they can add sender exceptions: `"always_ingest": ["newsletter@stratechery.com", "*@substack.com"]`. If they want everything, `DINA_TRIAGE=off` disables filtering entirely.

**Fiduciary override:** Even during triage, certain patterns always trigger full ingestion regardless of category — security alerts, financial documents, domain/account expiration warnings. These align with Tier 1 (Fiduciary) classification: silence would cause harm. The triage LLM is specifically instructed to never skip anything that looks actionable or time-sensitive.

#### OpenClaw Health Monitoring

Brain monitors OpenClaw availability on every sync cycle. If OpenClaw is unreachable:

```
HEALTHY ─(MCP call fails)──────────► DEGRADED   + Tier 2 notification
DEGRADED ─(3 consecutive failures)─► OFFLINE    + Tier 2 notification: "OpenClaw is down. No new memories."
OFFLINE ─(MCP call succeeds)───────► HEALTHY    (resume sync, fetch since last cursor)
```

**Rules:**
1. **Never lose data.** Cursors are preserved in vault. When OpenClaw recovers, brain resumes from the exact point it left off — no gap, no duplicates.
2. **Tier 2 notification on degradation.** Missing emails is an inconvenience, not a harm. Not Tier 1 (fiduciary).
3. **User can see sync status.** Last successful sync, current state, reason for current state — all visible in admin UI.

### Telegram Connector
- **Method:** Telegram Bot API (official, server-side)
- **How:** User creates a Telegram bot via @BotFather, configures the bot token in Dina. Home Node runs the connector which receives messages via webhook or long polling. Full message content, media, group context, reply chains.
- **Cross-platform:** Works on Android, iOS, web, and desktop — no device-specific code needed.
- **Persona routing:** Messages default to `/social` persona. User can configure per-chat or per-group routing.

### Calendar (via OpenClaw MCP)

**Time is a Sense, not a Tool.** Calendar data is ingested into the vault like email — a read-only cache of the external calendar, rolling window (-1 month / +1 year). When an email says "Can we meet at 4 PM?", brain queries the local vault (microseconds), not OpenClaw (seconds).

The read/write split:

| Direction | What | How |
|-----------|------|-----|
| **Read (Context)** | "Am I free at 4?" | Brain queries local vault — zero latency, zero network |
| **Write (Simple)** | "Book 2 PM Tuesday" | Brain → MCP → OpenClaw → Calendar API |
| **Write (Complex)** | "Find a slot for 5 people across 3 timezones" | Brain → MCP → OpenClaw — that's a *task*, not context |

- **Fetched by:** Brain → MCP → OpenClaw (Google Calendar API, `readonly` scope)
- **Sync frequency:** Morning full sync + every 30 minutes
- **What's fetched:** Events, attendees, locations, descriptions
- **Phase 2:** CalDAV for non-Google users (Nextcloud, Apple Calendar). Deferred because CalDAV implementations are mutually incompatible across providers.

### Contacts (via OpenClaw MCP)
- **Fetched by:** Brain → MCP → OpenClaw (Google People API or CardDAV)
- **Sync frequency:** Daily (contacts change infrequently)
- **What's fetched:** Names, phone numbers, emails, notes, relationships

### Future Senses (Phase 2+ — only after major traction)
- **Direct Go polling connectors:** Reintroduce lightweight Go polling workers in core for 5-minute latency if hourly MCP sync proves insufficient. OAuth flow in core at that point.
- **SMS:** Phone (Android Content Provider, read-only) — pushes to Home Node
- **Photos:** Phone (local photo library scan: EXIF data, face detection for relationship mapping) — metadata pushed to Home Node
- **Browser history:** Extension or local database read — pushes to Home Node
- **Bank statements:** Home Node (PDF parsing or Open Banking APIs — India: Account Aggregator framework)
- **Location:** Phone (background location for context "You're near Sancho's office") — pushed to Home Node

### Memory Strategy: The Living Window

Dina acknowledges that user identity evolves. Syncing 10 years of email history doesn't make Dina smarter — it makes her confused. If you were a Java developer in 2018 and a Rust developer now, 5,000 old Java emails pollute her understanding of who you are today. This is **Identity Drift**: outdated data degrades current performance.

**The goal is usefulness, not completeness.**

#### Two Zones

| | **Zone 1: The Living Self** | **Zone 2: The Archive** |
|--|---|---|
| **Timeframe** | Last 1 year (configurable via `DINA_HISTORY_DAYS`, default 365) | Older than 1 year |
| **Storage** | Vault (Tier 1) — vectorized, FTS-indexed, hot | Provider API (Gmail, etc.) — cold, not downloaded |
| **Status** | Indexed and embedded | Ignored (on-demand only) |
| **Access** | Proactive — Dina "thinks" with this data | Reactive — Dina searches only if user explicitly asks |
| **Logic** | "This is who you *are*." | "This is who you *were*." |

#### Startup Sync: Ready in Seconds, Not Hours

The mistake: syncing all history on first connect, blocking the main thread for hours. The fix: **sync recent data first, backfill later.**

```
STARTUP SYNC PROTOCOL (Brain orchestrates via MCP):

  1. FAST SYNC (blocking): Brain → MCP → OpenClaw: "fetch last 30 days of email"
     └─► OpenClaw returns structured JSON
     └─► Brain triages (see Ingestion Triage) → stores in vault
     └─► Takes seconds. Sync status → ACTIVE. Agent is "Ready."
         User can ask questions immediately.

  2. BACKFILL ("The Historian"): Brain fetches remaining data via MCP
     up to DINA_HISTORY_DAYS (default: 365 days).
     └─► OpenClaw returns batches → Brain triages → stores PRIMARY only.
     └─► Skipped emails stored as thin records (subject + sender only).
     └─► Processes in batches of 100 (see batch ingestion protocol).
     └─► Pauses when user issues a query (user queries always take priority).
     └─► Resumes when idle.
     └─► Progress visible: "Gmail sync: 2,400 / 8,000 emails (30%)"

  3. STOP: Historian stops at the time horizon. Data older than
     DINA_HISTORY_DAYS is NEVER downloaded.
```

**Why 30 days for fast sync:** Most user questions ("What did Sancho say last week?", "Where is my meeting tomorrow?") reference the last few weeks. 30 days gives Dina enough context to be immediately useful. The remaining 11 months backfill in the background.

**Why 365 days as the default horizon:** One year captures seasonal patterns (annual reviews, tax season, holiday plans) without drowning in irrelevant history. Configurable — privacy maximalists can set `DINA_HISTORY_DAYS=90`, archivists can set it to `730`.

#### Cold Archive: Pass-Through Search

When the user asks for data older than the horizon ("Find that invoice from the contractor in 2022"), Dina doesn't have it locally. Instead:

```
PASS-THROUGH SEARCH PROTOCOL:

  1. User query: "Find that invoice from the contractor"
  2. Step 1 (Hot Memory): Search local vault (last 365 days)
     └─► Found? Show it. Done.
  3. Step 2 (Cold Fallback): Not found, or query explicitly mentions old date.
     └─► Brain → MCP → OpenClaw: "search Gmail for 'invoice contractor before:2025/02/18'"
     └─► OpenClaw fetches matching emails from Gmail API (read-only)
     └─► Show results to user
     └─► Do NOT save to vault. This data stays cold.
```

**Privacy note:** Pass-through search queries traverse the provider's API (e.g., Gmail Search), exposing search metadata to the provider. This is an inherent trade-off: Dina cannot search what she hasn't downloaded, and she doesn't download data outside the time horizon. The user is informed: *"Searching Gmail directly for older emails. Your search query is visible to Google."*

**Why not save cold results to vault:** Saving them would silently expand the time horizon and introduce Identity Drift. The user asked for a specific old document — that's a point lookup, not a signal that old data is relevant to current identity.

#### Performance Impact

| Metric | Sync Everything (10 years) | Living Window (1 year) | Living Window + Triage |
|--------|---------------------------|------------------------|------------------------|
| Emails in scope | 50,000+ | ~5,000 | ~5,000 (but only ~400 fully ingested) |
| Full bodies downloaded | 50,000+ | ~5,000 | ~300-500 |
| Initial sync | Hours | Minutes | Minutes (~400 full + 4,500 thin records) |
| "Ready" state | After full sync completes | After 30 seconds | After 30 seconds |
| Vault size | ~2-5 GB | ~200-500 MB | ~30-80 MB |
| Embeddings generated | 50,000+ | ~5,000 | ~300-500 |
| Vector search latency | Slow (massive index) | Moderate | Fast (small, high-signal index) |
| RAM (embeddings) | Very heavy | Moderate | Minimal |
| Signal-to-noise | Very low (90%+ noise) | Low-moderate (70%+ noise in Primary) | High (noise filtered at source) |

### Ingestion Security Rules
1. **Core never calls external APIs.** All fetching goes through Brain → MCP → OpenClaw. Core is a pure storage kernel.
2. **Data is encrypted immediately upon storage.** Brain calls `POST /v1/vault/store` → Core writes to the SQLCipher-encrypted persona database. No plaintext staging.
3. **OpenClaw is sandboxed.** OpenClaw has no access to the vault, keys, or personas. It receives task requests ("fetch emails") and returns structured JSON. A compromised OpenClaw cannot read existing memories.
4. **Brain scrubs before storing.** Data from OpenClaw passes through PII scrubbing (Tier 1 regex + Tier 2 spaCy) before brain sends summaries to cloud LLMs for reasoning.
5. **User can see sync status.** Last successful sync, items ingested, current state — all visible in admin UI.
6. **Phone-based connectors (SMS, Photos) authenticate to Home Node with CLIENT_TOKEN** before pushing data. These bypass MCP — phone pushes directly to Core via authenticated WebSocket. Telegram runs server-side on the Home Node via MCP.
7. **OAuth tokens live in OpenClaw, not in Dina.** Dina never touches Gmail/Calendar credentials. If OpenClaw is compromised, revoke its tokens — Dina's vault and identity are unaffected.

---

