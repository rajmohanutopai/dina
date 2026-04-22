# `@dina/home-node-lite-core-server`

Fastify-based HTTP server that hosts Dina's **Core** surface for the
Home Node Lite deployment target. Parity target is the Go Core in
`core/` — same endpoints, status codes, field names, field types,
error-envelope keys. Exact error message strings are tracked per-test
in M5, not globally here.

**Status:** scaffolding — config loader (task 4.4-4.5) landed.
Remaining tasks lie in `docs/HOME_NODE_LITE_TASKS.md` Phase 4a-4f.

## Who runs this

An operator spins this up on their Home Node (VPS, Raspberry Pi, or
managed service) alongside `brain-server` and (optionally) an LLM
sidecar. Client devices connect in via the standard Dina pairing flow.

## Composition

This app is wiring + HTTP transport — no business logic. It imports:

- `@dina/core` — all route handlers, domain services, router, storage
  port.
- `@dina/adapters-node` — crypto (Ed25519, argon2, sealed-box),
  filesystem, keystore, network (http + ws). See
  [packages/adapters-node](../../../packages/adapters-node/README.md).
- `@dina/protocol` — wire-format types + canonical-sign helpers.
- `fastify`, `pino`, `zod` — ecosystem libs.

## Package layout

```
apps/home-node-lite/core-server/
├── package.json            # workspace package, binned as
│                           # `dina-home-node-lite-core`
├── tsconfig.json
├── jest.config.js
├── src/
│   ├── bin.ts              # `#!/usr/bin/env node` entry (task 4.12)
│   ├── main.ts             # boot ordering (task 4.3)
│   ├── config.ts           # env → typed config (tasks 4.4-4.5)
│   └── ...                 # rest lands per Phase 4 tasks
├── __tests__/
│   └── config.test.ts      # env parse + Zod validation tests
└── README.md
```

## Boot ordering (target shape, not yet fully wired)

1. Parse + validate config (`config.ts`)
2. Load / generate identity (keystore)
3. Open DB (SQLCipher; pending `@dina/storage-node`)
4. Wire adapters into Core's DI points
5. Register `CoreRouter` routes onto Fastify
6. Start Fastify
7. Connect to MsgBox relay

See `docs/HOME_NODE_LITE_TASKS.md` Phase 4a for the full checklist.

## See also

- [docs/HOME_NODE_LITE_TASKS.md](../../../docs/HOME_NODE_LITE_TASKS.md)
  Phase 4.
- [packages/core/README.md](../../../packages/core/README.md) —
  the TypeScript Core this server hosts.
