> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Infrastructure Layer

### Home Node Deployment

The Home Node runs three containers by default, orchestrated by docker-compose: dina-core (Go/net/http — vault, keys, NaCl messaging, admin proxy), dina-brain (Python/Google ADK — agent reasoning + admin UI), and dina-pds (AT Protocol PDS — public Trust Network). An optional fourth container (llama — llama.cpp, local LLM) is available via `--profile local-llm`. No separate database server, no Kubernetes.

**The docker-compose stack:**
- **dina-core**: Go binary + SQLCipher vaults (`identity.sqlite` + per-persona `.sqlite` files) — **private layer**. Ports: 443 (external), 8100 (internal). Reverse-proxies `/admin` to brain:8200/admin. Browser authentication gateway (session cookie → Bearer token translation).
- **dina-brain**: Python + Google ADK agent loop + Admin UI — **private layer**. Port: 8200 (unified — `/api/*` brain API, `/admin/*` admin UI, `/healthz` health).
- **dina-pds**: AT Protocol PDS for Trust Network — **public layer** (trust data only). Port: 2583 (external).
- **llama** (optional): llama.cpp + Gemma 3n E4B GGUF — **private layer**. Port: 8080 (internal). Enabled via `--profile local-llm`.
- Output: NaCl messaging endpoint + WebSocket API for clients + Admin UI + AT Protocol firehose
- Deployment: `docker compose up -d` (3 containers) or `docker compose --profile local-llm up -d` (4 containers)

**The docker-compose.yml (Phase 1 — strict):**

```yaml
# docker-compose.yml
# DINA: Phase 1 Developer Preview
# Security: Docker Secrets, network isolation, healthchecks

services:
  # -------------------------------------------------------------------
  # 1. THE KERNEL (Go)
  # Role: Gateway, Vault Manager, Ingress, Admin Proxy
  # -------------------------------------------------------------------
  core:
    image: ghcr.io/dinakernel/core:v0.1
    container_name: dina-core
    restart: unless-stopped

    # PORTS: 8100 for local dev (no TLS). Production: add ingress tunnel to 443.
    ports:
      - "8100:8100"

    # NETWORK: The Hub (connects to everything)
    networks:
      - dina-public
      - dina-brain-net
      - dina-pds-net

    # CONFIG: Non-sensitive only
    environment:
      - DOMAIN=${DOMAIN:-localhost}
      - PDS_ENDPOINT=http://pds:2583
      - DINA_VAULT_MODE=${DINA_VAULT_MODE:-security}  # "security" or "convenience"
      - TZ=UTC

    # SECRETS: Mounted read-only to /run/secrets/ (tmpfs, never on disk)
    secrets:
      - dina_passphrase
      - brain_token

    # HEALTH: Brain won't start until this passes
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8100/healthz"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s

    volumes:
      - ./data:/var/lib/dina    # identity.sqlite, vault/, inbox/, keyfile, config.json

    depends_on:
      pds:
        condition: service_started

  # -------------------------------------------------------------------
  # 2. THE WORKER (Python)
  # Role: LLM Logic, Admin UI. Needs outbound internet (Gemini, OpenClaw).
  # -------------------------------------------------------------------
  brain:
    image: ghcr.io/dinakernel/brain:v0.1
    container_name: dina-brain
    restart: unless-stopped

    # NETWORK: Isolated from PDS, but has outbound internet (standard bridge)
    networks:
      - dina-brain-net

    # HOST BRIDGE: For OpenClaw running on developer's machine
    extra_hosts:
      - "host.docker.internal:host-gateway"

    # ENV: Non-sensitive external service config only
    environment:
      - DINA_CORE_URL=http://core:8100
      - GOOGLE_API_KEY=${GOOGLE_API_KEY}
      - OPENCLAW_MCP_URL=${OPENCLAW_MCP_URL:-http://host.docker.internal:3000}

    # SECRETS
    secrets:
      - brain_token

    # HEALTH: Detects zombie brain process (reasoning loop hung, OOM, etc.)
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8200/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

    # DEPENDENCY: Won't start until Core is healthy (vault unlocked, DB ready)
    depends_on:
      core:
        condition: service_healthy

  # -------------------------------------------------------------------
  # 3. THE TRUST NETWORK (AT Protocol PDS)
  # Role: Public federation — relay crawling, trust data
  # -------------------------------------------------------------------
  pds:
    image: ghcr.io/bluesky-social/pds@sha256:...  # PINNED DIGEST — never :latest
    container_name: dina-pds
    restart: unless-stopped

    # NETWORK: Public (relay crawling) + internal (core pushes records)
    networks:
      - dina-public
      - dina-pds-net

    ports:
      - "2583:2583"

    volumes:
      - ./data/pds:/pds

    environment:
      - PDS_HOSTNAME=${DOMAIN:-localhost}

    # HEALTH: Detects PDS crash or federation failure
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:2583/xrpc/_health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

  # -------------------------------------------------------------------
  # 4. LOCAL LLM (Optional — enabled via --profile local-llm)
  # -------------------------------------------------------------------
  llama:
    image: ghcr.io/dinakernel/llama@sha256:...  # PINNED DIGEST
    container_name: dina-llama
    restart: unless-stopped
    profiles: ["local-llm"]

    networks:
      - dina-brain-net

    volumes:
      - ./data/models:/models

    # HEALTH: Detects model load failure or inference hang
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s  # models take time to load into RAM

# -------------------------------------------------------------------
# SECRETS: File-based, never environment variables
# -------------------------------------------------------------------
secrets:
  dina_passphrase:
    file: ./secrets/dina_passphrase.txt
  brain_token:
    file: ./secrets/brain_token.txt

# -------------------------------------------------------------------
# NETWORKS: Bowtie topology — Core is the hub
# -------------------------------------------------------------------
networks:
  dina-public:       # Internet-facing (core ingress, PDS federation)
  dina-brain-net:    # Core ↔ Brain (standard bridge — brain needs outbound internet
                     #   for Gemini/Claude API and host.docker.internal for OpenClaw)
  dina-pds-net:      # Core ↔ PDS (internal — PDS only needs inbound from relay + core)
    internal: true
```

