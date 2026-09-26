# Negotiation — development plan

**Status:** BUILT (2026-09-25). Items 1–9; item 10 deferred. See §9 for what was built and tested.
**Source:** the gap list from the Jiffy integration agent (ten items), checked against the code.
**Builds on:** `TRADE_FIRST_STRATEGY.md` §3 (private tender, price secrecy), `COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md` §9 (quote chain, revisions, counterproposals), `JIFFY_MERCHANT_INTEGRATION_PLAN.md` §8 (reference runner, `from_quote`).

A buyer asks several suppliers for a price, asks the better ones to come down, and awards the order to one. Each supplier answers within limits its owner set, and never below them. The owner still approves the order.

---

## 1. What already exists

Checked in code before planning, so the build adds only what is missing.

| Piece | Where | State |
|---|---|---|
| Quote revisions on the wire | `quote.ts`: `quote_revision`, `previous_quote_digest`, `verifyQuoteRevisionExtends` | Built. The buyer checks every revision against the chain it holds (`buyer_quotes.ts`). |
| Supplier registers revision N+1 | `admission.ts` `registerSignedQuoteInTx` → `QuoteFamily.advance` | Built, never driven by anything. |
| Substitution | `acceptable_substitutions` on request lines; `offered_product` + `substitution_evidence` on quote lines; `verifyQuoteLinesAnswerRequest` | Built in the protocol. Core's issuance always offers the requested product. |
| Order-time counterproposal | `admission.ts:855` sends `{kind:'counterproposal', replacement_quote}` | Supplier side built. The buyer records `received_countered` and drops the replacement quote. |
| Tender and comparison | `tender.ts`: `createTender`, `compareTender` (total, freight, advisory financing benefit, last-paid) | Built. Lists offers, never ranks, no award. |
| Probing budget | `provider_ingress.ts` `SPENDS_PROBING_BUDGET` | Built for `request_quote`. |
| Core-answered capabilities | `provider_ingress.ts` `ANSWERED_BY_CORE` | Built for `order_reconcile`. |

## 2. The ten items and the decision on each

| # | Item | Decision |
|---|---|---|
| 1 | Quote "the same item" across suppliers | A shared GTIN already works. Add **requirement lines** for goods with no shared code (§4.6). |
| 2 | Buyer counter-offer | New signed document `CounterOffer` and capability `counter_offer` (§4.2). |
| 3 | Revised quotes | The answer to a counter-offer is revision N+1 of the held quote, through the existing chain rules (§4.3). |
| 4 | Supplier pricing policy | `SupplierSettings.negotiation`, enforced by Core before signing (§4.1). |
| 5 | Counter logic in the reference runner | Move halfway to the buyer's target each round; Core clamps to the policy (§4.3). |
| 6 | Buyer negotiation loop | A Core sweeper over tenders that carry a policy; fixed rules, no model (§4.5). |
| 7 | Buyer keeps supplier counterproposals | The replacement quote goes through the quote lane into the buyer store (§4.4). |
| 8 | Tender award | Rank, award, build the order for the owner to approve (§4.5). |
| 9 | "Not awarded" notice | Capability `quote_outcome`, answered by Core on the supplier (§4.5). |
| 10 | Buyer approval within a spending limit | **Deferred.** It bypasses owner presence and needs its own design. The loop ends at a held order the owner approves, as today. |

## 3. Rules that hold throughout

1. **The supplier's floor never leaves Core as a number.** The runner proposes prices; Core checks each line against the owner's policy before it signs. A runner bug or a hostile runner cannot sell below the floor. No refusal names a floor. The lowest price Core signs does reveal a bound, round by round, as any price does; rule 2 limits how many rounds a buyer gets.
2. **Counter-offers cannot probe the floor.** A counter spends probing budget like a quote request, and the policy caps counters per buyer per day across all quotes, not only rounds per quote.
3. **Counter-offers bind nobody.** Neither side commits by countering. Only an order commits, and the order still needs the owner (item 10 is deferred).
4. **Price secrecy (TRADE_FIRST §3).** A not-awarded notice says only that. It never names the winner or the winning price. A buyer's target is its own ask; the loop never forwards one supplier's price to another.
5. **One chain per quote.** Every price change is a revision of the held quote, checked by both sides with the existing chain rules. No second family is minted for a haggle.
6. **Silence first.** The buyer's loop runs without asking. The owner hears once, when the tender is ready to award. A supplier owner hears only when a buyer asks below the automatic limit.

