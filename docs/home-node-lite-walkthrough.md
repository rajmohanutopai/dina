# Home Node Lite — a walkthrough

This is the long-form companion to
[`apps/home-node-lite/README.md`](../apps/home-node-lite/README.md)
(the quickstart) and [`docs/try-lite.md`](./try-lite.md) (the
10-minute narrative). Read this when you want to understand *how
the pieces fit together* — where a user request enters the system,
which package owns it, and how it lands on disk.

The audience is engineers: either contributing to Dina or
implementing a compatible Dina in another language.

> **Status: pre-M1.** Every piece described here exists as code in
> the repo today (you can `npm test` all of it), but the end-to-end
> user flows (`/ask`, pair-device, D2D delivery) land across
> milestones M1–M5 per
> [`docs/HOME_NODE_LITE_TASKS.md`](./HOME_NODE_LITE_TASKS.md). This
> walkthrough describes both what's shipped and what's scaffolded.

## Why a second implementation exists

Dina's production stack is Go Core + Python Brain — mature, backed
by thousands of integration tests, and what `./install.sh` at the
repo root gives you today. Home Node Lite is the same architecture
re-implemented in pure TypeScript, for two reasons:

1. **Mobile.** React Native / Expo runs one JavaScript VM. Go and
   Python don't ship on mobile in any reasonable way. A TS
   implementation of `@dina/core` + `@dina/brain` runs both a
   Node server and the mobile app without duplicating domain logic.
2. **Operator ergonomics.** A lot of home-lab operators are already
   comfortable with `npm install`. Dropping the Go/Python setup
   requirement expands the pool of people who can run their own
   Dina.

The deeper rationale lives in
[`ARCHITECTURE.md`](../ARCHITECTURE.md) under *Architectural
Decision: Two-Stack Implementation — Production (Go/Python) + Lite
(TypeScript)*. Short version: production is the correctness oracle;
Lite is validated against it; both speak the identical wire
protocol.

## The layout, top-down

```
dina/
├── packages/                   shared TypeScript workspace
│   ├── protocol/               wire types + canonical signing + validators (zero deps)
│   ├── core/                   pure vault / identity / audit / trust domain
│   ├── brain/                  pure analyst — ingestion, reason, nudge
│   ├── fixtures/               canonical test data (DID docs, vault items, …)
│   ├── test-harness/           shared mocks + fakes
│   │
│   ├── storage-node/           SQLCipher adapter (better-sqlite3-multiple-ciphers)
│   ├── crypto-node/            crypto primitives (@noble/*, argon2, libsodium)
│   ├── fs-node/                filesystem adapter
│   ├── net-node/               HTTP / WebSocket adapter
│   ├── keystore-node/          OS keystore adapter
│   ├── adapters-node/          meta-package that re-exports the above
│   │
│   ├── storage-expo/           SQLCipher via op-sqlite (mobile)
│   ├── crypto-expo/            crypto for React Native
│   ├── fs-expo/                expo-file-system wrapper
│   ├── net-expo/               fetch + WebSocket (React Native)
│   ├── keystore-expo/          react-native-keychain wrapper
│   └── adapters-expo/          meta-package for mobile
│
└── apps/
    ├── home-node-lite/
    │   ├── core-server/        Fastify Core app (port 8100)
    │   ├── brain-server/       Fastify Brain app (port 8200)
    │   └── docker/             Dockerfiles + compose (Phase 7)
    │
    └── mobile/                 Expo app (iOS + Android)
```

### The layering rule

There are three tiers and they imports only downwards:

- **Pure (`packages/protocol`, `packages/core`, `packages/brain`,
  `packages/fixtures`, `packages/test-harness`)** — no crypto
  backend, no HTTP client, no filesystem. Depends on other pure
  packages only. Runs anywhere a JS runtime runs.
- **Platform adapters (`packages/*-node`, `packages/*-expo`)** —
  implement the port interfaces defined in `packages/core`. One
  pair per platform. Depend on pure packages + the platform's
  native modules (`better-sqlite3-multiple-ciphers`, `op-sqlite`,
  `react-native-keychain`, etc.).