**Network topology — "The Bowtie":**

Core is the knot. Brain and PDS are the loops. They never touch each other.

```
                    ┌─────────────────┐
 Internet ◄────────┤  dina-public     │
                    │  (standard)      │
                    │                  │
         ┌─────────┤  core ◄──────────┤  pds
         │         │                  │
         │         └──────────────────┘
         │
         │         ┌─────────────────┐
         └─────────┤  dina-brain-net  │
                   │  (standard)      │
                   │                  │
         core ◄────┤  brain ──────────┼──► api.google.com (Gemini)
                   │                  ├──► api.anthropic.com (Claude)
                   │           ┌──────┼──► host.docker.internal (OpenClaw)
                   │  llama ◄──┘      │
                   └──────────────────┘

  Isolation guarantee: brain ✗ → pds (no shared network)
                       pds   ✗ → brain (no shared network)
                       core  ✓ → both (the hub)
```

**Port mapping:**

```
Phase 1 (local dev — no TLS):
  Host:8100  → core:8100   (developer access: API, admin proxy, messaging)
  Host:2583  → pds:2583    (AT Protocol relay crawling)

Production (behind ingress tunnel):
  Tunnel:443 → core:443    (clients, Dina-to-Dina NaCl messaging, /admin proxy)
  Host:2583  → pds:2583    (AT Protocol relay crawling)

Internal (Docker network only):
  8100 → core   (brain calls this for vault, PII scrub, signing)
  8200 → brain  (core calls this for /api/* reasoning + /admin/* UI proxy)
  8080 → llama  (brain + core call this, when present)
```

**External URL surface (production):**

```
  https://my-dina.example.com/                       → signup/unlock (core)
  https://my-dina.example.com/admin                  → admin UI (core auth gateway → brain:8200/admin)
  https://my-dina.example.com/msg                    → NaCl messaging endpoint (core)
  https://my-dina.example.com/.well-known/atproto-did → DID document for PDS federation (core)
  https://my-dina.example.com:2583                   → PDS (AT Protocol relay crawling)
```

**AT Protocol discovery (critical):** Core must serve `GET /.well-known/atproto-did` on port 443 (or 8100 in dev mode). This returns the user's `did:plc:...` string, which AT Protocol relays use to find the PDS on port 2583. Without this one-line handler in core's router, PDS federation silently fails:

```go
// In core's HTTP router — required for AT Protocol discovery
mux.HandleFunc("/.well-known/atproto-did", func(w http.ResponseWriter, r *http.Request) {
    did, _ := vault.GetRootDID()
    w.Header().Set("Content-Type", "text/plain")
    w.Write([]byte(did)) // e.g., "did:plc:abc123..."
})
```

**Bootstrap script (`install.sh`):**

Run once before `docker compose up`. Generates secrets, sets permissions, prevents accidental git commits.

```bash
#!/bin/bash
# install.sh — Run this ONCE before 'docker compose up'

set -e

# 1. Create directory structure
mkdir -p secrets data/vault data/inbox data/pds data/models

# 2. Generate the Brain Token (pre-shared secret, read by both core and brain)
echo "Generating Brain Token..."
openssl rand -hex 32 > secrets/brain_token.txt

# 3. Vault passphrase
echo ""
read -s -p "Enter a strong passphrase for your Vault: " pass
echo ""
echo "$pass" > secrets/dina_passphrase.txt

# 4. Lock down permissions
chmod 700 secrets
chmod 600 secrets/*

echo ""
echo "Setup complete. Secrets in ./secrets/ (gitignored)."
echo "Run: docker compose up"
```

