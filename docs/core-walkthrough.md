# The Dina Core: A Walk Through the Fortress

## Act I: Waking Up — The Composition Root

Core orchestrates every actor in the system.

<details>
<summary><strong>Design Decision — Why Go for the Core?</strong></summary>
<br>

Dina's core is a long-running, always-on process that manages cryptographic keys, encrypted storage, and real-time WebSocket connections. Written in Go (due to its support of Crypto). The other two components are the brain and appview. The brain sidecar handles LLM reasoning (Python is the defacto language in AI). AppView (Reputation Graph, built on AT Proto) is written in TypeScript.

</details>

<details>
<summary><strong>Design Decision — Why a single-file composition root?</strong></summary>
<br>

All dependency wiring lives in `main.go` — no dependency injection framework, no service locator, no reflection magic. Every adapter, service, and handler is constructed with explicit constructor calls and passed as arguments. This means: (1) the compiler catches missing dependencies at build time, not at runtime, (2) you can read `main.go` top-to-bottom to understand every dependency relationship in the system, and (3) there are no hidden "auto-wired" surprises. The tradeoff is a ~700-line `main.go`, but that's a feature — it's the one place where the entire system is visible.

</details>

When `dina-core` starts, the first thing it does is load configuration from environment variables (`core/cmd/dina-core/main.go:55-65`, `config.NewLoader()`). If anything is misconfigured — missing vault path, invalid listen address — the process refuses to start. There's no "run in degraded mode." The philosophy is: if the foundation is cracked, don't build the house.

Next comes the **security gauntlet** (lines 69-85). Two environment variables — `DINA_ALLOW_UNSIGNED_D2D` and `DINA_TEST_MODE` — are dangerous escape hatches meant only for development and testing. The startup code checks `DINA_ENV` and calls `log.Fatal` if someone tries to enable these in production. The process simply dies rather than run insecure.

<details>
<summary><strong>Design Decision — Why fail-fast instead of degraded mode?</strong></summary>
<br>

Many systems try to "keep running" with partial configuration — disable features, skip checks, log warnings. Dina takes the opposite stance: if the config is invalid, the process exits immediately. The reasoning is that Dina guards your cryptographic identity and private data. Running with a misconfigured gatekeeper, missing vault path, or test-mode flags in production is worse than not running at all. A crash is loud and obvious; a silently misconfigured security layer is invisible and dangerous. The load balancer will route traffic to healthy nodes; a half-configured node shouldn't be one of them.

</details>

### Bootstrapping Identity from Seed

Now the most delicate operation: **identity seed management** (lines 105-219). Dina's entire cryptographic identity derives from a single 32-byte seed. The code walks a priority chain:

1. **`DINA_IDENTITY_SEED` env var** — Direct injection (for CI/containers). If set, the hex is decoded and used immediately.

2. **AES-GCM wrapped file** (`identity_seed.wrapped`) — If `DINA_SEED_PASSWORD` is set, derive a KEK from it via SHA-256, then try to unwrap the `.wrapped` file. If the password is wrong, the process dies — it won't silently regenerate your identity.

3. **Auto-migration** — If a plaintext `.hex` file exists alongside a seed password, the code reads it, wraps it with AES-GCM, writes the `.wrapped` version, and logs the migration. The old plaintext file remains (the user decides when to delete it).

4. **Plaintext fallback** (`identity_seed.hex`) — If no password is set, loads from plaintext with a loud warning.

5. **Generate fresh** — If nothing exists at all, generates 32 random bytes, optionally wraps them, and persists.

<details>
<summary><strong>Design Decision — Why a single 32-byte seed instead of per-key generation?</strong></summary>
<br>

Every cryptographic key in Dina — the root signing key, each persona's vault DEK, future rotation keys — is *derived* from one master seed using deterministic HD (Hierarchical Deterministic) derivation. The alternative would be generating independent random keys for each purpose and storing them separately. The single-seed approach was chosen because: (1) **backup is trivial** — back up one seed (or its BIP39 mnemonic) and you can regenerate every key, (2) **recovery is possible** — Shamir's Secret Sharing splits one seed, not dozens of keys, (3) **key derivation is reproducible** — given the same seed and the same derivation path, you always get the same key, which means identity is portable across devices without key synchronization. The tradeoff is that seed compromise is total compromise — but that's also true of any root-of-trust model (HSMs, YubiKeys, iCloud Keychain). The mitigation is AES-GCM wrapping with a user-chosen password.

</details>

<details>
<summary><strong>Design Decision — Why AES-GCM wrapping instead of full-disk encryption?</strong></summary>
<br>

