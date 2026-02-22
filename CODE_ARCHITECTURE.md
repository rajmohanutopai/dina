# Dina Code Architecture

This document describes the internal code architecture of dina-core (Go) and dina-brain (Python). It covers directory layout, design patterns, interface boundaries, concurrency model, error handling philosophy, and the principles that make this codebase maintainable for years.

---

## Governing Principles

Seven rules that every line of code must satisfy:

**1. Interfaces define boundaries, structs implement them.** Every major component is a Go `interface` or Python `Protocol`. The implementation is private. Tests inject fakes. No concrete dependency ever crosses a package boundary.

**2. Dependencies flow inward.** Domain logic depends on nothing. Infrastructure depends on domain. HTTP handlers depend on services. Services depend on repositories. Repositories depend on database drivers. Never the reverse. This is the Dependency Rule from Clean Architecture — applied pragmatically, not dogmatically.

**3. Errors are values, not exceptions.** Go returns `error`. Python raises typed exceptions that are caught at service boundaries. No error is silently swallowed. Every error carries context about what operation failed and why.

**4. Context flows everywhere.** Every function that does I/O accepts `context.Context` (Go) or uses async with cancellation (Python). This enables clean shutdown, request-scoped timeouts, and graceful degradation.

**5. No global state.** No `init()` functions with side effects. No package-level `var db *sql.DB`. Every dependency is constructed in `main()` and injected downward. This makes the dependency graph explicit and testable.

**6. Secrets never appear in logs, errors, or stack traces.** All logging uses structured metadata (persona name, item count, latency). Never content. The logging policy from ARCHITECTURE.md is enforced by CI linters, not by hoping developers remember.

**7. The compiler is the first reviewer.** Go's type system catches entire categories of bugs. Strong typing on token types (BrainToken vs ClientToken), persona names, DID strings. No raw `string` where a domain type should exist.

---

## Repository Layout

