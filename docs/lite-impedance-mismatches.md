# Lite ↔ Production (Go/Python) impedance mismatches (task 8.62)

Known shape-level differences between the TypeScript **Home Node
Lite** stack and the **Go + Python production** stack that matter for
cross-stack interop and for the test-migration work in Phase 8 /
Phase 9. These are differences **at the edges of what the wire
protocol pins** — below the level of protocol (`@dina/protocol`
constrains the actual bytes on the wire), above the level of
behavioural semantics (both stacks implement the same Four Laws).

This doc is the **cross-stack compat matrix** deliverable from
Phase 8g (tasks 8.60 – 8.62). It's the place to look when a mixed
Lite-Core + Python-Brain (or vice versa) deployment misbehaves, and
when a test-migrator hits a difference they need to classify per
`tests/integration/LITE_SKIPS.md`'s taxonomy.

## Scope

**In scope** — observable differences from inside the two stacks:

- Error-message prose (Go's `fmt.Errorf` idiom vs Fastify/TS error
  objects)
- JSON field-name casing at transport boundaries (Go's snake_case vs
  TS's camelCase, with explicit translation layers)
- Optional-field handling (Go's zero-value-elision vs TS's
  `exactOptionalPropertyTypes` + conditional spread)
- Timestamp formats (`time.Time` RFC3339 vs Unix-seconds integers)
- Numeric precision at boundaries (int64 vs JS number)
- `null` vs `undefined` vs absent-field semantics
- Synchronous vs async return shapes (Phase 2 port rule)

**Out of scope** — explicitly pinned by `@dina/protocol`:

- D2D envelope JSON key order
- Canonical-signing string shape
- Sealed-box nonce derivation (`BLAKE2b(24)` — the #9 regression pin)
- PLC document Multikey field shape
- Auth handshake frame shapes

The wire-level invariants are the byte-for-byte contract; differences
there are **bugs**, not mismatches — file in `LITE_SKIPS.md` under
`wire-drift`, not here.

## Mismatch registry

### 1. Error-message prose (high impact for test migration)

Go `fmt.Errorf` conventions differ from Fastify/TS error object
conventions. Tests that string-match against Go's exact prose need
per-test adjustment — the registry lives in
[`tests/integration/LITE_ERROR_STRINGS.md`](../tests/integration/LITE_ERROR_STRINGS.md)
with 4 canonical fix patterns.

| Situation | Go (production) | Lite (TypeScript) |
|-----------|-----------------|-------------------|
| Persona unknown | `invalid persona: unknown` | `Unknown persona: unknown` |
| Persona locked | `persona locked` | `Persona is locked` |
| Missing required field | `field %q required` | `"<field>" is required` |
| Timestamp skew | `timestamp too old (age %d > 300s)` | `Timestamp too old: age <N>s exceeds 300s window` |
| Invalid signature | `signature verification failed` | `Invalid signature` |

**Both stacks now emit a stable `code` field** on every error —
preferred fix per `LITE_ERROR_STRINGS.md` pattern 1 is to assert
against the code, not the prose.

### 2. JSON field-name casing at transport boundaries

The wire uses `snake_case` (Go's `json:"snake_case"` tags; mirrored
in the Lite HTTP transport). `@dina/brain` and `@dina/core` in
TypeScript use `camelCase` internally. Translation lives at the
HTTP transport boundary (`HttpCoreTransport`), not in the domain
layer.

| Direction | Example internal → wire |
|-----------|-------------------------|
| Brain → Core | `{toDid: "did:plc:..."}` → `{to_did: "did:plc:..."}` on `/v1/service/query` |
| Core → Brain | `{queryId: "q-abc"}` ← `{query_id: "q-abc"}` from the response |

**Gotcha**: `ServiceQueryClientRequest` uses camelCase at the Brain
API; the transport spreads into a snake_case body. Optional fields
are conditionally assigned (`if (req.x !== undefined) body.x = req.x`)
rather than set to literal `undefined` so the route validator's
`typeof b.x === 'string'` checks behave right.

### 3. Optional-field handling

TypeScript's `exactOptionalPropertyTypes` treats `{x: undefined}`
and `{}` as distinct; Go's `json.Marshal` elides zero values + JSON's
`omitempty` tag. Crossing the boundary:

| Pattern | Wire shape |
|---------|-----------|
| Go writes `{Persona: "", ...}` with `omitempty` | `{...}` (field absent) |
| Go writes `{Persona: "personal", ...}` | `{"persona":"personal",...}` |
| Lite writes `req.persona = undefined` via transport | Field omitted (transport's conditional spread) |
| Lite writes `req.persona = ""` | `{"persona":"","...":"..."}` (empty string, not absent) |

**Fix**: absent field = "no value"; empty string = "explicit empty".
Both stacks now respect this distinction consistently.

### 4. Null vs undefined vs absent

On the wire, Dina uses **absent** (field omitted) to mean "no value"
and **explicit `null`** only when the null is itself meaningful
(e.g. `ServiceConfig | null` where null means "no config published
yet"). `undefined` never crosses the wire — it's a TS-only notion.

| Meaning | Wire |
|---------|------|
| "No value" | Field absent |
| "Explicitly cleared" | Field = `null` |
| TS `undefined` | Never serialised — TS transport drops before send |

### 5. Timestamp formats

- **Wire format**: Unix seconds as JSON integer (per `@dina/protocol`
  `created_time` pin)
- **Go internal**: `time.Time` via `.Unix()` conversion at boundaries
- **Python Brain internal**: `int(time.time())` or `datetime.now().timestamp()`
- **Lite internal**: `Math.floor(Date.now() / 1000)` — **NOT
  `Date.now()` which is milliseconds**

A Date-returning helper that mistakenly uses milliseconds produces
timestamps 1000× out-of-window; replay-protection rejects the
request. The `unixSeconds()` helper in `@dina/core/time` is the
canonical source.

### 6. Numeric precision at wire boundary

- JS `number` is IEEE-754 double — exact to 2^53
- Go `int64` can exceed this
- Go `uint64` definitely does

For any counter that might exceed 2^53 (unlikely for Dina in
practice — event counts, audit-log sequence numbers), the wire must
use a string-encoded number. Currently no Dina field crosses that
boundary; flagged for future proofing if `audit_log.seq` ever
approaches 9 × 10^15.

### 7. Async return shapes (Phase 2 port rule)

Lite repositories + adapters return `Promise<T>` per the
async-everywhere port rule (task 2.8 gate). Go returns sync values.
Both satisfy the same logical contract; tests that migrated from
the Python suite need to `await` at every repository call-site.

Pattern: `await repo.x()` everywhere + parens-fix for chained calls:
`(await repo.x()).map(...)` not `await repo.x().map(...)`.

## How a test-migrator uses this doc

When a migrated test fails against Lite:

1. **Wire bytes differ** → `LITE_SKIPS.md` category `wire-drift`, fix Lite
2. **Error string differs** → `LITE_ERROR_STRINGS.md`, apply pattern
   1-4
3. **Field casing / null / undefined / absent** differs → check this
   doc §3 / §4 for the expected handling; confirm Lite is following
   the spec; if Python test assumed the Go idiom, rewrite to be
   oracle-neutral
4. **Timestamp comparison fails** → §5; likely a ms-vs-seconds bug on
   one side

## Mixed-stack deployment viability (tasks 8.60 + 8.61)

| Combination | Status | Notes |
|-------------|--------|-------|
| Go Core + Python Brain | **Works** (production baseline) | Tested daily via `./install.sh` |
| Lite Core + Lite Brain | **Works at pre-M1 for low surface** | Tracked via Phase 5 / Phase 8 milestones |
| **Lite Core + Python Brain** (task 8.60) | **~48% — blocked on 22 endpoints including 1 path-rename** | Audit below; Python Brain's Core-facing surface is still broader than Lite Core implements. Wire format (canonical sign + sealed-box + D2D envelope) is protocol-pinned ✓. Auth + basic vault/persona/staging ops work; notify, did-sign, audit, contacts, reminder, service/agents, task/ack, vault/kv, staging/ingest, staging/status, approvals, vault/store/batch, workflow/tasks/queue-by-proposal, devices/{id} are not yet in Lite Core. |
| **Go Core + Lite Brain** (task 8.61) | **~92% — 12/13 endpoints work, 1 gap** | Audit below; only `/v1/scratchpad` is Lite-Brain-exclusive and not implemented on Go Core. Everything else Lite Brain calls (msg/send, pii/scrub, service/*, staging/*, vault/*, workflow/tasks/claim) exists on Go Core with compatible wire shapes. |

Enforced by jest test `packages/core/__tests__/cross_stack_compat.test.ts` —
the matrix is regenerated on every run from live source files. When Lite Core
gains a new endpoint the assertions narrow automatically; a deliberate
exception list (re-audited per milestone) captures the known gaps.

Full cross-stack runtime smoke is M3-bonus per task 8g's positioning —
not M1-blocking. The wire contract is pinned; the mismatches above
are at the edges.

### 8.60 Lite Core + Python Brain — audit

**Python Brain outbound surface** (enumerated from
`brain/src/adapter/core_http.py` + `brain/src/port/core_client.py`):
42 distinct Core endpoints.

**Lite Core inbound surface** (enumerated from
`packages/core/src/**` + `apps/home-node-lite/core-server/src/**`):
36 distinct routes.

**Overlap (supported paths — 20/42, ~48%)**: `/v1/devices`,
`/v1/msg/send`, `/v1/pair/{complete,initiate}`, `/v1/personas`,
`/v1/pii/scrub`, `/v1/service/{config,query,respond}`,
`/v1/staging/{claim,extend-lease,fail,resolve}`,
`/v1/vault/{query,store}`, `/v1/workflow/tasks`, `/v1/workflow/events/:id/ack`,
`/v1/workflow/tasks/:id/{approve,cancel}`, `/v1/workflow/tasks/:id`.

**Missing on Lite Core (22 endpoints)**:

| Endpoint | Category | Unlock milestone |
|----------|----------|------------------|
| `/v1/notify` | Notification hub | M2 (silence-first + WS push) |
| `/v1/did`, `/v1/did/sign` | Identity signing | M2 (DID subsystem) |
| `/v1/audit/append`, `/v1/audit/query` | Audit log | M2 |
| `/v1/contacts`, `/v1/contacts/{did}` | Contact graph | M3 (trust network) |
| `/v1/approvals`, `/v1/approvals/{id}/{approve,deny}` | Approval workflow | M5 (safety layer) |
| `/v1/reminder`, `/v1/reminder/fire`, `/v1/reminders/pending` | Reminder engine | M4 |
| `/v1/service/agents` | Service agent registry | M3 |
| `/v1/staging/ingest`, `/v1/staging/status/{id}` | Staging pipeline | M2 |
| `/v1/task/ack` | Task ack envelope | M2 |
| `/v1/vault/kv/{key}` | KV subscope | M1 (small) |
| `/v1/vault/store/batch` | Batch ingest | M2 |
| `/v1/workflow/tasks/queue-by-proposal` | Proposal queue | M3 |
| `/v1/devices/{token_id}` | Device revoke | M1 (small) |

**Path-shape mismatch (1)**: Python Brain calls
`/v1/memory/topic/touch`; Lite Core exposes `/v1/memory/touch`.
This is a **wire-drift bug** per `LITE_SKIPS.md`'s taxonomy — Python
Brain is the existing convention (already shipped against Go Core),
Lite Core should rename to match. Filed as fixup in Lite Core's
M2 memory-touch wiring.

**Verdict**: Lite Core + Python Brain works for the basic vault/persona/staging
slice today; every category-appropriate Lite Core milestone narrows the gap.
Protocol-pinned wire layer (auth, D2D, sealed-box) already compatible — see
`packages/protocol/docs/conformance.md`.

### 8.61 Go Core + Lite Brain — audit

**Lite Brain outbound surface** (enumerated from
`packages/brain/src/**`, template-literal paths included): 13
distinct Core endpoints.

**Go Core inbound surface** (enumerated from `core/internal/handler/**` +
`core/cmd/**`): 77 distinct routes.

**Per-endpoint coverage**:

| Lite Brain calls | Go Core route | Status |
|------------------|---------------|--------|
| `/v1/msg/send` | `/v1/msg/send` | ✅ Works |
| `/v1/pii/scrub` | `/v1/pii/scrub` | ✅ Works |
| `/v1/scratchpad` | *(absent)* | ❌ Go Core gap |
| `/v1/service/query` | `/v1/service/query` | ✅ Works |
| `/v1/service/respond` | `/v1/service/respond` | ✅ Works |
| `/v1/staging/claim` | `/v1/staging/claim` | ✅ Works |
| `/v1/staging/extend-lease` | `/v1/staging/extend-lease` | ✅ Works |
| `/v1/staging/fail` | `/v1/staging/fail` | ✅ Works |
| `/v1/staging/ingest` | `/v1/staging/ingest` | ✅ Works |
| `/v1/staging/resolve` | `/v1/staging/resolve` | ✅ Works |
| `/v1/vault/query` | `/v1/vault/query` | ✅ Works |
| `/v1/vault/store` | `/v1/vault/store` | ✅ Works |
| `/v1/workflow/tasks/claim` | `/v1/workflow/tasks/claim` | ✅ Works |

**The `/v1/scratchpad` gap**: Lite Brain's legacy
`BrainCoreClient` (`packages/brain/src/core_client/http.ts`) calls
`/v1/scratchpad` for multi-step reasoning checkpoints. Go Core has
no equivalent — Go's Python-Brain pairing stores scratch state
in-process inside Brain itself, not via Core. Two resolution paths:
(a) add `/v1/scratchpad` to Go Core, (b) migrate Lite Brain's
scratchpad off Core into in-process storage (matching Python Brain's
choice). Picking (b) aligns with "scratchpad is Brain private state"
conceptually — deferred to task 5.x scratchpad-rewiring.

**Verdict**: Go Core + Lite Brain works for 12/13 (~92%) of Lite
Brain's current Core calls. The 1 gap is a single Brain-internal
abstraction choice, not a protocol compatibility issue. Once
scratchpad moves Brain-internal, Go Core + Lite Brain is a complete
drop-in. Protocol-pinned wire layer (auth, D2D, sealed-box) fully
compatible.

## See also

- `packages/protocol/docs/conformance.md` — the normative wire spec
- `tests/integration/LITE_SKIPS.md` — per-test skip registry
- `tests/integration/LITE_ERROR_STRINGS.md` — per-test string-match
  adjustment registry
- `ARCHITECTURE.md` § *Two-Stack Implementation* — the stack
  comparison
