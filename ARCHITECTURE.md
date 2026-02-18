# Part III: Technical Architecture

This is the engineering blueprint for Dina. It covers every layer, every connection, every hard problem. Where choices are clear, they're stated. Where they're open, they're flagged.

---

## System Overview

Dina has eight layers. Each is independent and can be built, tested, and replaced separately.

### Core Philosophy: Dina is a Kernel, Not a Platform

**No internal plugins. No untrusted third-party code inside Dina's process. Ever.**

Dina is an orchestrator — she decides *what* needs to be done, but delegates *doing* it to specialized child agents. This is the "CEO vs. Contractor" model:

| | Dina (The CEO) | Child Agents (The Contractors) |
|---|---|---|
| **Role** | Holds intent, memory, identity, reputation | Specialized workers (browser, coding, travel, legal) |
| **Code** | Clean, minimal, high-security Go + Python | Whatever works — can crash without affecting Dina |
| **Security** | No third-party code in-process | Run in separate containers or servers |
| **Protocol** | Issues tasks, verifies results | Executes and reports back |

**Two external protocols, no plugin API:**

- **Dina-to-Dina** (peer communication): NaCl `crypto_box_seal` over HTTPS
- **Dina-to-Agent** (task delegation to OpenClaw etc.): MCP (Model Context Protocol)

Both talk to external processes. Neither runs code inside Dina. Child agents cannot touch Dina's vault, keys, or personas — they receive task messages via MCP and return results. If a child agent gets compromised, it's just a misbehaving external process that Dina can disconnect.

**Why this matters for security:** The biggest attack surface in any system is third-party code. Plugins running inside your process can crash your vault, read across persona boundaries, or exfiltrate data. By refusing to run external code inside the process, entire categories of vulnerabilities are eliminated. A compromised child agent is contained — it can only respond to MCP calls, never initiate access to Dina's internals.

**Why this matters for architecture:** No plugin store to maintain, no plugin review process, no sandboxing, no scoped tokens, no plugin API versioning. The two-tier auth model (`BRAIN_TOKEN` + `CLIENT_TOKEN`) is the permanent design, not a stepping stone. NaCl (for peers) and MCP (for agents) are the only extension points.

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

### Dead Drop Ingress (Message Queuing While Locked)

**Problem:** "Sancho is 15 minutes away" has a 15-minute relevance window. If the Home Node just rebooted into Security mode (vault locked), the DIDComm endpoint rejects the message. The sender retries with exponential backoff. By the time the user wakes up and types their passphrase, the message is 6 hours old and useless.

**A locked door should not prevent the postman from sliding mail through the slot.** The message is already encrypted with Dina's public key — storing it on disk is safe because the private key needed to read it is locked inside the vault.

**The fix: decouple ingress from processing.**

```
DEAD DROP ARCHITECTURE:

  Ingress (HTTP listener) ← "dumb" and fast, runs 24/7
    │                        Does NOT need the vault key.
    │                        Writes encrypted blobs to disk.
    │                        Returns 202 Accepted immediately.
    │
    ▼
  ./data/inbox/             ← Flat file spool
    msg_abc123.blob            Encrypted with Dina's public key.
    msg_def456.blob            Safe on disk — no one can read them
    msg_ghi789.blob            without the private key.
    │
    ▼
  Inbox Sweeper (Worker)   ← Needs the vault key.
    │                        Runs on startup + after vault unlock.
    │                        Decrypts, checks TTL, processes.
    ▼
  SQLite Vault + Brain
```

**The workflow:**

1. **State:** Node is LOCKED (after reboot, Security mode).
2. **Event:** `POST /didcomm/inbox` arrives with "Sancho is leaving home."
3. **Action:** Ingress writes raw encrypted bytes to `./data/inbox/msg_123.blob`.
4. **Response:** Returns `202 Accepted` immediately. Sender's Dina thinks: delivered.
5. **State change:** User types passphrase. Vault UNLOCKS.
6. **Action:** Inbox Sweeper wakes up, reads `msg_123.blob`, decrypts with now-available key, checks TTL, processes normally.

**TTL (Time-To-Live) prevents zombie notifications:**

Since the outer envelope is encrypted, the ingress handler cannot see the TTL — it must accept everything. The Inbox Sweeper applies TTL logic after decryption:

```go
// After decrypting the message
if msg.Timestamp.Add(msg.TTL).Before(time.Now()) {
    log.Info("Message expired while queued, storing silently",
        "from", msg.From, "type", msg.Type, "age", time.Since(msg.Timestamp))
    storeAsExpired(msg) // Log to vault history, no user notification
    return
}
// Message still valid — process normally
processMessage(msg)
```

| Scenario | Message | Vault State | Result |
|----------|---------|-------------|--------|
| Normal operation | "Sancho leaving home" | Unlocked | Processed immediately, whisper delivered |
| Locked, unlocked within TTL | "Sancho leaving home" (TTL: 30 min) | Locked → Unlocked 10 min later | Processed, whisper delivered (still relevant) |
| Locked, unlocked after TTL | "Pizza arriving in 5 min" (TTL: 15 min) | Locked → Unlocked 3 hours later | Stored silently in history, no notification (expired news) |
| Convenience mode reboot | Any message | Auto-unlocked on boot | Processed immediately (no queuing needed) |

**Security:** The inbox spool (`./data/inbox/`) contains only encrypted blobs. An attacker with filesystem access sees the same thing they'd see in the vault — encrypted data they can't read. The blobs are cleaned up (deleted from spool) after successful processing.

### Why Not Serverless?

Serverless (Lambda + S3) doesn't work for Dina. SQLite on network storage corrupts under concurrent access. Cold starts take 30-60 seconds to load a 2GB LLM. Lambda can't maintain persistent WebSocket or DIDComm connections. Continuous polling (Gmail, Calendar, Dina-to-Dina messages) costs more on Lambda than an always-on container.

The right architecture is lightweight, always-on containers via `docker compose up -d` — 3 containers in Online Mode (core, brain, pds) or 5 in Offline Mode (+ llama-server + whisper-server).

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

See [`ADVANCED-SETUP.md`](ADVANCED-SETUP.md) for setup instructions per tier (networking) and Offline Mode, or [`QUICKSTART.md`](QUICKSTART.md) to get running in 3 commands.

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

### Security Model: The Brain is a Guest

**The brain is an untrusted tenant. It does not have rights; it only has capabilities granted by the core.**

Brain is a Python process with a massive dependency tree (Google ADK, httpx, llama-cpp-python). It's the most likely entry point for compromise — PyPI supply chain attacks, prompt injection that escapes the sandbox, deserialization bugs. Core must treat every request from brain the same way it treats a request from any external client: verify, authorize, log.

```
Brain requests data  →  Core checks the ACL (gatekeeper.go)  →

  If persona is "open":       serve immediately, log silently
  If persona is "restricted":  serve immediately, log + notify user in daily briefing
  If persona is "locked":      reject with 403. Brain must request unlock via
                                POST /v1/persona/unlock → core asks human →
                                human approves with TTL → core serves for that window
```

Think of it as filesystem permissions. You don't get a popup every time an app reads a file in its sandbox. You do get a popup when it tries to access your contacts for the first time. And it can never access your keychain without biometric auth. Same model.

**The key architectural insight:** brain never knows personas exist as separate databases. Brain says `POST /v1/vault/query {persona: "/financial", text: "tax"}` and core decides whether to serve, reject, or gate. The persona isolation is enforced entirely by `gatekeeper.go` in core, invisible to brain.

