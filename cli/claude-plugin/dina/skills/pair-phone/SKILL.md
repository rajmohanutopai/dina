---
name: pair-phone
description: Explain the current pairing status and prepare Home Node Lite pairing.
user-invocable: true
---

State the current limitation first: v0.1 is an engineering preview. Its
filesystem-aware coding gate runs in Home Node Lite Core, not mobile Core.
The signed laptop-Core-to-phone approval bridge exists, but this slash command
does not yet provide its final pairing/revocation UI. Pairing the agent CLI
directly to the Dina mobile app therefore does not activate the coding gate;
the hook correctly blocks when mobile Core returns `501`.

1. Confirm `dina --version` is at least 0.19.0. If missing or older:
   `pip install --upgrade "dina-agent>=0.19.0"`.
2. Confirm Home Node Lite Core is running and has issued a coding-scope setup code.
3. Run `dina configure` and paste that setup code (or `dina configure --setup-code dina1:…`).
4. Verify with `dina status`.

Explain the trust model briefly: the agent gets **its own** Ed25519 key and never sees the vault keys; every action it takes still passes the Core-owned gate on the Home Node. Remind them that until pairing is complete, the gate blocks tool calls fail-closed.

Explain that HIGH approvals can be synchronized to mobile once Home Node Lite
has been bootstrapped with a phone setup code through
`DINA_APPROVAL_PHONE_SETUP_CODE`. Do not pretend this skill performs that
bootstrap, and do not describe the bridge as production-polished: the
one-command pairing, revocation/re-pairing controls, multi-phone routing, and
stale-card cleanup remain. The V1 phone endpoint is the mobile Home Node's
`did:plc`; the laptop approval client has its own paired `did:key`. Point to
`docs/DINA_PLUGIN_DEVELOPER_SURFACE.md` §13.1.

Do **not** paste, echo, or store the setup code or any pairing code in files or output — it is single-use enrolment authority. If the user pastes one here, tell them to run `dina configure` themselves rather than having you handle it.
