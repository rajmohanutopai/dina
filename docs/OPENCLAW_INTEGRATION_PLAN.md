# OpenClaw Outbound Integration: Full End-to-End (v11)

## Context

Dina has inbound OpenClaw integration (OpenClaw → `dina validate/ask/remember`). Missing: outbound flow where user delegates a task to OpenClaw. OpenClaw's power is autonomous execution — Dina validates the task once, then lets OpenClaw run and call back at its own discretion.

**CLI is an agent channel** — paired with `--role agent`, so all writes get caveated provenance automatically. This is a decided product stance, not an open design question.

Two architectural gaps must be closed: intent proposal lifecycle plumbing (create/poll/approve/deny with durable terminal states) and session propagation on validate.

## Architecture

```
User: dina task "Research ergonomic chairs under 20K"
  │
  ▼
CLI starts session: POST /v1/session/start {name: "task-<uuid>"}
  │
  ▼
CLI validates delegation: POST /v1/agent/validate
  │  {type: "agent_intent", action: "research", target: "..."}
  │  X-Session: task-<uuid>
  │
  │  Guardian: "research" ∈ _MODERATE_ACTIONS → flag_for_review
  │  Returns proposal_id
  │
  ▼
CLI shows: "Task requires approval (proposal: prop-xxx)"
CLI polls: GET /v1/intent/proposals/prop-xxx/status
  │
  │  User approves via:
  │    • Telegram bot inline button
  │    • Admin UI: /admin/intent-approvals
  │    • Admin CLI: dina-admin intent approve prop-xxx
  │  Any of these → POST /v1/intent/proposals/prop-xxx/approve
  │  → Core sends intent_approved event to Brain
  │  → Guardian removes proposal, returns approved=true
  │
  ▼ (after approval)
CLI connects to OpenClaw Gateway (WebSocket RPC)
  │  1. WS connect to ws://{openclaw_url}/ws
  │  2. Gateway sends connect challenge
  │  3. CLI responds with connect {token, clientId}
  │  4. CLI calls agent {task, dina_session, dina_skill: "dina"}
  │  5. CLI calls agent.wait — streams events until terminal
  │
  │  OpenClaw runs autonomously (its discretion):
  │  ├─ searches, browses, compiles
  │  ├─ dina ask "back pain?" --session task-<uuid>
  │  ├─ dina validate send_email "..." --session task-<uuid>
  │  ├─ dina remember "finding..."  (staging, provenance auto-derived)
  │  │
  │◄── terminal event (agent.wait resolves)
  ▼
CLI stores summary via staging: POST /v1/staging/ingest
  │  type: "note", source: "openclaw"
  │  X-Session: task-<uuid>
  │  Provenance: auto-derived from device role
  │
CLI ends session: POST /v1/session/end {name: "task-<uuid>"}
User sees results
```

## Changes (8 workstreams)

---

### 1. Guardian: Add `research` to `_MODERATE_ACTIONS`

**File:** `brain/src/service/guardian.py` (~line 308)

```python
_MODERATE_ACTIONS = {
    ...,
    "research",  # Autonomous research delegation to external agent
}
```

Without this, `research` falls through to SAFE auto-approve (line 1024), making the validation meaningless.

---

### 2. Intent Proposal Approval — End-to-End Plumbing

The Guardian creates proposals with `proposal_id` (line 1084) and can consume `intent_approved` events (line 2486). But there's no HTTP surface to approve them, no polling endpoint, and no admin UI.

#### 2a. Brain: Durable proposal store

**File:** `brain/src/service/guardian.py`

Guardian currently stores proposals in `_pending_proposals` (in-memory dict) and **removes them on approval** (line 2514). This means polling clients can't distinguish approved from expired/missing.

**Important:** `_pending_proposals` holds BOTH intent proposals and disclosure proposals (line 2114). The lifecycle changes and new endpoints must use a `kind` field to distinguish them.

**Fix:** Don't remove proposals on approval. Instead, transition status:

```python
# _pending_proposals stores full lifecycle:
# {proposal_id: {id, kind, agent_did, action, target, status, created_at, updated_at, expires_at, reason}}
# kind: "intent" | "disclosure"
# status: "pending" → "approved" | "denied" | "expired"
```

- Add `kind: "intent"` when creating intent proposals (line 1123)
- Add `kind: "disclosure"` when creating disclosure proposals (line 2114)
- On approval (`_handle_intent_approved`): set `status = "approved"`, keep in dict
- On deny (new `_handle_intent_denied`): set `status = "denied"`, keep in dict
- On TTL expiry: both eviction paths must transition to expired, not delete:
  - Sync recovery eviction (line 645)
  - Async eviction (line 2298)
  - Both should: set `status = "expired"` for pending proposals, delete terminal proposals older than 10 minutes
- New `/intent/proposals/*` endpoints filter to `kind == "intent"` only

#### 2b. Brain: Add `intent_denied` handler

**File:** `brain/src/service/guardian.py` + `brain/src/dina_brain/routes/process.py`

Add `IntentDeniedEvent` to the discriminated union:
```python
class IntentDeniedEvent(_EventBase):
    type: Literal["intent_denied"]
    proposal_id: str | None = None
    reason: str | None = None
```

Add `_handle_intent_denied()` to Guardian — sets proposal status to "denied".
Add `"intent_denied"` to the dispatch table.

#### 2c. Brain: Proposal status query endpoint

**File:** `brain/src/dina_brain/routes/proposals.py` (new, ~40 lines)

```
GET /api/v1/proposals/{id}/status  — query proposal lifecycle state
GET /api/v1/proposals              — list proposals (admin only)
```

Reads from Guardian's `_pending_proposals` dict. Returns `{id, status, action, target, created_at, expires_at}`. Status is one of: `pending`, `approved`, `denied`, `expired`.

#### 2d. Core: Intent proposal proxy endpoints

**File:** `core/internal/handler/intent_proposal.go` (new, ~120 lines)

```
POST /v1/intent/proposals/{id}/approve  — sends intent_approved to Brain
POST /v1/intent/proposals/{id}/deny     — sends intent_denied to Brain
GET  /v1/intent/proposals/{id}/status   — proxies to Brain's proposal status
GET  /v1/intent/proposals               — proxies to Brain's proposal list
```