```
dina/
├── core/                          # dina-core — Go
│   ├── cmd/
│   │   └── dina-core/
│   │       └── main.go            # Wiring. Constructs all dependencies. Starts servers.
│   │
│   ├── internal/                  # Private packages — nothing outside core/ imports these
│   │   ├── domain/                # Pure domain types. Zero dependencies. Zero I/O.
│   │   │   ├── identity.go        # DID, PersonaName, TrustLevel, KeyPair types
│   │   │   ├── vault.go           # VaultItem, SearchQuery, SearchResult types
│   │   │   ├── message.go         # DinaMessage, Envelope, MessageType types
│   │   │   ├── contact.go         # Contact, SharingPolicy, SharingTier types
│   │   │   ├── task.go            # Task, TaskStatus types
│   │   │   ├── device.go          # Device, DeviceToken types
│   │   │   ├── audit.go           # AuditEntry types
│   │   │   └── errors.go          # Sentinel errors: ErrPersonaLocked, ErrUnauthorized, etc.
│   │   │
│   │   ├── port/                  # Interfaces (ports). Define WHAT, not HOW.
│   │   │   ├── vault.go           # VaultReader, VaultWriter, VaultManager
│   │   │   ├── identity.go        # KeyDeriver, DIDResolver, Signer, Verifier
│   │   │   ├── crypto.go          # Encryptor, KeyWrapper, PIIScrubber
│   │   │   ├── transport.go       # MessageSender, MessageReceiver
│   │   │   ├── task.go            # TaskQueue, TaskWorker
│   │   │   ├── device.go          # DeviceRegistry, DevicePairer
│   │   │   ├── notification.go    # ClientNotifier
│   │   │   ├── brain.go           # BrainClient (how core talks to brain)
│   │   │   └── clock.go           # Clock interface (for deterministic testing)
│   │   │
│   │   ├── adapter/               # Implementations (adapters). The HOW.
│   │   │   ├── sqlite/            # SQLCipher vault implementation
│   │   │   │   ├── vault.go       # Implements port.VaultReader, port.VaultWriter
│   │   │   │   ├── pool.go        # VaultPool: one write conn + read pool per file
│   │   │   │   ├── manager.go     # VaultManager: opens/closes/locks persona databases
│   │   │   │   ├── migration.go   # Schema versioning + sqlcipher_export() backup
│   │   │   │   ├── fts.go         # FTS5 query builder + unicode61 configuration
│   │   │   │   ├── vec.go         # sqlite-vec nearest-neighbor queries
│   │   │   │   ├── identity.go    # Identity schema operations (contacts, audit, kv, tasks)
│   │   │   │   └── schema/        # Embedded SQL migration files
│   │   │   │       ├── identity_001.sql
│   │   │   │       ├── persona_001.sql
│   │   │   │       └── ...
│   │   │   │
│   │   │   ├── crypto/            # Cryptographic implementations
│   │   │   │   ├── nacl.go        # libsodium crypto_box_seal encrypt/decrypt
│   │   │   │   ├── argon2.go      # Argon2id KEK derivation
│   │   │   │   ├── hkdf.go        # HKDF-SHA256 per-persona DEK derivation
│   │   │   │   ├── slip0010.go    # SLIP-0010 Ed25519 hardened HD key derivation
│   │   │   │   ├── bip39.go       # Mnemonic generation + seed derivation
│   │   │   │   ├── keywrap.go     # AES-256-GCM master seed wrap/unwrap
│   │   │   │   └── convert.go     # Ed25519 → X25519 key conversion
│   │   │   │
│   │   │   ├── did/               # DID operations
│   │   │   │   ├── plc.go         # did:plc creation, resolution, rotation
│   │   │   │   ├── web.go         # did:web fallback resolution
│   │   │   │   └── document.go    # DID Document construction + serialization
│   │   │   │
│   │   │   ├── pii/               # Tier 1 regex PII scrubber
│   │   │   │   ├── scrubber.go    # Pattern registry + replacement engine
│   │   │   │   ├── patterns.go    # Aadhaar, SSN, credit card, phone, email regexes
│   │   │   │   └── map.go         # Replacement map ([CC_NUM] → original)
│   │   │   │
│   │   │   ├── brain/             # Brain HTTP client
│   │   │   │   ├── client.go      # Implements port.BrainClient
│   │   │   │   └── circuit.go     # Circuit breaker wrapping brain calls
│   │   │   │
│   │   │   └── pds/               # AT Protocol PDS client
│   │   │       ├── client.go      # Push signed records to PDS
│   │   │       └── lexicon.go     # com.dina.reputation.* record types
│   │   │
│   │   ├── service/               # Business logic orchestration
│   │   │   ├── vault.go           # VaultService: query routing, hybrid search, batch store
│   │   │   ├── identity.go        # IdentityService: setup, key derivation, DID registration
│   │   │   ├── gatekeeper.go      # GatekeeperService: persona access tiers, egress enforcement
│   │   │   ├── transport.go       # TransportService: send/receive messages, dead drop, outbox
│   │   │   ├── task.go            # TaskService: outbox pattern, retry, dead letter
│   │   │   ├── device.go          # DeviceService: pairing ceremony, token lifecycle
│   │   │   ├── sync.go            # SyncService: client cache sync protocol
│   │   │   ├── onboarding.go      # OnboardingService: setup wizard orchestration
│   │   │   ├── migration.go       # MigrationService: export/import .dina archives
│   │   │   └── watchdog.go        # WatchdogService: periodic health checks, cleanup
│   │   │
│   │   ├── handler/               # HTTP handlers — thin. Validate, call service, serialize.
│   │   │   ├── vault.go           # /v1/vault/query, /v1/vault/store, /v1/vault/item/:id
│   │   │   ├── identity.go        # /v1/did/sign, /v1/did/verify, /v1/did/document
│   │   │   ├── message.go         # POST /msg (NaCl ingress), /v1/msg/send (outbound)
│   │   │   ├── pii.go             # /v1/pii/scrub
│   │   │   ├── task.go            # /v1/task/ack
│   │   │   ├── device.go          # /v1/pair/initiate, /v1/pair/complete, /v1/devices/*
│   │   │   ├── contact.go         # /v1/contacts/:did/policy
│   │   │   ├── notify.go          # /v1/notify (push to client WebSocket)
│   │   │   ├── persona.go         # /v1/persona/unlock
│   │   │   ├── health.go          # /healthz, /readyz, /metrics
│   │   │   ├── admin.go           # /admin/* reverse proxy + session gateway
│   │   │   ├── wellknown.go       # /.well-known/atproto-did
│   │   │   └── export.go          # /v1/export, /v1/import
│   │   │
│   │   ├── middleware/            # HTTP middleware chain
│   │   │   ├── auth.go            # Two-tier token auth (BrainToken / ClientToken)
│   │   │   ├── ratelimit.go       # IP rate limiting (token bucket) + global cap
│   │   │   ├── logging.go         # Structured request logging (metadata only, no PII)
│   │   │   ├── recovery.go        # Panic recovery → 500 + safe log
│   │   │   ├── timeout.go         # Per-route request timeouts
│   │   │   └── cors.go            # CORS for admin UI
│   │   │
│   │   ├── websocket/             # WebSocket hub for client devices
│   │   │   ├── hub.go             # Connection registry, message routing
│   │   │   ├── connection.go      # Single client connection lifecycle
│   │   │   ├── auth.go            # Auth frame validation (5-second timeout)
│   │   │   ├── protocol.go        # Message envelope types (query, whisper, command, etc.)
│   │   │   └── buffer.go          # Per-device missed message buffer (50 msgs, 5 min TTL)
│   │   │
│   │   ├── ingress/               # Inbound message processing (Dead Drop + Fast Path)
│   │   │   ├── router.go          # State-aware ingress: vault locked → dead drop, unlocked → fast path
│   │   │   ├── deaddrop.go        # Spool management (write blobs, check quota)
│   │   │   ├── sweeper.go         # Post-unlock: decrypt blobs, check TTL, blocklist feedback
│   │   │   └── ratelimit.go       # IP rate limiter (Valve 1) + spool cap (Valve 2)
│   │   │
│   │   ├── reminder/              # Reminder loop
│   │   │   └── loop.go            # Channel-woken sleep loop, fires on schedule
│   │   │
│   │   └── config/                # Configuration loading
│   │       ├── config.go          # Typed config struct (from config.json)
│   │       ├── loader.go          # File + env + Docker Secrets loading
│   │       └── validate.go        # Structural validation at startup
│   │
│   ├── test/                      # Test files (mirror internal/ structure)
│   │   ├── testutil/
│   │   │   ├── skip.go            # NotImplemented(t), Implemented(t) markers
│   │   │   ├── vault.go           # In-memory vault fake for tests
│   │   │   ├── clock.go           # Deterministic clock for time-sensitive tests
│   │   │   ├── crypto.go          # Deterministic key generation for reproducible tests
│   │   │   └── assert.go          # Custom assertions (assertAuditLogged, assertPersonaLocked, etc.)
│   │   ├── auth_test.go           # §1
│   │   ├── crypto_test.go         # §2
│   │   ├── identity_test.go       # §3
│   │   ├── vault_test.go          # §4
│   │   ├── pii_test.go            # §5
│   │   ├── gatekeeper_test.go     # §6
│   │   ├── transport_test.go      # §7
│   │   ├── task_test.go           # §8
│   │   ├── websocket_test.go      # §9
│   │   ├── ...                    # §10–§27
│   │   └── testdata/              # Golden files, fixture databases, test certificates
│   │
│   ├── go.mod
│   └── go.sum
│
├── brain/                         # dina-brain — Python
│   ├── src/
│   │   ├── main.py                # FastAPI master app. Mounts /api and /admin.
│   │   │
│   │   ├── domain/                # Pure domain types. No I/O. No framework imports.
│   │   │   ├── types.py           # VaultItem, SearchResult, NudgePayload, TaskEvent dataclasses
│   │   │   ├── errors.py          # Typed exceptions: PersonaLocked, CoreUnreachable, etc.
│   │   │   └── enums.py           # Priority, SilenceDecision, LLMProvider enums
│   │   │
│   │   ├── port/                  # Protocols (interfaces). No implementations.
│   │   │   ├── core_client.py     # CoreClient protocol (vault query/store, PII scrub, notify)
│   │   │   ├── llm.py             # LLMProvider protocol (complete, embed, classify)
│   │   │   ├── mcp.py             # MCPClient protocol (call_tool, list_tools)
│   │   │   └── scrubber.py        # PIIScrubber protocol (scrub, rehydrate)
│   │   │
│   │   ├── adapter/               # Implementations
│   │   │   ├── core_http.py       # CoreClient → HTTP calls to core:8100
│   │   │   ├── llm_gemini.py      # LLMProvider → Gemini API
│   │   │   ├── llm_claude.py      # LLMProvider → Claude API
│   │   │   ├── llm_llama.py       # LLMProvider → llama:8080 (local)
│   │   │   ├── mcp_stdio.py       # MCPClient → stdio transport (OpenClaw on host)
│   │   │   ├── mcp_http.py        # MCPClient → HTTP transport
│   │   │   └── scrubber_spacy.py  # PIIScrubber → spaCy NER (Tier 2)
│   │   │
│   │   ├── service/               # Business logic
│   │   │   ├── guardian.py         # Guardian angel loop: silence → classify → assemble → notify
│   │   │   ├── sync_engine.py     # Ingestion orchestration: schedule → fetch → triage → store
│   │   │   ├── llm_router.py      # Route tasks to best LLM (local vs cloud, model selection)
│   │   │   ├── entity_vault.py    # Entity Vault: scrub → call cloud LLM → rehydrate
│   │   │   ├── nudge.py           # Nudge assembly: context gathering → LLM → format
│   │   │   └── scratchpad.py      # Cognitive checkpointing: save/resume multi-step reasoning
│   │   │
│   │   ├── dina_brain/            # Brain API sub-app (/api/*)
│   │   │   ├── app.py             # FastAPI sub-app, BRAIN_TOKEN auth middleware
│   │   │   └── routes/
│   │   │       ├── process.py     # POST /v1/process — new data event from core
│   │   │       └── reason.py      # POST /v1/reason — complex query from core
│   │   │
│   │   ├── dina_admin/            # Admin UI sub-app (/admin/*)
│   │   │   ├── app.py             # FastAPI sub-app, CLIENT_TOKEN auth middleware
│   │   │   ├── core_client.py     # Typed calls to core:8100 with CLIENT_TOKEN
│   │   │   ├── routes/
│   │   │   │   ├── dashboard.py
│   │   │   │   ├── history.py
│   │   │   │   ├── contacts.py
│   │   │   │   └── settings.py
│   │   │   └── templates/
│   │   │       ├── dashboard.html
│   │   │       ├── history.html
│   │   │       ├── contacts.html
│   │   │       └── settings.html
│   │   │
│   │   └── infra/                 # Cross-cutting infrastructure
│   │       ├── logging.py         # structlog config (JSON, no PII)
│   │       ├── crash_handler.py   # Safe crash: sanitized stdout + full traceback → core vault
│   │       └── config.py          # Typed config from env vars + Docker Secrets
│   │
│   ├── tests/                     # Test files (mirror src/ structure)
│   │   ├── conftest.py            # Auto-skip stubs, shared fixtures
│   │   ├── factories.py           # Test data factories (make_contact, make_vault_item, etc.)
│   │   ├── test_auth_1.py         # §1
│   │   ├── test_guardian_2.py     # §2
│   │   ├── test_pii_3.py          # §3
│   │   ├── ...                    # §4–§18
│   │   └── fakes/                 # In-memory fakes implementing port/ protocols
│   │       ├── fake_core.py       # CoreClient fake (returns canned vault data)
│   │       ├── fake_llm.py        # LLMProvider fake (deterministic responses)
│   │       └── fake_mcp.py        # MCPClient fake (simulates OpenClaw)
│   │
│   ├── pyproject.toml
│   └── requirements.txt
│
├── integration/                   # Integration tests (both services running)
│   ├── tests/
│   │   ├── conftest.py            # Docker-compose fixture, wait-for-healthy
│   │   ├── test_core_brain_flow.py
│   │   ├── test_didcomm_e2e.py
│   │   └── ...
│   └── docker-compose.test.yml    # Isolated test stack
│
├── docker-compose.yml             # Production stack
├── install.sh                     # Bootstrap: generates secrets, creates directories
├── test_taxonomy.yaml             # Maps test names to sections (for burndown matrix)
├── dina-test-matrix.py            # Aggregator script (go test -json + pytest-json-report)
└── ARCHITECTURE.md                # The specification this code implements
```

