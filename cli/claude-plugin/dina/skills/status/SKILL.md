---
name: status
description: Show whether Dina is connected to your Home Node and the coding gate is active.
user-invocable: true
---

Run `dina status` and report, in one short paragraph:

- whether `dina --version` is at least 0.19.0 (older CLIs do not satisfy this
  plugin's hook/MCP contract),
- whether the `dina` CLI is configured and paired to a Home Node (and over which transport),
- whether Core is reachable,
- and confirm the gate is installed — this plugin's PreToolUse hook forwards **every** tool call to Core's `/v1/agent/gate` for a Core-owned decision.

If `dina status` shows it is **not** configured, state the v0.1 limitation:
the filesystem-aware gate currently runs in Home Node Lite Core, so the user
must run `dina configure` with a coding-scope setup code issued by that Home
Node. Do not claim that pairing directly to the mobile app activates this gate;
the laptop-Core-to-phone bridge is a separate Home Node Lite bootstrap and its
final one-command pairing/status UI is not implemented yet.

Make the consequence explicit: until `dina` is configured, the gate **blocks
every tool call** (fail-closed by design), so Claude Code cannot run tools until
pairing is done.
