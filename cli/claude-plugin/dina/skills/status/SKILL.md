---
name: status
description: Show whether Dina is connected to your Home Node and the coding gate is active.
user-invocable: true
---

Call the `dina_status` MCP tool and use its authenticated result as the source
of truth for connectivity and pairing. Do not diagnose connectivity by probing
Home Node loopback URLs through a shell tool because host sandboxing can create
a false offline result. Report in one short paragraph:

- whether Dina is connected and this machine is paired,
- the installed Dina CLI version,
- the coding identity DID,
- local Home Node health and release when `dina_status` includes it,
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
