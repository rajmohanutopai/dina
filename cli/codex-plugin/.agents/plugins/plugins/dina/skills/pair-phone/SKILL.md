---
name: pair-phone
description: Guide the owner through local coding-agent enrollment and optional approval-phone pairing.
---

# Pair Dina

State the boundary first: the filesystem-aware coding gate runs in Home Node
Lite Core. Pairing the CLI directly to mobile Core does not activate it.

1. Ensure `dina --version` is at least 0.20.0.
2. Run `dina home-node install`; it normally enrolls this machine
   automatically with a separate, revocable coding-scoped `did:key`.
3. Record the owner recovery phrase with
   `dina home-node show-recovery-phrase`.
4. If enrollment metadata needs repair, run `dina home-node enroll-agent`.
5. Verify with `dina home-node status` and `dina status`.

For phone approvals, generate an agent setup code in the Dina mobile app, then
enter it directly in the Home Node owner page under **Approval phone**. Never
ask the user to paste a setup code into chat, and never echo or store one.

The Home Node owner identity may be a `did:plc`; the coding agent intentionally
uses its own revocable `did:key`. The agent never receives owner identity keys
or vault keys.
