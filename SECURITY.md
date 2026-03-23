# Security

Dina is a sovereign personal AI. The security model enforces one principle: **the human holds the keys, and the system cannot operate without them.** This document covers every layer — from key management to container isolation to supply chain integrity.

For the narrative walkthrough (how it all fits together), see [`docs/security-walkthrough.md`](docs/security-walkthrough.md).

---

## Key Management

### Master Seed

A 256-bit (32-byte) cryptographically random seed is the root of all identity and encryption. Generated via `openssl rand` during `install.sh`.

The seed is converted to a **24-word BIP-39 mnemonic** for human backup. Anyone with these 24 words can reconstruct the full identity and decrypt all data.

### Seed Wrapping (At Rest)

The master seed is never stored in plaintext. It is wrapped with a user-chosen passphrase:

1. User chooses passphrase (minimum 8 characters)
2. Generate 16-byte random salt
3. `Argon2id(passphrase, salt)` → 32-byte KEK (Key Encryption Key)
   - Memory: 128 MB, time: 3, parallelism: 4
4. `AES-256-GCM(KEK, seed)` → wrapped seed (60 bytes: nonce‖ciphertext‖tag)
5. Only `wrapped_seed.bin` and `master_seed.salt` are stored on disk

### Two Startup Modes

| Mode | Behavior | Trade-off |
|------|----------|-----------|
| **Manual-start** | Passphrase required on every start. Cleared from disk after Core reads it. | Most secure. No unattended restart. |
| **Auto-start** | Passphrase stored in `secrets/seed_password`. Core reads it automatically. | Convenient. Unattended restart works. |

Users can switch anytime: `dina-admin security auto-start` or `manual-start`.

### Key Derivation (SLIP-0010)

All operational keys are derived from the master seed. The seed itself is never used directly for signing or encryption.

```
Master Seed (32 bytes)
 └─ SLIP-0010 hardened derivation (purpose m/9999')
     ├─ m/9999'/0'/0'       → Root Ed25519 signing key (→ did:plc identity)
     ├─ m/9999'/1'/N'/0'    → Per-persona signing keys
     ├─ m/9999'/2'/0'       → secp256k1 PLC rotation key
     ├─ m/9999'/3'/0'       → Core service auth key
     └─ m/9999'/3'/1'       → Brain service auth key
 └─ HKDF-SHA256 per-persona DEKs
     ├─ HKDF("personal")   → Personal vault DEK
     ├─ HKDF("health")     → Health vault DEK
     └─ ...
```

Key rotation is possible without changing identity — only the derived keys rotate. Historical signatures remain verifiable via AT Protocol's temporal key registry.

---

## Authentication

Three authentication methods, each for a different trust boundary.

### 1. Ed25519 Service Keys (Core ↔ Services)

Internal service-to-service authentication with per-service least privilege. Each service has its own SLIP-0010-derived keypair. Private keys are isolated by separate Docker bind mounts — Core's private key never exists in Brain's container.

Every request is signed using a canonical format:

```
{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}
```

Transmitted via headers: `X-DID`, `X-Timestamp`, `X-Nonce`, `X-Signature`.

The nonce is a 16-byte random hex string generated per-request. It guarantees unique signatures even for identical payloads within the same second — no same-payload retry collisions.

**Replay protection:** 5-minute timestamp window + double-buffer nonce cache. Current generation collects all new nonces; previous generation is checked for duplicates. Rotation every 5 minutes or when current exceeds 100,000 entries.

**Per-service authorization:** Core identifies which service signed the request (via the registered `serviceID`) and enforces a distinct allowlist for each:

| Service | Allowed | Denied |
|---------|---------|--------|
| **brain** | Vault read/write, messaging, PII scrub, sessions, notifications, audit, health | DID signing/rotation, backup/export, persona unlock, pairing, admin UI |
| **admin** | Persona management, devices, export/import, pairing, audit, admin UI, health | Vault read/write, messaging, PII scrub, DID signing, notifications |
| **connector** | Vault store (ingestion only), task ACK, health | Everything else |

Unknown service IDs are denied on all paths (fail-closed). This ensures a compromised connector cannot read vault data, and a compromised admin backend cannot access vault contents.

