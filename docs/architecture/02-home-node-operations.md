> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

### The Unattended Reboot Problem

Dina promises two things that conflict: "always on" and "encrypted at rest with your keys."

If the Home Node reboots at 2 AM (kernel panic, power outage, OS patch), Dina cannot restart — the Master Key (DEK) that SQLCipher needs to open the vault files is gone from RAM. She sits at a locked prompt until the user wakes up at 8 AM. Six hours of missed monitoring.

**This is a user choice, presented during setup:**

| Mode | What's on Disk | Boot Process | Risk | Best For |
|------|---------------|-------------|------|----------|
| **Security** | No `keyfile` on disk. Master Seed wrapped by passphrase-derived KEK, stored in a separate `wrapped_seed.bin` file. | App prompts for passphrase → Argon2id → KEK → unwrap seed → derive per-database DEKs → `PRAGMA key` → SQLCipher opens | Downtime after every reboot until user intervenes | Self-hosted, sovereign box, privacy maximalists |
| **Convenience** | `keyfile` in `/var/lib/dina/keyfile` (raw master seed, `chmod 600`) | App reads seed from keyfile → derive per-database DEKs → `PRAGMA key` → SQLCipher opens automatically | Physical theft or root compromise exposes the key. Mitigated by Confidential Computing on managed hosting. | Managed hosting, anyone who prioritizes uptime |

**The exact boot sequence (both modes):**
```
1. dina-core starts
2. Read config.json → determine mode (security or convenience)
3. Obtain Master Seed:
     Security mode:  prompt client device → receive passphrase
                     → Argon2id(passphrase, salt) → KEK
                     → AES-256-GCM unwrap Master Seed
     Convenience:    read Master Seed from /var/lib/dina/keyfile
4. Derive per-database DEKs from Master Seed:
     HKDF(seed, info="dina:vault:identity:v1")  → identity DEK
     HKDF(seed, info="dina:vault:personal:v1")  → personal DEK
5. Open identity.sqlite first (gatekeeper needs contacts + sharing policy):
     PRAGMA key = 'x<hex-encoded-identity-DEK>'
     PRAGMA cipher_page_size = 4096
     PRAGMA journal_mode = WAL
6. Open personal.sqlite (default persona, always unlocked):
     PRAGMA key = 'x<hex-encoded-personal-DEK>'
     (same PRAGMAs)
7. Other persona databases remain CLOSED until explicitly unlocked
   — DEKs not derived until needed, never held in RAM unnecessarily
8. Notify brain: POST brain:8200/v1/process {event: "vault_unlocked"}
```

**Implementation:** The setup wizard asks: "If your Home Node restarts, should Dina unlock automatically or wait for you?" The choice is stored in `config.json` (not in the vault — the vault is what needs unlocking). Users can change this setting at any time. On managed hosting, the default is Convenience. On self-hosted, the default is Security.

**No obfuscation.** The codebase is open source — "hiding" the key on disk via obfuscation provides zero real security. In Convenience mode, the key is stored plainly and the security boundary is the server's access controls (filesystem permissions, Confidential Computing enclave, hosting provider trust). This is honest engineering, not security theater.

### Dead Drop Ingress (Message Queuing While Locked)

**Problem:** "Sancho is 15 minutes away" has a 15-minute relevance window. If the Home Node just rebooted into Security mode (vault locked), the DIDComm endpoint rejects the message. The sender retries with exponential backoff. By the time the user wakes up and types their passphrase, the message is 6 hours old and useless.

**A locked door should not prevent the postman from sliding mail through the slot.** The message is already encrypted with Dina's public key — storing it on disk is safe because the private key needed to read it is locked inside the vault.

**The cryptographic catch-22:** NaCl messages use authenticated encryption — the sender's DID is inside the encrypted envelope. When the vault is locked, Core doesn't have the private key in RAM. It **cannot identify the sender** before writing to disk. Per-DID rate limiting is mathematically impossible when locked. This is why the ingress defense must be physics-based (IP addresses, disk quotas), not identity-based.

**The fix: state-aware ingress with a 3-valve pressure system.**

