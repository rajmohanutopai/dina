---
name: pair-phone
description: Guide the owner through local coding-agent enrollment and optional approval-phone pairing.
---

# Pair Dina

State the boundary first: the filesystem-aware coding gate runs in Home Node
Lite Core. Pairing the CLI directly to mobile Core does not activate it.

1. Run `/dina:setup` if Home Node is not installed or enrollment needs repair.
   It preserves an existing identity and configuration.
2. Verify with
   `DINA_AGENT_HOST=codex "${PLUGIN_ROOT}/bin/dina-cli" home-node status` and
   `DINA_AGENT_HOST=codex "${PLUGIN_ROOT}/bin/dina-cli" status`.

The owner must record any recovery phrase themselves in a private terminal.
Never run a recovery-authority reveal command, and never request, receive,
echo, or store a recovery phrase.

For phone approvals, generate an agent setup code in the Dina mobile app, then
enter it directly in the Home Node owner page under **Approval phone**. Never
ask the user to paste a setup code into chat, and never echo or store one.

The Home Node owner identity may be a `did:plc`; the coding agent intentionally
uses its own revocable `did:key`. The agent never receives owner identity keys
or vault keys.