### 2. CLIENT_TOKEN (Admin Web UI) — Phase 1

32-byte random token generated during device pairing (`crypto/rand.Read`). Used as a login password for the browser admin UI. Browser POSTs it to `/admin/login`, gets a session cookie back.

**Current runtime flow:**

```
Browser → passphrase → Brain /admin/login → session cookie
Browser → session cookie → Brain /admin/* → CLIENT_TOKEN bearer → Core /v1/*
```

Core bypasses its own auth middleware for `/admin/*` paths and reverse-proxies them to Brain. Brain's admin app authenticates the browser user (passphrase → session), then calls Core using CLIENT_TOKEN bearer auth (admin scope). This means:

- Browser authentication happens in Brain, not Core
- Brain has admin-scoped access to Core via CLIENT_TOKEN
- The Core↔Brain link is trusted (same Docker network / same host)

This is acceptable for the Phase 1 single-user home node deployment where Brain is a co-located sidecar. It is NOT acceptable for multi-tenant, remote-Brain, or untrusted-network deployments.

**Planned (Phase 2):** Replace CLIENT_TOKEN with the same Ed25519 model used everywhere else. The admin UI backend authenticates to Core with Ed25519; the browser authenticates to the admin backend with a session cookie. This eliminates CLIENT_TOKEN entirely:

```
Browser   → session cookie → Admin backend → Ed25519 → Core
CLI       →                                  Ed25519 → Core
Telegram  → Telegram API   → Telegram bot  → Ed25519 → Core
Brain     →                                  Ed25519 → Core
```

One auth model everywhere. The browser is the only component that can't do Ed25519 natively, so the admin backend bridges that gap — same pattern as Telegram.

**Session security:**
- Session ID: 32-byte random hex
- CSRF token: 32-byte random hex, constant-time comparison
- Cookie: `HttpOnly; SameSite=Strict; Max-Age=86400`
- Session TTL: 24 hours (configurable)

### 3. Ed25519 Device Keys (CLI / Paired Devices)

Each device generates its own Ed25519 keypair locally. The private key never leaves the device. During pairing, the public key is registered with Core. Every CLI command is signed with the device's private key — same canonical format as service keys.

### Device Pairing

1. User runs `dina-admin device pair` → Core generates a 6-digit code (5-minute TTL)
2. User enters code on the new device
3. Device sends its Ed25519 public key (multicodec-prefixed `0xed01` + 32 bytes)
4. Core registers the public key under a `did:key` identifier and returns the device ID

No CLIENT_TOKEN is generated for Ed25519 devices — all auth is signature-based.

Rate limiting on pairing attempts prevents brute force (hard cap on pending codes).

### WebSocket Authentication

WebSocket connections (`/ws`) are Ed25519-only. The HTTP upgrade request must be signed with a paired device key — same canonical signature format as regular API calls (`X-DID`, `X-Timestamp`, `X-Signature`).

The auth middleware verifies the signature on the upgrade request and sets the device identity in context. After the upgrade succeeds, `authHandshake` reads the pre-authenticated identity and admits the connection immediately — no protocol-level token exchange. Unsigned upgrades are rejected with `ErrAuthFailed`.

The connection is then registered in the WebSocket hub with the device identity for push message delivery (approval notifications, vault updates, nudges).

### dina-admin (Local Operator)

`dina-admin` connects to Core via Unix domain socket inside the container. Socket access = admin auth — if you can exec into the container, you have host-level access. No token or key needed.

**Current model (Phase 1):** Unix socket for all admin commands. Acceptable for single-user Home Node where Docker access = machine access.

**Planned (Phase 2):** Dual-auth model:
- **Ed25519** for normal operations (status, persona, device, identity) — auditable, consistent with CLI
- **Unix socket restricted** to bootstrap + emergency only (init, key rotation, export, security mode changes) — the escape hatch when the auth system itself needs fixing

---

## Persona Isolation

Each persona is a separate encrypted SQLite database file with its own DEK (derived from master seed via HKDF). Cross-persona access is enforced cryptographically — a compromised persona cannot access another.

### Current Security Risk

Check Known Gaps Section please

### 4-Tier Access Model