```
STATE-AWARE INGRESS:

  POST /msg arrives
        │
        ▼
  ┌─ Valve 1: IP Rate Limiter ────────────────────────┐
  │  Token bucket per IP: 50 req/hour                  │
  │  Global bucket: 1000 req/hour (botnet defense)     │
  │  Payload cap: 256KB (DIDComm is JSON, no media)     │
  │  Fail → HTTP 429 immediately                       │
  └───────────────────────────┬────────────────────────┘
                              │ pass
                              ▼
                    Is vault UNLOCKED?
                     /            \
                   YES             NO
                   /                \
          ┌──────▼──────┐   ┌──────▼──────┐
          │ FAST PATH   │   │ DEAD DROP   │
          │ (in-memory)  │   │ (disk spool) │
          │              │   │              │
          │ Decrypt msg  │   │ Check spool  │
          │ Check DID in │   │ size < 500MB? │
          │ contacts     │   │  YES → write  │
          │ Per-DID rate │   │    blob to    │
          │ limiting     │   │    ./data/    │
          │ Check trust  │   │    inbox/     │
          │ ring         │   │    202 OK     │
          │ Process      │   │  NO → reject  │
          │ immediately  │   │    429 full   │
          └──────────────┘   └──────────────┘
                                    │
                              (on vault unlock)
                                    │
                              ┌─────▼─────┐
                              │ Valve 3:  │
                              │ SWEEPER   │
                              │ Decrypt,  │
                              │ check DID,│
                              │ check TTL,│
                              │ blocklist │
                              │ spam IPs  │
                              └───────────┘
```

**The three valves:**

| Valve | When | What | Defense |
|-------|------|------|---------|
| **1: IP Rate Limiter** | Always (pre-decryption) | Token bucket per IP (50 req/hr), global (1000 req/hr), 256KB payload cap (HTTP 413 if exceeded) | Stops flooding before any disk I/O |
| **2: Spool Cap** | Vault locked only | Hard quota on `./data/inbox/` (500MB default, configurable via `DINA_SPOOL_MAX`). **Reject-new when full, not drop-oldest.** | Prevents disk exhaustion. Reject-new preserves existing legitimate messages — drop-oldest would let attackers flush real mail. |
| **3: Sweeper Feedback** | After vault unlock | Decrypt blobs, identify sender DID, check trust ring. Spam DIDs → add source IP to Valve 1 blocklist. | Retroactive blocklisting. Known spam IPs get permanently blocked at Valve 1. |

**State 1: Vault UNLOCKED (fast path — zero disk I/O):**

1. Message arrives at `POST /msg`.
2. Valve 1 passes (IP rate limit OK, payload < 256KB).
3. Core decrypts NaCl envelope in-memory (private key available).
4. Core checks sender DID: in contacts? Trust ring? Per-DID rate limit?
5. Passes directly to brain's processing queue. No disk write.
6. Result: sub-millisecond, lightning fast.

**State 2: Vault LOCKED (dead drop — survival mode):**

1. Message arrives at `POST /msg`.
2. Valve 1 passes (IP rate limit OK, payload < 256KB).
3. Core cannot decrypt (no private key in RAM). Cannot identify sender.
4. Check spool size: `./data/inbox/` < 500MB?
5. **YES:** Write raw encrypted bytes to `./data/inbox/msg_{ulid}.blob`. Return `202 Accepted`.
6. **NO (spool full):** Return `429 Too Many Requests`. Sender retries later.
7. On vault unlock: Sweeper wakes up, processes all blobs.

**TTL (Time-To-Live) prevents zombie notifications:**

