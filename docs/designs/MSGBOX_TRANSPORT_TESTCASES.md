# MsgBox Universal Transport — Test Cases

Test plan for `docs/designs/MSGBOX_TRANSPORT.md`. 136 tests across 17 sections.

Tests use the `TST-MBX` suite prefix following the project's traceability convention (`TST-INT`, `INST`, `REL`). IDs are 4-digit zero-padded, grouped by section. Test code should include `# TRACE: {"suite": "MBX", "case": "XXXX", ...}` metadata.

Tests marked **(neg)** are negative-path / abuse tests.

---

## Section 01 — DID Authentication (`msgbox/internal/`)

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0001 | `did:key` connect with correct key → registered | happy | done |
| TST-MBX-0002 | `did:key` connect with wrong key → rejected **(neg)** | security | done |
| TST-MBX-0003 | `did:plc` connect with correct `#dina_signing` key → registered | happy | done |
| TST-MBX-0004 | `did:plc` connect with wrong key → rejected **(neg)** | security | done |
| TST-MBX-0005 | DID squatting: second connection claiming same DID → rejected unless re-authed **(neg)** | security | done |
| TST-MBX-0006 | PLC cache hit: second `did:plc` connect reuses cached document (no PLC fetch) | perf | done |
| TST-MBX-0007 | PLC cache stale after key rotation: old key may still work until cache TTL expires (up to 1 hour). After refresh, connect with old key fails; connect with new key succeeds. Test: rotate key → verify old key still works (stale cache) → advance clock past TTL → old key rejected, new key accepted | security | done |

## Section 02 — RPC Bridge Equivalence & Identity Binding (`core/internal/adapter/transport/`, `core/internal/middleware/`)

The bridge must produce identical auth and handler outcomes as direct HTTP. Equivalence tests run against **stubbed Brain/staging backends** (deterministic responses, no generated IDs or LLM output) to ensure stable assertions. The comparison is: same status code, same response structure, same auth outcome — not byte-for-byte body equality (handlers like `/api/v1/remember` generate staging IDs per-request, and `/api/v1/ask` depends on Brain output).

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0008 | Same signed `/api/v1/remember` request via direct HTTP and via MsgBox relay → same status code, same response schema, same auth path (stubbed staging backend, no generated-ID comparison) | equivalence | done |
| TST-MBX-0009 | Same signed `/api/v1/ask` request via both paths → same status code, same response schema (stubbed Brain backend returns deterministic response; `/v1/vault/query` is not device-accessible per auth.go allowlist) | equivalence | done |
| TST-MBX-0010 | Invalid Ed25519 signature → 401 via both paths **(neg)** | equivalence | done |
| TST-MBX-0011 | Expired timestamp → 401 via both paths **(neg)** | equivalence | done |
| TST-MBX-0012 | Device allowlist: CLI device requests restricted path (`/v1/vault/store`) → 403 via both paths **(neg)** | equivalence | done |
| TST-MBX-0013 | Request with query parameters → canonical signing payload identical via both paths | canonicalization | done |
| TST-MBX-0014 | Request with empty body → body hash uses `_EMPTY_BODY_HASH` via both paths | canonicalization | done |
| TST-MBX-0015 | Response headers (Content-Type, custom) preserved through MsgBox round-trip | equivalence | done |
| TST-MBX-0016 | `envelope.from_did` != inner `X-DID` → rejected with 403 **(neg)** | identity binding | done |
| TST-MBX-0017 | `envelope.from_did` == inner `X-DID` → accepted (normal flow) | identity binding | done |

## Section 03 — Replay Protection & Idempotency (`core/internal/adapter/sqlite/`, `core/internal/adapter/transport/`)

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0018 | Exact replay (same nonce + timestamp) → rejected by nonce cache **(neg)** | security | done |
| TST-MBX-0019 | Retry with same `request_id`, fresh nonce → returns cached response from `rpc_idempotency` (no re-processing) | idempotency | done |
| TST-MBX-0020 | Retry with different `request_id` → reprocesses as new request | idempotency | done |
| TST-MBX-0021 | Sender-scoped key: device A and device B both use `request_id="abc"` → two separate cache entries, no collision | idempotency | done |
| TST-MBX-0022 | Cached response expires after TTL (5 min) → next request with same `request_id` reprocesses | idempotency | done |
| TST-MBX-0023 | Background cleanup deletes expired entries from `rpc_idempotency` | maintenance | done |
| TST-MBX-0024 | **Store-before-send crash window**: handler commits side effects → cache stored → crash before send → retry with same `request_id` → returns cached response, no re-execution | idempotency + crash | done |