| Tier | Boot State | Users | Brain | Agents | Audit |
|------|-----------|-------|-------|--------|-------|
| **Default** | Auto-open | Free access | Free access | Free access | Silent |
| **Standard** | Auto-open | Free access | Free access | Needs session grant | On agent access |
| **Sensitive** | Closed | Unlock with confirmation | Needs approval | Needs approval via Telegram/admin | Always |
| **Locked** | Closed | Passphrase required | Denied (403) | Denied (403) | Always |

The default persona is "general" — always open. Standard personas (consumer, social, work) auto-open at boot but require agents to work within named sessions. Sensitive personas (health, finance) require explicit user approval before agents can access them. Locked personas require a persona-specific passphrase.

### Agent Sessions

Agents work within named sessions that scope access grants:

```
dina session start --name "chair-research"
dina recall "back pain" --session chair-research --persona health
  → Awaiting user approval on Telegram...
  → Health access granted for session "chair-research"
dina session end --name "chair-research"
  → All grants revoked
```

Sessions persist across crashes (agent can reconnect by name). Each session's grants are revoked when the session ends. Different agents can have different active sessions.

### Gatekeeper

The Gatekeeper enforces persona isolation at the API level:
- Caller type (user/brain/agent) determines access — derived from authentication
- Agents need active session grants for standard/sensitive personas
- Brain-denied actions: `did_sign`, `did_rotate`, `vault_backup`, `persona_unlock`, raw vault operations, `vault_export`
- Cross-persona queries are blocked regardless of authentication
- Approval requests are queued and the user is notified via Telegram and WebSocket

---

## Agent Safety

Any agent acting on the user's behalf submits its intent to Dina before acting.

### Intent Validation

1. Agent sends intent (action, target persona, parameters)
2. Core overrides caller-supplied DID with the authenticated identity (never trust the caller)
3. Gatekeeper evaluates: is this action safe? Does it match the user's rules? Is PII leaking?

### Action Classification

| Risk | Actions | Behavior |
|------|---------|----------|
| **Safe** | Web search, read vault | Pass through silently |
| **Moderate** | Send email, share data | Flag for human approval |
| **High** | Transfer money, modify identity | Require highest trust ring (verified + actioned) |

### Brain Restrictions

