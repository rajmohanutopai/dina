# `@dina/protocol` — Conformance Specification

**Status: v0 draft.** Pinned against `@dina/protocol` source in this
repo at commit time. Bumps follow protocol-major only; a flagged
release note accompanies every change.

This document defines what a non-reference Dina implementation must
reproduce byte-for-byte to be compatible with the TypeScript
reference (`@dina/core` / `@dina/brain`). It is the normative
counterpart to the README's narrative overview.

Readers: you are implementing a Dina in Go / Rust / Swift / Kotlin
/ C# / anything else, and you need a home node in that language to
be indistinguishable from the reference when seen from another peer.

If you only want to consume the package from TypeScript, this spec
is not required — the types compile and the tests are green.

## 1. Scope

In scope:

- Wire-format shapes and JSON key orders.
- String literals that appear on the wire.
- Canonical strings for signing.
- Validator input/output contracts.
- Constant values (ports, URIs, fragments, enums).

Out of scope (implementation choice, no conformance requirement):

- Crypto library.
- HTTP client, WebSocket client.
- Storage engine.
- State machines (pairing ceremony, gatekeeper, staging drain,
  reconnect logic).
- Logging format.

## 2. Normative references

| Artefact                                       | Path                                              |
|------------------------------------------------|---------------------------------------------------|
| Source of truth — constants                    | `packages/protocol/src/constants.ts`              |
| Source of truth — types (DID/d2d/RPC/auth/cap) | `packages/protocol/src/types/`                    |
| Source of truth — canonical signing            | `packages/protocol/src/canonical_sign.ts`         |
| Source of truth — envelope builders            | `packages/protocol/src/envelope_builder.ts`       |
| Source of truth — validators                   | `packages/protocol/src/validators.ts`             |
| JSON fixtures                                  | `packages/fixtures/`                              |
| Test vectors                                   | `packages/protocol/conformance/vectors/`          |

When the source and this document disagree, **the source is
authoritative**. Report the drift as a bug.

## 3. Conformance levels

Implementations are graded by the smallest level of conformance they
meet. Each level subsumes the previous.

| Level | Name          | Requirement                                                                   |
|-------|---------------|-------------------------------------------------------------------------------|
| L1    | Shape         | Emits + parses all wire types with correct field names + types.               |
| L2    | Byte-exact    | Assembled envelopes + canonical strings are byte-identical to the reference. |
| L3    | Signed round-trip | Can Ed25519-sign a canonical payload that the reference verifies — and can verify a reference-signed payload. |
| L4    | Full peer     | Completes a handshake over MsgBox + exchanges at least one `service.query` / `service.response` round-trip with a reference node. |

M1 ship of Home Node Lite targets L4 by definition (two Lite nodes
must talk to each other). External implementations don't need to
reach L4 to claim "Dina-protocol compatible" — L3 is the minimum
acceptable bar.

## 4. Canonical signing (L2 requirement)

### 4.1 Canonical payload shape

For every Ed25519-signed HTTP request, the string that gets signed
MUST be exactly:

```
{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{BODY_HASH_HEX}
```

with the following pinned semantics:

| Field          | Format                                          | Example                                |
|----------------|-------------------------------------------------|----------------------------------------|
| `METHOD`       | Uppercase HTTP method                           | `POST`                                 |
| `PATH`         | URL path, leading slash, no host                | `/v1/vault/query`                      |
| `QUERY`        | Query string without leading `?`, empty if none | `persona=personal&limit=10`            |
| `TIMESTAMP`    | RFC3339 UTC                                     | `2026-04-22T10:30:00Z`                 |
| `NONCE`        | Random hex string, ≥ 16 bytes of entropy        | `f0e8...7a2b`                          |
| `BODY_HASH_HEX`| Lowercase hex of `SHA-256(body_bytes)`          | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty-body case) |

Separators are ASCII newline (`0x0A`). No trailing newline. The
reference implementation is `buildCanonicalPayload` in
`canonical_sign.ts` — your port MUST produce byte-equal output for
the same inputs.

