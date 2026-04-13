# MsgBox Universal Transport — Task List

Generated from `docs/designs/MSGBOX_TRANSPORT.md` (reviewed 2026-04-11).
Sequenced by phase and dependency. Each task maps to a specific file and design doc section.

**Design doc:** `docs/designs/MSGBOX_TRANSPORT.md`
**Branch:** `feature/msgbox-transport`
**Test suite:** `TST-MBX-0001` through `TST-MBX-0085`

---

## Phase 1: MsgBox DID Verification

| # | Task | File(s) | Status | Tests | Depends On | Description |
|---|------|---------|--------|-------|------------|-------------|
| MBX-001 |  | done | TST-MBX-0001, 0002 | — | On WebSocket connect, MsgBox sends a 32-byte random challenge. Client signs with Ed25519 private key. For `did:key`, extract public key directly from the DID (self-certifying) and verify signature. Reject on failure, register in connection registry on success. |
| MBX-002 |  | done | TST-MBX-0003, 0004 | MBX-001 | For `did:plc` DIDs: fetch the PLC document from `plc.directory`, extract the `#dina_signing` verification method, verify Ed25519 signature against that public key. |
| MBX-003 | PLC document cache with TTL | `msgbox/internal/auth.go` | done | TST-MBX-0006, 0007 | MBX-002 | Cache PLC document lookups (TTL 1 hour). Second `did:plc` connect reuses cached doc. After key rotation, old key works until cache expires, then new doc is fetched. Injectable clock for testing. |
| MBX-004 |  | done | TST-MBX-0005 | MBX-001 | Second connection claiming same DID rejected unless re-authed. Replace existing unverified DID registration in `Hub.Register()`. |
| MBX-005 |  | done | TST-MBX-0001–0007 | MBX-001–004 | All 7 DID auth tests with TRACE metadata. Mock PLC directory for cache tests. |

## Phase 2: MsgBox RPC Protocol

### 2A — MsgBox: Message Routing