Since the outer envelope is encrypted, the ingress handler cannot see the TTL — it must accept everything. The Sweeper applies TTL logic after decryption:

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
| Normal operation | "Sancho leaving home" | Unlocked | **Fast path:** decrypted in-memory, nudge delivered instantly |
| Locked, unlocked within TTL | "Sancho leaving home" (TTL: 30 min) | Locked → Unlocked 10 min later | **Dead drop → sweeper:** processed, nudge delivered (still relevant) |
| Locked, unlocked after TTL | "Pizza arriving in 5 min" (TTL: 15 min) | Locked → Unlocked 3 hours later | **Dead drop → sweeper:** stored silently in history, no notification (expired news) |
| Convenience mode reboot | Any message | Auto-unlocked on boot | **Fast path:** processed immediately (no dead drop needed) |
| DoS attack (locked) | Millions of garbage payloads | Locked | **Valve 1** rejects most (IP rate limit). Remainder fills spool to 500MB cap. **Valve 2** rejects rest (429). Disk safe. |
| DoS attack (unlocked) | Millions of garbage payloads | Unlocked | **Valve 1** rejects most (IP rate limit). Survivors decrypted — unknown DID → dropped. No disk I/O. |

**Spool management:**

```go
const (
    DefaultMaxSpoolBytes = 500 * 1024 * 1024  // 500MB, configurable via DINA_SPOOL_MAX
    MaxPayloadBytes      = 256 * 1024           // 256KB per message (DIDComm is JSON metadata, no media/attachments)
    IPRateLimit          = 50                    // requests per hour per IP
    GlobalRateLimit      = 1000                  // requests per hour total
)

func inboxHandler(w http.ResponseWriter, r *http.Request) {
    // Valve 1: IP rate limit (checked before reading body)
    if !ipLimiter.Allow(r.RemoteAddr) {
        http.Error(w, "Rate limited", http.StatusTooManyRequests)
        return
    }

    // Valve 1: Payload size cap (checked before reading body)
    // Valve 1: Payload size cap — DIDComm is JSON metadata, no media.
    // 256KB is generous. Slowloris-style attacks with oversized payloads cut off immediately.
    r.Body = http.MaxBytesReader(w, r.Body, MaxPayloadBytes)
    blob, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, "Payload too large", http.StatusRequestEntityTooLarge) // 413
        return
    }

    // Fast path: vault unlocked → decrypt + process in-memory
    if vault.IsUnlocked() {
        msg, err := vault.DecryptNaCl(blob)
        if err != nil {
            http.Error(w, "Invalid", 400)
            return
        }
        if !didLimiter.Allow(msg.From) {  // Per-DID rate limit (unlocked only)
            http.Error(w, "Rate limited", 429)
            return
        }
        go processMessage(msg)
        w.WriteHeader(http.StatusOK)
        return
    }

    // Dead drop: vault locked → write to spool (Valve 2)
    spoolSize := getSpoolSize()
    if spoolSize+int64(len(blob)) > MaxSpoolBytes {
        http.Error(w, "Spool full", http.StatusTooManyRequests)
        return
    }
    writeToSpool(blob)  // ./data/inbox/msg_{ulid}.blob
    w.WriteHeader(http.StatusAccepted)
}
```

**Security:** The inbox spool (`./data/inbox/`) contains only encrypted blobs. An attacker with filesystem access sees the same thing they'd see in the vault — encrypted data they can't read. The blobs are cleaned up (deleted from spool) after successful processing. The spool cap (500MB) guarantees that even a sustained DoS attack against a locked vault cannot crash the Home Node by filling the disk.

### Portability & Migration (The `.dina` Archive)

A Dina node's state is a small directory tree: the encrypted vault, optional keyfile, inbox spool, and configuration. `dina export` compiles this into a single portable archive.

**The fix: `dina export` compiles the state into a single encrypted archive. `dina import` restores it.**

```
Export (old machine):
  docker exec dina-core dina export --output /backup/my-dina.dina

Import (new machine):
  # Run install.sh first (generates new BRAIN_TOKEN, sets up directories)
  docker exec -i dina-core dina import --input /backup/my-dina.dina
  # Prompts for passphrase → unlocks master key → restores vault
```

**What's in the `.dina` archive:**

```
my-dina.dina (encrypted tar.gz, encrypted with passphrase-derived key)
├── identity.sqlite            ← Tier 0: contacts, sharing policy, audit log
├── vault/
│   ├── personal.sqlite        ← Phase 1: all content here
│   ├── health.sqlite          ← Phase 2: per-persona files (if enabled)
│   ├── financial.sqlite
│   └── ...
├── keyfile                    ← Convenience mode only (raw master seed, chmod 600)
├── config.json                ← Mode, gatekeeper tiers, preferences
└── manifest.json              ← Version, export timestamp, file checksums
```

