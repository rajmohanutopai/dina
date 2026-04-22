# Feature: MsgBox auth handshake

**What it is.** The three-frame WebSocket exchange every Home Node
runs with the MsgBox relay when it connects. Proves the caller
controls the private key that corresponds to the DID they're
claiming — before any D2D envelopes flow.

## Flow

```
server → client   {type: "auth_challenge", nonce, ts}
client → server   {type: "auth_response",  did, sig, pub}
server → client   {type: "auth_success"}
```

Anything outside this schema is a protocol violation. The relay
MUST close the WebSocket with code `1008` (policy violation) on
bad/extra/out-of-order frames.

## Signed payload

The client signs exactly this string with Ed25519:

```
AUTH_RELAY\n{nonce}\n{ts}
```

- `AUTH_RELAY` — literal 10 ASCII bytes.
- `\n` — one LF (0x0A).
- `{nonce}` — the server-sent hex nonce verbatim.
- `{ts}` — the server-sent Unix-seconds timestamp rendered as a
  decimal integer string (no leading zero, no sign).
- No trailing LF.

## auth_response field shapes

| Field | Type / encoding                              |
|-------|----------------------------------------------|
| `did` | Full DID string (`did:plc:...` or `did:key:...`) |
| `sig` | Hex-encoded Ed25519 signature (64 bytes → 128 hex chars) |
| `pub` | Hex-encoded raw Ed25519 public key (32 bytes → 64 hex chars) |

`pub` MUST match the public key published in the sender's DID
document under `#dina_signing` (see [`plc-document.md`](./plc-document.md)).
A public-key substitution attack fails because the relay verifies
the DID's published key against `pub`.

## auth_success

Introduced in msgbox 0.14. No payload fields. Earlier relays
omitted this frame entirely; that transitional behaviour is no
longer supported — the client MUST wait for `auth_success` before
treating the session as established.

## Source of truth

- Types: [`types/auth_frames.ts`](../../src/types/auth_frames.ts) —
  `AuthChallengeFrame`, `AuthResponseFrame`, `AuthSuccessFrame`.
- Payload builder: [`buildAuthSignedPayload`](../../src/types/auth_frames.ts).
- Frame-type constants: `AUTH_CHALLENGE`, `AUTH_RESPONSE`,
  `AUTH_SUCCESS` in [`constants.ts`](../../src/constants.ts).

## Vectors

- [`auth_challenge_response.json`](../../conformance/vectors/auth_challenge_response.json)
  — full L3 round-trip vector: deterministic challenge, signed
  payload bytes, pub + sig hex, expected verify pass, tamper
  (ts+1) fail.

## Conformance level

**L3** — signed round-trip. The external implementation must both
(a) produce a signed response the reference can verify, and (b)
verify a reference-produced response.

## See also

- Spec: [`../conformance.md`](../conformance.md) §7.
- PLC document (where the `pub` field's matching verification
  method lives): [`plc-document.md`](./plc-document.md).
- Canonical signing (the OTHER signing flow — HTTP request signing
  not WebSocket auth): [`canonical-signing.md`](./canonical-signing.md).
