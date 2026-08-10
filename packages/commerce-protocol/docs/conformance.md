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
- [x] catalog declaration/snapshot records and proof verification (§10.2) —
      wire contract, publisher, ingester and frozen vectors landed; the AppView
      index that consumes them is separate and unbuilt
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
- **BREAKING** — `verifyRestoreFence` now requires an `at_iso` receiver clock
  and applies the dispute deadline to a `delivered -> disputed` fence, the way
  `verifyStatusSuccession` already did on the ordinary path. Previously the
  fence path never looked at the window — it took no clock at all — so a
  supplier could dispute an order whose window closed long ago by marking the
  record `restore_fence: true`. The parameter is required rather than optional
  because an omitted clock that skips the check reproduces exactly that bug.
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

| file                    | covers                                                                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arithmetic.json`       | line subtotals, magnitude bounds (both sides), totals including charge-order permutation equivalence and an expected rejection                                                                                                                |
| `digests.json`          | domain separation across the ten commerce record domains                                                                                                                                                                                      |
| `malformed.json`        | inputs every implementation must reject                                                                                                                                                                                                       |
| `units.json`            | the CLOSED §9.2 vocabulary — exact membership, dimensions, base factors, comparability, and codes that must be unknown                                                                                                                        |
| `product.json`          | §9.3/§9.4 product identity: equality across scheme, value and ISSUER; scoped-scheme normalization; exact-variant projection and substitution mismatch; the shapes that must be rejected                                                       |
| `catalog.json`          | §10.2 publication: page digests, payload root, snapshot digest, and five pointer-chain cases                                                                                                                                                  |
| `quantity.json`         | §9.1/§9.2 unit and PACK conversion: exact cross-scale comparison, and the refusal when a `case`/`pallet` needs pack evidence                                                                                                                  |
| `relationship.json`     | §10.2 relationship claims: the DID/product discriminant in BOTH directions, and temporal-validity windows                                                                                                                                     |
| `search_candidate.json` **(hand-authored — NOT emitted by `generate.ts`)** | §10.5 discovery result: a candidate as a catalog AppView emits it, plus five refusals with their exact strings                                                                                                                                |
| `schema_evolution.json` | §9.13 forward compatibility: MAJOR/MINOR version admission with the typed refusal, version-string shape, and the unknown-field law — canonicalization INCLUDES them (so a receiver may not strip and re-sign) while validation TOLERATES them |
| `wire_rules_parity.json` **(hand-authored — NOT emitted by `generate.ts`)** | Accept/reject parity between these validators and an INDEPENDENT reimplementation of them. Written for the catalog AppView, which declares no `@dina` dependency and reimplements §9.3 product identity, §9.0 regions, §9.5 items, §9.13 admission, and the §10.3 vocabulary. Parity is on BEHAVIOUR, not error text, because the two implementations differ in structure by design. `pack` internals are out of scope and the file says so: the unit vocabulary and its decimal scales stay protocol-side |
| `held_signed.json`      | §12.7/§16.2 held recovery evidence with a REAL Ed25519 signature over the canonical envelope, where the envelope commits to the record digest. Six cases: genuine; flipped signature; a 64-character signature (half an Ed25519 one); envelope altered after signing; record swapped so the binding breaks while the signature still verifies; and a different signing key. The only family requiring cryptography — the structural `malformed.held_evidence` battery can be passed without verifying anything |
| `nested_unknown.json`   | §9.13 additive fields at EVERY digest-bound depth, on real records of a named kind (`catalog_pointer`, `catalog_snapshot`, `catalog_page`, `relationship_claim`): top level, inside a page, inside an item, inside an item's product ref, inside a claim's subject. The flat `schema_evolution.unknown_fields` family only catches TOP-LEVEL stripping — a schema that is passthrough at the root and strict beneath it passes that one and fails this |

**Known gaps** (§25.1 categories not yet frozen): none. The last four —
substitution/variant mismatch, exact-variant projection, product normalization
beyond equality, and schema-version/unknown-field behaviour — landed in
`product.json` and `schema_evolution.json`.

`units.json` pins MEMBERSHIP, not just shape. The vocabulary being closed is
the rule (owner decision, §27 Q4): an implementation that quietly accepted one
more unit would price orders this one refuses, so a vector that only checked
the units it knows about would miss the interoperability failure entirely.

`quantity.json` pins PACK CONVERSION as a refusal. `case` and `pallet` carry
no base factor, so converting them needs evidence this layer does not hold. An
implementation that guessed "a case is twelve" would agree to a pallet order at
a twelfth of its size and price it accordingly, so the refusal — and its exact
wording — is the contract. The cross-dimension cases are separate on purpose:
they refuse for a different reason (a category error, not missing evidence),
and a vector set carrying only one would let a port collapse them.

`relationship.json` pins the DID/product discriminant in BOTH directions. These
edges compose manufacturer standing, so a port that accepted `manufactured_by`
pointing at another PRODUCT would inherit reputation along an edge that means
nothing. Temporal windows are pinned closed-before-open AND zero-length, since
`<=` rather than `<` is the whole difference, and timestamps must be UTC rather
than merely parseable — an offset canonicalizes differently, so two
implementations would digest the same claim to different bytes.

`catalog.json` pins the refusal STRING for each chain case, not merely the
fact of refusal. Two implementations that both reject a rollback for
differently-worded reasons diverge the first time an operator reads a log.

**`search_candidate.json` is the one file `generate.ts` does not write** — it emits nine of these ten, so regenerating leaves this one untouched by design rather than by omission. Deriving its `expect` strings from our own validator would make both sides of the check ours, which is the exact criticism that produced the interop fixture in the first place; it is pinned instead by `__tests__/search_candidate.test.ts` (the validator accepts the candidate and refuses each invalid case) and by AppView's projection test (the index PRODUCES that candidate). `search_candidate.json` is the first vector written for a CONSUMER rather than
a publisher. §10.5 is what a catalog AppView returns, and the AppView is a
separate deployment that cannot import this package — so the vector is the only
thing keeping its projection and this validator agreeing. The AppView side
asserts its projection produces exactly `candidate`; this side asserts the
validator accepts that object and refuses each `invalid` case with the stated
string. A candidate with no `matched_fields` is refused on purpose: a result
nobody can explain is indistinguishable from a paid placement.

A vector case carries either `expected_*` (a result) or
`expected_error_contains` (a rejection). Both matter: an implementation that
accepts what this one refuses is not conformant either.
