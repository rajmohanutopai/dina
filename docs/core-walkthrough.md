# The Dina Core: A Walk Through the Fortress

## Review Status

| # | Section | Status |
|---|---------|--------|
| I | [Waking Up — The Composition Root](#act-i-waking-up--the-composition-root) | COMPLETE |
| | — Before Core Starts: The Install Flow | COMPLETE |
| | — Three Secrets, Three Different Jobs | COMPLETE |
| | — Key Derivation: One Seed, Many Keys | COMPLETE |
| | — Bootstrapping Identity from Seed | COMPLETE |
| | — Assembly Line: Bottom-Up Construction | COMPLETE |
| | — Services: The Business Logic Layer | COMPLETE |
| II | [The Ingress Pipeline — Three Valves](#act-ii-the-ingress-pipeline--three-valves) | COMPLETE |
| | — The Router | COMPLETE |
| | — The Dead Drop: Peek/Ack Semantics | COMPLETE |
| | — The Sweeper | COMPLETE |
| | — The Outbox: Retry on the Other Side | COMPLETE |
| | [Where HTTP Lives in Core](#where-http-lives-in-core) | COMPLETE |
| III | [The Request Journey — From HTTP to Vault](#act-iii-the-request-journey--from-http-to-vault) | COMPLETE |
| | — The Middleware Chain | COMPLETE |
| | — Example: Storing a Verdict in the Vault | COMPLETE |
| | — Example: Querying with Gatekeeper | COMPLETE |
| IV | [Persona Lifecycle — Lock, Unlock, and the Ticking Clock](#act-iv-persona-lifecycle--lock-unlock-and-the-ticking-clock) | COMPLETE |
| | — Creating a Persona | COMPLETE |
| | — Unlocking: The Moment of Truth | COMPLETE |
| | — v1 Auto-Open | COMPLETE |
| | — The Lock Timer | COMPLETE |
| | — Approval Flow | COMPLETE |
| V | [Dina-to-Dina — Sending Messages Across the Wire](#act-v-dina-to-dina--sending-messages-across-the-wire) | COMPLETE |
| VI | [The Egress Guardian — Nothing Leaves Without Permission](#act-vi-the-egress-guardian--nothing-leaves-without-permission) | COMPLETE |
| VII | [Device Pairing — Adding a Second Screen](#act-vii-device-pairing--adding-a-second-screen) | COMPLETE |
| VIII | [The Connector Pipeline — From Ingestion to Vault](#act-viii-the-connector-pipeline--from-ingestion-to-vault) | COMPLETE |
| | — The Remember Endpoint | COMPLETE |
| IX | [Silence First — Notifications, Reminders, and the Daily Briefing](#act-ix-silence-first--notifications-reminders-and-the-daily-briefing) | COMPLETE |
| | — The Three-Tier Priority System | COMPLETE |
| | — Reminders: Deterministic Triggers, LLM-Free | COMPLETE |
| X | [The Trust Network — Verified Truth at the Ingress Gate](#act-x-the-trust-network--verified-truth-at-the-ingress-gate) | COMPLETE |
| | — The Trust Cache | COMPLETE |
| | — The Trust Resolver | COMPLETE |
| | — The Ingress Decision | COMPLETE |
| XI | [Portability and the Admin Socket](#act-xi-portability-and-the-admin-socket) | COMPLETE |
| | — Export/Import: Moving to a New Machine | COMPLETE |
| | — The Admin Unix Socket | COMPLETE |
| | — The Audit Trail | COMPLETE |
| | — Agent Sessions and the Reason Proxy | COMPLETE |
| XII | [WebSocket — Real-Time Connection](#act-xii-websocket--real-time-connection) | COMPLETE |
| XIII | [The Health Probes](#act-xiii-the-health-probes) | COMPLETE |
| XIV | [The Fourteen Stories — Proving the Architecture](#act-xiv-the-fourteen-stories--proving-the-architecture) | COMPLETE |
| | — Story 01: The Purchase Journey | COMPLETE |
| | — Story 02: The Sancho Moment | COMPLETE |
| | — Story 03: The Dead Internet Filter | COMPLETE |
| | — Story 04: The Persona Wall | COMPLETE |
| | — Story 05: The Agent Gateway | COMPLETE |
| | — Story 06: The License Renewal | COMPLETE |
| | — Story 07: The Daily Briefing | COMPLETE |
| | — Story 08: Move to New Machine | COMPLETE |
| | — Story 09: Connector Expiry | COMPLETE |
| | — Story 10: The Operator Journey | COMPLETE |
| | — Thesis Invariants (11-14) | COMPLETE |
| | [Epilogue](#epilogue-the-architecture-in-one-sentence) | COMPLETE |



## Act I: Waking Up — The Composition Root

Core orchestrates every actor in the system.

<details>
<summary><strong>Design Decision — Why Go for the Core?</strong></summary>
<br>

Dina's core is a long-running, always-on process that manages cryptographic keys, encrypted storage, and real-time WebSocket connections. Written in Go (due to its support of Crypto). The other two components are the brain and appview. The brain sidecar handles LLM reasoning (Python is the defacto language in AI). AppView (Trust Network, built on AT Proto) is written in TypeScript.

</details>

<details>
<summary><strong>Design Decision — Why a single-file composition root?</strong></summary>
<br>

All dependency wiring lives in `main.go` — no dependency injection framework, no service locator, no reflection magic. Every adapter, service, and handler is constructed with explicit constructor calls and passed as arguments. This means: (1) the compiler catches missing dependencies at build time, not at runtime, (2) you can read `main.go` top-to-bottom to understand every dependency relationship in the system, and (3) there are no hidden "auto-wired" surprises. The tradeoff is a ~1200-line `main.go`, but that's a feature — it's the one place where the entire system is visible.

</details>

When `dina-core` starts, the first thing it does is load configuration from environment variables (`core/cmd/dina-core/main.go:57-69`, `config.NewLoader()`). If anything is misconfigured — missing vault path, invalid listen address — the process refuses to start. There's no "run in degraded mode." The philosophy is: if the foundation is cracked, don't build the house.

Next comes the **security gauntlet** (lines 71-80). `DINA_TEST_MODE` is a dangerous escape hatch meant only for development and testing. The startup code checks `DINA_ENV` and calls `log.Fatal` if someone tries to enable it in production. The process simply dies rather than run insecure.

<details>
<summary><strong>Design Decision — Why fail-fast instead of degraded mode?</strong></summary>
<br>

Many systems try to "keep running" with partial configuration — disable features, skip checks, log warnings. Dina takes the opposite stance: if the config is invalid, the process exits immediately. The reasoning is that Dina guards your cryptographic identity and private data. Running with a misconfigured gatekeeper, missing vault path, or test-mode flags in production is worse than not running at all. A crash is loud and obvious; a silently misconfigured security layer is invisible and dangerous. The load balancer will route traffic to healthy nodes; a half-configured node shouldn't be one of them.

</details>

### Before Core Starts: The Install Flow

Before Core ever runs, `install.sh` handles seed generation and mnemonic display. Only the seed generation itself (`openssl rand -hex 32`) runs on the host — all crypto operations (wrapping, mnemonic derivation, service key provisioning) run inside a purpose-built `dina-crypto-tools` Docker container via the `run_crypto` helper. The host doesn't need Python installed.

In **interactive mode**, the user gets three choices: (1) create a new identity, (2) restore from a 24-word recovery phrase, or (3) restore from a raw 64-character hex seed. Non-interactive mode auto-generates a fresh seed.

For a new identity:

1. Generates a random 256-bit hex string (`MASTER_SEED`) using `openssl rand -hex 32` on the host.
2. Derives the 24-word BIP-39 mnemonic via `scripts/seed_to_mnemonic.py` (inside the crypto container). The script converts 256-bit entropy → SHA-256 checksum → 11-bit chunks → English wordlist lookup. The result is displayed in a yellow box for the user to write down on paper. The user verifies their backup by entering 3 random words from the phrase.
3. The user chooses a **passphrase** (minimum 8 characters) and a **startup mode**: Maximum Security (passphrase required on every restart — never stored) or Server Mode (passphrase stored locally in `secrets/seed_password` for unattended boot).
4. Wraps the seed with the passphrase (Argon2id + AES-256-GCM via `scripts/wrap_seed.py`) — secrets passed via environment variables to the container, never via command-line arguments. Produces `wrapped_seed.bin` and `master_seed.salt`. No raw seed is written to `.env`.
5. Provisions deterministic service keys from the seed (`scripts/provision_derived_service_keys.py`) — derives Core and Brain Ed25519 keypairs via SLIP-0010 at `m/9999'/3'/0'` and `m/9999'/3'/1'` respectively. Writes private keys to isolated directories (`secrets/service_keys/core/` and `secrets/service_keys/brain/`), public keys to the shared `secrets/service_keys/public/`.
6. **Zeroes the seed variable** — the raw hex is overwritten with zeros and unset. From this point forward, only the wrapped form exists.

Docker Compose passes `DINA_SEED_PASSWORD` as an environment variable and mounts `wrapped_seed.bin`, `master_seed.salt`, and `seed_password` as Docker secrets. Core decrypts the wrapped seed in-process at startup.

The hex seed and the 24 words are the **same thing** in two formats. If the user loses their machine, they enter the 24 words on a new install → the words convert back to the same hex seed → Core derives the same Ed25519 keypair → the same DID is restored. There is no "password reset" because there is no server.

### Three Secrets, Three Different Jobs

`install.sh` creates three independent secrets. Understanding what each does — and doesn't do — is essential:

| Secret | Created by | Purpose | If compromised |
|--------|-----------|---------|----------------|
| **Identity Seed** | `install.sh` — `openssl rand -hex 32` | Derives ALL cryptographic keys: DID, signing key, per-persona vault encryption keys | Total compromise — attacker becomes you |
| **Brain Service Key** | `install.sh` derives via SLIP-0010 at `m/9999'/3'/1'` | Brain signs every request to Core (`X-DID`, `X-Timestamp`, `X-Signature` headers). Private keys are isolated by separate Docker bind mounts — Brain's private key is in `secrets/service_keys/brain/` (mounted only to Brain), public keys are in `secrets/service_keys/public/` (mounted to both containers). Core's private key never exists in Brain's container filesystem and vice versa. At runtime, services load existing keys only — no generation occurs. | Attacker can call Core's API as Brain — but cannot derive DID or decrypt vaults. Revoke by removing the public key from the shared `public/` directory |
| **Client Token** | Core generates during `dina pair` — `crypto/rand.Read()` | Admin web UI login password (browser POSTs token, gets session cookie) | Revoke — other devices and identity unaffected |

The client token is **not derived from the seed**. It is an independent random value. The seed never leaves Core's memory. Brain never sees it — `docker-compose.yml` passes `DINA_SEED_PASSWORD` only to Core (via Docker secret), and Core decrypts the wrapped seed in-process. The raw seed is never in an env var in production. CLI and Brain authenticate via Ed25519 signatures, not tokens.

```
                    Has seed?    Has service keypair?    Has Ed25519 keypair?
Core                  YES         N/A (verifies)          N/A (verifies)
Brain                 NO          YES                     NO
CLI                   NO          NO                      YES (one per device)
PDS                   NO          NO                      NO
```

### Key Derivation: One Seed, Many Keys

From the single seed, Core derives every key deterministically (`core/internal/adapter/crypto/keyderiver.go`). Two derivation methods serve two purposes:

**Signing key** — SLIP-0010 (tree-shaped, by index):
```
Seed → SLIP-0010 → m/9999'/0'/0' → Root Ed25519 signing key (generation 0) → DID
```
One root signing key for the whole node. Used for DID authentication, D2D message signatures, and verdict signing. The derivation tree separates concerns at the top level: `m/9999'/0'/...` for root signing (with generations), `m/9999'/1'/...` for persona signing keys (index + generation), `m/9999'/2'/...` for PLC recovery, `m/9999'/3'/...` for service auth. Personas can grow to thousands without collisions.

**Vault encryption keys** — HKDF-SHA256 (by persona name string):
```
Seed + HKDF(salt=SHA256("dina:salt:personal"), info="dina:persona:personal:dek:v1")  → Personal vault DEK (AES-256)
Seed + HKDF(salt=SHA256("dina:salt:health"),   info="dina:persona:health:dek:v1")     → Health vault DEK (AES-256)
Seed + HKDF(salt=SHA256("dina:salt:financial"), info="dina:persona:financial:dek:v1")  → Financial vault DEK (AES-256)
Seed + HKDF(salt=SHA256("dina:backup:salt"),    info="dina:backup:key:v1")             → Backup encryption key
```

Both the persona name and a deterministic salt (`SHA256("dina:salt:<persona>")`) feed into HKDF. The persona name in the `info` parameter mathematically guarantees each persona gets a different encryption key from the same seed, while the per-persona salt adds domain separation. The derivation is versioned — v1 is the current default, v2 (with a different info tag) exists for vault re-encryption during DEK migration. Because the version goes into the HKDF info string, v1 and v2 produce different DEKs from the same seed, which is required for re-encrypting a vault without data loss.

**Persona signing keys** use SLIP-0010 with a 4-level path: `m/9999'/1'/<personaIndex>'/<generation>'`. Persona indexes are assigned by convention: 0=consumer, 1=professional, 2=social, 3=health, 4=financial, 5=citizen, 6+=custom. Each persona can rotate independently by incrementing its generation counter.

Signing keys (Ed25519, asymmetric) prove **who you are** — "this message is from me." Vault DEKs (AES-256, symmetric) protect **what you store** — "only I can read this data."

Recover the seed → all keys regenerate identically → same DID, same vault decryption.

### Bootstrapping Identity from Seed

Now the most delicate operation: **identity seed management** (lines 97-229). Dina's entire cryptographic identity derives from a single 32-byte seed. The code uses a strict priority chain:

1. **`DINA_MASTER_SEED` env var** — Direct injection (for CI/containers). If set, the hex is decoded and used immediately. When a seed password is also configured, the code auto-wraps the injected seed to `master_seed.wrapped` — a one-shot migration path from raw hex to password-protected storage.

2. **AES-GCM wrapped file** (`master_seed.wrapped` + `master_seed.salt`) — If `DINA_SEED_PASSWORD` is set (or `DINA_SEED_PASSWORD_FILE` points to a file), derive a KEK from it via Argon2id using the persisted 16-byte salt from `master_seed.salt`, then unwrap `.wrapped`. Wrong password or invalid salt is a hard failure. The state where `.wrapped` exists but `.salt` is missing is explicitly caught and fatal — it indicates a corrupt install.

3. **Generate fresh wrapped seed** — If wrapped files do not exist and password mode is enabled, generate 32 random bytes, generate a fresh 16-byte random salt, and persist both `master_seed.wrapped` and `master_seed.salt`.

There is no plaintext `master_seed.hex` fallback path in the strict runtime model. If neither `DINA_SEED_PASSWORD` nor `DINA_MASTER_SEED` is set, the process calls `log.Fatal` — fail-closed.

<details>
<summary><strong>Design Decision — Why a single 32-byte seed instead of per-key generation?</strong></summary>
<br>

Every cryptographic key in Dina — the root signing key, each persona's vault DEK, future rotation keys — is *derived* from one master seed using deterministic HD (Hierarchical Deterministic) derivation. The alternative would be generating independent random keys for each purpose and storing them separately. The single-seed approach was chosen because: (1) **backup is trivial** — back up one seed (or its BIP39 mnemonic) and you can regenerate every key, (2) **recovery is possible** — Shamir's Secret Sharing splits one seed, not dozens of keys, (3) **key derivation is reproducible** — given the same seed and the same derivation path, you always get the same key, which means identity is portable across devices without key synchronization. The tradeoff is that seed compromise is total compromise — but that's also true of any root-of-trust model (HSMs, YubiKeys, iCloud Keychain). The mitigation is AES-GCM wrapping with a user-chosen password.

</details>

<details>
<summary><strong>Design Decision — Why AES-GCM wrapping instead of full-disk encryption?</strong></summary>
<br>

The seed could be protected by OS-level disk encryption (FileVault, LUKS) or a hardware enclave. AES-GCM wrapping was chosen as an *additional* layer because: (1) Dina runs on user hardware where disk encryption may or may not be enabled — we can't assume it, (2) the wrapping is **application-level** — even if the OS is compromised or the disk image is copied, the seed is still encrypted with the user's password, (3) it enables **auto-migration** — old plaintext seeds are transparently upgraded to wrapped format on next startup, and (4) the wrapped file is portable — you can move `master_seed.wrapped` to a new machine and decrypt it with the same password. AES-256-GCM was chosen specifically because it provides both confidentiality and authenticity (if the ciphertext is tampered with, decryption fails) and is the NIST standard for symmetric authenticated encryption.

</details>

After loading, the code verifies the seed isn't all zeros (lines 218-229). Then it derives the signing key via SLIP-0010 at path `m/9999'/0'/0'` — the root signing key at generation 0. This is a deterministic HD derivation that produces the same Ed25519 keypair from the same seed every time (`core/internal/adapter/crypto/` package). Signing generation is persisted in DID metadata — if a previous key rotation occurred, the code resumes from that generation instead of always starting at zero (lines 257-269).

<details>
<summary><strong>Design Decision — Why SLIP-0010 HD derivation at path `m/9999'/0'/0'`?</strong></summary>
<br>

SLIP-0010 is the Ed25519-specific variant of BIP-32 hierarchical deterministic key derivation (BIP-32 itself only works with secp256k1). The path `m/9999'/0'/0'` uses purpose `9999'` — a custom purpose number that won't collide with Bitcoin (`44'`), Ethereum (`60'`), or any registered BIP-44 coin type. The `'` means hardened derivation, which means knowing a child public key doesn't reveal the parent. The top-level branches under `m/9999'` separate concerns: `0'` for root signing (generations), `1'` for persona signing keys (`m/9999'/1'/<index>'/<gen>'`), `2'` for PLC recovery (secp256k1), `3'` for service auth. This purpose-separated tree lets personas scale to thousands without ever colliding with root, PLC, or service keys. The alternative — BIP-32 with secp256k1 — would give us ECDSA keys instead of Ed25519, which are slower to verify and have a more complex signing algorithm. SLIP-0010 + Ed25519 gives us the best of both worlds: deterministic derivation and fast, simple signatures.

</details>

### Assembly Line: Bottom-Up Construction

With the seed in hand, the composition root builds **15 numbered adapter groups** (plus sub-groups) in dependency order. Think of it as assembling a car: you build the engine before attaching the wheels.

**Clock** comes first (line 85) — everything else needs to know what time it is. Then **crypto primitives** (lines 88-96): SLIP-0010 key deriver, HKDF key deriver, Argon2 password hasher, Ed25519 signer, key converter (Ed25519 to X25519), NaCl box sealer, AES-GCM key wrapper.

<details>
<summary><strong>Design Decision — Why Ed25519 instead of RSA or ECDSA P-256?</strong></summary>
<br>

Ed25519 was chosen as the universal signature algorithm for three reasons:

1. **Speed.** Ed25519 signature verification is ~30x faster than RSA-2048 and ~3x faster than ECDSA P-256. When every inbound D2D message needs signature verification, this matters.
2. **Small keys.** Ed25519 public keys are 32 bytes; RSA-2048 public keys are 256 bytes. DID documents, sealed envelopes, and contact directories all carry public keys — compact keys mean smaller payloads everywhere.
3. **Simplicity and safety.** Ed25519 has no configurable parameters (no curve choice, no hash choice, no padding mode). RSA has PKCS#1 v1.5 vs PSS vs OAEP. ECDSA has curve choice, hash choice, and requires careful nonce generation (nonce reuse = private key leak). Ed25519 is deterministic — the same message and key always produce the same signature — which eliminates an entire class of implementation bugs.
4. **W3C DID compatibility.** The `did:key` method natively supports Ed25519 via the `0xed01` multicodec prefix. The entire W3C Verifiable Credentials ecosystem is moving toward Ed25519/EdDSA.

The only downside: Ed25519 keys can't directly do Diffie-Hellman key exchange (needed for NaCl encryption). That's why there's a key converter (`Ed25519ToX25519`) — Ed25519 and X25519 share the same underlying curve (Curve25519), so conversion is a cheap, lossless operation.

</details>

**Vault** (line 231) — the encrypted SQLite storage. A build-tag factory (`newVaultBackend`) selects SQLCipher when CGO is available, or falls back to in-memory for testing. The identity database (Tier 0: contacts, audit log, kv_store, device_tokens) opens immediately with its own HKDF-derived DEK (lines 235-247) — it's always available, even before any persona is unlocked.

<details>
<summary><strong>Design Decision — Why SQLite/SQLCipher instead of PostgreSQL or a cloud database?</strong></summary>
<br>

Dina's core principle is **absolute loyalty** — the human holds the encryption keys, and no server sees the plaintext. A cloud database (even self-hosted PostgreSQL) creates a network-accessible attack surface and requires key management for connections. SQLite with SQLCipher gives us:

1. **Zero network surface.** The database is a local file. No TCP port, no connection string, no SQL injection over the wire.
2. **Transparent encryption.** SQLCipher encrypts every database page with AES-256-CBC. The DEK is derived per-persona from the master seed — different personas have different databases with different keys. Even if the disk is imaged, each persona vault is independently encrypted.
3. **Single-file portability.** One `.db` file per persona. Backup = copy the file. Migrate = move the file. No dump/restore, no schema versioning headaches.
4. **FTS5 full-text search.** SQLite's built-in full-text search engine is surprisingly powerful — good enough for keyword recall without a separate search service.
5. **Encrypted vector search.** Embeddings are stored as BLOBs in the same `vault_items` row — encrypted by SQLCipher like everything else. On persona unlock, Core hydrates a pure-Go HNSW index in RAM for semantic similarity search (<1ms queries). On lock, the index is destroyed. No mmap'd vector files, no plaintext leakage.

The build-tag factory (`newVaultBackend`) is a pragmatic compromise: CGO is required for SQLCipher's C library, but some CI environments and test runners don't have CGO. The in-memory fallback means tests run everywhere, and production uses the real encrypted backend.

</details>

<details>
<summary><strong>Design Decision — Why in-memory HNSW instead of sqlite-vec or FAISS for vector search?</strong></summary>
<br>

Dina needs semantic search — "I need an office chair" should find health records about "chronic lower back pain from sitting." FTS5 is keyword-based and can't do this. The obvious choice would be a vector database or SQLite extension like `sqlite-vec`.

The problem: **every popular vector solution stores vectors as plaintext files on disk via `mmap`.** sqlite-vec uses memory-mapped files. FAISS uses `.faiss` index files. ChromaDB uses Parquet files. These plaintext vector files sit alongside the encrypted SQLCipher database, completely bypassing the encryption that protects everything else. A disk image or stolen backup exposes all embeddings — which encode the semantic content of the user's personal data.

Dina's solution: **Encrypted Cold Storage with Volatile RAM Hydration.** Embeddings are stored as `BLOB` columns in the same SQLCipher row as the text. On persona unlock, Core reads all `(id, embedding_blob)` pairs and builds an HNSW (Hierarchical Navigable Small World) graph in RAM using [`github.com/coder/hnsw`](https://github.com/coder/hnsw) — a pure-Go library with built-in cosine distance (CC0 license). On persona lock, the index is destroyed and garbage collected.

The numbers work: 768-dim × float32 = 3,072 bytes per vector. 10K items = ~30MB in SQLCipher, ~50MB RAM when hydrated. Hydration takes ~40-80ms (one-time, during unlock). Queries take <1ms. For a personal vault on a Raspberry Pi 5 (8GB) or Mac Mini M4 (16GB), this is well within budget.

Hybrid search merges both: `score = 0.4 × FTS5_rank + 0.6 × cosine_similarity`. FTS5 catches exact keyword matches. HNSW catches semantic similarity. Together they cover both precise and fuzzy recall.

</details>

**PII Scrubber** (line 250) — a regex-based scanner that detects emails, SSNs, credit cards, and phone numbers before any data leaves the Home Node.

**Identity** (lines 252-357) — the DID manager, persona manager, contact directory, device registry, and recovery manager. This section has grown substantially. Here's the crucial wiring:

- `personaMgr.OnLock` (lines 304-317) fires when a persona's TTL timer expires or the user manually locks it. The callback strips the `"persona-"` prefix, validates it as a persona name, and calls `vaultMgr.Close()`. This is how **the vault automatically locks when the persona locks**.
- `personaMgr.VerifyPassphrase` (line 294) and `personaMgr.HashUpgrader` (line 297) — callbacks for Argon2id passphrase verification and hash upgrades on successful auth.
- `personaMgr.CheckOrphanedVault` (lines 324-329) — an orphan-guard callback. If a vault `.sqlite` file exists on disk but the persona has no in-memory state, creation is rejected to prevent DEK reuse. This guards against re-creating a persona whose encrypted data still exists from a previous install.
- **Persona state persistence** (lines 282-293) — persona state is persisted to `persona_state.json`. In production, a corrupted state file is fatal; in dev/test or with `DINA_RECOVER_PERSONAS=1`, degraded startup is allowed.
- **Auto-open at boot** (lines 330-353) — default and standard tier personas are automatically opened at startup, so vault queries work immediately for non-sensitive compartments. No passphrase needed — these tiers are designed for convenience.

**Trust** (lines 359-362) — the trust cache, resolver, and service. An in-memory trust cache provides microsecond DID lookups for ingress gatekeeper decisions. The resolver fetches trust profiles from the AppView XRPC endpoints. Together with the contact directory, they form a 3-tier authority hierarchy for incoming messages: contacts (manual, highest authority) → cache (AppView synced) → unknown (quarantine). More in Act X.

**PLC/PDS** (lines 364-384) — optional AT Protocol integration. When `DINA_PDS_URL` is set, Core connects to the AT Protocol PDS for `did:plc` identity and trust record publishing. K256 key management (secp256k1) provides the PLC recovery key at `m/9999'/2'/0'`.

**Service Keys** (lines 387-432) — Ed25519 service-to-service auth. PEM files are provisioned at install time via `provision_derived_service_keys.py` (SLIP-0010 derived at `m/9999'/3'/<index>'`). Runtime is load-only, fail-closed — `EnsureExistingKey("core")` loads but never generates. Brain's public key is required (30-second retry loop). Admin and connector peer keys are optional — loaded if provisioned, silently skipped otherwise.

**Auth** (lines 418-438) — the token validator. Brain's service key DID is registered, then optional peers (admin, connector). `cfg.ClientToken` is registered as scope `"admin"` when set — this is the bootstrap token that can do everything. Paired device tokens later get registered as scope `"device"`.

<details>
<summary><strong>Design Decision — Why two token scopes (admin vs device) instead of RBAC?</strong></summary>
<br>

A full role-based access control system (RBAC) with roles, permissions, and policy files would be overkill for Dina's two-actor model. There are exactly two kinds of callers: (1) the **bootstrap admin** — the human who set up the Home Node and knows the `DINA_CLIENT_TOKEN`, and (2) **paired devices** — phones, tablets, CLI tools that completed the QR pairing flow. Admin can do everything. Devices can do most things but cannot sign DIDs (would let a stolen phone impersonate you), rotate keys (would let a stolen phone lock you out), view the mnemonic (would let a stolen phone clone your identity), or access admin endpoints. Two scopes, two path lists, zero config files. If Dina ever needs finer-grained permissions (per-persona access for devices, time-limited scopes), the `scope` field is already a string — it can be extended without breaking the interface.

</details>

**Gatekeeper** (lines 440-441) — the intent evaluator and sharing policy manager. We'll visit this in detail later.

**Transport** (lines 443-498) — DID resolver, outbox, inbox, and the actual message transporter. Known peers from `DINA_KNOWN_PEERS` env var are pre-loaded into the resolver with full DID documents including `verificationMethod` and `serviceEndpoint`. The format is strict 3-part: `did=endpoint=seedhex`.

**Task Queue** (lines 500-503) — in-memory task queue with a watchdog for stale tasks, plus the reminder scheduler.

**WebSocket Hub** (lines 505-507) — connection registry and real-time notification. The notifier is created here but the `OnApprovalNeeded` callback is wired later (lines 510-535) — when a persona requires human approval (e.g., a locked persona access request from an agent), the notification is broadcast to all WebSocket clients (admin UI) and logged.

**Pairing** (line 538) — QR-code-based device pairing protocol.

**Brain Client** (line 541) — HTTP client for the Python sidecar, with circuit breaker (open after 5 consecutive failures, 30s cooldown), connection pooling, and Ed25519 request signing. After the brain client is created, the `OnApprovalNeeded` callback is extended (lines 546-563) to also push approval events to Brain — enabling Telegram notification delivery.

<details>
<summary><strong>Design Decision — Why a Python sidecar instead of in-process LLM?</strong></summary>
<br>

The Go core handles crypto, storage, identity, and HTTP — things that need to be fast, type-safe, and auditable. The Python brain handles LLM reasoning — calling Ollama, Gemini, or other providers, parsing structured output with PydanticAI, managing vector memory with ChromaDB. These are fundamentally different workloads:

- **Go** is better at: crypto operations, concurrent HTTP handling, low-latency API routing, and zero-dependency deployment.
- **Python** is better at: LLM library ecosystem (PydanticAI, LiteLLM, ChromaDB, Google ADK), rapid iteration on prompt engineering, and native support for ML/AI tooling.

A sidecar architecture means: (1) the core can run without the brain (health probes degrade gracefully), (2) the brain can be replaced or upgraded independently (swap Ollama for Gemini without touching the core), (3) a crash in the LLM layer doesn't take down identity or encryption, and (4) the brain communicates via a well-defined HTTP API authenticated with Ed25519 signed requests (service key), creating a clear security boundary.

</details>

**Reminder Loop** (lines 565-589) — a background goroutine that fires reminders on schedule. The loop sleeps until the next trigger time, wakes on new reminder insertion, and delegates fired reminders to Brain for contextual notification assembly. No cron library — just `time.Sleep(time.Until(triggerAt))` with channel-based wake interrupts.

**Observability** (lines 591-608) — a dynamic health checker (brain reachability + vault path + service key checks) and crash logger.

**Portability** (lines 609-611) — export and import managers for Home Node migration. Archives are encrypted with AES-256-GCM + Argon2id key derivation. More in Act XI.

**Estate** (line 614) — digital estate plan manager for Shamir-based activation and beneficiary key delivery.

### Services: The Business Logic Layer

With all adapters ready, the code constructs **service objects** (lines 616-809). Services compose port interfaces — they never import adapters directly. This is the hexagonal architecture boundary.

<details>
<summary><strong>Design Decision — Why hexagonal architecture (ports and adapters)?</strong></summary>
<br>

In hexagonal architecture, business logic lives in `service/` and depends only on `port/` interfaces — never on concrete adapters. The adapters (`adapter/auth/`, `adapter/identity/`, `adapter/vault/`) implement the port interfaces. This pattern was chosen because:

1. **Testability.** Every service can be tested with mock adapters. The 1060+ tests in the suite run without SQLCipher, without a real filesystem, without network — because the services only see interfaces.
2. **Swappability.** The vault backend can be SQLCipher in production and in-memory in tests — same service code, different adapter. The brain client can be real HTTP or a stub. The clock can be real or frozen for deterministic tests.
3. **Enforced boundaries.** If a service tries to `import "adapter/auth"`, the build fails. This prevents the "just this once" shortcuts that erode architecture over time.
4. **Readability.** The `port/` directory is the system's contract. Read it and you know every capability the system has — without reading a single implementation line.

The tradeoff is more files and more interfaces than a flat architecture. But for a security-critical system where every boundary matters, explicit interfaces are a feature, not overhead.

</details>

The **IdentityService** (line 618) handles DID creation, key rotation, and persona DEK derivation. The **GatekeeperService** (`gkSvc`, line 623) is created *before* the VaultService and passed into it. So every vault operation — query, store, delete — passes through the gatekeeper first. The **VaultService** (line 627) also receives a `PersonaManager` (line 630), enabling persona-tier enforcement on every operation.

The **TransportService** (lines 632-646) gets wired with the signer, converter, resolver, outbox, inbox, and clock. Then five post-construction wirings: `SetDeliverer` (the actual HTTP sender), `SetVerifier` (Ed25519 signature checker), `SetEgress` (gatekeeper-enforced egress policy on outbound D2D — SEC-HIGH-04), `SetRecipientKeys` (the node's own keypair for decryption), and conditionally `SetSenderDID` (lines 643-646, sets the sender DID for outbound messages when `cfg.OwnDID` is configured).

The ingress pipeline (lines 648-706) is assembled next — dead drop, rate limiter, sweeper, and router. Background goroutines follow (lines 708-786): ingress pending sweep (10s), outbox retry (30s), replay cache purge (5m), outbox retention cleanup (5m), pairing code expiry (1m), per-DID rate limit reset (1m), and trust neighborhood sync (1h).

Four new services complete the wiring: **TaskService** (line 788), **DeviceService** (line 790), **EstateService** (line 793), and **MigrationService** (line 797). Three more are constructed for future routing: **SyncService** (line 801 — multi-device sync via checkpoint-based deltas), **WatchdogService** (line 805 — periodic health monitoring with 90-day log retention purge), and **OnboardingService** (line 809 — first-run setup wizard).

---

## Act II: The Ingress Pipeline — Three Valves

This is the heart of Dina's message-receiving architecture. When another Dina sends you a message, it arrives as a NaCl-encrypted blob at `POST /msg`. The ingress pipeline ensures **no message is ever lost, even when you're locked out of your own vault**.

<details>
<summary><strong>Design Decision — Why NaCl `crypto_box_seal` instead of TLS or JWE?</strong></summary>
<br>

TLS protects data in transit but requires the server to be online and authenticated. Dina-to-Dina messages need to work **asynchronously** — the recipient's Home Node might be locked, offline, or sleeping. NaCl `crypto_box_seal` (libsodium's sealed box) provides:

1. **Sender anonymity at the crypto layer.** The sealed box only requires the recipient's public key. The sender is identified inside the encrypted payload (the `from` field in `DinaMessage`), not in the envelope. An eavesdropper sees only the recipient's public key and ciphertext.
2. **No session setup.** No TLS handshake, no certificate chain, no renegotiation. One HTTP POST with a binary blob. Fire and forget.
3. **Forward secrecy per message.** Each `crypto_box_seal` generates a fresh ephemeral X25519 keypair. Even if the recipient's long-term key is later compromised, past messages encrypted with past ephemeral keys remain safe.
4. **Phase 2 migration path.** The plaintext structure `{id, type, from, to, created_time, body}` is the migration invariant. Phase 2 replaces NaCl with JWE (JSON Web Encryption) for standards compliance — but the plaintext stays the same, so the ingress pipeline doesn't change.

The tradeoff: NaCl is not a web standard. JWE/JWS would be interoperable with the broader DID ecosystem. That's why Phase 2 is planned — but NaCl gives us correct, auditable encryption *now* with minimal code surface.

</details>

### The Router

The Router (`core/internal/ingress/router.go`) is the traffic cop. When a blob arrives, it passes through three valves:

**Valve 1: IP Rate Limit** — The RateLimiter (`core/internal/ingress/ratelimit.go`) checks whether this IP has exceeded its per-minute quota. If so, the message is rejected immediately with `ErrRateLimited`. This prevents a single sender from flooding your Home Node.

**Valve 2: Payload Size** — The InboxManager checks whether the envelope exceeds the maximum allowed size. Oversized payloads are rejected before they touch disk.

<details>
<summary><strong>Design Decision — Why a 3-valve pipeline instead of a simple message queue?</strong></summary>
<br>

A simple design would be: receive blob, try to decrypt, store result. But this breaks when the vault is locked — you can't decrypt without the DEK, and you can't get the DEK without the passphrase. You'd have to reject the message and tell the sender to retry later. That's unacceptable — the sender shouldn't know (or care) about the recipient's lock state.

The 3-valve pipeline solves this by separating **reception** from **processing**:
- **Valve 1 (IP rate limit)** protects against flood attacks regardless of vault state.
- **Valve 2 (payload size + spool capacity)** protects disk from exhaustion.
- **Valve 3 (the fork)** routes to dead drop (locked) or fast path (unlocked).

The result: the sender always gets `202 Accepted`. The message is either decrypted immediately or parked as an opaque blob. No retries needed. No state leak. The recipient's lock state is invisible to the network.

</details>

**The Fork: Locked vs Unlocked**

Now the Router checks: is the `general` persona's vault open (`domain.NewPersonaName("general")`)? This is the decisive moment.

**If locked** — the vault keys aren't available, so the blob can't be decrypted. But we don't want to lose it. First, `AllowGlobal()` checks spool capacity (Valve 2b — total spool size cap to prevent disk exhaustion). Then the blob goes into the **Dead Drop** (`core/internal/ingress/deaddrop.go`).

The Dead Drop is beautifully simple: a directory of opaque `.blob` files with random hex filenames. `Store()` writes atomically (temp file + rename) with `0600` permissions. No metadata, no sender DID visible, no index — while locked, these blobs are just opaque cryptographic noise on disk.

<details>
<summary><strong>Design Decision — Why a filesystem dead drop instead of a database queue?</strong></summary>
<br>

The dead drop stores encrypted blobs *before* the vault DEK is available. If we used SQLCipher for this, we'd need the DEK to write — but we don't have it because the vault is locked. A separate unencrypted SQLite database would work, but then we'd have an unencrypted database on disk holding ciphertext that an attacker could analyze for traffic patterns (timing, size, frequency).

Flat files in a directory give us:
- **Zero dependency on DEK state.** Write works whether the vault is locked or not.
- **Atomic writes.** `write-to-temp + rename` is the simplest atomic operation in any filesystem. No WAL, no journal, no recovery mode.
- **Random filenames.** `crypto/rand` generates 16-byte hex names. No enumeration, no ordering, no metadata leakage.
- **Trivial cleanup.** `os.Remove(path)` is the Ack. No garbage collection, no vacuum.

The tradeoff: no indexing, no querying, no ordering. But dead drop blobs don't need any of that — they're opaque until decrypted, and the Sweeper processes them all sequentially anyway.

</details>

**If unlocked** — the `onEnvelope` callback fires (lines 680-706 in `main.go`). This callback calls `transportSvc.ProcessInbound()` to decrypt the NaCl sealed box, verify the sender's signature, and produce a `DinaMessage`. If decryption succeeds, the message passes through two additional filters before storage:

1. **Per-DID rate limit** (SEC-MED-12) — even after IP rate limiting, each sender DID has its own per-minute quota. This prevents a single known sender from overwhelming the inbox.
2. **Trust-based ingress filtering** — the TrustService evaluates the sender's DID against the contact directory and trust cache. Three outcomes: **accept** (known/trusted, store normally), **quarantine** (unknown DID, store with `Quarantined=true` for later review), or **drop** (blocked DID, silently discard). This is the first line of defense against spam from the decentralized network.

If decryption fails, the blob **falls back to the dead drop**. No silent data loss.

### The Dead Drop: Peek/Ack Semantics

The Dead Drop uses a **two-phase** protocol. `Peek(name)` reads without removing. `Ack(name)` deletes after successful processing. This way, if decryption fails midway, the blob survives for the next sweep attempt. All operations are mutex-protected — concurrent goroutines cannot corrupt the spool state.

Writes are crash-safe: `Store()` writes to a temporary file (`.tmp-<name>`) first, then atomically renames it to the final `<name>.blob` path. If the process crashes mid-write, only the temp file is left — the spool stays clean. Filenames are 16 random bytes (hex-encoded) + `.blob`, preventing enumeration of pending messages.

<details>
<summary><strong>Design Decision — Why Peek/Ack instead of read-and-delete?</strong></summary>
<br>

The original `Read()` method (still present for backward compatibility) reads the blob and deletes it in one operation. This creates a window of data loss: if the process crashes between reading the blob and successfully decrypting/storing the message, the blob is gone and the message is lost.

Peek/Ack is the classic **two-phase commit** pattern from message queue systems (SQS, RabbitMQ, Kafka consumer groups):
1. `Peek` — read without side effects. The blob stays on disk.
2. Process — decrypt, verify, store in inbox.
3. `Ack` — delete from disk only after successful processing.

If the process crashes between Peek and Ack, the blob survives. The next Sweep picks it up again. The cost is one extra filesystem operation per message — trivial compared to the cryptographic work.

</details>

### The Sweeper

After the vault is unlocked, the **Sweeper** (`core/internal/ingress/sweeper.go`) drains the dead drop. Each `Sweep()` call begins with a **stale blob GC pass** — any `.blob` file whose filesystem mtime exceeds 24 hours is evicted immediately. This provides restart resilience, since the in-memory failure counters are lost on process restart.

For each remaining blob, the sweeper:

1. `Peek`s the blob (read without delete).
2. Delegates to `transport.ProcessInbound()` for decryption + signature verification. (A fallback raw-decryption path exists for cases where no transport processor is configured — it handles Ed25519-to-X25519 key conversion, NaCl `OpenAnonymous`, and JSON unmarshalling directly.)
3. Checks message TTL — if the message is older than 24 hours, it's silently dropped and `Ack`'d.
4. Calls the `onMessage` callback to deliver the decrypted message. The callback (wired in `main.go:658-677`) applies per-DID rate limiting and trust-based ingress filtering — the same accept/quarantine/drop rules as the fast path.
5. `Ack`s the blob (deletes from disk) and clears the failure counter.

**Poison-pill eviction** (HIGH-04): if a blob fails to decrypt on 5 consecutive sweep attempts, it is evicted — `Ack`'d and removed. Without this, a single corrupt or maliciously crafted blob would block the sweeper on every 10-second cycle forever. The failure counter is tracked per blob name in a mutex-protected map.

The background goroutine in `main.go:708-719` runs `ProcessPending()` every 10 seconds. It calls `sweeper.Sweep()` first (dead drop), then drains the fast-path inbox spool. Any failures during spool processing re-deposit the blob into the dead drop for another attempt.

<details>
<summary><strong>Design Decision — Why a 24-hour TTL on dead drop messages?</strong></summary>
<br>

Messages that sit in the dead drop for more than 24 hours are silently dropped during sweep. This prevents an attacker from sending thousands of messages while the vault is locked, then having them all process at once on unlock (a **thundering herd** that could overwhelm the system). It also prevents stale data from accumulating indefinitely if the user rarely unlocks a persona. The 24-hour window is generous enough that normal offline periods (sleeping, traveling) don't lose messages, but short enough that a sustained attack eventually expires. The TTL is configurable via the `Sweeper` constructor.

</details>

### The Outbox: Retry on the Other Side

Meanwhile, outbound messages have their own lifecycle. The outbox retry goroutine (lines 721-732) runs every 30 seconds, calling `transportSvc.ProcessOutbox()` to retry failed deliveries with exponential backoff (`30s × 2^retries`). Messages that fail 5 consecutive deliveries are dead-lettered — `ProcessOutbox` skips them, and they remain in the outbox until the cleanup goroutine removes them. A separate cleanup goroutine (lines 746-755) runs every 5 minutes, purging outbox entries older than 24 hours. And the replay cache (lines 734-744) — which prevents processing the same inbound message twice by keying on `senderDID|msgID` — is purged every 5 minutes, removing entries older than 24 hours (SEC-HIGH-08).

---

### Where HTTP Lives in Core

Before tracing a request's journey, it helps to see the full HTTP surface — both inbound and outbound.

**Server-side (Core listens):**

| Listener | Address | Auth | Purpose |
|----------|---------|------|---------|
| **TCP** | `:8100` (configurable) | Ed25519 signatures / Bearer token / public | Primary API — Brain, devices, agents, WebSocket |
| **Unix socket** | `/data/run/admin.sock` | Socket access = admin (no token) | `dina-admin` CLI inside the container |

Both use the same `http.ServeMux` router but different middleware chains — the socket replaces Auth+Authz with `SocketAdminAuth`.

**Client-side (Core calls out):**

| Client | Target | Auth | Purpose |
|--------|--------|------|---------|
| **BrainClient** | `brain:8200` | Ed25519 service key | Process events, reason, health check. Circuit breaker (5 failures → open, 30s cooldown) |
| **TrustResolver** | AppView `:3000` | None (internal network) | XRPC endpoints: `com.dina.trust.getProfile`, `com.dina.trust.getGraph` |
| **PLCClient** | PLC directory + PDS | Admin token | DID creation/rotation on `plc.directory` |
| **PDSPublisher** | AT Protocol PDS | Admin token | Publish trust records (`com.dina.trust.*` lexicons) |
| **Transporter** | Other Dina nodes | NaCl sealed box (payload-level) | D2D message delivery to `POST /msg` on recipient |

**Proxy paths (Core relays to Brain):**

Three handlers where Core accepts an HTTP request from a device/agent and re-issues it to Brain with Core's service key:

- **AdminHandler** (`/admin/*`) — reverse-proxies the admin web UI via `httputil.ReverseProxy`.
- **AgentHandler** (`/v1/agent/validate`) — not a generic proxy. Only accepts `agent_intent` events, overrides the caller-supplied `agent_did` with the authenticated identity from the auth middleware, and sets `trust_level` to `"verified"`. Then forwards the patched payload to Brain's guardian via `ProcessEvent`.
- **ReasonHandler** (`/api/v1/reason`) — proxies LLM reasoning to Brain, re-signing with Core's service key. Forwards agent DID and session name for agent-scoped callers so Brain can attribute vault access to the originating agent.

In all three cases, the external caller authenticates to Core (device key or client token), and Core authenticates to Brain (service key). Brain is never directly exposed to the network.

**Not HTTP:**

- **WebSocket** (`/ws`) — upgrades from HTTP but then uses the WebSocket protocol for bidirectional messaging.
- **Vault storage** — local SQLCipher files, no network.
- **Dead drop** — local filesystem, no network.
- **Reminder loop** — in-process goroutine, no network.

---

## Act III: The Request Journey — From HTTP to Vault

Now let's trace what happens when a legitimate request arrives at the API.

### The Middleware Chain

Every request passes through **eight layers** before reaching a handler (lines 1065-1084). Think of them as concentric walls of a fortress:

<details>
<summary><strong>Design Decision — Why hand-rolled middleware instead of a framework (Gin, Echo, Fiber)?</strong></summary>
<br>

Go's `net/http` standard library is production-grade: it handles HTTP/1.1 and HTTP/2, supports graceful shutdown, and provides `http.Handler` — the universal interface that every middleware composable uses. Frameworks add routing DSLs, context helpers, and middleware chains — but Dina's routing is simple enough for `http.ServeMux`, and the middleware chain is just function composition: `cors(bodyLimit(recovery(logging(rateLimit(auth(authz(timeout(mux))))))))`.

No framework means: (1) zero third-party dependencies in the HTTP layer (smaller attack surface), (2) no framework-specific context types leaking into business logic, (3) total control over the middleware order (which matters — CORS must be outermost, auth must come before authz, timeout must be innermost). The cognitive cost of learning "how does this framework work?" is replaced by "read the 8 wrapper functions in main.go."

**The numbers make the case.** The entire middleware layer is 505 lines across 7 files:

| File | Lines | What it does | Framework equivalent |
|------|-------|-------------|---------------------|
| `auth.go` | 251 | Ed25519 sig verification, Bearer tokens, per-service caller-type context injection, SocketAdminAuth, Authz | **None.** This is Dina-specific. No framework gives you Ed25519 canonical-payload signature auth with per-service caller-type mapping. You'd write the same custom middleware in Gin. |
| `ratelimit.go` | 77 | Per-IP rate limiting with rightmost-trusted XFF parsing (SEC-MED-15) | Gin has no built-in rate limiter. You'd add `gin-contrib/ratelimit` or `ulule/limiter` — a dependency, not free. The rightmost-trusted XFF logic would still be custom. |
| `cors.go` | 69 | Origin matching, preflight OPTIONS, wildcard vs credentialed | `gin-contrib/cors` does this. Saves ~50 lines. |
| `logging.go` | 45 | statusWriter wrapper + slog structured log | `gin.Logger()` does this. Saves ~30 lines. |
| `recovery.go` | 31 | Panic recovery → `debug.Stack()` + 500 | `gin.Recovery()` does this. Saves ~20 lines. |
| `timeout.go` | 17 | One-line wrapper: `http.TimeoutHandler(next, duration, msg)` | Same in any framework. |
| `bodylimit.go` | 15 | One-line wrapper: `http.MaxBytesReader(w, r.Body, max)` | Same in any framework. |

A framework would replace **~100 lines of boilerplate** (cors, logging, recovery) and add **~0 help** for the 251-line auth middleware — which is the only complex part and is entirely Dina-specific. Meanwhile, Gin pulls in `json-iterator`, `go-playground/validator`, `ugorji/codec`, and other transitive dependencies — each an attack surface for a security-critical system that currently has zero third-party deps in its HTTP layer.

The `http.Handler` interface is also the universal adapter in the Go ecosystem. Every middleware, every test harness, every tool works with it. Gin's `gin.Context` is a framework-specific type — once adopted, handlers, tests, and mocks all speak Gin, and switching away is a rewrite.

</details>

1. **CORS** (`core/internal/middleware/cors.go`) — Sets `Access-Control-Allow-Origin`. When configured as `"*"`, it correctly omits `Access-Control-Allow-Credentials` per the spec.

2. **Body Limit** — Caps request bodies at 1 MB. Rejects oversized payloads before any further processing.

3. **Recovery** — Catches panics, logs them, returns 500.

4. **Logging** — Structured JSON logs with request timing.

5. **Rate Limit** — Per-IP token bucket with trusted proxy CIDR support (X-Forwarded-For). Rejects with 429 if exceeded.

6. **Auth** (`core/internal/middleware/auth.go`) — This is where tokens are validated. Five paths, checked in order:
   - **Public paths** (`/healthz`, `/readyz`, `/.well-known/atproto-did`) — skip auth entirely.
   - **Admin proxy** (`/admin`, `/admin/*`) — bypassed because Core acts as a transport proxy; the Brain admin session/login middleware handles authentication on that side.
   - **NaCl ingress** (`POST /msg`) — authenticated by the sealed box itself, no token needed.
   - **Ed25519 signature auth** — The client sends `X-DID`, `X-Signature`, `X-Timestamp`, and `X-Nonce` headers. The middleware verifies the timestamp is within 5 minutes (replay protection), reads the body (bounded to 1MB), and calls `VerifySignature()`. The nonce provides additional replay protection beyond the timestamp window. On success, it sets `token_kind`, `agent_did`, and `token_scope` in the request context.
   - **Bearer token auth** — Classic `Authorization: Bearer <token>`. `IdentifyToken()` handles client tokens only (admin/bootstrap contexts). CLI and Brain use Ed25519 signatures for normal operations.
   - **Optional auth paths** (`/v1/pair/complete`) — if no Ed25519 or Bearer credentials are present, the request passes through unauthenticated. The pairing code itself is the auth for this endpoint.

<details>
<summary><strong>Design Decision — Why two auth methods (Ed25519 signatures + Bearer tokens)?</strong></summary>
<br>

Ed25519 signature auth (`X-DID` + `X-Signature` + `X-Timestamp` + `X-Nonce`) is the primary auth method for devices and services. The private key never leaves the device/service, and each request is signed with the current timestamp plus a random nonce to prevent replay. The canonical signing payload is: `{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{SHA256_HEX(BODY)}`. `VerifySignature()` checks service keys first (Brain's public key, loaded from `/run/secrets/service_keys/public/`), then device keys.

- **CLI** uses Ed25519 signature auth exclusively (one keypair per device).
- **The Python brain sidecar** uses Ed25519 signature auth with its own service keypair, derived from the master seed at install time via SLIP-0010. Private keys are isolated by separate Docker bind mounts — Brain's private key is in `secrets/service_keys/brain/` (mounted only to Brain as `/run/secrets/service_keys/private/`), while both services' public keys are in `secrets/service_keys/public/` (mounted to both containers as `/run/secrets/service_keys/public/`). At runtime, services load existing keys only — no generation occurs.

Bearer tokens serve browser-based contexts only:
- **Admin/browser path** is handled via Core auth/session and reverse proxying. The brain API itself stays on service-signature auth.

The 5-minute timestamp window prevents replay attacks while accommodating reasonable clock skew between devices. The body hash is included in the signature to prevent request tampering.

</details>

7. **Authz** (`NewAuthzMiddleware`) — Reads the token kind and scope from context. Calls `AllowedForTokenKind(kind, path, scope)` to check whether this caller can access this endpoint. The `AdminEndpointChecker` (`core/internal/adapter/auth/auth.go`) blocks `"device"`-scoped tokens from sensitive paths like `/v1/did/sign` and `/admin/*`.

8. **Timeout** — 30-second deadline on every request.

### Example: Storing a Verdict in the Vault

Say the Python brain just analyzed a YouTube video and wants to store the verdict. It sends `POST /v1/vault/store` with Ed25519 service-signature headers.

**Step 1: Auth middleware** verifies service signature and identifies caller as `brain` (kind=`"brain"`).

**Step 2: Authz middleware** checks — is `"brain"` allowed to access `/v1/vault/store`? Yes, the brain can store data.

**Step 3: VaultHandler.HandleStore** (`core/internal/handler/vault.go`) parses the JSON body, validates the persona name via `domain.NewPersonaName()` (which rejects anything not matching `[a-z0-9_]+`), and calls `vaultSvc.Store()`.

**Step 3b: Handler defaults** — Before calling the service, the handler checks the caller type. If the caller is an `agent` or `user` (as opposed to Brain's service identity), the handler injects trust metadata defaults: `sourceType="self"`, `sender="user"`, `senderTrust="self"`, `confidence="high"`, `retrievalPolicy="normal"`. This ensures user-authored content is always trusted without requiring Brain involvement.

**Step 4: VaultService.Store** (`core/internal/service/vault.go`) — Here the cascading checks begin:
- **PersonaManager.AccessPersona** — tier-based access control. This is not a simple "is the session active?" check — it's a decision tree over persona tiers. Locked-tier personas flat-deny agents and brain even when unlocked. Sensitive-tier personas audit every access and require a session grant for agents/brain. Standard-tier personas require a session grant for agents. Default-tier personas auto-approve. If a grant is missing, `ErrApprovalRequired` is returned — the handler catches this and creates an approval request (see Approval Flow below).
- **Is the vault open?** If not, returns `ErrPersonaLocked`.
- **Gatekeeper.EvaluateIntent** — the intent check, with `ActionVaultWrite` as the action. Brain's write to an unlocked persona passes; an untrusted external agent would be blocked. If denied, returns `ErrForbidden` with a reason.
- Set `IngestedAt` timestamp if not already set.
- Delegate to `writer.Store()` — the SQLite adapter, which performs its own validation: item type against `domain.ValidVaultItemTypes` and body size against `domain.MaxVaultItemSize` (10 MiB).

**Step 5:** ID returned to handler, encoded as JSON, returned as `201 Created`.

### Example: Querying with Gatekeeper

Now say an external agent (trust level: "verified") wants to query the vault. The flow changes:

**VaultService.Query** (`core/internal/service/vault.go`) does everything Store does, including the full authorization gauntlet. Every vault operation — query, get, store, delete — passes through the same checks:

```
Brain/Agent calls: POST /v1/vault/query {persona: "health", query: "..."}
       │
       ▼
VaultService.Query()
       │
       ├── 1. PersonaManager.AccessPersona() — tier-based access control
       │       (MUST run before IsOpen — so closed sensitive personas trigger
       │        approval flow, not just "persona locked")
       │
       ├── 2. Is persona unlocked?  ──── NO → ErrPersonaLocked (vault is sealed)
       │
       └── 3. Gatekeeper.EvaluateIntent({
               AgentDID:  "brain",         // who is asking
               Action:    "vault_read",    // what they want to do
               Target:    "health",        // resource being accessed
               PersonaID: "health",        // which compartment
           })
```

Note: the `Intent` struct also has `TrustLevel` and `Constraints` fields, but VaultService.Query does not set them — for vault operations, the gatekeeper sees Brain's agentDID (`"brain"`) and applies brain-specific rules. TrustLevel and Constraints are populated by the `AgentHandler` for external agent intent validation (`/v1/agent/validate`), a separate path.

This hits **Gatekeeper.EvaluateIntent** (`core/internal/adapter/gatekeeper/gatekeeper.go`). The gatekeeper applies a decision tree, checked in this order:

1. **Brain + security-critical action?** — Hard deny. Brain can never `did_sign`, `did_rotate`, `vault_backup`, `persona_unlock`, `vault_raw_read`, `vault_raw_write`, or `vault_export`. Seven actions, all requiring the human (via CLIENT_TOKEN).
2. **Brain + locked persona?** — Denied. The brain cannot access locked compartments (checks `intent.TrustLevel == "locked"`).
3. **Brain + restricted persona?** — Allowed but **audited**. Every access creates a trail.
4. **Cross-persona constraint?** — If an agent has constraint `persona_health_only: true`, it can **only** access the health vault. Requesting financial → denied. This is how you scope an external agent (OpenClaw, Perplexity Computer) to one compartment.
5. **Draft-only constraint?** — Agents with `draft_only: true` cannot perform risky actions (send_email, transfer_money). They can only prepare drafts.
6. **Untrusted agent?** — Flat denial for **all** actions. Not just vault or risky — an untrusted agent cannot do anything.
7. **Money action without highest trust?** — `transfer_money` requires the "Verified+Actioned" trust ring (proven transaction history + peer attestation).
8. **Vault access by verified (not fully trusted) agent?** — Allowed but **audited**. The user can review what was accessed.
9. **Risky action?** — `send_email`, `transfer_money`, `share_data` are **denied** (`Allowed: false`). Even trusted agents cannot silently send email — these actions require explicit human approval through a separate flow.
10. **Everything else** — Safe intent, pass silently, no audit trail.

Today, Brain's agent DID is `"brain"` and it can access any *unlocked* persona. The constraint mechanism (rules 4-5) exists for external agents where you'd scope access: "this agent can only see my personal vault, not health or financial." Brain itself is trusted (it runs on your hardware) — external agents are not.

<details>
<summary><strong>Design Decision — Why an in-process gatekeeper instead of OPA or an external policy engine?</strong></summary>
<br>

Open Policy Agent (OPA) is the industry standard for policy-as-code. It's powerful, flexible, and well-tested. But it's also: (1) a separate process to deploy and manage, (2) a network hop for every policy check (latency on every vault query), (3) a Rego policy language that most developers don't know, and (4) overkill for Dina's current policy model.

Dina's gatekeeper rules are **hardcoded in Go** because the rules are few, critical, and rarely change: brain can't sign, untrusted can't read, money needs highest trust, risky actions are flagged. These aren't configurable policies — they're security invariants. Putting them in Go means they're type-checked, compiled, and tested alongside the code they protect. If/when Dina needs user-configurable policies (custom sharing rules, per-agent allowlists), OPA or a similar engine could be added as an adapter behind the existing `port.Gatekeeper` interface — the service layer wouldn't change.

</details>

---

## Act IV: Persona Lifecycle — Lock, Unlock, and the Ticking Clock

Personas are Dina's compartmentalization mechanism. "personal" and "health" and "financial" each have their own encrypted vault, their own access rules, their own TTL.

### Creating a Persona

`POST /v1/personas` hits `PersonaHandler.HandleCreatePersona` (`core/internal/handler/persona.go`). The handler:
1. Requires a non-empty name, a **passphrase** (empty passphrase returns 400), and an optional **tier** (`default`, `standard`, `sensitive`, or `locked` — invalid tiers return 400).
2. Generates a 16-byte random salt, hashes the passphrase with Argon2id (`auth.HashPassphrase`).
3. Calls `personaMgr.Create()` with the name, tier, and hash. Inside the persona manager, two guards fire: the **duplicate check** (existing persona with same name → 409) and the **orphan guard** (a vault `.sqlite` file already exists for this persona name → 409, prevents accidentally reusing a DEK from a previous install). The persona's initial lock state depends on the tier — only `locked`-tier personas start locked; `default`, `standard`, and `sensitive` tiers start unlocked. DEK version is initialized to `1`.
4. After creation, the handler **auto-opens the vault** for `default` and `standard` tiers — it derives a DEK from the master seed and calls `vaultMgr.Open()` so the persona is immediately usable without an explicit unlock call. `Locked` tiers require explicit manual unlock. `Sensitive` personas are auto-opened on demand (see below).

<details>
<summary><strong>Design Decision — Why Argon2id instead of bcrypt or scrypt?</strong></summary>
<br>

All three are memory-hard password hashing algorithms designed to resist GPU/ASIC brute force. Argon2id was chosen because:

1. **It won the Password Hashing Competition (2015).** It's the most recent, most studied algorithm of the three.
2. **Argon2id = best of both worlds.** Argon2d resists GPU attacks (data-dependent memory access). Argon2i resists side-channel attacks (data-independent access). Argon2id combines both in a two-pass hybrid.
3. **Tunable independently.** Memory cost, time cost, and parallelism are separate parameters. Bcrypt only has a "cost factor" that couples CPU and memory. Scrypt couples `N`, `r`, and `p` in non-obvious ways.
4. **OWASP recommendation.** As of 2024, OWASP recommends Argon2id with 19 MiB memory, 2 iterations, 1 thread as the minimum. Dina uses these defaults.

Bcrypt would also be fine — it's battle-tested and widely understood. But for a new system with no legacy constraints, Argon2id is the better default.

</details>

### Unlocking: The Moment of Truth

`POST /v1/persona/unlock` hits `HandleUnlockPersona` (`core/internal/handler/persona.go`). This is the critical path:

1. Parse persona name and passphrase from the request.
2. Call `personaMgr.Unlock(ctx, persona, passphrase, 3600)` — the `3600` is the TTL in seconds (1 hour).
3. Inside `PersonaManager.Unlock` (`core/internal/adapter/identity/identity.go`), the stored Argon2id hash is retrieved and verified against the provided passphrase via the `VerifyPassphrase` callback. If wrong: `ErrInvalidPassphrase`.
4. **The persona ID is canonicalized** — `Unlock` calls `canonicalPersonaID()`, which ensures the `"persona-"` prefix is present (adding it if the caller passed a raw name like `"health"` instead of `"persona-health"`). Both forms resolve to the same internal key.
5. **Hash upgrade (CRITICAL-02)** — on successful passphrase verification, if a `HashUpgrader` is configured, the passphrase hash is silently upgraded to the latest Argon2id parameters. This ensures legacy hashes are migrated to the strongest algorithm on first use. Critically, only the *authentication hash* is upgraded — `DEKVersion` is *not* bumped here, because changing the DEK without re-encrypting the vault would lock out the persona.
6. A TTL timer starts. When it expires, the `OnLock` callback fires — which closes the vault (see Act I wiring).
7. Back in the handler: the persona name is normalized (strip `"persona-"` prefix before `NewPersonaName` validation), the **DEK version** is looked up via `GetDEKVersion()` (falling back to version 1 for legacy personas that pre-date versioning), and the versioned DEK is derived from the master seed via HKDF (`DerivePersonaDEKVersioned`). Then `vaultMgr.Open()` is called with that DEK. Now the vault is decrypted and ready for reads and writes. The staging inbox is drained (`StagingInbox.DrainPending`) to flush any items that were waiting for this persona to unlock — returning a count of items moved into the vault.

<details>
<summary><strong>Design Decision — Why HKDF for persona DEK derivation instead of a random key per persona?</strong></summary>
<br>

Each persona vault needs its own Data Encryption Key (DEK). Two approaches:

- **Random DEK per persona:** Generate a random 32-byte key, encrypt it with the master key, store the wrapped DEK alongside the vault. Recovery requires the wrapped DEK file *and* the master key.
- **HKDF-derived DEK:** Derive the DEK deterministically from the master seed using HKDF with the persona name as context: `HKDF(seed, "persona:" + name) → DEK`. No wrapped key file needed. Recovery requires only the master seed.

HKDF derivation was chosen because: (1) one seed backup recovers *all* persona vaults, (2) no additional encrypted key files to manage, lose, or corrupt, (3) HKDF is a NIST-standardized (RFC 5869) key derivation function designed specifically for this use case — deriving multiple independent keys from a single master secret, and (4) the persona name is a natural, unique context label. The tradeoff: if you rename a persona, the DEK changes and the old vault can't be opened. This is by design — personas are identity compartments, not mutable labels.

</details>

### v1 Auto-Open: Sensitive Personas Without a Passphrase

The explicit unlock flow described above is the passphrase-gated path. In v1, a simpler model applies to non-locked personas: `VaultService.ensureOpen()` auto-opens the vault on demand by deriving the DEK from the master seed and calling `vaultMgr.Open()`. This is safe because `ensureAuthorized()` calls `AccessPersona()` **first** — the caller has already passed tier-based access control before `ensureOpen` runs. The running node is trusted while up; the seed is in memory.

The only tier that blocks auto-open is **locked** — the `AutoUnlockFunc` callback (wired in `main.go`) checks the persona tier and returns `ErrPersonaLocked` for locked personas. Sensitive personas auto-open for authorized requests — no passphrase prompt. The human controls access through session grants and approval flows, not by re-entering a passphrase on every request.

This auto-open behavior bridges several subsystems. The staging pipeline's `HandleResolve` uses an `EnsureVaultOpenFunc` callback that runs after `AccessPersona` succeeds, ensuring the vault file is open before `StagingInbox.Resolve` checks `isPersonaOpen`. Without this bridge, `Resolve` would mark items `pending_unlock` even though the caller was authorized — the vault file simply hadn't been opened yet.

### The Lock Timer

This is the invisible guardian. The Unlock method registers a `time.AfterFunc` callback that fires after the TTL expires (default 1 hour). When it fires, the callback acquires the `PersonaManager` mutex, sets `Locked = true`, deletes the timer from the `ttlTimers` map, and persists state. Then — critically — it releases the mutex *before* calling `OnLock`. This ordering prevents deadlocks: `OnLock` (wired in `main.go:304-317`) calls `vaultMgr.Close()`, which might acquire its own locks.

The result: the vault closes, the DEK is gone from memory, and any subsequent queries return `ErrPersonaLocked`. No stale sessions. No forgotten open vaults. The clock enforces what policy cannot.

One subtlety: if the persona is **re-unlocked** before the timer fires, the existing timer is cancelled (`timer.Stop()`, line 1547) and a fresh one starts. This means extending a session is just another unlock — no special "extend TTL" endpoint needed.

<details>
<summary><strong>Design Decision — Why TTL-based auto-lock instead of manual-only locking?</strong></summary>
<br>

If personas only locked when the user explicitly asked, they'd stay open forever in practice. Users forget. Browsers stay open. Phones stay unlocked. A 1-hour TTL means that even if the user walks away, the vault seals itself. This is the same principle behind: screen lock timeouts, SSH session timeouts, and bank session expiry. The difference is that Dina's lock is *cryptographic* — when the timer fires, the DEK is discarded from memory. It's not a UI gate that can be bypassed; the data is literally unreadable until the passphrase is re-entered and the DEK is re-derived.

</details>

### Approval Flow: Agent Access to Sensitive Personas

When an agent requests access to a **sensitive** or **standard** tier persona without an active session grant, `AccessPersona` returns `ErrApprovalRequired`. The handler catches this error and calls `RequestApproval()` on the PersonaManager — which stores the pending approval (with a **30-minute expiry**), then fires the `OnApprovalNeeded` callback (wired in two phases at `main.go:510-563`). This triggers a two-step notification:

1. **WebSocket broadcast** — the approval request (approval ID, persona, requesting DID, session ID, reason) is pushed to all connected admin UI clients via the WSHub.
2. **Brain push** — the same event is sent to Brain via `brain.Process()` as a `TaskEvent` with type `"approval_needed"`, for downstream notification delivery (Telegram, push, etc.).

Note: **locked-tier** personas don't trigger approval — they flat-deny agents with `ErrPersonaLocked`, even when the vault is unlocked. The locked tier is the nuclear option: human-only access.

Approvals are triggered from two paths: vault operations (when `VaultHandler.HandleStore` or `HandleQuery` hits `ErrApprovalRequired`) and **staging resolve** (when `StagingHandler.HandleResolve` is denied access to a target persona). In the staging case, the denial creates an approval request and marks the staging item `pending_unlock` with its classified data preserved — the raw body is cleared but the enriched item survives for later drain.

The human approves via `POST /v1/persona/approve` (with optional `scope`: `"single"` or `"session"`, defaulting to `"session"`) or denies via `POST /v1/persona/deny`. A second approve path — `POST /v1/approvals/{id}/approve` — provides ID-based approval for Telegram and admin UI workflows. Both paths call the same `completeApproval()` method, which performs three post-approval actions:

1. **Opens the vault** for the approved persona (deriving the DEK, calling `VaultManager.Open`).
2. **Drains pending staging items** — calls `StagingInbox.DrainPending` to promote all `pending_unlock` items for the approved persona into the vault. Without this, approved items would sit in `pending_unlock` until Sweep reverts them.
3. **Resumes pending reason requests** — if any LLM reasoning requests were blocked waiting for this approval, they are re-dispatched to Brain.

Until approval, the requesting agent gets a 403 Forbidden with the `approval_id` for tracking. Pending approvals are listed at `GET /v1/persona/approvals`.

HandleApprove also calls `MarkGrantOpened` to track which vaults were opened via approval. This matters because grant-opened vaults are auto-closed when the session ends or a single-use grant is consumed — unlike manually unlocked vaults, which follow their TTL timer. Single-use grants (`scope: "single"`) are consumed on first access and the vault is re-locked if no other active grants remain.

---

## Act V: Dina-to-Dina — Sending Messages Across the Wire

When you want to send a message to another Dina:

`POST /v1/msg/send` hits `MessageHandler.HandleSend` (`core/internal/handler/message.go`). The handler parses the recipient DID, validates it via `domain.NewDID()`, and calls `transportSvc.SendMessage()`.

**TransportService.SendMessage** (`core/internal/service/transport.go`) orchestrates the encryption pipeline:
1. **Egress check** (SEC-HIGH-04) — first, before any crypto work. The GatekeeperService's egress policy is enforced on the plaintext. PII-containing payloads or blocked destinations are rejected immediately.
2. Resolve the recipient's DID document from the resolver to find their public key and service endpoint.
3. Sign the plaintext message with the sender's Ed25519 key.
4. Decode the recipient's multibase-encoded Ed25519 public key and convert it to X25519 (NaCl uses Curve25519 for key exchange).
5. Encrypt with `crypto_box_seal` — each message uses a **fresh ephemeral X25519 keypair**, ensuring unique ciphertext even to the same recipient.
6. **Enqueue in the outbox** — the message (ciphertext + signature) is always queued first, before any delivery attempt. This ensures the message survives a process crash between enqueue and delivery.
7. Build the delivery payload (JSON wrapper with base64-encoded ciphertext + hex-encoded signature) and attempt immediate delivery via HTTP POST to the recipient's service endpoint. If delivery succeeds, the outbox entry is marked delivered. If delivery fails, the message stays pending for `ProcessOutbox` retry (30-second interval, exponential backoff, max 5 retries before dead-letter).

<details>
<summary><strong>Design Decision — Why Ed25519-to-X25519 conversion instead of separate key exchange keys?</strong></summary>
<br>

NaCl's `crypto_box_seal` requires X25519 (Curve25519 Diffie-Hellman) keys. Dina's identity is Ed25519. These are different key types on the same underlying curve, so there are two options:

- **Separate keys:** Generate and manage an Ed25519 signing keypair *and* an X25519 encryption keypair. DID documents would list both. Recovery needs both.
- **Conversion:** Use one Ed25519 keypair for signing, and convert it to X25519 when encryption is needed. The conversion is a well-defined, lossless mathematical operation (RFC 7748, libsodium's `crypto_sign_ed25519_pk_to_curve25519`).

Conversion was chosen because: (1) one keypair per identity instead of two — simpler key management, simpler DID documents, simpler backup, (2) the conversion is cheap (~1 microsecond) and deterministic, and (3) libsodium/NaCl explicitly supports this pattern. The security implication is that if the Ed25519 key is compromised, encryption is also compromised — but that would be true of a combined key-agreement+signing scheme anyway. The "separate keys" approach only adds value if one key can be rotated independently, which Dina's current key rotation model doesn't support.

</details>

<details>
<summary><strong>Design Decision — Why `did:plc` instead of `did:web`, `did:key`, or `did:ion`?</strong></summary>
<br>

DID methods differ in where the DID document lives:

- **`did:web`** — DID document hosted at a URL. Simple, but depends on DNS and web hosting. If the domain expires or the server goes down, the identity is gone. No key rotation without a new URL.
- **`did:ion`** — DID document anchored to Bitcoin's blockchain. Immutable and censorship-resistant, but slow (Bitcoin block times), expensive (transaction fees), and requires a full node or trusted resolver.
- **`did:key`** — DID document is *derived* from the public key itself. Zero infrastructure, instant resolution, self-certifying. But no key rotation — the DID *is* the key, so rotating the key means changing the DID, which means changing your identity.
- **`did:plc`** — AT Protocol's DID method. The DID is a hash of a signed "genesis operation." The DID document lives on `plc.directory` (a distributed operation log). Key rotation is a signed operation that updates the document without changing the DID.

`did:plc` was chosen because Dina uses the AT Protocol ecosystem (PDS, AppView, Jetstream) for the Trust Network. Alignment on DID method means: (1) Dina's identity is a first-class AT Protocol identity — it can publish and receive AT Protocol records natively, (2) key rotation is supported — if a signing key is compromised, the recovery key (secp256k1, derived at `m/9999'/2'/0'`) can rotate to a new signing key without changing the DID, and (3) the PLC operation log provides an auditable history of key changes.

Core supports two modes: when `DINA_PDS_URL` is set, DIDs are registered on the real PLC directory via PDS (`CreateAccountAndDID`). In local-only mode (no PDS configured), Core derives a `did:plc:`-formatted identifier locally from a SHA-256 hash of the public key (`core/internal/adapter/identity/identity.go:260-264`) — same format, same validation rules, but no PLC directory registration. This means a Home Node works offline and can later register with PLC when PDS is configured.

</details>

The receiving side is the ingress pipeline from Act II — the same `POST /msg` endpoint, the same three valves, the same trust-based filtering.

---

## Act VI: The Egress Guardian — Nothing Leaves Without Permission

When data needs to leave the Home Node — to an external API, to another agent, to any destination — it must pass through egress control.

**Gatekeeper.CheckEgress** (`core/internal/adapter/gatekeeper/gatekeeper.go`) checks:
1. **Blocked destinations** — A hardcoded blocklist of known trackers. Instant denial.
2. **PII detection** — Five regex patterns scan the outbound data for email addresses, SSNs, credit card numbers, phone numbers, and IP addresses. If any match: denied. Raw data never leaves the Home Node.
3. **Default allow** — Non-blocked destinations with clean (PII-free) data are allowed. The code also maintains a `trustedDestinations` allowlist for future use when the default policy tightens to deny-by-default.

<details>
<summary><strong>Design Decision — Why default-deny egress instead of default-allow?</strong></summary>
<br>

Most systems default to allowing outbound traffic and block specific bad destinations (a blocklist/denylist approach). Dina inverts this for the sharing policy layer: no policy for a contact means **all categories blocked**. The reasoning:

1. **Privacy by default.** A new contact or a newly added agent gets zero data access until the user explicitly grants it. This is GDPR-aligned: data processing requires explicit consent.
2. **Fail-safe behavior.** If a policy is misconfigured, deleted, or corrupted, the system falls back to "share nothing" rather than "share everything." The blast radius of a bug is zero data exposure, not total exposure.
3. **Audit trail.** Every allowed egress creates an audit entry with the tier, category, and reason. Denied egress also creates an audit entry. The user can review exactly what was shared and what was blocked.

The tradeoff: the user must explicitly configure sharing policies for every contact. This is intentional friction — Dina is designed to make data sharing a conscious decision, not an accidental default.

</details>

For per-contact granularity, the **SharingPolicyManager** (`core/internal/adapter/gatekeeper/gatekeeper.go`) provides tiered data sharing:
- Default deny: no policy for a contact means all categories blocked — `GetPolicy` returns an empty `Categories` map, and `FilterEgress` denies every category not explicitly in the map.
- Six tiers: `"none"` — blocked. `"summary"`, `"eta_only"`, `"free_busy"` — the contact sees the summary-level payload. `"full"`, `"exact_location"` — the contact sees the full-detail payload. Each `TieredPayload` carries both a `Summary` and `Full` field; the tier selects which one the recipient receives.
- The `FilterEgress` method takes a payload with multiple categories and applies the tier for each, producing an audit trail of what was allowed and what was denied. `SetPolicy` uses PATCH semantics — it merges new category tiers into the existing policy rather than replacing it.

---

## Act VII: Device Pairing — Adding a Second Screen

When you want to connect your phone to your Dina:

1. `POST /v1/pair/initiate` generates a 6-digit pairing code (valid for 5 minutes). The response is `{code, expires_in: 300}` — the code itself is the session identifier. Underneath, `GenerateCode()` creates a 32-byte cryptographic secret, derives the 6-digit code from `SHA256(secret)` truncated to the range 100000–999999. SEC-MED-13: a hard cap of 100 pending codes prevents DoS via code exhaustion.
2. The device (CLI, phone) sends `POST /v1/pair/complete` with the code and its Ed25519 public key (`public_key_multibase`). The handler requires the public key — requests without it are rejected with 400.
3. `DeviceService.CompletePairingWithKey` decodes the multibase key (z-prefix base58btc → strip 2-byte `0xed01` multicodec header → 32-byte Ed25519 public key), registers it with the auth validator via `keyRegistrar.RegisterDeviceKey()`, and records the device in the device registry. No client token is generated — authentication is purely via Ed25519 signatures.
4. The device now authenticates via `X-DID` + `X-Signature` + `X-Timestamp` + `X-Nonce` headers — no bearer token, no shared secret.
5. If the device is revoked (`DELETE /v1/devices/{id}`), `DeviceService.RevokeDevice` calls `keyRegistrar.RevokeDeviceKey()` to remove the Ed25519 public key. It also calls `tokenRevoker.RevokeClientTokenByDevice()` if any bearer tokens were associated with the device — belt and suspenders for mixed-auth devices.

<details>
<summary><strong>Design Decision — Why QR-code pairing with a 6-digit code instead of OAuth or password entry?</strong></summary>
<br>

OAuth requires a third-party identity provider (Google, Apple, etc.) — the opposite of self-sovereign identity. Password entry on a phone keyboard is slow and error-prone. QR-code pairing with a short numeric code follows the pattern established by Signal, WhatsApp Web, and Apple TV:

1. **Physical proximity required.** You must be able to see the QR code on the primary device. This prevents remote pairing attacks.
2. **Short-lived session.** The 5-minute expiry means a photographed QR code becomes useless quickly.
3. **Human-verifiable.** The 6-digit code is short enough to read and confirm, providing a secondary verification channel.
4. **No shared secret.** The pairing flow generates a fresh Ed25519 keypair on the device and registers the public key with the core. The private key never leaves the device. There's no password to steal, no token to intercept during pairing.

After pairing, the device authenticates via Ed25519 signatures on every request — the strongest auth method available, with no bearer token at rest.

</details>

---

## Act VIII: The Connector Pipeline — From Ingestion to Vault

External connectors (OpenClaw for Gmail, Calendar, etc.) push raw data into Dina. But raw data can't go directly into the vault — it needs classification, PII scrubbing, and persona routing. The **staging pipeline** is the airlock between the outside world and the encrypted vault.

### The Staging Inbox

The StagingHandler (`core/internal/handler/staging.go`, routes at lines 909-913) exposes four endpoints:

```
Connector (OpenClaw)                Brain (Classifier)              Core (Vault)
     │                                    │                             │
     ├─ POST /v1/staging/ingest ─────────►│                             │
     │   raw email, calendar event        │                             │
     │                                    │                             │
     │                     POST /v1/staging/claim ◄─────────────────────┤
     │                       lease N items for classification           │
     │                                    │                             │
     │                     POST /v1/staging/resolve ───────────────────►│
     │                       classified item → vault persona(s)         │
     │                                    │                             │
     │                     POST /v1/staging/fail ──────────────────────►│
     │                       mark classification failed                 │
```

**Ingest** accepts raw items from connectors. Each item gets a unique ID and enters the staging table with status `pending`. The connector authenticates via its own Ed25519 service key (registered at install time, same as Brain).

**Claim** is Brain's polling endpoint. Brain calls `POST /v1/staging/claim` with a `limit` (default 10) and receives up to that many items locked with a lease. The lease prevents double-processing — if Brain crashes mid-classification, the lease expires and the item becomes claimable again. A background sweep goroutine (lines 849-858) runs every 5 minutes to expire stale leases and clean up old items.

**Resolve** is the critical moment. Brain has classified the item — determined which persona(s) it belongs to, extracted metadata, scrubbed PII. It sends back the classified item with one or more target personas. The staging handler supports both single-target (`TargetPersona + ClassifiedItem`) and multi-target (`Targets` array) resolution — a single email might need to land in both "personal" and "work" personas.

HandleResolve enforces **session-scoped access control** before writing to the vault. Brain's staging processor forwards `X-Session` and `X-Agent-DID` headers on the resolve call — these flow through Core's auth middleware into the request context. For each target persona, HandleResolve calls `AccessPersona`, which checks session grants, tier rules, and agent identity. The behavior differs by cardinality:

- **Single-target:** If `AccessPersona` denies the target, HandleResolve aborts immediately — it creates an approval request (via `RequestApproval`) and marks the staging item `pending_unlock` with the classified data preserved (via `MarkPendingApproval`). The response is 403 with the `approval_id`.
- **Multi-target:** HandleResolve partitions targets into accessible and denied sets. Accessible targets resolve immediately through `ResolveMulti`. Denied targets each get an approval request and a pending staging copy (via `CreatePendingCopy` with a deterministic ID `{staging_id}-{persona}`). If all targets are denied, the original staging row is marked `pending_unlock` for the first denied target and the response is 403.

After access checks pass, HandleResolve calls `EnsureVaultOpen` to auto-open the vault file before `StagingInbox.Resolve` checks `isPersonaOpen`. This bridges the v1 auto-open model with the staging pipeline — without it, authorized requests would hit `pending_unlock` because the vault file wasn't open yet.

The StagingInbox port interface includes two methods that support this access-denied path: `MarkPendingApproval` marks an existing staging item as `pending_unlock` with its classified data and target persona preserved so `DrainPending` can store it after approval. `CreatePendingCopy` creates a new staging row in `pending_unlock` state for multi-target resolves where individual targets are denied — the accessible targets go through `ResolveMulti` on the original row, while denied targets get their own pending rows for later drain.

**Fail** marks an item as classification-failed. This is an explicit acknowledgment, not a silent drop — the item remains in staging for debugging or retry.

<details>
<summary><strong>Design Decision — Why a staging inbox instead of direct vault writes from connectors?</strong></summary>
<br>

Connectors operate outside Dina's trust boundary. They fetch data from external services (Gmail, Calendar, etc.) but should not decide *where* it goes. The staging inbox creates a classification checkpoint:

1. **Persona routing.** A connector doesn't know which persona an email belongs to. Brain classifies based on content, sender, and context.
2. **PII scrubbing.** Raw emails contain addresses, phone numbers, and names. Brain's PII scrubber runs before the data enters the encrypted vault — ensuring PII lives in metadata, not in searchable text.
3. **Lease-based reliability.** If Brain crashes, unprocessed items remain in staging. No data loss, no connector retry needed.
4. **Multi-persona fan-out.** A single ingested item might belong to multiple personas. The resolve endpoint handles this atomically.
5. **Least privilege.** The connector can only write to staging — it cannot read the vault, cannot query other personas, cannot access the DEK.

The alternative — letting connectors write directly to vault personas — would require connectors to know about persona routing, PII rules, and classification logic. That violates the Thin Agent principle: connectors fetch, Core stores, Brain reasons.

</details>

### The Remember Endpoint

`POST /api/v1/remember` is the user-facing wrapper around the staging pipeline (`core/internal/handler/remember.go`). When a user says "remember this" via Telegram, CLI, or the admin UI, the request hits `RememberHandler.HandleRemember`, which orchestrates three steps:

1. **Ingest** — Builds a staging ingest request body (type `"note"`, with session and category merged into metadata) and delegates to `StagingHandler.HandleIngest` internally. The session name is injected into the request context and forwarded as an `X-Session` header, enabling session-scoped access control when Brain later calls resolve.
2. **Brain drain** — HandleIngest already triggers an immediate Brain drain (staging_drain event), so Brain picks up the item, classifies it, and calls resolve.
3. **Completion polling** — Polls `StagingInbox.GetStatus` every 500ms for up to 15 seconds, waiting for the item to reach a terminal state.

The response maps staging statuses to user-friendly semantics: `stored` returns 200 with "Memory stored successfully." `pending_unlock` is returned as `needs_approval` (202 Accepted) with a message explaining that the item was classified into a sensitive persona and requires approval. `classifying` maps to `processing`. A companion `GET /api/v1/remember/{id}` endpoint allows polling for status after the initial request returns.

---

## Act IX: Silence First — Notifications, Reminders, and the Daily Briefing

Law 1 says: *Never push content. Only speak when the human asked, or when silence would cause harm.* Core enforces this at the notification layer.

### The Three-Tier Priority System

The NotifyHandler (`core/internal/handler/notify.go`, route at line 983) accepts notifications from Brain and classifies them into three tiers:

| Tier | Name | Behavior | Example |
|------|------|----------|---------|
| 1 | **Fiduciary** | Interrupt immediately — silence causes harm | Security alert, estate activation, payment deadline |
| 2 | **Solicited** | Notify when convenient — user explicitly asked | Search results, scheduled reminders |
| 3 | **Engagement** | Queue for daily briefing — silence merely misses an opportunity | News digest, social updates, promotional content |

The handler validates that every notification has an explicit priority — notifications without priority are rejected (there is no "default" tier). This forces Brain to make a conscious classification decision for every piece of information it wants to surface.

**Fiduciary** notifications bypass Do Not Disturb (DND) and rate limits — safety-critical messages must reach the user. **Solicited** notifications respect DND — when DND is active, Core returns a `"deferred"` status instead of broadcasting. Important: Core does *not* persist deferred notifications — it signals the deferral back to Brain, which is responsible for retrying when DND lifts. **Engagement** notifications are never pushed via WebSocket — Core returns `"queued"` immediately and the notification is accumulated for the daily briefing.

The handler also supports **rate limiting** — a configurable max-notifications-per-window that prevents flooding connected clients. Fiduciary notifications are explicitly exempt (line 118: `req.Priority != "fiduciary"`). In the current `main.go` wiring (line 865), neither the `DNDChecker` nor `RateLimit` are set — DND is inactive and rate limiting is disabled. Both are ready to wire when the DND adapter and production rate policy are implemented.

The `ForcePush` field in the notification payload is deliberately decoded but **ignored**. Brain cannot bypass priority routing — even a compromised Brain sidecar can't force engagement-tier content to interrupt the user. The priority tier is the law, enforced by Core.

<details>
<summary><strong>Design Decision — Why enforce Silence First in Core instead of Brain?</strong></summary>
<br>

Brain is an untrusted tenant (see the Sidecar Pattern in Act I). If silence enforcement lived in Brain, a compromised or misbehaving Brain could push engagement-tier content as if it were fiduciary. By enforcing the three-tier system in Core — the component that holds the keys and controls the WebSocket — the notification policy becomes a security boundary, not a suggestion.

The tradeoff: Core doesn't understand *why* a notification is fiduciary (it doesn't read content). Brain makes the classification. But Core enforces the routing rules. A misbehaving Brain that classifies everything as "fiduciary" would bypass rate limiting (fiduciary is exempt), but the volume would be visible in the daily briefing statistics and audit trail — an operational signal that something is wrong.

</details>

### Reminders: Deterministic Triggers, LLM-Free

The ReminderHandler (`core/internal/handler/reminder.go`, routes at lines 986-987) stores and fires reminders. Two endpoints:

- `POST /v1/reminder` — stores a new reminder. Accepts: `trigger_at` (Unix timestamp, required), `kind` (semantic type like `payment_due`, `appointment`, `birthday`), `type` (recurrence rule), `message`, `metadata` (JSON blob), `timezone`, and optional source lineage (`source_item_id`, `source`, `persona`). At least one of `type` or `kind` must be set. After storing, the handler calls `Loop.Wake()` to interrupt the sleep loop — ensuring a newly added reminder that fires sooner than the current next-pending is picked up immediately.
- `GET /v1/reminders/pending` — lists all unfired reminders.

The background ReminderLoop (`core/internal/reminder/loop.go`, started at line 589) runs as a goroutine:

1. Query the next pending reminder from the scheduler. On error, back off for 10 seconds before retrying.
2. If none exists, sleep until woken by a `Wake()` signal or a 60-second fallback poll.
3. If a reminder is pending, sleep until its trigger time — or until woken by a `Wake()` signal (a new, earlier reminder may have been added). Missed reminders (trigger time in the past — e.g., after a restart) fire immediately.
4. On fire: mark the reminder as fired (atomically, before the callback — prevents infinite re-fire on callback failure), then invoke the `onReminderFire` callback.

The callback (wired at lines 569-586) sends a `reminder_fired` event to Brain with the full reminder context — ID, type, kind, message, metadata, source item ID, source, and persona. Brain then composes a contextual notification: it queries the vault for related items (e.g., for a license renewal reminder, it fetches address, insurance provider, nearby offices) and assembles a helpful nudge.

No cron library. No LLM in the trigger loop. The reminder fires deterministically at the scheduled time. Brain adds intelligence only in the response — what to say, not when to say it.

---

## Act X: The Trust Network — Verified Truth at the Ingress Gate

Law 2 says: *Rank by trust, not by ad spend.* Core implements this through a local trust cache that feeds into the ingress gatekeeper.

### The Trust Cache

The TrustCache (`core/internal/adapter/trust/cache.go`) is a dual-layer store: an in-memory map for microsecond lookups (used on every incoming D2D message) backed by persistence in the identity SQLite database (survives restarts). Each entry holds:

- **DID** — the entity's decentralized identifier
- **DisplayName** — human-readable label
- **TrustScore** — a float between 0.0 and 1.0, derived from identity anchors, transaction history, outcome data, peer attestations, and time
- **TrustRing** — 1 (Unverified), 2 (Verified via ZKP), or 3 (Verified + Actioned — proven history)
- **Relationship** — `"contact"`, `"frequent"`, `"1-hop"`, `"2-hop"`, or `"unknown"` (graph distance from the user)
- **Source** — `"manual"` (user-managed) or `"appview_sync"` (pulled from the Trust Network)
- **LastVerifiedAt** / **UpdatedAt** — Unix timestamps for freshness tracking

Lookups return a *copy* of the entry (not a pointer) to prevent data races on the hot path. If the SQLite migration fails on startup, the cache degrades gracefully to in-memory only — no crash, just a log warning. The `Stats()` method reads `trust_sync_last` from the `kv_store` table to report the most recent AppView sync timestamp.

### The Trust Resolver

The TrustResolver (`core/internal/adapter/trust/resolver.go`) fetches profiles and neighborhood graphs from AppView's XRPC endpoints:

- `GET /xrpc/com.dina.trust.getProfile?did={did}` — single entity profile (used by two methods: `ResolveProfile` returns a structured `TrustEntry`, `ResolveFullProfile` returns raw JSON for Brain reasoning)
- `GET /xrpc/com.dina.trust.getGraph?did={did}&depth={hops}&limit={limit}` — trust graph neighborhood

Response size is capped (64KB per profile, 512KB for graphs) to prevent OOM attacks. The two profile methods have deliberately different error semantics: `ResolveProfile` and `ResolveNeighborhood` return nil (not an error) when AppView is unreachable — the trust cache and sync cycle degrade gracefully. `ResolveFullProfile` returns distinct errors (`ErrAppViewNotConfigured`, upstream failure, or nil for 404) so the TrustHandler can map them to proper HTTP status codes (503, 502, 404 respectively). When `baseURL` is empty (AppView not configured), all methods short-circuit immediately.

### The Ingress Decision

The TrustService (`core/internal/service/trust.go`) orchestrates the decision on every inbound message. The `EvaluateIngress(senderDID)` method runs on the hot path — it must be fast. The authority hierarchy:

1. **Contact directory** (highest authority) — if the sender is in the user's contact list as "blocked", drop. If "trusted" or "verified", accept. Manual contacts always override cache.
2. **Trust cache** — if the sender has a cached score ≥ 0.3, accept. Below 0.3, quarantine.
3. **Unknown** — sender not in contacts or cache. Quarantine (never drop unknowns — they might be legitimate first-time contacts).

A background goroutine (line 777-786) syncs the trust neighborhood from AppView every hour, removing stale entries older than 7 days. The admin can trigger manual sync via `POST /v1/trust/sync`.

The TrustHandler (`core/internal/handler/trust.go`, routes at lines 967-971) exposes the trust subsystem to the admin UI and Brain:

- `GET /v1/trust/cache` — list all cached entries (admin dashboard)
- `GET /v1/trust/stats` — cache statistics (entry count, last sync time)
- `GET /v1/trust/resolve?did={did}` — fetch full trust profile from AppView (for Brain reasoning)
- `POST /v1/trust/sync` — trigger immediate neighborhood sync

---

## Act XI: Portability and the Admin Socket

### Export/Import: Moving to a New Machine

The ExportHandler (`core/internal/handler/export.go`, routes at lines 998-1000) and MigrationService (`core/internal/service/migration.go`) enable full Home Node migration.

**Export** (`POST /v1/export`) creates an encrypted portable archive:
1. Verify all user personas are closed (excluding the identity database). This prevents exporting a vault that's being mutated.
2. Checkpoint the identity SQLite WAL — since identity is always open in WAL mode, recent writes may be in the `-wal` file, not the main database.
3. Collect identity.sqlite, all persona `.sqlite` files, and optionally `config.json` (gatekeeper tiers, settings). Generate per-file SHA-256 checksums.
4. Encrypt with AES-256-GCM + Argon2id(passphrase, random 16-byte salt, time=3, mem=128MB, threads=4, keylen=32).
5. Write to a `.dina` archive file: `DINA_ARCHIVE_V2\n` header + salt + nonce + ciphertext.

**Import** (`POST /v1/import`) restores an archive:
1. Verify all user personas are closed (same as export — prevents conflicts during restore). Check archive compatibility (`DINA_ARCHIVE_V2` header). Verify archive integrity (decrypt + AEAD authentication). Run pre-flight validation (checksums, path safety, identity.sqlite presence) — all *before* closing the identity database, so failures leave the system non-degraded. Accepts an optional `force` flag to overwrite existing data.
2. Close the identity database (it runs in WAL mode and must be released before overwrite).
3. Decrypt and extract files to the vault directory in a flat layout (all files directly in vaultPath). For SQLite files, stale `-wal` and `-shm` journal files are removed before overwriting to prevent corruption.
4. Path traversal protection in four layers: reject absolute paths → reject `..` components → reject directory separators (flat vault layout only) → verify resolved path stays within vault root.
5. Return result with `RequiresRepair` (devices must be re-paired) and `RequiresRestart` (identity DB was closed; process must restart).

The handler applies defense-in-depth path validation via `validateExportPath()` — even the `dest_path` parameter is confined to a base directory (default `/tmp/dina-exports`). No directory escape, no symlink following.

<details>
<summary><strong>Design Decision — Why application-level encrypted archives instead of volume snapshots?</strong></summary>
<br>

Docker volume snapshots or filesystem-level backups would be simpler. But they export *everything* — including stale WAL files, temp files, and potentially cleartext data in OS caches. The `.dina` archive format gives us: (1) **selective export** — only vault files, not container artifacts, (2) **independent encryption** — the archive password is separate from the vault password, useful for cold storage, (3) **portability** — the archive moves between Linux, macOS, Docker, and bare metal without filesystem format concerns, (4) **integrity** — per-file SHA-256 checksums catch corruption, and (5) **versioned format** — the `DINA_ARCHIVE_V2` header enables future format evolution without breaking older archives.

</details>

### The Admin Unix Socket

Core listens on a second server — a Unix domain socket at `/data/run/admin.sock` (lines 1102-1150, default path configurable via `DINA_ADMIN_SOCKET`). This powers the `dina-admin` CLI tool.

The socket uses the same `http.ServeMux` router as the TCP server, but with a different middleware chain: Auth and Authz are replaced by `SocketAdminAuth` (which pre-authenticates every request as `token_kind=client`, `agent_did=socket-local`, `token_scope=admin`), and CORS is dropped (not meaningful for Unix sockets). The remaining layers — BodyLimit, Recovery, Logging, RateLimit, Timeout — are the same as the TCP chain. The reasoning: **socket access = admin auth**. The real trust boundary is `docker exec` access to the container — whoever can exec in can reach the socket. No CLIENT_TOKEN is needed.

The socket is `0600` permissions, cleaned up on shutdown (`os.Remove`), and stale socket files from previous runs are removed at startup before `net.Listen`. The parent directory is created with `0750` if it doesn't exist. The `dina-admin` host-side wrapper script (`./dina-admin`) forwards commands via `docker compose exec -T core dina-admin`, where the Python admin CLI (`admin-cli/`) communicates via `httpx.HTTPTransport(uds=socket_path)`.

### The Audit Trail

The AuditHandler (`core/internal/handler/audit.go`, routes at lines 928-930) provides an **append-only** audit log:

- `POST /v1/audit/append` — write an entry (action, persona, requester, query_type, reason, metadata)
- `GET /v1/audit/query` — query with filters (action, persona, requester, time range), default 50 results, capped at 200

Every gatekeeper decision, persona access, and data sharing event is recorded. Each entry includes a `prev_hash` field — a hash chain linking each entry to its predecessor, providing tamper-evident integrity. The user can inspect exactly who accessed what, when, and why.

### Agent Sessions and the Reason Proxy

The SessionHandler (`core/internal/handler/session.go`, routes at lines 944-946) tracks agent execution context:

- `POST /v1/session/start` — create a named session (requires `name` in body)
- `POST /v1/session/end` — close a named session
- `GET /v1/sessions` — list active sessions for the calling agent

Sessions scope vault access and approval history. They are isolated per agent DID — every handler extracts the agent's DID from the request context and passes it to the session manager, so agent A cannot see or end agent B's sessions.

The ReasonHandler (`core/internal/handler/reason.go`, route at line 992) proxies LLM reasoning requests from agents through Core to Brain. This is necessary because agents authenticate to Core via device keys, not to Brain directly. Core re-signs the request with its own service key. Crucially, the handler detects the caller type — admin/user callers get full Brain access via `Brain.Reason()`, while agents get scoped access via `Brain.ReasonWithContext()` with their DID and session name forwarded to Brain for audit and approval enforcement. When Brain returns an `approval_required` error (the agent tried to access a persona that requires human consent), the handler forwards it as HTTP 403 with a structured JSON body — triggering the approval UX in the CLI.

---

## Act XII: WebSocket — Real-Time Connection

`/ws` is wired inline in `main.go:1002-1031`. The implementation uses `coder/websocket` (formerly `nhooyr.io/websocket`), which provides native `context.Context` on every read/write, automatic WebSocket-level ping/pong, and graceful close with status codes. Four subsystems live in `core/internal/adapter/ws/`: WSHub, WSHandler, HeartbeatManager, and MessageBuffer.

Each WebSocket connection goes through a **four-phase lifecycle**:

1. **Upgrade** — `ws.NewUpgrader` accepts the HTTP 101 upgrade. If `AllowedOrigins` is configured, origin patterns are enforced; otherwise origin checking is enabled by default (secure by default).
2. **Auth handshake** — Ed25519-only. The HTTP upgrade request must be signed with a device key (`token_kind=client`, `token_scope=device`). The auth middleware verifies the signature before the upgrade reaches `ServeWS`. No protocol-level token handshake — unsigned upgrades are rejected with `StatusPolicyViolation`. Auth must complete within **5 seconds** (`AuthTimeoutSeconds`), after which the server sends `auth_ok` with the device name.
3. **Flush buffered messages** — If the device had buffered messages from a previous disconnect, they are replayed in FIFO order immediately after registration.
4. **Read/write pumps** — Two goroutines: `readPump` reads incoming messages and routes them through `WSHandler.HandleMessage`; `writePump` drains the outbound channel and sends application-level heartbeat pings.

**Message types:**
- `query` / `command` → routed to `wsBrainRouter`, which calls `brain.Reason()` and returns the result wrapped in a `whisper` envelope.
- `pong` → records the heartbeat response with `HeartbeatManager.RecordPong()`, resets the missed counter.
- `ack` → removes a specific message from the MessageBuffer by event ID.
- Unknown types get an error response but do **not** disconnect (extensible protocol).

**Heartbeat** — The write pump sends an application-level ping every **30 seconds** (`PingIntervalSec`) and increments the missed pong counter. After **3 consecutive missed pongs** (`MaxMissedPongCount`), the connection is dropped and the client unregistered.

**Message buffering** — If a client disconnects, `MessageBuffer` stores up to **50 messages** per device (`MaxBufferMessages`) with a **5-minute TTL** (`BufferTTLSeconds`). Oldest messages are dropped when the buffer exceeds capacity. On reconnect, buffered messages are flushed. The outbound channel on each connection holds 256 messages; `SendOutbound` is non-blocking — if the channel is full, the message is dropped (back-pressure).

<details>
<summary><strong>Design Decision — Why WebSocket instead of Server-Sent Events (SSE) or long-polling?</strong></summary>
<br>

Dina's real-time channel carries **bidirectional** traffic: the client sends queries to the brain, and the server pushes notifications (vault updates, incoming D2D messages, gatekeeper alerts, approval requests) to the client.

- **SSE** is server-to-client only. Client-to-server would still need regular HTTP requests — two channels instead of one, with synchronization complexity.
- **Long-polling** works but wastes connections and has higher latency. Each "push" requires a new HTTP request/response cycle.
- **WebSocket** gives full-duplex communication over a single TCP connection. The auth handshake, ping/pong heartbeat, and message buffering are standard WebSocket patterns.

The Hub pattern (register/unregister/broadcast/send) follows the classic chat-server architecture — the simplest correct implementation of connection management. `coder/websocket` was chosen over Gorilla WebSocket because it provides native `context.Context` integration (matching Core's port interfaces), automatic WebSocket-level ping/pong management, and is actively maintained.

</details>

---

## Act XIII: The Health Probes

Two endpoints are always public (no auth required), returning JSON responses:

**`/healthz`** — Liveness (`core/internal/handler/health.go`). Returns `{"status":"ok"}` (200) if the process is alive. The current implementation always succeeds — if this endpoint doesn't respond, the process has crashed.

**`/readyz`** — Readiness (`core/cmd/dina-core/main.go:591-606`). Three real checks via a `DynamicHealthChecker`:
1. Service key must be initialized (DID is non-empty).
2. Vault path must exist on disk.
3. Brain sidecar must be reachable (HTTP health check via the BrainClient).

Returns `{"status":"ready"}` (200) on success, or `{"status":"not ready"}` (503) with a `slog.Warn` if any check fails. The load balancer stops routing traffic to a 503 instance.

The AT Protocol discovery endpoint `GET /.well-known/atproto-did` (line 891) returns the node's root DID as plain text — enabling PDS identity resolution per the AT Protocol spec. The handler calls `DID.Create()` which returns the existing DID if already created (SEC-MED-14: `ErrDIDAlreadyExists` is expected after first run and handled gracefully).

<details>
<summary><strong>Design Decision — Why separate liveness and readiness probes?</strong></summary>
<br>

This follows the Kubernetes health check convention, but it matters even outside Kubernetes:

- **Liveness** (`/healthz`) answers: "Is the process alive?" If this fails, the process should be restarted. It always returns 200 — if it doesn't, the process has crashed.
- **Readiness** (`/readyz`) answers: "Can this instance serve traffic?" This might fail even when the process is alive — the brain sidecar might be restarting, the vault path might be on an unmounted volume, the config might be incomplete.

The distinction prevents premature restarts. If readiness fails but liveness passes, the orchestrator stops routing traffic but doesn't kill the process — giving the brain sidecar time to restart, the volume time to mount, or the operator time to fix the config. Killing a healthy process just because a dependency is temporarily unavailable would cascade failures.

</details>

---

## Act XIV: The Fourteen Stories — Proving the Architecture

The user story tests (`tests/system/user_stories/`) run against a real multi-node stack: 2 Go Core instances, 2 Python Brain sidecars, PLC directory, PDS, Jetstream, AppView, Postgres — zero mocks. Each story proves a capability that depends on core's architecture.

### Story 01: The Purchase Journey (13 tests)

**What it proves:** Trust-weighted purchase advice where verified reviewers outrank unverified ones — no ad spend involved.

Five Dinas are created with cryptographic DIDs. Three (Alice, Bob, Diana) are Ring 2 — verified via mutual DID attestations published as AT Protocol records through PDS (`com.atproto.repo.createRecord`): Alice ↔ Bob mutual vouch, Alice → Diana vouch. Two (Charlie, Eve) remain Ring 1 — unverified, no trust edges. All five publish product reviews through PDS, which flow through Jetstream into AppView's Postgres.

**Core's role:**
- **Vault** stores Alonso's personal context across 4 personas (health, work, finance, family) — each an encrypted SQLCipher compartment.
- **Trust resolver** (`/v1/trust/resolve`) proxies to AppView, returning trust profiles that brain uses for weighted ranking.
- **Identity** provides the Ed25519 DIDs that anchor every vouch and attestation.

The brain combines vault context (back pain → needs lumbar support, ₹10-20K budget, WFH schedule) with trust-weighted reviews (3 verified negatives for CheapChair, 3 verified positives for ErgoMax) to produce personalized advice. Core doesn't reason — it provides the trusted data.

### Story 02: The Sancho Moment (7 tests)

**What it proves:** Dina-to-Dina encrypted communication triggers a contextual nudge — "Sancho is 15 minutes away. Ask about his sick mother. Make cardamom tea."

Sancho's Dina sends a `dina/social/arrival` message via `POST /v1/msg/send`. Sancho's Core encrypts with NaCl sealed box, signs with Ed25519, and delivers to Alonso's Core at `POST /msg`. Alonso's ingress pipeline handles the rest:

1. **IP rate limiter** (`Router.Ingest`, Valve 1) checks the sender IP isn't flooding.
2. **Payload size** check rejects oversized envelopes before they touch disk.
3. **Vault state fork** — the `general` persona is checked. If unlocked (the normal case), the fast path fires:
4. **NaCl sealed box** decrypts the payload using Alonso's X25519 key (derived from Ed25519 via `ProcessInbound`).
5. **Ed25519 signature** verifies Sancho's DID — cryptographic proof of origin.
6. **Per-DID rate limit** (SEC-MED-12) and **trust filter** (`EvaluateIngress`) check the sender against the contact directory and trust cache.
7. **Inbox** stores the decrypted message for retrieval.

If the vault were locked at reception time, the blob would go to the **dead drop** instead (see Act II), and the Sweeper would decrypt it later after unlock.

Brain then processes the DIDComm event (via `/api/v1/process`), queries the vault by Sancho's DID (`/v1/vault/query`), finds relationship notes ("his mother had a fall", "likes cardamom tea"), and assembles the nudge. The nudge follows Silence First — it's a Fiduciary interrupt because silence would cause social harm (failing to ask about a friend's sick mother).

### Story 03: The Dead Internet Filter (8 tests)

**What it proves:** Content authenticity verification via identity, not forensics — "Is this video AI-generated?" becomes "Who made it, and do we trust them?"

AppView's Postgres is seeded with two creator profiles:
- **Elena** (Ring 3): trust_score 0.95, 200 attestations, 15 peer vouches, 2-year history.
- **BotFarm** (Ring 1): trust_score 0.0, 0 attestations, 3-day-old account.

Core's trust resolver (`/v1/trust/resolve?did={did}`) fetches these profiles from AppView's XRPC endpoint (`com.dina.trust.getProfile`) and passes them through unchanged — core doesn't editorialize. Brain's LLM receives the raw trust signals and recognizes the pattern: Elena's 2-year track record with 200 attestations means "authentic, trusted creator." BotFarm's empty history means "unverified, check other sources."

**Core's role:** Identity resolution and trust data passthrough. The AppView integration uses the same XRPC pattern as AT Protocol — `com.dina.trust.getProfile` returns a standardised trust profile that any client can consume.

### Story 04: The Persona Wall (11 tests)

**What it proves:** Persona isolation as a security boundary — a shopping agent cannot read health data, even when the request is reasonable.

The health persona is created with tier `restricted`. Three medical records are stored: a spinal diagnosis ("L4-L5 disc herniation, Dr. Sharma, Apollo Hospital"), ergonomic recommendations ("chronic back pain, needs lumbar support, avoid sitting > 1 hour"), and a medication record ("Ibuprofen 400mg"). A shopping agent (consumer persona, tier `open`) asks: "Does the user have any health conditions that affect chair selection?"

Brain's guardian processes the `cross_persona_request` event with a **deterministic tier gate** — no LLM involved in the block decision. Restricted tier → automatic block. The guardian then builds a minimal disclosure proposal:

- **Withheld:** L4-L5, herniation, Dr. Sharma, Apollo, Ibuprofen (medical PII detected via Presidio NER with optional GLiNER, regex fallback)
- **Safe to share:** "chronic back pain", "needs lumbar support", "avoid prolonged standing" (general health terms that don't identify the condition)

The user reviews and approves the proposal. Brain sends the approved text and runs a final PII audit — `medical_patterns_found: [], clean: true`. An audit record is written to core's KV store.

**Core's role:**
- **Vault** enforces persona compartmentalization — health and consumer are separate encrypted databases with separate DEKs. Core has no cross-persona query API; each `POST /v1/vault/query` targets a single persona. Brain's guardian handles the cross-persona disclosure decision before querying Core for the source persona's data.
- **KV store** records the audit trail of every disclosure decision.

<details>
<summary><strong>Design Decision — Why deterministic tier gates instead of LLM-based access control?</strong></summary>
<br>

An LLM could theoretically decide whether to share data across personas. But LLMs are probabilistic — they might allow disclosure 99% of the time and leak 1% of the time. For a system that guards medical records, 1% is unacceptable. The tier gate is a boolean: restricted tier → block. Always. The LLM's job is limited to building the *proposal* (which terms are safe to share), not the *decision* (whether to share at all). The human makes the final call. This is the Deterministic Sandwich pattern: deterministic gate → LLM proposal → deterministic audit.

</details>

### Story 05: The Agent Gateway (10 tests)

**What it proves:** Guardian's deterministic intent classification — the decision tree that routes agent intents to auto_approve, flag_for_review, or deny. Also proves device pairing, persona isolation, and device revocation.

An external agent pairs with the Home Node using `dina configure` (Ed25519 keypair + 6-digit pairing code → `POST /v1/pair/complete`; note: the CLI calls only `/v1/pair/complete`, not `/v1/pair/initiate`). Core registers the agent as a device and the agent appears in `GET /v1/devices`. The agent then submits intents via `dina validate <action> <description>`, which calls Core's `POST /v1/agent/validate`. Core proxies to brain's guardian internally using `BrainClient.ProcessEvent()` — the CLI authenticates to Core via Ed25519 device auth, no shared brain secret on the client.

The guardian's classification is deterministic (no LLM):

- **SAFE** → `auto_approve`: `search`, `fetch_weather` — agent proceeds without human intervention.
- **MODERATE** → `flag_for_review`: `send_email`, `pay_upi` — human must approve before the agent acts.
- **HIGH** → `flag_for_review`: `share_data`, `transfer_money` — human must approve, higher severity.
- **BLOCKED** → `deny`: `read_vault`, `export_data`, `access_keys` — categorically denied, always.
- **Unauthenticated agent** → `401`: Core's auth middleware rejects the request before it reaches the guardian. Note: the `AgentHandler` overrides `trust_level` to `"verified"` for every device that passes auth — so the untrusted path through the guardian cannot trigger via this endpoint; unauthenticated devices are stopped at the door.

Vault isolation is verified: data stored in the health persona is invisible from the consumer persona. Finally, admin revokes the agent's device (`DELETE /v1/devices/{device_id}`), and the device is marked as `Revoked` in the device list — subsequent requests with the revoked token are rejected.

**Core's role:**
- **Device pairing** registers the agent through the same ceremony used by phones and laptops — agents are first-class devices.
- **Agent validation proxy** (`/v1/agent/validate`) — Core authenticates the device, then forwards the intent to brain's guardian via BrainClient. Brain stays non-public.
- **Auth validator** validates the agent's Ed25519 signature on every request, and revokes it immediately when the admin calls `DELETE /v1/devices/{id}`.
- **Vault** enforces persona isolation — the agent in the consumer context cannot query health data, regardless of what it asks for.

### Story 06: The License Renewal (10 tests)

**What it proves:** The Agent Safety Layer — deterministic scheduling + LLM reasoning + guardian enforcement, with PII isolated in metadata.

A license scan is ingested via brain's `/api/v1/process` (event type: `document_ingest`). Brain extracts fields (license number, expiry date, holder name) with per-field confidence scores (≥0.95 for critical fields). Core stores the result in the vault with a critical design constraint: **PII lives in encrypted metadata only, never in searchable text.** The license number `KA-01-2020-1234567` is in metadata; the summary says "driving license, expires April 2026."

Core's reminder scheduler (`/v1/reminder`) fires deterministically 30 days before expiry — no LLM involved in the trigger. When it fires, brain queries the vault for context (address, insurance provider, nearby RTO offices) and composes a notification: "Your license expires April 15. Nearest RTO is Koramangala. Your ICICI insurance covers renewal."

The delegation test is the Agent Safety Layer in action: brain generates a `DelegationRequest` for an RTO bot with `denied_fields: [license_number, holder_name, date_of_birth]`. The guardian classifies it as HIGH risk and sets `requires_approval=True`. The bot never sees PII. The human decides.

**Core's role:**
- **Vault** enforces metadata isolation — PII in encrypted metadata, general description in searchable text.
- **Reminder scheduler** provides deterministic, LLM-free triggers.
- **Gatekeeper** authorises Brain's vault queries during notification assembly (ActionVaultRead/Write at the service layer). The delegation enforcement itself — HIGH risk, flag_for_review, requires_approval — is Brain's guardian, not Core.

### Story 07: The Daily Briefing (5 tests)

**What it proves:** Silence First notification triage (Law 1) — low-priority events queue silently in the vault while fiduciary events interrupt immediately via the agent safety layer.

Three engagement-tier events arrive over the course of a simulated day: a news article shared by a friend, a social media mention, and a product price drop. None warrant interrupting the user. They're stored in the vault and queued as JSON blobs in a `briefing_queue` KV entry (`PUT /v1/vault/kv/briefing_queue`). No notification, no buzz, no WebSocket push.

Then a fiduciary event: an autonomous agent attempts `transfer_money`. This goes through `POST /v1/agent/validate` — Brain's guardian classifies it as HIGH risk → `flag_for_review`, `requires_approval=True`. The agent cannot move money without explicit human approval.

At briefing time, `GET /v1/vault/kv/briefing_queue` retrieves all three queued items as a structured summary. After delivery, the queue is cleared by overwriting with an empty list — items are never repeated.

**Core's role:** Vault KV store provides the briefing queue mechanism — low-priority items are written to a key-value slot, not pushed as notifications. The agent validation proxy (`/v1/agent/validate`) handles the fiduciary interrupt via Brain's guardian. The NotifyHandler's three-tier system (tested separately in Act IX) provides the routing rules; this story validates the end-to-end briefing workflow built on top of those primitives.

### Story 08: Move to New Machine (8 tests)

**What it proves:** Data portability and DID stability — export from one machine, import to another, and the DID remains the same.

Two Docker nodes simulate the migration: Node A (Alonso's old machine) and Node B (Sancho's, simulating a new machine). Vault items are stored on Node A and verified as queryable. Each node has a valid DID (different keypairs), and Node B can independently store and query vault data. A pure-Python SLIP-0010 derivation proves same seed → same DID: the test derives `m/9999'/0'/0'` from Alonso's known Docker test seed (`0x00...01`), computes `did:plc:<base58btc(sha256(pubkey)[:16])>`, and asserts it matches Node A's actual DID from `GET /v1/did`.

The full migration roundtrip: `POST /v1/export` with a passphrase creates an encrypted `.dina` archive (MigrationService rejects export while personas are open — safety check). The archive is transferred via `docker cp` to Node B. `POST /v1/import` restores files, reports `requires_repair=true` (devices must re-pair) and `requires_restart=true` (identity DB was closed for safe overwrite). Unlocking with the wrong seed (Sancho's) fails — proving the vault is cryptographically bound. Node B is restarted with Alonso's seed (same recovery phrase), personas unlock successfully (same DEK), `GET /v1/did` returns Alonso's DID, and vault queries return the original data. No "account migration" needed because the identity *is* the seed.

**Core's role:** MigrationService orchestrates WAL checkpointing (`vault.Checkpoint("identity")` before reading raw `.sqlite` bytes), state verification (open-persona guard, `CheckCompatibility`, `VerifyArchive`, `ValidateImport` — all run before closing identity to avoid non-degraded failures), and archive encryption via the portability adapter. The portability adapter handles the AES-256-GCM + Argon2id encryption. Path traversal protection (`validateArchiveEntry`) prevents archive extraction outside the vault root — only flat filenames are allowed, no directory separators, no `..` components.

### Story 09: Connector Expiry (5 tests)

**What it proves:** Core's independence from the Brain sidecar — vault, identity, and health endpoints function without any Brain dependency, and Brain-dependent endpoints return well-formed responses (not crashes or HTML error pages).

The test establishes a healthy baseline (both Core and Brain healthz return 200), then proves independence layer by layer. Vault store and query (`POST /v1/vault/store`, `/v1/vault/query`) work as purely Core operations — encrypted SQLCipher with FTS5 search, no Brain involvement. A Brain-dependent endpoint (`POST /v1/agent/validate`) is exercised to verify Core always returns well-formed JSON with a meaningful status code (200 if Brain is up, 502/503/504 if Brain is down — never a crash, timeout, or HTML error dump). Brain's healthz is re-checked to confirm no permanent degradation from the agent validation round-trip. Finally, `GET /v1/did` proves identity is cryptographic and has zero sidecar dependency — your Ed25519 keypair is Core-native.

Note: this test validates the *design* of independence (Core subsystems have no Brain imports), not a live-disconnection scenario. The BrainClient does include a circuit breaker (open after 5 failures, 30s cooldown) for production resilience, but that path is not exercised here.

**Core's role:** Vault operations are independent of Brain by design — Core's SQLCipher adapter handles all storage and search natively. The DID is derived from Ed25519 keys stored locally, with no sidecar dependency. The BrainClient's circuit breaker (`defaultMaxFailures=5`, `defaultCooldown=30s`) provides fail-fast behaviour in production when Brain is unreachable.

### Story 10: The Operator Journey (5 tests)

**What it proves:** Idempotent install and administrative robustness — DID persists across re-install, persona creation is idempotent, health probes are stable under repeated access, and locked personas return clear errors.

The test simulates the operations an install script performs on every run: (1) `GET /v1/did` returns the same DID across repeated requests — the Ed25519 keypair is persisted, no rotation, no new DID, no broken trust chains (verified 3 times for stability), (2) `POST /v1/personas` for an existing persona returns 200, 201, or 409 (already exists) — never a 500 or crash, (3) `/healthz` returns 200 on 5 rapid sequential calls — deterministic under repeated probing, (4) a freshly created persona that hasn't been unlocked returns 403 or 423 with "locked" in the body — an actionable error, not a crash or data leak. These are the failure modes real operators hit when re-running installs, restarting nodes, and probing health.

**Core's role:** Identity persistence via the Ed25519 keypair (derived from master seed, stored in `identity.sqlite`), persona state file persistence (`persona_state.json` at `cfg.VaultPath`, loaded on startup via `SetPersistPath`), and the orphan-guard callback (`CheckOrphanedVault`) that rejects persona creation when orphaned vault artifacts exist — preventing silent DEK reuse after state file loss.

### Thesis Invariant Stories (11-14)

These four stories validate the **Four Laws** — the non-negotiable invariants of the Dina architecture.

### Story 11: The Anti-Her

**What it proves:** Law 4 — *Never Replace a Human.* Dina detects neglected contacts (>30 days since last interaction) and nudges the user toward human connection, not toward itself.

Brain's LLM responses are filtered for anthropomorphic language ("I feel", "I care", "I'm here for you"). If detected, the response is rewritten to redirect toward human connection. The test stores relationship data in the vault, triggers a loneliness-detection event, and verifies: (1) the nudge suggests contacting a real person, not Dina, (2) no emotional dependency language appears in the output.

**Core's role:** Vault stores relationship history. Reminder scheduler triggers the check. The Anti-Her enforcement is in Brain — but the data that powers it (contact dates, relationship notes) lives in Core's encrypted vault.

### Story 12: Verified Truth

**What it proves:** Law 2 — *Rank by trust, not by ad spend.* Core's trust system produces honest uncertainty, not hallucinated confidence.

Three scenarios: (1) **Zero trust data** — Brain must express uncertainty ("I don't have enough information"), never hallucinate reviews. (2) **Sparse data** (2 conflicting attestations) — Brain reports "opinions are split." (3) **Dense data** (12 consistent attestations) — Brain makes a confident recommendation with source attribution.

**Core's role:** Trust resolver returns raw trust profiles. The test verifies source attribution survives the vault round-trip: store with `source_url` → query → the same URL appears in the response. Core preserves provenance; Brain reasons with it.

### Story 13: Silence Under Stress

**What it proves:** Law 1 — *Silence First* under adversarial conditions. Low-priority events (social updates, reminders) are classified as engagement and queued silently. A security alert from a trusted source is correctly classified as fiduciary — it interrupts. A phishing message marked "URGENT" from an unknown vendor is correctly classified as engagement (not fiduciary) and queued silently.

**Core's role:** Brain's guardian classifies each event via `/api/v1/process` — the tier decision happens in Brain. Core enforces the routing rules (NotifyHandler, tested separately in Act IX). The test verifies that social engineering ("URGENT! Your account has been compromised!") from an untrusted source does not escalate to fiduciary priority — trust context overrides urgency language.

### Story 14: The Agent Sandbox

**What it proves:** The Agent Safety Layer is a hard security boundary.

Four attack vectors: (1) **Rogue agent (no auth)** → 401 at Core's perimeter. (2) **Agent revocation** → immediate key removal; next request returns 401. (3) **Blocked actions** (`read_vault`, `export_data`, `access_keys`, `messages.send`, `sms.send`) → denied regardless of trust level, even for verified agents. (4) **Identity forgery** → agent supplies a fake `agent_did` in the request body, but Core's `AgentHandler` overrides it with the authenticated identity — the forged DID never reaches Brain's guardian.

**Core's role:** Auth middleware validates every request. DeviceService revokes keys atomically. Brain's guardian maintains the blocked-action list — actions like `read_vault` and `export_data` are categorically denied. Core's `AgentHandler` enforces identity binding by overriding caller-supplied `agent_did` and `trust_level`.

---

## Epilogue: The Architecture in One Sentence

Every request enters through eight middleware layers, reaches a handler that delegates to a service, the service composes port interfaces to orchestrate business rules (gatekeeper for access control, persona manager for compartmentalization, vault for storage, trust cache for ingress filtering, notification handler for silence enforcement), and the adapters — hidden behind port interfaces — do the actual work with Ed25519 keys, SQLCipher databases, NaCl encryption, filesystem dead drops, staging inboxes, reminder loops, and a Unix admin socket. The human holds the seed. The math enforces the loyalty. Nothing leaves without permission. Nothing speaks without cause.