- **Apps (`apps/home-node-lite/core-server`, `apps/home-node-lite/
  brain-server`, `apps/mobile`)** — wire pure packages to platform
  adapters at startup. Own the HTTP routes (or React Native UI) +
  env config.

A violation — e.g., `packages/brain` importing `fetch` — is caught
by the lint gate in `eslint.config.mjs` (task 1.33). A violation
that makes it past lint is caught by test-harness interfaces that
force platform concerns to come through injected ports.

## The security boundary

Dina's architectural promise is: Brain is untrusted; Core owns the
keys. The boundary is enforced differently depending on runtime —
this is worth getting explicit about.

**On a server** (both Go/Python and Lite):

- Two OS processes in separate Docker containers.
- Core's signing-key file is bind-mounted **only** into Core's
  container. Brain's container has no path that resolves to it —
  `open("/var/lib/dina/service.key")` inside Brain returns ENOENT
  not "permission denied".
- Every Brain→Core request carries four headers: `X-DID`,
  `X-Timestamp`, `X-Nonce`, `X-Signature`. Core verifies the
  Ed25519 signature over the canonical payload before routing.
- Nonce cache (5-min TTL per DID) rejects replays. Timestamp
  window (±5 min) rejects stale requests.

A compromised Brain on the server can make the same requests Brain
was already allowed to make — subject to the 4-tier persona
gatekeeper + audit log. It cannot steal the root signing key
(never in its process) and cannot read unlocked vault files
directly (different bind mount).

**On mobile** (Lite only):

- One JavaScript VM. Brain and Core share the address space.
- The boundary is the TypeScript import graph. `@dina/brain`
  imports the `CoreClient` interface from `@dina/core`; at wire-up
  time the app gives it an `InProcessTransport` which dispatches
  typed method calls through `CoreRouter` directly.
- Handler-level enforcement still runs: sensitive-persona
  gatekeeper, locked-persona `403`, audit log. All the rules
  inside Core's handlers fire regardless of transport.

The mobile boundary is weaker than the server boundary. Documented
+ accepted: a compromised Brain on mobile has the same access as a
compromised userspace process on the device, which is the ceiling
of what mobile OS isolation provides anyway. See
[`docs/security-walkthrough.md`](./security-walkthrough.md)
→ *The Core / Brain Boundary* for the full discussion.

## How a request flows — `POST /api/v1/ask` example

Walking through what happens when a user types a question. M1
ships this end-to-end; right now the pieces exist but the route
binding in `brain-server` is still in Phase 5c.

```
          ┌────────────────────────────────────────────────┐
 user ───►│ CLI (dina ask "…")                             │
          │   • signs request with device key              │
          │   • X-DID, X-Timestamp, X-Nonce, X-Signature   │
          └────────────────────┬───────────────────────────┘
                               │ HTTP
                               ▼
          ┌────────────────────────────────────────────────┐
          │ apps/home-node-lite/core-server (Fastify)      │
          │                                                │
          │  auth middleware → verify signature            │
          │   ↓                                            │
          │  rate limit + gatekeeper (persona tier check)  │
          │   ↓                                            │
          │  @dina/core routes ─► /api/v1/ask              │
          │                        (forwards to Brain)     │
          └────────────────────┬───────────────────────────┘
                               │ HTTP, signed with Core's DID
                               ▼
          ┌────────────────────────────────────────────────┐
          │ apps/home-node-lite/brain-server (Fastify)     │
          │                                                │
          │  @dina/brain.ask(persona, question, context)   │
          │   ↓                                            │
          │  HttpCoreTransport (CoreClient impl) ─► Core   │
          │    • vaultQuery  → hybrid search               │
          │    • piiScrub    → redact outbound             │
          │    • memoryToC   → working memory              │
          │   ↓                                            │
          │  LLM provider (@dina/brain/llm/*)              │
          │   ↓                                            │
          │  HttpCoreTransport ─► Core                     │
          │    • piiRehydrate   → restore redactions       │
          │    • notify         → push to client           │
          └────────────────────┬───────────────────────────┘
                               │
                               ▼
                               Answer rendered to user
```