**`.gitignore` (security-critical — must include):**

```gitignore
# Security: NEVER commit secrets
secrets/
*.env

# Runtime data
data/

# IDE
.DS_Store
.vscode/
```

**Data volumes:**

```
core:
  ./data/identity.sqlite        — Tier 0: contacts, sharing policy, audit log, kv_store (SQLCipher)
  ./data/vault/personal.sqlite  — Phase 1: all content (SQLCipher, per-persona DEK)
  ./data/vault/health.sqlite    — Phase 2: per-persona files (each with own DEK)
  ./data/vault/...
  ./data/keyfile                — convenience mode master seed (chmod 600, absent in security mode)
  ./data/inbox/                 — Dead Drop spool (encrypted blobs, locked state)
  ./data/config.json            — gatekeeper tiers, settings

brain:
  (stateless — all state lives in core's vault)

llama:
  ./data/models/                — GGUF model files (auto-downloaded on first start)

pds:
  ./data/pds/                   — AT Protocol repo data
```

**Host bridge for OpenClaw (MCP):**

Phase 1 agents (OpenClaw) run on the developer's machine, outside Docker. The brain container reaches them via `host.docker.internal` — a Docker DNS name that resolves to the host machine's IP. The `extra_hosts` directive ensures this works on Linux (macOS has it built-in):

```yaml
brain:
  extra_hosts:
    - "host.docker.internal:host-gateway"  # Linux support
  environment:
    - OPENCLAW_MCP_URL=http://host.docker.internal:3000
```

**Encryption key passing:**

| Mode | What dina-core does at boot |
|------|---------------------------|
| **Security** | Reads `/run/secrets/dina_passphrase` → Argon2id → KEK → unwrap Master Seed → derive per-database DEKs via HKDF → `PRAGMA key` each database. Secret file is tmpfs-mounted, never on disk inside the container. |
| **Convenience** | Ignores the secret. Reads Master Seed directly from `/var/lib/dina/keyfile` (`chmod 600`) → derive per-database DEKs via HKDF. |

**Secret management rules:**
- Credentials are **never** set as `environment:` variables in docker-compose — they would appear in `docker inspect`, `/proc/*/environ`, process listings, and crash dumps.
- All secrets use Docker Secrets (file-based), mounted as in-memory tmpfs files at `/run/secrets/` — they never touch disk inside the container.
- The `secrets/` directory is in `.gitignore` and `.dockerignore`.
- `BRAIN_TOKEN` is generated once by `install.sh` (`openssl rand -hex 32`). Both core and brain read the same file. No runtime generation. Phase 2 can rotate it on every boot; Phase 1, a static pre-shared secret in a file is sufficient. **Compared to CLIENT_TOKEN:** BRAIN_TOKEN is a single per-machine static secret shared via Docker Secrets (never leaves the Docker network). CLIENT_TOKEN is used only for admin web UI login, stored as SHA-256 hash in `identity.sqlite` `device_tokens` table. All client devices use Ed25519 keypairs (no shared secret).
- `GOOGLE_API_KEY` is the one exception — it lives in `.env` (not secrets) because it's a cloud API key, not a local credential. If compromised, you revoke it in the Google Console. It doesn't unlock your vault or compromise your identity.
- For managed hosting (Fly.io), use `fly secrets set VAULT_PASSPHRASE=...` — Fly injects as an env var visible only to the process, not in logs or inspect output.

**`.env.example` (the 2-minute start):**

```bash
# .env.example — copy to .env and fill in

# NETWORK
DOMAIN=192.168.1.42              # Your machine's LAN IP (or localhost for dev)

# INTELLIGENCE
GOOGLE_API_KEY=AIzaSy...         # Gemini API key (for LLM reasoning)
OPENCLAW_MCP_URL=http://host.docker.internal:3000  # OpenClaw on host machine

# VAULT MODE
DINA_VAULT_MODE=security         # "security" (passphrase) or "convenience" (auto-unlock)
```

Four things total: domain, API key, OpenClaw URL, vault mode, plus two secrets generated by `install.sh` (passphrase, brain token). No OAuth credentials needed — OpenClaw manages external API auth. Developer fills in `.env`, runs `./install.sh`, runs `docker compose up`, has a working Dina.

**Three deployment profiles:**

