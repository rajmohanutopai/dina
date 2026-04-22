# `@dina/home-node-lite-brain-server`

Fastify-based Brain HTTP server for Dina's Home Node Lite.

**Status:** scaffold (task 5.1 / 5.2 done — boot + deps + scaffold
health route). Route binding + LLM routing + notify bridge land in
tasks 5.3 – 5.49.

## Role

This is the app-layer wrapper around `@dina/brain`. The pure-brain
package stays runtime-agnostic (transport injected); this server
binds it to:

- **HTTP surface** — Fastify serves `/api/*` for Brain, `/admin/*`
  for the admin UI (form factor per task 5.50).
- **CoreClient transport** — `HttpCoreTransport` from `@dina/core`
  (signed HTTP back to the Core server on `:8100`).
- **Platform adapters** — `@dina/adapters-node` gives Brain the Node
  implementations of crypto/fs/keystore/net/storage ports.

The Go/Python production stack uses a Python FastAPI Brain; this
Fastify Brain targets the **Node build target** described in
`docs/HOME_NODE_LITE_TASKS.md` decision #2 (two Node processes on
server, one JS VM on mobile).

## Layout

```
apps/home-node-lite/brain-server/
├── package.json
├── tsconfig.json
├── jest.config.js
├── src/
│   ├── bin.ts            # `dina-home-node-lite-brain` entry point
│   ├── main.ts           # composition-root re-export
│   ├── boot.ts           # ordered boot: config → logger → server → listen
│   ├── config.ts         # env-driven config with Zod validation
│   └── logger.ts         # pino wrapper (matches core-server conventions)
└── __tests__/
    └── scaffold.test.ts  # proves scaffold boots, emits healthz, closes
```

## Port convention

- `:8200` — Brain API + admin UI. Matches Go/Python Brain's default
  (`ARCHITECTURE.md` + task 5.3's `DEFAULT_BRAIN_PORT`). Paired with
  Core on `:8100`.
- Override via `DINA_BRAIN_PORT` when running Lite and the Go/Python
  stack side-by-side on one host.

## Roadmap (docs/HOME_NODE_LITE_TASKS.md Phase 5)

- **5a. Bootstrap** — 5.1 ✅ scaffold, 5.2 ✅ deps, 5.7 ✅ bin.
- **5b. HttpCoreTransport concrete impl** — wire fetch + signing.
- **5c. Brain API routes** — `/api/v1/ask`, `/api/v1/reason`,
  `/api/v1/process`, plus sub-app mounts.
- **5d. LLM routing** — provider selection, fallback, 5.29 llama
  feasibility.
- **5e. Agent orchestration** — delegation + OpenClaw MCP.
- **5f. Notify bridge** — Brain → Core push envelopes.
- **5g. Admin UI** — CLIENT_TOKEN auth, dashboards, approvals.
- **5h. Observability** — metrics, traces, structured logs.
- **5i. Operational concerns** — shutdown sequencing, connector
  lifecycle.