## Section 04 — Offline Behavior, Expiry & Cancel (`msgbox/internal/`, `cli/`)

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0025 | Core offline → request buffered in Dead Drop → CLI times out with "Home Node is offline" | offline | done |
| TST-MBX-0026 | Core reconnects → buffered request with valid `expires_at` drained → Core processes and sends response | offline | done |
| TST-MBX-0027 | CLI disconnects before response → response buffered for CLI's `did:key` | offline | done |
| TST-MBX-0028 | CLI reconnects → `_drain_buffered` consumes pending response → cache hit on retry (no re-send) | offline | done |
| TST-MBX-0029 | Drain order: multiple buffered responses delivered in FIFO order | offline | done |
| TST-MBX-0030 | Expired buffered response (Dead Drop TTL exceeded) → not delivered on reconnect. Test uses injectable clock or short TTL override (production TTL is 24h per buffer.go:15; test sets 1s via constructor param) | offline | done |
| TST-MBX-0031 | Duplicate retry: CLI sends same `request_id` after reconnect drain → idempotency cache returns cached response | offline + idempotency | done |
| TST-MBX-0032 | Buffered request with `expires_at` in the past → dropped by MsgBox on drain, not delivered to Core | expiry | done |
| TST-MBX-0033 | Buffered request with `expires_at` in the future → delivered normally on drain | expiry | done |
| TST-MBX-0034 | CLI sends `cancel` while request still buffered → MsgBox deletes from buffer | cancel | done |
| TST-MBX-0035 | CLI sends `cancel` after request already delivered to Core → cancel relayed to Core as best-effort | cancel | done |
| TST-MBX-0036 | Interactive read (`/api/v1/ask`) with 30s expiry + Core offline for 60s → request expired and dropped at MsgBox drain, never executed | expiry + stale | done |
| TST-MBX-0037 | Request delivered to Core before expiry, sits in worker pool backlog past expiry → Core re-checks on worker start, responds 408 (not executed) | expiry + backlog | done |
| TST-MBX-0038 | Request `expires_at` checked on receipt by Core (before enqueue) → already expired → dropped silently | expiry + receipt | done |
| TST-MBX-0039 | Cancel with matching `from_did` → buffered request deleted | cancel + ownership | done |
| TST-MBX-0040 | Cancel with non-matching `from_did` → rejected, buffered request preserved **(neg)** | cancel + ownership | done |
| TST-MBX-0041 | **Buffer dedup on sender-scoped composite key**: retry with same `id` from same sender → composite key `from_did:id` deduplicates in buffer (idempotent add). Second send produces no additional buffer entry. | invariant | done |
| TST-MBX-0042 | Store-before-send: simulated crash after handler completes but before WebSocket send → retry returns cached response (no re-execution) | idempotency + crash | done |
| TST-MBX-0043 | Core-side cancel with matching `from_did` on in-progress request → handler context cancelled | cancel + Core | done |
| TST-MBX-0044 | Core-side cancel with non-matching `from_did` → rejected, handler continues **(neg)** | cancel + Core | done |
| TST-MBX-0082 | **Buffer key isolation**: two senders with same `request_id="abc"` → both buffered independently via sender-scoped composite keys (`from_did:id`). Delete one, other survives. Buffer-layer only; Core idempotency isolation is TST-MBX-0021. | invariant | done |
| TST-MBX-0083 | **Response-side expiry**: Core sends response with `expires_at` (2min default), CLI offline for >2min → response expired in buffer, MsgBox drops on CLI reconnect drain, CLI retries with same `request_id` → Core returns cached response from idempotency | expiry + response | done |
| TST-MBX-0084 | **Cancel after completion**: request already completed and cached in `rpc_idempotency` → cancel arrives → ignored (idempotent), cached response and idempotency row intact → later retry with same `request_id` returns cached response | cancel + idempotency | done |
| TST-MBX-0085 | **Cancel while queued in worker backlog**: request delivered to Core, waiting in worker pool backlog (all workers busy), cancel arrives before handler starts → request removed from backlog or marked canceled, never executes | cancel + backlog | done |

