---
name: dina
description: Use Dina when the user references personal data, contacts, preferences, or history; asks you to remember something; asks you to perform a sensitive action; or when user content must be sent to an external API.
---

# Use Dina

Dina is the user's personal control plane. The encrypted vault and approval
policy stay behind Dina Core; never read vault storage or keys directly.

## Required flow

1. Start a Dina session with `dina_session_start` before using Dina's MCP
   tools. Keep the returned opaque session id for this task.
2. Use `dina_ask` when the answer depends on the user's personal context,
   contacts, preferences, or history.
3. Use `dina_remember` when the user explicitly asks you to store or remember
   something about them.
4. Use `dina_validate` before a sensitive action such as sending, sharing,
   deleting, purchasing, publishing, or changing external state.
5. Use `dina_scrub` before passing user-provided content to another external
   API, then call `dina_rehydrate` once with the returned `pii_id`.
6. End the MCP session with `dina_session_end` when the task is complete.

## Approval rule

If any Dina tool returns `pending_approval`, do not perform the protected
action and do not infer approval from the conversation. Poll the corresponding
status tool and proceed only after it returns `approved`. A denial or expiry is
final for that request.

The catch-all Claude `PreToolUse` hook is separate from this MCP session. It
automatically gates every tool call using Claude's host session; do not attempt
to bypass or replace that hook.
