# @dina/commerce-protocol — conformance

The byte-exact wire contract for Dina commerce (`docs/COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md`
§9, §10, §25). Ports in Go, Rust, Swift, Kotlin or Python target this package.

---

## ⚠️ `1.x` IS NOT FROZEN

**Status: pre-freeze. Do not target this wire for interoperability yet.**

`protocol_version` currently reads `1.0`, but that number does **not** yet
carry the usual promise. The spine has changed since it was first written —
most visibly `HeldEvidence`, which wrapped bare records in
`{record, signature, signer_key_id?}` and is an incompatible change — and
further changes are expected before Phase 0 exits.

**Owner decision, 2026-08-07:** rather than burn a major on pre-release churn,
`1.x` is declared explicitly unstable until the §24 Phase 0 exit criterion is
met, and then freezes at `1.0`.

Concretely, until this section is removed:

- no implementation may claim commerce conformance;
- no third party should target this wire;
- records signed by a build before the freeze may not verify against a build
  after it, and that is expected rather than a defect;
- changes land without a version bump, recorded in the changelog below.

Nothing is deployed and no external peer exists, which is the only reason
this is acceptable. **The moment either becomes false, this section must be
replaced by a real version policy.**

### Phase 0 exit criteria (§24)

Freeze happens when all of these hold:

- [ ] canonicalization, digests and arithmetic settled (§9.1, §9.3) — **done**
- [ ] catalog declaration/snapshot records and proof verification (§10.2) — open
- [ ] frozen vectors cover every §25.1 category — partial
- [ ] product relationship claims, evidence thresholds, review dimensions — partial
- [ ] legal order-state transitions and error codes (§9.11) — **done**
- [ ] quote/order retention and idempotency windows (§15.5) — **done**

Exit test: independent implementations produce byte-identical digests from the
frozen vectors and reject the same malformed inputs.

---

## Changelog

Entries are additions to, or breaks in, the wire contract. Until the freeze
above is lifted, breaks do not bump the version.

### Unreleased (pre-freeze `1.x`)

- **BREAKING** — `HeldEvidence<T>` wraps held records as
  `{record, signature, signer_key_id?}`. Previously the bare record travelled
  alone, which meant a content digest (computable by anyone) was the only
  thing standing behind a re-adoption claim.
- **BREAKING** — `computeTotal` sums all signed adjustments and applies
  non-negativity to the FINAL total. Previously any intermediate negative was
  rejected, which made validity depend on charge order and broke the §9.1
  plain-integer-sum guarantee for any document where a discount precedes a
  surcharge.
- **BREAKING** — `BuyerQuoteContext` now requires the retained `QuoteRequest`
  and an `at_iso` acceptance time. Verification binds quote lines to requested
  lines, exact product identity, substitution authority, and expiry. A digest
  alone proved only that the supplier saw the request.
- `validateIsoUtc` rejects impossible calendar dates. `Date.parse` accepts
  `2026-02-30` and silently means 2 March; a digest-covered timestamp that
  means a different day than it reads produces different bytes across
  implementations that disagree about normalising.
- `validateProductRelationshipClaim` enforces the object discriminant in both
  directions. `manufactured_by` with a `ProductRef` object previously passed.

---

## Frozen vectors

`conformance/vectors/`:

| file | covers |
|------|--------|
| `arithmetic.json` | line subtotals, magnitude bounds (both sides), totals including charge-order permutation equivalence and an expected rejection |
| `digests.json` | domain separation across the ten commerce record domains |
| `malformed.json` | inputs every implementation must reject |

**Known gaps** (§25.1 categories not yet frozen): unit/pack conversion,
product normalization, relationship canonicalization and temporal validity,
catalog snapshot roots, substitution/variant mismatch, exact-variant
projection, schema-version and unknown-field behaviour.

A vector case carries either `expected_*` (a result) or
`expected_error_contains` (a rejection). Both matter: an implementation that
accepts what this one refuses is not conformant either.
