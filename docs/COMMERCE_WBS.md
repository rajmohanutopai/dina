# Commerce Pack — Work Breakdown Structure

Derived from `docs/COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md` (3,340 lines,
§1–§29) and reconciled against the code at commit `4e02c2c8`.

Spec section references are given as `§n`. Every leaf task carries a status, a
dependency, and a Definition of Done that can be checked rather than asserted.

## Status legend

| Mark | Meaning |
|------|---------|
| **DONE** | Built, tested, and mutation-verified where it encodes a rule |
| **PART** | Built but with a recorded defect or gap against the spec |
| **TODO** | Not started |
| **BLOCKED** | Cannot start until a named dependency lands |

## Owner decisions folded in (2026-08-07)

| # | Decision | Effect on this WBS |
|---|----------|--------------------|
| 1 | X-10: Core never synthesizes a replacement quote after restore | Supplier seam owns the re-offer; `quote_voided` when unwired |
| 2 | Broad §24 scope — build the full vertical | All workstreams in scope |
| 3 | `1.x` unfrozen until Phase 0 exit, then freeze at `1.0` | 1.10 becomes a documentation gate, not a major bump |
| 4 | Quotes do not reserve stock (§27 Q6 closed) | `max_uses` is admission capacity; inventory stays supplier authority |
| 5 | Unit vocabulary v1 closed, custom rejected (§27 Q4 closed) | 1.1 confirmed; widening later is additive only |
| 6 | Archive carries operational tables as evidence; restore never adopts counters | **4.2 shrinks** — preflight proves authenticity, not counter trust; capacity always re-derived |

Decision 6 removes a failure mode rather than mitigating one: there is no
"validated counters" path to get wrong, because counters are never trusted.

## How to read this

The spec's own delivery phases (§24) are the top-level ordering, with one
exception: **WS-0** is a cross-cutting remediation stream that did not exist in
the spec. It came out of three dual-review rounds and has to interleave, because
several §24 items are symptoms of it rather than independent work.

A phase exit gate is met only when every task in it is DONE *and* the §24 exit
criterion has been demonstrated end to end. Passing unit tests is not a gate —
§23 says so explicitly: "The commerce pack must not claim production readiness
merely because workflow and plugin repository tests pass."

---

# WS-0 — Structural remediation (cross-cutting)

Not in §24. Added because the review evidence showed the same rule escaping at
new call sites three times in one day. Each escape was individually correct and
individually tested; the shape was what failed.

| ID | Deliverable | Spec | Status | Depends | Definition of Done |
|----|-------------|------|--------|---------|--------------------|
| 0.1 | `QuoteFamily` aggregate; quote ledger unreachable from callers | §9.8 §16.2 | **DONE** | — | Aggregate owns epoch/expiry/capacity/voiding/revision; grep shows no production caller naming ledger mutators |
| 0.2 | `CommerceOrder` aggregate + §12.8 decision/genesis atomicity | §9.9 §15.5 §12.8 | **DONE** | 0.1 | Order owns its lifecycle; uniqueness stays a DB invariant; decision + hold settlement + genesis commit together via an injected seam; genesis failure rolls the acceptance back. 2 mutations caught |
| 0.2b | Extract `AdmissionService` as a separate transactional coordinator | §9.9 | **TODO** | 0.2 | Engines stop owning the transaction. (Raw repository unreachability landed with 0.5.) |
| 0.3 | `StatusChain` aggregate | §9.11 §16.2 | **DONE** | 0.1 | Creation, advancement and fencing all go through the aggregate; raw `CommerceStatusHeadRepository` unreachable from production; genesis fork closed via `admitted_epoch` + `reconciliation_required`; 5 mutations all caught |
| 0.3b | `ReconciliationService` — evidence verified before the chain moves | §12.7 §16.2 | **TODO** | 0.3 | Reconcile coordinated as an application service; re-adoption reconstructs enough state to clear `reconciliation_required` |
| 0.4 | `register(quote, expectedBuyerDid)` — audience binding as a required argument | §9.8 §14.2 | **DONE** | 0.1 | Both inline buyer comparisons deleted; a new registration path cannot compile without naming its expected audience. Mutation: deleting the guard fails 4 tests across both paths |
| 0.5 | Ledger boundary made real: composition root + static guard | §16.2 | **DONE** | 0.2 0.3 | `commerce/runtime.ts` composes once; all five per-repository globals removed; engines depend on aggregate stores; `boundary.test.ts` asserts all four rules over the source |
| 0.6 | Separate authorization from existence at the ingress gate | §11.2 §16.2 | **DONE** | — | `order_reconcile` is entitlement-by-evidence (buyer-bound payload) and reaches the handler with no local reference; `order_status`/`cancel_order` stay entitlement-by-possession. 3 mutations caught |
| 0.7 | Type the wire boundary — structural validation → signature/identity/digest → domain construction | §9.12 | **TODO** | 0.2 0.3 | No `as` cast across the wire boundary; rehydration uses the same checked constructor as ingress; `decisionOutcome` has a default arm |