Verification: `conformance/vectors/canonical_request_string.json`
and `conformance/vectors/sha256_body_hash.json` (for the
`BODY_HASH_HEX` input).

### 4.2 Query serialisation

When you construct the canonical payload from parsed components,
`QUERY` MUST be emitted with **sorted keys**, lexicographic on the
UTF-8 byte sequence. Multi-value keys: repeat the key in sort
position, values in caller-supplied order.

`HttpCoreTransport` and `@dina/core`'s server side both sort before
signing and before verifying. A mismatch here surfaces as "invalid
signature" — the most common cause of handshake failure across
implementations.

### 4.3 Headers applied to the request

The sender MUST attach these four headers, computed from the
canonical payload + its private key:

| Header         | Source                                              |
|----------------|-----------------------------------------------------|
| `X-DID`        | The sender's DID in `did:plc:...` form              |
| `X-Timestamp`  | Same RFC3339 value used in the canonical payload    |
| `X-Nonce`      | Same hex nonce                                      |
| `X-Signature`  | Base64url of `Ed25519.Sign(privateKey, canonical)`  |

The receiver recomputes the canonical string from the request, hashes
the body bytes, and verifies `X-Signature` against `X-DID`'s
published signing key. Timestamp window: **±5 minutes** from the
receiver's clock.

## 5. DinaMessage envelope (L2 requirement)

`buildMessageJSON` is the load-bearing function — its output is what
gets signed for D2D messages.

### 5.1 Key order

Output JSON MUST have keys in this order:

```
id
type
from
to
created_time
body
```

Reference:
```json
{"id":"m-42","type":"nudge","from":"did:plc:a","to":["did:plc:b"],"created_time":1745318400,"body":"PGJhc2U2NCBjb250ZW50Pg=="}
```

Go-interop note: this order matches Go's declaration-order
`json.Marshal(DinaMessage)`. Any reordering breaks Ed25519
cross-runtime verification.

### 5.2 Normalisation rules

- `to` is **always** an array on the wire, even when a single
  recipient was supplied. Single-string input MUST be lifted to
  `[string]` before serialisation.
- `created_time` is Unix seconds, integer.
- `body` is base64 (standard alphabet, not URL-safe, padded).
- No whitespace, no trailing newline. `JSON.stringify(obj)`-style
  compact output.

Verification: `conformance/vectors/d2d_envelope_round_trip.json`.

## 6. Core RPC envelope (L2 requirement)

`buildRPCRequest` assembles a `CoreRPCRequest` — the shape that
tunnels a Core API call across MsgBox.

Required fields and their order in a compatible JSON serialisation:

```
type           (literal "core_rpc_request")
request_id     (caller-minted, typically "rpc-<hex>")
from           (sender DID)
method         (uppercase HTTP method)
path           (URL path)
query          (query string without leading ?)
headers        (map<string,string> — includes the X-Signature block)
body           (UTF-8 string, empty string if no body)
```

Response envelope:

```
type           (literal "core_rpc_response")
request_id     (echoed from the request)
status         (integer HTTP status)
headers        (map<string,string>)
body           (UTF-8 string)
```

The `type` literals come from `RPC_REQUEST_TYPE` (= `core_rpc_request`)
and `RPC_RESPONSE_TYPE` (= `core_rpc_response`) in `constants.ts` —
implementations MUST use those exact strings.

## 7. MsgBox auth handshake (L3 requirement)

On WebSocket connect, the flow is exactly three frames (shapes from
`types/auth_frames.ts`):

1. **Server → Client** — `{"type":"auth_challenge","nonce":"<hex>","ts":<unix_seconds>}`
2. **Client → Server** — `{"type":"auth_response","did":"did:plc:...","sig":"<hex>","pub":"<hex>"}`
   where `sig = Ed25519.Sign(privateKey, buildAuthSignedPayload(nonce, ts))`.
   The signed payload is the literal string:

   ```
   AUTH_RELAY\n{nonce}\n{ts}
   ```

   `\n` is one ASCII newline (0x0A). `{nonce}` is the exact hex
   string the server sent; `{ts}` is the integer Unix-seconds value
   rendered as a decimal string.