**What's NOT in the archive:**

| Excluded | Why |
|----------|-----|
| `BRAIN_TOKEN` | Regenerated by `install.sh` on new machine. Per-machine secret. |
| `CLIENT_TOKEN` | Admin web UI login password (32-byte random, hex). SHA-256 hash stored in `device_tokens` table (identity.sqlite) — but the table is excluded from export. All client devices (CLI, phone, etc.) use Ed25519 keypairs. Re-pair on new machine via 6-digit code flow. |
| `DINA_PASSPHRASE` | The user knows it. Archive is encrypted *with* it, not *containing* it. |
| PDS data | Replicated via AT Protocol. New PDS re-syncs from relay. |
| Docker secrets directory | Regenerated by `install.sh`. |
| OpenClaw state | OpenClaw manages its own credentials (Gmail OAuth, etc.). Re-configure on new machine. |

**The export process:**

```
1. Pause database writes (PRAGMA wal_checkpoint(TRUNCATE) on all open databases)
2. Create tar.gz of identity.sqlite, vault/*.sqlite, config.json
3. Encrypt the tar.gz with Argon2id(passphrase) → AES-256-GCM
4. Write manifest.json (version, checksums, timestamp) into archive
5. Resume database writes
6. Stream encrypted archive to stdout or --output path
```

**The import process:**

```
1. Prompt for passphrase
2. Decrypt archive (Argon2id → AES-256-GCM)
3. Verify manifest.json checksums (detect corruption)
4. Verify version compatibility (reject archives from incompatible versions)
5. Restore identity.sqlite, vault/*.sqlite, config.json to /var/lib/dina/
6. Open each database with its derived DEK to verify integrity (PRAGMA integrity_check)
7. Notify: "Import complete. Re-pair your devices (6-digit code) and re-configure OpenClaw."
```

**Migration between hosting levels** (managed → self-hosted, Pi → Mac Mini, etc.) is just export + import. Same archive, same command, any hardware. The promise of "zero lock-in" is enforced by the CLI, not by hoping users manually copy the right files.

### Why Not Serverless?

Serverless (Lambda + S3) doesn't work for Dina. SQLite on network storage corrupts under concurrent access. Cold starts take 30-60 seconds to load a 2GB LLM. Lambda can't maintain persistent WebSocket or DIDComm connections. Scheduled MCP sync cycles and always-on DIDComm reception cost more on Lambda than an always-on container.

The right architecture is lightweight, always-on containers via `docker compose up -d` — 3 containers by default (core, brain, pds). Add a local LLM with `docker compose --profile local-llm up -d` (4 containers: + llama).

### Connectivity & Ingress (Multi-Lane Networking)

dina-core exposes two ports:
- **Port 443** — external HTTPS: client WebSockets, NaCl messaging (Dina-to-Dina), admin UI proxy (`/admin` → brain:8200/admin). Behind a tunnel (Tailscale/Cloudflare/Yggdrasil) for NAT traversal and DDoS protection.
- **Port 8100** — internal API (brain ↔ core, Docker network only)

The public ingress is a tunnel or reverse proxy in front of port 443. This solves NAT traversal, port conflicts, TLS termination, and DDoS protection in one architectural decision. The PDS exposes port 2583 separately for AT Protocol relay crawling.

**Three ingress tiers, running simultaneously if needed:**

| Tier | Name | Mechanism | Who It's For | Public Endpoint |
|------|------|-----------|-------------|-----------------|
| **1: Community** | Zero-config | Tailscale Funnel (or Zrok) | Testing, non-technical users, onboarding | `https://node.tailnet.ts.net` (auto-TLS) |
| **2: Production** | Tunneled | Cloudflare Tunnel (`cloudflared`) | Daily drivers, anyone who wants DDoS protection | `https://dina.alice.com` (custom domain, WAF, geo-blocking) |
| **3: Sovereign** | Mesh | Yggdrasil | Censorship resistance, no central authority | Stable IPv6 derived from node's public key |