**Why 0.3 is the critical one:** the restore-fence rule is currently a predicate
each caller must remember to call. It cannot express chain *creation* at all,
because it takes a head epoch and at genesis there is no head. `signGenesis` /
`signGenesisInTx` can therefore re-sign a divergent sequence-0 record after a
restore, forking against the genesis the buyer already holds — and the fence
cannot repair it (unavailable before genesis, blocked afterward by the
same-sequence fork check).

---

# WS-1 — Protocol spine (Phase 0)

Exit (§24): *independent TypeScript fixtures produce byte-identical hashes and
reject the same malformed cases.*

| ID | Deliverable | Spec | Status | Depends | Definition of Done |
|----|-------------|------|--------|---------|--------------------|
| 1.1 | Money, quantity, unit vocabulary — **closed list, custom units rejected** *(owner decision, §27 Q4 closed)* | §9.1 §9.2 | **DONE** | — | Integer minor units; unit + pack conversion; custom units rejected. Widening after freeze is additive only |
| 1.2 | Exact arithmetic contract | §9.1 | **PART** | 1.1 | Rational subtotal, single round-half-even. **Open:** total validity depends on charge ordering — sum all signed adjustments, then bound the final total |
| 1.3 | Canonicalization + 10 domain-separated digests | §9.12 | **DONE** | 1.1 | Byte-exact canonical JSON; domain separation per record type |
| 1.4 | Product reference + exact-variant identity | §9.3 §9.4 | **PART** | 1.3 | **Open:** relationship/object discriminant not enforced in both directions (a `ProductRef` passes where a DID is required) |
| 1.5 | Quote request / signed quote / revision chain | §9.7 §9.8 | **PART** | 1.3 | **Open:** buyer verification binds only the request digest — quote lines, `requested_product` identity and substitution authority unchecked; expired quotes accepted |
| 1.6 | Order proposal, acknowledgement, status, cancellation, reconcile, epoch | §9.9–§9.11 §12.7 §12.8 §16.2 | **PART** | 1.3 | **Open:** restore fence may transition `delivered → disputed` without the dispute deadline |
| 1.7 | Protocol version negotiation | §9.13 | **PART** | 1.3 | **Open:** conversations pin only a major while records hard-code `1.0`; exact-version pin required across the chain |
| 1.8 | Catalog declaration + snapshot wire contract, pointer/tombstone, root + proof verification | §10.2 §10.3 | **TODO** | 1.3 | Canonical snapshot digest/root, pointer sequence, CAS-chain validator, withdrawal record, bounded-page proof |
| 1.9 | Frozen conformance vectors | §25.1 | **PART** | 1.1–1.8 | Have arithmetic, digests, malformed. **Missing:** unit/pack conversion, product normalization, relationship canonicalization + temporal validity, catalog snapshot roots, substitution/variant mismatch, exact-variant projection, schema-version/unknown-field behaviour |
| 1.10 | **Declare `1.x` unfrozen** until Phase 0 exit, then freeze at `1.0` *(owner decision 2026-08-07)* | §9.13 §25.1 | **TODO** | — | Dated pre-freeze note in `packages/protocol/docs/conformance.md` §changelog, not only in implementation-notes; no conformance claim and no third-party targeting until it is lifted |
| 1.11 | `validateIsoUtc` rejects impossible calendar dates (`2026-02-30`) | §9.12 | **TODO** | — | Round-trip check; vector added |

