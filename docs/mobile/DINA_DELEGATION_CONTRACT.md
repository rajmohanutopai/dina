# Dina Delegation Contract — Wire Protocol for External Execution Planes (v1)

**Status:** Dina-specific contract proposal. This document is only lightly inspired by `claw-code` task packets and MCP runtime patterns; the signed, capability-scoped, callback-driven contract described here does not exist as such in `claw-code` and is not implemented in current Dina. · **Audience:** Dina Mobile team, Basic Dina team, OpenClaw team, future MCP integrators · **Scope:** the contract between Dina and any external execution plane that performs delegated work on Dina's behalf — task packet shape, authentication, trust, result schema, callback correlation, audit, and failure handling.

## Document Suite

- **[DINA_ARCHITECTURE_OVERVIEW.md](./DINA_ARCHITECTURE_OVERVIEW.md)** — the map.
- **[DINA_AGENT_KERNEL.md](./DINA_AGENT_KERNEL.md)** — the synchronous turn loop.
- **[DINA_WORKFLOW_CONTROL_PLANE.md](./DINA_WORKFLOW_CONTROL_PLANE.md)** — durable state, lifecycles, ingestion.
- **DINA_DELEGATION_CONTRACT.md** — this document.

## Provenance and Reading Contract

This document should be read as a **forward-looking Dina contract**, not as a summary of an existing external execution protocol in `claw-code`.

Reference inputs are limited:

- `claw-code/rust/crates/runtime/src/task_packet.rs` — useful for explicit task envelope fields and validation discipline
- `claw-code/rust/crates/runtime/src/mcp_stdio.rs` and `mcp_tool_bridge.rs` — useful for capability, schema, and tool/resource lifecycle ideas

Everything beyond that — DID identities, signed envelopes, callback auth, audit destinations, capability scoping, and cryptographic correlation — is Dina-specific design.

## Provenance Summary

| Area | Classification | Notes |
|------|----------------|-------|
| Packet validation discipline | **[Reference-derived]** in spirit | Inspired by `task_packet.rs`, but redesigned here for delegation |
| Capability scoping and schema-bearing payloads | Mixed | Influenced by MCP tool contracts, but generalized here into Dina's external execution contract |
| DID identities, signatures, callback auth, audit requirements | **[Dina addition]** | Not present as such in the reference runtime |
| Correlation proofs, quarantine on mismatch, result verification | **[Dina addition]** | Dina-specific trust and sovereignty requirements |
| Cancellation, retry, idempotency across planes | Mixed, mostly Dina-specific | General distributed-systems design rather than a direct runtime borrowing |

Unless a section explicitly says otherwise, patterns in this document should be read as **[Dina addition]**.

## Current Dina Alignment

Current Dina has:

- direct MCP/OpenClaw integrations for provider-side tool execution
- service discovery and public-service D2D flows
- no general signed external delegation contract matching this document

Treat this document as the contract to build **when** Dina introduces real external execution planes that need durable, auditable, capability-scoped delegation.

## Preface

Dina is designed to delegate heavy, specialized, or privileged execution to external planes — most prominently **OpenClaw** (a capable agent execution environment), plus MCP servers and webhook integrations. The delegation contract is the wire-level spec that makes this delegation safe, auditable, and reliable.

This is not a tutorial, and it's not Dina-internal. It's a contract **other teams can implement** to accept Dina delegations. OpenClaw team should be able to read this document and implement Dina-compatible delegation endpoints. MCP server authors can read this to expose Dina-delegatable tools.

## Scope — In and Out

**In scope:**
- Outbound task packet shape and validation
- Capability scoping (what the external plane is authorized to do)
- Authentication and trust (who Dina is, who the external plane must prove to be)
- Result schema (success, failure, partial)
- Callback correlation and delivery
- Audit requirements on both sides
- Timeout, retry, and cancellation semantics
- Error taxonomy

**Out of scope:**
- How external planes execute internally (their business)
- How Dina decides to delegate (control plane concern — see workflow doc)
- How results enter the kernel (control plane ingest — see workflow doc)
- Specific OpenClaw or MCP implementation details

## Guiding Principles

1. **Least privilege always.** Every delegation includes an explicit capability scope. The external plane cannot exceed this scope even if its own system says "yes." The scope travels with the packet and is audited on both ends.

2. **Signed envelopes, always.** Every packet in both directions is signed by the sender's DID. Verification is mandatory — unsigned packets are rejected at the boundary.