| | **Cloud LLM** (default, Phase 1) | **Local LLM** (`--profile local-llm`) | **Hybrid** (recommended long-term) |
|--|---|---|---|
| **Containers** | 3 (core, brain, pds) | 4 (core, brain, pds, llama) | 4 (core, brain, pds, llama) |
| **Text LLM** | Gemini Flash Lite / Claude (cloud API) | Gemma 3n E4B via llama:8080 (local) | llama for simple tasks, cloud for complex reasoning |
| **Voice STT** | Deepgram Nova-3 (WebSocket streaming, ~150-300ms). Fallback: Gemini Flash Lite Live API. | Deepgram (or future: whisper.cpp when added) | Deepgram for streaming, local for batch |
| **PII scrubbing** | Tier 1 (regex in Go) + Tier 2 (spaCy NER in Python) | Tier 1 + 2 + Tier 3 (LLM NER via Gemma 3n on llama) | Tier 1 + 2 + 3 (llama always available) |
| **Embeddings** | `gemini-embedding-001` (cloud, $0.01/1M tokens) | EmbeddingGemma 308M via llama:8080 (local) | Local via llama (never leaves machine) |
| **Minimum RAM** | **2GB** (Go core ~200MB + Python brain ~500MB + PDS ~100MB + OS ~300MB + headroom) | **8GB** (+ Gemma 3n E4B ~3GB). Mac Mini M4 (16GB+) recommended. | **8GB** (same as local) |
| **CPU** | 2 cores | 4+ cores. Apple Silicon or x86 with AVX2. | 4+ cores |
| **Storage** | 10GB (grows with vault) | 15GB (+ model files ~3GB: Gemma E4B) | 15GB |
| **Internet** | Required (LLM + STT + messaging) | Required for messaging + PDS. LLM works offline. | Required for cloud LLM escalation + messaging |
| **Monthly cost** | ~$5-15 (Flash Lite: ~$1-5. Deepgram: ~$10 at 45 min/day.) | Hardware + electricity only (LLM). Still need Deepgram for voice. | ~$5 (cloud for complex reasoning only) |
| **Best for** | Phase 1 development, cheap VPS, getting started fast | Privacy maximalists, unreliable internet | Daily drivers — local for PII/embeddings, cloud for hard reasoning |

**Phase 1 ships Cloud LLM profile only.** Local LLM and Hybrid profiles ship once the end-to-end flow works without issues. All profiles share identical vault, identity, messaging, and persona layers — only the inference backends differ.

**Why these defaults for the Cloud LLM profile:**

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

**Why Whisper for local voice STT (not Gemma 3n audio):**
- Gemma 3n audio: ~13% WER (1 in 8 words wrong). Whisper Large v3 Turbo: ~4.4% WER. For voice commands, accuracy matters.
- Gemma 3n audio does NOT work in Ollama or llama.cpp today — only via MLX (Apple) or Hugging Face Transformers. whisper.cpp is battle-tested and works everywhere.
- Whisper has mature chunking pipelines for continuous voice. Gemma 3n audio is limited to 30-second clips with no streaming.
- Future: if Gemma 3n audio lands in llama.cpp with improved WER, the stack could consolidate.

**What always stays local regardless of mode:**
- PII scrubbing (regex first pass — always in Go core, never touches cloud)
- Vault encryption/decryption (SQLCipher, never leaves Home Node)
- DID signing/verification (Ed25519, never leaves Home Node)
- Persona compartment enforcement (cryptographic, never leaves Home Node)

**Sensitive persona rule (all profiles):** Health and financial persona data is always processed through the strongest available privacy path. With llama: processed locally, never leaves the Home Node (best privacy). Without llama (Cloud LLM profile): mandatory Entity Vault scrubbing — Tier 1 (regex) + Tier 2 (spaCy NER) strip all identifying entities before routing to cloud LLM. The cloud provider sees health/financial **topics** but cannot identify **who**. User must consent to this tradeoff during setup. This is enforced at the LLM router level in dina-brain. See "The Entity Vault Pattern" in Layer 6 for the full mechanism.

**Switching profiles:** `docker compose up -d` (cloud LLM) or `docker compose --profile local-llm up -d` (local LLM). Brain auto-detects whether llama:8080 is available and routes accordingly. Users can switch at any time — the vault, identity, and messaging layers are identical across all profiles.

### LLM & Voice Inference

