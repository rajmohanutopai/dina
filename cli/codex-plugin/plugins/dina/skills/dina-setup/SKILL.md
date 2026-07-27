---
name: dina-setup
description: Install or repair Dina Home Node, enroll Codex, and select Codex as Dina's foreground Brain.
---

# Set Up Dina For Codex

Use only the plugin-owned setup executable. Never request, receive, paste, or
store a recovery phrase or owner capability in this conversation.

Resolve the plugin root from this `SKILL.md` path: it is the directory two
levels above this skill directory. Invoke `bin/dina-setup` by its absolute
path.

1. Tell the user that the Dina hook must be reviewed and trusted under
   `/hooks` for safety enforcement. Setup can install Dina, but it cannot trust
   its own hook.
2. Run the exact status command:

   ```bash
   "<absolute-plugin-root>/bin/dina-setup" --status --json
   ```

3. If `cli.available` is false, or if `home_node.installed` is true, run this
   exact repair command without forwarding identity arguments. This installs
   the managed CLI when necessary, then safely discovers and repairs an
   existing Home Node:

   ```bash
   "<absolute-plugin-root>/bin/dina-setup" --ensure --json
   ```

4. If `--ensure` reports `identity_choice_required`, or status definitively
   reports that no Home Node exists, ask the user to choose one mode before
   running another command:

   - **Public identity (recommended):** required for publishing Services and
     Ranked Reviews. Ask for the complete PDS handle, then run:

     ```bash
     "<absolute-plugin-root>/bin/dina-setup" --pds-handle "<handle>" --json
     ```

   - **Local only:** safety, encrypted memory, and local agent features work,
     but public publishing and network identity do not. Run:

     ```bash
     "<absolute-plugin-root>/bin/dina-setup" --local-only --json
     ```

   `--pds-email` may be included only when the user explicitly supplies it
   together with `--pds-handle`.

5. Do not add environment assignments, redirects, shell operators, command
   substitutions, or unsupported flags to any setup command.
6. On success, explain `connected_brain.selected` plainly. If true, Codex can
   serve as Dina's foreground Brain without another AI API key while a Codex
   session is open. It is not a background daemon. If false, setup preserved
   an existing owner decision; the owner can change it on the Owner page.
7. Tell the user to trust the hook under `/hooks` and start a new Codex
   conversation so hooks and MCP reload.
8. Show the Owner URL. Tell the user to run owner-capability and
   recovery-phrase commands privately in their own terminal; never run those
   commands from Codex.

If setup reports an existing identity or configuration conflict, preserve it.
Do not purge, reinstall, replace identity settings, or choose a different
configuration directory automatically.
