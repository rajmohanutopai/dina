# Dina for Claude Code

Dina adds a Core-owned safety gate to every Claude Code tool call and exposes
encrypted memory, approval validation, and local PII scrub/rehydrate tools over
MCP. The bundle also includes the usage skill that tells Claude when those
tools are required; no separate `dina skill install` step is needed.

## Install order

Configure Dina **before** enabling this plugin. The hook fails closed, so an
unconfigured or unreachable Home Node blocks every Claude Code tool call.

```bash
pip install --upgrade "dina-agent>=0.19.0"
dina configure --role agent
dina status
```

For this engineering preview, the setup code must come from Home Node Lite with
the `coding` agent scope. Pairing directly to mobile Core does not activate the
filesystem-aware coding gate. Run the Home Node Lite installer, open the
loopback `/owner` page it prints, enter the owner key, and select **Pair coding
agent**. The five-minute code creates a separate revocable `did:key` for this
coding device; it does not expose the owner's identity or vault keys.

After `dina status` reports that Core is reachable:

```text
/plugin marketplace add <path-or-repository-containing-cli/claude-plugin>
/plugin install dina@dina
```

Restart Claude Code if it does not immediately refresh the MCP server and hook.
Run `/dina:status` to verify the installed integration.

## What is enforced

- Every tool call goes through `bin/dina-gate`, which asks Home Node Lite Core
  for an `allow`, `approval_required`, or `deny` decision.
- MODERATE actions use Claude Code's native confirmation.
- HIGH actions remain blocked until the durable Dina approval is approved; one
  exact retry consumes the approval.
- Missing CLI, malformed input, an unreachable Core, and gate failures block.
- `/dina:audit` shows only this paired agent's projected non-SAFE gate
  decisions. It cannot read another caller's events or raw audit details.
- Gate approvals are bound to Claude's current session. The plugin ends that
  Core session on Claude `SessionEnd`; lease expiry handles crashes or forced
  termination.

The residual is disclosed: if Claude Code never launches the hook process, the
host cannot receive its blocking exit code. This is framework-mediated policy,
not an OS sandbox.

## PII round trip

Call `dina_scrub` before sending user content to an external API. It returns
scrubbed text and a `pii_id`. Call `dina_rehydrate` with the external response
and that exact `pii_id`; restoration is local to the CLI host.

## Recovery and removal

If pairing breaks, fix it in a normal terminal with `dina configure` and verify
with `dina status`. The installed gate will keep Claude Code tools blocked until
Core is reachable again.

To remove access cleanly:

```bash
claude plugin uninstall dina@dina
dina unpair
```

Uninstalling the plugin removes the Claude Code hook and MCP registration.
`dina unpair` separately revokes this agent device from the Home Node.

## Preview limitation

Enrollment and approval-phone lifecycle controls are self-service in Home Node
Lite's owner console, but this plugin does not install, launch, upgrade, or
supervise Home Node Lite. V1 supports one approval phone; multi-phone routing is
deferred. See `docs/DINA_PLUGIN_DEVELOPER_SURFACE.md` for the complete boundary
and threat model.
