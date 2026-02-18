# Part III: Technical Architecture

This is the engineering blueprint for Dina. It covers every layer, every connection, every hard problem. Where choices are clear, they're stated. Where they're open, they're flagged.

---

## System Overview

Dina has eight layers. Each is independent and can be built, tested, and replaced separately.

### Deployment Model: Home Node + Client Devices

**Dina is not an app on your phone. Dina is a service that runs on infrastructure you control.**

An agent that goes offline when your phone battery dies isn't an agent — it's an app. Dina needs to be always-available: other Dinas need to reach it, connectors need to pull data at 3am, glasses and watches need a brain to talk to.

Dina runs on a **Home Node** — a small, always-on server. Your phone, laptop, glasses, and watch are **client devices** that connect to it. Think of it like email: your mail server is always running, and your phone is just a window into it.

```
┌──────────────────────────────────────────────────────┐
│                  DINA HOME NODE                       │
│      (VPS / Raspberry Pi / NAS / home server)        │
│                                                       │
│  ┌──────────────┐  ┌──────────────────────────────┐  │
│  │ Encrypted    │  │ Go Core (dina-core)           │  │
│  │ Vault        │  │ - Connector scheduler         │  │
│  │ (SQLite +    │  │ - PII scrubber                │  │
│  │  FTS5 +      │  │ - DIDComm endpoint            │  │
│  │  sqlite-vec) │  │ - WebSocket server            │  │
│  └──────────────┘  │ - Key management              │  │
│                     └──────────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────────────────────┐  │
│  │ Local LLM    │  │ Python Brain (dina-brain)     │  │
│  │ (llama.cpp   │  │ - Guardian angel loop (ADK)   │  │
│  │  + Gemma 3n) │  │ - Silence classification      │  │
│  └──────────────┘  │ - Whisper assembly             │  │
│                     │ - Agent orchestration          │  │
│                     └──────────────────────────────┘  │
└──────────┬──────────────┬──────────────┬─────────────┘
           │              │              │
     ┌─────┴────┐   ┌────┴─────┐  ┌─────┴──────┐
     │ Phone    │   │ Laptop   │  │ Glasses /  │
     │ (rich    │   │ (rich    │  │ Watch /    │
     │  client, │   │  client, │  │ Browser    │
     │  local   │   │  local   │  │ (thin      │
     │  cache,  │   │  cache,  │  │  client)   │
     │  on-device│  │  on-device│ │            │
     │  LLM)   │   │  LLM)    │  │            │
     └─────────┘   └──────────┘  └────────────┘
```

**Client devices:**

| Mode | Examples | Capabilities |
|------|----------|-------------|
| **Rich client** | Phone, Laptop | Local vault cache, on-device LLM, works offline (limited), syncs when connected |
| **Thin client** | Glasses, Watch, Browser, Car display | Authenticated WebSocket to Home Node only, no local storage |

**Privacy model:** All vault data encrypted at rest with user's keys. Home Node decrypts in-memory only during processing, then discards plaintext. Binary is open source and auditable. Hosting provider sees only encrypted blobs. Long-term: Confidential Computing (AMD SEV-SNP / Intel TDX / AWS Nitro Enclaves) makes even RAM inspection impossible.

### Hosting Levels

Same containers, same SQLite vault, same Docker image at every level. Migration between levels = copy one file.

| Level | Host | Trust Model |
|-------|------|------------|
| **Managed (default)** | Foundation or certified hosting partner | Operator trust + open-source audits + Confidential Computing (Phase 2+) |
| **Self-hosted VPS** | User's own VPS (Hetzner, Oracle free tier, DigitalOcean) | User's operational security. Single-user server = not a honeypot. |
| **Sovereign box** | Raspberry Pi / NAS / home server | Physical control. Attack surface is one machine, one user. |

**The honeypot problem:** For Dina to be a 24/7 agent, the Home Node must decrypt and process the vault. During processing, keys exist in RAM. On a managed multi-user server, a root attacker could theoretically extract keys. Mitigation: per-user SQLite isolation (no shared database), open-source audits, and Confidential Computing enclaves (Phase 2+) where hardware enforces memory encryption — even root cannot read enclave memory.

### The Unattended Reboot Problem

Dina promises two things that conflict: "always on" and "encrypted at rest with your keys."

If the Home Node reboots at 2 AM (kernel panic, power outage, OS patch), Dina cannot restart — the Master Key (DEK) that SQLCipher needs to open the vault files is gone from RAM. She sits at a locked prompt until the user wakes up at 8 AM. Six hours of missed monitoring.

**This is a user choice, presented during setup:**

| Mode | What's on Disk | Boot Process | Risk | Best For |
|------|---------------|-------------|------|----------|
| **Security** | `keys/master.key.enc` (Master Key wrapped by passphrase-derived KEK) | App prompts for passphrase → Argon2id → KEK → unwrap DEK → `PRAGMA key` → SQLCipher opens | Downtime after every reboot until user intervenes | Self-hosted, sovereign box, privacy maximalists |
| **Convenience** | `keys/master.key` (raw 32-byte Master Key, `chmod 600`) | App reads DEK from file → `PRAGMA key` → SQLCipher opens automatically | Physical theft or root compromise exposes the key. Mitigated by Confidential Computing on managed hosting. | Managed hosting, anyone who prioritizes uptime |

**The exact boot sequence (both modes):**
```
1. dina-core starts
2. Read config.json → determine mode (security or convenience)
3. Obtain Master Key (DEK):
     Security mode:  prompt client device → receive passphrase
                     → Argon2id(passphrase, salt) → KEK
                     → AES-256-GCM unwrap master.key.enc → DEK
     Convenience:    read master.key from disk → DEK
4. Derive per-persona SQLCipher keys:
     DEK → SLIP-0010 → persona keys → HKDF → SQLCipher passphrases
5. Open each persona vault:
     PRAGMA key = 'x<hex-encoded-passphrase>'
     PRAGMA cipher_page_size = 4096
     PRAGMA journal_mode = WAL
6. SQLCipher decrypts pages in-memory on demand
   — the .sqlite files on disk are NEVER decrypted to a temp file
7. Notify brain: POST brain:8200/v1/process {event: "vault_unlocked"}
```

**Implementation:** The setup wizard asks: "If your Home Node restarts, should Dina unlock automatically or wait for you?" The choice is stored in `config.json` (not in the vault — the vault is what needs unlocking). Users can change this setting at any time. On managed hosting, the default is Convenience. On self-hosted, the default is Security.

**No obfuscation.** The codebase is open source — "hiding" the key on disk via obfuscation provides zero real security. In Convenience mode, the key is stored plainly and the security boundary is the server's access controls (filesystem permissions, Confidential Computing enclave, hosting provider trust). This is honest engineering, not security theater.

### Why Not Serverless?

Serverless (Lambda + S3) doesn't work for Dina. SQLite on network storage corrupts under concurrent access. Cold starts take 30-60 seconds to load a 2GB LLM. Lambda can't maintain persistent WebSocket or DIDComm connections. Continuous polling (Gmail, Calendar, Dina-to-Dina messages) costs more on Lambda than an always-on container.

The right architecture is three lightweight, always-on containers via `docker compose up -d`.

### Connectivity & Ingress (Multi-Lane Networking)

dina-core **never binds to port 443 directly.** It listens on localhost only:
- Port 8100 — internal API (brain ↔ core)
- Port 8443 — DIDComm endpoint + client WebSockets (localhost, not exposed to internet)

The public ingress is always a layer in front — a tunnel, a reverse proxy, or a mesh network. This solves NAT traversal, port conflicts, TLS termination, and DDoS protection in one architectural decision.

**Three ingress tiers, running simultaneously if needed:**

| Tier | Name | Mechanism | Who It's For | Public Endpoint |
|------|------|-----------|-------------|-----------------|
| **1: Community** | Zero-config | Tailscale Funnel (or Zrok) | Testing, non-technical users, onboarding | `https://node.tailnet.ts.net` (auto-TLS) |
| **2: Production** | Tunneled | Cloudflare Tunnel (`cloudflared`) | Daily drivers, anyone who wants DDoS protection | `https://dina.alice.com` (custom domain, WAF, geo-blocking) |
| **3: Sovereign** | Mesh | Yggdrasil | Censorship resistance, no central authority | Stable IPv6 derived from node's public key |

**Why not Tor for Tier 3?** Dina has a DID — she's not trying to be anonymous, she's trying to be sovereign. DIDComm already provides E2E encryption, making Tor's encryption layer redundant. Tor's 3-second round trip kills whispers and real-time interactions. Yggdrasil provides censorship resistance with low latency and NAT traversal, and its key-derived IPv6 addresses are philosophically aligned with DIDs. Users who need anonymity (hiding that they run a Dina) can route Yggdrasil over Tor — that's an ops choice, not an architecture tier.

**How it connects to DIDComm:** The DID Document (resolved via `did:plc` or `did:web`) points to whatever public endpoint the tunnel exposes. DIDComm doesn't care whether that's a Tailscale URL, a Cloudflare domain, or a Yggdrasil IPv6. When the user changes ingress tier, they sign a `did:plc` rotation operation to update their service endpoint.

**Future: Wildcard Relay.** The Dina Foundation will operate a relay (`*.dina.host` via `frp`) to provide free, secure subdomains to Community tier users — replacing the Tailscale Funnel dependency. Not a Phase 1 dependency.

See [`NETWORKING.md`](NETWORKING.md) for setup instructions per tier, or [`QUICKSTART.md`](QUICKSTART.md) to get running in 3 commands.

### One User, One File (Tenancy Model)

Dina NEVER uses a shared database. Every user gets their own SQLite file.

```
/var/lib/dina/
├── users/
│   ├── did_user_A/
│   │   ├── identity.sqlite      ← Tier 0: root keys, persona keys (SQLCipher)
│   │   ├── consumer.sqlite      ← Consumer persona vault (SQLCipher, own key)
│   │   ├── social.sqlite        ← Social persona vault (SQLCipher, own key)
│   │   ├── health.sqlite        ← Health persona vault (SQLCipher, own key)
│   │   ├── staging.sqlite       ← Tier 4: drafts, payment intents (SQLCipher)
│   │   ├── reputation.sqlite    ← Tier 3: bot scores, outcome data (SQLCipher)
│   │   └── config.json
│   ├── did_user_B/
│   │   ├── identity.sqlite
│   │   ├── consumer.sqlite
│   │   └── ...
│   └── ...
└── system.db               ← Tiny: routing, auth, billing only
```

**Why this matters:**
- **Isolation.** User A's process has no file handle to User B's vault. OS enforces privacy, not just code. Within a user, each persona file is independently encrypted — compromise of `consumer.sqlite` reveals nothing about `health.sqlite`.
- **Portability.** User leaves → send them their directory of `.sqlite` files. Done. 100% of history, instantly.
- **Right to delete.** `rm user_b/`. Data physically annihilated. Or finer: `rm user_b/health.sqlite` to delete only medical data.
- **Breach containment.** Compromise of one user's vault does not expose others. Compromise of one persona file does not expose other personas. No shared secret, no master key.

### The Sidecar Pattern: Go Core + Python Brain

The Home Node is split into two services that communicate over a local HTTP API:

- **dina-core (Go + net/http):** The sovereignty layer. Holds the encrypted vault, manages keys, runs the DIDComm endpoint, serves client WebSockets, schedules connector polling, and enforces PII scrubbing. This is the part that must never fail, must never leak data, and must run for years without maintenance. Go is the right language for this — fast compilation, simple deployment (single static binary), excellent standard library for crypto (Ed25519, AES-256-GCM, X25519 all built-in), and strong concurrency primitives for managing connectors and WebSockets.

- **dina-brain (Python + Google ADK):** The intelligence layer. Runs the guardian angel reasoning loop — silence classification, disconnect detection, whisper assembly, agent orchestration. This is where LLM tool-calling, multi-step reasoning, and multi-agent coordination happen. Python is the right language for this because the AI/ML ecosystem (Google ADK, llama-cpp-python, embedding models) is Python-first.

A third container runs the local LLM:

- **llama-server (llama.cpp):** Serves Gemma 3n via an OpenAI-compatible API on localhost. Both core (for PII scrubbing) and brain (for classification) call it. Cloud LLM APIs (Claude, Gemini) are the escalation path for complex reasoning.

```
docker-compose.yml:
┌─────────────────────────────────────────────────────┐
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │  dina-core (Go + net/http)                    │    │
│  │  Port 8100 (internal)                         │    │
│  │  Port 8443 (DIDComm + clients, localhost only)  │    │
│  │                                                │    │
│  │  - SQLite vault + encryption                   │    │
│  │  - DID / key operations                        │    │
│  │  - DIDComm endpoint (external)                 │    │
│  │  - WebSocket server (client devices)           │    │
│  │  - PII scrubber (regex hot path)               │    │
│  │  - Connector scheduler (triggers brain)        │    │
│  │                                                │    │
│  │  Exposes to brain:                             │    │
│  │    POST /v1/vault/query                        │    │
│  │    POST /v1/vault/store                        │    │
│  │    POST /v1/did/sign                           │    │
│  │    POST /v1/did/verify                         │    │
│  │    POST /v1/pii/scrub                          │    │
│  │    POST /v1/notify (push to client)            │    │
│  └──────────────────┬───────────────────────────┘    │
│                      │ localhost:8100                   │
│  ┌──────────────────▼───────────────────────────┐    │
│  │  dina-brain (Python + Google ADK)             │    │
│  │  Port 8200 (internal)                         │    │
│  │                                                │    │
│  │  - Guardian angel reasoning loop               │    │
│  │  - Silence filter / interrupt classification   │    │
│  │  - Context assembly for whispers               │    │
│  │  - Disconnect detection                        │    │
│  │  - Agent orchestration (e.g. delegate to       │    │
│  │    OpenClaw via MCP)                           │    │
│  │                                                │    │
│  │  LLM routing:                                  │    │
│  │    Simple → llama-server (localhost:8300)       │    │
│  │    Complex → Claude/Gemini API                 │    │
│  │                                                │    │
│  │  Exposes to core:                              │    │
│  │    POST /v1/process (new data to analyze)      │    │
│  │    POST /v1/reason (complex decision needed)   │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │  llama-server (llama.cpp)                     │    │
│  │  Port 8300 (internal)                         │    │
│  │  Gemma 3n E2B model, OpenAI-compatible API    │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
└─────────────────────────────────────────────────────┘
```

**Why the sidecar pattern, not a single binary:**

- **Best tools for each job.** Go has excellent crypto/DID libraries (standard library `crypto/*`, libsodium via `GoKillers/libsodium-go`, AT Protocol via `bluesky-social/indigo`). Python has the best agent/AI frameworks. Running them side-by-side is the industry standard.
- **Independent development and testing.** `python3 brain.py` works on its own. `go run ./cmd/core` works on its own. You iterate on agent logic at Python speed without recompiling Go.
- **Crash isolation.** If the Python brain OOMs or crashes, the Go core catches it and restarts it. The vault, keys, and messaging endpoint never go down.
- **Swappable brain.** Switch from Google ADK to Claude Agent SDK, or from Python to Go (Google ADK now supports Go). The core's internal API doesn't change.
- **Future consolidation path.** Google ADK already supports Go. As Go's AI ecosystem matures, the brain could be rewritten in Go, collapsing the sidecar into a single binary. The internal API makes this a clean migration.
- **Docker-native.** In production (managed hosting), these are containers orchestrated by docker-compose or Fly.io. In development, they're just two terminal windows.

**Why Google ADK for the brain:**

