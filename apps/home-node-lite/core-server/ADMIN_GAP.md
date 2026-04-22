# Admin API Surface — Go Core ↔ Home Node Lite Gap Report

Task 4.84. Enumerates every admin-facing endpoint in the Go Core and
maps it to the Home Node Lite equivalent. Each row is one of:

- **✅ Present** — Lite registers an equivalent endpoint with compatible wire shape.
- **⏳ Pending** — deferred to a future phase; tracked here with the blocking task.
- **🛑 Descoped** — Lite intentionally does not implement; rationale inline.
- **🔁 Replaced** — Lite exposes the capability via a different surface (the new wiring is pointed to).

The primary Go sources are:

- `core/internal/adapter/server/server.go` — route registration
- `core/internal/handler/admin.go` — `/admin/*` reverse proxy + `/v1/admin/sync-status`
- `core/internal/handler/device.go` — pairing + device management
- `core/internal/handler/persona.go` — persona lifecycle

## Admin-Scoped Endpoints

| Go Endpoint | Method | Purpose | Lite Status | Notes |
|---|---|---|---|---|
| `/admin/*` | ANY | Reverse-proxy to Brain admin UI | 🛑 Descoped | Lite is a headless runtime; the admin UI lives in `apps/home-node-lite/brain-server` (Phase 5). Callers hit Brain's admin routes directly; no in-Core proxy. |
| `/admin/sync-status` | GET | Legacy unauthenticated sync-status probe | 🛑 Descoped | Go deprecated this in CXH6 (moved behind auth). Lite never had the pre-auth variant; clients use `/v1/admin/sync-status` (pending task below). |
| `/v1/admin/sync-status` | GET | Auth-gated Core↔Brain connectivity status | ⏳ Pending | Requires Brain-connectivity probe wiring; will land with Phase 5 brain-server or a standalone readiness check. The underlying *signal* already exists via `/readyz` when Brain is listed as a check. |

## V1 Device / Pairing (Admin-Operated)

| Go Endpoint | Method | Lite Status | Lite Endpoint | Notes |
|---|---|---|---|---|
| `/v1/pair/initiate` | POST | ✅ Present | `/v1/pair/initiate` | Task 4.63. Wire parity pinned. |
| `/v1/pair/complete` | POST | ✅ Present | `/v1/pair/complete` | Task 4.63. Token-auth flow today; sig-auth (`public_key_multibase`) is a follow-on with 4.65. |
| `/v1/devices` | GET | 🔁 Replaced | `/v1/pair/devices` | Lite co-locates under `/v1/pair/*` for operational cohesion. Same response body shape. |
| `/v1/devices/{id}` | DELETE | 🔁 Replaced | `/v1/pair/devices/:deviceId` | Task 4.66. Same wire contract (DELETE + 204). |

## V1 Persona (Admin-Operated)

| Go Endpoint | Method | Lite Status | Notes |
|---|---|---|---|
| `/v1/personas` | GET | ⏳ Pending | List personas — deferred until persona HTTP surface lands (currently Lite has only the persona-tier primitives from tasks 4.68–4.74; the CRUD routes come later). |
| `/v1/personas` | POST | ⏳ Pending | Create persona — same reason as above. |
| `/v1/personas/{id}/unlock` | POST | ⏳ Pending | Pairs with task 4.69 (`PassphraseRegistry`) for `locked` tier unlock; needs the HTTP binding. |
| `/v1/personas/{id}/lock` | POST | ⏳ Pending | Pairs with task 4.71 (`AutoLockRegistry.lock`). |

## V1 Vault (Not Admin-Scoped)

Not under this gap report — vault HTTP surface is operator-scoped, tracked separately under the storage-node + workflow tasks.

## V1 PII / Memory / Metrics (Ops Surface)

| Endpoint | Method | Lite Status | Task |
|---|---|---|---|
| `/v1/pii/scrub` | POST | ✅ Present | 4.78 |
| `/v1/pii/rehydrate` | POST | ✅ Present (Lite-only) | 4.79 — not in Go yet. |
| `/v1/pii/session` | POST | ✅ Present (Lite-only) | 4.79 — companion to rehydrate. |
| `/v1/memory/toc` | GET | ✅ Present (Lite-only) | 4.77 — Go has the aggregation logic internally; this exposes it over HTTP. |
| `/v1/memory/touch` | POST | ✅ Present (Lite-only) | 4.76 — explicit ingestion hook; Go drives touches implicitly from the vault store path. |
| `/metrics` | GET | ✅ Present (Lite-only) | 4.85 — Go declares the route but has no handler; Lite owns the Prometheus exposition. |

