---
name: status
description: Show whether Dina is connected to the Home Node and protecting supported Codex tool calls.
---

# Check Dina Status

Call the `dina_status` MCP tool. Treat its authenticated result as the source
of truth for connectivity and pairing. Do not diagnose connectivity by running
`dina status` or probing Home Node loopback URLs through a shell tool: Codex's
sandbox may block that process or loopback access and produce a false offline
result.

Report:

- whether Dina is connected and this machine is paired;
- the installed Dina CLI version;
- the coding identity DID;
- local Home Node health and release when `dina_status` includes it;
- whether this machine is enrolled with its own coding-scoped identity;
- that Codex hook trust must be checked by the user in `/hooks`; Dina cannot
  infer that UI decision from MCP.

Explain that the hook fails closed after Codex launches it. If Dina is
unconfigured or unreachable, supported local tool calls are blocked until the
Home Node or pairing is repaired. Also state the host boundary: hosted tools
such as web search and any specialized path that opts out of hooks are not
covered by `PreToolUse`.
