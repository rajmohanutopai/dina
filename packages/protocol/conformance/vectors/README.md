# `@dina/protocol` conformance vectors

Frozen byte-exact test vectors that a non-reference Dina
implementation runs against to prove wire compatibility with the
TypeScript reference.

**Status: scaffold (task 10.4 done).** The individual vector files
land with tasks 10.5 – 10.13. Until each one lands, a placeholder
`.pending` file sits in its slot so the `index.json` stays
authoritative about what's expected.

## How vectors are organised

```
conformance/vectors/
├── README.md            # this file — layout + contribution rules
├── index.json           # machine-readable manifest (one entry per vector)
└── <vector_name>.json   # per-vector file (data frozen at task-land time)
```

`index.json` is the only file the conformance suite reads directly;
each entry points at a sibling file plus metadata about which
conformance level (L1–L3; see `docs/conformance.md` §3) the vector
exercises and which reference source it was produced from.

## Vector file shape

Each vector is a JSON document with this top-level shape:

```json
{
  "name": "canonical_sign_basic",
  "description": "Minimum canonical-sign payload — empty query, empty body hash.",
  "level": "L2",
  "task": "10.7",
  "producer": {
    "tool": "packages/protocol/src/canonical_sign.ts",
    "commit": "<sha>"
  },
  "inputs": {
    "method": "POST",
    "path": "/v1/vault/query",
    "query": "",
    "timestamp": "2026-04-22T10:30:00Z",
    "nonce": "f0e87a2b...",
    "body_hash_hex": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  "expected": {
    "canonical_string_utf8": "POST\n/v1/vault/query\n\n2026-04-22T10:30:00Z\nf0e87a2b...\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }
}
```

Binary byte sequences are hex-encoded with a `_hex` suffix on the
field name. Base64-encoded blobs use the standard alphabet (not
URL-safe) and a `_base64` suffix. All timestamps are RFC3339 UTC.

## Conformance levels

See [`../../docs/conformance.md`](../../docs/conformance.md) §3. In
short:

- **L1** — shape conformance (types + field names). Verified by
  JSON-parse + field presence.
- **L2** — byte-exact envelope + canonical-string assembly.
- **L3** — Ed25519 round-trip: port signs with its crypto stack,
  reference verifies; reference-signed bytes verify with port.

Each vector declares exactly one level so implementers can gate
their compliance claim at whichever level they target.

## Producing new vectors

1. Add an entry to `index.json` with `"status": "pending"` and the
   filename slot.
2. Place a `.pending` sentinel next to the index until the real file
   lands.
3. When the producing task (10.5 – 10.13 in the plan) lands:
   a. Emit the vector from the reference source pinned in `producer`.
   b. Commit alongside a test in `__tests__/conformance_vectors.test.ts`
      that re-derives the `expected` fields from the reference and
      asserts equality.
   c. Replace the sentinel with the real `.json` file.

Vectors are **frozen at land time**. Regenerating them is a
protocol-wire event — bump the `producer.commit` and update the
changelog in `docs/conformance.md` §15.

## Reading a vector from an external implementation

```bash
# Fetch a vector (e.g. canonical request string)
cat conformance/vectors/canonical_request_string.json

# Feed the inputs into your port
# Compare your port's output against `expected`
# Pass/fail per level (see conformance.md §3)
```

A runnable harness (`conformance/suite.ts`) lands with task 10.14.
Until then, this directory is machine-readable but requires your
own test glue to consume.

## What's not here (deliberately)

- **No private keys.** L3 vectors include a public DID document + a
  signature produced during vector generation; the private key is
  destroyed after. Porting implementations can verify but not
  re-sign with these vectors' identities.
- **No full PDS traffic traces.** PDS round-trips are integration-
  scope; `test_trust_network.py` covers them. The conformance kit
  is protocol-scope only.
- **No llama-cpp or agent traffic.** Agent orchestration is above
  the protocol line — not wire-format.

## See also

- [`../../docs/conformance.md`](../../docs/conformance.md) — the spec.
- [`../../README.md`](../../README.md) — implementer overview.
- `docs/HOME_NODE_LITE_TASKS.md` Phase 10 — roadmap for the
  remaining vectors (10.5 – 10.13) and the runnable suite (10.14 –
  10.17).