3. **Server → Client** — `{"type":"auth_success"}` (no payload fields
   — introduced in msgbox 0.14, strict fail-closed).

Frame type literals come from `AUTH_CHALLENGE` / `AUTH_RESPONSE` /
`AUTH_SUCCESS`. Signature is hex-encoded (not base64); public key
is hex-encoded and corresponds to the signing key published in the
sender's `did:plc` document. Anything outside this schema is a
protocol violation; the relay MUST close with WebSocket code 1008.

## 8. DID document (L1 requirement)

`types/plc_document.ts` defines:

- `@context` MUST contain `DID_V1_CONTEXT` and `MULTIKEY_CONTEXT`.
- `verificationMethod` entries MUST have `type: "Multikey"` when
  carrying Dina's signing key; `publicKeyMultibase` is the canonical
  form.
- The signing key's verification-method fragment is
  `DINA_SIGNING_FRAGMENT` (= `#dina_signing`). Readers MUST also
  accept the legacy `#dina-signing` form for backward compat.
- Messaging-service endpoint fragment is `DINA_MESSAGING_FRAGMENT`
  (= `#dina_messaging`), same backward-compat rule applies.
- Service-endpoint `type` is one of `SERVICE_TYPE_MSGBOX` or
  `SERVICE_TYPE_DIRECT_HTTPS`.

## 9. Constants (L1 requirement)

Every string / number in `constants.ts` is on-the-wire. An
implementation MUST re-declare the same literal values. The
`@dina/protocol` CI has a test that compares the constants file
against the published fixtures — your port SHOULD have an
equivalent gate.

Default port numbers (`DEFAULT_CORE_PORT = 8100`,
`DEFAULT_BRAIN_PORT = 8200`, `DEFAULT_MSGBOX_PORT = 7700`) are
defaults only; operators may override via env vars. Your port must
default to the same values so unconfigured peers find each other.

### 9.1 D2D scenarios (L1 requirement)

`D2D_SCENARIOS` declares the six policy buckets every D2D message
type belongs to:

```
['presence', 'coordination', 'social', 'safety', 'trust', 'service']
```

Sharing policies are stored per-(contact, scenario), so partner
Home Nodes MUST agree on the namespace. Each language port mirrors
the list and the message-type → scenario mapping (Go:
`domain/message.go::MsgTypeToScenario`). Adding a scenario is a
wire break — bump the protocol minor and update §15.

Mapping (frozen):

| Message type            | Scenario       |
|-------------------------|----------------|
| `presence.signal`       | `presence`     |
| `coordination.request`  | `coordination` |
| `coordination.response` | `coordination` |
| `social.update`         | `social`       |
| `safety.alert`          | `safety`       |
| `trust.vouch.request`   | `trust`        |
| `trust.vouch.response`  | `trust`        |
| `service.query`         | `service`      |
| `service.response`      | `service`      |

## 10. Validators (L2 requirement)

`validators.ts` exports the three structural validators:

- `validateDinaMessage(obj)` — returns `null` on pass, string on fail.
- `validateCoreRPCRequest(obj)` — same.
- `validateAuthResponse(obj)` — same.

Error strings are part of the public API surface. Your port's
equivalent MUST return the same literal messages when asked about
the same failure mode; log aggregators grep on them. See
`__tests__/validators.test.ts` for the frozen list.

Timestamp skew: `created_time` is valid in the window
`[now - 300, now + 300]` seconds. Outside → error string
`"created_time too old"` or `"created_time too far in future"`.

## 11. Sealed-box encryption (L2 + L3 requirement)

D2D ciphertexts use libsodium's `crypto_box_seal` scheme —
anonymous (no sender crypto-auth; sender auth comes from the
Ed25519 signature around the envelope) and deterministic in its
nonce so the recipient can recompute it.