3. **Correlation is cryptographic.** The `correlation_id` is not just a convenience string — its binding to the original task is signed. Results arriving without a valid correlation proof are quarantined.

4. **Idempotent delivery.** Both outbound submissions and inbound results must be safely replayable. Each side tracks "seen" identifiers.

5. **Results are data, not instructions.** Kernel-side sanitization (kernel invariant #8) applies to all result payloads identically to tool outputs — a delegation result cannot hide a `<system-reminder>` or otherwise inject.

6. **Auditable by default, verifiable on demand.** Every delegation produces matching audit entries on both sides. Dina can later present proof of what was delegated, to whom, under what scope, with what result.

7. **Graceful degradation.** If the contract version is incompatible, the delegation is refused at the boundary with a clear reason — never partial acceptance.

## Wire Shape — Outbound Task Packet

```json
{
  "contract_version": "dina-delegation-v1",
  "packet_id": "pkt_01H...",
  "sent_at_ms": 1744670400000,
  "from": {
    "entity": "dina",
    "user_did": "did:key:z6Mk...abc",
    "session_id": "sess_01H...",
    "device_id": "device_01H..."
  },
  "to": {
    "entity": "openclaw" | "<mcp-server-name>" | "<webhook-endpoint>",
    "expected_did": "did:key:z6Mk...xyz"
  },
  "correlation": {
    "correlation_id": "corr_01H...",
    "task_id": "task_01H...",
    "parent_correlation_id": "corr_01H..." | null
  },
  "capability": {
    "scope": ["tool.web_fetch", "tool.code_execute"],
    "persona_context": "general",
    "data_access": {
      "personas_readable": ["general"],
      "personas_writable": [],
      "pii_scrubbed": true,
      "max_egress_bytes": 10000000
    },
    "expiry_at_ms": 1744674000000
  },
  "payload": {
    "task_description": "Fetch the HTML from https://example.com/article and summarize it in 3 bullets.",
    "inputs": {
      "url": "https://example.com/article",
      "max_length": 500
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "summary": {"type": "string"},
        "source_url": {"type": "string"}
      },
      "required": ["summary"]
    }
  },
  "policy": {
    "max_wall_clock_ms": 300000,
    "max_retries": 2,
    "idempotency_key": "idem_...",
    "cancellation_allowed": true
  },
  "audit": {
    "audit_requirements": ["record_each_tool_call", "preserve_raw_outputs", "sign_result"],
    "audit_destination": "https://audit.dina.example/ingest" | null
  },
  "callback": {
    "callback_mode": "push" | "poll",
    "callback_url": "https://dina.example/ingest/delegation" | null,
    "callback_auth": "bearer <short-lived-token>" | null,
    "poll_endpoint": "https://openclaw.example/status/pkt_01H..." | null
  },
  "signature": {
    "alg": "Ed25519",
    "signer_did": "did:key:z6Mk...abc",
    "signature_hex": "deadbeef..."
  }
}
```

### Field-by-field notes.

**`contract_version`** — version string. Mismatched versions must be refused at the boundary (see `contract_version_rejected` error).

**`from` / `to`** — identity declarations. `expected_did` in `to` is what Dina expects the external plane to prove via its signed response. If the response comes signed by a different DID, results are quarantined.

**`correlation.*`** — IDs for tracking and idempotency. `correlation_id` is the primary identifier for matching requests to results. `task_id` references the control-plane task record. `parent_correlation_id` enables tracing when this delegation is itself the result of a higher-level delegation.

**`capability.scope`** — list of capabilities the external plane is permitted to use for this task. Scope names are well-defined (see Capability Catalog below). The external plane must NOT exceed this scope even if its internal policy would allow it.

**`capability.data_access`** — what Dina data flows along with the delegation.
- `personas_readable/writable` — which personas the external plane may read/write (typically empty for writes; Dina keeps vault mutation internal).
- `pii_scrubbed: true` means the inputs in the payload have been PII-scrubbed (Dina kernel invariant #3). The external plane sees scrub tokens, not raw identifiers.
- `max_egress_bytes` — upper bound on outbound data from the external plane's side during execution (to third parties outside Dina's trust boundary).

**`capability.expiry_at_ms`** — capability grant expiry. External plane must complete within this window; after expiry, the capability is invalid and any further actions are unauthorized.

**`payload.task_description`** — the LLM-friendly description Dina wants the external plane to act on. May be used by the external plane's own agent if it has one.

**`payload.inputs`** — structured, type-safe inputs. Validated against the external plane's tool schema on their side.

**`payload.output_schema`** — JSON Schema the external plane's result must validate against. Results failing schema validation are rejected at the boundary.

**`policy.*`** — timeout, retry, idempotency, cancellation. External plane must honor these.

**`audit.*`** — what Dina requires the external plane to log, and optionally where to send it. `audit_destination` enables tamper-evident cross-organization audit when both parties trust a common audit service.

**`callback.*`** — how the result gets back. Two modes:
- `push` — external plane POSTs to `callback_url` with short-lived bearer token
- `poll` — Dina polls `poll_endpoint` for status

**`signature.*`** — Ed25519 signature over the canonicalized packet (signature fields excluded per Dina's `canonicalize()` spec). Verifies `from.user_did`.

## Capability Catalog (v1)

Capability names are well-defined strings. Each has clear semantics and the external plane is expected to implement it consistently.

| Capability | Semantics | Data access required |
|------------|-----------|----------------------|
| `tool.web_fetch` | Fetch a URL's content (GET). Return text + metadata. | Outbound network |
| `tool.web_search` | Perform a web search. Return top N results. | Outbound network |
| `tool.code_execute` | Execute code in a sandboxed environment. Return stdout/stderr/exit. | Sandbox |
| `tool.file_analyze` | Analyze a file (PDF, image, audio). Return structured extraction. | File input |
| `tool.llm_reason` | Run an LLM prompt with specified model and context. Return response. | LLM API |
| `tool.mcp_proxy` | Proxy a specific MCP server's tools. Return tool results. | MCP server |
| `workflow.multi_step` | Run a multi-step workflow with branching (e.g., research then summarize then translate). | Any capabilities listed in sub-request |

Each capability has its own payload schema. E.g., `tool.web_fetch` expects `{url, timeout_ms?, max_bytes?}`. Unsupported capabilities must be refused at the boundary with `capability_not_supported`.

## Wire Shape — Result Packet

```json
{
  "contract_version": "dina-delegation-v1",
  "packet_id": "rpkt_01H...",
  "sent_at_ms": 1744670700000,
  "in_reply_to": "pkt_01H...",
  "correlation": {
    "correlation_id": "corr_01H...",
    "task_id": "task_01H..."
  },
  "from": {
    "entity": "openclaw",
    "did": "did:key:z6Mk...xyz"
  },
  "result": {
    "status": "success" | "partial" | "failure" | "cancelled",
    "payload": { /* conforms to original output_schema if success/partial */ },
    "artifacts": [
      {
        "kind": "log" | "transcript" | "raw_output",
        "location": "inline" | "uri",
        "content": "..." | null,
        "uri": "..." | null,
        "hash": "sha256:...",
        "size_bytes": 12345
      }
    ],
    "usage": {
      "wall_clock_ms": 28321,
      "tool_calls": 4,
      "llm_tokens_in": 4500,
      "llm_tokens_out": 800,
      "egress_bytes": 120000
    }
  },
  "error": null | {
    "kind": "capability_denied" | "timeout" | "schema_violation" | "tool_error" | "policy_violation" | "internal" | "cancelled_by_user",
    "message": "Clear human-readable message",
    "retryable": bool,
    "details": { /* kind-specific */ }
  },
  "audit_references": [
    {"kind": "openclaw_task_log", "uri": "..."},
    {"kind": "signed_audit_record", "signature_hex": "..."}
  ],
  "signature": {
    "alg": "Ed25519",
    "signer_did": "did:key:z6Mk...xyz",
    "signature_hex": "deadbeef..."
  }
}
```

### Field notes.

**`result.status`** — `success` (fully complete, payload matches schema), `partial` (some work done, explained in payload and error), `failure` (no usable result), `cancelled` (stopped before completion).

**`result.payload`** — present when `status` in (`success`, `partial`). Must validate against the original `output_schema`.

**`result.artifacts`** — optional. Includes logs, transcripts, raw LLM outputs, intermediate files. Each artifact is either inline (`content`) or referenced (`uri`). Hashed for integrity.

**`result.usage`** — resource accounting. Dina uses this for cost tracking and limits.

**`error`** — non-null only when `status` is `failure`, `partial`, or `cancelled`. `kind` enumeration is fixed (see error taxonomy below).

**`audit_references`** — pointers to audit records on the external side (and optionally common audit service).

**`signature`** — signs the canonicalized result. Signer DID must match the `expected_did` in the original outbound packet (or one of its declared fallbacks).

## Error Taxonomy

| `kind` | Meaning | Retryable |
|--------|---------|-----------|
| `contract_version_rejected` | External plane doesn't support this contract version | no |
| `capability_not_supported` | Requested capability not implemented | no |
| `capability_denied` | External plane refuses (policy) | no |
| `signature_invalid` | Signature verification failed | no |
| `correlation_mismatch` | Signed correlation proof invalid | no |
| `schema_violation` | Input or output didn't match schema | no |
| `policy_violation` | External plane violated Dina's policy (exceeded egress, used unscoped capability) | no |
| `timeout` | Exceeded `max_wall_clock_ms` | yes |
| `tool_error` | Underlying tool raised | usually yes |
| `rate_limited` | External plane throttled | yes (with backoff) |
| `unreachable` | Network / infrastructure | yes |
| `cancelled_by_user` | User cancelled | no |
| `internal` | Uncategorized | varies |

## Signing and Verification

Both sides use Ed25519 signatures. The signature is over a canonicalized JSON form of the packet with the `signature` field omitted.

**Canonicalization** follows Dina's existing `canonicalize()` spec:
1. Keys sorted alphabetically at every level
2. No whitespace
3. UTF-8 encoding
4. The `signature` field is the only field omitted from canonicalization

**Signing (sender).**
```
canonical = canonicalize(packet - "signature")
signature_hex = ed25519_sign(canonical, sender_private_key)
packet.signature = { alg: "Ed25519", signer_did, signature_hex }
```

**Verification (receiver).**
```
canonical = canonicalize(received - "signature")
signer_pub = resolve_did_to_public_key(received.signature.signer_did)
if not ed25519_verify(canonical, received.signature.signature_hex, signer_pub):
    reject("signature_invalid")
if received.signature.signer_did != expected_did:  # outbound.to.expected_did
    reject("signer_unexpected")
```

**DID resolution.** `did:key` resolution is purely local (public key embedded in DID). Other DID methods require network resolution; receivers should cache resolutions.

## Trust Model

**Dina trusts the external plane per user configuration.** The user (or Dina policy on user's behalf) declares which DIDs are trusted endpoints for delegation. Before sending an outbound packet, the control plane verifies `to.expected_did` is in the user's trust list.

**External plane trusts Dina per its own policy.** Typically based on `from.user_did` being a known account or a provisioned API key tied to a user. API-key-based auth can complement signature auth (both required for sensitive capabilities).

**Trust attestations from third parties can short-circuit direct trust.** If the user's trust network contains signed attestations about the external plane's DID (e.g., "verified_execution_environment"), the control plane can auto-add to trusted endpoints after user confirmation.

## Callback Correlation — Cryptographic Binding

The `correlation_id` alone is a string; a replay attack could resubmit an old result. To prevent this, the outbound packet's `correlation_id` is cryptographically bound:

```
correlation_id = base58(hash(task_id || user_did || timestamp || nonce))
```

And the result's signature includes the `in_reply_to` (outbound packet_id) inside its canonicalized content. Replaying an old result from a past delegation fails because the `in_reply_to` won't match the current active packet for that correlation_id.

**Duplicate result handling.** If a valid result arrives for a correlation already terminated (result already processed), treat as idempotent no-op; log as `duplicate_result` event.

## Cancellation Protocol

Dina's control plane can cancel an in-flight delegation:

**Request.**
```json
{
  "contract_version": "dina-delegation-v1",
  "packet_id": "cpkt_01H...",
  "action": "cancel",
  "correlation_id": "corr_01H...",
  "reason": "user_requested" | "timeout" | "dependency_failure" | "policy_change",
  "signature": { ... }
}
```

**Response.**
```json
{
  "contract_version": "dina-delegation-v1",
  "packet_id": "crpkt_01H...",
  "in_reply_to": "cpkt_01H...",
  "status": "cancelled" | "cancel_pending" | "too_late_already_completed",
  "partial_result": { /* if any work was already done */ } | null,
  "signature": { ... }
}
```

`cancel_pending` state means the external plane is honoring the cancel but cleanup takes time. Dina's control plane polls or awaits a follow-up result packet.

`too_late_already_completed` means the work completed before cancellation arrived. The normal result packet should follow.

## Idempotency

Both submission and result delivery are idempotent.

**Submission.** If Dina retries an outbound packet with the same `packet_id`, the external plane must detect and deduplicate. Return the current status as a result packet; do not re-execute.

**Result delivery.** If the external plane retries a result packet, Dina's ingest router deduplicates by `(correlation_id, packet_id)`. Already-processed results are acknowledged without re-running the turn.

## Audit Requirements

**Both sides must log:**
- Packet receipt (inbound and outbound, including invalid ones that were rejected)
- Signature verification results
- Capability checks and decisions
- State transitions of the correlation
- Complete input/output for the delegation (subject to retention policy)

**Format.** Audit records are Dina's standard audit entry format (see Dina core's audit module):
```json
{
  "audit_id": "aud_01H...",
  "at_ms": ...,
  "actor_did": "did:key:...",
  "action": "delegation_outbound" | "delegation_result_received" | ...,
  "subject": "corr_01H...",
  "details": { /* action-specific */ },
  "signature_hex": "..."
}
```

**Retention.** Audit records are retained per user policy (default 90 days for delegations). Exportable as part of Dina's data export.

**Cross-organization audit** (optional). When the outbound packet's `audit.audit_destination` is set, both sides POST matching audit records to a common service. This enables third-party verification of the delegation's conduct.

## Implementation Notes for External Execution Planes

If you are building a delegation endpoint (OpenClaw, MCP server, webhook integrator):

1. **Minimum viable implementation.**
   - Accept POST of outbound packets at a declared endpoint
   - Verify contract version, signature, capability scope
   - Validate payload against capability's input schema
   - Execute (in your own system)
   - Produce result packet conforming to output schema
   - Sign with your DID
   - Deliver via push (POST to callback_url) or poll response

2. **Capability implementation.** Each capability you claim to support must behave identically to the catalog definition. Don't add surprising behaviors.

3. **Audit logging.** Implement the audit requirements in the outbound packet. Failure to log as required is a `policy_violation` even if the execution succeeded.

4. **Respect capability expiry.** When `capability.expiry_at_ms` is in the past, refuse the task with `capability_denied` and reason `expired`.

5. **Surface usage transparently.** Your result's `usage` section must be accurate. Dina may reject delegations that consistently under-report.

6. **Never exceed capability scope.** If asked to do X but your system would also want to do Y, refuse Y. If Y is needed, request via a sub-delegation (with its own correlation, child of the original).

7. **Handle partial completion cleanly.** If 70% done when timeout hits, return `status: partial` with what you have. Don't silently discard.

## Contract Versioning

This document is **v1**. Breaking changes produce v2; additions that are backward-compatible are v1.N.

**Version negotiation.** On outbound, the sender declares `contract_version`. If the receiver doesn't support that version, it returns a result packet with `error.kind: contract_version_rejected` including its supported versions. Dina's control plane then chooses to downgrade (if compatible) or fail the task.

**Forward compatibility.** Unknown optional fields in a packet must be ignored, not rejected. Unknown required fields (rare by design) must be rejected.

## Anticipated v2 Changes

Flagging for future planning; not in v1:

- Streaming result delivery (for long-running delegations with intermediate state)
- Multi-recipient delegations (one task, multiple external planes in parallel)
- Explicit trust negotiation (prove-who-you-are exchange before task)
- Richer capability scoping (time-of-day restrictions, per-URL whitelists)
- Cost cap enforcement in-contract (hard stop at USD limit)
- End-to-end encryption of payloads (for delegations crossing hostile networks)

---

## Summary Test Checklist

An implementer (either Dina or an external plane) should be able to verify compliance by:

- [ ] Reject outbound packet with wrong contract_version
- [ ] Reject outbound packet with invalid signature
- [ ] Reject outbound packet where signer_did ≠ from.user_did
- [ ] Accept valid outbound packet, produce valid signed result
- [ ] Refuse capability not in scope
- [ ] Refuse after capability.expiry_at_ms
- [ ] Deduplicate retry of same packet_id
- [ ] Honor cancellation request
- [ ] Produce accurate usage accounting
- [ ] Log required audit entries
- [ ] Handle partial completion with partial status
- [ ] Reject results with schema_violation
- [ ] Reject results from unexpected signer_did

---

**Document version:** 1.0 · **Last updated:** 2026-04-14 · **Scope:** wire protocol between Dina and external execution planes. Implementation semantics (who does what internally) are out of scope.
