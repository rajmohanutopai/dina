# Shelf-space negotiation — test plan

Spec: `docs/SHELF_SPACE_NEGOTIATION.md` (draft 6). Implementation notes:
`implementation-notes.html#shelf`.

Every scenario has an ID and names the test that covers it. **Status:**
`covered` (a test exists and passes), `gap` (no test yet; it must be
added), `n/a` (out of scope, with the reason).

Run tests with the memory-safe runner, never with a bare `jest`:

```
node scripts/test/safe_test.mjs --only core -- __tests__/commerce/term
node scripts/test/safe_test.mjs --only commerce-protocol -- __tests__/term
```

## How the tests are built

- **Protocol** units run on pure functions with golden digests.
- **Core scenarios** run on the Fleet harness
  (`packages/core/__tests__/commerce/term/term_harness.ts`). Every node is a
  real `TermEngine` on its own encrypted SQLite file. Documents move only
  through both sides' gates (`gateAllows` outbound, then inbound, then
  `ingest`). The clock is the fleet's, so expiries and resends are exact.
  `unreachable` drops sends, to stand for a sleeping phone or a lost receipt.
  `restart()` closes a node and reopens it on the same file, to stand for an
  app relaunch.
- **Routes** run through the real Core router with the owner capability,
  presence verifier and workflow service.
- **Phone** tests render the screens with the owner client mocked, or run
  the install service over the in-process owner dispatcher against real
  Core routes.
- **AppView** units run the validator, handler and xRPC queries over a fake
  database.

## 1. Protocol (`packages/commerce-protocol/__tests__/term.test.ts`)

| ID | Scenario | Status |
|---|---|---|
| P-01 | Each term digest domain separates; golden vectors frozen | covered |
| P-02 | The term table is Core-owned and sorted; both terms favour the buyer when lower | covered |
| P-03 | Month addition anchors on the start, clamps at month end, never drifts | covered |
| P-04 | Weeks are seven exact days; negative or fractional counts refused | covered |
| P-05 | A listing's digest covers it; unknown fields refused (closed vocabulary) | covered |
| P-06 | A request names a listing in the seller's own repo, asks only tag, currency and dates | covered |
| P-07 | Deadlines run at most seven days | covered |
| P-08 | Offer chains: revision 1 starts, later ones name their predecessor; immutables kept | covered |
| P-09 | Fee and share not both zero; rent-only means the vendor holds the takings | covered |
| P-10 | Counters name table terms only, and the head and the same parties | covered |
| P-11 | Receipt outcomes: stored, held, refused; only held is not final | covered |
| P-12 | A proposal equals its offer field by field | covered |
| P-13 | A renewal starts where the renewed agreement ends; same parties and resource | covered |
| P-14 | Termination: immediate in the trial; after it, at least the exit notice; never before issue | covered |
| P-15 | Schedule: trial, anchored periods, last period cut at end and prorated, half-even ties, weekly | covered |
| P-16 | Settlement notes match a scheduled period exactly; wrong, missing or drifted fees refused | covered |
| P-17 | A revenue-share agreement refuses a note that carries a fee | covered |
| P-18 | The fold: who owes whom for each cash handler; periods add signed; overflow refused | covered |
| P-19 | Old-node refusal: a push of a kind this build lacks is refused as unreadable at once, open money line or closed — never spooled (`term_compat`) | covered |
| P-20 | Version and currency mismatch within a chain refused (`term_mismatch`); a whole chain at an unsupported major refused on arrival, and no negotiation starts from such a listing (`term_review_fixes`) | covered |

## 2. Core transport and gate

