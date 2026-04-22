# @dina/protocol — extraction inventory (task 1.16)

Concrete file-level map of what moves from `@dina/core` → `@dina/protocol` during Phase 1b (tasks 1.17–1.27).

Produced 2026-04-21. Subsequent 1.17+ edits should be checked against this list; any divergence is either a refinement (update this doc) or a miss (fix the move).

## Per-category source files

### 1.16a — DID types (`did:plc`, `did:key`)

| File                                       | Lines | Key exports                                                                                |
| ------------------------------------------ | ----: | ------------------------------------------------------------------------------------------ |
| `packages/core/src/identity/did.ts`        |    97 | `isDIDKey`, `isDIDPlc`, `multibaseToPublicKey`, `publicKeyToDIDKey` (+ `did:*` validators) |
| `packages/core/src/identity/did_models.ts` |    76 | `DIDKeyBundle`, parsing helpers                                                            |

### 1.16b — PLC document shape

| File                                         | Lines | Key exports                                            |
| -------------------------------------------- | ----: | ------------------------------------------------------ |
| `packages/core/src/identity/did_document.ts` |   147 | `VerificationMethod`, `ServiceEndpoint`, `DIDDocument` |

### 1.16c — D2D envelope types (rpc / cancel / service.query / service.response)

| File                                      | Lines | Key exports                                                             |
| ----------------------------------------- | ----: | ----------------------------------------------------------------------- |
| `packages/core/src/d2d/envelope.ts`       |   140 | `D2DPayload`, `DinaMessage`                                             |
| `packages/core/src/d2d/service_bodies.ts` |   154 | `ServiceQueryBody`, `ServiceResponseBody`, `ServiceResponseStatus`      |
| `packages/core/src/d2d/families.ts`       |   146 | 12 `MsgType*` constants (`PresenceSignal`, `CoordinationRequest`, etc.) |
| `packages/core/src/d2d/signature.ts`      |    58 | canonical payload helpers for sig verification                          |

### 1.16d — Auth frame types (MsgBox handshake)

| File                                   | Lines | Key exports                                                                                                                                                                                                                                                             |
| -------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/relay/msgbox_ws.ts` |   485 | `MsgBoxEnvelope`, `WSLike`, `WSFactory`, the `auth_challenge` / `auth_response` / `auth_success` wire types (buried in this large file — extraction should lift just the type definitions + wire-format constants, leaving the connection state machine behind in core) |

**Note**: `msgbox_ws.ts` is a mix of protocol types + runtime state machine. Only the protocol types + frame constants move; the connection state machine stays in `@dina/core`.

### 1.16e — Capability schema + `schema_hash` contract

| File                                          |               Lines | Key exports                                                                                     |
| --------------------------------------------- | ------------------: | ----------------------------------------------------------------------------------------------- |
| `packages/core/src/service/service_config.ts` |                 288 | `ServiceCapabilitySchemas`, `ServiceCapabilityConfig`, `ServiceConfig`, `ServiceResponsePolicy` |
| `packages/core/src/d2d/service_bodies.ts`     | (shared with 1.16c) | `schema_hash` contract fields embedded in `ServiceQueryBody` / `ServiceResponseBody`            |

### 1.16f — Core HTTP envelope types

| File                                          | Lines | Key exports                                                                                 |
| --------------------------------------------- | ----: | ------------------------------------------------------------------------------------------- |
| `packages/core/src/relay/rpc_envelope.ts`     |    87 | `CoreRPCRequest`, `CoreRPCResponse` — the canonical shape of a Core↔MsgBox request envelope |
| `packages/core/src/relay/rpc_response.ts`     |    82 | helpers for building typed responses                                                        |
| `packages/core/src/relay/identity_binding.ts` |    74 | pairing-envelope DID binding checks                                                         |

### 1.16g — Service-endpoint type constants

| File                                      | Lines | Key exports                                                                     |
| ----------------------------------------- | ----: | ------------------------------------------------------------------------------- |
| `packages/core/src/transport/delivery.ts` |   286 | `ServiceType = 'DinaMsgBox' \| 'DinaDirectHTTPS'` constant string-literal union |

**Note**: Only the `ServiceType` type + associated string-literal constants move. The `DeliveryResult` / `WSDeliverFn` types + actual delivery machinery stay in `@dina/core`.

## Files NOT moving

Listed for completeness — these live adjacent to the wire-format material but are runtime logic, not protocol types:

- `packages/core/src/auth/canonical.ts` — canonical-string builder is **pure** and moves in task 1.22
- `packages/core/src/auth/nonce.ts`, `ratelimit.ts`, `authz.ts`, `middleware.ts` — runtime state; stays in core
- `packages/core/src/d2d/gates.ts`, `receive.ts`, `send.ts`, `receive_pipeline.ts`, `quarantine.ts` — runtime pipeline; stays
- `packages/core/src/relay/msgbox_handlers.ts`, `msgbox_boot.ts`, `msgbox_forward.ts` — runtime; stays
- `packages/core/src/identity/keypair.ts`, `signing.ts`, `rotation.ts`, `directory.ts` — key material / state; stays

## Extraction constraints

1. **Zero runtime deps** in `@dina/protocol` — if a file imports `@noble/hashes`, `@scure/base`, etc., either:
   - Move only the types + leave the runtime in `@dina/core`
   - Refactor to take a callback (crypto backend injection)
2. **One-way dep graph** — `@dina/protocol` imports nothing else in the workspace.
3. **Structural compatibility** — existing test fixtures in `@dina/fixtures` must still match the moved types byte-for-byte.

## Target shape in `@dina/protocol/src/`

```
packages/protocol/src/
├── index.ts                       public re-exports
├── types/
│   ├── did.ts                    DID types (1.16a)
│   ├── plc_document.ts           PLC doc shape (1.16b)
│   ├── d2d_envelope.ts           D2D envelope + family consts (1.16c)
│   ├── auth_frames.ts            auth_challenge / auth_response / auth_success (1.16d)
│   ├── capability.ts             capability schema + schema_hash (1.16e)
│   ├── core_rpc.ts               Core HTTP envelope types (1.16f)
│   └── service_endpoint.ts       DinaMsgBox / DinaDirectHTTPS constants (1.16g)
├── constants.ts                   `#dina_signing`, `#dina_messaging`, port numbers, frame type strings
├── canonical_sign.ts              pure canonical-string builder (1.22)
├── envelope_builder.ts            typed constructors (1.23)
└── validators.ts                  envelope validators w/ crypto injection (1.24)
```

## Validation gate (task 1.31)

After each move:

- `npm test` at root — all 7098 tests must still pass
- Lint/CI gate: `@dina/protocol` has zero imports from `@dina/core` or `@dina/brain`
- Type-level test: exported types structurally compatible with fixtures in `@dina/fixtures/`