- Apache 2.0 license (aligns with Dina's MIT license)
- Model-agnostic: routes to local Gemma (via llama-server), Claude, Gemini, or any OpenAI-compatible endpoint
- Native multi-agent orchestration: Sequential, Parallel, and Loop agents for complex reasoning
- MCP support: exposes Dina's vault, connectors, and reputation data as MCP tools, and connects to external agents (OpenClaw) via MCP
- Mature ecosystem: v1.25+, large community, Google-backed

**The internal API between core and brain is the protocol surface.** If a future community member wants to build a Rust brain, a TypeScript brain, or consolidate into a single Go binary, they implement the same `/v1/process` and `/v1/reason` endpoints. The core doesn't care what language the brain speaks.

### Data Flow: Who Touches What

The core principle: **Go owns the file. Python owns the thinking.**

```
WHO TOUCHES SQLITE?

  dina-core (Go)     ← ONLY process that opens vault .sqlite files
  dina-brain (Python) ← NEVER touches SQLite. Talks to core via HTTP API.
  llama-server        ← Stateless. No database access.
```

#### Writing

**1. Ingestion (core writes directly)**
```
Gmail API → core/connectors/gmail.go → normalize → core writes to consumer.sqlite
Calendar  → core/connectors/calendar.go → same
Contacts  → core/connectors/contacts.go → same
WhatsApp  → phone pushes to core via DIDComm → core writes to social.sqlite

Core then notifies brain:
  POST brain:8200/v1/process {item_id, source, type}
```

**2. Brain-generated data (brain asks core to write)**
```
Brain generates a draft     → POST core:8100/v1/vault/store {type: "draft", ...}
Brain creates staging item  → POST core:8100/v1/vault/store {type: "payment_intent", ...}
Brain extracts relationship → POST core:8100/v1/vault/store {type: "relationship", ...}
```

**3. Embeddings (brain generates, core stores)**
```
New email ingested by core
  → core notifies brain: POST brain:8200/v1/process
  → brain calls llama-server:8300 to generate embedding (EmbeddingGemma)
  → brain sends embedding back to core: POST core:8100/v1/vault/store
      {type: "embedding", vector: [...], source_id: "..."}
  → core writes vector into sqlite-vec
```

Brain generates the embedding because it already has the LLM routing logic and knows which model to use. Core just stores the vector — it doesn't need to understand embeddings, just execute the sqlite-vec INSERT.

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
  → brain generates query embedding via llama-server:8300
  → brain asks core for vector search:
      POST core:8100/v1/vault/query {vector: [...], top_k: 10}
  → core runs sqlite-vec nearest-neighbor search → returns results to brain
  → brain also asks core for FTS5 results:
      POST core:8100/v1/vault/query {text: "Sancho deal"}
  → brain merges both result sets (hybrid search)
  → brain reasons over combined context via LLM
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
    Step 4: brain → llama-server: "Given this context, assemble a whisper"
            → generates: "Sancho is 15 min away. Mother was ill. Likes strong chai."
    Step 5: brain → core: POST /v1/notify {type: "whisper", text: "...", client: "phone"}
            → core pushes to phone via WebSocket
```

#### Ownership Summary

```
┌─────────────────────────────────────────────────────────┐
│  dina-core (Go) — THE VAULT KEEPER                      │
│                                                         │
│  OWNS:                                                  │
│  - Per-persona .sqlite files (open, read, write, backup)│
│  - SQLCipher encryption/decryption                      │
│  - FTS5 queries                                         │
│  - sqlite-vec queries (given a vector, find neighbors)  │
│  - Connectors (ingest external data)                    │
│  - WebSocket to clients                                 │
│  - DIDComm endpoint                                     │
│                                                         │
│  DOES NOT:                                              │
│  - Generate embeddings                                  │
│  - Decide what to search for                            │
│  - Reason over results                                  │
│  - Classify urgency                                     │
│  - Assemble whispers                                    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  dina-brain (Python + ADK) — THE ANALYST                │
│                                                         │
│  OWNS:                                                  │
│  - Search strategy (what to query, in what order)       │
│  - Embedding generation (calls llama-server)            │
│  - LLM reasoning (calls llama-server or cloud)          │
│  - Silence classification (Tier 1/2/3)                  │
│  - Whisper assembly                                     │
│  - Agent orchestration (multi-step, ADK agents)         │
│  - MCP delegation (OpenClaw)                            │
│                                                         │
│  DOES NOT:                                              │
│  - Open SQLite files                                    │
│  - Manage encryption keys                               │
│  - Talk to clients directly                             │
│  - Handle DIDComm                                       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  llama-server (llama.cpp) — THE HIRED CALCULATOR        │
│                                                         │
│  OWNS:                                                  │
│  - Model inference (Gemma 3n, FunctionGemma, embeddings)│
│                                                         │
│  Called by BOTH core and brain:                          │
│  - Core calls it for: PII scrubbing (regex misses)      │
│  - Brain calls it for: everything else                  │
│                                                         │
│  Stateless. No database. No business logic.             │
└─────────────────────────────────────────────────────────┘
```

The analogy: **core is the vault keeper** (stores, retrieves, encrypts, never interprets). **Brain is the analyst** (thinks, searches strategically, reasons, never holds keys). **llama-server is the hired calculator** (computes what it's asked, remembers nothing).

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

  llama-server:
    restart: always
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8300/health"]
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

### Eight Layers

The layers are numbered 0-7 but the diagram reads **top-down** (7 → 0), like the OSI model — Layer 7 is closest to the user, Layer 0 is the cryptographic foundation. Layer 3 (Reputation Graph) sits to the side because it's a shared data layer that multiple upper layers query, not a step in the linear flow.

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
│  PII Scrubber, LLM Routing, Context Injection, Whisper      │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│  Layer 5: BOT INTERFACE                                     │
│  Query sanitization, Bot reputation checks, Response verify │
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
│  Layer 3: REPUTATION GRAPH                                  │
│  Expert attestations, Outcome data, Bot scores, Trust Rings │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Layer 2: INGESTION LAYER                                   │
│  Gmail API, WhatsApp Notifications, Calendar, Contacts      │
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

## Layer 0: Identity

### Root Identity

Every Dina has exactly one root identity — a cryptographic keypair generated during initial setup, stored encrypted on the Home Node, never transmitted in plaintext.

```
Root Identity
├── Root keypair (Ed25519)
├── Created: timestamp
├── Device origin: device fingerprint
└── Recovery: BIP-39 mnemonic (24 words, written on paper)
```

**Key generation:** Happens locally using device entropy (Secure Enclave on iOS, StrongBox on Android, TPM on desktop). The private key never leaves the hardware security module.

**Recovery:** BIP-39 standard mnemonic phrase. 24 words. User writes them down on paper. This is the only backup of the root identity. If you lose both the device and the paper, the identity is gone. This is by design — there is no "password reset" because there is no server that knows your password.

**Technology choice: W3C Decentralized Identifiers (DIDs).** Specifically `did:plc` — Bluesky's DID method, proven at scale (30M+ identities). `did:plc` stores a signed operation log in a public directory (the PLC Directory), giving every Dina a globally resolvable, key-rotatable identity with no blockchain dependency. Other Dinas find yours by resolving your DID against the PLC Directory, which returns only your DID Document (public key + service endpoint) — never your name, location, or personal data.

**Why `did:plc`:**
- **Key rotation.** If a key is compromised, the user signs a rotation operation with the old key. The PLC Directory updates the DID Document. No identity loss, no new DID needed.
- **Account recovery.** Recovery keys (stored offline, separate from signing keys) can reclaim a DID even if the primary key is lost. Aligns with BIP-39 recovery philosophy.
- **Go implementation exists.** Bluesky's `indigo` repository provides a production Go implementation of `did:plc` resolution and operations.
- **Proven at scale.** 30M+ identities. The method works.
- **Escape hatch via rotation op.** If Bluesky's PLC Directory ever becomes hostile, a rotation operation can redirect the DID to a `did:web` endpoint the user controls: "I am leaving `did:plc`. My new identity lives at `did:web:dina.alice.com`." The rotation is signed by the user's key — no permission needed from anyone.

**Fallback: `did:web` as escape hatch.** If the PLC Directory becomes unavailable or adversarial, Dina supports `did:web` as a sovereignty escape. A `did:web` identifier resolves to a DID Document hosted at a well-known HTTPS path on the user's domain (e.g., `did:web:dina.alice.com` → `https://dina.alice.com/.well-known/did.json`). It piggybacks on the same Cloudflare/Tailscale ingress the Home Node already has. The tradeoff: `did:web` depends on DNS and a web server, so it's not fully decentralized. Both methods use the same Ed25519 keypair and DID Document format — the rotation op handles the transition transparently.

```
did:plc:z72i7hdynmk6r22z27h6tvur
```

This DID resolves to a DID Document — a small public record containing the public key and service endpoint:

```json
{
    "id": "did:plc:z72i7hdynmk6...",
    "service": [
        {
            "type": "DinaMessaging",
            "serviceEndpoint": "https://dina.alice.com/didcomm"
        }
    ],
    "verificationMethod": [{ "type": "Multikey", "publicKeyMultibase": "z6Mk..." }]
}
```

The endpoint points to the user's Home Node (via tunnel). The PLC Directory only stores the signed operation log — it never holds keys, never reads messages, and can be exited via rotation op at any time.

### Personas (Compartments)

Each persona is a derived keypair from the root, using hierarchical deterministic derivation.

### Key Derivation

Two separate derivation schemes serve two different purposes:

| Component | Purpose | Algorithm | Why |
|-----------|---------|-----------|-----|
| **Master Seed (DEK)** | The Root | BIP-39 mnemonic (24 words, 256-bit entropy) → PBKDF2 → 512-bit seed | Industry standard recovery. The seed IS the DEK — key-wrapped on disk by the passphrase-derived KEK. |
| **Identity Keys** | Signing (`did:plc`), persona keypairs | **SLIP-0010** (Ed25519 hardened derivation) | Ed25519 is incompatible with BIP-32's secp256k1 math. SLIP-0010 provides equivalent HD paths with hardened-only derivation (no unsafe public derivation). |
| **Vault Keys** | SQLCipher database encryption | **HKDF-SHA256** from persona key | Domain-separated symmetric keys for each persona's encrypted SQLite file |

**Why not BIP-32:** BIP-32 uses point addition on the secp256k1 curve. Ed25519 keys use SHA-512 and bit clamping — fundamentally different algebra. Implementing BIP-32 on Ed25519 produces invalid keys or weakens curve security. BIP-32 also allows public derivation (`xpub` → child public keys), which is mathematically unsafe on Ed25519 without complex cryptographic tweaks. SLIP-0010 explicitly disables public derivation (hardened-only) to prevent this.

**SLIP-0010 derivation paths:**

```
BIP-39 Mnemonic (24 words = 256-bit entropy)
    │
    ▼  PBKDF2 (mnemonic + optional passphrase → 512-bit seed)
    │
    Master Seed (512-bit) — this IS the DEK (Data Encryption Key)
    │
    └── SLIP-0010 Ed25519 Hardened Derivation
        │
        ├── m/44'/0'  → Root Identity Key (signs DID Document, root of trust)
        │
        ├── m/44'/1'  → /persona/consumer     (shopping, product interactions)
        ├── m/44'/2'  → /persona/professional  (work, LinkedIn-style)
        ├── m/44'/3'  → /persona/social        (friends, Dina-to-Dina)
        ├── m/44'/4'  → /persona/health        (medical data)
        ├── m/44'/5'  → /persona/financial     (banking, tax, insurance)
        ├── m/44'/6'  → /persona/citizen       (government, legal identity)
        └── m/44'/N'  → /persona/custom/*      (user-defined compartments)
```

Each persona's Ed25519 keypair is then used for two purposes:
1. **Signing** — the persona's private key signs DIDComm messages and Reputation Graph entries
2. **Vault encryption** — the persona's private key is fed through HKDF-SHA256 with a domain separator to derive the SQLCipher passphrase:

```
Persona Key (Ed25519 private key from SLIP-0010)
    │
    └── HKDF-SHA256(ikm=persona_key, salt=user_salt, info="dina:vault:consumer:v1")
        → 256-bit SQLCipher passphrase for consumer.sqlite
    │
    └── HKDF-SHA256(ikm=persona_key, salt=user_salt, info="dina:index:consumer:v1")
        → 256-bit SQLCipher passphrase for consumer_index.sqlite
```

**Go implementation:** Use `github.com/stellar/go/exp/crypto/derivation` or equivalent SLIP-0010 library. Do not roll custom Ed25519 HD derivation.

**Critical security property:** Personas are cryptographically unlinkable. Knowing the consumer keypair tells you nothing about the health keypair — hardened derivation means each child key is derived from the parent seed plus an index, with no mathematical relationship between siblings. Even Dina's own code cannot cross compartments without the root key authorizing a specific, logged operation.

**Data isolation: Separate SQLite files per persona (Multi-Vault Architecture).** Each persona gets its own SQLCipher-encrypted SQLite file, with its own passphrase derived from the persona key. This is physical separation, not logical — there is no shared database with a `persona_id` column.

```
data/vaults/
├── consumer.sqlite     ← Encrypted with consumer persona key
├── social.sqlite       ← Encrypted with social persona key
├── health.sqlite       ← Encrypted with health persona key
├── financial.sqlite    ← Encrypted with financial persona key
├── citizen.sqlite      ← Encrypted with citizen persona key
├── professional.sqlite ← Encrypted with professional persona key
└── identity.sqlite     ← Tier 0: root keys, persona keys, ZKP credentials
```

**Why physical separation, not a single DB:**
- **The Exit Interview Test.** Leave your job? `rm professional.sqlite`. Physics guarantees the data is gone. No complex SQL queries, no missed FTS index entries, no lingering vector embeddings.
- **Context fences at the OS level.** In "Weekend Mode," Dina only unlocks `social.sqlite` and `consumer.sqlite`. She literally *cannot* bother you about work because the work vault is locked.
- **Blast radius containment.** Compromise of one persona's key exposes one file. The others are encrypted with independent keys.
- **Right to delete.** `rm health.sqlite`. All medical data physically annihilated. No forensic recovery possible.

**Unified search via SQLCipher ATTACH:** When the user authorizes multi-persona queries, Dina uses SQLite's `ATTACH DATABASE` to mount multiple vaults simultaneously with different keys:

```go
// Open primary vault
db, _ := sql.Open("sqlite3", "file:consumer.sqlite?_pragma_key=consumerKey")

// Attach secondary vault with its own key
db.Exec("ATTACH DATABASE 'social.sqlite' AS social KEY 'socialKey'")

// Query across both (unified search)
rows, _ := db.Query(`
    SELECT body_text FROM main.documents
    UNION ALL
    SELECT body_text FROM social.documents
`)
```

**Context modes:**
- **Single-persona mode (default):** Only the active persona's vault is unlocked. Health bot queries? Only `health.sqlite` is mounted. Shopping? Only `consumer.sqlite`.
- **Unified mode:** User explicitly authorizes cross-persona search. "Does my daughter's recital clash with the board meeting?" requires both `social.sqlite` and `professional.sqlite` to be mounted. Authorization is explicit and logged.

### Zero-Knowledge Proof Credentials (Trust Rings)

**Ring 1 — Unverified Dina:**
- Just the DID. No proof of anything.
- Anyone can create one in seconds.
- Trust ceiling: very low. Small interactions only.

**Ring 2 — Verified Human:**
- User proves they hold a valid government ID without revealing which one.
- Implementation: ZKP circuit that takes as private input the Aadhaar number / SSN / passport number, and outputs a proof that "this is a valid, unique ID number" without revealing the number itself.
- **Current reality check:** India's UIDAI does not currently offer a ZKP-native API. The practical first step is Aadhaar's existing e-KYC XML with offline verification, processed locally on-device, with only a yes/no attestation stored. True ZKP infrastructure (using Semaphore V4 — now production-proven via World ID with 300+ participant trusted setup ceremony) is Phase 2+.
- One government ID = one verified Dina. Prevents Sybil attacks.

**Ring 3 — Skin in the Game:**
- Optional professional/business credentials.
- Verifiable Credentials (W3C VC standard) from LinkedIn, GitHub, business registrations, GST numbers.
- Each credential adds trust weight but reveals only what the user chooses.

```
Trust Score = f(
    ring_level,           // 1, 2, or 3
    time_alive,           // age of this Dina in days
    transaction_anchors,  // verified money moved (count, volume, span)
    outcome_data,         // purchase outcomes fed to Reputation Graph
    peer_attestations,    // other verified Dinas who vouch
    credential_count      // Ring 3 credentials linked
)
```

### Open Questions — Identity
- **Key rotation:** If root key is compromised, how does the user rotate while preserving reputation? Possible: pre-signed rotation certificate stored in recovery.
- **Multi-device root:** Does each device get a copy of the root key, or do devices get delegated sub-keys? Delegated sub-keys are safer (compromised laptop doesn't lose root) but more complex.
- **Death detection:** How does the Digital Estate know the user has died? Manual trigger by next-of-kin with physical access to recovery phrase? Time-based dead man's switch?

---

## Layer 1: Storage

Six tiers (Tier 0-5). Each with different encryption, sync, and backup strategies. Primary location: Home Node. Client devices cache subsets.

### Tier 0 — Identity Vault

| Property | Value |
|----------|-------|
| Contents | Root keypair, persona keys, ZKP credentials, recovery config |
| Encryption | Hardware-backed (Secure Enclave / StrongBox / TPM) where available |
| Location | Home node (primary) + each client device holds delegated device keys |
| Backup | BIP-39 mnemonic on paper. Home node stores encrypted root key blob (decryptable only with mnemonic or hardware key). |
| Breach impact | Total identity compromise. Catastrophic. |

### Tier 1 — The Vault (Raw Ingested Data)

| Property | Value |
|----------|-------|
| Contents | Emails, chat messages, calendar events, contacts, photos, documents |
| Encryption | SQLCipher whole-database encryption (AES-256-CBC, per-page). Key derived from persona key via HKDF (persona key → HKDF-SHA256 → SQLCipher passphrase). Each persona is a separate `.sqlite` file. |
| Storage engine | SQLite with FTS5 (full-text search). FTS index is encrypted transparently by SQLCipher. |
| Location | Home node (source of truth). Rich clients cache configurable subsets. |
| Client cache | Phone: recent 6 months. Laptop: configurable (up to everything). Thin clients: no local cache. |
| Backup | Encrypted snapshot to blob storage of user's choice (S3, Backblaze, NAS, second VPS). Each persona file backed up independently. |
| Breach impact | Compromise of one persona's SQLite file exposes that persona only. Physical file separation limits blast radius. |

**Schema sketch for Vault (per-persona SQLCipher database):**
```sql
-- DINA VAULT SCHEMA (v2)
-- Storage: SQLCipher Encrypted Database (whole-file, AES-256-CBC per page)
-- Key: Master Key → SLIP-0010 → persona key → HKDF-SHA256 → SQLCipher passphrase
-- One file per persona: consumer.sqlite, health.sqlite, etc.

-- Core ingestion table
CREATE TABLE documents (
    id TEXT PRIMARY KEY,           -- UUID
    source TEXT NOT NULL,          -- 'gmail', 'whatsapp', 'calendar', etc.
    source_id TEXT,                -- original ID in source system
    item_type TEXT NOT NULL,       -- 'email', 'message', 'event', 'contact', 'photo'
    timestamp INTEGER NOT NULL,   -- unix timestamp of original item
    ingested_at INTEGER NOT NULL,  -- when Dina pulled it
    body_text TEXT,                -- the actual content (encrypted at rest by SQLCipher)
    author TEXT,                   -- sender/creator
    recipients TEXT,               -- JSON array of recipients
    metadata_json TEXT             -- structured metadata (encrypted at rest by SQLCipher)
);

-- Full-text search index (encrypted at rest by SQLCipher — no plaintext leakage)
CREATE VIRTUAL TABLE documents_fts USING fts5(body_text, content=documents, content_rowid=rowid, tokenize='porter');

-- Relationships (who sent what to whom)
-- No persona column needed — the persona is implicit from which .sqlite file this lives in
CREATE TABLE relationships (
    id TEXT PRIMARY KEY,
    entity_name TEXT,              -- "Sancho", "Priya", "Dr. Kumar"
    entity_type TEXT,              -- 'person', 'org', 'bot'
    last_interaction INTEGER,
    interaction_count INTEGER,
    notes TEXT                     -- Dina's inferred notes (encrypted at rest by SQLCipher)
);
```

### Tier 2 — The Index (Derived Intelligence)

| Property | Value |
|----------|-------|
| Contents | Embeddings, summaries, relationship graphs, inferred patterns |
| Encryption | SQLCipher whole-database encryption, per-persona file, key derived from persona key (separate from Tier 1 vault key via HKDF domain separation) |
| Storage engine | SQLite for structured data + sqlite-vec for vector embeddings |
| Location | Home node (primary). Rich clients may build a local subset from their cache for offline search. |
| Backup | Not backed up separately. Regenerable from Tier 1. |
| Breach impact | Attacker sees Dina's inferences. Metadata, not raw data. |

**Vector storage options:**
- Phase 1: `sqlite-vec` (successor to the now-deprecated `sqlite-vss`). Written in pure C, zero dependencies, runs anywhere SQLite runs — phones, desktops, WASM, Raspberry Pi. Mozilla Builders project, MIT/Apache-2.0 licensed. Supports metadata columns and partition keys alongside vectors.
- Phase 2: Consider `sqlite-vector` (from SQLite Cloud, HNSW-based for faster ANN at scale) or Turso's native vector search (libSQL fork with built-in vector support) if index grows large.
- Not using Pinecone/Weaviate — those are third-party cloud services. Dina's embeddings stay on your Home Node.

**Embedding model:** Runs on the Home Node (and optionally on rich client devices for offline search). Options:
- **Phase 1: `EmbeddingGemma`** (308M params, <200MB RAM quantized, 100+ languages). Google's purpose-built on-device embedding model based on Gemma 3 architecture. Best-in-class on MTEB for models under 500M params. Supports Matryoshka representation (768 down to 128 dims) and 2K–8K context. Runs fully offline on phones.
- **Phase 2: `Nomic Embed Text V2`** (475M params, MoE architecture — only 305M active during inference). Trained on 1.6B multilingual pairs, 100+ languages. Flexible dimension truncation (768 → 256). Competitive with models twice its size on BEIR/MIRACL. Needs more hardware but significantly better quality for complex retrieval.
- The embedding model is pluggable. Start small, upgrade later.

### Tier 3 — Reputation & Preferences

| Property | Value |
|----------|-------|
| Contents | Bot trust registry, user preferences, anonymized outcome data |
| Encryption | Encrypted at rest, but some data intentionally shared (anonymized outcomes) |
| Storage engine | SQLite (structured, small) |
| Location | Home node (source of truth). Replicated to rich clients for offline access. |
| Backup | Included in home node backup |
| Breach impact | Preferences and bot scores exposed. Low-medium severity. |

**Outcome data flow:**
```
Purchase happens (via Cart Handover)
        ↓
Dina records: {product_category, seller_dina_id, price, timestamp}
        ↓
    [ weeks/months later ]
        ↓
Dina asks: "How's that chair?"
User responds or Dina infers (still using it? returned?)
        ↓
Anonymized outcome record created:
{
    product_category: "office_chair",
    seller_trust_ring: 2,
    price_range: "10000-15000_INR",
    outcome: "still_using_6_months",
    dina_trust_ring: 2,
    dina_age_days: 730
}
        ↓
Signed with persona key, submitted to Reputation Graph
(No user identity. No product name. Just category + outcome.)
```

### Tier 4 — Staging (Ephemeral)

| Property | Value |
|----------|-------|
| Contents | Email drafts, payment intents, pending cart handovers, notification queue |
| Encryption | Encrypted at rest |
| Storage engine | SQLite or simple key-value store |
| Location | Home node (for agent-initiated drafts) + originating client device (for user-initiated drafts) |
| Backup | Not backed up |
| Auto-expire | Items older than 72 hours are deleted |
| Breach impact | Pending drafts visible. Low severity. |

### Tier 5 — The Deep Archive

Last-resort recovery. Survives Home Node destruction, backup ransomware, and total infrastructure loss.

| Property | Value |
|----------|-------|
| Contents | Full encrypted vault snapshots (complete Tier 0 + Tier 1 + Tier 3) |
| Encryption | AES-256-GCM, separate Archive Key derived from root |
| Frequency | Weekly (configurable) |
| Retention | Indefinite (or user-configured) |
| Breach impact | Encrypted blobs. Useless without keys. |

**User's choice of cold storage:**

| Option | Tech | Air Gap | Cost | Recovery Time |
|--------|------|---------|------|---------------|
| **Cloud Cold Storage** | AWS S3 Glacier Deep Archive (or Backblaze B2) with **Compliance Mode Object Lock** | Software air gap — even root user and cloud support cannot delete or modify locked objects for the configured retention period | ~$1/TB/month | 12-48 hours (retrieval from archive) |
| **Sovereign Cold Storage** | Physical USB HDD or LTO tape, unplugged after backup | Physical air gap — disconnected hardware | $50-3000 one-time, $0/month | Instant (once plugged in) |

**Why Compliance Mode Object Lock matters:** Without it, a compromised cloud credential can delete backups. With it, backups are immutable for the configured retention period.

**Default:** Most users use Cloud Cold Storage. Privacy absolutists use physical drives. Both are encrypted with a key that lives only on the user's devices.

### Encryption Architecture

```
Master Seed (BIP-39 mnemonic → stored encrypted on Home Node; hardware-backed on client devices)
    │
    ├── m/44'/0' → Root Identity Key (signs DID Document)
    │
    ├── m/44'/1' → Persona Key: /consumer
    │       ├── HKDF("dina:vault:consumer:v1") → SQLCipher key for consumer.sqlite (Tier 1)
    │       └── HKDF("dina:index:consumer:v1") → SQLCipher key for consumer_index.sqlite (Tier 2)
    │
    ├── m/44'/4' → Persona Key: /health
    │       ├── HKDF("dina:vault:health:v1") → SQLCipher key for health.sqlite (Tier 1)
    │       └── HKDF("dina:index:health:v1") → SQLCipher key for health_index.sqlite (Tier 2)
    │
    ├── m/44'/2'-6' → Persona Keys: /professional, /social, /financial, /citizen
    │       └── (same HKDF pattern — one .sqlite file per persona per tier)
    │
    ├── Staging Key → SQLCipher passphrase for staging.sqlite (Tier 4, shared)
    │
    ├── Backup Encryption Key (for off-node backups)
    │       └── Wraps per-persona .sqlite files for backup storage
    │
    ├── Archive Key (for Tier 5 Deep Archive)
    │       └── Wraps full vault snapshots for cold storage
    │       └── Separate from Backup Key so archive survives backup key rotation
    │
    ├── Client Sync Key (for home node ↔ client device communication)
    │       └── Encrypts vault cache pushes to client devices
    │
    └── Reputation Signing Key (for Graph submissions)
            └── Signs anonymized outcome data
```

**Two derivation layers:** Identity keys (Ed25519 keypairs for signing) are derived via SLIP-0010 hardened paths from the master seed. Vault keys (256-bit symmetric keys for SQLCipher) are derived via HKDF-SHA256 from the persona's private key, domain-separated by info string. Compromise of one vault key reveals nothing about other vaults or identity keys.

### Master Key Storage (Key Wrapping)

The Master Seed (DEK — Data Encryption Key) is the 512-bit seed derived from the BIP-39 mnemonic via PBKDF2. It is stored on disk, encrypted by a Key Encryption Key (KEK) derived from the user's passphrase. This is standard key wrapping, not "password-encrypted storage."

```
Passphrase ("correct horse battery staple")
    │
    ▼  Argon2id v1.3 (memory: 64 MB, time: 1 iteration, parallelism: 4 lanes)
    │
    KEK (32-byte Key Encryption Key)
    │
    ▼  AES-256-GCM wrap (or XChaCha20-Poly1305)
    │
    Encrypted Master Key blob → stored at keys/master.key.enc
    │  (plus cleartext 16-byte salt for Argon2id)
    │
    ▼  On unlock: KEK decrypts blob → Master Key loaded into RAM
    │
    Master Key (DEK)
    │
    ├── SLIP-0010 derivation → persona identity keys (Ed25519)
    └── HKDF derivation → per-persona SQLCipher passphrases
```

**Why key wrapping:** Changing the user's passphrase re-wraps the Master Key with a new KEK — no need to re-encrypt the entire multi-gigabyte database. The Master Key itself never changes unless the identity is rotated.

**Home node:** `keys/master.key.enc` + salt stored on filesystem. On client devices with hardware security modules, delegated device keys are generated and stored in Secure Enclave / StrongBox / TPM. The Master Key is NEVER stored in plaintext at rest on any system.

### Data Safety Protocol (Corruption Immunity)

In a sovereign architecture, there's no SRE team to restore the database. The architecture must defend against code bugs, power failures, and operator error at every level.

**Protection 1: Atomic Writes (Database Level)**

SQLite is robust, but only if configured correctly. A power outage mid-write can corrupt the file.

```sql
-- Run on every connection open (Home Node and client cache)
PRAGMA key='<hex-encoded-256-bit-key>';  -- SQLCipher: unlock the encrypted database
PRAGMA cipher_page_size=4096;            -- SQLCipher: page size (match default)
PRAGMA journal_mode=WAL;                 -- Write-Ahead Logging: changes go to -wal file first
PRAGMA synchronous=NORMAL;               -- Safe in WAL mode, significantly faster than FULL
PRAGMA foreign_keys=ON;                  -- Prevent orphaned data corruption
```

WAL mode means: if the server crashes mid-write, the main `.sqlite` is untouched. On restart, SQLite sees the incomplete `-wal` file and automatically rolls back. The database is always in a consistent state.

**Protection 2: Pre-Flight Snapshots (Application Level)**

Before any schema migration or major operation, Dina creates a point-in-time backup.

```
MIGRATION SAFETY PROTOCOL:

  1. Create backup: VACUUM INTO 'vault.v{old_version}.bak'
     (Atomic, non-blocking copy of entire database)
           ↓
  2. Apply schema changes inside a transaction
           ↓
  3. Run: PRAGMA integrity_check
     (Verifies every page of the database is consistent)
           ↓
  4a. If integrity_check = "ok" → Commit. Delete backup after 24h.
  4b. If integrity_check ≠ "ok" → ROLLBACK. Restore from backup. Alert user.
```

This runs automatically on every `dina-core` update. The user never sees it unless something goes wrong — in which case their vault is restored to the state 1 second before the update.

**Protection 3: File System Snapshots (Infrastructure Level)**

For managed hosting (Level 1/2) and power-user self-hosting:

- Format the `/var/lib/dina/users/` volume as **ZFS** or **Btrfs**
- Auto-snapshot every 15 minutes (copy-on-write: instant, near-zero space cost until data changes)
- Retain: 24h of 15-minute snapshots, 7 days of hourly, 30 days of daily

Recovery: `zfs rollback dina/users/did_user_A@15min_ago` — file system instantly reverts to that point in time.

**Protection 4: Off-Site Backup (Network Level)**

Encrypted vault snapshots pushed to remote blob storage (S3, Backblaze, second VPS). Covers disk failure, datacenter outage, theft.

**Protection 5: Deep Archive (Storage Tier 5)**

Immutable cold storage with compliance lock. Covers ransomware, total infrastructure loss, catastrophic operator error.

**The full corruption immunity stack:**

| Threat | Protection | Tech | Recovery Time |
|--------|-----------|------|---------------|
| Power outage mid-write | Atomic commits | `PRAGMA journal_mode=WAL` | Automatic (on restart) |
| Bad migration / code bug | Pre-flight snapshot | `VACUUM INTO` + integrity check | Seconds (auto-rollback) |
| Accidental deletion / logic bug | File system snapshot | ZFS/Btrfs snapshots (15 min) | Seconds (rollback) |
| Disk failure / hardware death | Off-site backup | Encrypted S3/Backblaze sync | Minutes to hours |
| Ransomware / total destruction | Immutable archive | Tier 5 Deep Archive (Object Lock) | 12-48 hours |

---

## Layer 2: Ingestion

How Dina pulls data from the outside world into the Vault.

### Where Connectors Run

Most connectors run on the **Home Node** — this is one of the main reasons the home node exists. API-based connectors (Gmail, Calendar, Contacts) work better from an always-on server than from a phone that sleeps, loses connectivity, and has battery constraints.

**Exception: WhatsApp.** The NotificationListenerService requires an Android device. WhatsApp ingestion runs on the phone and pushes captured messages to the home node.

| Connector | Runs On | Why |
|-----------|---------|-----|
| Gmail | Home Node | OAuth API, needs reliable polling |
| Calendar | Home Node | CalDAV API, needs reliable polling |
| Contacts | Home Node | CardDAV API, infrequent sync |
| WhatsApp | Phone (Android) | Requires NotificationListenerService |
| SMS | Phone (Android) | Requires Content Provider access |
| Photos | Phone | Local photo library access |
| Browser history | Laptop / Phone | Local browser database |
| Bank statements | Home Node | PDF parsing or Open Banking APIs |

### Connectors

Each data source gets a connector — a small, isolated module that knows how to pull data from one service.

```
HOME NODE                              PHONE (Android)
┌─────────────────────────┐            ┌──────────────────┐
│    INGESTION LAYER      │            │ DEVICE INGESTION │
│                         │            │                  │
│ ┌──────────┐ ┌───────┐ │            │ ┌──────────────┐ │
│ │ Gmail    │ │Calend.│ │            │ │ WhatsApp     │ │
│ │Connector │ │Connect│ │            │ │ Connector    │ │
│ │(API)     │ │(API)  │ │            │ │ (Notif.Lstnr)│ │
│ └────┬─────┘ └───┬───┘ │            │ └──────┬───────┘ │
│      │           │      │            │        │         │
│      ▼           ▼      │            │        ▼         │
│ ┌─────────────────────┐ │            │ ┌──────────────┐ │
│ │  Normalizer         │ │            │ │ Normalizer   │ │
│ └────────┬────────────┘ │            │ └──────┬───────┘ │
│          ▼              │            │        │         │
│ ┌─────────────────────┐ │            │        ▼         │
│ │  Encryptor          │ │  ◄─────────│  Push to Home   │
│ └────────┬────────────┘ │  encrypted │  Node via        │
│          ▼              │  channel    │  DIDComm         │
│    Vault (Tier 1)       │            └──────────────────┘
└─────────────────────────┘
```

### Gmail Connector
- **Runs on:** Home Node
- **API:** Gmail REST API, `readonly` scope only
- **Auth:** OAuth 2.0 token stored in Tier 0 (encrypted)
- **Pull frequency:** Every 15 minutes (configurable)
- **What's pulled:** Message headers, body (plain + HTML), attachments (metadata only, full download optional)
- **Dedup:** By Gmail message ID
- **Persona routing:** Emails go to whatever persona the user configures (most go to /professional or /consumer)

### WhatsApp Connector (Android)
- **Runs on:** Phone (Android only) — pushes to Home Node
- **Method:** Android NotificationListenerService
- **How:** When a WhatsApp notification arrives, the service copies sender, message text, and timestamp. Encrypts and pushes to Home Node via authenticated channel.
- **Limitations:** No message history before Dina was installed. No media (photos/videos) — text only via notifications. Fragile — breaks if WhatsApp changes notification format.
- **Alternative (Phase 2+):** WhatsApp Cloud API (requires business account) or WhatsApp Web protocol (legally gray, e.g. Baileys)
- **Limitation:** Weakest connector. Fragile, text-only, no history. Requires WhatsApp to open up or regulation to force interoperability (EU DMA).

### Calendar Connector
- **Runs on:** Home Node
- **API:** CalDAV (works with Google Calendar, Apple Calendar, any standard calendar)
- **Alt:** Google Calendar REST API for Google-specific features
- **Pull:** Every 30 minutes or on-change webhook
- **What's pulled:** Events, attendees, locations, descriptions

### Contacts Connector
- **Runs on:** Home Node
- **API:** CardDAV (standard) or platform-specific (Google People API, Apple Contacts)
- **Pull:** On-change sync
- **What's pulled:** Names, phone numbers, emails, notes, relationships

### Future Connectors (Phase 2+)
- **SMS:** Phone (Android Content Provider, read-only) — pushes to Home Node
- **Photos:** Phone (local photo library scan: EXIF data, face detection for relationship mapping) — metadata pushed to Home Node
- **Browser history:** Extension or local database read — pushes to Home Node
- **Bank statements:** Home Node (PDF parsing or Open Banking APIs — India: Account Aggregator framework)
- **Location:** Phone (background location for context "You're near Sancho's office") — pushed to Home Node

### Connector Security Rules
1. Every connector uses the minimum possible permission scope (read-only always)
2. OAuth tokens are encrypted in Tier 0, stored on the Home Node
3. Raw data is encrypted immediately upon ingestion — the normalizer outputs encrypted vault_items
4. Connectors are sandboxed — a compromised Gmail connector cannot access WhatsApp data
5. User can see every connector's status, last pull time, and data volume. Full transparency.
6. Phone-based connectors (WhatsApp, SMS) authenticate to Home Node with device-delegated keys before pushing data

---

## Layer 6: Intelligence

Where Dina thinks. This is the most complex layer.

**Sidecar mapping:** In the three-container architecture, Layer 6 is split across dina-core and dina-brain. The PII scrubber's regex hot path runs in dina-core (Go — fast, no external calls). The LLM-based NER fallback, silence classification, context assembly, whisper generation, and all agent reasoning run in dina-brain (Python + Google ADK). Both call llama-server for local LLM inference.

### The PII Scrubber

Before any text leaves the device for LLM processing, it passes through local sanitization.

```
Raw text from Vault
        ↓
┌─────────────────────────────┐
│  PII Scrubber (Local)       │
│                             │
│  Regex patterns:            │
│  - Credit card numbers      │
│  - Phone numbers            │
│  - Aadhaar / SSN            │
│  - Email addresses          │
│  - Bank account numbers     │
│                             │
│  NER model (Gemma 3n E2B): │
│  - Person names             │
│  - Addresses                │
│  - Organization names       │
│  - Medical terms            │
│                             │
│  Replacement map:           │
│  "Sancho" → [PERSON_1]     │
│  "4111-2222" → [CC_NUM]    │
│  "sancho@email" → [EMAIL_1]│
└──────────────┬──────────────┘
               ↓
Sanitized text → sent to LLM for reasoning
               ↓
Response received
               ↓
┌─────────────────────────────┐
│  De-sanitizer (Local)       │
│  [PERSON_1] → "Sancho"     │
│  [EMAIL_1] → "sancho@email"│
└─────────────────────────────┘
               ↓
Final response with real names restored
```

**NER model:** Runs on Home Node (primary) and on rich client devices (for offline fallback). Options:
- **Phase 1: `Gemma 3n E2B`** (2B active params, ~2GB RAM). Google's mobile-first multimodal model handles NER/PII detection as a general task — no separate NER model needed. Prompt it: "Extract all PII entities from this text." 32K context, 1.5x faster than previous generation. Runs on Home Node via llama.cpp.
- **Phase 1 fallback: `FunctionGemma 270M`** (270M params, ~529MB). Google's ultra-lightweight model fine-tuned for structured function calling. Can be fine-tuned for PII extraction specifically. Runs at 2500+ tok/sec. Perfect for the "fast regex + small model" PII pipeline.
- **Phase 2: Fine-tuned Gemma 3n E4B** (4B active, ~3GB RAM). Higher accuracy NER with custom PII-detection fine-tuning using Unsloth or similar efficient fine-tuning frameworks.

**Known limitation:** PII scrubbing is not perfect. Contextual re-identification is possible ("The CEO of [COMPANY_1] who wrote a novel about AI in 2017"). Mitigation: sensitive personas (health, financial) process entirely on Home Node — never sent to cloud LLMs.

### LLM Routing

Not all tasks need the same model. The dina-brain routes intelligently, using llama-server for local inference and cloud APIs for complex reasoning.

```
Task Classification (dina-brain, via llama-server)
        │
        ├── Simple lookup / search
        │   → dina-core: SQLite FTS5 query. No LLM needed.
        │
        ├── Basic summarization / drafting
        │   → llama-server: Gemma 3n E2B (2B active, multimodal)
        │     or Gemma 3n E4B (4B active, higher quality) if RAM allows
        │
        ├── Complex reasoning / multi-step analysis
        │   → Cloud LLM via PII scrubber (dina-brain → dina-core scrub → cloud API)
        │   → Options: Claude, Gemini, GPT-4, self-hosted
        │   → User configures which provider they trust
        │
        ├── Sensitive persona (health, financial)
        │   → llama-server only. Never external cloud. Regardless of task complexity.
        │   → With Gemma 3n E4B, quality trade-off is now minimal for most tasks.
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

### Context Injection (The Whisper)

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
Whisper delivered:
  Overlay/notification: "He asked for the PDF last week. Mom was ill."
```

**Platform implementations:**
- **Android:** Accessibility Service reads current screen context. Dina runs query in background, pushes floating overlay or notification.
- **iOS:** Limited. No Accessibility Service equivalent. Options: Siri Intents (limited), keyboard extension, Share sheet. Full whisper capability requires Android or desktop.
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

## Layer 5: Bot Interface

How Dina talks to external bots.

### Query Sanitization

When Dina needs external intelligence, she constructs a sanitized query:

```
User asks: "Should I buy the Aeron chair? I have back problems and I sit 10 hours a day"

Dina knows (from Vault):
  - User's budget range (from financial persona)
  - User's past chair purchases and outcomes
  - User's back issue history (from health persona)

What Dina sends to Review Bot:
  "Best ergonomic office chair for long sitting hours (10+/day), 
   lumbar support critical, budget under ₹80,000"

What Dina does NOT send:
  - User's name, identity, DID
  - Specific medical diagnosis
  - Financial details
  - Any persona data
```

### Bot Communication Protocol

Bots register with the Reputation Graph and expose a standard API:

```
POST /query
{
    "query": "Best ergonomic office chair, lumbar support, budget under 80000 INR",
    "requester_trust_ring": 2,        // anonymous — just the ring level
    "response_format": "structured",   // or "natural_language"
    "max_sources": 5
}

Response:
{
    "recommendations": [
        {
            "product": "Herman Miller Aeron",
            "score": 92,
            "sources": [
                {
                    "type": "expert",
                    "id": "rtings_review_2025",
                    "weight": 0.6,
                    "creator_name": "RTINGS.com",
                    "source_url": "https://rtings.com/chairs/reviews/herman-miller/aeron",
                    "deep_link": "https://rtings.com/chairs/reviews/herman-miller/aeron#lumbar",
                    "deep_link_context": "See lumbar support stress test at this section"
                },
                {"type": "outcome", "sample_size": 4200, "still_using_1yr": 0.89}
            ],
            "cons": ["price_high", "limited_tilt_range"],
            "confidence": 0.87
        }
    ],
    "bot_signature": "...",           // cryptographic signature for verification
    "bot_did": "did:plc:..."           // bot's identity in Reputation Graph
}
```

**Attribution is mandatory in the protocol.** Every expert source in a bot response MUST include `creator_name`, `source_url`, and where possible `deep_link` + `deep_link_context`.

Dina's default presentation uses the **Deep Link pattern**: drive traffic to the original source rather than extracting and replacing the expert's work. Bots that strip attribution receive a reputation penalty.
```

### Bot Reputation Scoring

Every bot interaction feeds back into the Bot Reputation Registry:

```
Bot Reputation = f(
    response_accuracy,     // did outcomes match recommendations?
    response_time,         // latency
    uptime,               // availability
    user_ratings,         // explicit thumbs up/down from users
    consistency,          // does it give different answers to similar queries?
    age,                  // how long has this bot been operating?
    peer_endorsements     // other bots or experts vouch for it
)
```

Dina tracks bot scores locally. If a bot's accuracy drops below a threshold, Dina automatically routes to the next-best bot. No manual intervention.

### Bot Discovery

How does Dina find bots in the first place?

- **Phase 1:** Hardcoded registry. The protocol ships with a default list of known bots (including the first review bot you build). Users can add/remove.
- **Phase 2:** Decentralized bot registry on the Reputation Graph. Bots self-register, and their reputation determines visibility.
- **Phase 3:** Bot-to-bot recommendations. "This query is outside my domain. Try the Medical Bot at did:plc:..."

---

## Layer 4: Dina-to-Dina Communication

The mesh protocol. How your Dina talks to Sancho's Dina.

### Encryption Protocol Decision

**Problem:** There is no actively maintained DIDComm v2.1 library in Go (or any language except Rust and Python). Hyperledger Aries Framework Go was archived in March 2024. DIDComm v2 itself lacks forward secrecy — the 2024 ACM CCS security analysis confirmed this. Building a full DIDComm v2.1 implementation from scratch would cost 2-3 months for marginal interoperability gain (the DIDComm ecosystem is small and concentrated in verifiable credentials, not agent-to-agent messaging).

**Decision: Phased encryption approach.**

| Phase | Encryption | Forward Secrecy | Interop |
|-------|-----------|-----------------|---------|
| **Phase 1** | libsodium `crypto_box_seal` (ephemeral sender keys) + DIDComm-shaped plaintext | Sender FS only (ephemeral key destroyed after send) | Dina-to-Dina only |
| **Phase 2** | Full JWE (ECDH-1PU+A256KW, A256CBC-HS512) | Same as DIDComm v2 (sender FS only) | Wire-compatible with DIDComm v2 libraries |
| **Phase 3** | Noise XX session establishment between Home Nodes | **Full FS** (both sender + receiver, per-session ephemeral keys) | Dina-to-Dina; DIDComm plaintext over Noise channel |

**Why this works:** The plaintext message structure inside the encryption envelope is DIDComm-compatible from day one (`{id, type, from, to, created_time, body}`). Migration between phases means swapping the encryption wrapper — application code and message types don't change.

**Why not full DIDComm v2 in Phase 1:**
1. No Go library exists. Rust FFI adds build complexity.
2. DIDComm's multi-recipient JWE, mediator routing, and ECDH-1PU are unnecessary — Dina-to-Dina is 1:1 between always-on Home Nodes.
3. DIDComm v2 doesn't provide forward secrecy anyway. Noise XX in Phase 3 provides better security than DIDComm ever would.
4. libsodium is available in every language and has a trivial API.

### Connection Establishment

```
Your Dina wants to talk to Sancho's Dina
        ↓
Step 1: You already have Sancho's DID (exchanged via QR code when you first connected)
        ↓
Step 2: Resolve DID via PLC Directory
  - Query PLC Directory for did:plc:...(sancho)
  - Returns Sancho's DID Document
  - DID Document contains: public key + Home Node endpoint
  - PLC Directory reveals nothing about Sancho — just how to reach his Dina
        ↓
Step 3: Connect to Sancho's Home Node directly
  - https://sancho-dina.example.com/didcomm  (or IP:port)
  - Home Node is always on — no relay needed, no waiting for phone to wake up
        ↓
Step 4: Mutual authentication
  - Both Dinas present DIDs, verify Ed25519 signatures
  - Both must be in each other's "allowed contacts" list
        ↓
Step 5: Encrypted message sent
  - Ed25519 signing key → X25519 encryption key (crypto_sign_ed25519_sk_to_curve25519)
  - Sender generates ephemeral X25519 keypair per message (crypto_box_seal)
  - Message encrypted with ephemeral key → recipient's static X25519 public key
  - Ephemeral private key destroyed immediately (sender forward secrecy)
  - Even if the VPS provider intercepts traffic, they see only encrypted blobs
```

### Message Types

Dina-to-Dina messages follow a strict schema. The **plaintext** (inside the encryption envelope) uses DIDComm-compatible structure:

```json
{
    "id": "msg_20260215_a1b2c3",
    "type": "dina/social/arrival",
    "from": "did:plc:...(sancho)",
    "to": ["did:plc:...(you)"],
    "created_time": 1739612400,
    "body": {
        "event": "departing_home",
        "eta_minutes": 15,
        "context_flags": ["mother_was_ill"]
    }
}
```

This plaintext is signed (Ed25519) and encrypted (libsodium `crypto_box_seal` in Phase 1) into an envelope:

```json
{
    "typ": "application/dina-encrypted+json",
    "from_kid": "did:plc:...(sancho)#key-1",
    "to_kid": "did:plc:...(you)#key-1",
    "ciphertext": "<base64url-encoded encrypted blob>",
    "sig": "<Ed25519 signature over plaintext>"
}
```

In Phase 2, the envelope becomes standard JWE (`application/didcomm-encrypted+json`) — the plaintext inside stays identical.

**Message categories:**
- `dina/social/*` — arrival, departure, mood flags, context sharing
- `dina/commerce/*` — price negotiation, product inquiry, cart handover coordination
- `dina/identity/*` — trust ring verification, peer attestation requests
- `dina/reputation/*` — outcome data exchange, bot recommendations

### What Gets Shared (And What Doesn't)

This is controlled by the sending Dina's sharing rules — configured by the user.

```
Sharing Rules for "Sancho" (social persona):
  ✓ Share: arrival/departure notifications
  ✓ Share: context flags (family health, mood, life events)
  ✓ Share: social preferences (tea preference, dietary)
  ✗ Never share: financial data
  ✗ Never share: health details beyond flags
  ✗ Never share: professional data
  
Sharing Rules for "Seller ABC" (consumer persona):
  ✓ Share: product requirements
  ✓ Share: budget range (not exact budget)
  ✓ Share: trust ring level
  ✗ Never share: name, address, contact details
  ✗ Never share: anything from any other persona
```

### Transport Layer

How do messages physically travel between Dinas?

**Phase 1: Direct Home Node to Home Node**
- Your DID Document (via PLC Directory) points to your Home Node's endpoint
- Messages go directly: Your Home Node → Sancho's Home Node
- Both are always-on servers — no relay needed for the common case
- End-to-end encrypted (libsodium `crypto_box_seal`). Even if traffic is intercepted, content is unreadable.
- Sender forward secrecy: ephemeral key destroyed after send. Compromise of sender's static key doesn't expose past messages.
- If a Home Node is temporarily down, the sending Dina queues the message and retries with exponential backoff.

**Phase 1 fallback: Relay for NAT/firewall situations**
- Some home servers (Raspberry Pi behind a router) can't accept inbound connections
- For these cases, the DID Document points to a relay endpoint instead
- Relay receives a simple forward envelope: `{type: "dina/forward", to: "did:plc:...", payload: "<encrypted blob>"}`. Relay peels the outer layer, forwards the inner blob. ~100 lines of code.
- Relay sees only: encrypted blob + recipient DID. Cannot read content.
- Community-run or self-hosted relays. User chooses which — and can switch by updating their DID Document.

**Phase 2: Full DIDComm v2 wire compatibility + direct peer-to-peer**
- Encryption envelope upgraded to standard JWE (ECDH-1PU+A256KW). Plaintext messages unchanged.
- Wire-compatible with any DIDComm v2 library (Rust, Python, WASM).
- When user is actively interacting on phone, latency-sensitive messages route directly via WebRTC.
- Falls back to Home Node path if peer unreachable.

**Phase 3: Noise XX sessions + mesh routing**
- Noise XX handshake between always-on Home Nodes establishes sessions with **full forward secrecy** (both sender and receiver). DIDComm plaintext flows over the Noise channel.
- Messages can hop through other Dinas (like Tor but for agent messages) — maximum privacy.

### The Sancho Moment — Complete Flow

```
1. Sancho picks up his keys → his phone detects "leaving home" (geofence)
2. Sancho's phone pushes event to his Home Node: "Sancho is departing"
3. Sancho's Home Node checks sharing rules → you're in "close friends" → arrival notification approved
4. Sancho's Home Node resolves your DID → connects to your Home Node directly
5. Message sent: {type: "arrival", eta: 15min, context: ["mother_ill"]}
6. Your Home Node receives → decrypts → processes
7. Your Home Node checks Vault:
   - Last interaction with Sancho: 3 weeks ago
   - His mother was ill (from previous Dina-to-Dina context flag)
   - His tea preference: strong chai, less sugar
8. Your Home Node pushes notification to your phone:
   - Whisper: "Sancho is 15 minutes away. His mother was ill. He likes strong chai."
   - Draft action: Clear calendar for next 2 hours (you approve on phone)
9. You put the kettle on. You open the door. You ask about his mother.
```

---

## Layer 3: Reputation Graph

Distributed system for verified product reviews, expert attestations, and outcome data. **Built on AT Protocol** — reputation data is inherently public and benefits from federation, Merkle tree integrity, and ecosystem discoverability.

### Architecture

The Reputation Graph is NOT a single database. It's a distributed system built on AT Protocol's federated infrastructure:

```
┌──────────────────────────────────────────────────────────────┐
│               REPUTATION GRAPH (AT Protocol)                  │
│                                                               │
│  ┌─────────────────┐  ┌──────────────┐  ┌───────────┐       │
│  │ Expert           │  │ Outcome      │  │ Bot       │       │
│  │ Attestations     │  │ Data Store   │  │ Registry  │       │
│  │                  │  │              │  │           │       │
│  │ Signed reviews   │  │ Anonymized   │  │ Bot DIDs  │       │
│  │ from verified    │  │ purchase     │  │ Bot scores│       │
│  │ experts          │  │ outcomes     │  │ Bot APIs  │       │
│  │                  │  │ from Dinas   │  │           │       │
│  └─────────────────┘  └──────────────┘  └───────────┘       │
│                                                               │
│  Storage: AT Protocol PDS (one per Home Node)                 │
│           Records stored in signed Merkle repos               │
│           Federated via AT Protocol Relay + AppView           │
│           Custom Lexicons: com.dina.reputation.*              │
│           Signed tombstones for deletion                      │
│           L2 Merkle root anchoring for timestamps (Phase 3)   │
│                                                               │
│  Data flow:                                                   │
│    Home Node → PDS (stores signed records in user's repo)     │
│         ↓                                                     │
│    AT Protocol Relay (aggregates firehose from all PDSes)     │
│         ↓                                                     │
│    Reputation AppView (indexes attestations, outcomes, bots)  │
│                                                               │
│  Rule: Only the keyholder can delete their own data.          │
│        Repo is cryptographically signed — operators            │
│        can censor but not forge.                               │
│        Relay replication defeats censorship.                   │
└──────────────────────────────────────────────────────────────┘
```

### Why AT Protocol for Reputation

| Property | AT Protocol Fit |
|----------|----------------|
| **Public data** | Reputation data is inherently public — AT Protocol repos are public by design |
| **Signed records** | AT Protocol repos are Merkle trees of signed CBOR records — tamper-evident by default |
| **Federation** | Relays aggregate data from all PDSes — no single point of failure or censorship |
| **Custom schemas** | Lexicons let us define `com.dina.reputation.attestation`, `com.dina.reputation.outcome`, etc. |
| **Identity** | `did:plc` is native to AT Protocol — zero integration work |
| **Deletion** | Users can delete records from their repo. Signed tombstones prevent unauthorized deletion. |
| **Ecosystem** | Any AT Protocol AppView can index Dina's Reputation Graph. Handles (`alice.dina.host`) provide human-readable discovery. |
| **Implementations** | Go (`bluesky-social/indigo`), Python (`MarshalX/atproto`), Rust (`atrium-rs`), TypeScript (official reference) |

### Custom Lexicons

```json
{
  "lexicon": 1,
  "id": "com.dina.reputation.attestation",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["expertDid", "productCategory", "productId", "rating", "verdict"],
        "properties": {
          "expertDid": {"type": "string", "format": "did"},
          "expertTrustRing": {"type": "integer"},
          "productCategory": {"type": "string"},
          "productId": {"type": "string"},
          "rating": {"type": "integer", "minimum": 0, "maximum": 100},
          "verdict": {"type": "ref", "ref": "#verdictDetail"},
          "sourceUrl": {"type": "string", "format": "uri"},
          "deepLink": {"type": "string", "format": "uri"},
          "createdAt": {"type": "string", "format": "datetime"}
        }
      }
    }
  }
}
```

Additional Lexicons: `com.dina.reputation.outcome` (anonymized purchase outcomes), `com.dina.reputation.bot` (bot registration and scores), `com.dina.trust.membership` (trust ring public info).

### Expert Attestations

```json
{
    "type": "expert_attestation",
    "expert_did": "did:plc:...",
    "expert_trust_ring": 3,
    "expert_credentials": ["youtube_channel_500k_subs", "verified_engineer"],
    "product_category": "office_chairs",
    "product_id": "herman_miller_aeron_2025",
    "rating": 92,
    "verdict": {
        "build_quality": 95,
        "lumbar_support": 90,
        "value_for_money": 70,
        "durability_estimate": "10+ years"
    },
    "source_url": "https://youtube.com/watch?v=...",
    "timestamp": "2026-01-15T00:00:00Z",
    "signature": "..."
}
```

### Outcome Data

```json
{
    "type": "outcome_report",
    "reporter_trust_ring": 2,
    "reporter_age_days": 730,
    "product_category": "office_chairs",
    "product_id": "herman_miller_aeron_2025",
    "purchase_verified": true,
    "purchase_amount_range": "50000-100000_INR",
    "time_since_purchase_days": 180,
    "outcome": "still_using",
    "satisfaction": "positive",
    "issues": [],
    "timestamp": "2026-07-15T00:00:00Z",
    "signature": "..."
}
```

**No personally identifiable data.** The report contains trust ring level, Dina age, product category, and outcome — not user identity or product specifics.

### Storage Options for the Graph

**Decision: AT Protocol (federated PDS + Relay + AppView) with signed tombstones. From day one.**

We evaluated five options:

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **A: IPFS + IPNS** | Decentralized, content-addressed | Slow queries, pinning economics, no guaranteed deletion | ❌ Rejected |
| **B: DHT (Kademlia)** | No central server, good for key lookup | Can't do complex queries ("all chairs rated > 80") | ❌ Rejected |
| **C: L2 blockchain** | Tamper-proof, auditable timestamps | **Cannot delete.** Immutability violates sovereignty. | ❌ Rejected for data storage |
| **D: Custom federated servers** | Fast queries, simple to build, deletable | Must build federation, sync, discovery from scratch | ❌ Rejected — AT Protocol does this better |
| **E: AT Protocol** | Federation built-in, signed Merkle repos, `did:plc` native, Lexicon schemas, relay infrastructure exists, Go/Python/Rust/TS SDKs | Public by design (fine — reputation IS public) | ✅ Chosen |

**Why AT Protocol wins over custom federation:** AT Protocol provides signed repos (Merkle tree integrity), relay-based federation (replication defeats censorship), custom Lexicons (schema-enforced records), `did:plc` identity (already our DID method), and an existing ecosystem of SDKs and infrastructure. Building custom federation would duplicate what AT Protocol already provides.

**Why blockchain is rejected for data storage:** Immutability violates sovereignty. If you cannot delete data, you are not sovereign.

### Signed Tombstones (Deletion Protocol)

Handles two threats: (1) Chair Company trying to delete your bad review, (2) you wanting to delete your own review.

**Creation:** When you write a review, you sign it with your private key.
```
Review { content: "Bad Chair", author: "did:plc:abc...", sig: "abc..." }
```

**Deletion:** To delete, you send a Tombstone message signed by the same key.
```
Tombstone { target: "review_id_555", author: "did:plc:abc...", sig: "xyz..." }
```

**Server logic:** Receive deletion request → look up original review → verify signature matches author → if match: delete. If no match: reject. The Chair Company cannot forge a deletion request because they don't have your private key.

**Anti-censorship through replication:** When you post a review, it replicates to servers A, B, and C. If the Chair Company operates Server A and wipes your review from their disk (censorship, not deletion), Servers B and C still have it. Other Dinas see the review on B and C, and may flag Server A as "censoring." When *you* delete via signed tombstone, the tombstone propagates to all servers and the review disappears from the entire network.

**Aggregate scores are computed, not stored.** Bot reputation scores and seller trust scores are derived values — any server independently recalculates them from the signed individual entries it holds. You can delete your review (removing your contribution from the aggregate), but you can't delete someone else's contribution or manipulate the aggregate directly.

### Timestamp Anchoring (The One Blockchain Use Case)

Federated servers have one weakness: timestamps are server-reported. A malicious operator can backdate entries or claim data arrived later than it did. For dispute resolution, you need provable "this existed before this date."

**Solution: Periodic Merkle root hash anchoring to an L2 chain.**

```
1000 signed reviews this week
        ↓
Merkle tree (hash of hashes)
        ↓
Single root hash → anchored to L2 (Base/Arbitrum) in one transaction
        ↓
Cost: fractions of a cent per review
        ↓
Verification: "Was this review in this week's batch?"
→ Check the Merkle proof against the on-chain root
```

The hash reveals nothing about the content. Privacy is preserved. When you delete via tombstone, the review disappears from federation — the hash on chain is meaningless without the original data. Deletion right is preserved.

**When this matters:**
- **Dispute resolution.** Seller claims review was revenge-posted after a refund. The timestamp anchor proves otherwise.
- **Anti-gaming.** Coordinated fake reviews are provably clustered in time.
- **Expert Bridge economics.** Creator needs tamper-proof proof of when their attestation was made ("I recommended this before it went viral").
- **Collusion resistance.** If enough servers collude (nation-state pressure, corporate influence), the hash anchors on a public chain are the nuclear option proof.

**Timeline:** Not needed for Phase 1 or 2. Becomes valuable in Phase 3 when real money flows through the system (Expert Bridge, Open Economy) and disputes have economic stakes.

### The First Reputation Bot

Open-source seed bot. Solves the cold start problem — ships with the protocol.

```
┌────────────────────────────────┐
│  Dina Review Bot v1            │
│                                │
│  Ingests:                      │
│  - YouTube review transcripts  │
│  - Reddit product discussions  │
│  - Wirecutter / rtings.com    │
│  - Open Food Facts             │
│  - Government recall databases │
│                                │
│  Processes:                    │
│  - Extracts structured verdicts│
│  - Cross-references sources    │
│  - Generates confidence scores │
│                                │
│  Outputs:                      │
│  - Expert attestation format   │
│  - Queryable via Bot Interface │
│                                │
│  Hosted: by you (free, v1)     │
│  Code: MIT licensed in repo    │
│  Anyone can fork and run their │
│  own instance                  │
└────────────────────────────────┘
```

This bot solves the cold start problem. Day 1, even with zero users contributing outcome data, Dina can answer "what laptop should I buy?" by querying the Review Bot, which has aggregated expert knowledge from public sources.

---

## Layer 7: Action Layer

Dina detects the need, assembles context, enforces safety rules, delegates execution (to the user or to an action agent like OpenClaw), and verifies the outcome. She is the approval gate, not the executor.

**Two exceptions where Dina acts directly:**
1. **Draft-Don't-Send** — because this is a safety enforcement mechanism. Dina ensures no agent auto-sends on your behalf.
2. **Cart Handover** — because this is an approval gate. Dina generates a payment intent; you authorize it.

### Draft-Don't-Send

**No agent operating under the Dina Protocol shall ever press Send. Only Draft.**

Dina (or a delegated action agent) may draft a response, but the draft must pass through Dina's approval gate before reaching the user for final review.

```
Dina reads incoming email (from Vault)
        ↓
Classifies: conference invite, you're free, low-risk response
        ↓
Drafts reply via Gmail API (drafts.create, NOT messages.send)
        ↓
Stores in Tier 4 (Staging):
{
    "type": "email_draft",
    "gmail_draft_id": "r123456",
    "to": "conference@org.com",
    "subject": "Re: Conference Invite",
    "body": "Hi, I'd love to attend. Added to my calendar.",
    "dina_confidence": 0.85,
    "created_at": "2026-02-15T10:00:00Z",
    "expires_at": "2026-02-18T10:00:00Z"
}
        ↓
Notifies user: "Conference invite. Drafted a 'Yes'. [Review & Send]"
        ↓
User taps [Review & Send] → sees draft in Gmail → edits if needed → presses Send
```

**Rules:**
1. Dina NEVER calls `messages.send`. Only `drafts.create`.
2. Every draft has a confidence score. Below threshold → Dina flags for manual review.
3. Drafts auto-expire after 72 hours.
4. High-risk classifications (legal, financial, emotional) → Dina only summarizes, never drafts.

### Cart Handover

```
Dina finds the best chair
        ↓
Constructs payment intent:

UPI:  upi://pay?pa=merchant@okicici&am=12000&pn=ChairMaker&tr=DINA-TXN-12345
Crypto: ethereum:0x1234...?value=0.05&data=0x...
Web:   https://chairmaker.com/checkout?cart=DINA-CART-12345
        ↓
Stores in Tier 4 (Staging):
{
    "type": "payment_intent",
    "method": "upi",
    "intent_uri": "upi://pay?...",
    "merchant": "ChairMaker",
    "amount": 12000,
    "currency": "INR",
    "dina_recommendation": "Best match. Rep score 94. 89% still using after 1 year.",
    "created_at": "2026-02-15T10:00:00Z",
    "expires_at": "2026-02-15T22:00:00Z"
}
        ↓
Presents to user: "₹12,000 to ChairMaker. [Pay Now]"
        ↓
User taps [Pay Now]
        ↓
Phone OS opens GPay/PhonePe/Metamask via deep link
        ↓
User enters PIN / biometric
        ↓
Payment app sends confirmation (SMS or callback)
        ↓
Dina records outcome in Tier 3 for future Reputation Graph contribution
```

**Dina never sees:** Bank balance, UPI PIN, card numbers, payment credentials. She generates the link. The OS handles the rest.

### Agent Orchestration (via MCP)

For tasks beyond drafting and payments, Dina delegates to external action agents. The integration protocol is MCP (Model Context Protocol) — the same standard used by Claude, OpenClaw, and the broader agent ecosystem.

```
User's license needs renewal
        ↓
dina-brain detects (from ingested email or calendar):
  "License expires in 7 days. User hasn't acted."
        ↓
dina-brain classifies: Priority 2 (user should know) or Priority 1 (fiduciary — harm if missed)
        ↓
Option A — Notify only:
  Whisper: "Your license expires next week."
        ↓
Option B — Delegate (if user has pre-authorized):
  dina-brain calls OpenClaw via MCP:
    Tool: "form_fill"
    Context: {task: "license_renewal", identity_persona: "/legal"}
    Constraints: {no_payment: true, draft_only: true}
        ↓
  OpenClaw fills forms, returns draft for review
        ↓
  dina-brain stores in Tier 4 (Staging)
        ↓
  Notifies user: "License renewal forms ready. [Review]"
        ↓
  User reviews, approves, submits
```

**Orchestration rules:**
1. Dina never gives an action agent raw vault data. She provides only the minimal context needed for the task, scrubbed through the PII layer.
2. Every delegated action passes through the Silence Protocol first — Dina decides IF to act, not just HOW.
3. Action agents operate under Dina's constraints. If Dina says `draft_only: true`, the agent cannot send.
4. Outcomes are recorded in Tier 3 for the agent's reputation score. If OpenClaw's form-fill quality drops, Dina routes to a better agent.

### Design Notes: Future Action Layer Features

**Emotional state awareness (Phase 2+).** Before approving large purchases or high-stakes communications, a lightweight classifier assesses user state (time of day, communication tone, spending pattern deviation). Flags "user may be impulsive" and adds cooling-off suggestion.

**Content verification (Phase 2+).** C2PA/Content Credentials for media provenance. Cross-reference claims against Reputation Graph. Requires significant ML infrastructure.

**Anti-Her safeguard (Phase 2+).** If interaction patterns suggest user is treating Dina as emotional replacement for human relationships, Dina redirects: "You haven't talked to Sancho in a while." Heuristic-based, tracks frequency/content/time-of-day. Architectural enforcement of the Four Laws.

**Open Economy (Phase 3+).** Dina-to-Dina negotiation via ONDC, UPI/crypto payments. Cart Handover extends to discovery and direct commerce. Requires mature Reputation Graph and commerce protocol.

---

## Home Node ↔ Client Sync

The Home Node is the single source of truth. Devices are clients.

### The Model

```
                    HOME NODE
                  (source of truth)
                 ┌───────────────┐
                 │  SQLite Vault │
                 │  (complete)   │
                 └───┬───┬───┬──┘
                     │   │   │
           ┌─────────┘   │   └──────────┐
           ▼             ▼              ▼
      ┌─────────┐  ┌──────────┐  ┌───────────┐
      │ Phone   │  │ Laptop   │  │ Glasses   │
      │ (cache: │  │ (cache:  │  │ (no cache,│
      │ 6 months│  │ all)     │  │ live only)│
      └─────────┘  └──────────┘  └───────────┘
```

### Sync Protocol

**Rich client (phone, laptop) connecting to Home Node:**

```
CLIENT STARTUP:
  1. Authenticate to Home Node with device-delegated key (TLS + DIDComm)
  2. Send: "My last sync checkpoint was timestamp X"
  3. Home Node responds with all vault_items changed since X
  4. Client applies changes to local SQLite cache
  5. Client sends any locally-created items (e.g. WhatsApp captures) to Home Node
  6. Home Node applies and acknowledges
  7. Both are now in sync
```

```
ONGOING (while connected):
  - Home Node pushes new items to connected clients in real-time (WebSocket)
  - Client pushes locally-created items immediately
  - If connection drops, client queues changes and syncs on reconnect
```

```
THIN CLIENT (glasses, watch, browser):
  - No local cache
  - All queries go directly to Home Node
  - Authenticated WebSocket connection
  - Home Node streams responses
```

**Why this is simple:**
- No event log, no vector clocks, no CRDTs
- Home Node is authoritative — no conflict resolution for 95% of operations
- Client caches are SQLite replicas — if corrupted, re-sync from Home Node
- Adding a new device = authenticate + full sync

**The one conflict case:**
- Phone captures a WhatsApp message while offline
- Laptop creates a manual note while offline
- Both reconnect to Home Node
- **These are different items. No conflict.** Both get inserted.

If both devices somehow modify the SAME item while offline (rare — most data is append-only ingestion), the Home Node accepts the later-timestamped write and logs the earlier one as a recoverable version. The user can review conflicts in a simple "sync conflicts" view — but in practice, this almost never happens because ingested data is immutable and user-editable data (notes, preferences) is small and infrequently modified.

### What About Home Node Failure?

- **Planned backup:** Home Node takes encrypted snapshots of the full Vault to a blob store (S3, Backblaze, NAS). Configurable frequency (daily default).
- **Recovery:** Spin up a new Home Node instance, restore from latest snapshot, re-authenticate devices. Same as restoring a mail server from backup.
- **Rich clients have local caches.** If Home Node is down, you can still read your cached data, do local searches, and use on-device LLM. You just can't ingest new data from API connectors or receive Dina-to-Dina messages until the node is back.
- **Offline-capable rich clients** queue changes locally and push when Home Node is reachable again.

---

## Digital Estate

Configurable transfer of vault data upon owner's death or incapacitation.

### Pre-Configuration

Estate plan stored in Tier 0:

```json
{
    "estate_plan": {
        "trigger": "dead_mans_switch",
        "switch_interval_days": 90,
        "beneficiaries": [
            {
                "name": "Daughter",
                "dina_did": "did:plc:...",
                "receives": ["/persona/social", "/persona/health"],
                "access_type": "full_decrypt"
            },
            {
                "name": "Spouse",
                "dina_did": "did:plc:...",
                "receives": ["/persona/financial", "/persona/citizen"],
                "access_type": "full_decrypt"
            },
            {
                "name": "Colleague",
                "dina_did": "did:plc:...",
                "receives": ["/persona/professional"],
                "access_type": "read_only_90_days"
            }
        ],
        "default_action": "destroy"
    }
}
```

### Dead Man's Switch

Every N days (configurable, default 90), Dina asks: "Still here?" If the user doesn't respond after 3 attempts over 2 weeks:

1. Dina enters "estate mode"
2. Sends notification to designated beneficiaries
3. Generates per-beneficiary decryption keys (derived from root, limited to specified personas)
4. Delivers keys via Dina-to-Dina encrypted channel
5. Destroys remaining data per configuration

### Alternative Triggers
- Manual trigger by next-of-kin with physical recovery phrase + death certificate verification
- Multiple-beneficiary threshold (e.g., 2 of 3 beneficiaries attest to death)

---

## Architectural Decision: Why Not IPFS / Ceramic / Web3?

**Decision: SQLite for private data. AT Protocol for public data. No IPFS, no Ceramic, no blockchain for storage.**

| Data Type | Requirements | Tech |
|-----------|-------------|------|
| Emails, chats, contacts, health, financials | Private, fast, deletable | SQLite (Home Node) |
| Product reviews, outcome data, bot scores | Public, deletable by author, censorship-resistant | AT Protocol PDS + Reputation AppView |

### Why Not IPFS/Ceramic

1. **Pinning economics.** Data exists only while someone pins it. Paying a pinning service to keep data online reinvents a database with extra latency.
2. **Latency.** SQLite query: ~0.4ms. Ceramic/ComposeDB indexed query: 200-500ms best case. 500-1000x slower — unacceptable for real-time agent context lookups.
3. **Cannot guarantee deletion.** You can unpin from your node, but any other node that pinned your data retains it. GDPR Article 17 and India's DPDP Act require guaranteed deletion. IPFS architecturally cannot fulfill this.
4. **Permanent attack surface.** IPFS encrypted blobs persist indefinitely and are retrievable by anyone with the CID — a permanent target. SQLite on Home Node limits the attack surface to one server.
5. **Complexity.** IPFS daemon + Ceramic node + ComposeDB + PubSub + DID resolver + pinning service vs. Go + SQLite + llama.cpp.

### Where Web3 Does Belong

Blockchain has exactly one role: **timestamp anchoring.** Federated servers report timestamps, but a malicious operator can backdate entries. Periodic Merkle root hash anchoring to an L2 chain provides provable timestamps for dispute resolution. Phase 3 addition, not a dependency. See Layer 3 "Timestamp Anchoring" for full design.

**Boundary: private data → SQLite on Home Node. Public data → AT Protocol. Blockchain → timestamp anchoring only.**

---

## Architectural Decision: AT Protocol — Where It Fits and Where It Doesn't

**Decision: AT Protocol for the Reputation Graph (public layer). Independent protocol for messaging and vault (private layer).**

Dina uses `did:plc` (Bluesky's DID method) for identity. The question was whether to adopt the full AT Protocol stack (PDS, Relay, AppView, Lexicons) for more than just identity.

### What AT Protocol provides

AT Protocol is a federated protocol for public, signed, replicated data. Each user's data lives in a Personal Data Server (PDS) as a signed Merkle tree of records. Relays aggregate data from many PDSes into a unified firehose. AppViews consume the firehose and build application-specific indexes.

### Where it fits: Reputation Graph

The Reputation Graph is inherently public data — expert attestations, anonymized outcome reports, bot scores. AT Protocol is a natural fit:

- **Public data → public protocol.** Reputation records should be visible, discoverable, and verifiable. AT Protocol repos are all of these.
- **Signed Merkle repos.** Every record is part of a cryptographically signed tree. Operators can censor but not forge. Replication defeats censorship.
- **Federation for free.** Relays replicate data across the network. No need to build custom federation, sync, or discovery.
- **`did:plc` native.** Dina's identity method is AT Protocol's identity method. Zero integration work.
- **Custom Lexicons.** Schema-enforced records: `com.dina.reputation.attestation`, `com.dina.reputation.outcome`, `com.dina.reputation.bot`.
- **Ecosystem.** Any AT Protocol AppView can index Dina's Reputation Graph. Handles (`alice.dina.host`) provide human-readable discovery.

### Where it doesn't fit: Messaging and Vault

AT Protocol is fundamentally a **public data protocol**. All repository records are visible to relays and any consumer. The Bluesky team explicitly says private/encrypted content in repos is "not a good idea" and that private data is "an entire second phase of protocol development" — not built, not specified.

| Dina Requirement | AT Protocol Status |
|-----------------|-------------------|
| E2E encrypted messaging | Not supported. Explicitly discouraged in repos. |
| Private data vault | Not supported. All repo data is public. |
| Persona compartments | Not supported. One DID = one repo. |
| Per-record access control | Not supported. |
| P2P direct messaging | Not the model. Data routes through relays. |

For messaging and vault, Dina uses its own stack: libsodium encryption for Dina-to-Dina messages, SQLCipher for the encrypted vault, persona compartments as separate encrypted databases.

### The Home Node architecture

```
Home Node
├── dina-core (Go)      ← Private layer: encrypted vault, keys, DIDComm-shaped messaging
├── dina-brain (Python)  ← Private layer: reasoning, classification, agent orchestration
├── llama-server         ← Private layer: local LLM inference
└── dina-pds             ← Public layer: AT Protocol PDS for Reputation Graph only
```

The PDS runs alongside the private stack. It hosts only reputation data (`com.dina.reputation.*` Lexicons). Private data (messages, personal vault, persona compartments) never touches the AT Protocol stack.

### Precedent

This hybrid approach mirrors **Roomy** (Discord-like chat on AT Protocol) — which uses AT Protocol for identity and blob storage but builds its entire messaging/encryption infrastructure independently. It also mirrors **Groundmist Sync** — a local-first sync server linked to AT Protocol identity, using AT Protocol for optional publishing while keeping private data local.

---

## Technology Stack Summary

| Component | Technology | Why |
|-----------|-----------|-----|
| **Home Node (dina-core)** | | |
| Core runtime | Go + net/http (HTTP server) | Fast compilation, single static binary, excellent crypto stdlib, goroutines for concurrency |
| Database | SQLite + SQLCipher + FTS5 (via `mattn/go-sqlite3` with CGO) | Battle-tested, one encrypted file per persona, no separate DB server. SQLCipher provides transparent whole-database AES-256 encryption. |
| Vector search | Phase 1: vectors stored and queried in dina-brain (Python, sqlite-vec). Phase 2: sqlite-vec in core via CGO. | Brain handles embeddings initially; core handles structured/FTS queries. Clean separation. |
| PII scrubbing (hot path) | Regex + calls to llama-server | Fast path in Go, LLM fallback for ambiguous cases |
| Client ↔ Node protocol | Authenticated WebSocket (TLS + device-delegated key) | Encrypted channel, device key proves identity |
| Home Node ↔ Home Node | Phase 1: libsodium `crypto_box_seal` (ephemeral sender keys) + DIDComm-shaped plaintext. Phase 2: full JWE (ECDH-1PU). Phase 3: Noise XX sessions for full forward secrecy. | Sender FS from day one. Full FS in Phase 3. Plaintext format is DIDComm-compatible throughout — migration is encryption-layer only. |
| **Home Node (dina-brain)** | | |
| Brain runtime | Python + Google ADK (v1.25+, Apache 2.0) | Model-agnostic agent framework, multi-agent orchestration |
| Local LLM inference | llama-server (llama.cpp) + Gemma 3n GGUF | OpenAI-compatible API, CPU inference, shared by core and brain |
| Function calling | FunctionGemma 270M (GGUF) via llama-server | 529MB, fast structured tool routing |
| Cloud LLM (optional) | User's choice (Claude, Gemini, GPT-4, self-hosted) | For complex reasoning tasks, goes through PII scrubber |
| Agent orchestration | Google ADK Sequential/Parallel/Loop agents | Multi-step reasoning, tool calling with retries |
| External agent integration | MCP (Model Context Protocol) | Connect to OpenClaw and other action agents |
| Embeddings | EmbeddingGemma (308M, Phase 1), Nomic Embed V2 (Phase 2) | <200MB RAM, 100+ languages, Matryoshka dims |
| **Container orchestration** | | |
| Development | docker-compose (4 containers: core, brain, llama-server, pds) | One-command startup, clean separation |
| Managed hosting | docker-compose or Fly.io | Same containers, orchestrated by hosting operator |
| **Identity & Crypto** | | |
| Identity | W3C DIDs (`did:plc` via PLC Directory) | Open standard, globally resolvable, key rotation, 30M+ identities, Go implementation available. Escape hatch: rotation op to `did:web`. |
| Key management | SLIP-0010 HD derivation (Ed25519), BIP-39 mnemonic | Proven, Ed25519-compatible |
| Vault encryption | SQLCipher (AES-256-CBC per page, transparent) | Whole-database encryption for persona vaults. FTS5/sqlite-vec indices encrypted transparently. |
| Wire encryption (Phase 1) | libsodium: X25519 + XSalsa20-Poly1305 (`crypto_box_seal`) | Ephemeral sender keys, ISC license, available in every language |
| Wire encryption (Phase 3) | Noise XX: X25519 + ChaChaPoly + SHA256 | Full forward secrecy for always-on Home Node sessions |
| Key wrapping / archive | AES-256-GCM, X25519, Ed25519 | Industry standard for key wrapping, archive snapshots |
| Identity key derivation | SLIP-0010 (hardened Ed25519 HD paths) | Ed25519-compatible, no unsafe public derivation. Go: `stellar/go/exp/crypto/derivation` |
| Vault key derivation | HKDF-SHA256 (from persona key, domain-separated) | Symmetric keys for SQLCipher, independent per persona per tier |
| Key storage (Home Node) | Key Wrapping: Passphrase → Argon2id (KEK) → AES-256-GCM wraps Master Key (DEK) | Standard key wrapping. Passphrase change re-wraps DEK without re-encrypting database. |
| Key storage (client) | Secure Enclave (iOS), StrongBox (Android), TPM (desktop) | Hardware-backed where available |
| **Client Devices** | | |
| Android client | Kotlin + Jetpack Compose | Native Android, NotificationListener for WhatsApp |
| iOS client | Swift + SwiftUI (Phase 3) | Limited — no NotificationListener equivalent |
| Desktop client | Tauri 2 (Rust + WebView, v2.10+) or Wails (Go + WebView) | Cross-platform, tiny binaries, native performance |
| On-device LLM (rich clients) | LiteRT-LM (Android), llama.cpp (desktop) | Latency-sensitive tasks: quick classification, offline drafting |
| Thin clients (glasses, watch) | Web-based via authenticated WebSocket | No local processing, streams from Home Node |
| **Infrastructure** | | |
| DID resolution | PLC Directory (`did:plc`), `did:web` escape hatch | `did:plc`: proven at 30M+ scale, key rotation, Go implementation (`bluesky-social/indigo`). `did:web`: sovereignty escape if PLC Directory becomes adversarial — rotation op transitions transparently. |
| Push to clients | FCM/APNs (Phase 1), UnifiedPush (Phase 2) | Wake clients when Home Node has updates |
| Backup | Any blob storage (S3, Backblaze, NAS) | Encrypted snapshots of Home Node vault |
| Reputation Graph | AT Protocol PDS + Relay + AppView. Custom Lexicons (`com.dina.reputation.*`). Signed tombstones for deletion. L2 Merkle root anchoring (Phase 3) for timestamp proofs. | AT Protocol provides federation, signed Merkle repos, `did:plc` identity, and ecosystem SDKs. Reputation data is public — AT Protocol's public-by-design model is the right fit. |
| ZKP | Semaphore V4 (PSE/Ethereum Foundation) | Production-proven (World ID), off-chain proof generation |
| Serialization | JSON (Phase 1), MessagePack or Protobuf (Phase 2) | JSON is debuggable and sufficient for core↔brain traffic volume. Binary serialization deferred until profiling shows it matters. |
| Containerization | Docker + docker-compose | Single-command Home Node deployment: `docker compose up -d` |
| **Observability** | | |
| Health probes | `/healthz` (liveness), `/readyz` (readiness) | Docker kills and restarts zombie containers automatically |
| Logging | Go `slog` + Python `structlog` → JSON to stdout | No file logs; Docker log rotation handles retention |
| Self-healing | `restart: always` + healthcheck + dependency chain | Brain waits for core; all containers auto-recover |
| **Data Safety** | | |
| Database config | WAL mode + `synchronous=NORMAL` | Crash-safe atomic writes |
| Migration safety | `VACUUM INTO` + `PRAGMA integrity_check` | Pre-flight snapshot before every schema change |
| File system (managed hosting) | ZFS or Btrfs | Copy-on-write snapshots every 15 min |
| Off-site backup | Encrypted snapshots to S3/Backblaze | Covers disk failure, theft |
| Deep archive (Tier 5) | AWS Glacier Deep Archive (Object Lock) or physical drive | Immutable cold storage — survives ransomware |
| **Managed Hosting** | | |
| Tenancy model | One SQLite file per user | OS-level isolation, trivial portability, true right-to-delete |
| Confidential computing | AWS Nitro Enclaves / AMD SEV-SNP / Intel TDX | Operator cannot read enclave memory, even with root access |
| System database | SQLite or Postgres (tiny) | Routing, auth, billing only — no personal data |

---

## Infrastructure Layer

### Home Node Deployment

The Home Node runs four containers orchestrated by docker-compose: dina-core (Go/net/http — vault, keys, encrypted messaging), dina-brain (Python/Google ADK — agent reasoning), llama-server (llama.cpp — local LLM), and dina-pds (AT Protocol PDS — public Reputation Graph). No separate database server, no Kubernetes.

**The docker-compose stack:**
- dina-core: Go binary + SQLCipher vaults (one encrypted file per persona) — **private layer**
- dina-brain: Python + Google ADK agent loop — **private layer**
- llama-server: llama.cpp + Gemma 3n GGUF model — **private layer**
- dina-pds: AT Protocol PDS for Reputation Graph — **public layer** (reputation data only)
- Input: `VAULT_PASSPHRASE` (env var or passed via client device at startup)
- Output: Encrypted messaging endpoint + WebSocket API for clients + AT Protocol firehose
- Deployment: `docker compose up -d`

**Minimum requirements:**
- 4GB RAM (Gemma 3n E2B quantized + Python brain + Go core)
- 2 CPU cores
- 10GB storage (grows with vault size)
- Always-on internet connection
- No GPU required

### LLM Inference

| Where | Runtime | Model | Use Cases |
|-------|---------|-------|-----------|
| Home Node | llama.cpp (GGUF) | Gemma 3n E2B (default), E4B (if RAM allows) | PII scrubbing, context injection, drafting, summarization, Dina-to-Dina response generation |
| Home Node | llama.cpp (GGUF) | FunctionGemma 270M | Fast intent classification, query routing, connector orchestration |
| Home Node | llama.cpp (GGUF) | EmbeddingGemma 308M | Embedding generation for Tier 2 Index |
| Home Node | Cloud API (optional) | Gemini / Claude / GPT-4 | Complex multi-step reasoning (scrubbed through PII layer first) |
| Android client | LiteRT-LM | Gemma 3n E2B | Offline drafting, quick replies, on-device search |
| Desktop client | llama.cpp | Gemma 3n E2B | Same as Android — latency-sensitive local tasks |
| Thin client | None | None | All inference routed to Home Node |

### Client Authentication

Rich and thin clients authenticate to the Home Node using device-delegated keys:

```
DEVICE ONBOARDING:
  1. User opens Dina client on new device
  2. Scans QR code displayed by existing authenticated device (or enters pairing code)
  3. Home Node generates a device-specific keypair (delegated from root)
  4. Device stores its key in hardware security module (Secure Enclave / StrongBox / TPM)
  5. Home Node registers device in allowed-devices list
  6. All subsequent communication: TLS + device-key mutual authentication
```

### Push Notifications (Home Node → Client)

When the Home Node has new data (ingested email, incoming Dina-to-Dina message, scheduled reminder), how does the client find out?

**While connected:** WebSocket push — instant.

**While disconnected:**
- Android: Firebase Cloud Messaging (FCM) — Phase 1
- iOS: Apple Push Notification Service (APNs) — Phase 1
- Android (Phase 2): UnifiedPush (self-hosted, no Google dependency)
- Push payload contains NO data — just "wake up and connect to your Home Node"

### Hardware Security Module APIs

| Platform | API | Key Operations |
|----------|-----|---------------|
| Android | Android Keystore API (StrongBox-backed) | Key generation, signing (Ed25519), key agreement (X25519). `setIsStrongBoxBacked(true)`. |
| iOS | Security Framework + Secure Enclave | `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave`. |
| Desktop | TPM 2.0 via `tpm2-tss` (Linux), CryptoAPI: NCrypt (Windows), Secure Enclave (macOS) | Falls back to encrypted keyfile if no TPM. |
| Home Node (VPS) | Key-wrapped Master Key (Argon2id KEK → AES-256-GCM) | No hardware security on most VPS. Compensated by full-disk encryption + process isolation. |

### What We Explicitly Don't Need

| Technology | Why Not |
|-----------|---------|
| **Kafka / RabbitMQ / NATS** | Message brokers for millions of events/sec across clusters. Dina is one person, ~1000 events/day. SQLite IS the event processor. |
| **Redis** | In-memory cache for server workloads. Dina's data is already in SQLite on the Home Node. No separate cache needed. |
| **PostgreSQL / MySQL** | Server databases designed for multi-tenant workloads. SQLite is the right database for a single-user personal agent. |
| **Kubernetes** | Container orchestration for distributed services. Dina's Home Node is three containers on one machine. `docker compose up` is the entire deployment. |
| **GraphQL** | API layer for complex multi-consumer APIs. Dina has one consumer: you. Direct SQLite queries from the agent loop. |
| **Elasticsearch** | Distributed search cluster. SQLite FTS5 + sqlite-vec handles search for a single user's data. |
| **Blockchain (L1)** | Gas costs, latency, complexity. Immutability violates sovereignty (right to delete). Federated servers + signed tombstones handle the Reputation Graph. Only use case is L2 Merkle root hash anchoring for timestamp proofs (Phase 3). |
| **CRDTs / Automerge** | Designed for peer-to-peer conflict resolution. With a Home Node as source of truth, client-server sync is simpler and sufficient. May reconsider for Phase 3 if we add collaborative features. |

Guiding principle: **one user, three containers, one machine, one SQLite file per persona, one always-on endpoint.**

---

## What's Hard (Honest Assessment)

**1. WhatsApp ingestion.** Still the weakest link. NotificationListener on Android is fragile, and now the captured data has to travel from phone to Home Node. More moving parts, same underlying problem. No real API. May never be fully solved without regulation.

**2. Managed hosting operations.** Running a hosted service requires: regulatory compliance (GDPR, DPDP Act), security operations, incident response, billing. The protocol creator should not be the hosting operator (separation of concerns).

**3. Home Node LLM quality on cheap hardware.** Gemma 3n E2B on a $5 VPS (CPU-only, ~2 vCPU) runs at ~5-10 tok/sec. Adequate for background tasks (ingestion, PII scrubbing, embeddings). Not great for interactive chat. Rich clients with on-device LLMs handle interactive use. Cloud LLM API is the escape valve.

**4. ZKP for government ID.** No government currently offers ZKP-native verification. The first implementation will be a compromise (local verification, attestation stored).

**5. Reputation Graph cold start.** The first review bot helps. But outcome data needs scale. This is a years-long build.

**6. iOS restrictions.** No NotificationListenerService equivalent. No Accessibility Service. iOS client will always be more limited for device-local ingestion. But with Home Node running API connectors (Gmail, Calendar, Contacts), iOS users still get most functionality. WhatsApp ingestion requires an Android device somewhere in the ecosystem.

**7. Key management UX.** Asking normal people to write down 24 words on paper is a known failure mode in crypto. Most people will lose them. Better UX needed (social recovery? hardware backup?) but security trade-offs are real.

**8. Home Node security surface.** An always-on server with your encrypted data is a target. Must be hardened: automatic updates, minimal attack surface (three containers, no open ports except DIDComm endpoint), fail2ban-style rate limiting, encrypted at rest. If the VPS is compromised, the attacker gets encrypted blobs they can't read — but they can DoS your Dina.

**9. Data corruption in sovereign model.** No SRE team to restore the database. A bug that corrupts a persona vault file means loss of that persona's memory. The 5-level corruption immunity stack (WAL → pre-flight snapshots → ZFS → off-site backup → Tier 5) addresses this, but must be implemented from Day 1.

---

## Current State (v0.4) → Target Architecture

> **Version note:** The README uses phase-based versioning (v0.1 Eyes, v0.2 Voice, v0.3 Identity, v0.4 Memory). This section refers to the entire current monolith as "v0.4" — the state at the end of the Memory phase, before the rewrite into the three-container sidecar architecture.

### What Works Today

| Capability | Implementation | Target Layer |
|-----------|---------------|-------------|
| YouTube product review analysis | Gemini video analysis + transcript extraction → structured verdict (BUY/WAIT/AVOID) | Layer 5 (Bot Interface) — first review bot |
| Semantic memory | Local vector database at `~/.dina/memory/`, persists across sessions | Layer 1 (Storage) — Tier 2 Index |
| RAG-powered Q&A | Natural language → search memory → contextual answer | Layer 6 (Intelligence) |
| Cryptographic signing | Ed25519 signature on every verdict, `/verify` command | Layer 0 (Identity) |
| Self-sovereign identity | did:key (pure Python) + did:plc (target) | Layer 0 (Identity) |
| Decentralized vault | Dual-write to Ceramic Network (when configured) | Layer 1 (Storage) — will migrate to federated Reputation Graph |
| Multi-provider LLM | Ollama (local) + Gemini (cloud), configurable routing | Layer 6 (Intelligence) |
| REPL interface | `/history`, `/search`, `/identity`, `/verify`, `/vault`, `/quit` | Human Interface |

### Migration Path

v0.4 is a monolithic Python application. The target is the three-container sidecar architecture. The migration is incremental:

1. **Phase 1a (now → 6 weeks):** Extract the agent reasoning logic from v0.4 into dina-brain running on Google ADK. The YouTube review bot, memory search, and RAG become ADK tools. The REPL becomes a thin client that talks to the brain.

2. **Phase 1b (parallel):** Build dina-core in Go. Start with the SQLite vault skeleton, DID key management (porting the Ed25519/did:key logic from Python to Go), and the internal API (`/v1/vault/query`, `/v1/vault/store`, `/v1/did/sign`). Go's standard library `crypto/ed25519` and `crypto/aes` handle the cryptography natively.

3. **Phase 1c (integration):** Wire dina-brain to call dina-core's API instead of managing its own storage. Add llama-server container. `docker-compose up` runs all three.

4. **v0.4 retirement:** Once the sidecar architecture handles everything v0.4 does, the monolithic REPL is deprecated. Its code lives on as reference.

---

## Phase 1 Scope (What Gets Built First)

```
DINA-CORE (Go + net/http):
  ✓ HTTP server exposing internal API (/v1/vault/*, /v1/did/*, /v1/pii/*)
  ✓ SQLite vault (Tier 0 + Tier 1 + Tier 4)
  ✓ WAL mode + synchronous=NORMAL (default config, non-negotiable)
  ✓ Pre-flight snapshot on every update (VACUUM INTO + integrity_check)
  ✓ Encrypted messaging endpoint (libsodium crypto_box_seal + DIDComm-shaped plaintext, always-on)
  ✓ WebSocket server for client connections
  ✓ Client authentication (device-delegated keys)
  ✓ PII scrubber (regex hot path + llama-server fallback)
  ✓ Connector scheduler (triggers brain on new data)
  ✗ Managed hosting infrastructure (Phase 1.5 — multi-tenant, one SQLite per user)
  ✗ Confidential computing / Nitro Enclaves (Phase 2-3)

DINA-BRAIN (Python + Google ADK):
  ✓ Guardian angel reasoning loop
  ✓ Silence filter / interrupt classification
  ✓ Context assembly for whispers
  ✓ YouTube review bot (ported from v0.4)
  ✓ Semantic memory search (ported from v0.4)
  ✓ LLM routing: local (llama-server) vs cloud (Claude/Gemini)
  ✓ MCP integration for external agents (OpenClaw)
  ✗ Multi-agent orchestration (Phase 2)
  ✗ Emotional state awareness (Phase 2)

LLAMA-SERVER:
  ✓ Gemma 3n E2B GGUF model
  ✓ OpenAI-compatible API (shared by core and brain)
  ✓ FunctionGemma 270M for routing (Phase 1.5)

DOCKER-COMPOSE:
  ✓ Four-container orchestration (core + brain + llama-server + pds)
  ✓ Internal network (containers talk on localhost)
  ✓ Single `docker compose up -d` deployment
  ✓ Healthchecks on all containers (/healthz, /readyz)
  ✓ Dependency chain (brain waits for core healthy, pds independent)
  ✓ `restart: always` with automatic recovery on failure

OBSERVABILITY:
  ✓ Structured JSON logging (Go slog, Python structlog) to stdout
  ✓ No file logs (Docker log rotation handles retention)
  ✗ Dozzle/Loki log viewer (optional, Phase 2)

Layer 0: Identity
  ✓ Root key generation + key-wrapped storage on Home Node (Argon2id KEK → AES-256-GCM)
  ✓ BIP-39 recovery
  ✓ DID generation (did:plc via PLC Directory, did:web as escape hatch)
  ✓ Two personas: /consumer and /social
  ✓ Device-delegated keys for client authentication
  ✗ ZKP credentials (Phase 2)

Layer 1: Storage  
  ✓ Tier 0 (Identity Vault on Home Node)
  ✓ Tier 1 (Vault with SQLite + FTS5 on Home Node)
  ✓ Tier 4 (Staging)
  ✓ Client cache sync protocol (checkpoint-based)
  ✓ Off-site encrypted backup to blob storage (S3/Backblaze)
  ✗ Tier 2 (Index with embeddings — Phase 2)
  ✗ Tier 3 (Reputation — Phase 2)
  ✗ Tier 5 Deep Archive with Object Lock (Phase 2)

Layer 2: Ingestion (runs on Home Node)
  ✓ Gmail connector (read-only, OAuth)
  ✓ Calendar connector (CalDAV)
  ✓ Contacts connector (CardDAV)
  ✗ WhatsApp connector on Android client → push to Home Node (Phase 1.5)

Layer 6: Intelligence (runs in dina-brain + dina-core)
  ✓ PII scrubber — regex in core, LLM fallback via llama-server
  ✓ FTS5 search (core)
  ✓ Context injection via Gemma 3n E2B (brain)
  ✓ Silence filter / interrupt classification (brain)
  ✓ Guardian angel reasoning loop (brain, Google ADK)
  ✗ Fine-tuned PII model (Phase 2)
  ✗ Embedding generation / Tier 2 Index (Phase 2)

Layer 5: Bot Interface
  ✓ First Review Bot (your build)
  ✓ Simple query/response protocol
  ✗ Full bot discovery (Phase 2)

Layer 7: Action Layer
  ✓ Draft-don't-send (Gmail — via Home Node)
  ✓ Cart Handover (UPI deep links — via client device)
  ✓ OpenClaw delegation via MCP (basic task handoff)
  ✗ Emotional state awareness / purchase hold (Phase 2)
  ✗ Content verification / C2PA (Phase 2+)

Layer 4: Dina-to-Dina
  ✓ DID exchange via QR code
  ✓ PLC Directory endpoint resolution (points to Home Node)
  ✓ Encrypted messaging (libsodium crypto_box_seal, sender forward secrecy)
  ✓ DIDComm-compatible plaintext format (id, type, from, to, created_time, body)
  ✓ Simple relay forwarding for NAT situations
  ✗ Full DIDComm v2 JWE wire compatibility (Phase 2)
  ✗ Noise XX sessions for full forward secrecy (Phase 3)
  ✗ Sharing rules enforcement (Phase 2)

Layer 3: Reputation Graph (AT Protocol)
  ✓ AT Protocol PDS running alongside Home Node
  ✓ Custom Lexicons: com.dina.reputation.attestation, com.dina.reputation.outcome
  ✓ Federation via AT Protocol Relay
  ✓ Local bot reputation tracking
  ✗ Reputation AppView (Phase 1.5 — separate service indexes the firehose)
  ✗ L2 Merkle root anchoring for timestamps (Phase 3)

CLIENT (Phase 1: Android only):
  ✓ Kotlin app — rich client
  ✓ Connect to Home Node via authenticated WebSocket
  ✓ Local vault cache (recent 6 months)
  ✓ On-device LLM (LiteRT-LM + Gemma 3n E2B) for offline/low-latency
  ✗ WhatsApp NotificationListener (Phase 1.5)
  ✗ Desktop client via Tauri (Phase 2)
  ✗ iOS client (Phase 3)
  ✗ Thin clients — glasses, watch, browser (Phase 3)
```

**Build order:**
1. llama-server — `docker run` with Gemma 3n (day 1, 5 minutes)
2. dina-brain — Python + Google ADK, guardian angel loop, port v0.4 review bot and memory into ADK tools (2-3 weeks)
3. dina-core — Go + net/http, SQLCipher vault skeleton (mattn/go-sqlite3), DID key management (crypto/ed25519), internal API (2-3 weeks, parallel with brain)
4. Wire together — docker-compose, core↔brain API integration, end-to-end Sancho moment flow (1 week)
5. Android client — Kotlin, connect to Home Node (Phase 1 follow-on)

**Timeline to working Sancho Moment:** 6-8 weeks from start.

**The product analogy:** Dina is Signal, not WordPress.
- Signal Foundation builds the protocol AND operates the servers. Users sign up and it works.
- Self-hosting Signal is possible (the server is open source) but almost nobody does it.
- Dina builds the protocol. A foundation operates the managed service. Self-hosters run the same binary.
- You own the content (your Vault). You choose the host. Zero lock-in.
- **But the default experience is: sign up, and your Dina is running. No Raspberry Pi required.**

---

## Build Roadmap

Every item below is sequenced by dependency — you can't build later items without earlier ones. Items within the same step can be built in parallel.

### ✅ Done (v0.4)

| # | Item | Layer | What It Is | Status |
|---|------|-------|-----------|--------|
| 0.1 | YouTube review analysis | L5 Bot Interface | Gemini video analysis → structured BUY/WAIT/AVOID verdict | ✅ Built |
| 0.2 | Semantic memory (vector DB) | L1 Storage | Local vector store at `~/.dina/memory/`, persists across sessions | ✅ Built |
| 0.3 | RAG-powered Q&A | L6 Intelligence | Natural language questions → memory search → contextual answer | ✅ Built |
| 0.4 | Cryptographic signing | L0 Identity | Ed25519 signature on every verdict, `/verify` command | ✅ Built |
| 0.5 | Self-sovereign identity | L0 Identity | did:key (pure Python) + did:plc (target) | ✅ Built |
| 0.6 | Ceramic dual-write | L1 Storage | Verdicts written to Ceramic Network when configured | ✅ Built |
| 0.7 | Multi-provider LLM routing | L6 Intelligence | Ollama (local) + Gemini (cloud), configurable | ✅ Built |
| 0.8 | REPL interface | Human Interface | `/history`, `/search`, `/identity`, `/verify`, `/vault`, `/quit` | ✅ Built |

### Phase 1a — Sidecar Foundation (Weeks 1-3)

Goal: Get the three-container architecture running. Brain thinks, core stores, llama-server infers.

| # | Item | Layer | What It Is | Depends On | Container |
|---|------|-------|-----------|-----------|-----------|
| 1.1 | llama-server setup | Infra | Docker container running Gemma 3n E2B GGUF, OpenAI-compatible API on port 8300 | Nothing | llama-server |
| 1.2 | dina-brain skeleton | L6 Intelligence | Python + Google ADK, basic agent loop, `/v1/process` and `/v1/reason` endpoints on port 8200 | 1.1 | dina-brain |
| 1.3 | Port review bot to ADK tool | L5 Bot Interface | YouTube analysis as a Google ADK tool callable by the agent loop | 1.2 | dina-brain |
| 1.4 | Port memory search to ADK tool | L6 Intelligence | Vector search + RAG as ADK tools | 1.2 | dina-brain |
| 1.5 | Silence filter (basic) | L6 Intelligence | Three-priority classification (Fiduciary / Solicited / Engagement) using llama-server | 1.2, 1.1 | dina-brain |
| 1.6 | LLM routing in brain | L6 Intelligence | Simple → llama-server, Complex → Claude/Gemini API | 1.1, 1.2 | dina-brain |
| 1.7 | dina-core skeleton | L1 Storage | Go + net/http server on port 8100, SQLCipher vault (mattn/go-sqlite3 with CGO, one file per persona) with WAL mode, basic `/v1/vault/query` and `/v1/vault/store` endpoints | Nothing | dina-core |
| 1.8 | DID key management in core | L0 Identity | BIP-39 seed → Master Key (DEK), key wrapping (passphrase → Argon2id KEK → AES-256-GCM wraps DEK), SLIP-0010 persona key derivation (Ed25519), HKDF persona key → SQLCipher vault unlock. `/v1/did/sign` and `/v1/did/verify` endpoints. Go: `crypto/ed25519`, `x/crypto/argon2`, `stellar/go/exp/crypto/derivation`. | 1.7 | dina-core |
| 1.9 | PII scrubber (regex) | L6 Intelligence | Regex-based PII detection in Go (credit cards, phone numbers, Aadhaar, emails). `/v1/pii/scrub` endpoint. | 1.7 | dina-core |
| 1.10 | docker-compose wiring | Infra | Three-container orchestration. Internal network. Brain calls core API. Both call llama-server. Single `docker compose up -d`. Healthchecks (`/healthz`, `/readyz`) on all containers. Dependency chain: brain waits for core healthy. `restart: always`. Structured JSON logging (Go `slog`, Python `structlog`) to stdout. | 1.2, 1.7, 1.1 | All |

### Phase 1b — Guardian Angel Loop (Weeks 3-6)

Goal: Dina watches your world, stays quiet, and whispers when it matters. The Sancho Moment works end-to-end.

| # | Item | Layer | What It Is | Depends On | Container |
|---|------|-------|-----------|-----------|-----------|
| 1.11 | Gmail connector (read-only) | L2 Ingestion | OAuth read-only access, poll for new emails, store encrypted in vault via core API | 1.7, 1.10 | dina-core |
| 1.12 | Calendar connector | L2 Ingestion | CalDAV sync, store events in vault | 1.7, 1.10 | dina-core |
| 1.13 | Contacts connector | L2 Ingestion | CardDAV sync, store contacts in vault | 1.7, 1.10 | dina-core |
| 1.14 | Connector scheduler | L2 Ingestion | Cron-style polling: check Gmail every 15 min (configurable), calendar every 30 min. Triggers brain on new data. | 1.11, 1.12, 1.13, 1.10 | dina-core |
| 1.15 | Context assembly for whispers | L6 Intelligence | Brain queries vault for relevant context (relationships, history), assembles whisper text | 1.10, 1.4 | dina-brain |
| 1.16 | Whisper delivery (WebSocket) | L7 Action | Core pushes whisper to connected client device via WebSocket. `/v1/notify` endpoint. | 1.15, 1.7 | dina-core |
| 1.17 | Encrypted messaging endpoint | L4 Dina-to-Dina | Always-on HTTPS endpoint on localhost:8443 (exposed to internet via ingress tier — Tailscale Funnel, Cloudflare Tunnel, or Yggdrasil). Receives encrypted messages from other Dinas. libsodium `crypto_box_seal` + DIDComm-shaped plaintext. | 1.8, 1.7 | dina-core |
| 1.18 | DID exchange (QR code) | L4 Dina-to-Dina | Generate QR code containing your DID. Scan another Dina's QR to establish connection. | 1.8, 1.17 | dina-core |
| 1.19 | Basic Dina-to-Dina messaging | L4 Dina-to-Dina | Send/receive encrypted messages between two Home Nodes. Sender FS via ephemeral keys. DIDComm-compatible plaintext format. | 1.17, 1.18 | dina-core |
| 1.20 | **The Sancho Moment (E2E)** | All | Sancho's Dina sends "leaving home" → your core receives → brain checks vault for Sancho context → brain assembles whisper ("his mother was ill, put the kettle on") → core pushes to your phone. | 1.19, 1.15, 1.16 | All |

### Phase 1c — Safety & Persistence (Weeks 6-8)

Goal: Data is safe. Actions go through approval gates. Bot protocol is standardized.

| # | Item | Layer | What It Is | Depends On | Container |
|---|------|-------|-----------|-----------|-----------|
| 1.21 | Pre-flight snapshots | L1 Storage | `VACUUM INTO` + `PRAGMA integrity_check` before every schema migration | 1.7 | dina-core |
| 1.22 | Off-site encrypted backup | L1 Storage | Encrypted vault snapshot pushed to S3/Backblaze on schedule | 1.7, 1.8 | dina-core |
| 1.23 | BIP-39 recovery | L0 Identity | Generate 24-word mnemonic from root key. Restore identity from mnemonic. | 1.8 | dina-core |
| 1.24 | Persona system (basic) | L0 Identity | Two personas: `/consumer` and `/social`. Separate cryptographic compartments. | 1.8 | dina-core |
| 1.25 | Draft-Don't-Send (Gmail) | L7 Action | Brain drafts email reply → stored in Tier 4 (Staging) → user reviews in Gmail → user presses Send. Dina NEVER calls `messages.send`. | 1.11, 1.15 | dina-brain + core |
| 1.26 | Cart Handover (basic) | L7 Action | Brain assembles payment intent (UPI deep link). Stored in Tier 4. User taps to pay. Dina never touches money. | 1.15, 1.7 | dina-brain + core |
| 1.27 | Bot response protocol | L5 Bot Interface | Standardized JSON response format with mandatory `creator_name`, `source_url`, `deep_link` attribution fields. | 1.3 | dina-brain |
| 1.28 | Local bot reputation tracking | L3 Reputation | Track bot accuracy, response time, uptime locally. Route to better bots when quality drops. | 1.27 | dina-brain |
| 1.29 | Client authentication | Infra | Device-delegated keys. Client scans QR code → Home Node registers device → all communication over TLS + DIDComm mutual auth. | 1.8, 1.17 | dina-core |

### Phase 1.5 — Client & Managed Hosting (Weeks 8-16)

| # | Item | Layer | What It Is | Depends On | Container/Platform |
|---|------|-------|-----------|-----------|-------------------|
| 1.30 | Android client (basic) | Client | Kotlin + Jetpack Compose app. Connects to Home Node via WebSocket. Displays whispers, notifications, daily briefing. | 1.16, 1.29 | Android |
| 1.31 | Android local vault cache | Client | SQLite cache of recent 6 months. Offline search. Checkpoint-based sync with Home Node. | 1.30 | Android |
| 1.32 | Android on-device LLM | Client | LiteRT-LM + Gemma 3n E2B for offline classification, quick replies. | 1.30 | Android |
| 1.33 | Managed hosting infra | Infra | Multi-tenant hosting. One SQLite per user. Sign-up flow. Billing ($5-10/month). | 1.10, 1.29 | Server |
| 1.34 | FunctionGemma 270M routing | L6 Intelligence | Ultra-lightweight model (529MB) for fast intent classification and tool routing. Runs alongside Gemma 3n on llama-server. | 1.1 | llama-server |
| 1.35 | WhatsApp connector (Android) | L2 Ingestion | NotificationListenerService captures WhatsApp notifications → pushes to Home Node via authenticated channel. | 1.30, 1.29 | Android |
| 1.36 | MCP integration (OpenClaw) | L7 Action | Delegate tasks to OpenClaw via MCP. License renewal, form filling, task automation — all with `draft_only` constraint. | 1.25 | dina-brain |
| 1.37 | Daily briefing | L6 Intelligence | End-of-day summary of Priority 3 items. "Here's what you missed that wasn't important enough to interrupt." | 1.5, 1.15 | dina-brain |
| 1.38 | Push notifications (FCM/APNs) | Infra | When client is disconnected, wake it via FCM/APNs. Payload contains NO data — just "connect to your Home Node." | 1.16, 1.30 | dina-core + client |

### Phase 2 — Intelligence & Trust (Months 4-9)

| # | Item | Layer | What It Is | Depends On |
|---|------|-------|-----------|-----------|
| 2.1 | Embedding generation (EmbeddingGemma) | L1 Storage | 308M param model generates embeddings. Stored in Tier 2 Index via sqlite-vec. Enables semantic search across all vault data. | 1.7, 1.1 |
| 2.2 | Tier 2 Index (embeddings) | L1 Storage | sqlite-vec vector store alongside SQLite FTS5. Hybrid search: keyword + semantic. | 2.1 |
| 2.3 | Reputation AppView | L3 Reputation | AT Protocol AppView indexes `com.dina.reputation.*` records from the relay firehose. Query API for attestations, outcomes, bot scores. | 1.28 |
| 2.4 | Outcome data collection | L3 Reputation | Dina tracks purchases via Cart Handover. Months later, gently asks "How's that chair?" Anonymized outcome → Reputation Graph. | 1.26, 2.3 |
| 2.5 | Trust Rings (Ring 1-2) | L0 Identity | Ring 1 (unverified) = anyone. Ring 2 (verified unique person) = ZKP or external verification. Higher rings get more trust weight. | 1.24, 2.3 |
| 2.6 | Fine-tuned PII model | L6 Intelligence | Gemma 3n E4B fine-tuned for PII detection. Replaces generic NER prompting. Higher accuracy, fewer leaks. | 1.9, 1.1 |
| 2.7 | Multi-agent orchestration | L6 Intelligence | Google ADK Sequential, Parallel, Loop agents. Complex multi-step reasoning (e.g., research laptop → check reputation → compare prices → assemble recommendation). | 1.2 |
| 2.8 | Emotional state awareness | L7 Action | Lightweight classifier flags "user may be upset/impulsive" before large purchases or high-stakes communications. Cooling-off suggestion. | 1.15, 2.1 |
| 2.9 | Anti-Her safeguard | L7 Action | Track interaction patterns. If user treats Dina as emotional replacement, redirect: "You haven't talked to Sancho in a while." | 1.19, 1.15 |
| 2.10 | Bot discovery (decentralized) | L5 Bot Interface | Bots self-register on Reputation Graph. Reputation determines visibility. Bot-to-bot referrals. | 2.3 |
| 2.11 | Dina-to-Dina sharing rules | L4 Dina-to-Dina | Fine-grained control over what each connection can see. "Sancho's Dina can see my location, but not my calendar." Per-connection permissions. | 1.19, 1.24 |
| 2.12 | Desktop client (Wails/Tauri) | Client | Cross-platform desktop app via Wails (Go + WebView) or Tauri 2. Connects to Home Node same as Android. | 1.29 |
| 2.13 | Tier 5 Deep Archive | L1 Storage | Weekly encrypted snapshots to S3 Glacier Deep Archive with Compliance Mode Object Lock. Immutable. Survives ransomware. | 1.22 |
| 2.14 | UnifiedPush (de-Googled) | Infra | Self-hosted push notification relay. Replaces FCM for users who don't want Google dependency. | 1.38 |
| 2.15 | Nomic Embed V2 (upgrade) | L1 Storage | 475M MoE embedding model. Better retrieval quality for complex queries. Drop-in replacement for EmbeddingGemma. | 2.1 |
| 2.16 | Confidential Computing (pilot) | Infra | AWS Nitro Enclaves / AMD SEV-SNP for managed hosting. Remote attestation proves unmodified binary. Eliminates honeypot problem at hardware level. | 1.33 |

### Phase 3 — Open Economy & Scale (Months 9-18+)

| # | Item | Layer | What It Is | Depends On |
|---|------|-------|-----------|-----------|
| 3.1 | Trust Rings (Ring 3+) | L0 Identity | Credential anchors: LinkedIn, GitHub, business registration. Transaction history + time + peer attestation → composite trust score. | 2.5 |
| 3.2 | Content verification (C2PA) | L7 Action | Media provenance via Content Credentials. Cross-reference claims against Reputation Graph. "This video appears AI-generated." | 2.3 |
| 3.3 | Social Radar (real-time co-pilot) | L6 Intelligence | "You've interrupted him twice." Context Injection from camera/microphone (glasses, phone). Requires on-device processing. | 2.7, 1.32 |
| 3.4 | Open Economy (ONDC + UPI) | L7 Action | Dina negotiates directly with manufacturer's Dina via ONDC. UPI/crypto for payment. Marketplace middlemen become optional. | 2.3, 1.26, 1.19 |
| 3.5 | Expert Bridge | L3 Reputation | Verified experts opt in to having their knowledge structured. Attribution + economic value when their knowledge drives decisions. | 2.3, 1.27 |
| 3.6 | Direct value exchange | L3 Reputation | Creators earn when their reviews drive purchases. Truth pays better than clicks. Micropayments via UPI/crypto. | 3.5, 3.4 |
| 3.7 | iOS client | Client | Swift + SwiftUI. More limited than Android (no NotificationListener). Home Node API connectors compensate. | 1.29 |
| 3.8 | Thin clients (glasses, watch, browser) | Client | Web-based via authenticated WebSocket. No local processing. Streams from Home Node. | 1.29, 1.16 |
| 3.9 | Foundation formation | Org | Nonprofit foundation takes over managed hosting operations. Multiple certified hosting partners across jurisdictions. | 1.33, 2.16 |
| 3.10 | Full Dina-to-Dina commerce protocol | L4 Dina-to-Dina | Buyer Dina ↔ Seller Dina negotiation, reputation check, payment intent, delivery tracking — all sovereign. | 3.4, 2.11, 3.1 |
| 3.11 | Timestamp anchoring (L2) | L3 Reputation | Weekly Merkle root hash of all Reputation Graph entries anchored to L2 chain. Provable "this existed before this date" for dispute resolution, anti-gaming, and Expert Bridge economics. | 2.3, 3.5 |

### Summary Timeline

| Phase | Duration | Milestone | What You Can Demo |
|-------|----------|-----------|------------------|
| **v0.4** | ✅ Done | Proof of concept | YouTube analysis with signed verdicts, memory, DID identity |
| **1a** | Weeks 1-3 | Sidecar running | Three containers up, brain reasons, core stores, review bot works via ADK |
| **1b** | Weeks 3-6 | Sancho Moment | Two Dinas talk, whisper delivered to phone, guardian angel loop end-to-end |
| **1c** | Weeks 6-8 | Safety & bots | Data backed up, drafts work, bot protocol standardized |
| **1.5** | Weeks 8-16 | Real product | Android app, managed hosting, WhatsApp ingestion, daily briefing |
| **2** | Months 4-9 | Intelligence | Semantic search across all data, Reputation Graph live, trust rings, desktop client |
| **3** | Months 9-18+ | Economy | Direct commerce via ONDC, expert marketplace, iOS, thin clients, foundation |

---

*This architecture is a living document. It will evolve as the protocol is implemented and real-world constraints are discovered.*