---

## Go Core: Internal Design

### The Hexagonal Shape

The Go core follows Hexagonal Architecture (Ports & Adapters). Three concentric rings:

```
                    ┌─────────────────────────────────────┐
                    │          handler/ + middleware/       │
                    │     HTTP handlers, WebSocket hub      │
                    │     (Thin. Validate → call → serialize)│
                    │                                       │
                    │    ┌─────────────────────────────┐   │
                    │    │         service/              │   │
                    │    │   Business logic orchestration │   │
                    │    │   (Composes ports. No I/O.)    │   │
                    │    │                               │   │
                    │    │    ┌───────────────────┐     │   │
                    │    │    │     domain/        │     │   │
                    │    │    │  Pure types.       │     │   │
                    │    │    │  Zero imports.     │     │   │
                    │    │    └───────────────────┘     │   │
                    │    │                               │   │
                    │    │    ┌───────────────────┐     │   │
                    │    │    │      port/         │     │   │
                    │    │    │  Interfaces only.  │     │   │
                    │    │    └───────────────────┘     │   │
                    │    │                               │   │
                    │    └─────────────────────────────┘   │
                    │                                       │
                    │    ┌─────────────────────────────┐   │
                    │    │        adapter/               │   │
                    │    │  SQLCipher, libsodium, HTTP   │   │
                    │    │  (Implements port interfaces) │   │
                    │    └─────────────────────────────┘   │
                    │                                       │
                    └─────────────────────────────────────┘
```

**Dependency rule:** Arrows point inward only.
- `handler/` imports `service/` and `domain/`. Never `adapter/`.
- `service/` imports `port/` and `domain/`. Never `adapter/`.
- `adapter/` imports `port/` and `domain/`. Implements the interfaces.
- `domain/` imports nothing.
- `port/` imports `domain/` only.

**Why this matters:** You can replace SQLCipher with a different database by writing a new adapter. You can test services with in-memory fakes. You can swap libsodium for a different NaCl implementation. The business logic never knows.

### The Domain Package — Types That Cannot Lie

`domain/` contains only types, no behavior. These types use Go's type system to make invalid states unrepresentable.

```go
// domain/identity.go

// PersonaName is a validated persona path. Cannot be empty. Cannot contain "..".
// Constructor validates. Once created, always valid.
type PersonaName string

func NewPersonaName(raw string) (PersonaName, error) {
    if raw == "" || strings.Contains(raw, "..") || !strings.HasPrefix(raw, "/") {
        return "", ErrInvalidPersona
    }
    return PersonaName(raw), nil
}

// DID is a validated Decentralized Identifier string.
type DID string

func NewDID(raw string) (DID, error) {
    if !strings.HasPrefix(raw, "did:") {
        return "", ErrInvalidDID
    }
    return DID(raw), nil
}

// TokenType distinguishes brain tokens from client tokens at the type level.
// A function that accepts BrainToken cannot accidentally receive a ClientToken.
type BrainToken string
type ClientToken string
```

**The principle:** raw strings become typed wrappers with validated constructors. A function signature like `func QueryVault(persona PersonaName, q SearchQuery) ([]VaultItem, error)` is self-documenting and impossible to call with an invalid persona name. The compiler enforces what code review would otherwise need to catch.

### The Port Package — Interfaces That Define the System

Every major capability is an interface in `port/`. Services depend on these interfaces, never on concrete implementations.

```go
// port/vault.go

type VaultReader interface {
    Query(ctx context.Context, persona domain.PersonaName, q domain.SearchQuery) ([]domain.VaultItem, error)
    GetItem(ctx context.Context, persona domain.PersonaName, id string) (*domain.VaultItem, error)
    VectorSearch(ctx context.Context, persona domain.PersonaName, vector []float32, topK int) ([]domain.VaultItem, error)
}

type VaultWriter interface {
    Store(ctx context.Context, persona domain.PersonaName, item domain.VaultItem) (string, error)
    StoreBatch(ctx context.Context, persona domain.PersonaName, items []domain.VaultItem) ([]string, error)
    Delete(ctx context.Context, persona domain.PersonaName, id string) error
}

type VaultManager interface {
    Open(ctx context.Context, persona domain.PersonaName, dek []byte) error
    Close(persona domain.PersonaName) error
    IsOpen(persona domain.PersonaName) bool
    OpenPersonas() []domain.PersonaName
}
```

```go
// port/identity.go

type KeyDeriver interface {
    DerivePersonaDEK(seed []byte, persona domain.PersonaName) ([]byte, error)
    DeriveSigningKey(seed []byte, index uint32) (ed25519.PrivateKey, error)
    DeriveBackupKey(seed []byte) ([]byte, error)
}

type Signer interface {
    Sign(ctx context.Context, data []byte) ([]byte, error)
    PublicKey() ed25519.PublicKey
}

type DIDResolver interface {
    Resolve(ctx context.Context, did domain.DID) (*domain.DIDDocument, error)
}
```