| # | Task | File(s) | Status | Tests | Depends On | Description |
|---|------|---------|--------|-------|------------|-------------|
| MBX-006 | Dispatch RPC binary-JSON in `handleWSBinaryForward` | `msgbox/internal/handler.go` | done | TST-MBX-0070, 0071 | MBX-001 | Binary frames starting with `{` → JSON parse → switch on `type`. `"rpc"` → `routeRPC()`. `"cancel"` → `routeCancel()`. Otherwise fall through to existing 2-byte-DID-length D2D forwarding. Malformed JSON logged and dropped without killing connection. |
| MBX-068 | MsgBox sender binding: `envelope.from_did == conn.DID` | `msgbox/internal/handler.go` | done | TST-MBX-0118–0121 | MBX-006 | **Security-critical.** Before routing any RPC or cancel envelope, verify `envelope.from_did == conn.DID`. Without this, an authenticated connection can forge envelopes claiming a different `from_did`, poisoning sender-scoped buffer keys, cancel ownership, and downstream idempotency. Reject mismatched envelopes with an error frame. D2D binary path already uses `conn.DID` directly (no envelope-level sender). |
| MBX-007 | `routeRPC` — composite key + delivery | `msgbox/internal/handler.go` | done | TST-MBX-0069, 0082 | MBX-068 | Parse full envelope `{type, id, from_did, to_did, direction, expires_at, ciphertext}`. Sender already verified by MBX-068. Construct `msgID = from_did + ":" + id` (sender-scoped). Call `Hub.Deliver(to_did, msgID, data)`. Pass `sender` and `expires_at` for buffer storage. |
| MBX-067 | `Buffer.DeleteIfExists` — returns whether message was found | `msgbox/internal/buffer.go` | done | — | — | Current `Delete(msgID)` (buffer.go:117) returns nothing — caller cannot distinguish "deleted" from "not found / already delivered". Add `DeleteIfExists(msgID string) bool` that returns true if a row was deleted, false otherwise. Uses `DELETE ... RETURNING id` or checks `RowsAffected()`. Required by `routeCancel` to decide whether to relay cancel to Core. |
| MBX-008 | `routeCancel` — ownership-verified cancel | `msgbox/internal/handler.go` | done | TST-MBX-0039, 0040 | MBX-068, MBX-067 | Parse cancel envelope `{type, cancel_of, from_did, to_did}`. Construct composite key `from_did + ":" + cancel_of`. Call `Buffer.DeleteIfExists(compositeKey)`. If true → canceled from buffer, done. If false → already delivered or never buffered → relay cancel to Core on recipient's WebSocket. |
| MBX-009 | Buffer schema: add `sender` + `expires_at` columns | `msgbox/internal/buffer.go` | done | — | — | `ALTER TABLE messages ADD COLUMN sender TEXT NOT NULL DEFAULT ''` and `ALTER TABLE messages ADD COLUMN expires_at INTEGER`. Existing D2D messages get empty sender and NULL expires_at (backward-compat). |
| MBX-064 | Extend `BufferedMsg` struct + `Drain()` to return new fields | `msgbox/internal/buffer.go` | done | — | MBX-009 | Current `BufferedMsg` has only `ID`, `Payload`, `StoredAt` (buffer.go:23). `Drain()` selects only `id, payload, stored_at` (buffer.go:89). Add `Sender string` and `ExpiresAt *int64` to `BufferedMsg`. Extend `Drain()` SELECT to include `sender, expires_at`. Hub needs `ExpiresAt` for drain-time expiry and `Sender` for drain-failure rebuffer. |
| MBX-066 | Fix drain semantics: delete-on-ack, not delete-before-send | `msgbox/internal/buffer.go`, `hub.go` | done | — | MBX-064 | **Reliability fix.** Current `Drain()` (buffer.go:110-112) deletes ALL messages for a recipient before returning them. Hub then writes them one by one (hub.go:57-68). On first write failure, Hub re-buffers only the current message and breaks — all remaining `msgs[i+1:]` are silently lost. Fix: change `Drain()` to SELECT without DELETE (rename to `Peek(did)` or equivalent). Hub deletes each message individually via `Buffer.Delete(msgID)` only after successful WebSocket write. On write failure, remaining messages stay in buffer untouched. This is delete-on-ack semantics — no messages are lost on partial drain failure. |
| MBX-065 |  | done | — | MBX-064, MBX-066 | Current `Hub.Deliver(recipientDID, msgID string, payload []byte)` (hub.go:83) and `bufferMsg(did, msgID, payload)` (hub.go:103) have no sender or expires_at parameters. Expand to `Deliver(recipientDID, msgID string, payload []byte, sender string, expiresAt *int64)` — passes metadata through to `Buffer.Add()`. With MBX-066's delete-on-ack, the drain-failure rebuffer path is eliminated — messages that fail to send simply stay in the buffer. D2D call sites in handler.go (handler.go:121 `/forward` HTTP path, handler.go:220 binary forward path) must be updated to pass empty sender and nil expires_at (backward-compat). `routeRPC` (MBX-007) passes `envelope.from_did` and `envelope.expires_at`. |
| MBX-010 | Buffer: `expires_at` enforcement on drain | `msgbox/internal/hub.go` | done | TST-MBX-0032, 0033 | MBX-065, MBX-066 | In `Hub.Register()` drain loop: for each peeked message, check `msg.ExpiresAt` (if non-nil) against current time. Expired → `Buffer.Delete(msg.ID)` (discard). Valid → write to WebSocket → `Buffer.Delete(msg.ID)` on success. On write failure → break (remaining messages stay in buffer via delete-on-ack). |
| MBX-011 | Buffer: store sender + expires_at on Add | `msgbox/internal/buffer.go` | done | TST-MBX-0041 | MBX-009 | Extend `Buffer.Add()` signature to accept sender and expires_at. Store in new columns. `Buffer.Add` dedup by `msgID` (now sender-scoped composite key). |
| MBX-012 |  | done | TST-MBX-0073–0081 | MBX-006 | Invalid JSON → drop, unknown type → drop, bad direction → drop, missing id → drop, missing cancel_of → drop. All without killing WebSocket connection. T7.9: bad→good→bad→good sequence. |
| MBX-013 |  | done | TST-MBX-0039–0041, 0069–0082 | MBX-006–012 | Handler dispatch, composite key construction, interleaving, frame parsing, hardening. All with TRACE metadata. |
| MBX-014 |  | done | TST-MBX-0030, 0032–0033, 0059 | MBX-010, MBX-011, MBX-066 | Drain expiry (depends on MBX-010 + MBX-066 delete-on-ack), buffer full, buffer TTL with injectable clock. |

