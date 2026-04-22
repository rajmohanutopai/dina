# Feature: canonical signing

**What it is.** The byte string that Dina computes over every HTTP
request before signing with Ed25519. Both sender and receiver
reconstruct this exact string — any drift breaks signature
verification.

## Wire format

```
{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{BODY_HASH_HEX}
```

- **Separator** — single LF (0x0A). No CR, no CRLF, no trailing LF.
- **METHOD** — uppercase HTTP method.
- **PATH** — URL path with leading `/`, no host, no scheme.
- **QUERY** — query string without leading `?`; sorted by key
  lexicographically; empty string when no query params.
- **TIMESTAMP** — RFC3339 UTC with `Z` suffix.
- **NONCE** — random hex string, ≥ 16 bytes of CSPRNG entropy.
- **BODY_HASH_HEX** — lowercase hex of `SHA-256(body_bytes)`.

A receiver with a mismatched timestamp window (±5 min) or a
repeated nonce (per-DID cache, 5-min TTL) rejects the request
before signature verification.

## Headers added to the HTTP request

| Header        | Value                                                            |
|---------------|------------------------------------------------------------------|
| `X-DID`       | Sender DID (`did:plc:...`)                                       |
| `X-Timestamp` | Same RFC3339 string used in the canonical payload                |
| `X-Nonce`     | Same hex nonce                                                   |
| `X-Signature` | Base64url-encoded `Ed25519.Sign(privateKey, canonical_payload)`  |

## Why sort query keys

Two implementations serialising a JavaScript object with the same
fields can emit `a=1&b=2` or `b=2&a=1` depending on language/version.
Signing over an unsorted query means a peer re-serialising the URL
on the receive side might reconstruct a different canonical string
→ signature fails. Sorting is the single deterministic rule both
sides follow.

## Source of truth

- Code: [`canonical_sign.ts`](../../src/canonical_sign.ts) —
  `buildCanonicalPayload` (pure function).
- Server verify: `@dina/core`'s auth middleware verifies the
  headers against the reconstructed canonical string.
- Client sign: `HttpCoreTransport` (`@dina/core`) sorts query keys
  + signs; see `packages/core/src/client/http-transport.ts`.

## Vectors

- [`canonical_request_string.json`](../../conformance/vectors/canonical_request_string.json)
  — 5 cases covering empty-query, empty-body, path params,
  non-empty body hash, HEAD.
- [`sha256_body_hash.json`](../../conformance/vectors/sha256_body_hash.json)
  — companion for the `BODY_HASH_HEX` input (task 10.8).

## Conformance level

**L2** — byte-exact canonical string. Third-party implementations
MUST produce the same bytes for the same inputs.

## See also

- Spec: [`../conformance.md`](../conformance.md) §4.
- Full-envelope signing (non-HTTP, the D2D envelope sign path):
  [`d2d-envelope.md`](./d2d-envelope.md).