| ID | Scenario | Status | Test |
|---|---|---|---|
| T-01 | Egress: a brand sends a request only to the store that published the listing | covered | `term_d2d_gates` |
| T-02 | Ingress: an offer binds only from the store the request went to | covered | `term_d2d_gates` |
| T-03 | A blocked destination never reaches the stranger waiver (egress) | covered | `term_d2d_gates` |
| T-04 | A blocked brand is refused: by the receive pipeline, and by the term gate itself whatever listing it names; a store sends a blocked brand nothing | covered | `term_access_packs`, `term_review_fixes` |
| T-05 | Outbound, a node sends only what it stored for that peer | covered | `term_scenarios` |
| T-06 | A request naming a listing this store does not publish is refused; an offer for nothing asked is refused | covered | `term_scenarios` |
| T-07 | A resend of a stored document gets the same answer, never a second store | covered | `term_scenarios` |
| T-08 | Resends run every 6 h until a final receipt; held resends daily | covered (in part) | `term_scenarios` |
| T-09 | Resends stop at the document's deadline; the owner is told once | covered | `term_scenarios` |
| T-10 | A held document becomes stored when the thing it needs arrives, with lost receipts and a restart in between | covered | `term_restarts` |
| T-11 | A held document becomes refused after 30 days, with lost receipts and a restart; the sender's 33-day horizon outlasts the hold; after `held`, resends stay daily even when later receipts are lost | covered | `term_restarts`, `term_review_fixes` |
| T-12 | An unanswered request across a restart, through its `respond_by`; given up once, the owner told once | covered | `term_restarts` |
| T-13 | A settlement arriving before the decision is held, then lands | covered | `term_scenarios` |
| T-14 | A termination arriving before the decision, with a restart in between | covered | `term_restarts` |
| T-15 | A store offline for more than a day: the request is resent until it lands | covered | `term_scenarios` |
| T-16 | A proposal sent before `valid_until`, processed after the store's phone wakes, still lands | covered | `term_scenarios` |
| T-17 | A termination dated more than 3 days before it arrived, or in the future, is refused; both sides then keep the deal to its end | covered | `term_review_fixes` |
| T-18 | Sends, receipts and cards run only after their transaction commits, never after a rollback | covered | `term_review_fixes` |
| T-19 | An owner's yes the inbox committed and the engine never heard is acted on by the next sweep; a no likewise | covered | `term_second_review` |
| T-20 | A corrupted resend never changes the answer its digest already has | covered | `term_second_review` |
| T-21 | A send that fails outright retries within a minute; a near deadline gets its first resend before it | covered | `term_second_review` |
| T-22 | A refused termination releases the cut notes held for it at once, on every refusal path (first arrival, re-run, hold expiry); residual (accepted by the owner 2026-10-14): a note arriving after the refusal waits 30 days | covered | `term_second_review` |
| T-23 | Only a first failed send is pulled forward; repeated failures keep the normal schedule | covered | `term_second_review` |
| G-14 | A trial termination arriving after the trial ended is refused; both keep the deal | covered | `term_second_review` |
| G-15 | A revision delivered after the brand's card supersedes it; the newer offer gets a card that binds | covered | `term_second_review` |
| G-16 | A stranger yes whose request is then refused reads as refused | covered | `term_second_review` |
| G-17 | Ranking never compares costs in different periods | covered | `term_second_review` |
| K-08 | The sweeper withdraws listings nothing backs (renting off, slot gone, half uninstalled or device-revoked) and retries directory removals; a PAUSED half keeps its listings; no publish, withdrawal, removal, policy save or sweep interleaves with another (one lock); a publish is checked against the policy standing when it writes; an ambiguous record-write failure is cleaned up by the sweeper | covered | `term_second_review`, `commerce_terms` (route-level, slow directory), `commerce_install_reference` |
| M-16 | Empty sales field refused; weekly slots on the terms form; listings keep Withdraw with the store's half off; binding cards stay approvable when the deciding node cannot check presence, with a warning asked of that node (none while unknown or with a passphrase); the may-still-show card offers Remove; a refused follow-up worded as refused | covered | `screens/shelf_space.render`, `components/approval_inbox`, `hooks/useServiceInbox` |
| M-17 | The phone boots Brain with its own client: owner-only cards reach it redacted; the Core-side runtime keeps the owner-side client, as on the server | covered | `services/boot_service`, `services/bootstrap` |

## 3. Seller policy and arithmetic

| ID | Scenario | Status | Test |
|---|---|---|---|
| S-01 | The juice example: two juice brands raise every floor by 30% | covered | `term_scenarios`, `term_fleet_story` |
| S-02 | No first-offer cap: asking below a raised floor is lifted to the automatic limit, and the first offer never asks the owner | covered | `term_policy` |
| S-03 | The cap: with four placed, a fifth is refused and told nothing | covered | `term_scenarios` |
| S-04 | A snack brand is untouched by the juice rule | covered | `term_scenarios`, `term_fleet_story` |
| S-05 | A manual holding naming the slot blocks it; one naming another slot does not | covered | `term_scenarios` |
| S-06 | Floor card: a yes authorises the asked value for the next counter | covered | `term_scenarios` |
| S-07 | One open floor card per negotiation | covered | `term_fleet_story` |
| S-08 | A rule tightened after the offer: acceptance re-checks and says no longer available | covered | `term_scenarios` |
| S-09 | Policy validation: every refusal reason of `validateTermPolicy` | covered | `term_policy` |
| S-10 | `applyHoldingPremium` and `clampTerm` units: rounding goes the seller's way; hard vs automatic floors | covered | `term_policy` |