The seed could be protected by OS-level disk encryption (FileVault, LUKS) or a hardware enclave. AES-GCM wrapping was chosen as an *additional* layer because: (1) Dina runs on user hardware where disk encryption may or may not be enabled — we can't assume it, (2) the wrapping is **application-level** — even if the OS is compromised or the disk image is copied, the seed is still encrypted with the user's password, (3) it enables **auto-migration** — old plaintext seeds are transparently upgraded to wrapped format on next startup, and (4) the wrapped file is portable — you can move `identity_seed.wrapped` to a new machine and decrypt it with the same password. AES-256-GCM was chosen specifically because it provides both confidentiality and authenticity (if the ciphertext is tampered with, decryption fails) and is the NIST standard for symmetric authenticated encryption.

</details>

After loading, the code verifies the seed isn't all zeros (lines 201-211). Then it derives the signing key via SLIP-0010 at path `m/9999'/0'` — a deterministic HD derivation that produces the same Ed25519 keypair from the same seed every time (`core/internal/adapter/crypto/` package).

<details>
<summary><strong>Design Decision — Why SLIP-0010 HD derivation at path `m/9999'/0'`?</strong></summary>
<br>

SLIP-0010 is the Ed25519-specific variant of BIP-32 hierarchical deterministic key derivation (BIP-32 itself only works with secp256k1). The path `m/9999'/0'` uses purpose `9999'` — a custom purpose number that won't collide with Bitcoin (`44'`), Ethereum (`60'`), or any registered BIP-44 coin type. The `'` means hardened derivation, which means knowing a child public key doesn't reveal the parent. The alternative — BIP-32 with secp256k1 — would give us ECDSA keys instead of Ed25519, which are slower to verify and have a more complex signing algorithm. SLIP-0010 + Ed25519 gives us the best of both worlds: deterministic derivation and fast, simple signatures.

</details>

### Assembly Line: Bottom-Up Construction

With the seed in hand, the composition root builds **15 adapter groups** in dependency order. Think of it as assembling a car: you build the engine before attaching the wheels.

**Clock** comes first (line 90) — everything else needs to know what time it is. Then **crypto primitives** (lines 93-101): BIP39 mnemonic generator, SLIP-0010 key deriver, HKDF key deriver, Argon2 password hasher, Ed25519 signer, key converter (Ed25519 to X25519), NaCl box sealer, AES-GCM key wrapper.

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

**Vault** (line 222) — the encrypted SQLite storage. A build-tag factory (`newVaultBackend`) selects SQLCipher when CGO is available, or falls back to in-memory for testing.

<details>
<summary><strong>Design Decision — Why SQLite/SQLCipher instead of PostgreSQL or a cloud database?</strong></summary>
<br>

Dina's core principle is **absolute loyalty** — the human holds the encryption keys, and no server sees the plaintext. A cloud database (even self-hosted PostgreSQL) creates a network-accessible attack surface and requires key management for connections. SQLite with SQLCipher gives us:

1. **Zero network surface.** The database is a local file. No TCP port, no connection string, no SQL injection over the wire.
2. **Transparent encryption.** SQLCipher encrypts every database page with AES-256-CBC. The DEK is derived per-persona from the master seed — different personas have different databases with different keys. Even if the disk is imaged, each persona vault is independently encrypted.
3. **Single-file portability.** One `.db` file per persona. Backup = copy the file. Migrate = move the file. No dump/restore, no schema versioning headaches.
4. **FTS5 full-text search.** SQLite's built-in full-text search engine is surprisingly powerful — good enough for verdict recall without a separate search service.

The build-tag factory (`newVaultBackend`) is a pragmatic compromise: CGO is required for SQLCipher's C library, but some CI environments and test runners don't have CGO. The in-memory fallback means tests run everywhere, and production uses the real encrypted backend.

</details>

**PII Scrubber** (line 227) — a regex-based scanner that detects emails, SSNs, credit cards, and phone numbers before any data leaves the Home Node.

**Identity** (lines 230-251) — the DID manager, persona manager, contact directory, device registry, and recovery manager. Here's a crucial wiring moment: `personaMgr.OnLock` (lines 235-248) is a callback that fires when a persona's TTL timer expires or the user manually locks it. The callback strips the `"persona-"` prefix from the internal ID, validates it as a persona name, and calls `vaultMgr.Close()`. This is how **the vault automatically locks when the persona locks** — no data accessible without an active session.

**Auth** (lines 276-281) — the token validator. `cfg.ClientToken` is registered as scope `"admin"` — this is the bootstrap token that can do everything. Paired device tokens later get registered as scope `"device"` — they can't touch `/v1/did/sign`, `/v1/did/rotate`, `/v1/identity/mnemonic`, or `/admin/*`.

<details>
<summary><strong>Design Decision — Why two token scopes (admin vs device) instead of RBAC?</strong></summary>
<br>

A full role-based access control system (RBAC) with roles, permissions, and policy files would be overkill for Dina's two-actor model. There are exactly two kinds of callers: (1) the **bootstrap admin** — the human who set up the Home Node and knows the `DINA_CLIENT_TOKEN`, and (2) **paired devices** — phones, tablets, CLI tools that completed the QR pairing flow. Admin can do everything. Devices can do most things but cannot sign DIDs (would let a stolen phone impersonate you), rotate keys (would let a stolen phone lock you out), view the mnemonic (would let a stolen phone clone your identity), or access admin endpoints. Two scopes, two path lists, zero config files. If Dina ever needs finer-grained permissions (per-persona access for devices, time-limited scopes), the `scope` field is already a string — it can be extended without breaking the interface.

</details>

**Gatekeeper** (line 284) — the intent evaluator. We'll visit this in detail later.

**Transport** (lines 288-338) — DID resolver, outbox, inbox, and the actual message transporter. Known peers from `DINA_KNOWN_PEERS` env var are pre-loaded into the resolver with their DID documents and public keys.

**Task Queue** (lines 341-343) — in-memory task queue with a watchdog for stale tasks.

**WebSocket Hub** (lines 346-347) — connection registry and real-time notification.

**Pairing** (line 350) — QR-code-based device pairing protocol.

**Brain Client** (line 353) — HTTP client for the Python sidecar that handles LLM reasoning.

<details>
<summary><strong>Design Decision — Why a Python sidecar instead of in-process LLM?</strong></summary>
<br>

The Go core handles crypto, storage, identity, and HTTP — things that need to be fast, type-safe, and auditable. The Python brain handles LLM reasoning — calling Ollama, Gemini, or other providers, parsing structured output with PydanticAI, managing vector memory with ChromaDB. These are fundamentally different workloads:

- **Go** is better at: crypto operations, concurrent HTTP handling, low-latency API routing, and zero-dependency deployment.
- **Python** is better at: LLM library ecosystem (PydanticAI, LiteLLM, ChromaDB, Google ADK), rapid iteration on prompt engineering, and native support for ML/AI tooling.

A sidecar architecture means: (1) the core can run without the brain (health probes degrade gracefully), (2) the brain can be replaced or upgraded independently (swap Ollama for Gemini without touching the core), (3) a crash in the LLM layer doesn't take down identity or encryption, and (4) the brain communicates via a well-defined HTTP API with its own bearer token (`BRAIN_TOKEN`), creating a clear security boundary.

</details>

### Services: The Business Logic Layer

With all adapters ready, the code constructs **service objects** (lines 382-489). Services compose port interfaces — they never import adapters directly. This is the hexagonal architecture boundary.

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

The **GatekeeperService** (`gkSvc`, line 387) is created *before* the VaultService and passed into it. So every vault operation — query, store, delete — passes through the gatekeeper first. The VaultService also receives a `PersonaManager` (line 394), enabling persona-tier enforcement on every operation.

The **TransportService** (lines 396-409) gets wired with the signer, converter, resolver, outbox, inbox, and clock. Then three critical post-construction wirings: `SetDeliverer` (the actual HTTP sender), `SetVerifier` (Ed25519 signature checker), and `SetRecipientKeys` (the node's own keypair for decryption).

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

**Valve 1: IP Rate Limit** (line 45) — The RateLimiter (`core/internal/ingress/ratelimit.go`) checks whether this IP has exceeded its per-minute quota. If so, the message is rejected immediately with `ErrRateLimited`. This prevents a single sender from flooding your Home Node.

**Valve 2: Payload Size** (line 50) — The InboxManager checks whether the envelope exceeds the maximum allowed size. Oversized payloads are rejected before they touch disk.

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

**The Fork: Locked vs Unlocked** (lines 57-83)

Now the Router checks: is the default persona's vault open? This is the decisive moment.

**If locked** — the vault keys aren't available, so the blob can't be decrypted. But we don't want to lose it. First, `AllowGlobal()` checks spool capacity (Valve 2b — total spool size cap to prevent disk exhaustion). Then the blob goes into the **Dead Drop** (`core/internal/ingress/deaddrop.go`).

The Dead Drop is beautifully simple: a directory of opaque `.blob` files with random hex filenames. `Store()` writes atomically (temp file + rename) with `0600` permissions (lines 40-81). No metadata, no sender DID visible, no index — while locked, these blobs are just opaque cryptographic noise on disk.

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

**If unlocked** — the `onEnvelope` callback fires (lines 68-73). In `main.go:426-435`, this callback calls `transportSvc.ProcessInbound()` to decrypt the NaCl sealed box, verify the sender's signature, and produce a `DinaMessage`. If decryption succeeds, `StoreInbound()` adds it to the inbox. **If decryption fails** — and this is critical — the blob **falls back to the dead drop** (line 71). No silent data loss.

### The Dead Drop: Peek/Ack Semantics

The Dead Drop evolved from simple read-and-delete to a **two-phase** protocol. `Peek(name)` (lines 126-137) reads without removing. `Ack(name)` (lines 140-149) deletes after successful processing. This way, if decryption fails midway, the blob survives for the next sweep attempt.

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

After the vault is unlocked, the **Sweeper** (`core/internal/ingress/sweeper.go`) drains the dead drop. For each blob, it:

1. `Peek`s the blob (read without delete)
2. Delegates to `transport.ProcessInbound()` for decryption + signature verification (lines 111-113)
3. Checks message TTL — if the message is older than 24 hours, it's silently dropped (lines 117-122)
4. Calls `onMessage` to deliver the decrypted message
5. `Ack`s the blob (deletes from disk)

The background goroutine in `main.go:438-448` runs `ProcessPending()` every 10 seconds. It calls `sweeper.Sweep()` first (dead drop), then drains the fast-path inbox spool. Any failures during spool processing re-deposit the blob into the dead drop for another attempt.

<details>
<summary><strong>Design Decision — Why a 24-hour TTL on dead drop messages?</strong></summary>
<br>

Messages that sit in the dead drop for more than 24 hours are silently dropped during sweep. This prevents an attacker from sending thousands of messages while the vault is locked, then having them all process at once on unlock (a **thundering herd** that could overwhelm the system). It also prevents stale data from accumulating indefinitely if the user rarely unlocks a persona. The 24-hour window is generous enough that normal offline periods (sleeping, traveling) don't lose messages, but short enough that a sustained attack eventually expires. The TTL is configurable via the `Sweeper` constructor.

</details>

### The Outbox: Retry on the Other Side

Meanwhile, outbound messages have their own lifecycle. The outbox retry goroutine (lines 451-461) runs every 30 seconds, calling `transportSvc.ProcessOutbox()` to retry failed deliveries with exponential backoff.

---

## Act III: The Request Journey — From HTTP to Vault

Now let's trace what happens when a legitimate request arrives at the API.

### The Middleware Chain

Every request passes through **seven layers** before reaching a handler (lines 644-652). Think of them as concentric walls of a fortress:

<details>
<summary><strong>Design Decision — Why hand-rolled middleware instead of a framework (Gin, Echo, Fiber)?</strong></summary>
<br>

Go's `net/http` standard library is production-grade: it handles HTTP/1.1 and HTTP/2, supports graceful shutdown, and provides `http.Handler` — the universal interface that every middleware composable uses. Frameworks add routing DSLs, context helpers, and middleware chains — but Dina's routing is simple enough for `http.ServeMux`, and the middleware chain is just function composition: `cors(recovery(logging(rateLimit(auth(authz(timeout(mux)))))))`.

No framework means: (1) zero third-party dependencies in the HTTP layer (smaller attack surface), (2) no framework-specific context types leaking into business logic, (3) total control over the middleware order (which matters — CORS must be outermost, auth must come before authz, timeout must be innermost). The cognitive cost of learning "how does this framework work?" is replaced by "read the 7 wrapper functions in main.go."

</details>

1. **CORS** (`core/internal/middleware/cors.go`) — Sets `Access-Control-Allow-Origin`. When configured as `"*"`, it correctly omits `Access-Control-Allow-Credentials` per the spec.

2. **Recovery** — Catches panics, logs them, returns 500.

3. **Logging** — Structured JSON logs with request timing.

4. **Rate Limit** — Per-IP token bucket. Rejects with 429 if exceeded.

5. **Auth** (`core/internal/middleware/auth.go:64-147`) — This is where tokens are validated. Three paths:
   - **Public paths** (`/healthz`, `/readyz`, `/.well-known/atproto-did`) — skip auth entirely.
   - **NaCl ingress** (`POST /msg`) — authenticated by the sealed box itself, no token needed.
   - **Ed25519 signature auth** (lines 78-120) — The client sends `X-DID`, `X-Signature`, `X-Timestamp` headers. The middleware verifies the timestamp is within 5 minutes (replay protection), reads the body (bounded to 1MB), and calls `VerifySignature()`. On success, it sets `token_kind=client`, `agent_did={identity}`, and `token_scope=device` in the request context.
   - **Bearer token auth** (lines 123-145) — Classic `Authorization: Bearer <token>`. `IdentifyToken()` determines if it's a brain token or a client token. For client tokens, the scope resolver looks up whether it's `"admin"` or `"device"`.

<details>
<summary><strong>Design Decision — Why two auth methods (Ed25519 signatures + Bearer tokens)?</strong></summary>
<br>

Bearer tokens are simple but dangerous: anyone who steals the token string can impersonate the device. Ed25519 signature auth (`X-DID` + `X-Signature` + `X-Timestamp`) is stronger — the private key never leaves the device, and each request is signed with the current timestamp to prevent replay. But signature auth requires the client to have an Ed25519 keypair and implement the signing protocol.

The dual approach serves two audiences:
- **Paired devices** (phone, CLI) use signature auth after the QR pairing flow. The private key lives in the device's secure enclave or keychain. No token to steal.
- **The Python brain sidecar** uses a bearer token (`BRAIN_TOKEN`). It runs on the same machine as the core, communicates over localhost, and is a trusted internal component. Signature auth would add complexity without meaningful security gain for a localhost-only sidecar.

The 5-minute timestamp window prevents replay attacks while accommodating reasonable clock skew between devices. The body is included in the signature to prevent request tampering.

</details>

6. **Authz** (`NewAuthzMiddleware`, lines 154-173) — Reads the token kind and scope from context. Calls `AllowedForTokenKind(kind, path, scope)` to check whether this caller can access this endpoint. The `AdminEndpointChecker` (`core/internal/adapter/auth/auth.go`) blocks `"device"`-scoped tokens from sensitive paths like `/v1/did/sign` and `/admin/*`.

7. **Timeout** — 30-second deadline on every request.

### Example: Storing a Verdict in the Vault

Say the Python brain just analyzed a YouTube video and wants to store the verdict. It sends `POST /v1/vault/store` with a bearer token.

**Step 1: Auth middleware** identifies the token as `brain` (kind=`"brain"`, identity=`"brain"`).

**Step 2: Authz middleware** checks — is `"brain"` allowed to access `/v1/vault/store`? Yes, the brain can store data.

**Step 3: VaultHandler.HandleStore** (`core/internal/handler/vault.go:104-131`) parses the JSON body, validates the persona name via `domain.NewPersonaName()` (which rejects anything not matching `[a-z0-9_]+`), and calls `vaultSvc.Store()`.

**Step 4: VaultService.Store** (`core/internal/service/vault.go:120-141`) — Here the cascading checks begin:
- Is the vault open? If not, returns `ErrPersonaLocked`.
- PersonaManager.AccessPersona — is this persona's session still active? (checks TTL timer)
- Validate item type against `domain.ValidVaultItemTypes` and size against `domain.MaxVaultItemSize` (1MB).
- Set `IngestedAt` timestamp if not already set.
- Delegate to `writer.Store()` — the SQLite adapter.

**Step 5:** ID returned to handler, encoded as JSON, returned as `201 Created`.

### Example: Querying with Gatekeeper

Now say an external agent (trust level: "verified") wants to query the vault. The flow changes:

**VaultService.Query** (`core/internal/service/vault.go:50-80`) does everything Store does, but adds a **gatekeeper check**:

```go
intent := domain.Intent{
    AgentDID:  agentDID,
    Action:    domain.ActionVaultRead,  // "vault_read"
    Target:    string(persona),
    PersonaID: string(persona),
}
decision, err := s.gatekeeper.EvaluateIntent(ctx, intent)
```

This hits **Gatekeeper.EvaluateIntent** (`core/internal/adapter/gatekeeper/gatekeeper.go:99-205`). The gatekeeper applies a decision tree:

- **Brain agent + security-critical action?** (lines 109-116) — Denied. The brain can never sign DIDs, rotate keys, backup vaults, or unlock personas.
- **Brain + locked persona?** — Denied. The brain shouldn't access locked compartments.
- **Constraint violations?** (lines 136-161) — Cross-persona constraints prevent an agent authorized for "work" from accessing "personal". Draft-only constraints prevent direct actions.
- **Untrusted agent?** (lines 164-170) — Flat denial for any vault or risky action.
- **Money action without highest trust?** (lines 173-179) — Transfer money requires "Verified+Actioned" trust ring.
- **Vault access by verified (not fully trusted) agent?** (lines 182-188) — Allowed but **audited**. The user can later review what was accessed.
- **Risky action?** (lines 191-197) — Flagged for user review (send_email, transfer_money, share_data).
- **Everything else** — Safe intent, pass silently, no audit trail.

<details>
<summary><strong>Design Decision — Why an in-process gatekeeper instead of OPA or an external policy engine?</strong></summary>
<br>

Open Policy Agent (OPA) is the industry standard for policy-as-code. It's powerful, flexible, and well-tested. But it's also: (1) a separate process to deploy and manage, (2) a network hop for every policy check (latency on every vault query), (3) a Rego policy language that most developers don't know, and (4) overkill for Dina's current policy model.

Dina's gatekeeper rules are **hardcoded in Go** because the rules are few, critical, and rarely change: brain can't sign, untrusted can't read, money needs highest trust, risky actions are flagged. These aren't configurable policies — they're security invariants. Putting them in Go means they're type-checked, compiled, and tested alongside the code they protect. If/when Dina needs user-configurable policies (custom sharing rules, per-agent allowlists), OPA or a similar engine could be added as an adapter behind the existing `port.Gatekeeper` interface — the service layer wouldn't change.

</details>

---

## Act IV: Persona Lifecycle — Lock, Unlock, and the Ticking Clock

Personas are Dina's compartmentalization mechanism. "personal" and "work" and "medical" each have their own encrypted vault, their own access rules, their own TTL.

### Creating a Persona

`POST /v1/personas` hits `PersonaHandler.HandleCreatePersona` (`core/internal/handler/persona.go:58-101`). The handler:
1. Requires a non-empty name and **requires a passphrase** (line 75 — empty passphrase returns 400).
2. Generates a 16-byte random salt, hashes the passphrase with Argon2id (`auth.HashPassphrase`).
3. Calls `personaMgr.Create()` with the hash. The persona is created in a **locked** state.

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

`POST /v1/persona/unlock` hits `HandleUnlockPersona` (`core/internal/handler/persona.go:104-156`). This is the critical path:

1. Parse persona name and passphrase from the request.
2. Call `personaMgr.Unlock(ctx, persona, passphrase, 3600)` — the `3600` is the TTL in seconds (1 hour).
3. Inside `PersonaManager.Unlock` (`core/internal/adapter/identity/identity.go`), the stored Argon2id hash is retrieved and verified against the provided passphrase via the `VerifyPassphrase` callback. If wrong: `ErrInvalidPassphrase`.
4. **The persona ID is canonicalized** — `Unlock` uses `CanonicalID()` to handle both raw names and `"persona-"` prefixed IDs consistently.
5. A TTL timer starts. When it expires, the `OnLock` callback fires — which closes the vault (see Act I wiring).
6. Back in the handler (lines 133-151): the persona name is normalized (strip `"persona-"` prefix before `NewPersonaName` validation), a DEK is derived from the master seed via HKDF, and `vaultMgr.Open()` is called with that DEK. Now the vault is decrypted and ready for reads and writes.

<details>
<summary><strong>Design Decision — Why HKDF for persona DEK derivation instead of a random key per persona?</strong></summary>
<br>

Each persona vault needs its own Data Encryption Key (DEK). Two approaches:

- **Random DEK per persona:** Generate a random 32-byte key, encrypt it with the master key, store the wrapped DEK alongside the vault. Recovery requires the wrapped DEK file *and* the master key.
- **HKDF-derived DEK:** Derive the DEK deterministically from the master seed using HKDF with the persona name as context: `HKDF(seed, "persona:" + name) → DEK`. No wrapped key file needed. Recovery requires only the master seed.

HKDF derivation was chosen because: (1) one seed backup recovers *all* persona vaults, (2) no additional encrypted key files to manage, lose, or corrupt, (3) HKDF is a NIST-standardized (RFC 5869) key derivation function designed specifically for this use case — deriving multiple independent keys from a single master secret, and (4) the persona name is a natural, unique context label. The tradeoff: if you rename a persona, the DEK changes and the old vault can't be opened. This is by design — personas are identity compartments, not mutable labels.

</details>

### The Lock Timer

This is the invisible guardian. After 1 hour (or whatever TTL was set), the timer fires, the mutex releases, `OnLock` runs, the vault closes, and any subsequent queries return `ErrPersonaLocked`. No stale sessions. No forgotten open vaults. The clock enforces what policy cannot.

<details>
<summary><strong>Design Decision — Why TTL-based auto-lock instead of manual-only locking?</strong></summary>
<br>

If personas only locked when the user explicitly asked, they'd stay open forever in practice. Users forget. Browsers stay open. Phones stay unlocked. A 1-hour TTL means that even if the user walks away, the vault seals itself. This is the same principle behind: screen lock timeouts, SSH session timeouts, and bank session expiry. The difference is that Dina's lock is *cryptographic* — when the timer fires, the DEK is discarded from memory. It's not a UI gate that can be bypassed; the data is literally unreadable until the passphrase is re-entered and the DEK is re-derived.

</details>

---

## Act V: Dina-to-Dina — Sending Messages Across the Wire

When you want to send a message to another Dina:

`POST /v1/msg/send` hits `MessageHandler.HandleSend` (`core/internal/handler/message.go:31-68`). The handler parses the recipient DID, validates it via `domain.NewDID()`, and calls `transportSvc.SendMessage()`.

**TransportService.SendMessage** (`core/internal/service/transport.go`) orchestrates the encryption pipeline:
1. Resolve the recipient's DID document from the resolver to find their public key and service endpoint.
2. Convert the recipient's Ed25519 public key to X25519 (NaCl uses Curve25519 for key exchange).
3. Sign the plaintext message with the sender's Ed25519 key.
4. Encrypt with `crypto_box_seal` — each message uses a **fresh ephemeral X25519 keypair**, ensuring unique ciphertext even to the same recipient.
5. Package into a `DinaEnvelope` with the signature, sender DID, and ciphertext.
6. Attempt delivery via HTTP POST to the recipient's service endpoint.
7. If delivery fails, queue in the **outbox** for retry (30-second retry interval, exponential backoff).

<details>
<summary><strong>Design Decision — Why Ed25519-to-X25519 conversion instead of separate key exchange keys?</strong></summary>
<br>

NaCl's `crypto_box_seal` requires X25519 (Curve25519 Diffie-Hellman) keys. Dina's identity is Ed25519. These are different key types on the same underlying curve, so there are two options:

- **Separate keys:** Generate and manage an Ed25519 signing keypair *and* an X25519 encryption keypair. DID documents would list both. Recovery needs both.
- **Conversion:** Use one Ed25519 keypair for signing, and convert it to X25519 when encryption is needed. The conversion is a well-defined, lossless mathematical operation (RFC 7748, libsodium's `crypto_sign_ed25519_pk_to_curve25519`).

Conversion was chosen because: (1) one keypair per identity instead of two — simpler key management, simpler DID documents, simpler backup, (2) the conversion is cheap (~1 microsecond) and deterministic, and (3) libsodium/NaCl explicitly supports this pattern. The security implication is that if the Ed25519 key is compromised, encryption is also compromised — but that would be true of a combined key-agreement+signing scheme anyway. The "separate keys" approach only adds value if one key can be rotated independently, which Dina's current key rotation model doesn't support.

</details>

<details>
<summary><strong>Design Decision — Why `did:key` instead of `did:web` or `did:ion`?</strong></summary>
<br>

DID methods differ in where the DID document lives:

- **`did:web`** — DID document hosted at a URL. Simple, but depends on DNS and web hosting. If the domain expires or the server goes down, the identity is gone.
- **`did:ion`** — DID document anchored to Bitcoin's blockchain. Immutable and censorship-resistant, but slow (Bitcoin block times), expensive (transaction fees), and requires a full node or trusted resolver.
- **`did:key`** — DID document is *derived* from the public key itself. No network lookup needed. The DID `did:key:z6Mk...` literally encodes the Ed25519 public key with a multicodec prefix. Resolution is a pure function: parse the DID string → extract the key → build the document.

`did:key` was chosen for Phase 1 because: (1) zero infrastructure dependency — no DNS, no blockchain, no server, (2) instant resolution — no network call, (3) self-certifying — the DID *is* the key, so it can't be spoofed without the private key. The migration path to `did:plc` (AT Protocol's DID method, backed by a distributed ledger) is planned for Phase 3, which adds key rotation and account portability without sacrificing self-sovereignty. The `port.DIDManager` interface already abstracts the DID method — switching from `did:key` to `did:plc` changes the adapter, not the service layer.

</details>

The receiving side is the ingress pipeline from Act II — the same `POST /msg` endpoint, the same three valves.

---

## Act VI: The Egress Guardian — Nothing Leaves Without Permission

When data needs to leave the Home Node — to an external API, to another agent, to any destination — it must pass through egress control.

**Gatekeeper.CheckEgress** (`core/internal/adapter/gatekeeper/gatekeeper.go:208-242`) checks:
1. **Blocked destinations** — A hardcoded blocklist of known trackers. Instant denial.
2. **PII detection** — Four regex patterns scan the outbound data for email addresses, SSNs, credit card numbers, and phone numbers. If any match: denied. Raw data never leaves the Home Node.
3. **Trusted destinations** — Known-good endpoints that pass with clean data.

<details>
<summary><strong>Design Decision — Why default-deny egress instead of default-allow?</strong></summary>
<br>

Most systems default to allowing outbound traffic and block specific bad destinations (a blocklist/denylist approach). Dina inverts this for the sharing policy layer: no policy for a contact means **all categories blocked**. The reasoning:

1. **Privacy by default.** A new contact or a newly added agent gets zero data access until the user explicitly grants it. This is GDPR-aligned: data processing requires explicit consent.
2. **Fail-safe behavior.** If a policy is misconfigured, deleted, or corrupted, the system falls back to "share nothing" rather than "share everything." The blast radius of a bug is zero data exposure, not total exposure.
3. **Audit trail.** Every allowed egress creates an audit entry with the tier, category, and reason. Denied egress also creates an audit entry. The user can review exactly what was shared and what was blocked.

The tradeoff: the user must explicitly configure sharing policies for every contact. This is intentional friction — Dina is designed to make data sharing a conscious decision, not an accidental default.

</details>

For per-contact granularity, the **SharingPolicyManager** (`core/internal/adapter/gatekeeper/gatekeeper.go:246-381`) provides tiered data sharing:
- Default deny: no policy for a contact means all categories blocked.
- Tiers: `"summary"` — the contact sees a summary. `"full"` — the contact sees everything. `"none"` — blocked.
- The `FilterEgress` method takes a payload with multiple categories and applies the tier for each, producing an audit trail of what was allowed and what was denied.

---

## Act VII: Device Pairing — Adding a Second Screen

When you want to connect your phone to your Dina:

1. `POST /v1/pair/initiate` generates a pairing session with a 6-digit code and a session ID (valid for 5 minutes).
2. Your phone scans the QR code, sends `POST /v1/pair/complete` with the code.
3. `DeviceService.CompletePairing` generates a unique client token for the device, registers it with scope `"device"` (not `"admin"`), registers the device's Ed25519 public key for future signature auth, and records the device in the device registry.
4. The phone now authenticates via `X-DID` + `X-Signature` + `X-Timestamp` headers — no bearer token in local storage.
5. If the device is revoked (`DELETE /v1/devices/{id}`), `DeviceService` calls `tokenRevoker.RevokeClientTokenByDevice()` to remove all associated tokens and marks the device key as revoked.

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

## Act VIII: WebSocket — Real-Time Connection

`/ws` is wired inline in `main.go:597-626`. Each WebSocket connection goes through:

1. **Upgrade** (`ws.NewUpgrader` with `ws.ServeWS`) — checks origin if not in insecure mode.
2. **Auth handshake** — 5-second timer. The first message must be an `auth` message with a valid client token. `wsTokenValidator` calls `tokenValidator.ValidateClientToken()`.
3. **Hub registration** — The authenticated client joins the WSHub. They can now receive broadcasts and targeted messages.
4. **Message routing** — Non-auth messages are routed through `wsBrainRouter`, which forwards to the Python brain sidecar for LLM reasoning.
5. **Heartbeat** — Ping every 30 seconds, expect pong within 10 seconds. After 3 missed pongs, the connection is dropped and the client is unregistered.
6. **Message buffering** — If a client disconnects, up to 50 messages are buffered for 5 minutes. On reconnect, buffered messages are delivered.

<details>
<summary><strong>Design Decision — Why WebSocket instead of Server-Sent Events (SSE) or long-polling?</strong></summary>
<br>

Dina's real-time channel carries **bidirectional** traffic: the client sends queries to the brain, and the server pushes notifications (vault updates, incoming D2D messages, gatekeeper alerts) to the client.

- **SSE** is server-to-client only. Client-to-server would still need regular HTTP requests — two channels instead of one, with synchronization complexity.
- **Long-polling** works but wastes connections and has higher latency. Each "push" requires a new HTTP request/response cycle.
- **WebSocket** gives full-duplex communication over a single TCP connection. The 5-second auth handshake, ping/pong heartbeat, and message buffering are standard WebSocket patterns.

The Hub pattern (register/unregister/broadcast/send) is borrowed from Gorilla WebSocket's chat example — the simplest correct implementation of connection management. The 50-message, 5-minute buffer ensures that a brief WiFi dropout doesn't lose notifications.

</details>

---

## Act IX: The Health Probes

Two endpoints are always public (no auth required):

**`/healthz`** — Liveness. Always returns 200 if the process is running.

**`/readyz`** — Readiness (`core/cmd/dina-core/main.go:356-370`). Three real checks:
1. Brain token must be configured.
2. Vault path must exist on disk.
3. Brain sidecar must be reachable (HTTP health check).

If any fails, the load balancer gets a 503 and stops sending traffic.

<details>
<summary><strong>Design Decision — Why separate liveness and readiness probes?</strong></summary>
<br>

This follows the Kubernetes health check convention, but it matters even outside Kubernetes:

- **Liveness** (`/healthz`) answers: "Is the process alive?" If this fails, the process should be restarted. It always returns 200 — if it doesn't, the process has crashed.
- **Readiness** (`/readyz`) answers: "Can this instance serve traffic?" This might fail even when the process is alive — the brain sidecar might be restarting, the vault path might be on an unmounted volume, the config might be incomplete.

The distinction prevents premature restarts. If readiness fails but liveness passes, the orchestrator stops routing traffic but doesn't kill the process — giving the brain sidecar time to restart, the volume time to mount, or the operator time to fix the config. Killing a healthy process just because a dependency is temporarily unavailable would cascade failures.

</details>

---

## Epilogue: The Architecture in One Sentence

Every request enters through seven middleware layers, reaches a handler that delegates to a service, the service composes port interfaces to orchestrate business rules (gatekeeper for access control, persona manager for compartmentalization, vault for storage), and the adapters — hidden behind port interfaces — do the actual work with Ed25519 keys, SQLCipher databases, NaCl encryption, and filesystem dead drops. The human holds the seed. The math enforces the loyalty. Nothing leaves without permission.
