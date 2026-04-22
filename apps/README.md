# Dina TS Apps

Build targets that consume the shared packages in `../packages/`.

## Targets

### `home-node-lite/` — Node server (active)

Two Fastify processes, following the "Brain is an untrusted tenant" boundary from the Go + Python production stack:

- **`core-server/`** — wraps the pure `CoreRouter` from `@dina/core` with Fastify + Node adapters (`@dina/adapters-node`). Owns vault keys, SQLCipher, MsgBox client, pairing, persona gatekeeper, DID / PLC flows.
- **`brain-server/`** — wraps the pure Brain pipeline from `@dina/brain` with Fastify + Node adapters. Calls Core via a signed `HttpCoreTransport`, never shares memory space with Core.

Deployment: `docker-compose.lite.yml`, one container per process, key material bind-mounted only into the owning container.

### `mobile/` — Expo / React Native (lands in Phase 1)

Single RN JS VM hosting the full home-node logic locally:

- Consumes the same pure packages (`@dina/core`, `@dina/brain`, `@dina/protocol`)
- Brain calls Core via `InProcessTransport` (direct router dispatch, no HTTP hop)
- Platform adapters: `@dina/adapters-expo` (op-sqlite, expo-crypto, expo-secure-store, expo-file-system)
- Security boundary: OS app sandbox + module scoping. Weaker than the server's two-process isolation, documented as an accepted runtime-dependent tradeoff in `docs/security-walkthrough.md` (Phase 12)

## What both targets share

- Same `@dina/core`, `@dina/brain`, `@dina/protocol` — no duplication
- Same business logic, same error types, same wire format on every external boundary
- Only the adapter layer and the Core↔Brain transport differ

## See also

- `../docs/HOME_NODE_LITE_TASKS.md` — task plan including milestone-by-milestone parity gates
- `../packages/README.md` — layering rules that keep mobile ↔ server code sharing honest
