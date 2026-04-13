# MsgBox Universal Transport — CLI over MsgBox

## Problem

Today, dina CLI connects directly to Core via HTTPS:

```
dina remember "buy milk"
  → HTTPS POST https://my-homenode.com:443/v1/staging/ingest
  → Ed25519 signed request
  → Core processes, responds
```

This requires:
- Core has a public IP or domain
- Port 443 is open and forwarded
- A reverse proxy or tunnel (Caddy, ngrok, Tailscale)
- TLS certificate provisioned

For a "sovereign personal AI that runs on a Raspberry Pi behind your router," this is a significant barrier. Most users can't set up port forwarding, DNS, and TLS.

## Solution

Route CLI requests through MsgBox — the same WebSocket relay already used for D2D messaging. Core already maintains a persistent WebSocket connection to MsgBox. CLI sends its request to MsgBox addressed to the user's DID, MsgBox relays it to Core's WebSocket, Core processes it and sends the response back through MsgBox.

**Core needs zero public ports.** Only outbound WebSocket to MsgBox.

## What Changes

| Component | Before | After |
|-----------|--------|-------|
| dina CLI | Direct HTTPS to Core | Request via MsgBox relay |
| Core | Listens on :8100 (public) | Only outbound WebSocket to MsgBox; :8100 internal only |
| MsgBox | D2D messages only | D2D + CLI request/response relay |
| Brain | Direct HTTP to Core | No change (same Docker network) |
| dina-admin | Admin socket / docker exec | No change (local) |
| D2D | Already via MsgBox | No change |
| Trust Network | All outbound | No change |
| Telegram | Brain polls outbound | No change |

## What Does NOT Change