| Where | Runtime | Model | Use Cases | Profile |
|-------|---------|-------|-----------|---------|
| **Text LLM** | | | | |
| Home Node | Cloud API | Gemini 2.5 Flash Lite ($0.10/$0.40 per 1M tokens) | Summarization, drafting, context assembly, classification, routing | Cloud (default) |
| Home Node | llama.cpp (GGUF) | Gemma 3n E4B (~3GB RAM) | Same as above, but local. Also: PII scrubbing NER fallback | Local LLM |
| Home Node | Cloud API | Gemini 2.5 Flash / Pro / Claude / GPT-4 | Complex multi-step reasoning when Flash Lite quality is insufficient | Cloud (escalation), Hybrid |
| **Voice STT** | | | | |
| Home Node | Cloud API (WebSocket) | Deepgram Nova-3 ($0.0077/min, ~150-300ms) | Real-time voice command transcription, continuous dictation | All profiles |
| Home Node | Cloud API (WebSocket) | Gemini Flash Lite Live API ($0.30/1M audio tokens) | Fallback STT when Deepgram is unavailable | All profiles (fallback) |
| **Embeddings** | | | | |
| Home Node | Cloud API | `gemini-embedding-001` ($0.01/1M tokens) | Embedding generation for Tier 2 Index | Cloud |
| Home Node | llama.cpp (GGUF) | EmbeddingGemma 308M (~300MB) | Same: embedding generation, fully local | Local LLM, Hybrid |
| **On-device** | | | | |
| Android client | LiteRT-LM | Gemma 3n E2B | Offline drafting, quick replies, on-device search | All profiles |
| Desktop client | llama.cpp / MLX | Gemma 3n E4B | Same as Android — latency-sensitive local tasks | All profiles |
| Thin client | None | None | All inference routed to Home Node | All profiles |

### Client Authentication

Rich clients and the CLI authenticate to the Home Node using two methods:

1. **Ed25519 signature auth** (CLI — exclusive): The CLI generates an Ed25519 keypair during `dina configure`, registers the public key via the pairing ceremony, and signs every request with `X-DID` + `X-Timestamp` + `X-Signature` headers. No token is exchanged or stored. This is the only auth method the CLI supports.

2. **CLIENT_TOKEN** (admin web UI only): A 32-byte cryptographic random value (hex-encoded, 64 chars). Used as a login password for the admin web UI (browser POSTs it, gets a session cookie; Brain proxies Core requests with Bearer header). Core stores only the SHA-256 hash. If `identity.sqlite` is exfiltrated, the attacker cannot extract usable tokens.

**Why SHA-256, not Argon2id for CLIENT_TOKEN?** CLIENT_TOKEN has 256 bits of entropy (cryptographic random). Argon2id is designed for low-entropy inputs like human-chosen passwords where you need to slow down brute force. Nobody is brute-forcing a 256-bit random token. SHA-256 is sufficient and avoids wasting CPU on every request validation.

```
THE PAIRING FLOW:

  ┌─────────────────────────────────────────────────────────┐
  │  6-digit code = short-lived physical proximity proof    │
  │  CLIENT_TOKEN = admin web UI login password              │
  │  These are NOT the same thing.                          │
  └─────────────────────────────────────────────────────────┘

FIRST DEVICE (docker compose up):
  1. Core generates 6-digit pairing code (expires in 5 minutes)
     Core stores: pending_pairings[code] = {expires, used: false}
  2. Terminal prints:
       Dina is running on http://192.168.1.42:8100
       Pairing code: 847 291
       Expires in 5 minutes.
  3. User opens Dina app on phone
  4. mDNS auto-discovery finds Home Node on LAN
     (or user types the IP manually)
  5. User enters 6-digit pairing code
  6. Phone generates Ed25519 keypair → derives did:key:z6Mk...
  7. Phone: POST /v1/pair/complete {code: "847291", device_name: "Raj's iPhone",
     public_key_multibase: "z6MkhaXg..."}
  8. Core validates:
       code exists? YES. Expired? NO. Already used? NO.
  9. Core registers public key in identity.sqlite device_tokens table
  10. Core returns (over TLS):
       {
         device_id: "dev_...",
         device_did: "did:key:z6MkhaXg...",
         node_did: "did:plc:5qtzkvd...",
         ws_url: "wss://192.168.1.42:8100/ws"
       }
  11. Phone stores Ed25519 private key in secure hardware
      (iOS Secure Enclave / Android StrongBox / TPM on desktop)
  12. Every request signed with Ed25519 — no token exchanged.

SUBSEQUENT DEVICES:
  Same flow — core generates a new pairing code via admin UI or terminal.
  Each device gets its own Ed25519 keypair. Revoke one without affecting others.

MANAGED HOSTING:
  Signup flow provides the pairing code. No terminal.

QR CODE:
  Deferred. Nice-to-have for non-developers. Pairing code is sufficient.
  6 digits + mDNS solves the real friction (finding the IP).

Ed25519 REQUEST SIGNING:
  All client devices generate Ed25519 keypair → derive did:key:z6Mk...
  (multicodec 0xed01 + base58btc). During pairing, device sends
  public_key_multibase in POST /v1/pair/complete.
  Core stores the public key in device_tokens.

  Every HTTP request carries three headers:
    X-DID:       did:key:z6MkhaXg...   (device identity)
    X-Timestamp: 2025-01-15T10:30:00Z  (ISO 8601 UTC)
    X-Signature: <hex(Ed25519(canonical_payload))>

  Canonical signing payload:
    {METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{SHA256_HEX(body)}

  Core middleware verifies: DID is paired, timestamp within 5-min window,
  signature matches. Reject → 401. CLI uses Ed25519 exclusively — no
  Bearer token fallback.
```

