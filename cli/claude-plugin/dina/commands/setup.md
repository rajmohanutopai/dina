---
description: Install or repair Dina Home Node and connect it to Claude Code
argument-hint: "[--local-only | --pds-handle <handle> [--pds-email <email>]]"
allowed-tools: AskUserQuestion
---

Set up Dina using only the bundled installer. Never request, receive, paste, or
store a recovery phrase or setup capability in this conversation.

Raw arguments:
`$ARGUMENTS`

1. Run this exact status command with a 10-minute Bash timeout:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/dina-setup" --status --json
```

2. If `cli.available` is false, or if `home_node.installed` is true, run the
   repair command below whether or not `ready` is already true. `--ensure`
   installs the managed CLI when necessary, then safely discovers and repairs
   an existing Home Node. Do not forward identity arguments:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/dina-setup" --ensure --json
```

3. If `--ensure` reports `identity_choice_required`, or status definitively
reports `home_node.installed` as false, and the user supplied valid arguments,
run the exact matching command:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/dina-setup" $ARGUMENTS --json
```

Only `--local-only`, `--pds-handle`, and `--pds-email` are supported. Do not
forward shell operators, environment assignments, redirects, command
substitutions, or additional flags.

4. If setup reports `identity_choice_required` and no mode was supplied, use
`AskUserQuestion` once:

- `Public identity (Recommended)`: required for publishing Services and Ranked
  Reviews. Explain that the user must provide the complete handle they want,
  then wait for that handle before running
  `"${CLAUDE_PLUGIN_ROOT}/bin/dina-setup" --pds-handle "<handle>" --json`.
- `Local only`: safety, encrypted memory, and local agent features work, but
  public publishing and network identity do not. Run
  `"${CLAUDE_PLUGIN_ROOT}/bin/dina-setup" --local-only --json`.

5. Present the final result plainly. On success, tell the user to restart
Claude Code once so the Dina MCP server starts against the new installation.
Explain whether `connected_brain.selected` is true. If true, Claude can serve
as Dina's foreground Brain without another AI API key while a Claude session
is open; it is not a background daemon. If false, the installer preserved an
existing owner decision and the user can change it on the Owner page. Show the
Owner URL for supervision settings and optional phone pairing. Never run the
owner-capability or recovery-phrase commands inside Claude; tell the user to
run them privately in their own terminal.

If setup reports an existing identity or configuration conflict, preserve it.
Do not delete, purge, reinstall, or choose a different config directory
automatically.
