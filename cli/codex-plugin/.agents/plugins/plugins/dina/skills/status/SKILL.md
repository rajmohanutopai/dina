---
name: status
description: Show whether Dina is connected to the Home Node and protecting supported Codex tool calls.
---

# Check Dina Status

Run `dina --version`, `dina home-node status`, and `dina status`. Report:

- whether the CLI is at least version 0.20.0;
- whether Home Node Lite is installed and healthy;
- whether this machine is enrolled with its own coding-scoped identity;
- whether Core is reachable;
- whether the plugin hook has been reviewed and trusted in Codex.

Explain that the hook fails closed after Codex launches it. If Dina is
unconfigured or unreachable, supported local tool calls are blocked until the
Home Node or pairing is repaired. Also state the host boundary: hosted tools
such as web search and any specialized path that opts out of hooks are not
covered by `PreToolUse`.
