# Dina for Codex

Dina connects Codex to a user-owned Home Node for deterministic tool gating,
encrypted personal memory, service discovery and invocation, owner-approved
contact messaging and delegation, human approvals, and local PII scrubbing.

## Prerequisites

Install and enroll the CLI before enabling the plugin. The gate is fail-closed,
so an unconfigured or unreachable Home Node blocks supported local tool calls.

```bash
pip install --upgrade "dina-agent>=0.20.0"
dina home-node install --pds-handle your-handle.example.com
dina home-node show-recovery-phrase
dina home-node status
dina status
```

The installer uses a published native platform release and enrolls this machine
with a separate coding-scoped `did:key`. It requires no source checkout or
external runtime; the archive carries its matching Node runtime and SQLCipher
binding, and installation verifies each file against the release manifest.
Existing CLI configuration is preserved rather than overwritten. The PDS
handle provisions the owner's `did:plc` and enables public Services and
PeerLens publication. Omit it only for a deliberately local-only Home Node. To
reuse an existing Dina identity, install with that identity's handle plus
`--restore-identity`, then restore its portable `.dina` archive; automatic
phone-to-Home-Node continuity is not yet implemented.

## After Installation

Open `/hooks`, review the Dina hook definition, and trust it. Codex skips
untrusted plugin hooks. Start a new conversation after installing or updating
the plugin so the bundled hooks, skills, and MCP server are loaded.

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