**Phase 0 cannot be declared frozen** while 1.8, 1.9 and 1.10 are open.

---

# WS-2 — Supplier-side Core engines

| ID | Deliverable | Spec | Status | Depends | Definition of Done |
|----|-------------|------|--------|---------|--------------------|
| 2.1 | Commerce stores (order refs, quote/status heads, use counters, receipts, watermarks) | §23 | **DONE** | 1.x | Dual harness (in-memory + SQLCipher) parity |
| 2.2 | Admission engine — §9.9 precedence, atomic holds, settlement, recovery sweeper | §9.9 §15.5 | **PART** | 2.1 | **Open:** request-receipt / projection-digest binding; store-integrity failure frozen as a durable wire rejection; `recoverAdmissions` silently skips a missing receipt and leaks the hold forever |
| 2.3 | Status / cancel / reconcile engines | §9.11 §12.7 §12.8 | **PART** | 2.1 | **Open:** acceptance and genesis are separate transactions (§12.8 race); `finalizePendingCancellation` emits a terminal `cancelled` no conforming buyer can accept and never moves the chain; re-adoption returns `received_accepted` without enough state to resume |
| 2.4 | Epoch service — CAS publication, restore increment, fail-closed signing | §16.2 | **PART** | 2.1 | **Open:** no periodic live-epoch revalidation, so a forgotten pre-restore node signs at its cached epoch indefinitely |
| 2.5 | `loadHeadStatus` bound to the expected order/buyer/supplier | §9.11 | **TODO** | 0.3 | A valid status from another chain is refused even when a corrupted head points at it |
| 2.6 | Restore fence re-derives rather than restates | §9.11 §16.2 | **TODO** | 0.3 | Fence checks transition legality and runs `verifyStatusLines` against the order's `accepted_lines` instead of copying `predecessor.state`/`lines` verbatim |
| 2.7 | Commerce `order_status` capability handler | §11.2 | **TODO** | 0.6 | Subject-authorized read; non-buyer receives a non-disclosing rejection |
| 2.8 | Receipt evidence capture | §9.12 §16.2 | **TODO** | 0.7 | Typed envelope/signature/key evidence captured atomically at D2D send and receive; first-writer-wins cannot discard later authentication evidence |
| 2.9 | Counterparty epoch watermark wiring | §16.2 | **TODO** | 2.4 | Watermark read before accepting an arriving quote/status, raised on acceptance; §25.3 delayed-pre-restore-write case passes |

---

# WS-3 — Platform enablement (Phase 1 blockers)

Nothing in WS-1 or WS-2 is reachable in production until this stream lands.