The injected `CoreClient` is the abstraction that makes this flow
transport-agnostic. On the server it's `HttpCoreTransport` (signed
HTTP). On mobile it's `InProcessTransport` (direct dispatch).
Brain never knows which.

## Packages you'll actually touch

### `@dina/protocol`

Wire types + canonical signing + frame constants. Pure, zero runtime
deps. 9 frozen conformance vectors + a runnable test suite live
under `packages/protocol/conformance/` — external implementations
target this surface to claim compatibility. See
[`packages/protocol/docs/conformance.md`](../packages/protocol/docs/conformance.md)
for the spec.

### `@dina/core`

Vault (SQLCipher via `DatabaseAdapter` port), identity + DID
resolution, audit log, gatekeeper, trust network, ingestion
staging. This is the heavy package — most domain logic lives here.
Tests run against `InMemoryDatabaseAdapter`; real-SQLite behaviour
is cross-checked by `@dina/storage-node`'s integration test
(`core_integration.test.ts`) — the gate that proves the in-memory
mock's looseness doesn't hide real SQL bugs (task 3.17).

### `@dina/brain`

Analyst layer. Ingests content, classifies intent, reasons over
vault context, writes nudges, mediates agent-gateway approvals.
Imports the `CoreClient` interface only — transport is injected by
the app layer. An ESLint gate (`eslint.config.mjs` block 6, task
1.33) forbids Brain code from importing `fetch` / `undici` / `ws`
/ `node:http` / `@fastify/*` so the runtime-agnostic property
stays intact.

### `@dina/storage-node`

SQLCipher adapter for server-side Node. 128 tests covering:
encrypted open/close, pragma application (WAL, synchronous=NORMAL
for vault / synchronous=FULL for identity), full CRUD, FTS5 with
the `unicode61 remove_diacritics 1` tokenizer, blob round-trip,
per-persona file multiplexing, migration runner, concurrent access
under WAL, perf smoke (10K items, FTS5 p95 < 50ms). See
[`packages/storage-node/README.md`](../packages/storage-node/README.md).

### `apps/home-node-lite/core-server` + `brain-server`

Fastify app-layer wrappers. Each exposes a handful of env vars
(`DINA_CORE_PORT`, `DINA_BRAIN_PORT`, `DINA_VAULT_DIR`, …), parses
them with Zod, wires a pino logger, starts the Fastify listener,
and registers SIGINT/SIGTERM → graceful close.

## How the test story fits together

Five tiers, each catching a different class of regression:

1. **Unit tests** (inside each package). Pure-function + class
   tests. Fast. Mocks at the port boundary.
2. **Cross-package integration** (in `@dina/storage-node`'s
   `core_integration.test.ts` + similar). Runs real migrations +
   real SQL against a real adapter. Task 3.17 landed this.
3. **Conformance suite** (`packages/protocol/conformance/`). 9
   frozen vectors. Self-checks the reference + exposes an HTTP
   harness for external implementations.
4. **Lite suite in `run_all_tests.sh`** (task 12.7). Runs every
   workspace's `npm test` as a Phase 1b gate before the Go/Python
   Docker non-unit tests.
5. **Milestone integration tests** (Phase 8 in the task plan).
   M1–M5 gates validate the Lite stack against the same
   `tests/integration/` suite the Go/Python stack satisfies.

Every tier is green today except Phase 5 above, which lands across
M1–M5.

## Where to go next

- **Quickstart:** [`apps/home-node-lite/README.md`](../apps/home-node-lite/README.md)
- **First-use narrative:** [`docs/try-lite.md`](./try-lite.md)
- **Two-stack decision (why a second implementation):**
  [`ARCHITECTURE.md`](../ARCHITECTURE.md) → *Architectural Decision: Two-Stack Implementation*
- **Security boundary detail:** [`docs/security-walkthrough.md`](./security-walkthrough.md)
- **Task plan + milestones:** [`docs/HOME_NODE_LITE_TASKS.md`](./HOME_NODE_LITE_TASKS.md)
- **Conformance spec (for third-party implementations):**
  [`packages/protocol/docs/conformance.md`](../packages/protocol/docs/conformance.md)
