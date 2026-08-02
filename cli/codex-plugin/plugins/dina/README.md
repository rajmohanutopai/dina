# Dina for Codex

Dina connects Codex to a user-owned Home Node for deterministic tool gating,
encrypted personal memory, service discovery and invocation, owner-approved
contact messaging and delegation, human approvals, and local PII scrubbing.

## Installation

Install the marketplace and plugin:

```bash
codex plugin marketplace add rajmohanutopai/dina-plugins
codex plugin add dina@dina
```

The marketplace repository is a small release mirror of the Dina monorepo, so
installs stay light and update only when a plugin release is published.

Start Codex, invoke `$dina-setup` or say **Set up Dina**, and follow the
identity choice. Setup installs a compatible CLI in a plugin-managed
environment when needed, downloads and verifies the native Home Node, starts
Core and Brain, enrolls this machine with a separate coding-scoped `did:key`,
and selects that exact identity as Dina's foreground Brain unless doing so
would replace or revive an existing owner decision.

No source checkout, Docker, global Python package, owner key, or vault key is
required. The plugin manages the pinned `dina-agent==0.20.6`
installation. A public PDS handle provisions the Home Node's `did:plc` and
enables public Services and Ranked Reviews. Local-only setup creates a private
`did:key`; safety, memory, and local agent features work, but public publishing
does not.

Codex can reason for Dina without another metered AI API key while a Codex
session is open. It is not a background daemon: ask Codex to process queued
Dina work when another client needs its reasoning.

## After Installation

Open `/hooks`, review the Dina hook definition, and trust it. Codex skips
untrusted plugin hooks. Start a new conversation after setup or a plugin update
so the bundled hooks, skills, and MCP server reload.

Before Core exists, the trusted gate permits only the exact plugin-owned setup
executable with validated arguments. Every other supported local tool remains
blocked. Codex's normal command approval remains the human consent boundary
for running setup.

## Enforcement

- `SessionStart` recovers an already-installed Home Node.
- `PreToolUse` sends supported local tool calls to Home Node Core.
- Safe actions continue silently.
- Moderate and high-risk actions create durable Dina approvals and block.
- After approval, an exact retry consumes the permit.
- Denials, malformed requests, a missing CLI, and Core failures block.
- `SessionEnd` best-effort revokes the host-bound Core session; lease expiry is
  the crash backstop.

Codex currently cannot ask for local approval from a `PreToolUse` hook.
Therefore moderate-risk calls use the same phone/owner approval path as
high-risk calls rather than failing open.

## Honest Boundary

This is framework-mediated policy, not an OS sandbox. The hook covers Bash,
`apply_patch`, MCP calls, and most local function tools that Codex routes
through `PreToolUse`. Hosted tools such as web search are not hook-visible, and
specialized paths may opt out. If Codex never launches or trusts the hook, no
hook can enforce policy; inspect `/hooks` before relying on the gate.

The MCP profile provides sessions, memory, Ask, validation, PII, Services,
PeerLens, Talk, delegation, reminders, and bounded vault-metadata inspection.
Talk, delegation, and public review publication use stable request IDs and
must be polled after phone approval; Codex must not perform an equivalent
action independently while approval or a durable retry is pending.

If another Dina installation or Brain selection already exists, setup repairs
compatible enrollment but preserves identity and owner policy. It never
purges data or silently replaces a revoked or competing Brain binding.
