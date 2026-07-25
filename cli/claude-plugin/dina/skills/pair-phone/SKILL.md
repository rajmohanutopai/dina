---
name: pair-phone
description: Guide the owner through coding-agent and approval-phone pairing.
user-invocable: true
---

State the boundary first: the filesystem-aware coding gate runs in Home Node
Lite Core, not mobile Core. Pairing the agent CLI directly to the Dina mobile
app therefore does not activate the coding gate; the hook correctly blocks
when mobile Core returns `501`.

1. Confirm `dina --version` is at least 0.20.0. If missing or older:
   `pip install --upgrade "dina-agent>=0.20.0"`.
2. Confirm Home Node Lite Core is running with `dina home-node status`.
   `dina home-node install` normally enrolls the local coding agent
   automatically.
3. If enrollment metadata needs repair, run `dina home-node enroll-agent` in a
   normal terminal. It preserves any configuration belonging to another Home
   Node.
4. Verify with `dina status`.

Explain the trust model briefly: the agent gets **its own** Ed25519 key and never sees the vault keys; every action it takes still passes the Core-owned gate on the Home Node. Remind them that until pairing is complete, the gate blocks tool calls fail-closed.

Explain that HIGH approvals can be synchronized to mobile:

1. Generate an agent setup code in the Dina mobile app.
2. On the Home Node's owner page, paste it under **Approval phone** and select
   **Pair phone**.
3. Use the same owner page to revoke before pairing a replacement.

This skill only guides the owner; it must not receive or handle the phone setup
code. The V1 phone endpoint is the mobile Home Node's canonical `did:plc`; the
laptop approval client has its own revocable `did:key`. V1 supports one phone.
Point to `docs/DINA_PLUGIN_DEVELOPER_SURFACE.md` §13.1.

Do **not** paste, echo, or store a setup code or pairing code in files or
output. It is single-use enrolment authority. If the user pastes one here,
tell them to enter it directly in `dina configure` or the owner console rather
than having the agent handle it.