**Pairing API endpoints:**

```
POST /v1/pair/initiate
  → Core generates 6-digit code (expires in 5 minutes)
  → Core stores: pending_pairings[code] = {expires, device_name}
  → Returns: {code: "847291", expires_in: 300}

POST /v1/pair/complete
  Body: {code: "847291", device_name: "Raj's iPhone",
         public_key_multibase: "z6MkhaXg..."}   ← required for CLI (Ed25519 pairing)
  → Core validates code (exists, not expired, not used)
  → If public_key_multibase provided (CLI): register Ed25519 public key,
    derive device DID. No CLIENT_TOKEN generated.
  → If no public_key_multibase (admin UI setup): generate CLIENT_TOKEN
    (crypto/rand 32 bytes → hex), store SHA-256 hash in device_tokens.
  → Core deletes pending pairing
  → Returns: {
      device_id: "dev_...",
      node_did: "did:plc:5qtzkvd...",
      device_did: "did:key:z6MkhaXg...",  ← if Ed25519 pairing
      client_token: "a3f8b2c1d4e5...",    ← only if token pairing (not CLI)
      ws_url: "wss://192.168.1.42:8100/ws"
    }
  → Device stores keypair in secure storage (CLI: ~/.dina/cli/identity/,
    phone: Keychain/Keystore, desktop: TPM) and uses Ed25519 signing
```

**Device management:**

```
User: "Show my paired devices"
Brain: queries device_tokens via core
Brain: "You have 3 paired devices:
        1. Raj's iPhone (last seen: 2 minutes ago)
        2. MacBook Pro (last seen: yesterday)
        3. iPad (last seen: 3 weeks ago)"

User: "Revoke the iPad"
Brain: PATCH /v1/devices/{token_id}/revoke
Brain: "iPad revoked. It will need to re-pair to connect."

Core sets revoked=true. Next request from iPad → 401. Immediate.
```

**Token lifecycle summary:**

```
For CLIENT_TOKEN (admin web UI):
  Generate:   crypto/rand 32 bytes → hex → CLIENT_TOKEN (plaintext)
  Store:      SHA-256(CLIENT_TOKEN) → device_tokens.token_hash
  Send:       plaintext returned to device ONCE during pairing (over TLS)
  Validate:   device sends token → core hashes → compares to stored hash
  Revoke:     user says "revoke device" → core sets revoked=true
  Re-pair:    after import/restore, all tokens invalidated → re-pair required

For Ed25519 (CLI devices):
  Generate:   CLI creates Ed25519 keypair locally during `dina configure`
  Store:      Public key registered in device_tokens during pairing
  Send:       Only public key sent to Core (private key never leaves CLI)
  Validate:   CLI signs every request → Core verifies signature against stored public key
  Revoke:     user says "revoke device" → core sets revoked=true
  Re-pair:    CLI runs `dina configure` again with new keypair
```

**Phase 2: Secure Enclave Key Storage**

```
SECURE ENCLAVE KEY STORAGE:
  Phase 1 stores Ed25519 private keys as PEM files on disk (chmod 0600).
  Phase 2 moves key generation and signing into hardware security modules.
  The private key never leaves the HSM, never enters user-space RAM.

  ARCHITECTURE:
    CLIIdentity interface stays the same (backend is swappable):
      .sign_request(method, path, body) → (did, timestamp, signature)
      .did() → "did:key:z6Mk..."
      .public_key_multibase() → "z6Mk..."

    Backend selection (in priority order):
      1. HSM (default if available):
         Key generated inside Secure Enclave / StrongBox / TPM.
         Signing: CLI → sign_request() → HSM.sign(canonical_payload) → signature
         Private key never in Python process memory.
      2. Encrypted PEM (explicit fallback):
         PKCS#8 PEM encrypted with Argon2id-derived passphrase.
         For headless servers, VMs, CI environments.
      3. Plaintext PEM (Phase 1 compat):
         Current behavior. Deprecation warning on startup.

    Platform HSM APIs:
      iOS:     Secure Enclave — SecKeyCreateRandomKey + kSecAttrTokenIDSecureEnclave
      Android: StrongBox Keystore — setIsStrongBoxBacked(true)
      macOS:   Secure Enclave — Security.framework / CryptoKit (T2/Apple Silicon)
      Linux:   TPM 2.0 — tpm2-tss / PKCS#11
      Windows: CNG / NCrypt — NCryptCreatePersistedKey (TPM-backed or software KSP)

  CLI COMMANDS:
    dina configure --hsm         # Auto-detect available HSM, generate key inside it
    dina configure --software    # Force encrypted PEM fallback
    dina configure --promote-to-hsm  # Migrate existing PEM key to HSM:
      → Generates NEW keypair inside HSM
      → Re-pairs with Home Node (auto: initiate + complete with new public key)
      → Old PEM-based device key revoked
      → Old PEM files deleted after confirmation

  KEY LIFECYCLE (HSM):
    Generate:  HSM creates Ed25519 keypair internally
    Export:    Only PUBLIC key exported → derive did:key:z6Mk...
    Register:  Public key sent to Home Node during pairing (public_key_multibase)
    Sign:      HSM signs canonical payload → returns signature bytes
    Rotate:    Generate new key in HSM → re-pair → old key revoked
    Destroy:   HSM deletes key material (or device wipe)
```