### 2B — MsgBox: Rate Limiting

| # | Task | File(s) | Status | Tests | Depends On | Description |
|---|------|---------|--------|-------|------------|-------------|
| MBX-015 | Separate RPC vs D2D rate limits | `msgbox/internal/handler.go` | done | TST-MBX-0057, 0058 | MBX-006 | D2D: 60/min per DID. RPC: 300/min per DID. Separate rate limiter instances. |
| MBX-016a |  | done | — | MBX-006 | Add optional `"subtype": "pair"` to the outer envelope (outside ciphertext). MsgBox stays application-dumb — it cannot inspect ciphertext or inner paths. The subtype is a generic transport-level marker the CLI sets when sending pairing requests. MsgBox uses it only for rate-limit bucketing, not for routing or business logic. Update design doc envelope examples accordingly. |
| MBX-016b | Source-IP throttling for `subtype: "pair"` RPCs | `msgbox/internal/handler.go` | done | TST-MBX-0051 | MBX-016a | Max 10 RPC messages with `subtype: "pair"` per source IP per 5 minutes. Separate from per-DID RPC rate limit. No ciphertext inspection — only reads the outer `subtype` field. |

### 2C — Core: RPC Handler

| # | Task | File(s) | Status | Tests | Depends On | Description |
|---|------|---------|--------|-------|------------|-------------|
| MBX-017 | Message type dispatch in `readPump` callback | `core/internal/adapter/transport/msgbox_client.go` | done | — | MBX-006 | Extend `handleMessage` to parse envelope type. `"didcomm_envelope"` → existing D2D. `"rpc"` with direction "request" → dispatch to worker pool. `"cancel"` → `handleCancel()`. |
| MBX-018 | Bounded worker pool for RPC dispatch | `core/internal/adapter/transport/rpc_worker_pool.go` | done | TST-MBX-0067, 0068 | MBX-017 | `rpcPool` — bounded goroutine pool (default: 8 workers, 32 backlog). RPC requests dispatched off read loop. Backlog full → 503 response. D2D stays inline. |
| MBX-019 | `expires_at` check on receipt (before enqueue) | `core/internal/adapter/transport/rpc_worker_pool.go` | done | TST-MBX-0038 | MBX-017 | In `handleMessage`, before enqueue: if `envelope.expires_at` is set and in the past → drop silently, do not enqueue to worker pool. |
| MBX-020 | `expires_at` check on worker start | `core/internal/adapter/transport/rpc_worker_pool.go` | done | TST-MBX-0037 | MBX-018 | First line of `handleRPCRequest`: re-check `expires_at` → if expired, respond 408 (Request Timeout). |
| MBX-021 | Decrypt ciphertext (Ed25519→X25519) | `core/internal/adapter/transport/rpc_decrypt.go` | done | — | MBX-020 | Decrypt with Core's X25519 private key (derived from Ed25519 `#dina_signing` key via `Ed25519ToX25519Public` in `crypto/convert.go`). Parse inner JSON (method, path, headers, body). |
| MBX-022 |  | done | TST-MBX-0016, 0017 | MBX-021 | After decryption, before signature validation: verify `envelope.from_did == inner headers["X-DID"]`. Reject with 403 if they diverge. For pairing: `from_did == did:key:{body.public_key_multibase}`. |
| MBX-023 | Build internal `http.Request` and route through handler chain | `core/internal/adapter/transport/rpc_bridge.go` | done | TST-MBX-0008, 0009 | MBX-022 | Construct `http.Request` from inner method/path/headers/body. Call `handler.ServeHTTP()` with `httptest.ResponseRecorder`. Auth middleware, persona gating, rate limiting all run as normal. |
| MBX-024 |  | done | TST-MBX-0015 | MBX-023 | Capture response (status + headers + body). Encrypt with CLI device's X25519 public key (derived from `from_did`). Build response envelope `{type: "rpc", id, from_did: homenode, to_did: cli_did, direction: "response", expires_at: now+120}`. Send via WebSocket. |
| MBX-025 |  | done | TST-MBX-0012 | MBX-023 | Same device path restrictions as direct HTTP. CLI devices cannot access `/v1/vault/store` directly — must use `/api/v1/remember`. Reuse existing auth middleware allowlist. |
| MBX-026 |  | done | TST-MBX-0008–0017 | MBX-017–025 | Same signed request via direct HTTP and MsgBox relay → same status code, same response schema. Stubbed Brain/staging backends. All 10 equivalence + identity binding tests. |
| MBX-027 |  | done | TST-MBX-0067, 0068 | MBX-018 | Async dispatch off read loop. Pool full → 503. Slow handler doesn't block D2D. |
| MBX-028 |  | done | TST-MBX-0037, 0038 | MBX-019, MBX-020 | Receipt-time expiry, worker-start expiry. Injectable clock. |

