# Commerce & procurement — consolidated test plan

What is covered, by which tests, and what is not. Built by reading the suites
and the spec rather than by recalling what was written, so the gaps at the end
are measured rather than remembered.

Counts at the time of writing: **core 8,005 · core-server 2,842 · mobile 3,318 ·
commerce-protocol 354 · protocol 724**, typecheck clean across the workspace.

---

## 1. How to run it

```bash
# One package at a time, foreground. Never in parallel — the full matrix
# in one process has OOM'd this machine before.
cd packages/commerce-protocol && DINA_RATE_LIMIT=100000 npx jest --runInBand
cd packages/core             && DINA_RATE_LIMIT=100000 npx jest --runInBand
cd apps/home-node-lite/core-server && DINA_RATE_LIMIT=100000 npx jest --runInBand
cd apps/mobile               && DINA_RATE_LIMIT=100000 npx jest --runInBand

npm run typecheck   # from the repo root
```

`DINA_RATE_LIMIT` matters: the default is 60/min and the ingress suites exceed
it.

---

## 2. The retailer/manufacturer journeys

Sancho is the retailer (buyer), ChairMaker the manufacturer (supplier) —
UTOPAI naming, used consistently across every scenario file. 47 journey cases
in five files, all driving the real engines rather than doubles.

### `procurement_scenario.test.ts` — the trade itself, both storage backends

Runs twice, in-memory and SQLite, so a rule that depends on storage semantics
cannot pass in one and fail in the other.

| Scenario | What it pins |
|---|---|
| the whole journey: quote, order, accept, fulfil, deliver | the happy path exists end to end |
| survives a restart | both sides still agree after a cold start |
| refuses a second order once quote capacity is spent | §9.9 capacity is not a suggestion |
| the chain is fenced before it moves again after a restore | §16.2 — no silent resumption |
| ChairMaker loses the order entirely and recovers it from Sancho | §12.7 re-adoption, on the REAL verifier |
| refuses a forged acknowledgement instead of re-adopting | three forgeries: wrong key, wrong audience, unbound body |
| an unanswered submission reconciles instead of being ordered twice | §12.7 — the duplicate-order case |
| reconcile answers for an order never received | `never_received` is reachable and honest |
| answerable across a mid-order plugin update, then closes the lane | §9.13 continuity |

### `procurement_lane_scenario.test.ts` — the plugin lane between them

Sixteen cases covering the owner-approval card, decline, replay, capacity
refusal, runner silence (`outcome_unknown`), schema-rejecting answers, a
stranger's order, and the uninstall interlock (refused while an order is open,
refused after delivery because the dispute window is an obligation, allowed
once nothing is open, and the runner fenced afterwards).

### `buyer_round_trip_journey.test.ts` — Sancho's side of the wire

Settlement on accept/reject, parking when no answer arrives, re-asking,
staying parked when ChairMaker denies an order it signed for, refusing a
relayed acknowledgement for someone else's order, catching up a status chain
from genesis, idempotent re-application, and refusing a chain tampered with in
flight.

### `disaster_recovery_journey.test.ts` — loss and return

One order carried through loss and recovery; a status from the abandoned
generation refused; an archive that cannot describe its own orders refused
whole; a re-adopted order frozen until the ceremony runs.

### `external_fulfilment_journey.test.ts` — the ERP edge

The full arc with a refusal at every step not yet earned, ERP fulfilment
reconciled into the chain, a late webhook refused, a failing credential shown
to the operator even though the settings row calls it fine, a connector that
cannot be widened without asking again (§6.5), and a sweep that covers every
open order rather than the ones a caller names.

---

## 3. Threat model (§20) coverage

Measured by behaviour, not by whether a test mentions a section number.

| Threat | Where |
|---|---|
| §20.1 catalog poisoning | attribute bounds, prompt-text dump refusal (`catalog.test.ts`) |
| §20.2 product identity collision | issuer-binding on identifiers, GTIN rules |
| §20.5 quote replay | `quote_consumed`, `max_uses`, `duplicate_use` holds |
| §20.6 duplicate purchase | idempotency keys, `never_received` as the only resubmission authority |
| §20.7 approval bait-and-switch | `approved_scope_hash`, re-consent on widening |
| §20.8 cross-tenant access | `not_your_object` in the managed blob store |
| §20.9 location leakage | region/postal projection rules |
| §20.11 paid ranking | deterministic local ranking |
| §20.13 connector compromise | credential broker, address re-check after DNS |
| §20.15 malicious AppView | snapshot evidence on results |
| §20.16 feed SSRF / exhaustion | redirect refusal with a body, private-address block, page caps |
| §20.18 buyer abuse | probing ledger, budget spent before dispatch |
| §20.19 arithmetic exploitation | exact rational subtotal, single round-half-even, closed unit vocabulary |
| §20.20 runner exfiltration | egress gates, PII scrub, `data_scope` caps |