## Section 05 — Pairing (`core/internal/adapter/pairing/`, `msgbox/internal/`, `cli/`)

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0045 | **Pairing transport contract**: `select_transport("msgbox")` returns `MsgBoxTransport` with correct interface. `request()` raises `NotImplementedError` (MBX-040 stub). Full end-to-end pairing is an integration test (tests/e2e/). | contract | done |
| TST-MBX-0046 | Wrong pairing code → rejected, attempt counter incremented **(neg)** | security | done |
| TST-MBX-0047 | 3 wrong attempts → code burned (deleted), correct code after that → rejected **(neg)** | security | done |
| TST-MBX-0048 | Expired code (>5 min TTL) → rejected **(neg)** | security | done |
| TST-MBX-0049 | Reused code (already consumed) → rejected **(neg)** | security | done |
| TST-MBX-0050 | Wrong Home Node DID → NaCl decryption fails on target (wrong key), pairing fails **(neg)** | security | done |
| TST-MBX-0051 | Source-IP throttling: 11th pairing RPC from same IP within 5 min �� throttled by MsgBox **(neg)** | abuse | done |
| TST-MBX-0052 | Pairing request arrives with no Ed25519 signature → accepted (code is the auth, `/v1/pair/complete` is in `optionalAuthPaths`) | happy | done |
| TST-MBX-0053 | Attacker mints fresh `did:key` per attempt → per-code counter still burns code after 3 wrong guesses **(neg)** | abuse | done |
| TST-MBX-0054 | Pairing identity binding: `envelope.from_did` != `did:key:{public_key_multibase}` → rejected with 403 **(neg)** | identity binding | done |
| TST-MBX-0055 | Pairing identity binding: `envelope.from_did` == `did:key:{public_key_multibase}` → accepted (normal flow) | identity binding | done |

## Section 06 — Operational & Load (`msgbox/internal/`, `core/`, `cli/`)

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0056 | Two CLI devices send concurrent RPC requests → both routed and responded independently | concurrency | done |
| TST-MBX-0057 | RPC rate limit: device exceeds 300/min → throttled **(neg)** | abuse | done |
| TST-MBX-0058 | D2D rate limit: external DID exceeds 60/min → throttled **(neg)** | abuse | done |
| TST-MBX-0059 | Buffer full: Dead Drop at capacity → new buffered message rejected with error **(neg)** | abuse | done |
| TST-MBX-0060 | Oversized ciphertext (>1 MiB) → rejected by RPC handler **(neg)** | abuse | done |
| TST-MBX-0061 | `transport=auto`: Core reachable directly → uses DirectTransport (no MsgBox contact) | transport selection | done |
| TST-MBX-0062 | `transport=auto`: Core unreachable directly, MsgBox up → falls back to MsgBoxTransport | transport selection | done |
| TST-MBX-0063 | `transport=auto`: both unreachable → clear error "Home Node unreachable" | transport selection | done |
| TST-MBX-0064 | `transport=msgbox` **type + no-fallback contract**: `select_transport` returns `MsgBoxTransport` (not `DirectTransport`). `request()` raises error (currently `NotImplementedError`). Proves transport selection is fail-closed. Does NOT yet prove runtime "MsgBox down → connection refused" behavior — that requires MBX-040 (WebSocket relay implementation). | transport selection | done |
| TST-MBX-0065 | `transport=direct`: never contacts MsgBox, even if configured | transport selection | done |
| TST-MBX-0066 | PLC cache refresh: DID key rotated, cache expires, next connect re-fetches and succeeds | operational | done |
| TST-MBX-0067 | Slow RPC handler does not block D2D delivery on same connection (async dispatch off read loop) | concurrency | done |
| TST-MBX-0068 | RPC worker pool full (all workers busy + backlog full) → new RPC gets 503 response | backpressure | done |
| TST-MBX-0069 | **Mixed D2D + RPC interleaving**: send D2D, RPC, D2D, RPC in sequence on same connection → all delivered correctly, no misparsing or cross-contamination | regression | done |
| TST-MBX-0070 | D2D binary frame (2-byte DID prefix) not misparsed as RPC (does not start with `{`) → handled by existing binary forward path | regression | done |
| TST-MBX-0071 | RPC binary-JSON frame not misparsed as D2D (starts with `{`, not 2-byte DID prefix) → handled by RPC path | regression | done |
| TST-MBX-0072 | Concurrent D2D and RPC from different senders to same Home Node → both delivered, RPC dispatched to worker pool, D2D handled inline | regression | done |

