---
name: status
description: Show whether Dina is connected to your Home Node and the coding gate is active.
user-invocable: true
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/dina-cli" --version`,
`"${CLAUDE_PLUGIN_ROOT}/bin/dina-cli" home-node status`, and
`"${CLAUDE_PLUGIN_ROOT}/bin/dina-cli" status`, then report in one short
paragraph:

- whether `dina --version` is at least 0.20.0 (older CLIs do not satisfy this
  plugin's hook/MCP contract),
- whether the `dina` CLI is configured and paired to a Home Node (and over which transport),
- whether Core is reachable,
- and confirm the gate is installed — this plugin's PreToolUse hook forwards **every** tool call to Core's `/v1/agent/gate` for a Core-owned decision.

If Dina is not configured, tell the user to run `/dina:setup`. Do not claim
that pairing directly to mobile Core activates the filesystem-aware gate; it
runs in Home Node Lite Core.

Make the consequence explicit: until `dina` is configured, the gate **blocks
every tool call** (fail-closed by design), so Claude Code cannot run tools until
pairing is done.