- `approve`: sends `{type: "intent_approved", payload: {proposal_id: id}}` via `brain.ProcessEvent()`
- `deny`: sends `{type: "intent_denied", payload: {proposal_id: id, reason: "..."}}` via `brain.ProcessEvent()`
- Uses the same narrow Brain interface pattern as AgentHandler (`agent.go:19` — ad hoc interface, not the full BrainClient port)
- **Access control:**
  - Admin (CLIENT_TOKEN): can list/approve/deny all proposals
  - Agent device (Ed25519): can query status of **its own** proposals only (ownership check: request X-DID must match proposal's agent_did)
  - Agent devices **cannot** approve/deny — only admin can

#### 2e. Core: Register routes + auth allowlist

**File:** `core/cmd/dina-core/main.go` (~4 lines)

Register the new handler on the mux at `/v1/intent/proposals/`.

**File:** `core/internal/adapter/auth/auth.go` (~line 1107)

Add `/v1/intent/proposals` to the device access prefix allowlist. Without this, agent devices cannot poll proposal status — requests will be rejected by auth middleware before reaching the handler.

#### 2f. Admin CLI: Intent approval commands

**File:** `admin-cli/src/dina_admin_cli/main.py` (~40 lines)

```
dina-admin intent list              — list pending intent proposals
dina-admin intent approve <id>      — approve proposal
dina-admin intent deny <id>         — deny proposal
```

Calls `POST /v1/intent/proposals/{id}/approve|deny`.

#### 2g. Admin UI: Intent approval page

**File:** `brain/src/dina_admin/routes/approvals.py` (new, ~60 lines)

Dashboard page listing pending intent proposals with approve/deny buttons.

#### 2h. CLI: Poll intent proposal status

**File:** `cli/src/dina_cli/main.py` (in `task` command)

After receiving `requires_approval` + `proposal_id`, CLI polls `GET /v1/intent/proposals/{id}/status` every 5 seconds for up to 5 minutes. Status transitions:
- `pending` → keep polling
- `approved` → proceed to OpenClaw run
- `denied` → show reason, exit
- `expired` → show "timed out, retry", exit

---

### 3. CLI as Agent Channel

The CLI used for OpenClaw is paired with `--role agent` (`cli/src/dina_cli/main.py:598`). This means ALL writes from this CLI identity land as `(cli, agent)` → `unknown / service / medium / caveated` in the trust scorer (`brain/src/service/trust_scorer.py:109`). No identity separation problem — the CLI IS the agent.

This also means `dina task` can store the final result via `staging_ingest()` and it will automatically get caveated provenance. No need to rely on OpenClaw storing results during its run.

#### 3a. Remove hardcoded `sender: "user"` from remember

**File:** `cli/src/dina_cli/main.py` (~line 158)

Currently `remember` hardcodes `"sender": "user"`. Since this CLI is an agent channel, that label is misleading. Remove it — let Core/Brain derive sender from the device's auth context and role.

#### 3b. Skill doc: Require `--role agent` pairing

The Dina skill doc must state: pair with `dina configure --role agent`. Core already routes `role=agent` to caveated provenance (staging.go:128).

---

### 4. Session Propagation on `validate`

#### 4a. CLI: Add `--session` to `validate`

**File:** `cli/src/dina_cli/main.py` (~line 350)

```python
@cli.command()
@click.argument("action")
@click.argument("description")
@click.option("--session", default="", help="Session name for scoped validation")
def validate(ctx, action, description, session):
```

#### 4b. DinaClient: Pass X-Session in process_event

**File:** `cli/src/dina_cli/client.py` (~line 268)

```python
def process_event(self, event: dict, session: str = "") -> dict:
    headers = {}
    if session:
        headers["X-Session"] = session
    resp = self._request(self._core, "POST", "/v1/agent/validate",
                         json=event, headers=headers)
    return resp.json()
```

#### 4c. Core: AgentHandler reads X-Session

**File:** `core/internal/handler/agent.go`

Extract `SessionNameKey` from request context (already set by auth middleware) and include it in the payload forwarded to Brain. Add `payload["session"] = sessionName` alongside the existing `agent_did` and `trust_level` overrides.

#### 4d-extra. Brain: Add session field to AgentIntentEvent

**File:** `brain/src/dina_brain/routes/process.py` (~line 59)

`AgentIntentEvent` currently has no `session` field. Add `session: str | None = None` so the discriminated union accepts session from Core's forwarded payload.

#### 4d. Remember `--session` with X-Session header

**File:** `cli/src/dina_cli/main.py` (~line 142)

Add `--session` option. Pass as `X-Session` header via `staging_ingest(item, session=session)`. Also put in metadata for traceability. Omit hardcoded `sender: "user"` — let Core/Brain derive sender from device role.

#### 4e. DinaClient: Session-aware staging_ingest

**File:** `cli/src/dina_cli/client.py`

```python
def staging_ingest(self, item: dict, session: str = "") -> dict:
    headers = {}
    if session:
        headers["X-Session"] = session
    resp = self._request(self._core, "POST", "/v1/staging/ingest",
                         json=item, headers=headers)
    return resp.json()
```

---

### 5. OpenClaw Gateway WS Client

**New file:** `cli/src/dina_cli/openclaw.py` (~120 lines)

```python
class OpenClawClient:
    """WebSocket RPC client for the local OpenClaw Gateway.

    Implements the documented Gateway protocol:
    1. WS connect to ws://{base_url}/ws
    2. Receive connect challenge from Gateway
    3. Send connect response with {token, clientId}
       (non-local clients must sign the challenge; local clients
        send token directly)
    4. Call health (optional, verifies gateway state)
    5. Call agent with {task, skills, idempotencyKey}
       Returns {runId, acceptedAt}
    6. Call agent.wait — blocks on WS, streams agent events
       until terminal event (completed/failed/cancelled)
    7. Return final result from terminal event
    """

    def __init__(self, base_url: str, token: str, timeout: float = 300.0)

    def run_task(self, task: str, dina_session: str = "",
                 dina_skill: str = "dina",
                 idempotency_key: str = "") -> dict:
        """Full autonomous run: connect → agent → agent.wait → result.

        Passes dina_session to the agent so OpenClaw uses
        --session for scoped Dina callbacks.

        Side-effecting RPCs include idempotencyKey per protocol.
        """

    def close()
```

- Uses `websockets` library (add to cli dependencies)
- Auth: token sent during connect handshake
- Client identity: CLI device DID as clientId
- Timeout: 5 minutes default
- `idempotencyKey`: UUID per agent call (prevents duplicate runs on retry)

---

### 6. CLI `dina task` Command

**File:** `cli/src/dina_cli/main.py` (~80 lines)

```python
@cli.command()
@click.argument("description")
@click.option("--dry-run", is_flag=True, help="Validate without executing")
def task(ctx, description, dry_run):
```

Flow:
1. Check OpenClaw config (url + token)
2. `client.session_start(session_name)`
3. `client.process_event({type: "agent_intent", action: "research", target: description}, session=session_name)`
4. If `requires_approval`: show proposal_id, poll `GET /v1/intent/proposals/{id}/status` (5s interval, 5min timeout). Agent can only poll its own proposals (ownership check).
5. If denied: show reason, exit
6. If dry-run: show "approved, would invoke OpenClaw", exit
7. `openclaw.run_task(description, dina_session=session_name)` — WS autonomous run (connect → agent → agent.wait)
8. Store final result via `client.staging_ingest({type: "note", source: "openclaw", ...}, session=session_name)` — auto-caveated since CLI is `--role agent`
9. Display result
10. `client.session_end(session_name)` in finally block

The CLI is paired as `--role agent`, so `staging_ingest()` automatically gets caveated provenance (unknown/service/medium/caveated). No special handling needed.

The final summary is intentionally additive — a concise result envelope. OpenClaw may also store intermediate findings via `dina remember` during the run. The task summary is a one-line result; the remembered findings are the detailed research. Both are caveated since both come from agent-role devices.

---

### 7. DinaClient: Add session_start/session_end methods

**File:** `cli/src/dina_cli/client.py` (~15 lines)

Currently session commands call `client._request()` directly (main.py:1172). Add proper methods:

```python
def session_start(self, name: str) -> dict:
    resp = self._request(self._core, "POST", "/v1/session/start", json={"name": name})
    return resp.json()

def session_end(self, name: str) -> None:
    self._request(self._core, "POST", "/v1/session/end", json={"name": name})
```

Refactor existing session CLI commands to use these methods.

---

### 8. Config + Skill Doc

#### 8a. CLI Config

**File:** `cli/src/dina_cli/config.py`

```python
@dataclass(frozen=True)
class Config:
    core_url: str
    timeout: float
    device_name: str = ""
    openclaw_url: str = ""     # ws://localhost:3000
    openclaw_token: str = ""   # Gateway auth token
```

Env vars: `DINA_OPENCLAW_URL`, `DINA_OPENCLAW_TOKEN`. Optional in `dina configure`.

#### 8b. Skill Doc Update

**File:** `docs/dina-openclaw-skill.md`

- Fix stale `stored: true` → `staged: true` for remember
- Require `dina configure --role agent` for OpenClaw
- Add "Outbound Task Delegation" section documenting `dina task`
- Document WS Gateway protocol (connect → agent → agent.wait)
- Document `--session` on remember and validate for scoped callbacks

---

## Files Summary

| File | Change | New/Mod |
|------|--------|---------|
| `brain/src/service/guardian.py` | Add `"research"` to `_MODERATE_ACTIONS`; durable proposal store (don't delete on approve); add `_handle_intent_denied`; `_sweep_proposals` sets expired not delete | Mod |
| `brain/src/dina_brain/routes/process.py` | Add `IntentDeniedEvent` to union; add `session` to `AgentIntentEvent` | Mod |
| `brain/src/dina_brain/routes/proposals.py` | Proposal status/list query endpoints | **New** |
| `brain/src/dina_admin/routes/approvals.py` | Admin UI intent approval page | **New** |
| `core/internal/handler/intent_proposal.go` | Intent proposal approve/deny/status/list proxy endpoints | **New** |
| `core/cmd/dina-core/main.go` | Register intent proposal routes | Mod |
| `core/internal/adapter/auth/auth.go` | Add `/v1/intent/proposals` to device allowlist | Mod |
| `core/internal/handler/agent.go` | Forward X-Session to Brain payload | Mod |
| `admin-cli/src/dina_admin_cli/main.py` | `dina-admin intent list/approve/deny` | Mod |
| `cli/src/dina_cli/openclaw.py` | OpenClaw Gateway WS RPC client | **New** |
| `cli/src/dina_cli/main.py` | `dina task`; `--session` on remember/validate; remove hardcoded sender | Mod |
| `cli/src/dina_cli/client.py` | session_start/end; session-aware staging_ingest/process_event | Mod |
| `cli/src/dina_cli/config.py` | openclaw_url, openclaw_token | Mod |
| `cli/pyproject.toml` | Add `websockets` dependency | Mod |
| `docs/dina-openclaw-skill.md` | Staging, --role agent, outbound task, WS protocol | Mod |
| `cli/tests/test_task.py` | Task command tests | **New** |
| `cli/tests/test_openclaw.py` | OpenClaw WS client tests | **New** |
| `tests/integration/test_intent_proposals.py` | Proposal lifecycle integration tests | **New** |

---

## Tests

**`cli/tests/test_task.py`** (9 cases):
- Validates `research` intent via process_event with X-Session
- `requires_approval`: shows proposal_id, polls status
- `denied`: shows reason, no OpenClaw call
- `approved` after polling: invokes OpenClaw WS run_task
- `dry-run`: validates, shows approval result, no OpenClaw call
- OpenClaw unreachable: WS connect fails, clear error
- Not configured: empty openclaw_url, usage error
- Session start/end always called (end in finally)
- OpenClaw WS error during agent.wait: handled gracefully

**`cli/tests/test_openclaw.py`** (6 cases):
- WS handshake: connect challenge → connect response with token
- agent call returns runId
- agent.wait streams events, returns terminal result
- Auth token passed during connect
- Connection timeout
- Task with dina_session forwarded in agent args

**`tests/integration/test_intent_proposals.py`** (8 cases):
- Proposal created on moderate action → status returns pending
- Approve → status returns approved (not missing)
- Deny → status returns denied with reason
- TTL expiry → status returns expired
- Agent can poll own proposal, cannot poll others (403)
- Agent cannot approve/deny (403, admin only)
- Admin can list all pending proposals
- Second proposal for same agent coexists

**Brain unit tests** (additions to existing test files):
- Guardian: `research` ∈ `_MODERATE_ACTIONS` → flag_for_review
- Guardian: proposal survives approval (status=approved, not removed)
- Guardian: `_handle_intent_denied` sets status=denied
- Guardian: `_sweep_proposals` sets expired, cleans up terminal after 10min

**Core unit tests**:
- AgentHandler: X-Session forwarded to Brain payload
- IntentProposalHandler: access control (admin vs agent ownership)

---

## Verification

1. `cd core && go build -tags fts5 ./...` — Go compiles with new intent_proposal handler
2. `python scripts/test_status.py --restart` — no regressions
3. `pytest cli/tests/test_task.py -v` — task command tests pass
4. `pytest cli/tests/test_openclaw.py -v` — OpenClaw client tests pass
5. Manual: `dina task "Search for something"` → shows proposal → approve via admin → OpenClaw runs → result displayed