### 2D — Core: Idempotency

| # | Task | File(s) | Status | Tests | Depends On | Description |
|---|------|---------|--------|-------|------------|-------------|
| MBX-029 |  | done | — | — | New table in identity.sqlite: `(from_did TEXT, request_id TEXT, response BLOB, created_at INTEGER, expires_at INTEGER, PRIMARY KEY (from_did, request_id))`. Add as next migration version. |
| MBX-030 | Idempotency check in `handleRPCRequest` | `core/internal/adapter/transport/rpc_idempotency.go` | done | TST-MBX-0019, 0021 | MBX-029 | After identity binding, before signature validation: check `rpc_idempotency` for `(from_did, id)`. If found and not expired → return cached response. Sender-scoped: two devices with same `request_id` get separate entries. |
| MBX-031 |  | done | TST-MBX-0024, 0042 | MBX-030 | After handler completes: store response in `rpc_idempotency` BEFORE sending over WebSocket. Critical for crash safety — retry hits cache, no re-execution. |
| MBX-032 |  | done | TST-MBX-0022, 0023 | MBX-029 | Periodic goroutine (every 60s): `DELETE FROM rpc_idempotency WHERE expires_at < now()`. |
| MBX-033 | Nonce cache replay rejection | `core/internal/adapter/transport/rpc_idempotency.go` | done | TST-MBX-0018 | MBX-022 | Same nonce + timestamp replay → rejected. Reuse existing nonce cache from auth middleware. |
| MBX-034 |  | done | TST-MBX-0018–0024 | MBX-029–033 | Replay, retry, sender-scoped collision, TTL, cleanup, crash window. All 7 tests. |

### 2E — Core: Cancel Handling

| # | Task | File(s) | Status | Tests | Depends On | Description |
|---|------|---------|--------|-------|------------|-------------|
| MBX-063 | In-flight request registry | `core/internal/adapter/transport/rpc_worker_pool.go` | done | — | MBX-018 | `sync.Map` of `(from_did, request_id) → { cancelFunc context.CancelFunc, state enum(queued/running/completed) }`. Populated on enqueue to worker pool (state=queued). Updated to state=running when worker starts. Removed or set to completed when handler finishes. Required by cancel semantics — the idempotency table only exists after handler completes, so in-progress and queued requests need a separate lookup structure. |
| MBX-035 | `handleCancel` — three-phase lookup | `core/internal/adapter/transport/rpc_worker_pool.go` | done | TST-MBX-0043, 0044 | MBX-029, MBX-063 | Cancel lookup order: (1) in-flight registry `(from_did, cancel_of)` — if state=running → call cancelFunc; if state=queued → mark canceled. (2) `rpc_idempotency` `(from_did, cancel_of)` — if found → already completed, ignore (idempotent). (3) Neither → invalid cancel or race, ignore. Non-matching `from_did` → reject at all layers. |
| MBX-036 |  | done | TST-MBX-0085 | MBX-063 | Request in worker pool backlog (in-flight registry state=queued), cancel arrives → mark canceled in registry. When worker picks it up, check canceled flag → skip execution, respond 499. |
| MBX-037 |  | done | TST-MBX-0084 | MBX-035 | Request completed + cached → cancel arrives → ignored. Idempotency row and cached response remain intact. Later retry returns cached response. |
| MBX-038 |  | done | TST-MBX-0042–0044, 0084, 0085 | MBX-035–037 | Store-before-send crash, in-progress cancel, non-matching sender, after-completion, queued-but-not-started. All 5 tests. |

### 2F — CLI: MsgBox Transport