## 4. Access and strangers

| ID | Scenario | Status | Test |
|---|---|---|---|
| A-01 | `contacts_or_card`: a stranger is held, the owner is asked once, a yes lets the request run | covered | `term_scenarios` |
| A-02 | A no refuses the request and the brand learns it | covered | `term_scenarios` |
| A-03 | A contact skips the card even under `contacts_or_card` | covered | `term_scenarios` |
| A-04 | A stranger the owner never answers is refused when the request expires | covered | `term_scenarios` |
| A-05 | `anyone`: a stranger gets a first offer with no card, end to end, and a decline closes it | covered | `term_access_packs` |
| A-06 | A request spends probing budget; with none left it is refused | covered | `term_scenarios` |

## 5. Agreements

| ID | Scenario | Status | Test |
|---|---|---|---|
| G-01 | A full deal: bargain, both approve, settle | covered | `term_flow` |
| G-02 | Two brands race for the last place: the first acceptance counts | covered | `term_scenarios` |
| G-03 | A future-start deal counts and occupies its slot | covered | `term_scenarios` |
| G-04 | Renewal at the cap counts as one holding | covered | `term_scenarios` |
| G-05 | The store's card lapses after three days; the brand gets a rejection | covered | `term_scenarios` |
| G-06 | A proposal that changes a term is rejected automatically, with no detail | covered | `term_scenarios` |
| G-07 | The brand's proposal card lapses, by sweep or workflow expiry, or a yes arrives after the offer expired: nothing is sent | covered | `term_access_packs`, `term_review_fixes` |
| G-08 | Trial: either side ends at once; the trial is charged pro rata | covered | `term_scenarios` |
| G-09 | After the trial, termination needs the exit notice | covered | `term_scenarios` |
| G-10 | Notice, end, and settling the final period after the end; a note for a period the end removed counts nothing, an uncut note for a cut period is refused and leaves the sender's books | covered | `term_agreement_end`, `term_review_fixes` |
| G-11 | Both sides fold the same statement; accepting never marks paid | covered | `term_scenarios` |
| G-12 | The fleet story: two juice deals, then a third juice brand and a snack brand at once, both approved on both sides | covered | `term_fleet_story` |
| G-13 | A disputed settlement stays out of the statement; a correction replaces it | covered | `term_agreement_end` |

## 6. Packs, install and updates

| ID | Scenario | Status | Test |
|---|---|---|---|
| K-01 | Both Slot manifests pass the shared validator and need only shipped features | covered | `slot_pack_manifests` |
| K-02 | No money field in either manifest | covered | `slot_pack_manifests` |
| K-03 | Each half installs through the first-party door: begin, bind, consent; idempotent | covered | `commerce_install_reference` |
| K-06 | A Slot-only node opens no money store | covered | `slot_pack_manifests`, `commerce_install_reference` |
| K-07 | Moving to a new machine carries every term table, on both sides | covered | `term_archive` |
| K-04 | A paused or absent seller half refuses requests and proposals, and a yes given while paused rejects; agreement follow-ups still land | covered | `term_access_packs`, `term_review_fixes` |
| K-05 | An app update within a schema major keeps negotiations and agreements working; another major is refused (with a passing control) | covered | `term_compat` |

## 7. Routes, cards and Brain

| ID | Scenario | Status | Test |
|---|---|---|---|
| R-01 | Every term route is owner-only | covered | `commerce_terms` |
| R-02 | Policy, publish, withdraw and terminate need presence | covered | `commerce_terms` |
| R-03 | Publishing writes the public record first | covered | `commerce_terms` |
| R-04 | No route proposes or decides a term agreement directly | covered | `commerce_terms` |
| R-05 | The two agreement cards need presence, and on a node that cannot establish it they fall open with a warning on the phone's card (owner decision 2026-10-14); the stranger card needs none | covered | `commerce_terms`, `approval_inbox` |
| R-06 | Brain reads card kind and negotiation, never a number, and cannot decide | covered | `commerce_terms` |
| R-08 | A yes the engine refuses closes the workflow task as failed, in words ("no longer available"), never as decided | covered | `commerce_terms_projection` |
| R-09 | The Slot Pack's capabilities are served by Core: left out of Brain's tool list, refused by every invocation | covered | `commerce_install_reference` |
| R-10 | On the phone, Brain's workflow reads and decisions go through a client stamped `brain`: owner-only cards reach it redacted and it cannot decide them; the owner's inbox keeps its own client | covered | `commerce_terms_projection` |
| R-07 | Brain projections on every surface: task list, task detail, events feed, notifications, authz on every term route, and the two transports Brain's client uses | covered (server; the phone in R-10) | `commerce_terms_projection` |