```go
// port/crypto.go

type Encryptor interface {
    SealAnonymous(plaintext []byte, recipientPub []byte) ([]byte, error)
    OpenAnonymous(ciphertext []byte, recipientPub, recipientPriv []byte) ([]byte, error)
}

type KeyWrapper interface {
    Wrap(masterSeed []byte, kek []byte) ([]byte, error)
    Unwrap(wrapped []byte, kek []byte) ([]byte, error)
}

type KEKDeriver interface {
    DeriveKEK(passphrase string, salt []byte) ([]byte, error)
}
```

```go
// port/transport.go

type MessageSender interface {
    Send(ctx context.Context, to domain.DID, msg domain.DinaMessage) error
}

type MessageReceiver interface {
    // OnMessage registers a handler for incoming decrypted messages.
    OnMessage(handler func(ctx context.Context, msg domain.DinaMessage) error)
}
```

```go
// port/brain.go

type BrainClient interface {
    Process(ctx context.Context, event domain.TaskEvent) error
    Reason(ctx context.Context, query string) (*domain.ReasonResult, error)
    IsHealthy(ctx context.Context) bool
}
```

```go
// port/clock.go

// Clock enables deterministic time in tests. Production uses RealClock.
// Tests use FixedClock or SteppingClock.
type Clock interface {
    Now() time.Time
    After(d time.Duration) <-chan time.Time
    NewTicker(d time.Duration) *time.Ticker
}
```

**Why Clock is an interface:** The reminder loop, task timeouts, TTL checks, session expiry, and audit log timestamps all depend on time. In tests, you need deterministic time to avoid flaky test failures. Injecting a Clock interface lets tests control time precisely. This is the single most impactful testability decision in the codebase.

### The Service Layer — Where Business Logic Lives

Services compose ports to implement business operations. They never directly access databases or networks.

```go
// service/gatekeeper.go

type GatekeeperService struct {
    vault    port.VaultManager
    reader   port.VaultReader
    config   *domain.GatekeeperConfig  // persona → tier mapping
    auditor  port.AuditWriter
    notifier port.ClientNotifier
    clock    port.Clock
}

// CheckAccess decides whether brain can access a persona.
// Returns nil if allowed. Returns ErrPersonaLocked or ErrPersonaRestricted.
// Restricted access is allowed but logged + notified.
func (g *GatekeeperService) CheckAccess(
    ctx context.Context,
    requester domain.TokenType,
    persona domain.PersonaName,
    action domain.AccessAction,
) error {
    // ... tier check logic, audit logging, notification for restricted ...
}

// EnforceEgress filters outbound data based on sharing policy.
// Brain provides max-detail payload. Gatekeeper strips to policy level.
func (g *GatekeeperService) EnforceEgress(
    ctx context.Context,
    to domain.DID,
    payload domain.SharingPayload,
) (*domain.SharingPayload, error) {
    // ... policy lookup, per-category filtering, audit logging ...
}
```

```go
// service/transport.go

type TransportService struct {
    encryptor   port.Encryptor
    signer      port.Signer
    resolver    port.DIDResolver
    vault       port.VaultReader   // for contact lookup
    gatekeeper  *GatekeeperService
    outbox      port.TaskQueue
    clock       port.Clock
}

// SendMessage encrypts and sends. If recipient offline, queues in outbox.
func (t *TransportService) SendMessage(
    ctx context.Context,
    to domain.DID,
    msg domain.DinaMessage,
) error {
    // 1. Gatekeeper enforces egress policy
    // 2. Sign plaintext (inside envelope)
    // 3. Resolve recipient DID → endpoint + public key
    // 4. Encrypt with crypto_box_seal (ephemeral sender key)
    // 5. POST to recipient — if fails, queue in outbox for retry
}
```

**The pattern:** Each service receives its dependencies via constructor injection. No service calls another service's internal methods — they compose through shared port interfaces. This means you can test the GatekeeperService by injecting a fake VaultManager that always reports personas as locked, and verify the 403 behavior without touching SQLCipher.

### The Adapter Layer — Implementations

Adapters implement port interfaces using concrete technology. They're the only place in the codebase that imports third-party libraries.

```go
// adapter/sqlite/pool.go

// VaultPool holds one write connection and a read pool for a single persona database.
type VaultPool struct {
    writeConn *sql.DB  // MaxOpenConns=1
    readPool  *sql.DB  // MaxOpenConns = runtime.NumCPU() * 2
    persona   domain.PersonaName
    mu        sync.Mutex // Protects write connection serialization
}
```

```go
// adapter/sqlite/manager.go

// Manager implements port.VaultManager.
// Holds pools for all currently open persona databases.
type Manager struct {
    identity  *VaultPool                        // Always open (contacts, audit, kv, tasks)
    personas  map[domain.PersonaName]*VaultPool  // "personal" → pool, etc.
    mu        sync.RWMutex                       // Protects the personas map
    deriver   port.KeyDeriver                    // For deriving DEKs on demand
    seed      []byte                             // Master seed, held in RAM
}
```

**Critical implementation detail — sqlcipher_export for backups:**

The adapter layer is where the `VACUUM INTO` vulnerability is prevented. The `SecureBackup` method uses `ATTACH DATABASE` + `sqlcipher_export()` exclusively. A CI test attempts to open every backup as a plaintext SQLite file — if the `SQLite format 3\0` header is present, the build fails. This is enforced in the adapter, not relied upon by code review.

### The Handler Layer — Thin HTTP Glue

Handlers do three things: validate input, call a service, serialize output. No business logic.

```go
// handler/vault.go

type VaultHandler struct {
    vault      *service.VaultService
    gatekeeper *service.GatekeeperService
}

func (h *VaultHandler) HandleQuery(w http.ResponseWriter, r *http.Request) {
    // 1. Parse + validate request body → domain.SearchQuery
    // 2. Extract token type from context (set by auth middleware)
    // 3. Call gatekeeper.CheckAccess(ctx, tokenType, persona, ActionRead)
    // 4. If err → write 403 with structured error
    // 5. Call vault.Query(ctx, persona, query)
    // 6. Serialize results → JSON response
}
```

**Why handlers are thin:** A thick handler mixes HTTP concerns with business logic, making it untestable without spinning up an HTTP server. Thin handlers let you test the service layer directly with unit tests, and test the handler layer with HTTP request/response assertions that verify serialization and status codes.

### The Middleware Chain

Middleware is composed in `main.go` as a stack. Order matters:

```go
// cmd/dina-core/main.go (conceptual wiring)

// Build middleware chain — outermost runs first
handler := recovery(             // 1. Catch panics → 500
    timeout(                     // 2. Request deadline
    logging(                     // 3. Structured access log (no PII)
    ratelimit(                   // 4. IP token bucket + global cap
    auth(                        // 5. Identify token type (brain/client/unknown)
    router                       // 6. Route to handler
)))))
```

The auth middleware puts the identified token type into `context.Context`. Handlers and services retrieve it via typed context keys. No handler ever inspects the Authorization header directly.

### Concurrency Model

**Rule: One writer per SQLite file. Unlimited readers.**

The VaultPool enforces this structurally. There is no concurrent write path that can race because the write connection has `MaxOpenConns=1` and `busy_timeout=5000ms`. Reads use a separate connection pool and never block on writes (WAL mode).