**What a compromised brain can do:** access open personas (social, consumer, professional) via `BRAIN_TOKEN`. That's it. It cannot touch locked personas (financial, citizen) without human approval. It cannot touch restricted personas (health) without creating a detection trail the user sees in their daily briefing. It cannot call admin endpoints (`did/sign`, `did/rotate`, `vault/backup`, `persona/unlock`) — `BRAIN_TOKEN` is rejected by `isAdminEndpoint()`. It cannot bypass the PII scrubber — that's a core-side gate. The damage radius of a compromised brain is limited to open persona data.

**Authentication: Two-tier static tokens, no JWTs.**

```
Two token types:

BRAIN_TOKEN (generated at boot, injected via Docker Secrets):
  ✓ vault/query, vault/store, pii/scrub, notify, msg/send,
    reputation/query, process, reason
  ✗ did/sign, did/rotate, vault/backup, persona/unlock, admin/*

CLIENT_TOKEN (per-device, issued during QR pairing):
  ✓ Everything — including admin endpoints
  ✓ did/sign, did/rotate, vault/backup, persona/unlock
```

Core's middleware is a static allowlist checked at request time:

```go
func auth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := r.Header.Get("Authorization")

        switch identifyToken(token) {
        case BrainToken:
            if isAdminEndpoint(r.URL.Path) {
                http.Error(w, "Forbidden", 403)
                return
            }
            next.ServeHTTP(w, r)
        case ClientToken:
            next.ServeHTTP(w, r)
        default:
            http.Error(w, "Unauthorized", 401)
        }
    })
}
```

**Why not JWTs or scoped task tokens?** Brain never needs `/v1/did/sign` directly. When brain wants to send a message to Sancho's Dina, it calls `POST /v1/msg/send {to: "did:plc:sancho", body: "..."}` — core handles NaCl encryption + signing internally. Same for reputation record publishing (core signs and pushes to PDS) and DIDComm outbox. Brain triggers high-level operations; core handles crypto. No endpoint requires brain to hold a signing capability.

A static allowlist is simpler to audit (reviewable at compile time), has zero runtime overhead (no JWT signing/verification/expiry tracking), and achieves identical security for the current architecture.

**This is the permanent design.** Dina is a kernel, not a platform — no plugins, no untrusted code inside the process (see "Core Philosophy" above). Two-tier auth is sufficient because child agents (OpenClaw etc.) communicate via MCP, not by running code inside Dina.

### Data Flow: Who Touches What

The core principle: **Go owns the file. Python owns the thinking. Core is the gatekeeper.**

```
WHO TOUCHES SQLITE?

  dina-core (Go)     ← ONLY process that opens vault .sqlite files
  dina-brain (Python) ← NEVER touches SQLite. Talks to core via HTTP API.
                        Core decides what brain can access (gatekeeper.go).
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

**Cross-persona queries and the Gatekeeper:** The brain needs data from multiple personas constantly (see [Security Model: The Brain is a Guest](#security-model-the-brain-is-a-guest) above). The Sancho Moment whisper at 3 AM needs `/social` (relationship with Sancho, his mother's illness), `/professional` (calendar — is user free?), and `/consumer` (tea preference). That's three persona crosses for one whisper — dozens of times daily. Requiring user approval for each would kill the always-on agent.

**The model: personas have access tiers, not per-query gates.** Enforced by `gatekeeper.go` in core.

```
Persona Access Tiers (configured by user, stored in config.json):

  "brain_access": {
    "/social":       "open",        ← brain can query freely
    "/consumer":     "open",        ← brain can query freely
    "/professional": "open",        ← brain can query freely
    "/health":       "restricted",  ← brain can query, but every access logged + user notified
    "/financial":    "locked",      ← requires client device approval per session (not per query)
  }
```

| Tier | Behavior | Use Case |
|------|----------|----------|
| **Open** | Brain queries freely. Core serves. Logged but no gate. | Social, consumer, professional — the personas brain needs constantly for whispers. |
| **Restricted** | Brain can query, but core logs every access to Tier 0 audit log AND pushes a silent notification to client device. User sees "Dina accessed your health data 3 times today" in daily briefing. | Health — brain sometimes needs it (e.g., "you have a doctor's appointment"), but user should know when. |
| **Locked** | Brain cannot query at all until user unlocks the persona for a time-limited session via client device. `POST /v1/persona/unlock {persona: "/financial", ttl: "15m"}`. Core auto-locks after TTL expires. | Financial — brain almost never needs this. When it does, it's high-stakes (tax filing, insurance claim). Worth the friction. |

**What this fixes:**

1. **Compromised brain can't touch locked personas at all.** Financial data requires user interaction. The attack surface is limited to open personas.
2. **Restricted personas create a detection trail.** If a compromised brain starts scraping health data, the user sees it in the audit log.
3. **Open personas stay fast.** The whisper flow works without friction for everyday contexts.
4. **Cross-persona ATTACH is never done.** Core doesn't use `ATTACH DATABASE`. Each persona query is a separate API call to `/v1/vault/query` with a `persona` field. Core opens each persona's partition independently, checks the access tier, and responds. Brain never sees the SQLite handle.

**The audit log (Tier 0) records every persona access:**

```json
{"ts": "2026-02-18T03:15:00Z", "persona": "/health", "action": "query", "requester": "brain", "query_type": "fts", "reason": "whisper_assembly"}
```

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
PRAGMA busy_timeout=5000;                -- Wait up to 5s for write lock (prevents SQLITE_BUSY under load)
```

WAL mode means: if the server crashes mid-write, the main `.sqlite` is untouched. On restart, SQLite sees the incomplete `-wal` file and automatically rolls back. The database is always in a consistent state.

**Protection 1b: Concurrent Access (Single-Writer Pattern)**

dina-core is a concurrent Go server: WebSocket clients, connector polling, DIDComm reception, and brain API requests all hit the same persona SQLite file. WAL mode allows concurrent readers, but only **one writer at a time**. Without proper connection management, writes back up during heavy ingestion (e.g. initial Gmail sync of 10,000 emails) and brain queries time out.

**Connection pool design (per persona file):**

```go
// One write connection (serialized), unlimited read connections
type VaultPool struct {
    writeConn *sql.DB  // MaxOpenConns=1, busy_timeout=5000
    readPool  *sql.DB  // MaxOpenConns=N (cpu_count * 2), read-only
}
```

```sql
-- Write connection PRAGMAs (in addition to Protection 1 PRAGMAs)
PRAGMA busy_timeout = 5000;        -- Wait up to 5s for lock instead of returning SQLITE_BUSY immediately
PRAGMA wal_autocheckpoint = 1000;  -- Checkpoint every 1000 pages (~4MB)

-- Read connections
PRAGMA query_only = ON;            -- Prevents accidental writes on read connections
```

**Why single-writer:** SQLite's WAL allows only one writer. Attempting concurrent writes causes `SQLITE_BUSY`. The alternatives — retry loops, random backoff, connection-level mutexes — are fragile. A single dedicated write connection with `busy_timeout` is deterministic: writes queue up, readers never block.

**Batch ingestion pattern (connectors):**

During initial sync, connectors ingest thousands of items. Writing each one individually creates lock contention and WAL bloat.

```
BATCH INGESTION PROTOCOL:

  Connector polls for new items (e.g. 10,000 Gmail messages)
           ↓
  Collect into batches of 100 items
           ↓
  Per batch: BEGIN → INSERT 100 rows → COMMIT (one transaction)
           ↓
  After each batch: notify brain "100 new items in consumer vault"
           ↓
  Brain processes in background (reads from read pool — never blocked by writer)
```

The batch size (100) balances write throughput against WAL file growth. At 100 rows per transaction, a 10,000-email initial sync completes in ~100 transactions instead of 10,000 individual writes — roughly 50x faster and with minimal lock contention.