Wire layout:

```
sealed = eph_pub (32 bytes) || XSalsa20-Poly1305(shared, nonce, plaintext)
```

- `eph_pub` — fresh ephemeral X25519 public key, one per sealed message.
- `shared` — `X25519(eph_priv, recipient_pub)` on the sender,
  `X25519(recipient_priv, eph_pub)` on the receiver.
- `nonce` — `BLAKE2b-24(eph_pub || recipient_pub)`. **Not**
  `SHA-512(input)[:24]` (pre-#9 Go regression). Every libsodium
  binding derives this nonce the same way; hand-rolled
  implementations that don't are non-conforming.
- Ciphertext overhead is 48 bytes = 32 (ephemeral pub) + 16 (Poly1305 MAC).

Verification:

- `conformance/vectors/blake2b_24_sealed_nonce.json` — nonce
  formula, L2 (hash re-derivation, no private key needed).
- `conformance/vectors/nacl_sealed_box.json` — full encrypt /
  decrypt L3 round-trip: decrypt shipped ciphertexts with the
  shipped recipient private key, match plaintexts, confirm
  Poly1305 fails on any byte tamper.

See [`features/sealed-box.md`](./features/sealed-box.md) for the
field-by-field walkthrough.

## 12. Cross-runtime round-trip (L3 + L4 requirement)

L3 round-trip test (external implementers SHOULD reproduce):

1. Take the fixture in `conformance/vectors/d2d_envelope_round_trip.json`
   (reference-produced bytes) and the companion Ed25519 vector in
   `ed25519_sign_verify.json`.
2. Parse + verify an Ed25519 signature over the frozen JSON bytes
   against the accompanying public key.
3. Mutate one field; verify the signature now fails.

L4 round-trip test:

1. Start a reference `@dina/home-node-lite-core` on loopback with
   your test DID's public key registered.
2. Your implementation sends a signed `CoreRPCRequest` wrapped in a
   DinaMessage via MsgBox.
3. Assert the reference Core returns the expected RPC response.

## 13. Version + backward compatibility

- **Protocol major** changes mean wire-breaking changes (key order,
  fragment names, serialisation semantics). Flagged in the release
  notes + requires implementers to bump.
- **Protocol minor** changes are additive: new optional fields, new
  enum values that older implementations can treat as "unknown".
- **Patch** changes don't touch the wire.

The current protocol version is carried in `@dina/protocol`'s
`package.json`. There is no wire-carried version header yet —
compat is declared via the package's major; wire-incompatible
changes require a flagged major bump + a release note naming every
affected vector. Implementations SHOULD record the `@dina/protocol`
version they target in their own build metadata so drift is
attributable.

## 14. Test vectors

The companion directory `packages/protocol/conformance/vectors/` ships
signed example bytes for every assertion above (task 10.4). A port
MUST pass its L1–L3 subset against those vectors; L4 vectors
describe the network-level exchange but require a live loopback.

## 15. Changelog to this document

- **2026-04-22** — initial draft accompanying the scaffold for task
  10.4. Content pinned against `@dina/protocol` at this repo's HEAD.
- **2026-04-22** — added §11 sealed-box section; renumbered §12–16;
  fixed vector-filename references (`canonical_sign.json` →
  `canonical_request_string.json`, `dina_message.json` →
  `d2d_envelope_round_trip.json`); removed stale claim that a
  wire-carried version header would land in task 10.14.

## 16. See also

- [`README.md`](../README.md) — `@dina/protocol` implementer
  overview (narrative).
- [`../INVENTORY.md`](../INVENTORY.md) — per-file inventory with
  extraction provenance.
- [`../src/`](../src/) — the source of truth.
- [`../conformance/vectors/`](../conformance/vectors/) — frozen
  test vectors.
- Home Node Lite task plan: `docs/HOME_NODE_LITE_TASKS.md` Phase 10.