- **Brain ↔ Core**: direct HTTP on Docker network. Co-located.
- **dina-admin ↔ Core**: admin socket via docker exec. Local only.
- **D2D messaging**: already uses MsgBox. No protocol change to D2D message flow. **Note:** the existing `/forward` HTTP endpoint (handler.go:162-204) verifies that the Ed25519 signature matches the provided `X-Sender-Pub` key, but does not verify that `X-Sender-DID` is bound to that key. This means MsgBox-side rate limiting and abuse logs use a self-asserted DID. End-to-end D2D authenticity is still intact (recipient verifies sender's DID against PLC doc in transport.go), so this is not a plaintext/authenticity break — but MsgBox-level attribution is spoofable. Fixing `/forward` DID-binding is orthogonal to this design and deferred to a separate change.
- **Trust Network**: all outbound (publish to PDS, query AppView). PDS never calls back.
- **Telegram**: Brain polls Telegram API. No inbound.
- **Port 8100**: still exists for internal Brain ↔ Core. Just not exposed externally.

## Protocol Design

### Opaque Envelope

The envelope is fully opaque to MsgBox. Method, path, headers, and body are ALL inside the encrypted ciphertext. MsgBox sees only routing metadata.

```json
{
  "type": "rpc",
  "id": "req-uuid-1234",
  "from_did": "did:key:z6Mkn...",
  "to_did": "did:plc:homenode...",
  "direction": "request",
  "expires_at": 1744378972,
  "ciphertext": "<NaCl crypto_box_seal encrypted blob>"
}
```

Inside the ciphertext (after decryption by Core):

```json
{
  "method": "POST",
  "path": "/api/v1/remember",
  "headers": {
    "Content-Type": "application/json",
    "X-DID": "did:key:z6Mkn...",
    "X-Timestamp": "2026-04-11T14:21:52Z",
    "X-Nonce": "a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8",
    "X-Signature": "9f86d081884c7d659a2feaa0c55ad015...hex-ed25519-sig"
  },
  "body": "{\"text\":\"buy milk\",\"session\":\"ses_abc\"}"
}
```

Response (Core → CLI, same opaque envelope):

```json
{
  "type": "rpc",
  "id": "req-uuid-1234",
  "from_did": "did:plc:homenode...",
  "to_did": "did:key:z6Mkn...",
  "direction": "response",
  "expires_at": 1744378972,
  "ciphertext": "<NaCl encrypted blob>"
}
```

Inside the response ciphertext:

```json
{
  "status": 200,
  "headers": {"Content-Type": "application/json"},
  "body": "{\"status\":\"stored\",\"persona\":\"general\"}"
}
```

**MsgBox cannot see:** method, path, headers, body, status code, session IDs, vault contents, query text — nothing. It sees only `{type, id, from_did, to_did, direction, expires_at, ciphertext}`. This is metadata-private: MsgBox knows that a CLI device talked to a Home Node, but not what it said.

### Transport Control Primitives

MsgBox is application-dumb — it never inspects ciphertext, never understands API paths, never branches on business logic. But it understands generic transport semantics via two outer-envelope primitives:

**`expires_at`** (unix timestamp, optional) — Hard expiry enforced at three points: (1) MsgBox drops expired buffered messages at drain time, (2) Core drops expired requests on receipt before enqueueing to worker pool, (3) Core re-checks expiry when a worker starts the request. This prevents stale late execution at every stage: a `/ask` request buffered while Core was offline for an hour is dropped, and even a request delivered just before expiry but queued behind slow handlers is caught. CLI sets `expires_at` based on the operation type (see defaults below). If omitted, MsgBox uses the Dead Drop's default TTL (24h); Core treats omitted `expires_at` as no expiry (backward compat with D2D).

**`cancel`** (message type) — Best-effort cancellation. CLI sends a cancel envelope when the user gives up before timeout:

```json
{
  "type": "cancel",
  "cancel_of": "req-uuid-1234",
  "from_did": "did:key:z6Mkn...",
  "to_did": "did:plc:homenode..."
}
```

MsgBox behavior on cancel:
1. If the target request is still buffered (not yet delivered) → delete it from buffer
2. If already delivered to Core → relay the cancel to Core as a best-effort signal
3. Core treats cancel as advisory: stop if the handler hasn't started or is cancellable; ignore if already completed

**Cancel is an optimization, not the primary safety control.** `expires_at` is the hard stop — it works even if the CLI crashes, loses network, or can't send a cancel.

**Default `expires_at` by operation type** (set by CLI, not MsgBox):

| Pattern | Default expiry | Rationale |
|---------|---------------|-----------|
| Interactive reads (`/api/v1/ask`, `/api/v1/status`) | 30s | Stale answers are useless |
| Writes (`/api/v1/remember`, `/api/v1/task`) | 5min | User may retry; idempotency handles dedup |
| Pairing (`/v1/pair/complete`) | 5min | Matches pairing code TTL |
| Responses (Core ��� CLI) | 2min | If CLI is gone for >2min, it will retry with same request_id |

### MsgBox DID Authentication

**Current gap:** MsgBox accepts any claimed DID without verifying ownership. A client can register under an arbitrary DID and intercept traffic.

**Fix:** MsgBox must verify DID ownership on WebSocket connection:

1. Client connects to MsgBox WebSocket, claims a DID
2. MsgBox sends a random challenge (32 bytes)
3. Client signs the challenge with its private key
4. MsgBox verifies:
   - For `did:plc:` DIDs: fetch the PLC document from `plc.directory`, extract the `#dina_signing` verification method, verify the signature against that public key
   - For `did:key:` DIDs: extract the public key directly from the DID (it's self-certifying), verify the signature
5. If verification fails → reject connection
6. If verified → register the DID in the connection registry

This prevents DID squatting. A client can only register as a DID it actually holds the private key for.

**Caching:** MsgBox caches PLC document lookups (TTL 1 hour) to avoid hitting plc.directory on every connection.

**Key rotation:** If a DID's signing key rotates, the cached PLC document becomes stale. The 1-hour TTL handles this — worst case, the old key works for up to 1 hour after rotation. For immediate invalidation, MsgBox can expose a cache-bust endpoint.

### DID Types in the System

| DID type | Who uses it | How MsgBox verifies |
|----------|-------------|-------------------|
| `did:plc:` | Home Node (Core) | Fetch PLC document → `#dina_signing` key |
| `did:key:` | CLI devices, paired devices | Self-certifying — public key is the DID |

CLI devices use `did:key:` (Ed25519 public key encoded as a DID). This is set during pairing and stored in the CLI config. The `did:key` format is self-verifying — no PLC lookup needed, the public key IS the DID.

### Response Protocol: Temporary WebSocket

CLI opens a short-lived WebSocket to MsgBox for each command:

```
1. CLI → MsgBox: WebSocket connect + DID auth (did:key challenge-response)
2. CLI → MsgBox: send rpc envelope {type: "rpc", direction: "request", to_did: homenode, ...}
3. MsgBox → Core: relay envelope on Core's existing WebSocket
4. Core decrypts → validates Ed25519 signature → routes to HTTP handler → captures response
5. Core → MsgBox: send rpc envelope {type: "rpc", direction: "response", to_did: cli-device, ...}
6. MsgBox → CLI: relay response on CLI's WebSocket
7. CLI: decrypt response, display result, close WebSocket
```

**Timeout:** CLI waits up to 30 seconds (configurable) for the response. If no response → "Home Node did not respond. It may be offline."

**No polling.** No long-poll. Single WebSocket, request and response on the same connection.

### Offline Behavior

If Core is offline (no active WebSocket to MsgBox):

1. CLI sends the request with `expires_at` → MsgBox has no WebSocket for `to_did`
2. MsgBox stores the request in the Dead Drop buffer (existing infrastructure)
3. CLI waits up to 30s, times out: "Home Node is offline"
4. CLI may send `cancel` if user hits Ctrl-C (best-effort: deletes from buffer if still there)
5. When Core reconnects, MsgBox drains the buffer — but **checks `expires_at` first**:
   - Expired → dropped silently (not delivered). Interactive reads (`/ask`) with 30s expiry are gone.
   - Still valid → delivered to Core. Writes (`/remember`) with 5min expiry survive short outages.
6. Core processes any surviving requests, sends responses with their own `expires_at`
7. If CLI is no longer connected, responses go to Dead Drop for the CLI's `did:key`
8. Next time CLI connects, it drains pending responses before sending new requests (see drain-before-send contract)

**Key invariant:** A request is never *executed* after its `expires_at`. Enforcement is layered: MsgBox drops expired messages at drain time, and Core re-checks expiry on receipt and again when a worker picks up the request (see Core Changes → Expiry enforcement). The CLI doesn't need to know *why* Core was offline or predict when it will return — it just sets an appropriate expiry per operation type.

### Idempotency

**Problem:** If the CLI times out and retries, Core may process the same request twice. The nonce prevents replay of the exact same signed request, but a retry has a fresh nonce/timestamp.

**Solution:** Explicit request-level idempotency in Core:

```go
// New table in identity.sqlite
CREATE TABLE rpc_idempotency (
    from_did    TEXT NOT NULL,
    request_id  TEXT NOT NULL,
    response    BLOB,       -- cached response (encrypted)
    created_at  INTEGER,    -- unix timestamp
    expires_at  INTEGER,    -- TTL: created_at + 300 (5 minutes)
    PRIMARY KEY (from_did, request_id)
);
```

The primary key is `(from_did, request_id)` — namespaced by sender DID. Request IDs are client-generated UUIDs, so two paired devices could accidentally collide. Sender-namespacing prevents cross-device conflicts.

Flow:
1. CLI sends request with `id: "req-uuid-1234"`
2. Core checks `rpc_idempotency` for `(from_did, id)`
3. If found and not expired → return cached response (no re-processing)
4. If not found → process, **store response in cache, then send response** (store-before-send — see Core Changes)
5. Background cleanup: delete expired entries

The `id` is generated by the CLI (UUID). Retries use the same `id`. Core deduplicates per sender.

## Core Changes

### RPC Handler on WebSocket

Core's MsgBox WebSocket client gets a new message handler. **Critical: RPC handling must be dispatched off the read loop.** The current `readPump` (msgbox_client.go:153) invokes one callback inline per binary frame. If `handleRPCRequest` runs synchronously, a slow handler stalls all D2D and RPC traffic for the Home Node. RPC requests are dispatched to a bounded worker pool.

```go
func (c *MsgBoxClient) handleMessage(msg []byte) {
    envelope := parseEnvelope(msg)
    switch envelope.Type {
    case "didcomm_envelope":
        c.handleD2D(envelope)      // existing D2D (fast: just decrypt + store)
    case "rpc":
        if envelope.Direction == "request" {
            // Dispatch off the read loop — do not block D2D or other RPC traffic.
            c.rpcPool.Submit(func() { c.handleRPCRequest(envelope) })
        }
    case "cancel":
        c.handleCancel(envelope)   // best-effort: ownership-verified cancel (see below)
    }
}
```

**Worker pool:** `rpcPool` is a bounded goroutine pool (default: 8 workers). If all workers are busy, new RPC requests queue up to a bounded backlog (default: 32). If the backlog is full, the request is rejected with a 503 response (Core overloaded). This prevents a flood of RPC requests from starving the read loop or exhausting memory.

**Expiry enforcement at Core (two checkpoints):** MsgBox enforces `expires_at` at drain time, but a request can be delivered to Core before expiry and then sit in the worker pool backlog past expiry. Core therefore checks `expires_at` at two points:

1. **On receipt** (in `handleMessage`, before enqueue): if `envelope.expires_at` is set and in the past → drop silently, do not enqueue.
2. **On worker start** (first line of `handleRPCRequest`): re-check `expires_at` → if expired, respond with 408 (Request Timeout) so the CLI knows the request was not processed.

This closes the gap between MsgBox delivery and Core execution. The invariant is: **a request is never executed after its `expires_at`**, regardless of where the delay occurred (MsgBox buffer, Core backlog, or network latency).

`handleRPCRequest`:
1. **Expiry check**: if `envelope.ExpiresAt` is set and `time.Now().Unix() > envelope.ExpiresAt` → respond 408, return
2. Decrypt ciphertext with Core's X25519 private key (derived from Ed25519 `#dina_signing` key)
3. Parse the inner JSON (method, path, headers, body)
4. **Identity binding**: verify `envelope.from_did == inner X-DID` (see Identity Binding Rules below). Reject with 403 if they diverge.
5. Check `rpc_idempotency` cache by `(from_did, id)` — if hit, return cached response
6. Validate the Ed25519 signature from the inner headers (same validation as HTTP middleware)
7. Check device allowlist — CLI devices have restricted paths (same as current device auth)
8. Build an internal `http.Request` and route through the handler chain
9. Capture the `http.Response`
10. Encrypt the response (status + headers + body) with the CLI device's public key
11. **Store in `rpc_idempotency` cache** (before send — see store-before-send below)
12. Send `rpc` response envelope back through WebSocket

**Store-before-send invariant:** The idempotency cache entry must be written *before* the response is sent over WebSocket. If the order were reversed (send then store), a crash or send failure after handler side effects commit but before the cache write would leave no idempotency record — and a retry would re-execute the mutation. With store-before-send, the worst case on crash is: side effects committed + cache written + response not sent → retry hits the cache and returns the cached response without re-executing. The cost is that a successful store followed by a send failure means the response is cached but the CLI didn't receive it — the CLI retries with the same `request_id` and gets the cached response. This is the correct behavior.

**Core-side cancel ownership:** When Core receives a relayed cancel (after the request has left MsgBox's buffer), it must verify that the canceller is the original sender. The `rpc_idempotency` table already stores `from_did` as part of the primary key. Core's `handleCancel`:

1. Look up `(cancel.from_did, cancel.cancel_of)` in `rpc_idempotency`
2. If found → the cancel is from the original sender. If the handler is still running (tracked via a `context.CancelFunc` in the worker pool), cancel its context. If already completed, ignore (idempotent).
3. If not found → either the request hasn't been processed yet (check worker pool pending queue by `request_id`, verify `from_did` matches the envelope's `from_did`) or the cancel is invalid. Reject if `from_did` doesn't match.

This extends the cancel ownership guarantee from MsgBox buffer layer through to Core execution. The invariant: **a cancel is only honored if `cancel.from_did` matches the original request's `from_did`**, at every layer.

**Device path restrictions apply.** Current device auth restricts CLI devices to specific paths. The same restrictions apply here — a CLI device cannot access `/v1/vault/store` directly; it must use `/api/v1/remember` (which goes through Brain's staging pipeline). The RPC handler enforces the same allowlist.

### Identity Binding Rules

The RPC bridge carries identity at two layers: the outer envelope (`from_did`) and the inner signed request (`X-DID`). These must be bound to prevent routing/idempotency being keyed to one identity while authorization is evaluated for another.

**Rule 1 — Normal RPC: `envelope.from_did` must equal inner `X-DID`.**

The bridge checks this *after* decryption but *before* signature validation or handler dispatch. If they diverge → reject with 403. This ensures idempotency (keyed by `from_did`) and authorization (keyed by `X-DID`) always refer to the same device.

**Rule 2 — Pairing RPC: `envelope.from_did` must equal `did:key:{public_key_multibase}` from inner body.**

Pairing requests have no `X-DID` or Ed25519 signature (the pairing code is the auth). Instead, the inner body carries `public_key_multibase` — the device key being registered. The bridge must verify that the envelope's authenticated `from_did` (verified via MsgBox challenge-response) matches the device key being paired. Without this, the MsgBox-authenticated transport identity and the registered device identity could diverge: an attacker could authenticate as `did:key:A` but register `did:key:B`, causing responses to be encrypted to the wrong key.

```go
// In handleRPCRequest, after decryption:
if innerPath == "/v1/pair/complete" {
    // Pairing: bind envelope.from_did to body.public_key_multibase
    expectedDID := "did:key:" + body.PublicKeyMultibase
    if envelope.FromDID != expectedDID {
        respondError(403, "envelope from_did does not match pairing key")
        return
    }
} else {
    // Normal RPC: bind envelope.from_did to inner X-DID
    if envelope.FromDID != innerHeaders["X-DID"] {
        respondError(403, "envelope from_did does not match inner X-DID")
        return
    }
}
```

### No Handler Changes

The HTTP handlers themselves don't change. The RPC handler constructs an `http.Request` and calls `handler.ServeHTTP()` directly. From the handler's perspective, it's a normal HTTP request. Auth middleware runs, persona gating runs, rate limiting runs — all the same.

The only new code is the WebSocket-to-HTTP bridge in `handleRPCRequest` and the idempotency cache.

## CLI Changes

### Transport Abstraction

```python
class Transport(Protocol):
    async def request(self, method: str, path: str, body: bytes | None,
                      headers: dict[str, str]) -> TransportResponse: ...

class DirectTransport:
    """Direct HTTPS to Core (current). For local/Docker/LAN use."""
    
class MsgBoxTransport:
    """Request via MsgBox relay (new). For remote/NAT use."""
```

The CLI client selects transport based on config:
- `DINA_TRANSPORT=direct` → DirectTransport (current behavior)
- `DINA_TRANSPORT=msgbox` → MsgBoxTransport
- Default: `msgbox` if `DINA_CORE_URL` is not set or unreachable; `direct` if Core is reachable locally

### MsgBoxTransport Implementation

```python
class MsgBoxTransport:
    def __init__(self, msgbox_url: str, homenode_did: str, device_keypair: Ed25519Keypair):
        self.msgbox_url = msgbox_url
        self.homenode_did = homenode_did
        self.keypair = device_keypair
        self._pending: dict[str, TransportResponse] = {}  # request_id → response
    
    # Default expiry by path pattern (seconds from now)
    _EXPIRY = {"ask": 30, "status": 30, "remember": 300, "task": 300, "pair": 300}
    
    async def request(self, method, path, body, headers,
                      request_id: str | None = None) -> TransportResponse:
        # 1. Connect to MsgBox, authenticate (did:key challenge-response)
        ws = await connect(self.msgbox_url)
        await self.authenticate(ws)
        
        # 2. Drain buffered envelopes (MsgBox sends them immediately on connect — hub.go:55)
        #    Match by (from_did, request_id, direction="response") and cache locally.
        await self._drain_buffered(ws)
        
        # 3. If this is a retry, check if we already have the response from the drain
        rid = request_id or str(uuid4())
        if rid in self._pending:
            return self._pending.pop(rid)
        
        # 4. Build inner request JSON
        inner = {"method": method, "path": path, "headers": headers, "body": base64(body)}
        
        # 5. Encrypt with homenode's X25519 public key
        # (PLC doc #dina_signing is Ed25519 → convert to X25519 via birational map, then NaCl sealed-box)
        ciphertext = nacl_seal(json.dumps(inner), homenode_x25519_public_key)
        
        # 6. Build envelope with expires_at
        ttl = self._expiry_for_path(path)
        envelope = {
            "type": "rpc", "id": rid,
            "from_did": self.keypair.did_key,
            "to_did": self.homenode_did,
            "direction": "request",
            "expires_at": int(time.time()) + ttl,
            "ciphertext": base64(ciphertext),
        }
        
        # 7. Send request, wait for response with matching id
        await ws.send(json.dumps(envelope).encode())  # binary frame
        response = await asyncio.wait_for(self._wait_for_response(ws, rid), timeout=30)
        
        # 8. Decrypt response
        inner_response = nacl_open(response.ciphertext, self.keypair)
        return TransportResponse(status=inner_response.status, ...)
    
    async def _drain_buffered(self, ws):
        """Consume any envelopes MsgBox drained from buffer on connect.
        These arrive as binary frames before any new traffic.
        Each is matched by (from_did=homenode, direction=response) and
        cached in self._pending keyed by request_id."""
        while True:
            try:
                data = await asyncio.wait_for(ws.recv(), timeout=0.5)
            except asyncio.TimeoutError:
                break  # no more buffered messages
            env = json.loads(data)
            if env.get("direction") == "response" and env.get("type") == "rpc":
                self._pending[env["id"]] = env
```

**Drain-before-send contract:** MsgBox's Hub drains all buffered messages to a DID immediately on WebSocket registration (hub.go:55-68). These arrive as binary frames before any new traffic flows. `_drain_buffered` consumes them with a short timeout, matches by `(from_did, request_id, direction="response")`, and caches locally. On retry (same `request_id`), the transport checks this cache before sending — if the response already arrived while the CLI was offline, no re-send is needed. The idempotency cache on Core (keyed by `(from_did, request_id)`) handles the case where the CLI does re-send.

### Configuration

After pairing, CLI config stores:

```json
{
  "core_url": "http://localhost:18100",
  "msgbox_url": "wss://mailbox.dinakernel.com",
  "homenode_did": "did:plc:abc123",
  "device_did": "did:key:z6Mkn...",
  "transport": "auto"
}
```

`transport: "auto"` means: try `core_url` first (direct), fall back to `msgbox_url` (relay).

## Pairing via MsgBox (Telegram-Assisted)

### The Problem

Initial pairing currently requires direct network access to Core. The user must be on the same LAN or have a tunnel. This defeats the purpose of "no public ports."

### Protocol

Pairing via MsgBox uses a **time-limited pairing code** with per-code attempt limiting and source-level throttling:

**Step 1: User requests pairing code (Telegram)**

User → Telegram bot: `/pair`
Brain → Core: `POST /v1/pair/initiate`
Core generates:
- 6-digit pairing code (random)
- Binds it to the Home Node's DID
- TTL: 5 minutes
- Per-code attempt counter: max 3 failed attempts, then code is burned (deleted)

**Note on current implementation:** `pairing.go` today has single-use + TTL but no attempt counter — codes are consumed on first *successful* attempt. This design adds a failed-attempt counter so that 3 wrong guesses burn the code even before TTL expires.

Core → Brain → Telegram:
```
Pairing code: 847291
Expires in 5 minutes. Enter this on the new device.

Your DID: did:plc:abc123
MsgBox: wss://mailbox.dinakernel.com
```

**Step 2: CLI sends pairing request through MsgBox**

```bash
dina configure --pair-code 847291 --did did:plc:abc123 --msgbox wss://mailbox.dinakernel.com
```

CLI generates a new Ed25519 device keypair, then sends through MsgBox:

```json
{
  "type": "rpc",
  "id": "pair-uuid",
  "from_did": "did:key:z6MknewDevice...",
  "to_did": "did:plc:abc123",
  "direction": "request",
  "expires_at": 1744379272,
  "ciphertext": "<NaCl sealed-box: #dina_signing Ed25519 key converted to X25519>"
}
```

Inside the ciphertext (no Ed25519 signature — pairing code IS the auth):

```json
{
  "method": "POST",
  "path": "/v1/pair/complete",
  "headers": {"Content-Type": "application/json"},
  "body": "{\"code\":\"847291\",\"public_key_multibase\":\"z6MknewDevice...\",\"device_name\":\"laptop\"}"
}
```

**Step 3: Core validates and completes**

Core receives the pairing request on its WebSocket:
1. Decrypt the ciphertext
2. **Identity binding check**: verify `envelope.from_did == did:key:{body.public_key_multibase}`. Reject if they diverge (see Identity Binding Rules).
3. No Ed25519 signature validation (pairing is pre-auth — the code IS the auth)
4. Validate the pairing code:
   - Code matches? (if wrong: increment per-code attempt counter; at 3 → delete code)
   - Not expired (5-minute TTL)?
   - Not already consumed?
5. Register the new device's public key
6. Return the pairing result (encrypted with the new device's key)

**Step 4: CLI stores config**

CLI receives the response, stores:
```json
{
  "core_url": "",
  "msgbox_url": "wss://mailbox.dinakernel.com",
  "homenode_did": "did:plc:abc123",
  "device_did": "did:key:z6MknewDevice...",
  "transport": "msgbox"
}
```

Done. CLI can now send requests through MsgBox. No direct network access was ever needed.

### Security of Pairing

| Threat | Mitigation |
|--------|-----------|
| Brute-force code | 6 digits = 1M combinations. **Per-code** attempt counter: 3 wrong guesses burn the code. 5-minute expiry. Per-DID limits are useless here (attacker mints fresh `did:key`), so MsgBox also applies source-IP throttling: max 10 pairing-type RPC messages per IP per 5 minutes. |
| Code interception | Code shown only in Telegram. Bot traffic is server-encrypted (not E2E), but the code is single-use and expires in 5 minutes, limiting the interception window. |
| MsgBox intercepts pairing | Ciphertext is NaCl sealed-box encrypted to Home Node's X25519 key (derived from `#dina_signing` Ed25519 key in PLC doc). MsgBox cannot read it. |
| Replay of pairing request | Code is single-use. Consumed on first successful attempt. |
| Wrong Home Node | CLI encrypts with the specific DID's X25519 key (derived from `#dina_signing` in PLC doc). Only the real Home Node holds the corresponding private key. |
| DID spoofing at MsgBox | MsgBox verifies DID ownership via challenge-response (see DID Authentication section). |

## MsgBox Changes

### New Message Type

**Wire format decision: binary-JSON end-to-end.** The RPC envelope is JSON, but sent as a binary WebSocket frame — not a text frame.

Rationale: Hub's `Deliver()` writes `websocket.MessageBinary` (hub.go:91). Hub's drain loop writes `websocket.MessageBinary` (hub.go:59). Core's `readPump` only processes `websocket.MessageBinary` (msgbox_client.go:159). The durable buffer stores raw `[]byte` payloads and replays them as binary. Making RPC a text frame would require the buffer, drain, and delivery paths to become frame-type-aware, and Core's read pump to accept text frames — all for no benefit. Binary-JSON avoids all of that.

`handler.go` changes: `handleWSBinaryForward` currently assumes the 2-byte-DID-length + DID + payload format. It must now distinguish between the existing D2D binary format and the new RPC JSON binary format:

```go
// handler.go — handleWSBinaryForward (binary frames)
func (h *Handler) handleWSBinaryForward(conn *MsgBoxConn, data []byte) {
    // Try JSON parse first (RPC/cancel envelope starts with '{')
    if len(data) > 0 && data[0] == '{' {
        var env struct {
            Type string `json:"type"`
        }
        if json.Unmarshal(data, &env) == nil {
            switch env.Type {
            case "rpc":
                h.routeRPC(conn, data)
                return
            case "cancel":
                h.routeCancel(conn, data)
                return
            }
        }
    }
    // Existing: 2-byte DID length + DID + payload (D2D binary forwarding)
    if len(data) < 3 {
        return
    }
    // ... existing binary forward logic ...
}
```

**MsgBox sender binding:** Before routing, `routeRPC` and `routeCancel` must verify `envelope.from_did == conn.DID`. Without this, an authenticated connection could forge envelopes with a different `from_did`, poisoning sender-scoped buffer keys, cancel ownership, and idempotency attribution. This is the MsgBox-side analog of Core's identity binding rule (Section "Identity Binding Rules"). The existing D2D binary forward path already uses `conn.DID` for rate limiting (handler.go:115) and never exposes an envelope-level sender field — so D2D is not affected.

`routeRPC` first verifies `envelope.from_did == conn.DID`, then parses the full envelope (`{type, id, from_did, to_did, direction, expires_at, ciphertext}`), looks up the WebSocket for `to_did`, and calls `Hub.Deliver()` — the same binary delivery path used by D2D. **Key invariant: `msgID = from_did:envelope.id`** (see below). For RPC messages, `Hub.Deliver` also stores `sender = envelope.from_did` and `expires_at` in the buffer row, enabling cancel ownership checks and drain-time expiry. Since both the online delivery and buffered drain paths write binary frames, Core's existing `readPump` processes them without change.

`routeCancel` parses the cancel envelope (`{type, cancel_of, from_did, to_did}`) and enforces **cancel ownership**: only the original sender of the buffered request can cancel it. This requires the buffer to store the sender DID alongside each message.

**Buffer schema change:** The current `messages` table (buffer.go:44-51) stores `(id, recipient, payload, size, stored_at)`. For RPC messages, it must also store `sender` and `expires_at`:

```sql
ALTER TABLE messages ADD COLUMN sender     TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN expires_at  INTEGER;  -- NULL = no expiry (D2D default)
```

Cancel flow:
1. Parse `cancel_of` and `from_did` from the cancel envelope
2. Look up the buffered message by composite key `from_did + ":" + cancel_of` — this inherently enforces ownership since the key includes the sender
3. If not found → either already delivered or wrong sender — no action
4. If still buffered and ownership matches → delete from buffer
5. If already delivered → relay the cancel to Core as best-effort

Without the sender column, `cancel_of` would be a delete-by-ID primitive that any connected DID could invoke.

**Critical invariant: `msgID = {from_did}:{envelope.id}` for RPC messages.** `Hub.Deliver(recipientDID, msgID, payload)` (hub.go:83) requires an explicit `msgID`. For RPC, this must be sender-scoped: `msgID = envelope.from_did + ":" + envelope.id`. This is necessary because `envelope.id` is client-generated and two different senders can independently choose the same UUID. The current buffer deduplicates globally by `messages.id` (buffer.go:66) — without sender-scoping, device A's request would shadow device B's if they happen to use the same `id`.

This single composite key is used for:
- **Buffer idempotency**: `Buffer.Add` deduplicates by `msgID` (buffer.go:66) — sender-scoped prevents cross-device collision
- **Retry matching**: CLI retries with the same `id`, buffer dedup prevents duplicate buffering; Core idempotency cache deduplicates by `(from_did, id)`
- **Drain-before-send**: CLI matches buffered responses by `id` (safe because the CLI only sees its own `from_did`-scoped responses)
- **`cancel_of`**: cancel lookup uses `from_did + ":" + cancel_of` to match the buffer key
- **Buffer deletion**: `Buffer.Delete(msgID)` uses the composite key

**Buffer expiry enforcement:** When draining buffered messages on reconnect, Hub checks `expires_at` (if present, stored in the buffer row) against the current time. Expired messages are dropped silently. This is a check in the existing drain loop (hub.go:57).

Text frames remain ACK-only (unchanged).

### DID-Verified Connection Registry

Replace the current unverified DID registration with challenge-response:

```go
func (h *Hub) handleAuth(conn *Connection, msg AuthMessage) error {
    // 1. Send challenge
    challenge := randomBytes(32)
    conn.Send(ChallengeMessage{Challenge: base64(challenge)})
    
    // 2. Receive signed challenge
    signed := conn.Receive()
    
    // 3. Verify based on DID type
    switch {
    case strings.HasPrefix(msg.DID, "did:key:"):
        pubKey := didKeyToEd25519(msg.DID)
        if !ed25519.Verify(pubKey, challenge, signed.Signature) {
            return errors.New("did:key signature verification failed")
        }
    case strings.HasPrefix(msg.DID, "did:plc:"):
        doc := h.plcCache.Fetch(msg.DID)  // cached PLC document
        pubKey := doc.VerificationMethod("#dina_signing")
        if !ed25519.Verify(pubKey, challenge, signed.Signature) {
            return errors.New("did:plc signature verification failed")
        }
    }
    
    // 4. Register verified DID
    h.register(msg.DID, conn)
    return nil
}
```

### Rate Limiting

Separate rate limits for RPC vs D2D:

| Type | Default limit | Rationale |
|------|--------------|-----------|
| D2D per DID | 60/min | External contacts, potential abuse |
| RPC per DID | 300/min | User's own CLI, higher throughput needed |
| Pairing per code | 3 failed attempts → code burned | Per-DID useless (attacker mints `did:key`) |
| Pairing per source IP | 10 pairing RPCs/5min | Source-level throttling at MsgBox |

## Security Summary

| Property | How it's achieved |
|----------|------------------|
| **Confidentiality** | Entire request (method, path, headers, body) inside NaCl sealed-box ciphertext (Ed25519→X25519 converted key). MsgBox sees only routing DIDs + transport metadata (`expires_at`). |
| **Authenticity** | Ed25519 signature inside ciphertext, verified by Core. Same scheme as direct HTTPS. |
| **Integrity** | NaCl authenticated encryption (crypto_box_seal). Tampered ciphertext fails to decrypt. |
| **Identity binding** | Bridge enforces `envelope.from_did == inner X-DID` (normal RPC) and `envelope.from_did == did:key:{public_key_multibase}` (pairing). Prevents routing/idempotency keyed to one identity while auth uses another. |
| **Replay protection** | Timestamp window + nonce cache (same as current). Plus request-level idempotency cache with store-before-send ordering (no duplicate side-effect window). |
| **DID ownership** | MsgBox verifies via challenge-response on WebSocket connect. PLC lookup for did:plc, self-certifying for did:key. |
| **Stale execution prevention** | `expires_at` enforced at three layers: MsgBox drain, Core receipt, Core worker start. `cancel` (sender-ownership-verified) for early user abort. |
| **No metadata leakage** | Method, path, headers all inside ciphertext. MsgBox sees only type + routing DIDs + opaque blob + expiry timestamp. |
| **Pairing security** | 6-digit code, 3 failed attempts per code → burned, 5-minute expiry, NaCl sealed-box, single-use. Source-IP throttling at MsgBox. |
| **D2D (existing)** | End-to-end authenticity intact (recipient verifies sender DID via PLC doc). MsgBox-side `/forward` sender attribution uses self-asserted DID (known gap, deferred fix). |

## Implementation Plan

### Phase 1: MsgBox DID Verification

1. **MsgBox**: Challenge-response DID auth on WebSocket connect
2. **MsgBox**: PLC document cache with TTL
3. **MsgBox**: Support `did:key:` self-verification

### Phase 2: RPC Protocol

1. **MsgBox**: Accept `rpc` and `cancel` message types, route by `to_did`; enforce `expires_at` on buffered messages
2. **Core**: `handleRPCRequest` — async dispatch to worker pool, identity binding check, decrypt, validate signature, route to handler, encrypt response
3. **Core**: `rpc_idempotency` table with TTL-based cleanup
4. **CLI**: `MsgBoxTransport` — temporary WebSocket, send/receive, drain-before-send, `expires_at` per operation type, `cancel` on user abort
5. **CLI**: Transport auto-selection (direct vs msgbox)

### Phase 3: Telegram-Assisted Pairing

1. **Brain**: `/pair` generates code + DID + MsgBox URL
2. **Core**: Per-code attempt counter (3 failed → burn) in pairing manager
3. **MsgBox**: Source-IP throttling for pairing RPCs
4. **CLI**: `dina configure --pair-code CODE --did DID --msgbox URL`

### Phase 4: Remove External Port

1. **docker-compose.yml**: Remove external Core port mapping
2. **install.sh**: No port allocation for Core
3. **Documentation**: "Home Node needs zero inbound ports"
4. **Fallback**: Keep `DINA_TRANSPORT=direct` for Docker/LAN development

## Test Plan

See [MSGBOX_TRANSPORT_TESTCASES.md](MSGBOX_TRANSPORT_TESTCASES.md) — 136 tests across 17 sections (TST-MBX-0001 through TST-MBX-0136).

## Critical Files

| File | Change |
|------|--------|
| `msgbox/internal/auth.go` | DID challenge-response verification |
| `msgbox/internal/handler.go` | `rpc` message type handling (currently only text ACKs + binary DID-prefix forwarding) |
| `msgbox/internal/hub.go` | Route `rpc` + `cancel` messages, PLC cache, `expires_at` check on drain |
| `msgbox/internal/buffer.go` | Add `sender` + `expires_at` columns, cancel-by-ID with ownership check |
| `core/internal/adapter/transport/msgbox_client.go` | Handle `rpc` requests → HTTP handler → response |
| `core/internal/adapter/sqlite/pool.go` | `rpc_idempotency` table |
| `core/internal/middleware/auth.go` | No change needed — `/v1/pair/complete` is already in `optionalAuthPaths` (auth.go:66). RPC bridge must preserve the unauthenticated request shape so the existing exemption works. |
| `cli/src/dina_cli/client.py` | `MsgBoxTransport` class |
| `cli/src/dina_cli/config.py` | Transport preference, MsgBox URL storage |
| `cli/src/dina_cli/main.py` | `--pair-code` / `--did` / `--msgbox` flags |
| `brain/src/service/telegram.py` | `/pair` enhanced with MsgBox URL + DID |

## What This Enables

- **Raspberry Pi behind a router** — works without port forwarding
- **Laptop Home Node** — close the lid, Core disconnects. Open it, reconnects and drains queue.
- **True sovereignty** — no tunnel services, no cloud providers, no static IPs
- **Mobile app** (future) — same MsgBox transport, different client
- **Multiple devices** — each paired device gets its own `did:key`, all relay through MsgBox
