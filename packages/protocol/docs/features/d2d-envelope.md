# Feature: D2D envelope

**What it is.** The JSON shape two Home Nodes exchange over the
MsgBox relay when one Dina talks to another. Every D2D envelope is
Ed25519-signed over its `buildMessageJSON` output.

## Wire format

```json
{"id":"m-0001","type":"presence.signal","from":"did:plc:alice","to":["did:plc:bob"],"created_time":1745318400,"body":"PGJhc2U2NCBjb250ZW50Pg=="}
```

## Rules

- **Key order is pinned**: `id` → `type` → `from` → `to` →
  `created_time` → `body`. Matches Go's declaration-order
  `json.Marshal(DinaMessage)`. Any reorder breaks Ed25519 cross-
  runtime verification.
- **`to` is always an array** on the wire, even when a single
  recipient was supplied. Single-string input MUST be lifted to
  `[string]` before serialisation.
- **`created_time` is Unix seconds** (integer, not quoted).
- **`body` is standard base64** (A-Z, a-z, 0-9, +, /, =). Not URL-
  safe. Not preceded by a MIME prefix.
- **Compact JSON** — no whitespace around `:` or `,`. No trailing
  newline.

## Why these rules

Ed25519 signatures commit to exact bytes. If Brain emits JSON with
keys in one order and Core re-serialises in another, the signature
over the two byte sequences differs → cross-runtime signature
verification fails. Pinning key order, array normalisation, and
compact emission makes every Dina implementation's JSON identical.

## Message types

The `type` field is one of nine `MSG_TYPE_*` string literals defined
in [`constants.ts`](../../src/constants.ts). Implementations MUST
use the exact strings — any other value is non-conforming.

## Source of truth

- Code: [`envelope_builder.ts`](../../src/envelope_builder.ts) —
  `buildMessageJSON` (pure function; the caller has already
  base64-encoded the body).
- Type: [`types/d2d.ts`](../../src/types/d2d.ts).

## Vectors

- [`d2d_envelope_round_trip.json`](../../conformance/vectors/d2d_envelope_round_trip.json)
  — 4 cases: single-recipient (array-lifted), already-array,
  multi-recipient, service-response with non-empty body.

## Conformance level

**L2** — byte-exact JSON emission from given inputs.

## See also

- Spec: [`../conformance.md`](../conformance.md) §5.
- Request signing (different flow, uses `buildCanonicalPayload`
  not `buildMessageJSON`): [`canonical-signing.md`](./canonical-signing.md).
- Auth handshake that wraps D2D envelope delivery:
  [`auth.md`](./auth.md).