**Goroutine ownership:**

```
main goroutine
├── HTTP server (net/http — spawns per-request goroutines automatically)
├── WebSocket hub goroutine (reads from channel, dispatches to connections)
│   └── Per-connection goroutines (read pump + write pump per WebSocket)
├── Ingress router goroutine (Dead Drop sweeper, wakes on vault unlock)
├── Task watchdog goroutine (scans for timed-out tasks every 30s)
├── Reminder loop goroutine (sleeps until next reminder, wakes on channel)
├── Outbox retry goroutine (exponential backoff for failed sends)
└── Watchdog goroutine (periodic health checks, disk usage, cleanup)
```

Each goroutine is launched in `main()` and connected to the root `context.Context`. On shutdown (SIGTERM), the context is cancelled, and every goroutine drains cleanly. The shutdown sequence:

1. Stop accepting new HTTP connections
2. Close WebSocket connections (send close frame, wait 5s)
3. Wait for in-flight requests to complete (30s deadline)
4. Flush outbox (attempt final sends)
5. Checkpoint WAL on all open databases
6. Close all SQLite connections
7. Zero master seed from memory
8. Exit

### Error Handling

**Go core uses error wrapping with sentinel types:**

```go
// domain/errors.go

var (
    ErrPersonaLocked    = errors.New("persona locked")
    ErrPersonaNotFound  = errors.New("persona not found")
    ErrUnauthorized     = errors.New("unauthorized")
    ErrForbidden        = errors.New("forbidden")
    ErrRateLimited      = errors.New("rate limited")
    ErrSpoolFull        = errors.New("spool full")
    ErrMessageExpired   = errors.New("message expired")
    ErrDIDNotFound      = errors.New("DID not found")
    ErrInvalidSignature = errors.New("invalid signature")
    ErrVaultCorrupted   = errors.New("vault corrupted")
)
```

Services wrap errors with context using `fmt.Errorf`:

```go
return fmt.Errorf("gatekeeper: query persona %s: %w", persona, domain.ErrPersonaLocked)
```

Handlers check with `errors.Is()`:

```go
if errors.Is(err, domain.ErrPersonaLocked) {
    writeJSON(w, 403, ErrorResponse{Code: "persona_locked", Message: "requires CLIENT_TOKEN approval"})
    return
}
```

**No error is ever ignored.** `errcheck` linter runs in CI and fails the build on unchecked errors.

### Wiring in main.go — The Composition Root

`main.go` is the only file that knows about concrete types. It constructs everything and wires dependencies:

```go
// cmd/dina-core/main.go (conceptual structure)

func main() {
    // 1. Load config
    cfg := config.Load()

    // 2. Obtain master seed (security mode: prompt. convenience mode: read keyfile)
    seed := obtainMasterSeed(cfg)

    // 3. Construct adapters (concrete implementations)
    clock       := adapter.NewRealClock()
    keyDeriver  := crypto.NewHKDFDeriver()
    encryptor   := crypto.NewNaClEncryptor()
    keyWrapper  := crypto.NewAESGCMWrapper()
    didResolver := did.NewPLCResolver(cfg.PLCDirectory)
    piiScrubber := pii.NewRegexScrubber()
    brainClient := brain.NewHTTPClient(cfg.BrainURL, cfg.BrainToken)
    pdsClient   := pds.NewClient(cfg.PDSEndpoint)

    // 4. Construct vault manager (opens identity.sqlite + personal.sqlite)
    vaultMgr := sqlite.NewManager(seed, keyDeriver)
    vaultMgr.Open(ctx, domain.PersonaIdentity, /* derived DEK */)
    vaultMgr.Open(ctx, domain.PersonaPersonal, /* derived DEK */)

    // 5. Construct services (depend on port interfaces, receive adapters)
    gatekeeper := service.NewGatekeeper(vaultMgr, vaultMgr /* as reader */, cfg.Gatekeeper, clock)
    transport  := service.NewTransport(encryptor, signer, didResolver, gatekeeper, outbox, clock)
    taskSvc    := service.NewTaskService(vaultMgr /* identity.sqlite */, brainClient, clock)
    vaultSvc   := service.NewVaultService(vaultMgr, gatekeeper)
    deviceSvc  := service.NewDeviceService(vaultMgr, clock)
    // ... etc

    // 6. Construct handlers (depend on services)
    vaultHandler   := handler.NewVaultHandler(vaultSvc, gatekeeper)
    messageHandler := handler.NewMessageHandler(transport)
    // ... etc

    // 7. Build router + middleware chain
    mux := buildRouter(vaultHandler, messageHandler, /* ... */)
    server := buildMiddleware(mux, cfg)

    // 8. Launch background goroutines
    go taskSvc.WatchdogLoop(ctx)
    go reminderLoop(ctx, vaultMgr, clock)
    go outboxRetryLoop(ctx, transport, clock)
    go watchdog.Run(ctx, vaultMgr, clock)

    // 9. Start HTTP server
    server.ListenAndServe(":8100")

    // 10. On shutdown signal: graceful drain
    gracefulShutdown(server, vaultMgr, seed)
}
```

**Why this matters:** Every dependency is visible in one file. You can read `main.go` and understand the entire wiring of the system. No magic, no framework auto-discovery, no dependency injection container. Just constructors.

---

## Python Brain: Internal Design

### Architecture Style: Service Layer + Protocols

Python brain uses the same port/adapter separation as Go core, but adapted to Python idioms:
- `Protocol` classes instead of Go interfaces
- `dataclass` for domain types instead of Go structs
- `async/await` throughout (FastAPI is async-native)
- Dependency injection via constructor parameters (no DI framework)

### The Domain Layer

```python
# domain/types.py

@dataclass(frozen=True)
class VaultItem:
    id: str
    type: str
    persona: str
    summary: str
    timestamp: datetime
    metadata: dict[str, Any]

@dataclass(frozen=True)
class TaskEvent:
    task_id: str
    type: str          # "process", "reason"
    payload: dict[str, Any]

@dataclass(frozen=True)
class NudgePayload:
    text: str
    sources: list[str]
    tier: int          # 1 = interrupt, 2 = notify, 3 = silent queue
    trigger: str       # what caused this nudge

class SilenceDecision(Enum):
    INTERRUPT = 1      # Priority 1 — fiduciary, break through
    NOTIFY = 2         # Priority 2 — solicited, show notification
    SILENT = 3         # Priority 3 — queue for briefing
```

### The Port Layer

```python
# port/core_client.py

class CoreClient(Protocol):
    async def vault_query(self, persona: str, query: str, **kwargs) -> list[VaultItem]: ...
    async def vault_store(self, persona: str, item: dict) -> str: ...
    async def vault_store_batch(self, persona: str, items: list[dict]) -> list[str]: ...
    async def pii_scrub(self, text: str) -> ScrubResult: ...
    async def notify(self, device: str, payload: NudgePayload) -> None: ...
    async def task_ack(self, task_id: str) -> None: ...
    async def did_sign(self, data: bytes) -> bytes: ...
```

```python
# port/llm.py

class LLMProvider(Protocol):
    async def complete(self, messages: list[dict], **kwargs) -> str: ...
    async def embed(self, text: str) -> list[float]: ...
    async def classify(self, text: str, categories: list[str]) -> str: ...
    @property
    def model_name(self) -> str: ...
    @property
    def is_local(self) -> bool: ...
```