**Protection 2: Pre-Flight Snapshots (Application Level)**

Before any schema migration or major operation, Dina creates a point-in-time backup.

> **CRITICAL WARNING — CVE-level vulnerability:**
> Do **NOT** use the standard SQLite `VACUUM INTO` command for backups. In SQLCipher, `VACUUM INTO 'backup.sqlite'` does **not** inherit the encryption context of the parent database. It produces a **plaintext** copy — completely bypassing the encryption layer. Shipping this would mean every backup vomits secrets into a plaintext file that anyone with filesystem access could read.
>
> Backups **MUST** be performed using `sqlcipher_export()` via the `ATTACH DATABASE` method. This is the only mathematically safe way to back up a SQLCipher database.

```
MIGRATION SAFETY PROTOCOL:

  1. Create encrypted backup using sqlcipher_export():
     ATTACH DATABASE 'vault.v{old_version}.bak' AS backup KEY '<same_key>';
     SELECT sqlcipher_export('backup');
     DETACH DATABASE backup;
     (Keyed-to-Keyed transaction: decrypts page-by-page from main,
      re-encrypts page-by-page into backup. Plaintext never touches disk.)
           ↓
  2. Apply schema changes inside a transaction
           ↓
  3. Run: PRAGMA integrity_check
     (Verifies every page of the database is consistent)
           ↓
  4a. If integrity_check = "ok" → Commit. Delete backup after 24h.
  4b. If integrity_check ≠ "ok" → ROLLBACK. Restore from backup. Alert user.
```

```go
// Go implementation using mutecomm/go-sqlcipher
func (s *Store) SecureBackup(backupPath string, key string) error {
    // 1. Ensure backup file does not exist (SQLite will create it)
    if _, err := os.Stat(backupPath); err == nil {
        os.Remove(backupPath)
    }

    // 2. Atomic Keyed-to-Keyed backup via sqlcipher_export()
    //    ATTACH initializes the new file with encryption header + derived key
    //    before any data is written. sqlcipher_export() decrypts from main
    //    and re-encrypts into backup — plaintext never touches disk.
    query := `
        ATTACH DATABASE ? AS backup KEY ?;
        SELECT sqlcipher_export('backup');
        DETACH DATABASE backup;
    `

    // 3. Execute — same key for seamless restoration
    _, err := s.db.Exec(query, backupPath, key)
    if err != nil {
        return fmt.Errorf("secure backup failed: %w", err)
    }

    return nil
}
```

**CI/CD verification (mandatory):** The backup test suite must attempt to open the resulting `backup.sqlite` as a standard plaintext SQLite file. If the file opens successfully (valid `SQLite format 3\0` header), the build **MUST** fail. This catches any regression where someone replaces `sqlcipher_export()` with `VACUUM INTO`.

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
| Bad migration / code bug | Pre-flight snapshot | `sqlcipher_export()` (Keyed-to-Keyed backup) + integrity check | Seconds (auto-rollback) |
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

### Attachment & Media Storage: References, Not Copies

**Never store binary blobs in SQLite.** A single user's vault goes from 50MB to 50GB if you store email attachments, and everything breaks — backups, sync, portability, encryption overhead. The "copy your vault file and go" promise dies.

```
What Dina stores (in vault.sqlite):
  - Metadata: filename, size, MIME type, source_id, timestamp
  - Reference: URI back to source (Gmail message ID, Drive file ID)
  - Context: LLM-generated summary of the attachment content

What Dina does NOT store:
  - The actual PDF, image, spreadsheet, video
```

**Why references beat copies:** The user already has the attachment — it's in Gmail, Drive, or their local filesystem. Duplicating it means encrypting 50GB with SQLCipher (slow), backing up 50GB to S3 (expensive), syncing 50GB to client devices (impossible on mobile), and `vault.sqlite` becomes unmovable.

**What brain actually needs:** Brain doesn't need the raw PDF to assemble a whisper. Brain needs: "Sancho sent a contract (PDF, 2.3MB) titled 'Partnership_Agreement_v3.pdf' on Feb 15. Key terms: 60/40 revenue split, 2-year lock-in, exit clause in Section 7." That summary is a few KB, fully searchable via FTS5, embeddable via sqlite-vec.

**When the user needs the file:** Brain returns a deep link to the source — the client app opens Gmail/Drive. The file was always there.

**Dead references:** If the user deletes the email from Gmail, the reference is dead. This is acceptable. Dina is memory and context, not a backup service. The summary survives in the vault even if the source is gone.

**Exception — voice memos and WhatsApp voice notes:** These are small (typically under 1MB), have no stable source URI to link back to, and the transcript is the valuable part. For these: store the transcript in the vault, discard the audio. If the user wants to keep audio, it goes to a `media/` directory alongside the vault — files on disk, not inside SQLite.

```
vault.sqlite     → text, metadata, references, summaries (small, portable)
media/           → optional voice notes, images user explicitly wants to keep
                   (not inside SQLite, just files on disk, encrypted at rest)
```

### Gmail Connector
- **Runs on:** Home Node
- **API:** Gmail REST API, `readonly` scope only
- **Auth:** OAuth 2.0 token stored in Tier 0 (key-wrapped with Argon2id KEK)
- **Pull frequency:** Every 15 minutes (configurable) for new emails; startup sync follows the Living Window protocol (30-day fast sync → background backfill to 365 days)
- **What's pulled:** Headers first, then full body only for emails that pass triage (see Ingestion Triage below). Attachments: metadata only, full download optional. Only messages within `DINA_HISTORY_DAYS` (default 365). Older messages are never downloaded — accessed via pass-through search when needed.
- **Dedup:** By Gmail message ID
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
           Online Mode:  Gemini Flash Lite — ~700 tokens = $0.00007 per batch.
                         Classifying 2,000 emails/year = 40 batches = $0.003/year.
           Offline Mode: Gemma 3n via llama-server — ~0.5 seconds per batch.

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
| LLM triage cost (Online Mode) | $0 | ~$0.003/year |
| Signal-to-noise | Very low | High (real correspondence + actionable items) |

**User override:** The triage categories are configurable. If a user wants to index their newsletters (e.g., they subscribe to high-quality technical newsletters), they can add sender exceptions: `"always_ingest": ["newsletter@stratechery.com", "*@substack.com"]`. If they want everything, `DINA_TRIAGE=off` disables filtering entirely.

**Fiduciary override:** Even during triage, certain patterns always trigger full ingestion regardless of category — security alerts, financial documents, domain/account expiration warnings. These align with Tier 1 (Fiduciary) classification: silence would cause harm. The triage LLM is specifically instructed to never skip anything that looks actionable or time-sensitive.

#### OAuth Token Lifecycle