## 4. Design

### 4.1 Supplier pricing policy (item 4)

`SupplierSettings.negotiation` (optional; absent means counters are declined). Settings are stored as the owner sends them, in camelCase:

```
negotiation: {
  enabled: boolean,
  maxRounds: number,                  // per quote, 1..10
  windowSeconds: number,              // from the quote's first issue, 60..86400
  maxCountersPerBuyerPerDay: number,  // across all quotes, 1..200
  defaultMaxDiscountBps: number,      // off the first quoted unit price, 0..5000
  items?: [{
    product: ProductRef,
    floorMinorUnits: string,          // hard floor: never below, ever
    autoFloorMinorUnits?: string,     // lowest Core signs alone; below it (to the floor) needs the owner
  }]
}
```

For a line, Core computes two numbers from the revision-1 unit price `p`:

- hard floor = the item's `floorMinorUnits`, else `p × (1 − defaultMaxDiscountBps)`, rounded up.
- auto floor = the item's `autoFloorMinorUnits`, else the hard floor.
- Neither is ever above `p`.

Worked example (the bakery's rule, "floor 220, at most 20 off; 210 needs the owner"): list price 240, auto floor 220, floor 210. A buyer who asks 200 gets 220 automatically; 210 is possible only after the owner says yes; nothing below 210 is ever signed.

Validated by `validateSupplierSettings`; not on the integration proposal allowlist, so a connector cannot change a floor.

### 4.2 The counter-offer document (item 2)

`@dina/commerce-protocol`, new commerce digest domain `counter` (`counter_digest`):

```
CounterOffer {
  protocol_version        // the conversation's, from the request (§9.13)
  counter_id              // buyer-chosen, idempotency key
  quote_id, quote_digest  // the head the buyer is countering
  buyer_did, supplier_did
  round                   // canonical integer ≥ 1
  target_total: Money     // the whole quote, in its currency
  issued_at, respond_by   // respond_by after issued_at
  counter_digest
}
```

Carried as the params of a `service.query`, capability `com.dinakernel.commerce.counter_offer`, to the listing the quote came from. A conformance vector pins the digest; `conformance.md` records the domain.

### 4.3 The supplier's answer: a revision (items 3 and 5)

Supplier Core, before the runner:

- The subject gate: the quote family must exist and belong to the authenticated sender; any miss is one non-disclosing refusal.
- A `counter_id` this buyer already sent is answered from the record before the probing gate: the replay asks nothing new, and a buyer that lost the reply must be able to get it. One id names one counter: a different body under an id already recorded is refused, at admission and again before signing.
- Spend probing budget; refuse above `max_counters_per_buyer_per_day`. A counter that asks again while this node's owner is still deciding a price on that quote (the last answer was a hold waiting on the owner, and the owner's question is still open or just approved) asks nothing new: it spends no probing budget and does not count toward the daily cap, as it already does not count as a round. Otherwise a buyer waiting politely spends, on waiting, the budget the owner's yes needs to arrive. A declined, withdrawn or lapsed question ends this. Core reserves the counter's row before the runner is asked, so two counters arriving together cannot both slip under the daily cap.
- Refuse when negotiation is off, this buyer already has `maxRounds` counters recorded on the quote (Core counts its own records; the round number the buyer writes is not trusted), the window has closed, or the quote was closed by a not-awarded notice. A counter on a head that is no longer current is answered with the current head.

The runner (`negotiate-quote`, new manifest capability; pack version 1.1.0) receives the counter and the current lines, and answers proposed unit prices per line. The reference runner moves each line halfway from its current price toward the price that would meet the target, rounded to the minor unit.