**Why not Tor for Tier 3?** Dina has a DID — she's not trying to be anonymous, she's trying to be sovereign. DIDComm already provides E2E encryption, making Tor's encryption layer redundant. Tor's 3-second round trip kills nudges and real-time interactions. Yggdrasil provides censorship resistance with low latency and NAT traversal, and its key-derived IPv6 addresses are philosophically aligned with DIDs. Users who need anonymity (hiding that they run a Dina) can route Yggdrasil over Tor — that's an ops choice, not an architecture tier.

**How it connects to DIDComm:** The DID Document (resolved via `did:plc` or `did:web`) points to whatever public endpoint the tunnel exposes. DIDComm doesn't care whether that's a Tailscale URL, a Cloudflare domain, or a Yggdrasil IPv6. When the user changes ingress tier, they sign a `did:plc` rotation operation to update their service endpoint.

**Future: Wildcard Relay.** The Dina Foundation will operate a relay (`*.dina.host` via `frp`) to provide free, secure subdomains to Community tier users — replacing the Tailscale Funnel dependency. Not a Phase 1 dependency.

See [`ADVANCED-SETUP.md`](ADVANCED-SETUP.md) for setup instructions per tier (networking) and Local LLM profile, or [`QUICKSTART.md`](QUICKSTART.md) to get running in 3 commands.

### One User, Many Vaults (Tenancy Model)

Phase 1 is single-user, single-machine. Contacts and identity live in `identity.sqlite`. Content lives in per-persona SQLite files — each encrypted with its own DEK.

**Canonical directory layout:**

```
On disk (what the developer sees):
  dina/
  └── data/
      ├── identity.sqlite              ← Tier 0: contacts, sharing policy, audit log, kv_store
      ├── vault/
      │   ├── personal.sqlite          ← Phase 1: everything here (single persona)
      │   ├── health.sqlite            ← Phase 2: per-persona files
      │   ├── financial.sqlite
      │   ├── social.sqlite
      │   └── consumer.sqlite
      ├── keyfile                      ← Convenience mode only (master seed, chmod 600)
      ├── inbox/                       ← Dead Drop spool (locked state, encrypted blobs)
      ├── pds/                         ← AT Protocol repo data
      ├── models/                      ← GGUF files (optional, --profile local-llm)
      └── config.json                  ← Gatekeeper tiers, settings

Inside container (what the code sees):
  /var/lib/dina/
  ├── identity.sqlite
  ├── vault/
  │   ├── personal.sqlite
  │   ├── health.sqlite              (Phase 2)
  │   └── ...
  ├── keyfile
  ├── inbox/
  ├── pds/
  ├── models/
  └── config.json
```

**Path rules:**
1. Code always uses absolute paths: `/var/lib/dina/vault/personal.sqlite`
2. Docker-compose uses relative paths: `./data/vault`
3. Always singular: `vault`, not `vaults`
4. Multi-tenant (managed hosting): future problem, different compose file. `/var/lib/dina/users/<did>/vault/` — only in managed hosting docs, not Phase 1.

**Why this matters:**
- **True cryptographic isolation.** Each persona is encrypted with a different DEK derived from a unique HKDF path. Your health data is encrypted with a different key than your financial data, even on the same machine. Locked persona = DEK not in RAM = file is opaque bytes.
- **Portability.** User leaves → `dina export` bundles identity + persona files + config into a single encrypted `.dina` archive. `dina import` on the new machine restores everything.
- **Right to delete.** `rm data/vault/health.sqlite`. Persona physically annihilated — no SQL needed, no VACUUM, no residual data. The entire file is gone.
- **Selective unlock.** `identity.sqlite` always unlocked first (gatekeeper needs contacts/sharing policy). `/personal` unlocked by default. Other personas remain locked until explicitly requested. Locked = DEK not in RAM = invisible, not just access-controlled.
- **Phase 1 simplicity.** Single `personal.sqlite` — same developer experience as one file. Per-persona files appear only when multi-persona is enabled in Phase 2.