## Section 07 — Envelope Parsing & Hardening (`msgbox/internal/`, `core/internal/adapter/transport/`)

Malformed envelopes must be rejected without killing the WebSocket connection. Each test sends a bad frame and verifies the connection stays alive for subsequent valid frames.

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0073 | Invalid JSON binary frame (not valid JSON, starts with `{`) → logged and dropped, connection stays alive **(neg)** | hardening | done |
| TST-MBX-0074 | Valid JSON but unknown `type` field (e.g., `"type": "foo"`) → ignored, connection stays alive **(neg)** | hardening | done |
| TST-MBX-0075 | RPC envelope with `direction` neither "request" nor "response" → dropped **(neg)** | hardening | done |
| TST-MBX-0076 | RPC envelope with missing `id` field → rejected **(neg)** | hardening | done |
| TST-MBX-0077 | RPC envelope with invalid base64 in `ciphertext` → Core decryption fails, responds 400, connection stays alive **(neg)** | hardening | done |
| TST-MBX-0078 | RPC envelope with valid base64 but garbage ciphertext (NaCl open fails) → Core responds 400, connection stays alive **(neg)** | hardening | done |
| TST-MBX-0079 | Cancel envelope with missing `cancel_of` → ignored **(neg)** | hardening | done |
| TST-MBX-0080 | Cancel envelope with missing `from_did` → ignored **(neg)** | hardening | done |
| TST-MBX-0081 | Rapid sequence: bad frame → good RPC → bad frame → good D2D → all valid frames processed correctly | hardening + regression | done |

## Section 08 — Reliability & Crash Recovery (`msgbox/internal/`, `core/internal/adapter/transport/`, `cli/`)

These tests validate failure-mode correctness: partial failures, crash windows, races, and restart persistence.

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0086 | **Partial drain failure preserves tail**: 5 buffered messages, message 1 sends OK, message 2 write fails → messages 2–5 remain buffered (delete-on-ack). Reconnect drains 2–5 successfully. Validates MBX-066. | reliability | done |
| TST-MBX-0087 | **Crash after WS write, before buffer delete (RPC)**: message delivered to Core via WebSocket, buffer delete hasn't run yet (simulated crash) → message stays in buffer → on reconnect, message re-delivered → Core idempotency absorbs duplicate (same `(from_did, id)` → cached response) | crash + idempotency | done |
| TST-MBX-0088 | **Crash after WS write, before buffer delete (D2D)**: D2D message delivered to recipient, buffer delete not yet committed → re-delivered on reconnect → recipient-side D2D dedupe absorbs duplicate delivery | crash + D2D | done |
| TST-MBX-0089 | **Cancel race with worker start**: fill worker pool to capacity, submit request (goes to backlog), send cancel and simultaneously free a worker → assert exactly one outcome: either canceled before execution (499) or handler runs with cancel context (handler observes cancellation). Never double-handled. | race + cancel | done |
| TST-MBX-0090 | **Retry vs buffered response race**: CLI reconnects, drain delivers a buffered response for request_id X, CLI simultaneously prepares to re-send request X → drain populates `_pending` cache → `request()` finds cached response and skips re-send. Assert single logical completion. | race + offline | done |
| TST-MBX-0091 | **MsgBox restart persistence (request)**: buffer an RPC request (Core offline), restart MsgBox process → request survives in SQLite buffer → Core reconnects → request drained and delivered | persistence | done |
| TST-MBX-0092 | **MsgBox restart persistence (response)**: buffer an RPC response (CLI offline), restart MsgBox process → response survives in SQLite buffer → CLI reconnects → response drained and delivered | persistence | done |
| TST-MBX-0093 | **Core restart before idempotency write**: Core receives RPC, handler starts processing, Core crashes before `rpc_idempotency` INSERT → no cached response → CLI retries → request re-executes (expected: idempotency only protects after commit) | crash + Core | done |
| TST-MBX-0094 | **Core restart after idempotency write, before response send**: Core receives RPC, handler completes, `rpc_idempotency` INSERT committed, Core crashes before WebSocket send → CLI retries → Core returns cached response from idempotency table (no re-execution). Validates store-before-send across restarts. | crash + Core | done |
| TST-MBX-0095 | **Connection replacement during drain**: DID connects, drain starts delivering messages 1–5, second connection for same DID arrives mid-drain (hub.go replaces connection) → first connection closed, remaining messages stay buffered → second connection drains them. No message loss, no double delivery. | reliability | done |
| TST-MBX-0096 | **Large queue FIFO across partial failures**: 20 messages buffered, drain delivers 1–8, fails on 9 → 9–20 stay buffered. Reconnect delivers 9–15, fails on 16 → 16–20 stay. Reconnect delivers 16–20. Assert strict FIFO ordering across all three drain attempts. | reliability + ordering | done |