**Phase 2: Tailscale Zero-Config Authentication (Server-Initiated)**

```
TAILSCALE AUTH (SERVER-INITIATED):
  Home Node initiates encrypted connections to client CLIs via Tailscale mesh.
  No tokens, no signatures, no pairing ceremony. Tailnet membership = trust.

  TOPOLOGY:
    Home Node (100.x.y.z) ←→ Tailscale WireGuard mesh ←→ Client CLI (100.a.b.c)
    Both run tailscaled. WireGuard handles mutual authentication.

  SERVER-TO-CLIENT FLOW:
    Home Node resolves client via MagicDNS: macbook.tailnet-name.ts.net
    Home Node connects to client's Tailscale IP on CLI listener port (8300)
    Both sides verify peer identity via Tailscale local API whois
    Connection established — fully encrypted, mutually authenticated

  CLIENT CLI LISTENER:
    Lightweight HTTP server bound to Tailscale interface only (100.a.b.c:8300)
    NOT bound to 0.0.0.0 — only reachable via tailnet
    Serves: /healthz, /notify, /sync (receives pushes from Home Node)

  AUTO-REGISTRATION:
    First connection from Home Node to new tailnet device:
    → Home Node calls Tailscale local API /localapi/v0/status to discover nodes
    → For each new node, calls /localapi/v0/whois?addr=<tailscale-ip> to get identity
    → Creates device entry: auth_type=tailscale, name=<tailscale hostname>
    → No manual pairing needed — joining the tailnet IS the pairing

  DOCKER COMPOSE (Home Node):
    tailscale:
      image: tailscale/tailscale:latest
      hostname: dina-homenode
      environment:
        - TS_AUTHKEY=${TAILSCALE_AUTHKEY}
        - TS_STATE_DIR=/var/lib/tailscale
      volumes:
        - tailscale-state:/var/lib/tailscale
      cap_add: [NET_ADMIN, NET_RAW]
    core:
      network_mode: "service:tailscale"  # shares tailscale's network namespace

  REVOCATION:
    Remove device from tailnet via Tailscale admin console → immediate disconnect.
    Or revoke in Dina admin UI → device entry marked revoked.

  COMPARISON WITH OTHER AUTH METHODS:
    | Method          | Setup             | Direction        | Auth proof              | NAT traversal          |
    |-----------------|-------------------|------------------|-------------------------|------------------------|
    | CLIENT_TOKEN    | Setup/install     | Browser → Server | Bearer token (admin UI) | Manual port-forward    |
    | ED25519_SIGNED  | Keygen + pair     | Client → Server  | Signature headers       | Manual port-forward    |
    | TAILSCALE       | Join tailnet      | Server → Client  | WireGuard mutual auth   | Built-in (DERP relays) |
    Note: All client devices use ED25519_SIGNED. CLIENT_TOKEN is admin web UI only.

  COEXISTENCE:
    All four auth methods (BRAIN_TOKEN, CLIENT_TOKEN, ED25519_SIGNED, TAILSCALE)
    coexist. Tailscale is for home users with personal devices. CLIENT_TOKEN is
    admin web UI only. Ed25519 is for all client devices. CI/CD uses Ed25519.
```

### Client ↔ Home Node WebSocket Protocol

After pairing, clients communicate with the Home Node over an authenticated WebSocket connection. This is the primary real-time channel for queries, responses, proactive whispers, and system notifications.

**Connection and authentication:**

```
Phase 1 (auth frame — no token in URL):

  1. Client connects:  wss://dina.local:8100/ws
  2. Core accepts upgrade, starts 5-second auth timer
  3. Client sends auth frame:
       {"type": "auth", "did": "...", "timestamp": "...", "signature": "..."}  ← client devices
  4. Core validates: Ed25519 signature verification against stored public key
       Valid (signature verified, not revoked):
         {"type": "auth_ok", "device": "phone_pixel7"}
         Core updates last_seen timestamp
       Invalid (hash not found, or revoked):
         {"type": "auth_fail"} → core closes connection
       Timeout: core closes connection after 5s with no auth frame

Phase 2 (session tokens — reduces token exposure):
  POST /v1/auth/session {token: CLIENT_TOKEN}
    → returns short-lived session_token (24h TTL)
  Client connects with session_token in auth frame instead
```