| ID | Deliverable | Spec | Status | Depends | Definition of Done |
|----|-------------|------|--------|---------|--------------------|
| 3.1 | Provider-kind install support | §11.2a §23 | **DONE** | — | `kind.provider` shipped in `NODE_SUPPORTED_FEATURES`; a provider manifest installs through `beginInstall`, and a manifest also declaring an unshipped kind is still refused. Mutation-verified |
| 3.2 | Provider-ingress bridge | §11.2a | **PART** | 3.1 | Helper exists but has no caller. **DoD:** receive pipeline → binding resolution → `plugin:<install_id>` task → pinned result schema → D2D response as Business DID |
| 3.3 | Listing bound to exact `(install_id, manifest CID, capability)` | §23 FR-P2 | **TODO** | 3.1 | Recorded at publication; a paused/revoked/missing install answers a typed unavailable error, never a stale cache |
| 3.4 | Extension-operation broker | §3.4 | **PART** | 3.1 | Registry + allowlist gate only. **DoD:** durable proposal → permit → execute → verified result, with claim, schema, authority, retry, cancellation, audit and `outcome_unknown` semantics |
| 3.5 | Typed host operations (bounded AppView search, D2D send, publication candidate, connector broker) | §3.4 FR-P9 | **TODO** | 3.4 | Runner never holds Dina authority; every effect routed through a typed Core operation |
| 3.6 | Composition root — production wiring for admission / lifecycle / epoch on both boots | §23 | **TODO** | 0.2 0.3 0.5 3.1 | Server and mobile construct the engines; commerce disabled cleanly when unconfigured |
| 3.7 | Update-rebind coordinator | §9.13 §16.5 | **TODO** | 3.3 | Transactional install-CID + listing rebind; prior-schema drain and lifecycle-continuity authorizations created and released |
| 3.8 | Prior-major lifecycle continuity handlers | §9.13 | **TODO** | 1.7 3.7 | `order_status` / `order_reconcile` / `cancel_order` stay served for prior-major orders until terminal, parsed under the old major's schemas |
| 3.9 | Buyer + Supplier plugin manifests and runner SDK | §8.1 §8.2 §6 | **TODO** | 3.1 3.4 | Two manifests published; runner completes claims with typed candidate results |

---

# WS-4 — Restore, continuity and durability

| ID | Deliverable | Spec | Status | Depends | Definition of Done |
|----|-------------|------|--------|---------|--------------------|
| 4.1 | Restore-epoch fence + pre-backup quote voiding | §16.2 | **DONE** | 2.4 | Epoch monotonicity inside the aggregate; capacity cannot be resurrected through the quote path |
| 4.2 | **Validated commerce archive restore** — operational tables restored as EVIDENCE, counters never adopted *(owner decision 2026-08-07)* | §16.2 | **TODO** | 0.2 0.3 2.4 | Preflight proves the archive is **intact and authentic** (rows, digests, signatures, required-table coverage, cross-table invariants) — it does NOT have to establish that counters are trustworthy. Commerce stays disabled until live PDS epoch CAS succeeds; restore then **always** voids capacity and re-fences chains, re-deriving state rather than trusting it |
| 4.3 | Per-order restore reconciliation ceremony | §16.2 | **TODO** | 4.2 0.3 | Every non-terminal order reconciled against receipts, held evidence and the external system before resuming |
| 4.4 | Genesis-side restore prerequisite | §16.2 | **TODO** | 0.3 | A restored node cannot sign a second, divergent genesis; cancellation cannot decide an order whose post-backup decision was lost |
| 4.5 | Pause / uninstall / update semantics | §16.3 §16.4 §16.5 | **TODO** | 3.7 | Business records survive; authority revocation is immediate and provable |

**4.2 is rated critical.** Commerce tables currently fall through the generic
archive import path; nothing invokes `establishAfterRestore` afterwards. That is
capacity resurrection by the front door, and it makes 4.1 moot in the one
scenario 4.1 exists for.

---

# WS-5 — Catalog and discovery (Phase 2)

Exit (§24): *a buyer with no prior supplier reference discovers and successfully
quotes a live supplier from proof-bound catalog data.*

