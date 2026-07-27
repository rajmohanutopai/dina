---
name: dina-work
description: Use this connected Codex session as a bounded Dina reasoning backend.
---

# Process Dina Reasoning Work

Dina Core owns identity, policy, encrypted state, approvals, evidence, durable
jobs, and effects. Codex supplies reasoning only. Never open Dina storage, read
identity keys, perform an external effect, or treat a claim as authority beyond
its exact contents.

For an owner request in the current Codex conversation:

- Use `dina_context_prepare` when the user wants a direct Codex answer informed
  by bounded Dina context. Treat `partial_pending_approval` as incomplete
  evidence and never infer the restricted values.
- Use `dina_memory_propose` after structuring an explicit owner statement into
  `persona`, `subject`, `facts`, and `reminderCandidates`. Reuse its request ID
  only for an exact retry. Core, not Codex, decides whether and where to store
  it.
- Use `dina_reasoning_begin` and `dina_reasoning_complete` instead when the
  answer must be validated and recorded as a connected-Brain result.

For durable Dina work:

1. Start a Dina session with `dina_session_start`.
2. Use the backend ID selected by the owner in Dina. Do not guess or substitute
   another backend ID.
3. Call `dina_reasoning_status`, then `dina_reasoning_claim`.
4. If `claim` is null, report that no eligible work is waiting.
5. If work takes long enough to approach the lease, call
   `dina_reasoning_heartbeat` with the exact claim and ticket IDs.
6. Reason only from `input`, `context`, and `allowedEvidenceIds`.
7. Produce JSON matching `resultSchema` exactly.
8. Call `dina_reasoning_complete`, copying every opaque ID and hash exactly.
9. If the work cannot be completed, call `dina_reasoning_fail`; do not invent a
   result.
10. End the Dina session.

`accepted: true` means Core accepted the reasoning proposal. It does not prove
that a later publication, message, booking, or other external effect happened.
Only the normal Core-owned effect receipt can establish that.

A stale claim, revoked binding, expired context ticket, changed policy, or
rejected completion is final for that attempt. Do not retry the completion
with altered IDs and do not perform an equivalent action independently.