## Section 09 — Backward Compatibility & Migration (`msgbox/internal/`)

Buffer schema migration and legacy D2D behavior after Hub.Deliver signature expansion.

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0097 | **Legacy D2D offline delivery path**: after Hub.Deliver expansion (sender="", expires_at=nil), D2D message to an unconnected recipient buffers correctly → same behavior as before, no regression. Note: online WebSocket delivery requires integration tests; this unit test validates the Hub→Buffer contract. | backward-compat | done |
| TST-MBX-0098 | **Legacy D2D offline buffering**: D2D message buffered with sender="" and expires_at=nil → stored correctly, no schema errors | backward-compat | done |
| TST-MBX-0099 | **Legacy D2D drain**: buffered D2D message with sender="" and expires_at=NULL → drained normally, no expiry check (NULL = no expiry) | backward-compat | done |
| TST-MBX-0100 | **Buffer migration: existing rows with no sender column**: simulate pre-migration buffer rows (no sender, no expires_at columns) → migration adds columns with defaults → old rows have sender="" and expires_at=NULL → drain works correctly | migration | done |
| TST-MBX-0101 | **DeleteIfExists: found → true**: insert message, `DeleteIfExists(id)` → returns true | unit | done |
| TST-MBX-0102 | **DeleteIfExists: not found → false**: `DeleteIfExists("nonexistent")` → returns false | unit | done |
| TST-MBX-0103 | **DeleteIfExists: repeated delete → false**: insert, delete (true), delete again → returns false | unit | done |

## Section 10 — Pairing Subtype & Rate Isolation (`msgbox/internal/`)

Validates the outer `subtype` field and rate-limit bucket separation.

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0104 | **Pairing RPC emits subtype "pair"**: CLI pairing request has `subtype: "pair"` in outer envelope | contract | done |
| TST-MBX-0105 | **Normal RPC has no subtype**: regular `/api/v1/remember` RPC envelope omits `subtype` field (`omitempty` in Go marshaling). Stored payload verified to not contain a `subtype` key. | contract | done |
| TST-MBX-0106 | **Pairing IP throttle counts only subtype "pair"**: send 10 pairing RPCs from IP → throttled. Send normal RPC from same IP → not throttled (separate bucket) | rate isolation | done |
| TST-MBX-0107 | **Normal RPC not counted against pairing throttle**: send 300 normal RPCs → D2D and pairing budgets unaffected | rate isolation | done |
| TST-MBX-0108 | **D2D does not consume RPC quota**: send 60 D2D messages (hit D2D limit) → RPC still works | rate isolation | done |
| TST-MBX-0109 | **RPC does not consume D2D quota**: send 300 RPC messages (hit RPC limit) → D2D still works | rate isolation | done |

## Section 11 — PLC Cache Failure Modes (`msgbox/internal/`)

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0110 | **PLC fetch timeout**: plc.directory unreachable → `did:plc` connection rejected with clear error, `did:key` connections unaffected | resilience | done |
| TST-MBX-0111 | **Malformed PLC document**: plc.directory returns invalid JSON → connection rejected | resilience | done |
| TST-MBX-0112 | **Missing #dina_signing in PLC doc**: valid PLC doc but no `#dina_signing` verification method → connection rejected with specific error | resilience | done |

## Section 12 — MsgBox Sender Binding (`msgbox/internal/`)