## 8. AppView (`appview/tests/unit/commerce_term_listing.test.ts`)

| ID | Scenario | Status |
|---|---|---|
| V-01 | Collection subscribed; listing admitted as the PDS stores it | covered |
| V-02 | A listing edited after its digest is refused | covered |
| V-03 | Indexed only from the seller's own repo under its own id | covered |
| V-04 | Nothing in the row is money; a refused record logs no content | covered |
| V-05 | Search filters and order; both endpoints routed | covered |
| V-07 | The listing region is closed: only scheme and value, no custom scheme, each value in its code's shape | covered (protocol `term.test`, shared by AppView's validator) |
| V-06 | Postgres: the real handler and queries on migration 0030 — indexed and read back whole (still passing the protocol validator), newer revision wins and an older replay does not, deletion, refused records write nothing, every search filter in SQL that runs, no price column (`tests/integration/commerce_term_listing_ingest.test.ts`); the schema test lists the table | covered (run on a local `dina_trust`) |

## 9. Phone (`apps/mobile`)

| ID | Scenario | Status | Test |
|---|---|---|---|
| M-01 | Terms form ↔ policy (rupees and percentages ↔ minor units and basis points); typos caught by field | covered | `services/shelf_space` |
| M-02 | Saving terms needs presence | covered | `screens/shelf_space.render` |
| M-03 | Publishing a listing sends no money | covered | `screens/shelf_space.render` |
| M-04 | Finding slots and opening a request | covered | `screens/shelf_space.render` |
| M-05 | The deep link takes a listing address and nothing else | covered | `screens/shelf_space.render`, `services/shelf_space` |
| M-06 | The brand's request carries its limits | covered | `screens/shelf_space.render` |
| M-07 | Agreement screen: settle, accept or dispute, end with presence | covered | `screens/shelf_space.render` |
| M-08 | The five term cards in the inbox, in plain words; a no is a cancel | covered | `hooks/useServiceInbox`, `components/approval_inbox` |
| M-09 | Turning each Slot half on, behind presence | covered | `screens/shelf_space.render`, `services/commerce_install` |
| M-10 | Holdings made outside Dina: recorded on Terms and rules, with a slot or none; bad dates caught first | covered | `services/shelf_space`, `screens/shelf_space.render` |
| M-11 | "Sent" → "waiting" → "delivered" / "refused" / "not delivered" for the proposal and the decision, on the request and agreement rows | covered | `term_fleet_story` (engine), `screens/shelf_space.render` (phone) |
| M-12 | The agreement cards show everything the yes binds: takings, trial, notice, stock duties; never clipped | covered | `hooks/useServiceInbox`, `components/approval_inbox` |
| M-13 | A withdrawn listing whose public record still stands says so and offers a retry, across restarts; renting off hides listing | covered | `screens/shelf_space.render`, route `commerce_terms` |
| M-14 | After a dispute the takings holder sends corrected figures that replace the note; the other side waits | covered | `screens/shelf_space.render` |
| M-15 | A brand's limits are per month or per week; a store's other period is compared after conversion, rounded the brand's way | covered | `term_periods` (engine), `screens/shelf_space.render`, `services/shelf_space` |

## 10. Whole-system

| ID | Scenario | Status |
|---|---|---|
| W-01 | The full green run: every workspace through `safe_test.mjs` | run before every hand-off |
| W-02 | Store and brand on the live test fleet (`scripts/scenarios/shelf_live.ts`): own did:plc each on the test PDS, security mode, met only through the test MsgBox — Slot Pack on, terms saved, listing on the PDS with none of the store's numbers, found through the test AppView's search, stranger admitted, rent bargained 250000 → 190000 (above the 180000 automatic limit), both owners approve with presence, the same agreement on both sides with both answers delivered, a period settled and accepted, statements equal (vendor owes 330000), listing withdrawn and gone from the PDS | covered 2026-10-14: all 21 steps with `--appview`, the listing found through the test AppView after its deploy |