**Message envelope — all messages are JSON with `type`/`id`/`payload`:**

```json
// ─── Client → Core ───

// User asks a question
{
  "type": "query",
  "id": "req_001",
  "payload": {
    "text": "Am I free at 3pm today?",
    "persona": "/personal"
  }
}

// User action (connect service, unlock persona, etc.)
{
  "type": "command",
  "id": "req_002",
  "payload": { "action": "unlock_persona", "persona": "/financial" }
}

// Client acknowledges receipt of a message
{
  "type": "ack",
  "id": "evt_003"
}

// Heartbeat response
{ "type": "pong", "ts": 1708300000 }
```

```json
// ─── Core → Client ───

// Streaming response to a query (brain is thinking)
{
  "type": "whisper_stream",
  "reply_to": "req_001",
  "payload": { "chunk": "Looking at your calendar... " }
}

// Final response to a query
{
  "type": "whisper",
  "reply_to": "req_001",
  "payload": {
    "text": "You're free at 3pm. Your next meeting is at 4:30.",
    "sources": ["calendar:event:abc123"]
  }
}

// Proactive whisper (no request — brain initiated)
{
  "type": "whisper",
  "id": "evt_003",
  "payload": {
    "text": "Sancho just left home. He'll arrive in about 15 minutes.",
    "trigger": "didcomm:geofence:sancho:departed",
    "tier": 2
  }
}

// System notification (watchdog, connector status)
{
  "type": "system",
  "id": "sys_004",
  "payload": {
    "level": "warning",
    "text": "Gmail hasn't synced in 48 hours. Re-authenticate?"
  }
}

// Heartbeat
{ "type": "ping", "ts": 1708300000 }

// Error
{
  "type": "error",
  "reply_to": "req_002",
  "payload": { "code": 403, "message": "/financial requires approval" }
}
```

**Message type summary:**

| Direction | Type | Purpose |
|-----------|------|---------|
| Client → Core | `auth` | Authenticate after connect (5s timeout) |
| Client → Core | `query` | User asks a question |
| Client → Core | `command` | User action (unlock persona, connect service) |
| Client → Core | `ack` | Acknowledge receipt of proactive message |
| Client → Core | `pong` | Heartbeat response |
| Core → Client | `auth_ok` / `auth_fail` | Auth result |
| Core → Client | `whisper_stream` | Streaming response chunk (`reply_to` links to request) |
| Core → Client | `whisper` | Final response or proactive insight |
| Core → Client | `system` | Watchdog alerts, connector status |
| Core → Client | `ping` | Heartbeat (every 30s) |
| Core → Client | `error` | Failed request |

**Routing logic:** `reply_to` present → response to a client request (match to pending `id`). `reply_to` absent → proactive event from brain or system.

**Heartbeat and reconnection:**

```
Heartbeat:
  Core sends {"type": "ping"} every 30 seconds
  Client responds {"type": "pong"} within 10 seconds
  3 missed pongs → core closes connection, marks device offline

Reconnection (client-side):
  Client detects disconnect → exponential backoff
  1s → 2s → 4s → 8s → 16s → max 30s
  On reconnect: send auth frame again → core replays buffered messages

Missed message buffer (core-side, per device):
  Max 50 messages, max 5 minutes retention
  On reconnect: core sends buffered messages in order
  Client ACKs each → ACKed messages removed from buffer
  After 5 min: buffer expires, messages gone
  Why 5 min, not longer: if phone is offline for hours, brain
  generates a fresh briefing instead of replaying stale notifications
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
| **Kubernetes** | Container orchestration for distributed services. Dina's Home Node is 3-4 containers on one machine. `docker compose up` is the entire deployment. |
| **GraphQL** | API layer for complex multi-consumer APIs. Dina has one consumer: you. Direct SQLite queries from the agent loop. |
| **Elasticsearch** | Distributed search cluster. SQLite FTS5 + in-memory HNSW handles search for a single user's data. |
| **Blockchain (L1)** | Gas costs, latency, complexity. Immutability violates sovereignty (right to delete). Federated servers + signed tombstones handle the Trust Network. Only use case is L2 Merkle root hash anchoring for timestamp proofs (Phase 3). |
| **CRDTs / Automerge** | Designed for peer-to-peer conflict resolution. With a Home Node as source of truth, client-server sync is simpler and sufficient. May reconsider for Phase 3 if we add collaborative features. |

Guiding principle: **one user, a handful of containers, one machine, per-persona encrypted vaults, one always-on endpoint.**

---