**Architectural note:** MsgBox verifies DID ownership on WebSocket connect (challenge-response), but `routeRPC` and `routeCancel` read `from_did` from the envelope body — which is attacker-controlled. Without a `conn.DID == envelope.from_did` check, an authenticated connection can forge envelopes with a different `from_did`, poisoning sender-scoped buffer keys, cancel ownership, and idempotency attribution. This is the MsgBox-side analog of Core's identity binding rule.

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0118 | **Sender binding: `envelope.from_did` matches `conn.DID`** → accepted, routed normally | happy | done |
| TST-MBX-0119 | **Sender binding: `envelope.from_did` != `conn.DID`** → rejected by MsgBox, not routed **(neg)** | security | done |
| TST-MBX-0120 | **Cancel sender binding: `cancel.from_did` != `conn.DID`** → rejected by MsgBox **(neg)** | security | done |
| TST-MBX-0121 | **D2D binary forward already uses `conn.DID` for rate limiting** (handler.go:115) — verify no envelope-level DID spoofing possible on binary path | security | done |

## Section 13 — WebSocket Lifecycle & Connection Edge Cases (`msgbox/internal/`)

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0122 | **Challenge-response timeout**: client connects, MsgBox sends challenge, client never responds → connection closed after timeout (e.g., 10s) | lifecycle | done |
| TST-MBX-0123 | **Clean reconnection after client disconnect**: Client-side WebSocket closed. Hub.Deliver to stale connection produces either "delivered" (TCP kernel buffered) or "buffered" (broken pipe detected) — both OS-dependent and valid. The deterministic assertion: after fresh reconnection, buffer is empty and new connection is functional. Does NOT lock the write-failure → buffer path (OS-dependent). | lifecycle | done |
| TST-MBX-0124 | **Rapid reconnect storm**: Core disconnects and reconnects 10 times in 5 seconds → each reconnect replaces previous connection cleanly, buffer drains on final stable connection, no duplicate delivery | lifecycle | done |
| TST-MBX-0125 | **Client disconnect mid-send**: CLI sends first half of a binary frame then disconnects → MsgBox handles partial read gracefully, no panic, no corrupted state | lifecycle | done |

## Section 14 — Concurrent & Multi-Device Edge Cases (`core/`, `cli/`)

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0126 | **Two concurrent requests from same device**: same device sends `/remember` and `/ask` simultaneously with different request_ids → both processed independently, both responses returned correctly matched by id | concurrency | done |
| TST-MBX-0127 | **Same request_id sent twice concurrently from same device**: race between two identical requests → exactly one executes, other hits idempotency cache. No double side-effect. | concurrency + race | done |
| TST-MBX-0128 | **Device revoked during in-flight RPC**: device paired, sends RPC, admin unpairs device while handler is processing → handler completes (no mid-flight revocation), but next request from that device is rejected by device auth | lifecycle | done |
| TST-MBX-0129 | **Response out-of-order**: CLI sends request A then B, Core responds B then A → CLI matches each response by `id`, both returned to correct callers | ordering | done |

## Section 15 — Crypto & Encoding Edge Cases (`core/internal/adapter/transport/`, `cli/`)

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0130 | **Composite msgID with DID containing colons**: `from_did = "did:key:z6MkABC"`, `id = "req-123"` → composite key `"did:key:z6MkABC:req-123"` works as opaque key (never decomposed, only constructed) | encoding | done |
| TST-MBX-0131 | **Core key rotation while CLI has cached X25519 key**: Core rotates Ed25519 `#dina_signing` key → CLI's sealed-box encrypted with old X25519 fails to decrypt on Core → CLI gets error, re-fetches PLC doc, retries with new key | crypto + lifecycle | done |
| TST-MBX-0132 | **Empty ciphertext field**: valid envelope structure but `ciphertext: ""` → Core rejects with 400 **(neg)** | hardening | done |
| TST-MBX-0133 | **Binary frame with 0 bytes**: empty binary WebSocket frame → ignored, connection stays alive | hardening | done |