| ID | Deliverable | Spec | Status | Depends | DoD |
|----|-------------|------|--------|---------|-----|
| 5.1 | Catalog pointer + immutable snapshot publication | §10.2 | **TODO** | 1.8 3.5 | Signed, content-bound, CAS-sequenced |
| 5.2 | Supplier catalog import (CSV first) + pre-publication validation | §12.1 FR-S2 FR-S3 | **TODO** | 1.4 | Identifiers, variants, units and public fields validated before publication |
| 5.3 | Publication leakage gate — secret-shaped-token detector + closed public-field vocabularies | §12.1 §23 | **TODO** | 5.2 | No secret-shaped tokens or private terms reach a public snapshot |
| 5.4 | AppView ingest: repo proof, snapshot digest/root, caps | §10 FR-A1 FR-A2 | **TODO** | 1.8 | Record/page/item/field/refresh caps enforced |
| 5.5 | Exact-variant index without name-based merging | §10 FR-A3 | **TODO** | 5.4 | Identity never merged; relationship projection kept separate |
| 5.6 | Search by identifier, category, text, region + bounded evidence | FR-A4 FR-A5 | **TODO** | 5.5 | Bounded source and freshness evidence returned |
| 5.7 | Withdrawal, expiry, freshness, incremental refresh | §10.4 FR-A6 | **TODO** | 5.4 | Withdrawn/expired snapshots removed or marked predictably |
| 5.8 | Product relationship projection with provenance and disagreement | §10.7 FR-A8 | **TODO** | 5.5 | Source, issuer, time, confidence and disagreement preserved |
| 5.9 | Bounded top-N quote fan-out | §12.3 §20.17 | **TODO** | 3.2 | Fan-out capped; amplification test passes |

---

# WS-6 — Ranking, privacy and disclosure

| ID | Deliverable | Spec | Status | Depends | DoD |
|----|-------------|------|--------|---------|-----|
| 6.1 | Hard filters before scoring | §13.2 | **TODO** | 1.5 | Non-compliant offers removed before any scoring |
| 6.2 | Deterministic score + explanation | §13.3 §13.4 FR-B6 FR-B7 | **TODO** | 6.1 | No LLM in the arithmetic path; missing data explained |
| 6.3 | Context projection per capability and task | §13.5 FR-P3 | **TODO** | 3.5 | Projection per task, never a runner union |
| 6.4 | Hierarchical product evidence composition | §13.6 FR-B13 FR-B14 | **TODO** | 5.8 | Exact-variant evidence never presented as inherited, or vice versa |
| 6.5 | Progressive disclosure + price confidentiality | §14.1 §14.2 | **PART** | 1.5 | Audience binding done. **Open:** the §14.2 surface is only as strong as 0.4 |
| 6.6 | Competitor and probing resistance | §14.3 §20.10 | **TODO** | 6.5 | Probing yields no price or existence disclosure |

---

# WS-7 — User experience

| ID | Deliverable | Spec | Status | Depends | DoD |
|----|-------------|------|--------|---------|-----|
| 7.1 | Commerce Pack install journey | §18.1 | **TODO** | 3.1 | Buyer and Supplier install with separate consent records |
| 7.2 | Buyer settings | §18.2 | **TODO** | 7.1 | Policy, standing grants, regions |
| 7.3 | Supplier settings + inbox | §18.3 §18.6 | **TODO** | 7.1 3.3 | Listing state, pause, revoke |
| 7.4 | Comparison card | §18.4 | **TODO** | 6.2 | Deterministic fallback rendering |
| 7.5 | Approval card bound to one canonical order payload | §18.5 §15.2 FR-P5 | **TODO** | 0.2 | Approval and execution bind the same payload; bait-and-switch test passes |
| 7.6 | Supplier-side approval payload | §15.2b | **TODO** | 7.3 | Distinct from buyer payload |
| 7.7 | Reconciliation UX for `outcome_unknown` | §12.7 | **TODO** | 2.3 4.3 | Ambiguity surfaced honestly, never blind duplication |
| 7.8 | One command/projection contract shared by mobile and web | FR-P10 | **TODO** | 3.6 | Both clients consume identical read models |

---

# WS-8 — Managed runtime (Phase 3)

| ID | Deliverable | Spec | Status | DoD |
|----|-------------|------|--------|-----|
| 8.1 | Multi-tenant control plane + tenant cells | §17.1 §17.3 | **TODO** | Tenant isolation provable |
| 8.2 | Hosted runner binding per install | §17.4 | **TODO** | Per-install binding, no shared authority |
| 8.3 | Encrypted managed catalog store + export | §17.2 | **TODO** | Tenant-owned, exportable |
| 8.4 | Staff authority + acting-for chain | §7.2 §7.3 | **TODO** | Authority never inferred from a contact label |
| 8.5 | Metering, quotas, backup, hot/cold lifecycle | §17.5 | **TODO** | Owner phone may sleep while read/quote work continues |