## Core Operational (Uncategorized Admin-Adjacent)

| Go Endpoint | Method | Lite Status | Notes |
|---|---|---|---|
| `/healthz` | GET | ✅ Present | Task 4.10. Same body shape. |
| `/readyz` | GET | ✅ Present | Task 4.10. Readiness checks are injectable. |
| `/.well-known/atproto-did` | GET | ⏳ Pending | AT Proto service DID publication. Needed for Lite-as-operator scenarios; deferred until Phase 6 (AppView) or until a specific deployment needs it. |
| `/v1/task/ack` | POST | ⏳ Pending | Workflow-task ack (task 4.82 "Long-running workflow persistence"). |
| `/v1/did` | GET | ⏳ Pending | Expose Home Node DID — follow-on for task 4.57 (`home_node_did_document.ts` is present; route not bound). |
| `/v1/did/sign` | POST | ⏳ Pending | Handler exists as primitive (`@dina/core` sign); HTTP wrapper not yet bound. |
| `/v1/did/verify` | POST | ⏳ Pending | Same as sign. |
| `/v1/did/rotate` | POST | ⏳ Pending | Rotation primitive in `@dina/core`; HTTP wrapper not yet bound. |
| `/v1/contacts` | ANY | ⏳ Pending | Contact HTTP surface — out of scope for Phase 4. |
| `/v1/people` | ANY | ⏳ Pending | Same. |
| `/v1/msg/*` | ANY | ⏳ Pending | Message inbox — covered by the MsgBox WS client (task 4.41) in a different shape; direct HTTP surface descoped in favor of MsgBox. |
| `/v1/notify` | POST | ⏳ Pending | Nudge delivery endpoint — pairs with WebSocket hub (task 4.36). |
| `/v1/trust/query` | POST | ⏳ Pending | AppView trust query proxy — Phase 6. |
| `/v1/trust/publish` | POST | ⏳ Pending | AppView trust publish — Phase 6. |
| `/v1/approvals/*` | ANY | 🔁 Replaced (primitive) | Task 4.72 exposes `ApprovalRegistry` as an in-process primitive; HTTP surface not yet bound. Pairs with 4.72 follow-on when admin-UI wiring lands. |
| `/v1/intent/proposals/*` | ANY | ⏳ Pending | Agent-gateway intent flow — Phase 6 / 7. |
| `/v1/reason/*` | ANY | ⏳ Pending | Reasoning-agent primitives — Phase 5 (Brain server). |
| `/v1/reminder/*` | ANY | ⏳ Pending | Reminder service — Phase 5+. |
| `/v1/staging/*` | ANY | ⏳ Pending | Staging inbox — pairs with task 4.76 ingestion; route surface deferred. |
| `/v1/service/agents` | GET | ⏳ Pending | Narrow read-only agent listing for Brain's service-discovery path. Can be added by filtering `listLive()` from `DeviceTokenRegistry` (task 4.64). |

## Summary

**Admin gaps that need a named follow-on task** (currently unassigned):

1. `/v1/admin/sync-status` — Core↔Brain connectivity. Needs a thin Fastify route + readiness-check wiring. **Recommendation**: add as **task 4.91** after Brain-server (Phase 5) lands.
2. HTTP bindings for existing persona + passphrase primitives (tasks 4.68–4.74 built the mechanisms; the `/v1/personas/*` routes still need wiring). **Recommendation**: add as **task 4.92** bundling `/v1/personas`, `/v1/personas/:id/unlock`, `/v1/personas/:id/lock`.

Every other gap is already tracked by an explicit Phase 4+ task in `docs/HOME_NODE_LITE_TASKS.md` or explicitly descoped with rationale above.

## Descope Rationale Summary

- **`/admin/*` reverse proxy**: Lite decouples Core and Brain across processes; Brain's admin UI is reachable at Brain's own listener, no proxy hop through Core.
- **`/admin/sync-status` (unauthenticated)**: inherited Go deprecation (CXH6); Lite starts with the auth-gated variant only.
- **`/v1/msg/*` HTTP inbox**: Dina's preferred message channel is MsgBox WS (task 4.41); the HTTP surface was a Go-era compatibility path that's not load-bearing for the typed-D2D protocol.