### The Service Layer

```python
# service/guardian.py

class GuardianLoop:
    """The core reasoning engine. Runs continuously, processes events from core."""

    def __init__(
        self,
        core: CoreClient,
        llm_router: LLMRouter,
        scrubber: PIIScrubber,
        entity_vault: EntityVaultService,
        nudge_assembler: NudgeAssembler,
        scratchpad: ScratchpadService,
    ):
        self._core = core
        self._llm = llm_router
        self._scrubber = scrubber
        self._entity_vault = entity_vault
        self._nudge = nudge_assembler
        self._scratchpad = scratchpad

    async def process_event(self, event: TaskEvent) -> None:
        """Handle an incoming event from core (new data, DIDComm message, etc.)"""
        # 1. Classify silence level (should we interrupt?)
        # 2. If silent → store for briefing, ACK task, return
        # 3. If notify/interrupt → assemble nudge via multi-step reasoning
        # 4. Nudge assembly may checkpoint to scratchpad for crash recovery
        # 5. Send nudge to core for client delivery
        # 6. ACK task

    async def reason_query(self, query: str) -> ReasonResult:
        """Handle a complex query routed from core (needs LLM reasoning)."""
        # 1. Generate query embedding
        # 2. Call core for hybrid search (FTS5 + semantic)
        # 3. Assemble context from results
        # 4. PII-scrub context for cloud LLM (or skip if local)
        # 5. Call LLM with context
        # 6. Rehydrate response (Entity Vault pattern)
        # 7. Return answer
```

```python
# service/llm_router.py

class LLMRouter:
    """Routes LLM tasks to the best available provider."""

    def __init__(
        self,
        providers: dict[str, LLMProvider],  # "llama", "gemini", "claude"
        config: LLMRoutingConfig,
    ):
        self._providers = providers
        self._config = config

    async def complete(self, messages: list[dict], *, task_type: str, persona: str) -> str:
        """Select provider based on task type and persona sensitivity."""
        # Sensitive persona + llama available → llama (never leaves node)
        # Sensitive persona + no llama → Entity Vault scrub → cloud
        # Simple task + llama available → llama
        # Complex reasoning → cloud (with PII scrub)
        provider = self._select_provider(task_type, persona)
        return await provider.complete(messages)
```

```python
# service/entity_vault.py

class EntityVaultService:
    """
    Scrubs identifying entities before cloud LLM calls.
    Creates ephemeral per-request token maps.
    Rehydrates tokens in LLM responses.
    """

    def __init__(self, scrubber: PIIScrubber, core_scrubber: CoreClient):
        self._scrubber = scrubber    # spaCy NER (Tier 2)
        self._core = core_scrubber   # Tier 1 regex via core

    async def scrub_and_call(
        self,
        llm: LLMProvider,
        messages: list[dict],
    ) -> str:
        # 1. Tier 1: core regex scrub (structured PII)
        # 2. Tier 2: spaCy NER scrub (contextual entities)
        # 3. Build entity_map: {"[PERSON_1]": "Dr. Sharma", "[ORG_1]": "Apollo Hospital"}
        # 4. Call cloud LLM with scrubbed messages
        # 5. Rehydrate response: "[PERSON_1]" → "Dr. Sharma"
        # 6. Discard entity_map (ephemeral, never persisted)
        # 7. Return rehydrated response
```

```python
# service/sync_engine.py

class SyncEngine:
    """Orchestrates data ingestion from external sources via MCP."""

    def __init__(
        self,
        core: CoreClient,
        mcp: MCPClient,
        llm: LLMRouter,
        triage: TriageClassifier,
    ):
        self._core = core
        self._mcp = mcp
        self._llm = llm
        self._triage = triage

    async def run_sync_cycle(self, source: str) -> SyncResult:
        """
        Full sync cycle for a data source.
        
        Phase 1: fast sync (last 30 days, PRIMARY items only)
        Phase 2: backfill (up to DINA_HISTORY_DAYS)
        """
        # 1. Read last sync cursor from core KV store
        # 2. Fetch new items via MCP → OpenClaw
        # 3. Triage: classify each item as PRIMARY / THIN / SKIP
        # 4. For PRIMARY: generate summary + embedding
        # 5. Store to core vault in batches of 100
        # 6. Update sync cursor
        # 7. Return stats (fetched, stored, skipped)
```

### The Adapter Layer

```python
# adapter/core_http.py

class CoreHTTPClient:
    """Implements CoreClient protocol via HTTP calls to core:8100."""

    def __init__(self, base_url: str, brain_token: str):
        self._base_url = base_url
        self._token = brain_token
        self._session: httpx.AsyncClient | None = None

    async def vault_query(self, persona: str, query: str, **kwargs) -> list[VaultItem]:
        resp = await self._request("POST", "/v1/vault/query", json={
            "persona": persona,
            "q": query,
            **kwargs
        })
        return [VaultItem(**item) for item in resp["items"]]
```

```python
# adapter/llm_llama.py

class LlamaProvider:
    """Implements LLMProvider via OpenAI-compatible API on llama:8080."""

    def __init__(self, base_url: str = "http://llama:8080"):
        self._base_url = base_url

    @property
    def is_local(self) -> bool:
        return True  # Never leaves the Home Node

    async def complete(self, messages: list[dict], **kwargs) -> str:
        # Call llama:8080/v1/chat/completions (OpenAI-compatible)
        ...
```

### Error Handling in Python

Python brain uses typed exceptions caught at service boundaries:

```python
# domain/errors.py

class DinaError(Exception):
    """Base exception for all Dina errors."""

class PersonaLockedError(DinaError):
    """Core returned 403 — persona is locked."""

class CoreUnreachableError(DinaError):
    """Core HTTP endpoint is not responding."""

class LLMError(DinaError):
    """LLM provider returned an error or timed out."""

class MCPError(DinaError):
    """MCP agent (OpenClaw) failed or is unavailable."""
```

Routes catch service exceptions and return structured HTTP errors:

```python
# dina_brain/routes/process.py

@router.post("/v1/process")
async def process_event(event: TaskEventRequest, guardian: GuardianLoop = Depends()):
    try:
        await guardian.process_event(event.to_domain())
        return {"status": "ok"}
    except PersonaLockedError as e:
        raise HTTPException(403, detail={"code": "persona_locked", "message": str(e)})
    except CoreUnreachableError:
        raise HTTPException(502, detail={"code": "core_unreachable"})
```

### Wiring in main.py

Same principle as Go — the composition root is explicit, no magic:

```python
# main.py

from fastapi import FastAPI

def create_app() -> FastAPI:
    cfg = load_config()

    # 1. Construct adapters
    core_client   = CoreHTTPClient(cfg.core_url, cfg.brain_token)
    llama_client  = LlamaProvider(cfg.llama_url) if cfg.llama_available else None
    gemini_client = GeminiProvider(cfg.google_api_key)
    mcp_client    = MCPStdioClient(cfg.openclaw_url)
    spacy_scrubber = SpacyScrubber(model="en_core_web_sm")

    # 2. Construct services
    llm_router    = LLMRouter(providers={"llama": llama_client, "gemini": gemini_client}, config=cfg.llm)
    entity_vault  = EntityVaultService(scrubber=spacy_scrubber, core_scrubber=core_client)
    nudge         = NudgeAssembler(core=core_client, llm=llm_router, entity_vault=entity_vault)
    scratchpad    = ScratchpadService(core=core_client)
    sync_engine   = SyncEngine(core=core_client, mcp=mcp_client, llm=llm_router, triage=TriageClassifier(llm_router))
    guardian      = GuardianLoop(core=core_client, llm_router=llm_router, scrubber=spacy_scrubber, 
                                 entity_vault=entity_vault, nudge_assembler=nudge, scratchpad=scratchpad)

    # 3. Build apps
    master = FastAPI()
    brain_api = create_brain_api(guardian, sync_engine, cfg.brain_token)
    admin_ui  = create_admin_ui(core_client, cfg)

    master.mount("/api", brain_api)
    master.mount("/admin", admin_ui)

    @master.get("/healthz")
    async def healthz():
        return {"status": "ok"}

    return master
```

---

## Design Patterns — Complete Catalog

### 1. Repository Pattern (Go Core — Vault Access)

Every SQLite table is accessed through a repository interface. The implementation handles SQL, encryption, connection pooling. The service layer sees only typed Go objects.

**Where:** `port/vault.go` (interface) → `adapter/sqlite/vault.go` (implementation)

**Why:** SQLCipher is a complex dependency. Isolating it behind an interface means services can be tested with in-memory fakes, and the database engine can be replaced without touching business logic.

### 2. Outbox Pattern (Go Core — Task Queue)

When core receives an event for brain, it writes to `dina_tasks` table first, then sends to brain. If brain doesn't ACK within the timeout, the watchdog goroutine resets the task to `pending`. Brain picks it up on the next cycle.

**Where:** `service/task.go` + `adapter/sqlite/identity.go` (dina_tasks table)

**Why:** Brain is unreliable (Python, large dependency tree, OOM-prone). Core must never lose an event because brain crashed mid-processing. The outbox pattern guarantees at-least-once delivery with deduplication via task IDs.

### 3. Circuit Breaker (Go Core — Brain Client)

The brain HTTP client wraps calls in a circuit breaker. After N consecutive failures, the circuit opens and fast-fails for a cooldown period. This prevents core from hanging on a dead brain.

**Where:** `adapter/brain/circuit.go`

**States:**
```
CLOSED  →  (N failures)  →  OPEN  →  (cooldown)  →  HALF-OPEN  →  (success)  →  CLOSED
                                                                 →  (failure)  →  OPEN
```

**Why:** Without a circuit breaker, a crashed brain causes core's HTTP handler goroutines to pile up waiting for brain responses, eventually exhausting core's resources. Circuit breaker ensures core stays responsive even when brain is down.

### 4. Strategy Pattern (Go Core — Vault Unlock Mode)

Security mode vs Convenience mode is a strategy. Both implement the same interface:

```go
type SeedObtainer interface {
    ObtainSeed(ctx context.Context) ([]byte, error)
}
```

`SecurityModeObtainer` prompts for passphrase, derives KEK, unwraps seed. `ConvenienceModeObtainer` reads the keyfile. Selected at startup based on `config.json`, used by `main.go`. No conditional logic scattered through the codebase.

**Where:** `config/` + `adapter/crypto/keywrap.go`

### 5. Chain of Responsibility (Python Brain — PII Scrubbing)

PII scrubbing is a pipeline of scrubbers. Each one processes text and passes the result to the next:

```
Raw text → Tier 1 (regex, via core) → Tier 2 (spaCy NER, local) → [Tier 3 (LLM NER, optional)] → Scrubbed text
```

Each scrubber implements the same `PIIScrubber` protocol. They compose into a `ScrubberChain` that runs them in order and merges their replacement maps.

**Where:** `service/entity_vault.py` + `adapter/scrubber_spacy.py`

**Why:** Adding Tier 3 (LLM-based NER) shouldn't require changing Tier 1 or Tier 2 code. Each tier is independently testable.

### 6. State Machine (Go Core — Dead Drop Ingress)

The ingress router is a state machine with two states: `VaultLocked` and `VaultUnlocked`. The state determines the code path for incoming messages:

```
VaultUnlocked: decrypt in-memory → check DID → per-DID rate limit → process
VaultLocked:   IP rate limit → check spool quota → write blob → 202 Accepted
```

On vault unlock, the sweeper transitions pending blobs through the VaultUnlocked path.

**Where:** `ingress/router.go`

**Why:** The two code paths have fundamentally different capabilities (can/cannot decrypt). A state machine makes this explicit rather than scattering `if vault.IsUnlocked()` checks throughout the code.

### 7. Observer Pattern (Go Core — Vault State Notifications)

When the vault transitions from locked to unlocked, multiple goroutines need to wake up: the Dead Drop sweeper, the task watchdog, the reminder loop. Rather than coupling them to the vault, the vault manager emits events via a channel:

```go
type VaultEvent struct {
    Type    VaultEventType // Unlocked, Locked, PersonaOpened, PersonaClosed
    Persona domain.PersonaName
}
```

Goroutines select on this channel alongside their own timers. Clean decoupling.

**Where:** `adapter/sqlite/manager.go` (emits) → `ingress/sweeper.go`, `reminder/loop.go` (listen)

### 8. Cognitive Checkpointing (Python Brain — Scratchpad)

Multi-step reasoning (the Sancho nudge is 5 steps) checkpoints intermediate results to the vault via core. If brain crashes mid-step, it resumes from the last checkpoint on retry.

```python
# Step 1: Get relationship
scratchpad = await core.vault_query(type="scratchpad", task_id=task_id)
if scratchpad and scratchpad["step"] >= 1:
    relationship = scratchpad["context"]["relationship"]  # resume
else:
    relationship = await core.vault_query(...)             # fresh
    await core.vault_store(type="scratchpad", ...)         # checkpoint
```

**Where:** `service/scratchpad.py`

**Why:** LLM calls are expensive (time + money). Redoing steps 1-3 because brain crashed during step 4 wastes both. Checkpointing makes retries resume from the failure point.

### 9. Functional Options (Go Core — Configuration)

Complex constructors use the functional options pattern to keep required parameters explicit and optional ones chainable:

```go
pool, err := sqlite.NewVaultPool(
    persona,
    dek,
    sqlite.WithReadPoolSize(8),
    sqlite.WithBusyTimeout(5000),
    sqlite.WithWALCheckpoint(1000),
)
```

**Where:** `adapter/sqlite/pool.go`, `adapter/brain/client.go`

**Why:** Avoids config structs with 15 fields where you can't tell which ones are required. Required params are positional; optional params are chainable with sensible defaults.

### 10. Sealed Envelope (Go Core — Message Construction)

Message construction follows a build → sign → encrypt → seal sequence where each step produces an immutable type:

```go
// domain/message.go

type PlaintextMessage struct { ... }    // Constructed by brain/service
type SignedMessage struct { ... }       // After signing (plaintext + signature)
type EncryptedEnvelope struct { ... }   // After encryption (ciphertext only)
```