Core then, per line: clamps the proposal to at least `auto_floor` (the floors come from revision 1, so a round cannot move them); if the runner asked below `auto_floor` but not below `hard_floor`, raises one owner card ("The buyer asks 210 for 3 cakes. Your automatic limit is 220. Offer 210?"). A yes records an authorised price that the buyer's next counter receives. If the clamped total is not below the current head, or the owner raised a floor since the head was signed so that a line now sits below `hard_floor`, Core answers the current head unchanged (a hold). A revision that fails Core's own checks is recorded and answered `{ outcome: 'refused' }`, so the buyer's counter does not wait out its window. Otherwise it composes revision N+1: same lines and quantities, new unit prices, `previous_quote_digest` = the head, same `max_uses`, and a validity as long as the head's, measured from now. While an owner question on the quote is open, the answer carries `pending_owner: true`, so the buyer's loop asks again after a pause instead of reading the hold as final. It registers the revision through `registerSignedQuoteInTx` and answers with it; the revision and the answer the buyer may replay are written in one transaction, so a head never moves without a retained answer. The answer to a repeated `counter_id` is the answer already given.

The owner card's per-line prices are the owner's alone: Brain reads the card with every line reduced to its `line_id` (`redacted: 'owner_only'`), on task reads, lists and events alike.

Existing installs run manifest 1.0.0, which has no `negotiate-quote`; they decline counters until the owner updates the pack.

### 4.4 Buyer intake (items 3 and 7)

- A counter's answer arrives on the `counter_offer` lane and goes through `applyInboundQuote`, so the revision is checked against the held chain exactly as a first quote is. The answer must name the quote countered; one that names another is recorded as refused.
- A counter whose window passes unanswered is sent once more under the same `counter_id` (the supplier replays a reply that was lost), on a tender still negotiating or one already ready; only after that is the supplier treated as silent. The sweeps resend this tender's own latest counter, not merely the newest one, so a manual counter sent later cannot strand it. A loop counter is in flight while its window is open and, once that window closes unanswered, until it has been asked once more and that window closes too: the supplier may have signed a revision whose reply was lost, and an award in the gap would order from a quote already superseded. So a silent supplier holds the award for two windows at most. A manual counter is never sent again, by the loop or the ready sweep; it is in flight only while its own window is open, and after that the owner may counter once more.
- An order-time counterproposal is kept only when its acknowledgement is valid and bound to the order this node holds (same order, lineage pointing at the countered quote, a fresh quote id).
- An order-time counterproposal: when a submission's acknowledgement, or a later reconcile's, is `counterproposal`, its `replacement_quote` goes through the same quote lane before the order record settles, so `from_quote` and the tender comparison see it.

### 4.5 Tender policy, loop, award and notice (items 6, 8, 9)

A tender may carry a negotiation policy at creation:

```
negotiation: { target_total, budget_ceiling, max_rounds (default 3), deadline_seconds (default 90) }
```

**Loop** (a Core sweeper, fixed rules): while the tender is open, before its deadline, and no quote is at or under the target, send each quoted supplier whose head is above the target a counter at `target_total` (the tick keeps one clock for all tenders, moved on by every awaited send; before each supplier it reads that clock again, re-reads the tender and checks every offer against the target, so a deadline that passed, a tender marked ready or awarded, or an offer that met the target while an earlier send awaited, stops it), one at a time per supplier, up to `max_rounds`. A supplier that holds, refuses, or lets a counter's window pass unanswered (an older pack drops a counter it has no lane for) stops receiving counters; one that holds with `pending_owner` is asked again after 20 seconds, then after 40, 80 and so on, at most every five minutes while the owner is still deciding. When the deadline passes, rounds run out, or a quote meets the target, the tender is **ready** and the owner gets one notice.

**Ranking:** quoted, unexpired, in the policy's currency (with no policy, offers that do not share one currency are refused `mixed_currencies`), total ≤ `budget_ceiling`; ordered by comparison cost (total minus advisory financing benefit), then total, then supplier DID. Every excluded offer carries its reason.

**Award:** `POST /v1/commerce/trade/tender/award { tender_id, supplier_did? }`, owner-only, owner presence where the node can prove it. It refuses while a counter to the chosen supplier is still in flight (the revision could make the held order stale), then picks the top-ranked offer (or the named one if it passes the filters), builds the order through the same builder `from_quote` uses, holds it as an approval, closes the tender, and returns the `approval_id` that `orders/submit` sends. A retry of an award already made returns that award (`replayed: true`, the same `approval_id`), and the ranking shows the `approval_id` once awarded; naming a different supplier is refused `tender_closed`. The tender's close and one notice intent per other quoted supplier are written in one transaction; the notices are then sent. A notice is marked sent once the transport takes it; one the transport refuses is retried by the loop's sweeper every 60 seconds, up to five tries, then marked abandoned. The supplier sends no receipt for a notice, so one refused on arrival is not retried. A manual counter on a quote that answers a tender no longer negotiating is refused `tender_closed`; Core finds the tender from the quote's request, so the owner need not name it.

