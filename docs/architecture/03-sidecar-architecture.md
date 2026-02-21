> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

### The Sidecar Pattern: Go Core + Python Brain

The Home Node is split into two services that communicate over a local HTTP API:

- **dina-core (Go + net/http):** The sovereign cryptographic kernel. Holds the encrypted vault, manages keys, runs the DIDComm endpoint, serves client WebSockets, and enforces gatekeeper RBAC + PII scrubbing. **Core never calls external APIs** — no OAuth, no Gmail, no connector code. This is the part that must never fail, must never leak data, and must run for years without maintenance. Go is the right language for this — fast compilation, simple deployment (single static binary), excellent standard library for crypto (Ed25519, AES-256-GCM, X25519 all built-in), and strong concurrency primitives for WebSockets and DIDComm.

- **dina-brain (Python + Google ADK):** The intelligence and orchestration layer. Runs the guardian angel reasoning loop — silence classification, disconnect detection, nudge assembly, agent orchestration. **Brain also orchestrates data ingestion**: schedules sync cycles, delegates fetching to OpenClaw via MCP, triages results, and stores memories in the vault via Core's API. Python is the right language for this because the AI/ML ecosystem (Google ADK, llama-cpp-python, embedding models) is Python-first.

An optional fourth container runs a local LLM:

- **llama (llama.cpp):** Serves Gemma 3n via an OpenAI-compatible API on localhost. Brain calls it for classification, embeddings, and LLM-based NER (Tier 3 PII scrubbing). Core calls it for PII scrubbing NER fallback. Enabled via `--profile local-llm`. Without llama, brain calls cloud LLM APIs (Gemini, Claude) directly — PII scrubbing uses regex (core) + spaCy NER (brain), which catches structured and most contextual PII.