You can't encrypt an unsigned message because `Encrypt()` requires a `SignedMessage` input, not a `PlaintextMessage`. The type system enforces the correct cryptographic ordering.

**Where:** `domain/message.go` + `service/transport.go`

---

## Testing Strategy Alignment

The code architecture is designed to make every test section from the test plan trivially implementable:

| Test Section | What's Tested | How It's Isolated |
|---|---|---|
| §1 Auth | `middleware/auth.go` | HTTP test server + real middleware, fake backend |
| §2 Crypto | `adapter/crypto/*` | Pure functions, no dependencies, golden file comparisons |
| §3 Identity | `adapter/did/*` + `service/identity.go` | Fake KeyDeriver, mock PLC directory HTTP |
| §4 Vault | `adapter/sqlite/*` | In-memory SQLCipher databases (`:memory:` with encryption) |
| §5 PII | `adapter/pii/*` | Pure regex, table-driven test cases |
| §6 Gatekeeper | `service/gatekeeper.go` | Fake VaultManager (controls open/locked state) |
| §7 Transport | `service/transport.go` + `ingress/*` | Fake Encryptor, fake DIDResolver, in-memory outbox |
| §8 Task Queue | `service/task.go` | Fake Clock (control time), in-memory task store |
| §9 WebSocket | `websocket/*` | `httptest` server + WebSocket client, fake auth |
| §10 Pairing | `service/device.go` | Fake Clock, in-memory device store |

**The key insight:** Because every external dependency is behind a port interface, every test section can inject fakes for everything except the code under test. No Docker required for unit tests. No network required. No filesystem required. No real time required.

### The Test Fake Strategy

Fakes live in `test/testutil/` (Go) and `tests/fakes/` (Python). They implement port interfaces with in-memory state:

```go
// test/testutil/vault.go

type FakeVaultManager struct {
    openPersonas map[domain.PersonaName]bool
    items        map[string]domain.VaultItem
}

func (f *FakeVaultManager) IsOpen(persona domain.PersonaName) bool {
    return f.openPersonas[persona]
}

// Used in gatekeeper tests:
// vault := testutil.NewFakeVault()
// vault.SetLocked("/financial")
// gatekeeper := service.NewGatekeeper(vault, ...)
// err := gatekeeper.CheckAccess(ctx, BrainToken, "/financial", ActionRead)
// assert.ErrorIs(t, err, domain.ErrPersonaLocked)
```

**Why fakes over mocks:** Mocks verify behavior ("was this method called with these arguments?"). Fakes verify outcomes ("given this state, does the service produce the correct result?"). Fakes are reusable across test sections. Mocks create tight coupling between tests and implementation details.

---

## Security Patterns

### 1. Zero-Trust Between Containers

Brain is untrusted. Every request from brain is authenticated (`BRAIN_TOKEN`), authorized (gatekeeper checks persona tier), and audited. The auth middleware in `middleware/auth.go` treats brain requests identically to external client requests — verify token, check endpoint ACL, log.

### 2. Constant-Time Token Comparison

`BRAIN_TOKEN` comparison uses `subtle.ConstantTimeCompare`. CLIENT_TOKEN validation hashes the presented token before database lookup. Both paths add a small uniform delay on failure to prevent timing attacks (Issue #10 from architecture review).

### 3. Memory Zeroing

Master seed and DEKs are stored in `[]byte` slices that are explicitly zeroed on shutdown and when personas are locked:

```go
func zeroBytes(b []byte) {
    for i := range b {
        b[i] = 0
    }
    runtime.KeepAlive(b) // prevent compiler from optimizing away the zeroing
}
```

### 4. No PII in Logs — Enforced by Types

The structured logger accepts only typed log fields, not raw strings:

```go
type LogField struct {
    Key   string
    Value string
}

func PersonaField(p domain.PersonaName) LogField { return LogField{"persona", string(p)} }
func CountField(n int) LogField                   { return LogField{"count", strconv.Itoa(n)} }
func LatencyField(d time.Duration) LogField       { return LogField{"latency_ms", ...} }
// No generic StringField. You can't accidentally log user content.
```

CI linter enforces: no `slog.String("query", ...)`, no `log.Info(fmt.Sprintf(..., userInput))`.

### 5. Immutable Configuration After Startup

`domain.GatekeeperConfig` and `domain.LLMRoutingConfig` are loaded once at startup and passed as values (not pointers) to services. No runtime mutation of security-critical configuration. Changes require restart.

---

## Dependency Graph (Condensed)

```
main.go
 │
 ├── config/          ← loads config.json + Docker Secrets + env
 │
 ├── adapter/         ← constructs concrete implementations
 │   ├── sqlite/      ← depends on: go-sqlcipher, domain, port
 │   ├── crypto/      ← depends on: libsodium-go, x/crypto, domain, port
 │   ├── did/         ← depends on: indigo (Bluesky), domain, port
 │   ├── pii/         ← depends on: regexp (stdlib), domain, port
 │   ├── brain/       ← depends on: net/http (stdlib), domain, port
 │   └── pds/         ← depends on: indigo, domain, port
 │
 ├── service/         ← depends on: port, domain (NEVER adapter)
 │
 ├── handler/         ← depends on: service, domain (NEVER adapter)
 │
 ├── middleware/       ← depends on: domain (token types)
 │
 ├── websocket/       ← depends on: gorilla/websocket, domain, port
 │
 ├── ingress/         ← depends on: domain, port
 │
 └── reminder/        ← depends on: domain, port
```

**Third-party dependency count (Go Core):**
- `go-sqlcipher` — SQLCipher bindings (CGO, single vendored dependency)
- `GoKillers/libsodium-go` — NaCl bindings (CGO)
- `gorilla/websocket` — WebSocket implementation
- `bluesky-social/indigo` — AT Protocol / did:plc
- `x/crypto` — Argon2id, HKDF (stdlib extension, maintained by Go team)

Five external dependencies. Everything else is Go stdlib. This is deliberate — every dependency is an attack surface. The fewer, the better for a security-critical system.

**Third-party dependency count (Python Brain):**
- `fastapi` + `uvicorn` — HTTP server
- `httpx` — async HTTP client (for core + cloud LLM calls)
- `google-adk` — Agent Development Kit
- `spacy` — NER (Tier 2 PII)
- `structlog` — structured logging

Brain has a larger dependency surface by design — it's the "untrusted tenant" that handles AI/ML libraries. Core treats it accordingly.

---

## What This Architecture Optimizes For

**Testability.** Every component can be tested in isolation with fakes. No Docker, no network, no filesystem, no real time needed for unit tests.

**Auditability.** The dependency graph is explicit. You can read `main.go` and trace every data path. No framework magic, no auto-wiring, no reflection-based discovery.

**Security containment.** If brain is compromised, the blast radius is limited to open persona data. Core's gatekeeper enforces this structurally, not by hoping brain is honest.

**Replaceability.** Want to swap Google ADK for Claude Agent SDK? Write new adapter, plug into same ports. Want to move from SQLCipher to libSQL? Write new adapter. The service layer doesn't change.

**Longevity.** No framework lock-in in core. Pure Go stdlib for HTTP. Interfaces for everything. When Go 2.0 ships, or when a better SQLite library appears, migration is a single adapter replacement, not a rewrite.