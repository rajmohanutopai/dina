# `@dina/protocol`

[![npm version](https://img.shields.io/npm/v/@dina/protocol.svg?style=flat-square&color=blue&label=npm)](https://www.npmjs.com/package/@dina/protocol)
[![npm downloads](https://img.shields.io/npm/dm/@dina/protocol.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/@dina/protocol)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Zero runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)](./__tests__/dep_hygiene.test.ts)
[![Conformance vectors](https://img.shields.io/badge/conformance%20vectors-9-brightgreen?style=flat-square)](./conformance/vectors)

**The wire-format protocol of Dina — the shapes, strings, and signing
rules two sovereign personal AIs use to talk to each other, without
trusting any server in between.**

This package is for you if you're implementing a Dina in a runtime
that isn't TypeScript — Go, Python, Rust, Swift, Kotlin, or anything
else — and you need to stay bit-compatible with the reference
`@dina/core`. It's also the dependency line we draw around what is
load-bearing on the wire versus what is a Core implementation detail
that may change.

See the repo root's [`README.md`](../../README.md) for the vision
(Dina, The Architecture of Agency) and
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) for the full engineering
blueprint. This package is the subset of the blueprint that
*external* implementations must reproduce exactly.

## What's in here

Wire-format contracts, and nothing else:

| Category | What it covers | File |
| --- | --- | --- |
| DID documents | `did:plc` document shape + verification-method / service-endpoint fields | `types/plc_document.ts` |
| D2D envelopes | Peer-to-peer message payload, service query/response bodies, response-status enum | `types/d2d.ts` |
| Auth frames | MsgBox WebSocket handshake frames (`auth_challenge` / `auth_response` / `auth_success`) | `types/auth_frames.ts` |
| Core RPC | Envelope shape for Core API requests tunnelled through MsgBox | `types/core_rpc.ts` |
| Capability schema | `com.dina.service.profile` publish record + `schema_hash` contract | `types/capability.ts` |
| Wire constants | DID-doc contexts, service-type literals, frame-type strings, port defaults, `MSG_TYPE_*` strings, size limits, notify-priority literals | `constants.ts` |
| Canonical signing | Pure helper that builds the request-signing canonical string | `canonical_sign.ts` |
| Envelope builders | Deterministic constructors for DinaMessage JSON + `CoreRPCRequest` | `envelope_builder.ts` |
| Validators | Body-shape validators + future-skew guard + Ed25519 signature verifier (crypto via DI) | `validators.ts` |

What's **not** here:

- Crypto primitives — no Ed25519, no NaCl sealed box, no Argon2, no
  hashing, no base64, no entropy. Protocol takes hashes as hex
  strings, bodies as base64 strings, request ids as pre-minted
  strings. Your runtime owns the crypto stack; protocol owns the
  shape the crypto operates on.
- State machines — no pairing ceremony, no gatekeeper tier logic,
  no staging drain, no reconnect backoff. Those are in `@dina/core`
  and should be re-implemented in the style idiomatic to your
  runtime.
- HTTP clients, WebSocket clients, storage drivers. Protocol has
  zero I/O.

## Why this split matters

Dina's security model is *enforced by math, not by a privacy policy*.
That only works if every implementation emits and verifies the same
bytes. A Go home node and a mobile TS home node must produce
byte-identical Ed25519 signatures over the same logical message —
if the JSON key order drifts by one field, every cross-runtime
handshake fails with `invalid signature`. We've eaten that bug
twice already; the exact-byte tests in this package exist to
prevent a third.

Extracting the wire contract into its own zero-deps package lets us:

1. **Pin determinism**: fixture-compat + exact-byte tests here catch
   wire-format drift before release.
2. **Let third-party implementations build against a schema**, not
   a full TS runtime.
3. **Prove, via a CI dep-hygiene gate, that protocol has no runtime
   dependency on Core or Brain** — reverse-coupling would mean
   changes to Core's business logic could accidentally break the wire.

## Zero-runtime-deps invariant

The `__tests__/dep_hygiene.test.ts` gate enforces:

- No import of any `@dina/*` workspace package.
- No import of any crypto library (`@noble/*`, `@scure/*`, `hash-wasm`,
  `tweetnacl`, `libsodium`, `argon2`).
- No import of any HTTP client (`undici`, `ws`, `fetch`, `node:http`).
- `package.json` has no `dependencies` block at all.

If you're forking this package into a different monorepo, keep the
invariant. The moment protocol grows a runtime dep, third-party
implementations have to pull TypeScript/Node to talk to the reference
node, and the abstraction boundary is gone.

## How purity is preserved when the original logic needed crypto

Functions that logically belong on the wire contract but happen to
need a crypto primitive are split into "compose the shape" (pure,
stays here) and "run the crypto" (callback or pre-hashed input).

- **Canonical signing** — `buildCanonicalPayload(method, path, query,
  timestamp, nonce, bodyHashHex)` takes a pre-hashed body. Your
  runtime computes `SHA-256(body)` and passes the hex. The signing
  step that happens next is yours — protocol just gives you the
  canonical string to sign.
- **DinaMessage JSON** — `buildMessageJSON(input)` takes
  `bodyBase64: string`. Your runtime encodes the body bytes with
  whatever base64 library it has; protocol assembles the key-ordered
  JSON around it.
- **Signature verify** — `verifyMessageSignature` takes an
  `Ed25519VerifyFn` and a `hexToBytes` converter as callbacks. Pass
  your `@noble/ed25519.verify` on Node; pass `libsodium.crypto_sign_verify`
  on native; pass `crypto/ed25519.Verify` from Go.

The reference `@dina/core` is the first consumer of the DI'd versions,
and its wrappers add the platform-specific bits:

```ts
// core/src/d2d/envelope.ts
import { buildMessageJSON } from '@dina/protocol';
import { base64 } from '@scure/base';

export function buildMessage(msg: DinaMessage): string {
  const bodyBytes = new TextEncoder().encode(msg.body);
  return buildMessageJSON({
    id: msg.id,
    type: msg.type,
    from: msg.from,
    to: msg.to,
    created_time: msg.created_time,
    bodyBase64: base64.encode(bodyBytes),
  });
}
```

A Go implementation looks almost identical — lift the pattern, swap
the encoder.

## Compatibility guarantees

- **Types** are structurally compared to JSON fixtures in
  `packages/fixtures/` via the fixture-compat test. A rename
  requires updating the fixture and bumping the wire version.
- **Key order in `buildMessageJSON`** is pinned by exact-byte tests.
  It matches Go's declaration-order `json.Marshal` of `DinaMessage`,
  which is what the reference Ed25519 signing uses. Don't reorder
  keys.
- **Error messages** returned by the structural validators are
  part of the public API surface. Core and Brain log these; external
  log-analysis tools may grep them. Error strings won't change
  without a flagged release note.
- **Constants** (strings, port numbers, size limits) are part of the
  wire format. A port-default change would mean every pre-existing
  peer has the wrong config file; we won't do that lightly.

## Implementing Dina in another language

The loose recipe, assuming you've read the vision doc:

1. **Start with `constants.ts`.** Re-declare every string / number /
   literal in your language's idiom. Add tests that compare your
   values to this file literally.
2. **Port the type declarations.** Map `types/*.ts` interfaces to
   your language's structs / dataclasses. Use the JSON fixtures in
   `packages/fixtures/` as an integration check — if you can parse
   them and get the same field values, you're on the wire.
3. **Port the canonical-sign helper.** Confirm your canonical string
   is byte-identical to what this package emits for the same inputs.
4. **Port the validators.** They're pure logic — no crypto. Just
   reproduce the null/error-string contract. The test file
   (`__tests__/validators.test.ts`) doubles as a conformance spec.
5. **Now wire in your crypto stack** (Ed25519 sign/verify, NaCl
   sealed box, SHA-256, Argon2id for persona unlock). Protocol
   doesn't care which library; just verify cross-runtime
   round-trips with the reference `@dina/core` over a loopback
   channel.

A dedicated conformance suite ships in `./conformance/`. Run it
against the reference TypeScript implementation at any time:

```bash
cd packages/protocol
npm run conformance              # human-readable report; exit 0 iff every vector passes
npm run conformance -- --json    # machine-readable JSON
```

The runner is `conformance/suite.ts` (`runConformance`); the CLI is
`conformance/cli.ts`; the frozen inputs live in
`conformance/vectors/`. The Jest test
`__tests__/conformance_suite.test.ts` is the same check wired into
CI. See [`docs/conformance.md`](./docs/conformance.md) for the
normative spec and [`docs/features/`](./docs/features/) for the
per-feature walkthroughs.

## Publishing to npm

Currently ships TS source for workspace-internal consumption. Phase 10
task 10.18 ("Publish `@dina/protocol` to npm") adds a `tsc` build
step emitting `dist/index.{cjs,mjs,d.ts}` and updates `exports` to
point there so external TS/JS consumers can `npm install @dina/protocol`
without pulling the rest of the workspace.

## See also

- [docs/HOME_NODE_LITE_TASKS.md](../../docs/HOME_NODE_LITE_TASKS.md)
  Phase 1b — extraction roadmap + per-task annotations.
- [packages/README.md](../README.md) — workspace layering rules.
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — Dina's engineering
  blueprint; this package is its wire-format subset.

## License

Same as the repo root. See [`LICENSE`](../../LICENSE).