**Notice:** capability `com.dinakernel.commerce.quote_outcome`, params `{ request_id, quote_id, outcome: 'not_awarded' }`, answered by the supplier's Core with no runner, before the probing gate (it asks for no price). It records the outcome, refuses later counters on that quote, and cancels any open owner price card for it. The supplier's own quote list shows that quote as **not awarded**: still in date, so the buyer could still order against it, but closed to counters. A repeated award returns each notice's state (`pending`, `sent`, `abandoned`), and once awarded the ranking says whether the held order is still `held`, already `sent`, or `lapsed`, so no surface offers Send twice.

A paused listing does not hear it. Core's receive path refuses every query to a listing that is not active, and this notice is no exception. The transport has already taken it, so the buyer marks it sent and does not try again; the supplier's quote stays open on its side until it expires. Decision (2026-09-25, dual review): accept this. A paused supplier is closed and takes no counters, so no later counter needs refusing, and any open owner price card on that quote lapses on its own window. Opening the receive path to one capability on a paused listing would weaken the owner's off switch for a courtesy message.

### 4.6 Requirement lines (item 1)

A request line may describe a need instead of naming a product:

```
{ line_id, product: { scheme: 'custom', value: 'req:<line_id>', issuer_did: <buyer> },
  requirement: { text, category_id? }, acceptable_substitutions: 'supplier_may_propose',
  requested_quantity }
```