| # | Task | File(s) | Status | Tests | Depends On | Description |
|---|------|---------|--------|-------|------------|-------------|
| MBX-039 |  | done | — | — | `Transport` protocol class with `request(method, path, body, headers) → TransportResponse`. `DirectTransport` wraps current HTTPS logic (existing behavior, no change). |
| MBX-040 |  | done | — | MBX-001 | WebSocket connect to MsgBox URL. `did:key` challenge-response authentication. |
| MBX-041 |  | done | TST-MBX-0028 | MBX-040 | `_drain_buffered()`: consume buffered envelopes (binary frames) on connect with 0.5s timeout. Match by `(from_did, request_id, direction="response")`. Cache in `_pending` dict. On retry, check cache before sending. |
| MBX-042 |  | done | — | MBX-041 | Build inner request JSON. Ed25519→X25519 conversion for Home Node public key. NaCl sealed-box encryption. Build outer envelope with `expires_at` (per operation type: 30s for reads, 5min for writes) and optional `subtype` (set to `"pair"` for pairing requests — consumed by MBX-016b rate limiter). Send as binary frame. |
| MBX-043 |  | done | — | MBX-042 | Wait for response with matching `id` (30s timeout). Decrypt with device's X25519 private key. Parse inner response (status, headers, body). Return `TransportResponse`. |
| MBX-044 |  | done | TST-MBX-0034 | MBX-042 | On Ctrl-C / timeout: send cancel envelope `{type: "cancel", cancel_of: request_id, from_did, to_did}`. Best-effort — don't block on send failure. |
| MBX-045 |  | done | TST-MBX-0061–0065 | MBX-039, MBX-040 | `DINA_TRANSPORT=direct` → DirectTransport. `=msgbox` → MsgBoxTransport (fail-closed if down). `=auto` → try direct first, fall back to msgbox. Default: `auto`. |
| MBX-046 |  | done | — | — | Add `msgbox_url`, `homenode_did`, `transport` fields to CLI config. Populated during pairing. |
| MBX-047 |  | done | TST-MBX-0028, 0034, 0061–0065 | MBX-039–046 | Drain-before-send, cancel from CLI, all 5 transport selection modes. Mock MsgBox WebSocket. |

### 2G — Integration Tests

| # | Task | File(s) | Status | Tests | Depends On | Description |
|---|------|---------|--------|-------|------------|-------------|
| MBX-048 |  | done | TST-MBX-0008–0009, 0012–0015, 0057–0058 | MBX-017–025, MBX-015 | Real Core + MsgBox with stubbed Brain. Same signed request via direct and relayed. Rate limit enforcement (depends on MBX-015 for RPC/D2D rate limit separation). |
| MBX-049 |  | done | TST-MBX-0025–0031, 0035, 0036, 0083 | MBX-010, MBX-024, MBX-035, MBX-042 | Real buffering with Docker services. Core offline → buffer → drain. Response-side expiry (depends on MBX-024 response envelope send). Cancel relayed to Core (depends on MBX-035 Core-side cancel handler). |
| MBX-050 |  | done | TST-MBX-0060, 0066, 0077–0078 | MBX-003, MBX-012 | Oversized ciphertext. PLC cache refresh (depends on MBX-003 PLC cache implementation). Ciphertext failures against real Core. |

## Phase 3: Telegram-Assisted Pairing

| # | Task | File(s) | Status | Tests | Depends On | Description |
|---|------|---------|--------|-------|------------|-------------|
| MBX-051 | Per-code attempt counter in pairing manager | `core/internal/adapter/pairing/pairing.go` | done | TST-MBX-0046, 0047 | — | Add `attempts int` field to pairing code struct. On wrong code: increment counter. At 3 → delete code (burned). Today only has `used` boolean + TTL. |
| MBX-052 |  | done | TST-MBX-0054, 0055 | MBX-022 | For `/v1/pair/complete` path: verify `envelope.from_did == did:key:{body.public_key_multibase}`. Reject 403 if divergent. Prevents registering different device key than authenticated transport identity. |
| MBX-053 |  | done | — | — | `/pair` Telegram command: calls `POST /v1/pair/initiate` on Core, returns pairing code + Home Node DID + MsgBox URL to user. Format: "Pairing code: XXXXXX / Expires in 5 minutes / DID: did:plc:abc123 / MsgBox: wss://mailbox.dinakernel.com". |
| MBX-054 |  | done | TST-MBX-0045 | MBX-040, MBX-046 | `dina configure --pair-code CODE --did DID --msgbox URL`. Generate Ed25519 device keypair. Send pairing request through MsgBox with outer `subtype: "pair"` (no Ed25519 sig — code is auth). Sets `expires_at` to 5min. Store resulting config. |
| MBX-055 |  | done | TST-MBX-0046–0050 | MBX-051 | Wrong code, 3 attempts burned, expired, reused, wrong DID. |
| MBX-056 |  | done | TST-MBX-0045, 0051–0055 | MBX-016b, MBX-051–054 | Full pairing through relay. IP throttle (depends on MBX-016b). Identity binding. No direct network access. |