**§20.3 (reputation whitewashing by variant churn) and §20.14 (commercial spam
and Sybil suppliers) have no Core-side enforcement test, and that is a scoping
statement rather than a gap being hidden.** Both name controls that live in the
AppView and PeerLens layers — quotas, retrieval diversity, reputation
inheritance and presentation, identity age. What Core owns for them is the
signed primitive those controls read: `ProductRelationshipClaim` lineage
assertions (§9.4) and historical catalog snapshots (§10.2), both validated and
vector-frozen. The enforcement belongs to §25.4's AppView tests.

---

## 4. Contract and conformance

- **12 frozen vectors** in `packages/commerce-protocol/conformance/vectors/`:
  arithmetic, catalog (pages, snapshot, genesis pointer, chain cases), digests,
  malformed inputs, product, quantity, relationship, schema evolution, search
  candidates, units.
- **Schema evolution** pins §9.13's forward-compatibility law: same-major
  higher-minor parses, higher-major is refused, and an unknown field is both
  tolerated and covered by the record's digest.
- **Boundary test** (`commerce/boundary.test.ts`) enforces two structural
  rules: no commerce source parses a stored record outside the rehydration
  module (plus `archive_preflight.ts`, which re-derives every receipt digest),
  and every exported symbol is either wired into a composition root or listed
  as not-yet-wired with a reason. That second rule caught a stale annotation
  during this run.

---

## 5. Composition

Two source-level tests exist because behavioural tests structurally cannot
catch what they check:

- **`workflow_service_composition.test.ts`** — every `new WorkflowService({…})`
  in the server boot supplies a `pluginCompletionHandler`. A behavioural test
  drives one instance and cannot see an unwired second one, which is exactly
  how the degraded-mode window survived.
- **the boundary test's wired/not-wired list** — a row goes green when an
  engine is built, not when something calls it. The dominant defect class in
  this subsystem has been correct, well-tested code that nothing invoked.

---

## 6. Known gaps, stated plainly

1. **Continuity claims are not bound to a specific non-terminal order.** The
   prior major is checked; the order is not, because the envelope names it only
   inside `params`. Needs a wire field.
2. ~~Force-restore clears a commerce table the archive did not supply.~~
   **Fixed**, with a caveat about the evidence. Force now clears only a table
   the archive actually SUPPLIES: an empty list is a statement ("this table had
   no rows") and clears, while an absent key means the archive predates the
   table and is left alone. The test added alongside it guards the reachable
   half — it passes under the old behaviour too, which I verified rather than
   assumed. The absent-key branch has no end-to-end test because this build
   cannot produce an archive with a missing key: `dumpTable` returns `[]` for a
   table it cannot read, and the exporter writes a key for every allowlisted
   table. The only producer is an older build.
3. **ARCH-3's three seam layers are an ordering, not an abstraction.**
   Structural validation, then signature/identity, then domain construction
   happens at each seam and is enforced by the boundary test and by the draft
   annotations — but there is no shared type that makes skipping a layer
   impossible. Eight `as`-casts remain outside the record builders; each is a
   narrowing after a validator has run, which is the safe form, but they have
   not been audited one by one.
4. **No live two-node commerce run over MsgBox.** Every cross-Dina journey here
   is in-process. The transport is exercised by the existing services harness,
   not by a commerce order.

---

## 7. Mutation discipline

Green is not evidence on its own. Every gate added during this work was
neutered and the suite re-run, and three of those checks caught something:

- A `toContain` assertion passed against a field renamed to
  `MUTATED_pluginCompletionHandlerXX`; matched as a property key instead.
- Two mutations of the fence chain-walk produced `Tests: 0 total`, which is a
  crash and not a survival; the third neutered only the comparison and failed
  exactly the cases that assert disagreement.
- A camelCase key injected into a wire-record builder compiled cleanly after
  the first ARCH-3 fix, which is how that fix was found to be checking nothing.
