# Home Node Lite

Pure-TypeScript implementation of the Dina Home Node, running as two
Node processes in the same architectural pattern as the Go Core +
Python Brain production stack.

> **Status: pre-M1.** See
> [`docs/HOME_NODE_LITE_TASKS.md`](../../docs/HOME_NODE_LITE_TASKS.md)
> for the milestone plan. M1 (pair + ask + remember + D2D delivery)
> is the first ship-able milestone.

## Layout

```
apps/home-node-lite/
├── core-server/      Fastify Core — sovereign cryptographic kernel
│                     (task 4.x; port 8100)
├── brain-server/     Fastify Brain — LLM + orchestration + admin UI
│                     (task 5.x; port 8200)
└── docker/           Dockerfiles + compose (task 7.x; pending)
```

The two processes mirror the architectural separation that the Go/
Python stack enforces:

| Role    | Pure package      | App wrapper                   | Responsibility |
|---------|-------------------|-------------------------------|----------------|
| Core    | `@dina/core`      | `apps/home-node-lite/core-server/`  | Vault keeper. Owns SQLCipher files + Ed25519 keys. Never interprets, never calls external APIs. |
| Brain   | `@dina/brain`     | `apps/home-node-lite/brain-server/` | Analyst. Thinks, searches, reasons, delegates fetching via MCP. Never holds keys. |

Brain talks to Core through the transport-agnostic `CoreClient`
interface (`@dina/core`) — on the Node server target that's the
signed-HTTP `HttpCoreTransport`; on mobile (where both run in one JS
VM) it's `InProcessTransport`.

## Quickstart — local dev

### Prerequisites

- Node ≥ 22 (`nvm use` honours `.nvmrc`)
- `npm install` at the repo root — populates the workspace
- Native build toolchain is **not** required for the standard target
  arches — `better-sqlite3-multiple-ciphers` ships prebuilt binaries
  for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`,
  `linuxmusl-{arm64,x64}`, `win32-{arm64,x64}`, covering Node 20/22/
  23/24 ABIs (see `packages/storage-node/README.md`).

### Run the Core server

```bash
cd apps/home-node-lite/core-server
npm start              # tsx src/bin.ts
```

Listens on `127.0.0.1:8100` by default. Probe with:

```bash
curl http://127.0.0.1:8100/healthz
# {"status":"ok","version":"0.0.1"}
```

### Run the Brain server

```bash
cd apps/home-node-lite/brain-server
npm start              # tsx src/bin.ts
```

Listens on `127.0.0.1:8200` by default.

```bash
curl http://127.0.0.1:8200/healthz
# {"status":"ok","role":"brain"}
```

## Test

From this directory (runs both apps' Jest suites):

```bash
cd apps/home-node-lite
(cd core-server && npm test)
(cd brain-server && npm test)
```

Or from the repo root (all packages + apps):

```bash
npm test
```

Typecheck everything:

```bash
npm run typecheck      # at repo root
```

## Build

Each app compiles to `dist/` via `npm run build`. The workspace
root `npm run build` runs a composite `tsc --build` across every
package + app.

## Environment variables

### Core server (`DINA_CORE_*`)

Documented in `core-server/src/config.ts`. Most users don't need to
set anything — defaults bind to `127.0.0.1:8100` with WAL-mode
SQLCipher at `$HOME/.dina/core/`.

### Brain server (`DINA_BRAIN_*`)

Documented in `brain-server/src/config.ts`. Scaffold envs: `_HOST`,
`_PORT`, `_LOG_LEVEL`, `_PRETTY_LOGS`. Phase 5 tasks layer on
`DINA_CORE_URL`, `DINA_MODEL_DEFAULT`, provider API keys, config
directory fallback.

## Security posture

- `npm audit` gate — zero high/critical prod vulnerabilities.
  Re-run via `npm run audit:prod` at the repo root. CI should
  fail on non-zero exit. (task 11.13)
- Brain and Core are **separate processes** by design — Brain
  cannot read Core's key file even at the filesystem level
  because they run under separate Docker bind mounts in the
  production layout (task 11.11 verification pending).
- Every HTTP request Brain makes to Core carries Ed25519-signed
  canonical headers via `HttpCoreTransport` (no shared secrets,
  no JWT, no bearer tokens).

## Docker

Docker packaging lands in Phase 7. Target outputs:

- `ghcr.io/rajmohan/dina-home-node-lite-core:latest`
- `ghcr.io/rajmohan/dina-home-node-lite-brain:latest`

Multi-arch (`amd64` + `arm64`) for Raspberry Pi 5 target. Compose
file at `docker/docker-compose.lite.yml`.

## Milestone roadmap (see `docs/HOME_NODE_LITE_TASKS.md`)

| Milestone | Scope                                                           | Target |
|-----------|-----------------------------------------------------------------|--------|
| **M1**    | Pair + ask + remember + D2D delivery, basic PII, default persona | 4-5 weeks |
| **M2**    | 4-tier persona gating, passphrase, audit, storage tiers          | 6-7 weeks |
| **M3**    | Trust Network, service query/response, cart handover             | 8-9 weeks |
| **M4**    | Chaos, crash recovery, migration, perf targets                   | 9-10 weeks |
| **M5**    | Full integration-test parity with Go/Python stack                | 10-12 weeks |

## See also

- [docs/HOME_NODE_LITE_TASKS.md](../../docs/HOME_NODE_LITE_TASKS.md)
  — full task plan, ~500 checkboxes across 14 phases.
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — engineering blueprint
  (applies to both Go/Python stack and this Lite stack).
- [packages/README.md](../../packages/README.md) — layering rules
  for the shared workspace packages.
- [CLAUDE.md](../../CLAUDE.md) — development environment + build
  commands for the full polyglot repo.
