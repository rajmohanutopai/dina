---
name: status
description: Show whether Dina is connected to your Home Node and the coding gate is active.
user-invocable: true
---

Run `DINA_AGENT_HOST=claude-code
"${CLAUDE_PLUGIN_ROOT}/bin/dina-cli" --version`,
`DINA_AGENT_HOST=claude-code
"${CLAUDE_PLUGIN_ROOT}/bin/dina-cli" home-node status`, and
`DINA_AGENT_HOST=claude-code
"${CLAUDE_PLUGIN_ROOT}/bin/dina-cli" status`, then report in one short paragraph:

- whether `dina --version` is at least 0.20.0 (older CLIs do not satisfy this
  plugin's hook/MCP contract),
- whether the `dina` CLI is configured and paired to a Home Node (and over which transport),
- whether Core is reachable,
- and confirm the gate is installed — this plugin's PreToolUse hook forwards
  ordinary tool calls to Core's `/v1/agent/gate` for a Core-owned decision.
  Only exact plugin-owned setup and read-only diagnostic commands are handled
  locally.

If Dina is not configured, tell the user to run `/dina:setup`. Do not claim
that pairing directly to mobile Core activates the filesystem-aware gate; it
runs in Home Node Lite Core.

Make the consequence explicit: until `dina` is configured, the gate **blocks
ordinary work tools** (fail-closed by design). Only the bounded setup and
read-only diagnostic commands remain available until pairing is done.
