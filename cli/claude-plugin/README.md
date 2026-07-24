# Dina — Claude Code plugin (v0.1 engineering preview)

Your sovereign personal AI, inside the agent you already use. This plugin puts a
**Core-owned safety gate** on every Claude Code tool call and adds Dina's
**portable encrypted memory**, **intent validation**, and **PII scrubbing** as
MCP tools. The agent calls into Dina; you keep Claude Code.

It follows the MCP + hooks model (see `docs/DINA_PLUGIN_DEVELOPER_SURFACE.md`):

- a **catch-all `PreToolUse` hook** forwards the raw `(tool_name, tool_input)` of
  every tool call to Core's `/v1/agent/gate`, which classifies it and returns
  `allow` / `approval_required` / `deny`. Core owns the policy — the hook decides
  nothing;
- a **`SessionEnd` hook** immediately ends Claude's DID-bound Core gate session,
  revoking its authority; a 15-minute lease is the crash/forced-exit backstop;
- an **MCP server** exposes `dina_remember`, `dina_ask`, `dina_validate`,
  `dina_scrub`, session tools, and more.

## Current integration status

The package is an engineering preview of the hook and CLI integration, not yet
the production one-click phone plugin described by the design document.

- The coding classifier is filesystem-aware and currently runs only in
  **Home Node Lite Core**. Mobile Core deliberately registers no coding gate, so
  pairing this CLI directly to the mobile app makes `/v1/agent/gate` return
  `501` and the hook blocks fail-closed.
- Core can mint the first coding-agent enrolment capability and deliver it over
  a process-bound inherited file descriptor, but this package does not yet
  contain the launcher that spawns Core, consumes that handoff, and assembles
  the complete `dina1:` setup code. The standalone Home Node Lite installer
  and owner console do not currently expose an equivalent owner-authorized
  “Pair coding agent” action. A fresh user therefore still needs an
  operator-provisioned Home Node and admin-issued coding setup code.
- A HIGH-risk call creates a durable Dina approval task and stays blocked until
  that task is approved; an exact retry then redeems a single-use permit.
- The laptop-Core-to-phone approval substrate in design §13 is implemented:
  Home Node Lite mirrors HIGH approvals to a paired mobile Core over signed,
  sealed MsgBox RPC and applies the phone's decision to the durable local task.
  Exact approved retries are single-use and remain safe across a laptop-Core
  restart.
- The production `/dina:pair-phone` workflow is not implemented yet. Today the
  bridge is bootstrapped with `DINA_APPROVAL_PHONE_SETUP_CODE`; revocation,
  re-pairing, and stale-card cleanup still need product UI.

Do not publish this package as a finished one-click integration until the
first-agent launcher/owner pairing surface and the phone lifecycle surface are
complete.

## Verification

The hosted high-fidelity regression runs two real Home Node Lite instances,
provisions separate test-PDS identities, pairs the coding agent and the
laptop-to-phone approval client over MsgBox, approves on the phone-side node,
restarts the laptop node, and proves that only one exact retry is released:

```bash
cli/claude-plugin/e2e/phone_approval_e2e_msgbox.sh
```

It targets `test-mailbox.dinakernel.com` and `test-pds.dinakernel.com` by
default and creates throwaway test identities. See the script header for
endpoint and handle overrides.

## Prerequisites

This plugin is a thin wrapper over the `dina` CLI, which holds the agent's key
and does the signed transport to Home Node Lite Core. For the current preview,
start Home Node Lite and pair the CLI using a coding-scope setup code issued by
that node:

```bash
pip install --upgrade "dina-agent>=0.19.0"
dina configure          # paste the coding-agent setup code from Home Node Lite
dina status             # confirm Core is reachable
```

**Read this before you install:** the gate is **fail-closed**. Until `dina` is
configured and can reach your Home Node, the hook **blocks every tool call**, so
Claude Code cannot run tools until pairing is done. That is the point — a gate
that opened when Dina was unreachable would be no gate at all.

## Install

```
/plugin marketplace add <path-or-repo-containing cli/claude-plugin>
/plugin install dina@dina
```

For local development, point the marketplace at the folder directly:

```
/plugin marketplace add /absolute/path/to/dina/cli/claude-plugin
/plugin install dina@dina
```

## What you get

- **The gate** — every tool call (including `Bash`, `Write`, MCP, and future
  tools) is classified by Core. Reading a secret/seed/vault path, writing to a
  protected path, or an unparseable shell command blocks; ordinary project edits
  and safe reads pass silently; MODERATE actions use Claude's native confirmation,
  while HIGH actions remain blocked until Dina approves the exact call.
- **MCP tools** — `dina_remember` (portable encrypted memory), `dina_ask`,
  `dina_validate`, `dina_scrub` / `dina_rehydrate` (PII), and session tools.
- **Usage policy** — a bundled Dina skill tells Claude when to ask personal
  context, remember facts, validate sensitive actions, and scrub external
  egress. It uses the MCP-native tool names and requires explicit session
  teardown.
- **Slash commands** — `/dina:status`, `/dina:audit`, `/dina:pair-phone`.

## Honest limits (v0.1)

- **Fail-closed only up to the running hook.** The supervisor (`bin/dina-gate`)
  turns every _child_ failure — a crash, a signal, a non-2 exit, Core being
  unreachable or slow past the gate's ~10s deadline — into a block. It **cannot**
  cover its **own** failure: if Claude Code never launches the supervisor, the
  supervisor process itself dies, or the host-side hook timeout fires, no block
  is emitted and the tool runs. Only exit 2 blocks a `PreToolUse` call. Closing
  that residual needs an independent host-level deny; it is disclosed, not hidden
  (§10, §16 of the design doc).
- **The gate is a framework-mediated guarantee, not an OS sandbox.** It stops the
  agent's tool calls, which all pass the hook. It does not stop a process that has
  already compromised the agent and calls the OS directly. The real boundary is
  an OS sandbox / non-exportable keystore / phone-held key.
- **Foundation scope.** v0.1 ships the gate + memory + sessions + the existing
  agent tools. Services, cross-Dina Talk, delegation, and PeerLens are later build
  stages; their tools are omitted here rather than shipped as dead stubs.
- **Phone pairing is not one-click yet.** Signed approval synchronization works,
  but its current environment-variable bootstrap is an engineering surface,
  not the final install/revoke/re-pair experience.
- **Fresh Home Node enrolment is not productized.** The secure Core-side
  bootstrap handoff exists, but no shipped plugin launcher consumes it and no
  owner UI issues the equivalent coding-scoped setup code. The current package
  is installable only after operator provisioning.
- **"Works with Codex"** is a later item — this package targets Claude Code.

## How it fits together

```
Claude Code ── PreToolUse hook ─▶ bin/dina-gate (supervisor, exit-2 on any failure)
                                      └─▶ dina gate-hook ─▶ POST /v1/agent/gate (Core)
Claude Code ── SessionEnd hook ─▶ dina session-end-hook ─▶ end host-bound Core session
Claude Code ── MCP client ───────▶ dina mcp-server ─▶ Core (memory, ask, validate, scrub, …)
```

Both reuse the `dina` CLI's Ed25519 signing and transport to your Home Node.
The hook's session is managed automatically from Claude's host session id.
MCP tools use explicit `dina_session_start`/`dina_session_end` scopes; they are
independently revocable rather than implicitly sharing the hook session.