Brain is treated as an untrusted tenant. It can reason and search, but cannot:
- Sign with the node's identity key
- Rotate keys
- Export or backup vaults
- Unlock locked personas
- Access raw vault data (only through Core's API)

---

## PII Protection

Raw user data never leaves the Home Node. Three tiers of scrubbing:

| Tier | Method | Where |
|------|--------|-------|
| 1 | Regex patterns (email, phone, SSN, credit card, IP) | Go Core |
| 2 | spaCy NER (named entity recognition) | Python Brain |
| 3 | LLM NER (optional, for edge cases) | Python Brain |

**Logging rule:** PII must never reach stdout. Logs contain metadata only — persona, type, count, latency. Never vault content, never user queries.

**Egress scanning:** Before any data leaves the Home Node (D2D messages, agent responses), the Gatekeeper scans for PII patterns and blocks if detected.

---

## Audit Logging

Append-only audit trail in `identity.sqlite` (Tier 0, always accessible).

Every significant action is logged:
- Timestamp, action type, requester (agent DID), persona, decision, reason
- Structured reasoning traces from Brain (prompt preview, tools called, vault context used)
- Hash-chained entries (SHA-256) for tamper detection

Query via `GET /v1/audit/query` or `dina-admin` CLI. On test failure, the system test hook automatically dumps recent audit traces for debugging.

---

## Container & Network Isolation

### Docker Network Topology

```
┌─────────────────────────────────────┐
│ dina-pds-net                        │
│   Core ←→ PDS ←→ PLC Directory     │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│ dina-brain-net                      │
│   Core ←→ Brain                     │
└─────────────────────────────────────┘
```

- **Core** (port 8100): only service exposed to the host
- **Brain** (port 8200): internal only, not exposed to host
- **PDS**: separate network, accessible only to Core
- Two isolated Docker networks prevent Brain from reaching PDS directly

### Service Key Isolation

```
Host: secrets/service_keys/
  ├── core/    → bind-mounted ONLY to Core container
  ├── brain/   → bind-mounted ONLY to Brain container
  └── public/  → bind-mounted to both (read-only)
```

Core's private key never exists in Brain's filesystem. Brain's private key never exists in Core's filesystem.

### Entrypoint Secret Handling

Docker Compose mounts secrets as `root:root 0400`. The Core entrypoint (running as root) copies secrets to a container-local `/tmp/secrets/` directory owned by the `dina` user (UID 10001), then drops privileges via `gosu`. The host bind mount is never mutated.

Required key files are verified after copy — if any are missing, Core exits immediately with a clear error.

---

## Rate Limiting & DoS Protection

- **Token-bucket rate limiting:** default 60 requests per 60-second window per IP
- **X-Forwarded-For parsing:** rightmost-trusted header (prevents spoofing)
- **Bucket management:** periodic purge every 5 minutes, hard cap at 10,000 buckets, LRU eviction
- **Request body size limits:** 64 KB for agent validation, 1 MB for signed requests
- **Pairing code rate limiting:** hard cap on pending codes prevents brute force

---

## Dead Drop (Locked-State Messaging)

When a persona vault is locked, incoming DIDComm messages are stored as encrypted blobs in an `inbox/` spool directory. A sweeper job processes them when the persona is unlocked. Messages older than the configured TTL are discarded without notification.

This ensures messages are never lost during locked state, but the user is not bothered about stale messages.

---

## Dina-to-Dina (D2D) Messaging

The network is treated as zero-trust:

1. Sender signs the plaintext message with its Ed25519 key
2. Message is wrapped in a NaCl `crypto_box_seal` (anonymous sealed box) using the recipient's public key
3. Recipient decrypts, verifies the DID signature, checks for replay
4. If any check fails, the message is rejected

No intermediary (relay, server, platform) can read the message content.

---

## Trust Network

Dina uses the AT Protocol to build a decentralized trust network:

- **Trust rings:** Unverified → Verified (ZKP) → Verified + Actioned (transactions, time, peer attestation)
- **Trust score:** composite function of identity anchors, transaction history, outcome data, peer attestations, and time
- **AppView:** processes attestations, vouches, and outcome reports from the AT Protocol firehose
- **Fallback:** when AppView is unreachable, trust queries return gracefully degraded results (not failures)

Trust is ranked by verified outcomes, not by ad spend.

---

## Supply Chain Security

### Digest Pinning

Every image reference in production uses a full SHA-256 digest. No `:latest` tags. External changes cannot break a running installation. Users upgrade when they choose.

```yaml
# Pinned — immutable
services:
  core:
    image: ghcr.io/dina/core@sha256:a1b2c3d4e5f6...
```

### Image Signing (Cosign)

All container images are signed during CI using [Cosign](https://docs.sigstore.dev/cosign/overview/) (Sigstore). Keyless signing via GitHub Actions OIDC — the signature proves the image was built by a specific workflow in a specific repository.

Verification before upgrade:
```bash
cosign verify ghcr.io/dina/core@sha256:a1b2c3... \
  --certificate-identity=https://github.com/rajmohanutopai/dina/.github/workflows/release.yml@refs/tags/v1.0.0 \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com
```

### SBOM (Software Bill of Materials)

Every release ships an SPDX SBOM generated by [syft](https://github.com/anchore/syft), attached to the container image via Cosign. Users can scan for known vulnerabilities:

```bash
grype ghcr.io/dina/core@sha256:a1b2c3...
```

### No Auto-Updates

Dina never pulls new images without the user's knowledge. The user initiates upgrades. Verification happens before anything changes. This is sovereignty.

| Measure | What it prevents | Phase |
|---------|-----------------|-------|
| Digest pinning | Accidental breakage from upstream changes | Day one |
| Cosign signing | Malicious image tampering | Phase 1a |
| SBOM (syft) | Hidden vulnerabilities in dependencies | Phase 1a |

---

## Vector Storage Security

Dina encrypts every page of every persona vault with SQLCipher (AES-256-CBC). Traditional vector databases (sqlite-vec, FAISS, Qdrant, ChromaDB) break this by storing vectors in unencrypted memory-mapped files.

**Dina's approach:** 768-dimensional float32 embeddings are stored as BLOB columns inside SQLCipher, in the same row as the text they represent. No separate index file. No mmap.

**Lifecycle:**
1. **At rest:** encrypted BLOBs inside SQLCipher
2. **On persona unlock:** read embeddings, build HNSW index in RAM (~40-80ms for 10K items)
3. **On query:** search RAM index (<1ms)
4. **On persona lock:** destroy HNSW index, nil reference, GC
5. **Persona Leak** External systems should not know about different persona names.

Vectors exist in plaintext only in process memory during an active session — same exposure as decrypted text.

---

## LLM Prompt Injection Defense

You cannot prevent prompt injection, so you contain the blast radius. Key mechanisms:

- **Split Brain:** process-level isolation between reading and acting
- **Per-stage tool isolation:** each reasoning step has a limited tool set
- **Deterministic Egress Gatekeeper:** spaCy NER, not an LLM, makes the final send/block decision
- **Vault query limits:** enforced server-side in Core, not by the LLM

Full architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md), section on prompt injection defense.

---

## Known Gaps (Phase 1)

Documented limitations of the current implementation, with the deployment context that makes them acceptable and the planned resolution.

### Current Security Risk

In the current release, the persona vault is secure if DEK is not there in RAM - so copying the file will not give you access.
But In the current release, some open issues are there. 
For example - open persona window risk: When a sensitive persona is unlocked for an active session, authorization is code-enforced, not cryptographic. A compromised Brain process could potentially access open persona data by reusing valid grant credentials.
   
   Some possible mitigation paths (planned): 
   - Per-request grant tokens (not reusable session grants)
   - Request-scoped DEK derivation ?
   - Brain process attestation
   - Encrypted Session ID 
   - Separate process boundary for sensitive vault access
      A small vault service holds the DEK and enforces per-request/session policy.
   - KMS/HSM/TEE-backed key release
      The main app never gets long-lived raw DEKs freely in memory.
   - Per-session capability-wrapped access
      The unlock operation returns a scoped capability, not a global open bit.

This needs to be thought through and implemented in a future release 

### Admin Auth Trust Boundary

**Gap:** The documented model is `browser → admin backend → Ed25519 → Core`. The runtime is `browser → Brain (CLIENT_TOKEN bearer) → Core`, with Core bypassing auth on `/admin/*` paths.

**Why it's acceptable now:** Brain is a co-located sidecar on the same Docker network. The Core↔Brain link is localhost-only. CLIENT_TOKEN is generated at install time and never exposed externally. For a single-user home node, Docker access = machine access = admin access.

**When it matters:** Multi-tenant operator mode, Brain on a remote host, or any deployment where the Core↔Brain network is untrusted.

**Resolution:** Phase 2 — migrate admin backend to Ed25519 service auth (same as vault/reason paths). Remove CLIENT_TOKEN entirely. See Authentication §2 above.

### Trust Rings & Agent Data Access (Phase 3)

**Design:** Contacts carry a `trust_ring` (0-3) that controls how action agents receive contact data:

| Ring | Access Model | Example |
|------|-------------|---------|
| 0 (Unverified) | Blocked — agents get nothing | Unknown senders |
| 1 (Inner Circle) | Late binding — agents get `{{dina.vault...}}` placeholders, Dina hydrates at execution time. Agent never sees raw PII. | Family, close friends |
| 2 (Verified) | Plaintext for low-risk intents, late binding for risky ones | Verified contacts |
| 3 (Transactional) | Plaintext — business/public info | Plumber, restaurants |

**Why this matters:** When an action agent (OpenClaw, Perplexity Computer) needs to "send an email to your daughter," it must never see her actual email address. The agent drafts with `TO: {{dina.vault.social.daughter.email}}` and Dina hydrates locally at send time. This is Zero-Knowledge Execution — the cloud agent executes the task without ever holding the PII.

**Status:** Domain types defined (`TrustRing`, `EntityResolutionRequest/Response` in `domain/contact.go`). Gateway handler and late-binding hydration engine are Phase 3. See [`docs/ROADMAP.md`](docs/ROADMAP.md) for implementation plan.