## Section 16 — Clock & Timing Edge Cases

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0134 | **Clock skew: CLI ahead by 30s**: CLI sets `expires_at = now + 30s` but MsgBox clock is 30s behind → message not prematurely expired at MsgBox drain | timing | done |
| TST-MBX-0135 | **Clock skew: MsgBox ahead by 30s**: MsgBox clock is 30s ahead → message with tight 30s expiry dropped even though CLI thinks it's still valid. Test documents this as known behavior — tight expiry + clock skew = potential drops. | timing | done |
| TST-MBX-0136 | **expires_at already past on online delivery**: message sent to an online recipient but `expires_at` is already in the past → MsgBox delivers anyway (expiry only checked at buffer drain, not online delivery). Core catches it at receipt-time check. | timing + contract | done |

## Section 17 — Additional Envelope Hardening (`msgbox/internal/`)

| ID | Test | Type | Status |
|----|------|------|--------|
| TST-MBX-0113 | **Unknown subtype**: envelope with `subtype: "foo"` → treated as normal RPC (no special handling), connection stays alive | hardening | done |
| TST-MBX-0114 | **Invalid expires_at type**: `expires_at: "not-a-number"` → envelope dropped, connection stays alive **(neg)** | hardening | done |
| TST-MBX-0115 | **Missing to_did on RPC**: envelope with no `to_did` → dropped **(neg)** | hardening | done |
| TST-MBX-0116 | **Missing from_did on RPC**: envelope with no `from_did` → dropped **(neg)** | hardening | done |
| TST-MBX-0117 | **Extremely long IDs**: `id` and `from_did` at 10KB each → rejected by sender binding (`from_did` != `conn.DID`), connection stays alive. No explicit length validation needed — sender binding is the natural firewall. **(neg)** | hardening | done |

---

## Test Infrastructure

Actual file locations (verified against source). Updated 2026-04-12.

| Tier | Location | Tests |
|------|----------|-------|
| Unit | `msgbox/internal/auth_test.go` | 0001–0007, 0066, 0110–0112 |
| Unit | `msgbox/internal/handler_test.go` | 0034–0035, 0039–0041, 0051, 0056–0058, 0060, 0069–0071, 0073–0076, 0079–0082, 0104–0109, 0113–0125, 0133 |
| Unit | `msgbox/internal/hub_test.go` | 0025–0027, 0029–0030, 0032–0033, 0036, 0042, 0083, 0086–0088, 0091–0092, 0095–0096, 0134–0136 |
| Unit | `msgbox/internal/buffer_test.go` | 0059, 0097–0103, 0130 |
| Unit | `core/internal/adapter/transport/rpc_bridge_test.go` | 0008–0017, 0050, 0054–0055, 0072, 0077–0078, 0090, 0126–0129, 0131–0132 |
| Unit | `core/internal/adapter/transport/rpc_idempotency_test.go` | 0018–0024, 0028, 0031, 0084, 0093–0094 |
| Unit | `core/internal/adapter/transport/rpc_worker_pool_test.go` | 0037–0038, 0043–0044, 0067–0068, 0085, 0089 |
| Unit | `core/internal/adapter/pairing/pairing_msgbox_test.go` | 0046–0049, 0052–0053 |
| Unit | `cli/tests/test_transport.py` | 0045, 0061–0065 |

---

## Summary

| Section | Tests | Pending | Passed |
|---------|-------|---------|--------|
| 01 DID Auth | 7 | 0 | 7 |
| 02 Bridge Equivalence | 10 | 0 | 10 |
| 03 Idempotency | 7 | 0 | 7 |
| 04 Offline/Expiry/Cancel | 25 | 0 | 25 |
| 05 Pairing | 11 | 0 | 11 |
| 06 Operational | 17 | 0 | 17 |
| 07 Envelope Hardening | 9 | 0 | 9 |
| 08 Reliability/Crash | 11 | 0 | 11 |
| 09 Backward Compat | 7 | 0 | 7 |
| 10 Subtype/Rate Isolation | 6 | 0 | 6 |
| 11 PLC Cache Failures | 3 | 0 | 3 |
| 12 Sender Binding | 4 | 0 | 4 |
| 13 WS Lifecycle | 4 | 0 | 4 |
| 14 Concurrent/Multi-Device | 4 | 0 | 4 |
| 15 Crypto/Encoding | 4 | 0 | 4 |
| 16 Clock/Timing | 3 | 0 | 3 |
| 17 Extra Hardening | 5 | 0 | 5 |
| **Total** | **136** | **0** | **136** |