---

# WS-9 — External systems (Phase 4)

| ID | Deliverable | Spec | Status | DoD |
|----|-------------|------|--------|-----|
| 9.1 | Spreadsheet + generic REST connectors | §24 | **TODO** | Connector replacement does not change capability semantics |
| 9.2 | One real ERP/inventory connector | §24 | **TODO** | Live round trip |
| 9.3 | Credential broker + rotation UX | §6.5 §8.3 FR-P4 | **TODO** | No secrets in manifest, config or task payload |
| 9.4 | End-to-end idempotency evidence at the order boundary | §15.5 | **TODO** | An accepted order appears exactly once externally, or the ambiguity is reconciled honestly |
| 9.5 | Fulfilment updates + reconciliation | §12.7 | **TODO** | External state reconciled to the chain |

---

# WS-10 — Trust and interoperability (Phase 5)

| ID | Deliverable | Spec | Status |
|----|-------------|------|--------|
| 10.1 | Commerce outcome prompts + Ranked Reviews integration | §14.4 | **TODO** |
| 10.2 | Reviewer-confirmed evidence scope + dimension UX | §14.4 FR-A9 | **TODO** |
| 10.3 | Plural relationship resolvers + disagreement display | §10.7 FR-A8 | **TODO** |
| 10.4 | Additional AppViews + cross-index evidence | §10.6 | **TODO** |
| 10.5 | Third-party pack via the conformance kit | §25.1 | **TODO** |
| 10.6 | Optional standard-capability promotion | §11.3 | **TODO** |

---

# WS-11 — Conformance, testing and acceptance

| ID | Deliverable | Spec | Status | DoD |
|----|-------------|------|--------|-----|
| 11.1 | Protocol vectors complete | §25.1 | **PART** | See 1.9 |
| 11.2 | Plugin security tests | §25.2 | **PART** | Substrate covered; commerce lane not |
| 11.3 | Commerce workflow tests | §25.3 | **PART** | Engine-level covered; no end-to-end journey |
| 11.4 | AppView tests | §25.4 | **TODO** | Blocked on WS-5 |
| 11.5 | Managed-runtime tests | §25.5 | **TODO** | Blocked on WS-8 |
| 11.6 | **Manual acceptance journey — 15 steps** | §25.6 | **TODO** | Two real Dinas: install → catalog → publish → discover → quote → approve → accept → **restart both** → matching receipts → revoke and prove no further work |

§25.6 is the production claim. Nothing below it substitutes.

---

# Critical path to a demonstrable Phase 1

```
0.2 CommerceOrder ─┐
0.3 StatusChain ───┼─→ 0.5 boundary ─→ 3.6 composition root ─┐
0.4 audience ──────┘                                          │
                                                              ├─→ 11.6 acceptance
3.1 provider install ─→ 3.2 ingress ─→ 3.3 listing binding ───┤
                                    └─→ 3.9 manifests + SDK ──┘
                                                              │
4.2 validated restore ─→ 4.3 reconciliation ─→ 4.4 genesis ───┘
```

Everything else is parallelisable. The three chains above are serial and none of
them can be skipped for a credible §25.6 run — step 13 is "restart both sides",
which is precisely what WS-4 governs.

## Sequencing note

WS-0 before WS-3, not after. Three of the six round-2 review findings were
round-1 fixes leaking at a second call site, and the round-3 finding was the
same rule leaking at a third. Wiring more call sites onto a substrate whose
rules live in call sites multiplies that failure mode rather than containing it.

## Honest scale

WS-1 and WS-2 are roughly a third of the vertical and carry the best test
coverage in the codebase, which is exactly why the green suite reads more
reassuring than the state warrants. WS-3 through WS-5 are the bulk of the
remaining engineering; WS-8 through WS-10 are post-pilot.