```
docker-compose.yml (4 containers — llama optional via --profile local-llm):

┌─────────────────────────────────────────────────────────┐
│                                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │  dina-core (Go + net/http)                        │    │
│  │  Port 443  (external) — HTTPS: clients,           │    │
│  │                         NaCl messaging,            │    │
│  │                         /admin proxy → brain:8200   │    │
│  │  Port 8100 (internal) — API for brain + admin      │    │
│  │                                                    │    │
│  │  - SQLite vault + encryption                       │    │
│  │  - DID / key operations                            │    │
│  │  - NaCl messaging endpoint (Dina-to-Dina)         │    │
│  │  - WebSocket server (client devices)               │    │
│  │  - PII scrubber (regex hot path)                   │    │
│  │  - Connector scheduler (triggers brain)            │    │
│  │  - Reverse proxy: /admin → brain:8200/admin         │    │
│  │                                                    │    │
│  │  Exposes to brain:                                 │    │
│  │    POST /v1/vault/query                            │    │
│  │    POST /v1/vault/store                            │    │
│  │    POST /v1/did/sign                               │    │
│  │    POST /v1/did/verify                             │    │
│  │    POST /v1/pii/scrub                              │    │
│  │    POST /v1/notify (push to client)                │    │
│  └──────────────────┬───────────────────────────────┘    │
│                      │ localhost:8100                       │
│  ┌──────────────────▼───────────────────────────────┐    │
│  │  dina-brain (Python + Google ADK)                 │    │
│  │  Port 8200 (internal) — unified FastAPI              │    │
│  │    /api/* → Brain API, /admin/* → Admin UI          │    │
│  │                                                    │    │
│  │  /api/* — Brain API (BRAIN_TOKEN):                  │    │
│  │  - Guardian angel reasoning loop                   │    │
│  │  - Silence filter / interrupt classification       │    │
│  │  - Context assembly for nudges                   │    │
│  │  - Disconnect detection                            │    │
│  │  - Agent orchestration (e.g. delegate to           │    │
│  │    OpenClaw via MCP)                               │    │
│  │                                                    │    │
│  │  /admin/* — Admin UI (CLIENT_TOKEN, proxied via core:443): │    │
│  │  - Dashboard, connector status, vault health       │    │
│  │  - Nudge history, contacts, sharing rules        │    │
│  │  - Settings, personas, onboarding flow             │    │
│  │                                                    │    │
│  │  LLM routing:                                      │    │
│  │    Local → llama:8080 (if available)               │    │
│  │    Cloud → Gemini/Claude API (PII-scrubbed)        │    │
│  │                                                    │    │
│  │  Exposes to core:                                  │    │
│  │    POST /v1/process (new data to analyze)          │    │
│  │    POST /v1/reason (complex decision needed)       │    │
│  └──────────────────────────────────────────────────┘    │
│                                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │  llama (llama.cpp)                [local-llm]     │    │
│  │  Port 8080 (internal)                              │    │
│  │  Gemma 3n E4B model, OpenAI-compatible API         │    │
│  │  Optional: docker compose --profile local-llm up   │    │
│  └──────────────────────────────────────────────────┘    │
│                                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │  dina-pds (AT Protocol PDS)                       │    │
│  │  Port 2583 (external) — Relay crawling             │    │
│  │  Reputation Graph records only                     │    │
│  │  Core pushes signed records here                   │    │
│  └──────────────────────────────────────────────────┘    │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

**Why the sidecar pattern, not a single binary:**

- **Best tools for each job.** Go has excellent crypto/DID libraries (standard library `crypto/*`, libsodium via `GoKillers/libsodium-go`, AT Protocol via `bluesky-social/indigo`). Python has the best agent/AI frameworks. Running them side-by-side is the industry standard.
- **Independent development and testing.** `python3 brain.py` works on its own. `go run ./cmd/core` works on its own. You iterate on agent logic at Python speed without recompiling Go.
- **Crash isolation.** If the Python brain OOMs or crashes, Docker restarts it (`restart: unless-stopped`). The vault, keys, and messaging endpoint in core never go down. In-flight operations survive via the Task Queue (core requeues unacknowledged tasks) and Scratchpad (brain checkpoints reasoning to vault). See "Brain Crash Recovery" below.
- **Swappable brain.** Switch from Google ADK to Claude Agent SDK, or from Python to Go (Google ADK now supports Go). The core's internal API doesn't change.
- **Future consolidation path.** Google ADK already supports Go. As Go's AI ecosystem matures, the brain could be rewritten in Go, collapsing the sidecar into a single binary. The internal API makes this a clean migration.
- **Docker-native.** In production (managed hosting), these are containers orchestrated by docker-compose or Fly.io. In development, they're just two terminal windows.

**Why Google ADK for the brain:**

- Apache 2.0 license (aligns with Dina's MIT license)
- Model-agnostic: routes to local Gemma (via llama:8080 when available), Claude, Gemini, or any OpenAI-compatible endpoint
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

**The key architectural insight:** brain sends `POST /v1/vault/query {persona: "/financial", q: "tax"}` and core decides whether to serve, reject, or gate. Core routes the query to the correct persona database file (if open) or returns `403 Persona Locked` (if the DEK isn't in RAM). The persona isolation is enforced by per-file encryption + `gatekeeper.go` in core — brain has no direct database access and cannot bypass access tiers. See [Core ↔ Brain API Contract](#core--brain-api-contract) for the full request/response spec.

**What a compromised brain can do:** access open personas (social, consumer, professional) via `BRAIN_TOKEN`. That's it. It cannot touch locked personas (financial, citizen) without human approval. It cannot touch restricted personas (health) without creating a detection trail the user sees in their daily briefing. It cannot call admin endpoints (`did/sign`, `did/rotate`, `vault/backup`, `persona/unlock`) — `BRAIN_TOKEN` is rejected by `isAdminEndpoint()`. It cannot bypass the PII scrubber — that's a core-side gate. The damage radius of a compromised brain is limited to open persona data.

**Authentication: Two-tier static tokens, no JWTs.**

```
Two token types:

BRAIN_TOKEN (generated by install script, injected via Docker Secrets):
  ✓ vault/query, vault/store, pii/scrub, notify, msg/send,
    reputation/query, process, reason
  ✗ did/sign, did/rotate, vault/backup, persona/unlock, admin/*

CLIENT_TOKEN (per-device, issued during pairing; also used for /admin proxy):
  ✓ Everything — including admin endpoints
  ✓ did/sign, did/rotate, vault/backup, persona/unlock
```

**What these tokens are:**

| Token | Generated | Storage | Validated by | Scope |
|-------|-----------|---------|-------------|-------|
| `BRAIN_TOKEN` | Once, by `install.sh` (`openssl rand -hex 32`) | Docker Secret file (`/run/secrets/brain_token`), read by both core and brain | Constant-time byte comparison against the single known value | Agent operations only — never admin |
| `CLIENT_TOKEN` | Per-device, during pairing ceremony (6-digit code flow) | SHA-256 hash in `identity.sqlite` `device_tokens` table. Plaintext on device only (iOS Keychain / Android Keystore / TPM). | SHA-256(presented token) → lookup in `device_tokens` WHERE `revoked = 0` | Full access including admin |

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

// identifyToken: BRAIN_TOKEN is a single static value (compared in constant time).
// CLIENT_TOKEN is per-device — SHA-256 hash the presented token and look it up
// in the device_tokens table.
func identifyToken(header string) TokenType {
    raw := strings.TrimPrefix(header, "Bearer ")
    if subtle.ConstantTimeCompare([]byte(raw), brainTokenBytes) == 1 {
        return BrainToken
    }
    hash := sha256Hex(raw)
    if deviceTokenExists(hash) {  // SELECT 1 FROM device_tokens WHERE token_hash = ? AND revoked = 0
        return ClientToken
    }
    return Unknown
}
```

**Why not JWTs or scoped task tokens?** Brain never needs `/v1/did/sign` directly. When brain wants to send a message to Sancho's Dina, it calls `POST /v1/msg/send {to: "did:plc:sancho", body: "..."}` — core handles NaCl encryption + signing internally. Same for reputation record publishing (core signs and pushes to PDS) and DIDComm outbox. Brain triggers high-level operations; core handles crypto. No endpoint requires brain to hold a signing capability.

A static allowlist is simpler to audit (reviewable at compile time), has zero runtime overhead (no JWT signing/verification/expiry tracking), and achieves identical security for the current architecture.

**This is the permanent design.** Dina is a kernel, not a platform — no plugins, no untrusted code inside the process (see "Core Philosophy" above). Two-tier auth is sufficient because child agents (OpenClaw etc.) communicate via MCP, not by running code inside Dina.

### Admin UI: Python, Not Go

The admin UI (dashboard, settings, connector status, onboarding flow) and the brain API are **sub-mounted into a single FastAPI master app** in the brain container on port 8200. One Uvicorn process, one port, one healthcheck. Users access the admin UI via `https://my-dina.example.com/admin` — core reverse-proxies the request to brain:8200/admin.

```
brain container (single Uvicorn process on port 8200):

  master app
    ├── /api/*    → Brain API sub-app   (BRAIN_TOKEN — agent operations)
    └── /admin/*  → Admin UI sub-app    (CLIENT_TOKEN — full admin access)
    └── /healthz  → health endpoint     (no auth)

  Two separate FastAPI sub-apps. They share nothing except the Uvicorn process.
  Auth is per-sub-app: brain API checks BRAIN_TOKEN, admin UI checks CLIENT_TOKEN.
  Admin UI calls core:8100 with CLIENT_TOKEN.

External access (browser — see "Browser Authentication Gateway" below):
  User hits https://my-dina.example.com/admin
    → core checks for valid dina_session cookie
    → no cookie? → core serves static login page (Go embed.FS)
    → user enters DINA_PASSPHRASE → core validates via Argon2id
    → core sets HttpOnly/Secure/SameSite=Strict session cookie
    → core injects CLIENT_TOKEN header, proxies to brain:8200/admin
    → admin UI sees Bearer token, renders page
    → response flows back through core to browser

External access (device app — existing flow):
  App sends Authorization: Bearer <CLIENT_TOKEN>
    → core validates token, proxies to brain:8200/admin
    → same as browser, no cookie needed

  One Uvicorn process, one port, one healthcheck, one external port (443).
```

**Why a single Uvicorn process:** Two separate processes (port 8200 + port 8300) in one container is the fat container antipattern — Docker healthcheck can only monitor one port, so the other process dies silently. Sub-mounting both apps into one FastAPI master gives a single process, a single healthcheck (`/healthz`), and one port for core to proxy to. Clean.

```python
# brain/src/main.py — master app
from fastapi import FastAPI
from dina_brain.app import brain_api
from dina_admin.app import admin_ui

master = FastAPI()
master.mount("/api", brain_api)      # BRAIN_TOKEN auth
master.mount("/admin", admin_ui)     # CLIENT_TOKEN auth

@master.get("/healthz")
async def healthz():
    return {"status": "ok"}
```

**Why Python, not Go:** Go templates are painful for forms, tables, and interactive pages. FastAPI + Jinja2 ships a decent admin interface in days, not weeks. The extra HTTP hop to core (`admin → core:8100 → vault → core → admin → browser`) is ~5ms on localhost Docker networking — imperceptible for a dashboard that refreshes every 30 seconds.

**Why core proxies admin UI:** Only two external ports (443 for core, 2583 for PDS). One TLS certificate, one auth layer. The user never needs to know admin is in the brain container. Core checks CLIENT_TOKEN on `/admin/*` requests, then proxies to brain:8200/admin. Smaller attack surface than exposing brain ports directly.

**Why separate sub-apps (not one monolith):** The brain API is an untrusted tenant with `BRAIN_TOKEN` (agent capabilities only). The admin UI needs `CLIENT_TOKEN` (full access including settings, persona management, signing). Sub-mounting as separate FastAPI apps with per-app auth middleware enforces the permission boundary even though they share a process. Neither sub-app can import or call the other — isolation via Python module boundaries.

### Browser Authentication Gateway

The Admin UI uses `CLIENT_TOKEN` for authorization, but browsers can't inject Bearer tokens into requests like device apps can. Copy-pasting a 64-character hex token into a browser is a UX failure. Building a separate auth system in Python Brain would violate the "Core is the Gatekeeper" model.

The fix: **Core handles browser sessions natively and translates them into Bearer tokens before proxying.** The brain never knows about cookies, sessions, or web logins.

```
Browser Authentication Flow:

  ┌─────────┐     GET /admin      ┌──────────┐
  │ Browser │ ──────────────────→ │ Go Core  │
  └─────────┘                     └────┬─────┘
                                       │
                              Has valid dina_session cookie?
                                       │
                          ┌────────────┴────────────┐
                          │ NO                       │ YES
                          ▼                          ▼
                   Serve login page          Validate session
                   (Go embed.FS,             (in-memory map,
                    ~30 lines HTML)           check TTL)
                          │                          │
                          ▼                          ▼
                   User enters               Inject CLIENT_TOKEN
                   DINA_PASSPHRASE           as Authorization header
                          │                          │
                          ▼                          ▼
                   Core validates             Proxy to brain:8200/admin
                   (same Argon2id            (brain sees Bearer token,
                    as vault unlock)          serves page normally)
                          │
                          ▼
                   Generate session ID
                   (crypto/rand, 32 bytes)
                          │
                          ▼
                   Set cookie:
                     dina_session=<id>
                     HttpOnly ✓
                     Secure ✓
                     SameSite=Strict ✓
                     Max-Age=86400 (24h)
                          │
                          ▼
                   302 Redirect → /admin
```

**Key properties:**

| Property | Value |
|----------|-------|
| **Login credential** | `DINA_PASSPHRASE` — same passphrase that unlocks the vault. No additional password. |
| **Session storage** | In-memory map in Go Core (`map[string]session`). Lost on restart — user logs in again. |
| **Session TTL** | 24 hours (configurable via `DINA_SESSION_TTL`). Auto-expires. |
| **Cookie flags** | `HttpOnly` (no JS access), `Secure` (HTTPS only), `SameSite=Strict` (no cross-site) |
| **CSRF protection** | `SameSite=Strict` blocks cross-origin requests. Core also generates a CSRF token per session, injected as `X-CSRF-Token` header. Admin UI embeds it in forms. |
| **Rate limiting** | 5 login attempts per minute per IP. Argon2id is intentionally slow (~1s with 128MB/3 iter defaults), making brute force impractical. |
| **Convenience mode** | Same login flow. Vault auto-unlocks on boot, but browser access still requires passphrase. Defense in depth — an open network shouldn't mean open admin access. |
| **Login page** | ~30-line static HTML form, compiled into Go binary via `embed.FS`. Zero external dependencies. Posts to `POST /admin/login`. |
| **Brain changes** | Zero. Brain continues to check Bearer token on every request. Browser and device app look identical to brain. |

**The bridge — session-to-token translation (Go middleware):**

```go
// In core's admin proxy middleware
func adminProxyHandler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Path 1: Device app with Bearer token — pass through
        if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
            if validateClientToken(auth[7:]) {
                proxyToBrain(w, r)
                return
            }
            http.Error(w, "Unauthorized", 401)
            return
        }

        // Path 2: Browser with session cookie — translate to Bearer
        cookie, err := r.Cookie("dina_session")
        if err != nil || !validateSession(cookie.Value) {
            serveLoginPage(w, r)  // embed.FS static HTML
            return
        }

        // Inject CLIENT_TOKEN before proxying (brain sees Bearer token)
        r.Header.Set("Authorization", "Bearer "+clientToken)
        proxyToBrain(w, r)
    })
}
```

**Why passphrase, not a separate admin password:** Adding another credential means another thing to lose, another thing to brute-force, another thing to configure in `install.sh`. The passphrase is already the user's "master key" for Dina — vault encryption, identity recovery, and now admin access. One credential, one responsibility. Users who want passwordless admin access can use device apps (Bearer token from pairing flow).

```
brain/
  src/
    main.py               # Master FastAPI app (sub-mounts brain + admin)
    dina_brain/            # Brain API sub-app (/api/*, BRAIN_TOKEN)
      app.py
      ...
    dina_admin/            # Admin UI sub-app (/admin/*, CLIENT_TOKEN)
      app.py
      core_client.py       # Calls core:8100 with CLIENT_TOKEN
      templates/
        dashboard.html     # Connector status, health, vault size
        history.html       # Nudge history, searchable
        contacts.html      # Contact list, sharing rules
        settings.html      # Personas, reboot mode, connectors
      routes/
        dashboard.py
        history.py
        contacts.py
        settings.py
```

### Onboarding: Progressive Disclosure

Complexity exists on day one, but the user doesn't see it. The principle is Signal-level simplicity: **password → done.**

```
What the user sees (managed hosting):
  1. "Enter email and password"
  2. Done. Dina starts ingesting via OpenClaw.

What happens silently:
  1. Core generates BIP-39 mnemonic (24 words) → master seed (512-bit)
  2. Core derives root Ed25519 keypair via SLIP-0010 (m/9999'/0')
  3. Core registers did:plc with plc.directory
  4. Core derives per-database DEKs from master seed via HKDF
  5. Password → Argon2id → KEK → wraps master seed (key wrapping, not derivation)
  6. Core creates identity.sqlite (contacts, audit, kv_store) and personal.sqlite (all content)
  7. Core sets convenience mode (auto-unlock, writes master seed to keyfile)
  9. Brain starts guardian angel loop
  10. Brain triggers initial sync via MCP → OpenClaw fetches Gmail/Calendar
```

Features unlock as the user is ready:

| When | What |
|------|------|
| **Day 1** | Email + calendar ingestion, basic nudges |
| **Day 7** | Prompt: "Write down these 24 words. They're your recovery key." (Phase 2: "You have trusted contacts now — set up social recovery so you don't depend on paper alone.") |
| **Day 14** | Prompt: "Want to connect WhatsApp too?" |
| **Day 30** | Prompt: "You can separate health and financial data into private compartments" |
| **Month 3** | Power user discovers personas, sharing rules, self-hosting option |

One default persona (`/personal`), not five. The multi-persona key hierarchy exists in the code but only `/personal` is created at setup. Adding `/health`, `/financial`, `/citizen` is a settings screen action, not an onboarding step. Mnemonic backup is deferred, not skipped — generated at setup, prompted after the user has had a week to see value. Sharing rules default to empty.

