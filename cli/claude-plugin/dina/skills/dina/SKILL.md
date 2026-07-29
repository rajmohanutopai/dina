---
name: dina
description: Use Dina for personal context, memory, services, contact messaging, delegation, sensitive actions, and external-API privacy.
---

# Use Dina

Dina is the user's personal control plane. The encrypted vault and approval
policy stay behind Dina Core; never read vault storage or keys directly.

## Required flow

1. Start a Dina session with `dina_session_start` before using Dina's MCP
   tools. Keep the returned opaque session id for this task.
2. Use `dina_ask` when the answer depends on the user's personal context,
   contacts, preferences, or history.
3. When the user explicitly asks you to remember an owner statement in this
   conversation, call `dina_vaults`, structure only what the user said, and
   use `dina_memory_propose`. Its `proposal` must contain exactly `persona`,
   `subject: {kind, label}`, `facts: [{text, confidence}]`, and
   `reminderCandidates: [{text, dueAtMs}]`; use an empty reminder array unless
   the source supports a concrete reminder. Only `stored` proves success. If
   it returns `pending_approval`, keep the session open and retry the exact
   proposal only after Dina reports approval.
4. Use `dina_remember` only when deliberately handing unstructured text to a
   configured always-on Dina Brain. If it returns `processing` or
   `pending_approval`, keep the session open and poll `dina_remember_status`
   with the returned item id until it returns `stored`, `denied`, or `failed`.
   Never call `dina_session_end` while a Remember operation from that session
   is non-terminal.
5. Use `dina_validate` before a sensitive action such as sending, sharing,
   deleting, purchasing, publishing, or changing external state.
6. Use `dina_find_service`, `dina_invoke_service`, and
   `dina_service_status` when another Dina service can answer or act. Discovery
   does not send vault data.
7. Use `dina_talk` to send one exact message to a known contact. Generate one
   stable request id and reuse it for every retry and
   `dina_action_status(action="talk", ...)` poll.
8. Use `dina_delegate` to queue one bounded task for a named runner. Generate
   one stable request id and reuse it with
   `dina_action_status(action="delegate", ...)`.
9. Use `dina_peerlens` to search signed public reviews. Use `dina_review` only
   when the user intends to publish a public review, and reuse its stable
   request id with `dina_review_status` until publication is terminal.
10. Use `dina_vaults` to inspect vault names and access state without reading
   contents. Use `dina_reminders` for active reminders visible to this exact
   session; never use storage or admin routes to bypass a restricted vault.
11. Use `dina_scrub` before passing user-provided content to another external
   API, then call `dina_rehydrate` once with the returned `pii_id`.
12. End the MCP session with `dina_session_end` when the task is complete.

## Approval rule

If any Dina tool returns `pending_approval`, do not perform the protected
action and do not infer approval from the conversation. Poll the corresponding
status tool and proceed only after it returns `approved`. A denial or expiry is
final for that request.

Talk and delegation are executed by their status tool after approval. For
these two operations, only `completed` proves Dina accepted the message or
task. Review publication is also continued by its status tool; only
`publish_status: published` proves it reached the PDS. `pending_approval`,
`queued`, `publishing`, and `running` all mean wait. Never perform an
equivalent action independently while a Dina request is pending or durably
queued.

The catch-all Claude `PreToolUse` hook is separate from this MCP session. It
automatically gates every ordinary tool call using Claude's host session; the
plugin has only bounded local exceptions for setup and read-only diagnostics.
Do not attempt to bypass or replace that hook.