Gmail access tokens expire every **60 minutes**. Refresh tokens rotate on each use (Google's rotation policy). Tokens are revoked when the user changes their Google password, removes the app from their Google account, or a security event triggers forced revocation.

**Connector health state machine:**

```
ACTIVE ─(token expiring in <5 min)─► NEEDS_REFRESH
NEEDS_REFRESH ─(refresh succeeds)──► ACTIVE         (new token, rotated refresh token)
NEEDS_REFRESH ─(refresh fails)─────► EXPIRED         + Tier 2 notification
EXPIRED ─(user re-authorizes)──────► ACTIVE
EXPIRED ─(provider revokes)────────► REVOKED         + Tier 2 notification
REVOKED ─(user re-authorizes)──────► ACTIVE
```

**Rules:**
1. **Auto-refresh before expiry.** The connector scheduler calls `check_token_health()` on every poll cycle. If the token expires within 5 minutes, refresh is attempted automatically. If refresh succeeds, the user never notices.
2. **Never poll with a bad token.** If the connector is in EXPIRED or REVOKED state, `poll()` returns empty — no API call is made. This prevents 401 storms and avoids triggering Google's abuse detection.
3. **Tier 2 notification on failure.** When auto-refresh fails or the token is revoked, emit a Tier 2 (solicited) notification: *"Gmail access expired. [Re-authorize]"*. This is not Tier 1 (fiduciary) because missing emails is an inconvenience, not a harm.
4. **Status transitions are logged.** Every state change is recorded with timestamp and reason for observability. User can see: connector name, current status, last successful poll, reason for current state.
5. **Refresh token rotation.** On successful refresh, the old refresh token is discarded and the new one is key-wrapped and stored in Tier 0. The old access token is also replaced.

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
STARTUP SYNC PROTOCOL:

  1. FAST SYNC (blocking): Fetch last 30 days (or 100 items, whichever is smaller)
     └─► Metadata fetch → triage → full download only for PRIMARY emails
     └─► Takes seconds. Connector status → ACTIVE. Agent is "Ready."
         User can ask questions immediately.

  2. BACKFILL ("The Historian"): Low-priority background thread fetches
     remaining data up to DINA_HISTORY_DAYS (default: 365 days).
     └─► Metadata fetch → triage → full download for PRIMARY only.
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
     └─► Construct provider API query: Gmail search "invoice contractor before:2025/02/18"
     └─► Fetch matching emails from Gmail API (read-only)
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

### Connector Security Rules
1. Every connector uses the minimum possible permission scope (read-only always)
2. OAuth tokens are key-wrapped (passphrase → Argon2id KEK → AES-256-GCM) in Tier 0, stored on the Home Node. Never stored as plaintext config values.
3. Raw data is encrypted immediately upon ingestion — the normalizer outputs encrypted vault_items
4. Connectors are sandboxed — a compromised Gmail connector cannot access WhatsApp data
5. User can see every connector's status, last pull time, and data volume. Full transparency.
6. Phone-based connectors (WhatsApp, SMS) authenticate to Home Node with device-delegated keys before pushing data
7. OAuth token lifecycle is managed by a health state machine (ACTIVE → NEEDS_REFRESH → EXPIRED → REVOKED). Auto-refresh before expiry. On failure, Tier 2 notification. Never poll with an invalid token.

---

## Layer 6: Intelligence

Where Dina thinks. This is the most complex layer.

**Sidecar mapping:** Layer 6 is split across dina-core and dina-brain. The PII scrubber's regex hot path runs in dina-core (Go — fast, no external calls). The LLM-based NER fallback, silence classification, context assembly, whisper generation, and all agent reasoning run in dina-brain (Python + Google ADK). In Online Mode, brain calls Gemini Flash Lite for text and Deepgram Nova-3 for voice STT. In Offline Mode, brain calls llama-server for text and whisper-server for voice.

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
│  Storage: AT Protocol PDS (external or bundled — Split         │
│           Sovereignty model, see section below)               │
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

### PDS Hosting: Split Sovereignty

**Problem:** Reputation data must be queryable 24/7 — even when the seller's Home Node is a Raspberry Pi behind CGNAT that's currently offline. If your PDS goes down, your reviews, attestations, and trust score become invisible to the network. AT Protocol relays only crawl live PDSes.

**Principle: Split Sovereignty.** Separate *cryptographic authority* (who signs records) from *infrastructure availability* (who hosts the PDS). You always hold the signing keys. The PDS is a dumb host — it stores your signed Merkle repo and serves it to relays. It cannot forge records because it doesn't have your keys. It can censor (refuse to serve) but cannot fabricate. And if it censors, you move to another PDS — AT Protocol's account portability guarantees this.

This is the same model as email: you own your messages (cryptographic authority via PGP/S-MIME), but Gmail hosts the mailbox (infrastructure availability). You can move to Fastmail without losing your identity.

#### Two PDS Topologies

| | Type A: External PDS | Type B: Bundled PDS |
|---|---|---|
| **Who** | Home users (Raspberry Pi, Mac Mini, NAS behind CGNAT/NAT) | VPS users, advanced self-hosters with static IP |
| **PDS location** | Community-hosted (e.g., `pds.dina.host`) or any AT Protocol PDS provider | Co-located with Home Node in docker-compose |
| **Signing** | Home Node signs records locally → pushes signed commits to external PDS | Home Node signs records locally → writes directly to co-located PDS |
| **Availability** | PDS is always online (cloud/community infrastructure) | PDS is as available as your VPS (99.9%+ uptime typical) |
| **Incoming traffic** | Zero — PDS absorbs all read traffic from relays and AppViews | PDS handles relay crawl requests alongside Home Node traffic |
| **docker-compose** | Default: `docker compose up -d` (2 containers: core, brain) | `docker compose --profile with-pds up -d` (adds PDS container) |
| **Best for** | Getting started, home hardware, unreliable connectivity | Production, always-on VPS, full control |

**Type A flow (External PDS):**
```
Home Node (Raspberry Pi, behind NAT)
    │
    │  Signs attestation/outcome record with user's Ed25519 key
    │  Pushes signed commit to external PDS (outbound HTTPS)
    ▼
External PDS (pds.dina.host or any AT Protocol PDS)
    │
    │  Stores signed Merkle repo
    │  Serves to relay on crawl request
    ▼
AT Protocol Relay (firehose aggregation)
    │
    ▼
Reputation AppView (indexes com.dina.reputation.* records)
```

The Home Node never receives inbound reputation traffic. The external PDS absorbs all read load. The Home Node only makes outbound pushes when it has new records to publish — a few requests per day for a typical user. Your Raspberry Pi is safe.

**Type B flow (Bundled PDS):**
```
Home Node (VPS with static IP)
    │
    ├── dina-core (Go)     ← Private layer
    ├── dina-brain (Python) ← Private layer
    ├── llama-server        ← Private layer (Offline Mode)
    └── dina-pds            ← Public layer: AT Protocol PDS
            │
            │  Serves signed repo to relay on crawl
            ▼
       AT Protocol Relay → Reputation AppView
```

The PDS container runs alongside the private stack but serves only reputation data (`com.dina.reputation.*` Lexicons). It handles relay crawl requests — infrequent, lightweight, and cacheable.

#### Why Your Machine Isn't Overwhelmed (AT Protocol's Three Layers)

AT Protocol separates read traffic from write traffic across three architectural layers:

```
                Write path                    Read path
                (your PDS)                    (AppView)

User writes    ─────►  PDS  ◄─────  Relay crawls (pull, not push)
review                  │                │
                        │                │
                        ▼                ▼
                    Relay (Firehose)──► AppView (Query Index)
                                            │
                                            ▼
                                    Other Dinas query
                                    reputation here
```

| Layer | Role | Traffic pattern |
|-------|------|----------------|
| **PDS** (yours) | Stores your signed Merkle repo | Low: relay crawls periodically (delta sync via Merkle Search Trees). No end-user queries hit your PDS. |
| **Relay** | Aggregates firehose from all PDSes | High: crawls thousands of PDSes, streams unified firehose to AppViews. Not your problem — relay operators handle this. |
| **AppView** | Builds application-specific query indexes | High: serves all end-user queries ("show me all chairs rated > 80"). Not your problem — AppView operators handle this. |

**Key insight: your PDS only talks to the relay.** It never serves end-user queries. When another Dina asks "what's the reputation of this seller?", that query hits the Reputation AppView — not your PDS. Your PDS's only job is to store your signed records and let the relay crawl them.

**Merkle Search Trees make crawling cheap.** The relay doesn't download your entire repo on every crawl. AT Protocol repos use Merkle Search Trees (MSTs) — a self-balancing tree where the structure is determined by record key hashes. The relay stores the last root hash it saw. On the next crawl, it walks only the diff — new records since the last sync. For a typical user publishing a few attestations per week, delta sync transfers a few kilobytes.

#### The Dina Foundation PDS (`pds.dina.host`)

> Planned for Phase 1. Free tier for all Dina users.

The Dina Foundation will operate an AT Protocol PDS at `pds.dina.host` as the default Type A host. Users get a handle like `alice.dina.host` and a PDS that's always online.

- **What it stores:** Only `com.dina.reputation.*` records (attestations, outcomes, bot scores). No private data ever touches it.
- **What it can do:** Serve your signed repo to relays. That's it.
- **What it cannot do:** Forge records (no signing keys), read private vault data (different protocol entirely), prevent you from leaving (AT Protocol account portability).
- **If it goes down:** Your records are already replicated to relays. You migrate to another PDS. Zero data loss.
- **If it turns evil:** You rotate your PDS in your `did:plc` document. All existing records remain valid (signed by your key, not the PDS's key).

#### Choosing Your PDS Topology

```
Start here
    │
    ├── Home hardware (Pi, Mac Mini, NAS)?
    │       └── Type A: External PDS (pds.dina.host)
    │           docker compose up -d  (no PDS container)
    │
    └── VPS or dedicated server with static IP?
            └── Type B: Bundled PDS
                docker compose --profile with-pds up -d
```

Both topologies produce identical results on the network. A relay crawling `pds.dina.host/alice` and a relay crawling `your-vps:pds-port` see the same signed Merkle repo format. The choice is purely about infrastructure preference and availability guarantees.

### Reputation AppView (Aggregation & Query Layer)

Personal data lives on user PDSes, but global queries ("who are the top-rated sellers?", "what's the best laptop under ₹80K?") require an aggregation layer. This is the AppView.

The AppView does not hold user keys or create data. It is a **read-only indexer** that consumes the network firehose, filters for Dina-specific records, and serves a high-speed query API.

#### Phase 1: The Monolith (0–1M users)

**Philosophy: keep it simple.** Dina filters for a specific Lexicon (`com.dina.reputation.*`), so the data volume is <1% of the full AT Protocol firehose. A single optimized node handles this for years.

**Stack:**

| Component | Technology | Why |
|-----------|-----------|-----|
| Runtime | Go (single binary) | Matches ecosystem, `indigo` firehose consumer library |
| Database | PostgreSQL 16 + `pg_trgm` | Text search, normalized schema, mature tooling |
| Ingestion | `indigo` library connecting to `bsky.network` Relay | Proven AT Protocol firehose consumer |
| Deployment | 1x VPS (4 vCPU, 8GB RAM, NVMe) | Blue/green zero-downtime updates |
| Resilience | WAL archiving + periodic snapshots (PITR) | Point-in-time recovery |

**Architecture:**

```
AT Protocol Relay (bsky.network)
        │
        │ WebSocket firehose
        ▼
┌─────────────────────────────────────────┐
│  Reputation AppView (Single Go Binary)  │
│                                         │
│  1. Firehose Consumer                   │
│     └─ Connects to Relay WebSocket      │
│     └─ Tracks cursor (seq number)       │
│                                         │
│  2. Filter                              │
│     └─ Discards all events except       │
│        com.dina.reputation.*            │
│        com.dina.identity.attestation    │
│                                         │
│  3. Verifier                            │
│     └─ Cryptographically verifies       │
│        signature on every record        │
│     └─ Rejects unsigned/invalid         │
│                                         │
│  4. Indexer                             │
│     └─ Upserts valid records into       │
│        PostgreSQL (sellers, reviews,    │
│        trust_scores, bot_scores)        │
│                                         │
│  5. Query API                           │
│     └─ GET /v1/reputation?did=...       │
│     └─ GET /v1/product?id=...           │
│     └─ GET /v1/bot?did=...             │
│     └─ Serves signed payloads for       │
│        client-side verification         │
└─────────────────────────────────────────┘
        │
        │ JSON API
        ▼
   Dina Agents query here
```

**Aggregate scores are computed, not stored in any PDS.** The AppView independently calculates product ratings, seller trust composites, and bot accuracy scores from the signed individual records it holds. Any AppView processing the same firehose computes the same scores — the math is deterministic.

**API contract: signed payloads from day one.** Every query response includes the raw signed record payloads alongside computed scores. This is cheap (the records are already in Postgres) and locks in the right API shape. Agent-side verification of these signatures is deferred — no agent checks them in Phase 1, but when verification lands (Phase 3), the API doesn't need to change.

```json
{
  "product_id": "herman_miller_aeron_2025",
  "score": 92,
  "review_count": 14,
  "reviews": [
    {
      "expert_did": "did:plc:abc...",
      "rating": 95,
      "signed_record": "...",
      "signature": "..."
    }
  ]
}
```

#### Future: Scaling & Verification (deferred until multiple AppViews exist)

> **Not needed for Phase 1.** The sections below document the scaling path and trust model for when the ecosystem grows beyond a single Foundation-operated AppView.

**The Sharded Cluster (10M+ users)**

When write load (new reviews) or read load (agent queries) exceeds a single Postgres instance:

```
Relay firehose
      │
      ▼
Stateless Go workers (Ingestion Layer — The Writer)
      │
      ▼
Kafka / NATS JetStream (event buffer: dina-events topic)
      │
      ▼
Indexer Workers → ScyllaDB (sharded by DID) for high-velocity tables
                  PostgreSQL (read replicas) for metadata/identity
      │
      ▼
Independent API cluster (Query Layer — The Reader)
      └─ Autoscales horizontally (Kubernetes HPA)
      └─ Reads from ScyllaDB + Postgres read replicas
```

**Cursor tracking:** Each worker tracks its `seq` number. Crash → resume exactly where it left off. Zero data loss. **Janitor process:** periodically spot-checks AppView against random PDS samples to detect index drift.

**Three-Layer Verification: Trust but Verify**

The AppView provides speed, but it is **not the ultimate source of truth**. Signed records on PDSes are. When multiple AppViews exist, a Dina agent employs a three-layer verification strategy:

**Layer 1: Cryptographic Proof.** When the AppView returns a reputation record ("Alice rated this seller 92"), it includes the raw signed data payload and Alice's signature. The agent verifies the signature against Alice's public key (from her DID Document). The AppView cannot fake a record — it can only serve records actually signed by the author.

**Layer 2: Consensus Check (anti-censorship).** An AppView cannot fake data, but it *can* hide it (e.g., censoring bad reviews for a paying seller). For high-value transactions, the agent queries multiple AppViews. If Provider A returns 5 reviews and Provider B returns 50, the agent detects censorship and alerts the user.

**Layer 3: Direct PDS Spot-Check (the audit).** Randomly (e.g., 1 in 100 queries), or when a score seems suspicious, the agent bypasses the AppView entirely — resolves the target's DID to their PDS URL and fetches records directly via `com.atproto.repo.listRecords`. Discrepancies downgrade the AppView's trust score.

**Why this makes the AppView a commodity:** The AppView has no power to manipulate the market — it only has the power to serve data fast. Agents verify its work, so a dishonest AppView gets caught and abandoned. The network switches to a competitor. **The AppView is infrastructure, not a gatekeeper.** Anyone can run one. Competition is on speed and uptime, not on data access.

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

### Agent Delegation (via MCP)

For tasks beyond drafting and payments, Dina delegates to external child agents. The integration protocol is MCP (Model Context Protocol) — the same standard used by Claude, OpenClaw, and the broader agent ecosystem. **Dina has no plugins — child agents are external processes.** MCP is a wire protocol for task delegation, not a mechanism for running code inside Dina.

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

### Scheduling: Three Tiers, No Scheduler

Dina does not have a general-purpose scheduler. Scheduling is hard when you try to build one. It's easy when you limit yourself to "what's the next thing, and when is it due."

| Problem | Solution | Complexity |
|---------|----------|-----------|
| **Periodic tasks** (watchdog, connector polling, integrity checks) | Go ticker (`time.NewTicker`) | Trivial. Loop with a sleep. If you miss one, catch it next tick. No persistence needed — tickers restart with the process. |
| **One-shot reminders** ("wake me at 5 AM", "license expires in 7 days") | Reminder loop on vault | 20 lines of Go. Store reminder in vault with trigger timestamp. One loop checks "what's next." |
| **Complex scheduling** ("every Monday at 9 AM except holidays") | Delegate to calendar service via OpenClaw | Don't build it. Recurrence rules, timezone math, daylight saving — Google Calendar spent years getting this right. |

**The reminder loop:**

```go
func reminderLoop(vault *Vault) {
    for {
        next := vault.NextPendingReminder()  // SELECT ... ORDER BY trigger_at LIMIT 1
        if next == nil {
            time.Sleep(1 * time.Minute)      // nothing pending, check again later
            continue
        }
        sleepDuration := time.Until(next.TriggerAt)
        if sleepDuration > 0 {
            time.Sleep(sleepDuration)
        }
        notify(next)                          // push to client device
        vault.MarkFired(next.ID)
    }
}
```

On reboot, the loop starts, finds the next reminder, sleeps until it's due. If the server was down when the reminder should have fired, `sleepDuration` is negative — it fires immediately. Missed reminders are caught on startup. No cron library, no scheduler dependency, no complexity.

**For recurring schedules:** Brain tells the user "I've noted this. Want me to create a recurring calendar event?" Then delegates to the calendar service via OpenClaw. Don't rebuild Google Calendar inside Dina.

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
Home Node (Type B: Bundled PDS — VPS with static IP)
├── dina-core (Go)      ← Private layer: encrypted vault, keys, DIDComm-shaped messaging
├── dina-brain (Python)  ← Private layer: reasoning, classification, agent orchestration
├── llama-server         ← Private layer: local LLM inference (Offline Mode)
└── dina-pds             ← Public layer: AT Protocol PDS for Reputation Graph only
                            (docker compose --profile with-pds)

Home Node (Type A: External PDS — home hardware behind NAT)
├── dina-core (Go)      ← Private layer: encrypted vault, keys, DIDComm-shaped messaging
├── dina-brain (Python)  ← Private layer: reasoning, classification, agent orchestration
├── llama-server         ← Private layer: local LLM inference (Offline Mode)
└── (no PDS container — reputation records pushed to external PDS via outbound HTTPS)
```

In Type B, the PDS container runs alongside the private stack, hosting only reputation data (`com.dina.reputation.*` Lexicons). In Type A, the Home Node signs records locally and pushes them to an external PDS (e.g., `pds.dina.host`). In both cases, private data (messages, personal vault, persona compartments) never touches the AT Protocol stack. See Layer 3 "PDS Hosting: Split Sovereignty" for the full design.

### Precedent

This hybrid approach mirrors **Roomy** (Discord-like chat on AT Protocol) — which uses AT Protocol for identity and blob storage but builds its entire messaging/encryption infrastructure independently. It also mirrors **Groundmist Sync** — a local-first sync server linked to AT Protocol identity, using AT Protocol for optional publishing while keeping private data local.

---

## Technology Stack Summary

| Component | Technology | Why |
|-----------|-----------|-----|
| **Home Node (dina-core)** | | |
| Core runtime | Go + net/http (HTTP server) | Fast compilation, single static binary, excellent crypto stdlib, goroutines for concurrency |
| Database | SQLite + SQLCipher + FTS5 (via `mutecomm/go-sqlcipher` with CGO) | Battle-tested, one encrypted file per persona, no separate DB server. SQLCipher provides transparent whole-database AES-256 encryption. **Not** `mattn/go-sqlite3` — SQLCipher support was never merged into mainline mattn; it only exists in forks. `mutecomm/go-sqlcipher` embeds SQLCipher directly. CI must assert raw `.sqlite` bytes are not valid SQLite headers (proving encryption is active). |
| Vector search | Phase 1: vectors stored and queried in dina-brain (Python, sqlite-vec). Phase 2: sqlite-vec in core via CGO. | Brain handles embeddings initially; core handles structured/FTS queries. Clean separation. |
| PII scrubbing (hot path) | Regex + calls to llama-server | Fast path in Go, LLM fallback for ambiguous cases |
| Client ↔ Node protocol | Authenticated WebSocket (TLS + device-delegated key) | Encrypted channel, device key proves identity |
| Home Node ↔ Home Node | Phase 1: libsodium `crypto_box_seal` (ephemeral sender keys) + DIDComm-shaped plaintext. Phase 2: full JWE (ECDH-1PU). Phase 3: Noise XX sessions for full forward secrecy. | Sender FS from day one. Full FS in Phase 3. Plaintext format is DIDComm-compatible throughout — migration is encryption-layer only. |
| **Home Node (dina-brain)** | | |
| Brain runtime | Python + Google ADK (v1.25+, Apache 2.0) | Model-agnostic agent framework, multi-agent orchestration |
| Text LLM (Online) | Gemini 2.5 Flash Lite API ($0.10/$0.40 per 1M tokens) | Cheapest Gemini model, 1M context, native function calling + JSON mode, 305+ t/s |
| Text LLM (Offline) | llama-server (llama.cpp) + Gemma 3n E4B GGUF (~3GB RAM) | OpenAI-compatible API, CPU/Apple Silicon inference, full offline capability |
| Voice STT (Online) | Deepgram Nova-3 ($0.0077/min, WebSocket streaming) | ~150-300ms latency, purpose-built real-time STT. Fallback: Gemini Flash Lite Live API. |
| Voice STT (Offline) | whisper.cpp + Whisper Large v3 Turbo (~3GB) | 4.4% WER, battle-tested, mature chunking pipeline |
| Cloud LLM (escalation) | User's choice (Gemini 2.5 Flash/Pro, Claude, GPT-4) | For complex reasoning that Flash Lite can't handle. Goes through PII scrubber. |
| Agent orchestration | Google ADK Sequential/Parallel/Loop agents | Multi-step reasoning, tool calling with retries |
| External agent integration | MCP (Model Context Protocol) | Connect to OpenClaw and other child agents. No plugins — agents are external processes. |
| Embeddings (Online) | `gemini-embedding-001` ($0.01/1M tokens) | 768/3072 dims, 100+ languages |
| Embeddings (Offline) | EmbeddingGemma 308M (GGUF) via llama-server | ~300MB RAM, 100+ languages, Matryoshka dims |
| **Container orchestration** | | |
| Online Mode | docker-compose (2 containers: core, brain). Add PDS with `--profile with-pds` (Type B). | 2GB RAM minimum. No local LLM/STT needed. Type A users push to external PDS instead. |
| Offline Mode | docker-compose (4 containers: core, brain, llama-server, whisper-server). Add PDS with `--profile with-pds` (Type B). | 8GB RAM minimum. Mac Mini M4 (16GB) recommended. Full offline capability. |
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
| Reputation Graph (PDS) | AT Protocol PDS (external or bundled — Split Sovereignty). Custom Lexicons (`com.dina.reputation.*`). Signed tombstones for deletion. | Type A: home users push signed records to external PDS (`pds.dina.host`). Type B: VPS users run bundled PDS (`--profile with-pds`). See Layer 3 "PDS Hosting: Split Sovereignty". |
| Reputation Graph (AppView) | Go + PostgreSQL 16 (`pg_trgm`). `indigo` firehose consumer. Phase 1: single monolith (0–1M users). Phase 3: sharded cluster (ScyllaDB + Kafka + K8s). | Read-only indexer. Signature verification on every record. Three-layer trust-but-verify: cryptographic proof, consensus check, direct PDS spot-check. AppView is a commodity — anyone can run one. See Layer 3 "Reputation AppView". |
| Reputation Graph (timestamps) | L2 Merkle root anchoring (Phase 3). Base or Polygon. | Provable "this existed before this date" for dispute resolution. Not needed until real money flows through the system. |
| ZKP | Semaphore V4 (PSE/Ethereum Foundation) | Production-proven (World ID), off-chain proof generation |
| Serialization | JSON (Phase 1), MessagePack or Protobuf (Phase 2) | JSON is debuggable and sufficient for core↔brain traffic volume. Binary serialization deferred until profiling shows it matters. |
| Containerization | Docker + docker-compose | Single-command Home Node deployment: `docker compose up -d` |
| Supply chain | Digest pinning (`@sha256:...`, never `:latest`), Cosign image signing, SBOM (`syft`, SPDX) | Pinning prevents breakage, signing prevents tampering, SBOM enables auditing. Reproducible builds skipped (too hard with Python/CUDA). See [SECURITY.md](SECURITY.md). |
| **Observability** | | |
| Watchdog | Internal Go ticker (1-hour interval) | Checks connector liveness, disk usage, brain health. Breaches inject Tier 2 system messages into user's notification stream. No external monitoring stack. Zero extra RAM. |
| Health probes | `/healthz` (liveness), `/readyz` (readiness) | Docker kills and restarts zombie containers automatically |
| Logging | Go `slog` + Python `structlog` → JSON to stdout | No file logs; Docker log rotation handles retention |
| Self-healing | `restart: always` + healthcheck + dependency chain | Brain waits for core; all containers auto-recover |
| Metrics (optional) | `/metrics` (Prometheus format, protected by `CLIENT_TOKEN`) | For power users with existing homelab dashboards. Not required for default operation. |
| **Data Safety** | | |
| Database config | WAL mode + `synchronous=NORMAL` | Crash-safe atomic writes |
| Migration safety | `sqlcipher_export()` + `PRAGMA integrity_check` | Pre-flight snapshot before every schema change. **Never `VACUUM INTO`** — creates unencrypted copies on SQLCipher (CVE-level vulnerability). |
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
- llama-server: llama.cpp + Gemma 3n E4B GGUF — **private layer** (Offline Mode only)
- whisper-server: whisper.cpp + Whisper Large v3 Turbo — **private layer** (Offline Mode only)
- dina-pds: AT Protocol PDS for Reputation Graph — **public layer** (reputation data only)
- Output: Encrypted messaging endpoint + WebSocket API for clients + AT Protocol firehose
- Deployment: `DINA_MODE=online docker compose up -d` (or `offline`)

**Encryption key passing (docker-compose):**

The vault passphrase never appears in `docker-compose.yml`, command history, or process listings:

```yaml
services:
  dina-core:
    image: dina-core:latest
    environment:
      - DINA_VAULT_MODE          # "security" or "convenience" (from .env)
    secrets:
      - vault_passphrase         # Injected as /run/secrets/vault_passphrase
    volumes:
      - ./data:/data             # Persistent vault storage

secrets:
  vault_passphrase:
    file: ./secrets/vault_passphrase.txt   # chmod 600, .gitignored
```

| Mode | What dina-core does at boot |
|------|---------------------------|
| **Security** | Reads `/run/secrets/vault_passphrase` → Argon2id → KEK → unwrap `master.key.enc` → DEK → `PRAGMA key`. Secret file can be a one-time read (tmpfs mount, deleted after boot). |
| **Convenience** | Ignores the secret. Reads `master.key` directly from `./data/keys/master.key` (raw 32-byte DEK, `chmod 600`). |

**Rules:**
- `DINA_VAULT_PASSPHRASE` is **never** set as a plain `environment:` variable — it would appear in `docker inspect`, process listings, and container logs.
- Docker Secrets mount as in-memory tmpfs files at `/run/secrets/` — they never touch disk inside the container.
- The `secrets/` directory is in `.gitignore` and `.dockerignore`.
- For managed hosting (Fly.io), use `fly secrets set VAULT_PASSPHRASE=...` — Fly injects as an env var visible only to the process, not in logs or inspect output.

**Two deployment modes:**

| | **Online Mode** (default, Phase 1) | **Offline Mode** (safety-conscious, Phase 2) |
|--|---|---|
| **Containers** | 3 (core, brain, pds) | 5 (core, brain, llama-server, whisper-server, pds) |
| **Text LLM** | Gemini 2.5 Flash Lite (cloud API) | Gemma 3n E4B via llama-server (local) |
| **Voice STT** | Deepgram Nova-3 (WebSocket streaming, ~150-300ms latency). Fallback: Gemini Flash Lite Live API. | whisper.cpp + Whisper Large v3 Turbo (~3GB, 4.4% WER) |
| **PII scrubbing** | Regex in Go (always local) | Regex + Gemma 3n (local) |
| **Embeddings** | `gemini-embedding-001` (cloud, $0.01/1M tokens) | EmbeddingGemma 308M via llama-server (local) |
| **Minimum RAM** | **2GB** (Go core ~200MB + Python brain ~500MB + PDS ~100MB + OS ~300MB + headroom) | **8GB** (Gemma 3n E4B ~3GB + Whisper Turbo ~3GB + Go ~200MB + Python ~500MB + PDS ~100MB + OS ~300MB + headroom). Mac Mini M4 (16GB+) recommended. |
| **CPU** | 2 cores | 4+ cores. Apple Silicon (MLX) or x86 with AVX2. |
| **Storage** | 10GB (grows with vault) | 20GB (+ model files ~6GB: Gemma E4B ~3GB + Whisper ~3GB) |
| **GPU** | Not needed | Not needed on Apple Silicon (unified memory). Discrete GPU helps on x86. |
| **Internet** | Required (LLM + STT + messaging) | Required for messaging only. LLM + STT work fully offline. |
| **Monthly cost** | ~$5-15 (Flash Lite: ~$1-5 for text. Deepgram: ~$10 for voice at 45 min/day. Embeddings: <$1.) | Hardware + electricity only |
| **Offline capability** | Degraded — messaging queued, LLM + STT unavailable, vault still works | Full — everything works, messages queued for later delivery |
| **Best for** | Raspberry Pi, cheap VPS, managed hosting, Phase 1 development, users who want it working fast | Mac Mini, NUC, dedicated server, privacy maximalists, unreliable internet |

**Phase 1 implements Online Mode only.** Offline Mode ships once the end-to-end flow works without issues. Both modes share identical vault, identity, messaging, and persona layers — only the inference and STT backends differ.

**Why these defaults for Online Mode:**

*Text — Gemini 2.5 Flash Lite:*
- Cheapest Gemini model: $0.10 input / $0.40 output per 1M tokens (8.75x cheaper than Flash output, 25x cheaper than Pro).
- 1M token context window, native function calling + JSON mode, 305+ t/s, 0.3-0.5s TTFT.
- Paid API: prompts/responses NOT used for training. 55-day abuse monitoring retention only.
- Free tier: 15 RPM, 1000 RPD — enough for personal dev/testing.

*Voice — Deepgram Nova-3:*
- Purpose-built real-time STT (not a repurposed LLM). Aligns with Dina's "Thin Agent" principle: delegate to specialists.
- ~150-300ms WebSocket streaming latency — fastest in class. Critical for natural voice interaction.
- $0.0077/min (~$10/month at 45 min/day). $200 one-time free credit covers months of testing.
- Fallback: Gemini Flash Lite Live API ($0.30/1M audio tokens, ~$0.78/month) — already in the stack, no additional integration.

*Voice — Why not Gemini alone for STT:*
- Gemini Live API is a conversational LLM, not a dedicated ASR service. It adds LLM inference overhead to what should be a fast transcription step.
- No independent WER benchmarks for pure transcription. Latency spikes to 780ms at p95.
- Better reserved for the reasoning layer where Dina already uses it.

**Why Whisper for Offline Mode (not Gemma 3n audio):**
- Gemma 3n audio: ~13% WER (1 in 8 words wrong). Whisper Large v3 Turbo: ~4.4% WER. For voice commands, accuracy matters.
- Gemma 3n audio does NOT work in Ollama or llama.cpp today — only via MLX (Apple) or Hugging Face Transformers. whisper.cpp is battle-tested and works everywhere.
- Whisper has mature chunking pipelines for continuous voice. Gemma 3n audio is limited to 30-second clips with no streaming.
- Future: if Gemma 3n audio lands in llama.cpp with improved WER, the stack could consolidate.

**What always stays local regardless of mode:**
- PII scrubbing (regex first pass — always in Go core, never touches cloud)
- Vault encryption/decryption (SQLCipher, never leaves Home Node)
- DID signing/verification (Ed25519, never leaves Home Node)
- Persona compartment enforcement (cryptographic, never leaves Home Node)

**Sensitive persona rule (both modes):** Health and financial persona data is NEVER sent to cloud LLMs or cloud STT. Even in Online Mode, queries involving health/financial context are routed to on-device Gemma 3n (if available) or rejected with a "local model required" error. Voice input containing medical/financial context is transcribed locally (Whisper on-device) before processing. This is enforced at the LLM router level in dina-brain.

**Switching modes:** Set `DINA_MODE=online` or `DINA_MODE=offline` in `.env`. The brain routes accordingly. Users can switch at any time — the vault, identity, and messaging layers are identical in both modes.

### LLM & Voice Inference

| Where | Runtime | Model | Use Cases | Mode |
|-------|---------|-------|-----------|------|
| **Text LLM** | | | | |
| Home Node | Cloud API | Gemini 2.5 Flash Lite ($0.10/$0.40 per 1M tokens) | Summarization, drafting, context assembly, classification, routing | Online |
| Home Node | llama.cpp (GGUF) | Gemma 3n E4B (~3GB RAM) | Same as above, but local. Also: PII scrubbing fallback (ambiguous cases) | Offline |
| Home Node | Cloud API | Gemini 2.5 Flash / Pro / Claude / GPT-4 | Complex multi-step reasoning when Flash Lite quality is insufficient | Online (escalation) |
| **Voice STT** | | | | |
| Home Node | Cloud API (WebSocket) | Deepgram Nova-3 ($0.0077/min, ~150-300ms) | Real-time voice command transcription, continuous dictation | Online |
| Home Node | Cloud API (WebSocket) | Gemini Flash Lite Live API ($0.30/1M audio tokens) | Fallback STT when Deepgram is unavailable | Online (fallback) |
| Home Node | whisper.cpp | Whisper Large v3 Turbo (~3GB, 4.4% WER) | Same: voice transcription, fully offline | Offline |
| **Embeddings** | | | | |
| Home Node | Cloud API | `gemini-embedding-001` ($0.01/1M tokens) | Embedding generation for Tier 2 Index | Online |
| Home Node | llama.cpp (GGUF) | EmbeddingGemma 308M (~300MB) | Same: embedding generation, fully offline | Offline |
| **On-device** | | | | |
| Android client | LiteRT-LM | Gemma 3n E2B | Offline drafting, quick replies, on-device search | Both |
| Desktop client | llama.cpp / MLX | Gemma 3n E4B | Same as Android — latency-sensitive local tasks | Both |
| Thin client | None | None | All inference routed to Home Node | Both |

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
| **Kubernetes** | Container orchestration for distributed services. Dina's Home Node is 3-5 containers on one machine. `docker compose up` is the entire deployment. |
| **GraphQL** | API layer for complex multi-consumer APIs. Dina has one consumer: you. Direct SQLite queries from the agent loop. |
| **Elasticsearch** | Distributed search cluster. SQLite FTS5 + sqlite-vec handles search for a single user's data. |
| **Blockchain (L1)** | Gas costs, latency, complexity. Immutability violates sovereignty (right to delete). Federated servers + signed tombstones handle the Reputation Graph. Only use case is L2 Merkle root hash anchoring for timestamp proofs (Phase 3). |
| **CRDTs / Automerge** | Designed for peer-to-peer conflict resolution. With a Home Node as source of truth, client-server sync is simpler and sufficient. May reconsider for Phase 3 if we add collaborative features. |

Guiding principle: **one user, a handful of containers, one machine, one SQLite file per persona, one always-on endpoint.**

---

## What's Hard (Honest Assessment)

**1. WhatsApp ingestion.** Still the weakest link. NotificationListener on Android is fragile, and now the captured data has to travel from phone to Home Node. More moving parts, same underlying problem. No real API. May never be fully solved without regulation.

**2. Managed hosting operations.** Running a hosted service requires: regulatory compliance (GDPR, DPDP Act), security operations, incident response, billing. The protocol creator should not be the hosting operator (separation of concerns).

**3. Home Node LLM quality on cheap hardware.** Gemma 3n E2B on a $5 VPS (CPU-only, ~2 vCPU) runs at ~5-10 tok/sec. Adequate for background tasks (ingestion, PII scrubbing, embeddings). Not great for interactive chat. Rich clients with on-device LLMs handle interactive use. Cloud LLM API is the escape valve.

**4. ZKP for government ID.** No government currently offers ZKP-native verification. The first implementation will be a compromise (local verification, attestation stored).

**5. Reputation Graph cold start.** The first review bot helps. But outcome data needs scale. This is a years-long build.

**6. iOS restrictions.** No NotificationListenerService equivalent. No Accessibility Service. iOS client will always be more limited for device-local ingestion. But with Home Node running API connectors (Gmail, Calendar, Contacts), iOS users still get most functionality. WhatsApp ingestion requires an Android device somewhere in the ecosystem.

**7. Key management UX.** Asking normal people to write down 24 words on paper is a known failure mode in crypto. Most people will lose them. Better UX needed (social recovery? hardware backup?) but security trade-offs are real.

**8. Home Node security surface.** An always-on server with your encrypted data is a target. Must be hardened: automatic updates, minimal attack surface (3-5 containers, no open ports except messaging endpoint), fail2ban-style rate limiting, encrypted at rest. If the VPS is compromised, the attacker gets encrypted blobs they can't read — but they can DoS your Dina.

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

## Phase 1 Scope, Build Roadmap & Timeline

> **Moved to [ROADMAP.md](ROADMAP.md)** — the full build roadmap with status tracking, dependency chains, and cross-referenced items from this architecture document.
>
> The roadmap includes 18 items that were described in this architecture but had no explicit roadmap entries (digital estate, rate limiting, brain→core auth, relay, container signing, monitoring, and more). See "Items Added During Architecture Review" in ROADMAP.md for the full list.

---

*This architecture is a living document. It will evolve as the protocol is implemented and real-world constraints are discovered.*