## Phase 4: Remove External Port

| # | Task | File(s) | Status | Tests | Depends On | Description |
|---|------|---------|--------|-------|------------|-------------|
| MBX-057 | Remove external Core port mapping | `docker-compose.yml` | done | — | MBX-048, MBX-056 | Remove `ports: "443:443"` (or equivalent) from dina-core service. Port 8100 remains for internal Brain↔Core on Docker network. **Depends on pairing via MsgBox (MBX-056) — without it, new-device onboarding breaks when external port is removed.** |
| MBX-058 | install.sh: no external port allocation | `install.sh` | done | — | MBX-057 | Remove port allocation/configuration steps for Core's external port. Add MsgBox URL configuration. |
| MBX-059 | Keep `DINA_TRANSPORT=direct` for dev/LAN | `docker-compose.direct.yml` | done | — | MBX-057 | Development and LAN setups still work with direct transport. Document in docker-compose comments. |
| MBX-060 | Documentation: "zero inbound ports" | `ARCHITECTURE.md` | done | — | MBX-057 | Update architecture docs to reflect that Core needs zero public ports. MsgBox relay is the default. Direct transport for Docker/LAN dev. |

## Phase 5: E2E + Regression Tests

| # | Task | File(s) | Status | Tests | Depends On | Description |
|---|------|---------|--------|-------|------------|-------------|
| MBX-061 | E2E: multi-device concurrency | `tests/e2e/test_msgbox_e2e.py` | done | TST-MBX-0056 | MBX-048 | Two CLI devices send concurrent RPC requests across nodes. Both routed and responded independently. |
| MBX-062 | E2E: mixed D2D + RPC interleaving | `tests/e2e/test_msgbox_e2e.py` | done | TST-MBX-0069, 0072 | MBX-048 | D2D and RPC interleaved on same connection across nodes. No misparsing, no cross-contamination. Concurrent cross-sender to same Home Node. |

---

## Deferred (Not in Scope)

| # | Task | Status | Rationale |
|---|------|--------|-----------|
| MBX-D01 | Fix `/forward` DID-binding gap | deferred | Existing D2D `/forward` (handler.go:162-204) doesn't bind `X-Sender-DID` to `X-Sender-Pub`. End-to-end authenticity intact but MsgBox-side attribution spoofable. Orthogonal to RPC transport. |
| MBX-D02 | Mobile app MsgBox transport | deferred | Same `MsgBoxTransport` protocol, different client. No architecture change needed — just a new client implementation. |

---

## Summary

| Phase | Tasks | Tests |
|-------|-------|-------|
| Phase 1: DID Verification | MBX-001–005 | TST-MBX-0001–0007, 0110–0112, 0122 (11) |
| Phase 2: RPC Protocol | MBX-006–050, 016a, 016b, 063–068 | TST-MBX-0008–0044, 0057–0136 (113) |
| Phase 3: Pairing | MBX-051–056 | TST-MBX-0045–0055 (11) |
| Phase 4: Remove Port | MBX-057–060 | — |
| Phase 5: E2E | MBX-061–062 | TST-MBX-0056 (1) |
| **Total** | **70 tasks** | **136 tests** |

**Note:** MBX-016a/016b (pairing subtype + IP throttle) are defined in Phase 2B (MsgBox rate limiting) because they are MsgBox protocol-layer changes. Phase 3 pairing integration tests (MBX-056) depend on them. Sections 08–12 (TST-MBX-0086–0117) cover reliability, crash recovery, backward compatibility, migration, subtype isolation, rate-limit separation, PLC cache failures, and additional envelope hardening.
