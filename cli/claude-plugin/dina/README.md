# Dina for Claude Code

Dina adds a Core-owned safety gate to every Claude Code tool call and exposes
encrypted memory, service discovery/invocation, owner-approved contact
messaging and delegation, approval validation, and local PII scrub/rehydrate
tools over MCP. The bundle includes usage instructions; no separate
`dina skill install` step is needed.

## Install order

Configure Dina **before** enabling this plugin. The hook fails closed, so an
unconfigured or unreachable Home Node blocks every Claude Code tool call.

```bash
pip install --upgrade "dina-agent>=0.20.0"
dina home-node install --pds-handle your-handle.example.com
dina home-node show-recovery-phrase
dina status
```

`dina home-node install` installs a published native platform release without a
source checkout or external runtime and automatically enrolls this machine with
a separate, revocable, `coding`-scoped `did:key`. The archive includes its
matching Node runtime and SQLCipher binding; installation verifies every file
against the release manifest. Pairing directly to mobile Core does not activate
the filesystem-aware coding gate. The automatic path never prints or persists
the owner or one-time pairing capability. If a different Dina CLI configuration
already exists, it is preserved and installation stops with an explicit
conflict; use a separate `DINA_CONFIG_DIR` or run
`dina home-node install --no-enroll`.

`--pds-handle` provisions the owner's public `did:plc` and is required for
public Services and PeerLens writes. Omit it only for a deliberately
local-only Home Node. To reuse an existing Dina identity, install with the
existing handle and `--restore-identity`, then restore the portable `.dina`
archive. This is a manual continuity path; automatic phone-to-Home-Node
identity/data transfer is not implemented.

Releases are upgraded explicitly with
`dina home-node upgrade --release <version>`. The controller stops Core for a
consistent private-data snapshot, verifies and health-checks the candidate, and
restores both the prior release and data if validation fails or an interrupted
upgrade is detected.

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

## Network and personal-data tools

Claude can discover and invoke services through the Home Node without sending
vault data during discovery. Service calls are asynchronous and must be polled
with the same Dina session.

Contact messages and delegated tasks are owner-approved, exact, idempotent
actions. Claude generates one stable request id, submits the action once, and
polls `dina_action_status` with that same id. It must wait while approval is
pending and may claim success only after the status is `completed`.

The coding profile also exposes bounded vault metadata, session-scoped
reminders, PeerLens search, and owner-approved durable review publication. It
never exposes raw vault or PDS credentials.

## Recovery and removal

If local enrollment metadata is missing, repair it in a normal terminal with
`dina home-node enroll-agent` and verify with `dina status`. The command never
overwrites a configuration belonging to another Home Node. The installed gate
keeps Claude Code tools blocked until Core is reachable again.

To remove access cleanly:

```bash
claude plugin uninstall dina@dina
dina unpair
```

Uninstalling the plugin removes the Claude Code hook and MCP registration.
`dina unpair` separately revokes this agent device from the Home Node.
`dina home-node uninstall` preserves both the encrypted Home Node data and the
agent credentials. A confirmed `dina home-node uninstall --purge-data` removes
the vault and removes local credentials only when they are still proven to be
installer-managed credentials for that exact Home Node.

## Preview limitation

Home Node installation and supervision are owned by `dina-agent`; Claude's
`SessionStart` hook recovers an existing installation. Automatic local
coding-agent enrollment is implemented, along with rollback-safe release
upgrades, service tools, Talk, and delegation. Mobile identity/vault reuse
is available only through the manual recovery-phrase plus portable-archive
path; automatic continuity remains unfinished. Native release archives must be
published for every supported platform. V1 supports one approval phone;
multi-phone routing is deferred. See
`docs/DINA_PLUGIN_DEVELOPER_SURFACE.md` for the complete boundary and threat
model.