`requirement` is new at protocol minor 1.2; a request that carries one must be at 1.2 or later and must allow `supplier_may_propose`. The reference runner matches the requirement against its published items (category first, then words shared between the text and the item's name and description) and answers with its own item as `offered_product` and a one-line `substitution_evidence`. Core accepts an offered product only when it is an item of this supplier's live published catalogue, so a runner cannot invent one; an answer that echoes the buyer's placeholder back as the offered product is refused at issuance and by the buyer's verifier alike. Suppliers with no good match decline `no_match`.

### 4.7 A clerk awards inside the owner's cap

Added 2026-09-26, after the review closed. The award and `from_quote` were owner-only, while a clerk with a buyer-side `commerce_submit` grant could already approve and send a draft order up to the grant's cap (TRADE_FIRST §6.5). So a distributor's purchasing clerk could place a draft order but could not award the tender Dina had just negotiated.

A staff device with a live buyer-side `commerce_submit` grant may now read the ranking and the held quotes, award a tender, hold an order from a held quote, and send it. The same gate as the draft path applies:

- presence on the clerk's own device, and a live grant, checked before any state is read, so an ungranted device learns nothing;
- the cap compares the held quote's own total (for the send, the approval's bound total), never a value the caller supplies;
- above the cap or in another currency, the owner gets one card before anything changes. The card is keyed by the quote and its total. A quote may be ordered from more than once, and the card names the clerk who asked, so one owner yes covers one order for one clerk: when the hold it approved succeeds, Core records the held order, the clerk and the card (`commerce_staff_clearances`), then marks the card spent (it completes, so the owner's history reads approved). That clerk may then send the order, and send it again after a failure, with no new card; a second order from the same quote, or another clerk sending this one, asks the owner again. The clearance row is the record of the spend: a card it names is spent whatever state a crash left it in, and the next attempt finishes it rather than reusing it;
- only Core mints these cards: the workflow API refuses both the card type and its key namespace, Brain may not decide one, and a task under the key that is not this exact question is never read as a yes;
- a draft-bound order is sent only through the draft send, which closes competing conversations and records the dispatch intent; a clerk's direct send refuses it (`use_draft_submit`);
- the held order names the clerk's device as the one who vouched for it.

A clerk still cannot open a tender, compare one, or counter; those stay with the owner. This is not item 10: a person still decides every order.

**On a server node the owner works from Core's own console** (`/owner`, `DINA_CORE_OWNER_CONSOLE=1`), never the Brain-served `/web` page, which by design holds no owner key. The console's **Approvals** section lists and decides the owner-only cards — a buyer asking below the automatic limit (with the numbers, which Brain never sees), a tender ready to award, a clerk over the cap — and its **Tenders** section shows a tender's ranked offers with Award (raising a passphrase box when presence is due) and Send. The owner header reaches the card list (GET only) and the existing approve/cancel verbs; nothing else on the workflow tree.

**The tender screen** (phone, `app/tender.tsx`). One screen for the owner and a clerk: the ranked offers and the excluded ones with reasons, an Award button on each offer while the tender can be awarded, and Send once the order is held. The owner reaches it from the trade inbox's open tender or the "tender ready" card; a clerk from the staff home's open tender (`as=staff`, the sealed relay). A lapsed presence raises the passphrase (owner) or PIN (clerk) sheet and retries; a clerk over the cap reads "waiting for the owner"; Core's refusals read in words (a counter still out, the tender already awarded).

## 5. Storage

Migration v49 (appended; boot does not read these tables, but appending keeps old nodes safe):

| Table | Side | Holds |
|---|---|---|
| `commerce_negotiation_counters` | supplier | each received counter, its answer digest, round, buyer, created_at |
| `commerce_negotiation_approvals` | supplier | owner-authorised prices per quote and line |
| `commerce_quote_outcomes` | supplier | not-awarded notices received |
| `commerce_buyer_counters` | buyer | each sent counter, state (`sent`/`unsent`/`revised`/`held`/`pending`/`refused`), answer digest, attempts |
| `commerce_tender_negotiation` | buyer | policy, state (`negotiating`/`ready`/`awarded`/`closed`), awarded supplier, approval id |
| `commerce_tender_notices` | buyer | one not-awarded notice per losing supplier, state (`pending`/`sent`/`abandoned`), attempts |
| `commerce_staff_clearances` | buyer | §4.7: the held order each owner yes above a clerk's cap was spent on |

## 6. Routes

| Route | Who | Does |
|---|---|---|
| `POST /v1/commerce/trade/tender` (+ `negotiation`) | owner | starts a tender, optionally with a policy |
| `GET /v1/commerce/trade/tender/ranking?tender_id` | owner, or a clerk with the grant | the ranked offers and the excluded ones with reasons |
| `POST /v1/commerce/trade/tender/award` | owner, or a clerk inside the cap; presence | award, held order, notices |
| `POST /v1/commerce/trade/counter` | owner | one manual counter to one supplier |

## 7. Tests

Contract tests per rule, then a live bed run: sancho tenders to alonso and chairmaker with a policy, the loop counters, alonso revises, the owner award builds the order, the loser receives its notice, the order is submitted and accepted.

## 8. Out of scope

- Item 10, approval within a spending limit.
- A model-driven requirement matcher. The reference runner matches by category and words; a pack may do better.
- Counter-offers on charges and payment terms. A counter moves price only.

---

## 9. As built (2026-09-25)

| Item | Where | Pinned by |
|---|---|---|
| Protocol: `CounterOffer`, digest domain `counter`, `QuoteOutcomeNotice`, requirement lines at 1.2 | `commerce-protocol/src/negotiation.ts`, `quote.ts`, `digests.ts`; vector in `conformance/vectors/digests.json` | `negotiation.test.ts` (vector cross-checked by an independent Python recomputation), `digests.test.ts`, `conformance_runner.test.ts` |
| 4 — pricing policy | `negotiation_policy.ts` (`negotiationPolicyFindings`, `lineBounds`, `clampProposal`), validated in `validateSupplierSettings` | `negotiation_policy.test.ts` |
| 2, 3, 5 — counter lane | provider ingress (`counter_offer` spends probing budget; `admitInboundCounter` before any runner), `order_decision.ts` → `settleInboundCounter`, reference runner `answerCounterOffer`, manifest 1.1.0 `negotiate-quote`, listing bindings | `negotiation_flow.test.ts` |
| 4 — owner question | card `negotiation_price_approval` (Core-minted, fenced from Brain), `makeNegotiationPriceDecisionHandler`, hooks in all three hosts, phone card | `negotiation_flow.test.ts`, `workflow_price_card_redaction.test.ts`, phone `useServiceInbox.test.ts` and `approval_inbox_price_card.test.tsx` |
| 7 — counterproposal intake | `buyer_response.ts` (`replacementQuoteOf` → quote lane) | `negotiation_flow.test.ts` |
| 6 — the loop | `buyer_negotiation.ts` (`runNegotiationTick`, `NegotiationSweeper`, always-on in `startCommerceSweepers`) | `negotiation_flow.test.ts` (two suppliers to ready) |
| 8 — ranking and award | `rankTender`; routes `tender/ranking`, `tender/award` (presence, `holdOrderFromQuote`, one award) | `commerce_tender_award.test.ts` |
| 9 — notice | `sendNotAwardedNotices` (buyer), `answerQuoteOutcomeInCore` (supplier) | both test files |
| 1 — requirement lines | `requestQuote` (placeholder + 1.2), `matchRequirement`, `quote_issuance.ts` substitution gate | `negotiation_flow.test.ts` |
| Tender screen | `apps/mobile/app/tender.tsx`; `tenderRanking` / `awardTender` / `sendHeldOrder` on the owner and staff clients (`client/tender_views.ts`); entry from the trade inbox, the staff home and the "tender ready" card | `tender.render.test.tsx`, `tender_clients.test.ts`, `approval_inbox_price_card.test.tsx` (the card's Open tender) |
| §4.7 — a clerk awards | `purchasingCaller` + `staffPurchaseGate` in `routes/commerce.ts` on ranking, award, `buyer/quotes`, `from_quote`, `orders/submit`; five exact rows in `authz.ts` | `commerce_tender_award.test.ts` (under the cap, over it with one owner card, no grant, no presence, `from_quote`, doors that stay owner-only), `staff_caller.test.ts` |
| Storage | migration v49 (seven tables + `service_rkey` on tender members) | every SQLite-backed test above |

Found and fixed on the way: `from_quote` fixed the approval's listing at `self`, so an order from a quote on any other listing was refused `service_rkey_disagrees`; the builder now carries the stated listing. The listing binder pinned the manifest this build ships rather than the one the install runs, so an install on an older pack could not be rebound; it now pins the install's own manifest and binds only the lanes it provides.

Review round (one independent reviewer, read-only): no path signs below the hard floor. Fixed and pinned: the round limit trusted the buyer's round number (now counts the supplier's records); an owner's yes never reached the loop (`pending_owner` and the `pending` state); an award could build an order a counter in flight would make stale; the not-awarded notice paid probing budget; revisions got a fixed 24-hour validity; ranking with no policy compared currencies; a counter's answer was not tied to the quote countered; the manual counter ignored an ambiguous one in flight. Found on the live bed: a supplier that drops a counter unanswered was countered again each round.

Dual review, round 1 (a Claude and a Codex reviewer, read-only, on the same version). Fixed and pinned: a runner could echo the buyer's placeholder as the substitute; a loop tick could counter after an award; a revision that failed Core's checks left the buyer waiting out its window; two counters arriving together could both pass the daily cap; an owner's floor raised between rounds did not apply to a held head; Brain could read the owner's floors on the price card; a counter replay paid probing budget, so a lost reply could not be recovered; a revision lost to a timeout was never asked for again; a lost award response could not be recovered; notices were lost when the send failed; a reconcile's counterproposal was dropped; the phone clipped a price card to three lines; the loop countered before checking a quote already met the target. Corrected: the notice does not reach a paused listing (§4.5 records the decision).

Dual review, round 2. Fixed and pinned: the resend rule from round 1 held the award forever when the deadline came before a counter's window closed (now a counter is in flight only while a window is open, and a ready tender still resends once); every workflow route that returns a task now hides a price card's numbers from Brain, `/running` and a deduped create included; a counter id reserved for one body refused any other; a manual counter could reach a tender that had left negotiation; a reconcile stored a counterproposal's replacement before checking the acknowledgement was about the held order; the loop did not recheck the target after an awaited send; the round-1 ordering test had overwritten its own first member. Corrected: a notice the transport took is not retried, so the plan no longer promises retries a paused receiver never triggers.

Dual review, round 3. Fixed and pinned: an award could slip in after a loop counter's first window and before its resend, and so order from a quote whose revision was lost (the award now waits for the resend's window too); the sweeps resent manual counters (now only the tender's own); the deadline was judged at the tick's start, so a slow send let later counters go out after it (the clock is read again before each supplier); a revision was published in one commit and its replay answer in another (now one transaction).

Dual review, round 4 (the round-3 fixes and §4.7). Fixed and pinned: one owner yes above the cap could cover several orders from one quote (the send now spends the card); a clerk could send a draft-bound order around the draft send (refused); the clock reset for each tender and the ready resends used the tick's start (one clock for the whole tick); a manual counter could strand an older loop counter's resend (the sweeps resend the tender's own latest counter).

Dual review, round 5. Fixed and pinned: Brain could decide a staff escalation card, and a task created under the card's key could stand in for the owner's yes (the card type joined the Core-minted set, the API refuses its key namespace, and the readback checks it is this exact question); spending a card by cancelling it made the owner's history read "denied" (it now completes); spending at the send lost the owner's yes when a send failed before leaving (the hold now spends it and records the one order it covers).

Dual review, round 6. Fixed and pinned: a clearance granted to one clerk let another clerk send that order above their own cap (clearances are now per order and clerk); the spend and the clearance were two commits, so a crash between them could strand the card or lose the yes (the clearance is written first and is the record of the spend; an interrupted card is finished on the next attempt, never reused).

### Browser run on the bed (2026-09-26, Core's `/owner` console, Playwright)

| Step | Result |
|---|---|
| sancho tenders "Oak dining chair" ×4 to albert (1.1.0) and alonso (1.0.0), 150-second deadline | ranking on sancho's console: alonso ₹60,000 best, albert revised to ₹66,000 |
| albert's console, Approvals | "A buyer asks for a lower price — asks ₹15,750 (now ₹16,500, first quoted ₹17,500)"; Offer it cleared the card |
| Award alonso at once | the page asked for the passphrase, then "Dina is still waiting for this supplier to answer a counter-offer" (alonso's silent counter, resent on the ready tender) |
| Award alonso after both windows | awarded; "Order held"; Send → "Sent. The supplier has not confirmed yet." |
| albert's quote list | "Not awarded. The buyer chose another offer." |
| Repeated award (API) | `replayed`, notice to albert `sent` |

Found and fixed during the run: after Send the page still offered Send (the ranking now carries `held_order`); the console's `clear` helper was called but never defined, so its staff-device, agent and Brain-work lists never rendered (a fault older than this work). Also found: sancho re-asked albert every 20 seconds while albert's owner decided, and those waiting rounds spent albert's probing budget for a stranger (5 an hour), so the round that would have carried the owner's yes was refused. Fixed on both sides (§4.3, §4.5): a re-ask while the owner decides spends no probing budget and no daily cap, and the buyer backs off (20 s doubling to five minutes).

### Live bed run (2026-09-25, four nodes on this code)

| Step | Result |
|---|---|
| sancho tenders "Oak dining chair" ×4 (a requirement line, protocol 1.2) to albert (pack 1.1.0, Core's runner) and alonso (pack 1.0.0, open orders, cannot update) | both matched their own chair: alonso ₹60,000, albert ₹70,000 |
| The loop counters at a ₹56,000 target | albert revised to its ₹16,500 automatic limit (₹66,000) and asked its owner about ₹15,750; alonso has no counter lane, dropped the counter unanswered, and was not asked again |
| Rounds that only waited on albert's owner | did not use up rounds; after the owner's yes, the next round came back at ₹63,000 (₹15,750 a chair) |
| A further round | refused by albert's probing budget: sancho is a stranger there (5 price questions an hour), so waiting rounds also spend budget — rule 2 as designed |
| Award (presence) | best offer alonso ₹60,000 → held order; albert received the not-awarded notice and closed its quote |
| Submit | alonso's runner accepted (`SO-AA408515B6`); alonso's export names the matched chair |

Bed notes: supplier packs cannot be retired while orders are open, so only albert could move to 1.1.0. The owner's floors are per product: an item floor on a product the catalogue does not offer never applies, and the default discount governs.
