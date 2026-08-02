# Dina for Claude Code

Dina adds a Core-owned safety gate to every Claude Code tool call and exposes
encrypted memory, service discovery/invocation, owner-approved contact
messaging and delegation, approval validation, and local PII scrub/rehydrate
tools over MCP. The bundle includes usage instructions; no separate
`dina skill install` step is needed.

## Installation

Install the plugin first:

```text
/plugin marketplace add rajmohanutopai/dina-plugins
/plugin install dina@dina
```

Then run:

```text
/dina:setup
```

Setup offers two explicit identity modes:

- **Public identity** provisions the chosen PDS handle as the Home Node's
  `did:plc`. This enables public Services and Ranked Reviews.
- **Local only** creates an offline `did:key`. Safety, memory, and local agent
  features work, but public publishing does not.

The bundled setup command installs the immutable `dina-agent==0.20.9` release in a private
managed Python environment when no compatible CLI is already available. It then
downloads and verifies the published native Home Node release, starts Core and
Brain, and enrolls this machine with a separate, revocable, `coding`-scoped
`did:key`. Setup also selects that exact coding identity as Dina's foreground
Brain unless an existing owner decision would be replaced or revived. Claude
can therefore provide Dina's reasoning while a Claude session is open, without
a separate metered AI API key. No source checkout, Docker, global Python
installation, owner key, or vault key is required.

The first setup call is intentionally narrow. Before Core exists, the
fail-closed hook permits only `AskUserQuestion` and the exact bundled
`bin/dina-setup` executable with validated arguments. Arbitrary Bash, file
access, MCP calls, and every other tool remain blocked. Claude's normal Bash
permission prompt remains the human consent boundary for running setup.

Restart Claude Code once after setup so the Dina MCP process starts against the
new installation. Run `/dina:status` to verify it. Foreground Brain means
Claude is not a background daemon: ask Claude to process Dina work when another
client has queued a reasoning request.

If a different Dina CLI configuration or Home Node already exists, setup
preserves it and either repairs enrollment or stops with an explicit conflict.
It will reuse an already-compatible Brain binding, but will not revive a
revoked binding or replace another owner-selected connected Brain. Use the
Owner page for those changes. Setup never purges, changes identity settings, or
chooses another config directory automatically.

To reuse an existing Dina identity, do not paste its recovery phrase into
Claude. Use a private terminal to install with the existing handle and
`--restore-identity`, then restore the portable `.dina` archive. This remains a
manual continuity path; automatic phone-to-Home-Node identity/data transfer is
not implemented.

Releases are upgraded explicitly with
`dina home-node upgrade --release <version>`. The controller stops Core for a
consistent private-data snapshot, verifies and health-checks the candidate, and
restores both the prior release and data if validation fails or an interrupted
upgrade is detected.

## What is enforced

- Every tool call goes through `bin/dina-gate`, which asks Home Node Lite Core
  for an `allow`, `approval_required`, or `deny` decision.
- Before first setup, only the bounded setup executable and
  `AskUserQuestion` bypass Core so the user can establish Core. No general
  bootstrap shell is allowed.
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

If local enrollment metadata is missing, run `/dina:setup`; it repairs the
existing Home Node and enrollment without replacing identity settings. The
installed gate keeps normal Claude Code tools blocked until Core is reachable
again.

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

Home Node installation and supervision are owned by `dina-agent`; the bundled
setup command bootstraps it and Claude's `SessionStart` hook recovers an
existing installation. Automatic local coding-agent enrollment is implemented,
along with rollback-safe release upgrades, service tools, Talk, and delegation.
Mobile identity/vault reuse is available only through the private-terminal
recovery-phrase plus portable-archive path; automatic continuity remains
unfinished. Native release archives must be published for every supported
platform. V1 supports one approval phone; multi-phone routing is deferred. See
`docs/DINA_PLUGIN_DEVELOPER_SURFACE.md` for the complete boundary and threat
model.
