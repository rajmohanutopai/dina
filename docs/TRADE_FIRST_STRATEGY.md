# Trade-First Strategy — distributors, small manufacturers, micro-vendors

Status: phase 1 IMPLEMENTED (2026-08-18, this repo, uncommitted at
review time) — the mechanisms in §3–§8 and §10 ship as code and tests;
§11's later phases remain design. Decision input: 2026-08 reviews
with a founder running a distribution company in takeoff mode (250
retailers live). Companion architecture: `COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md`,
`PHOTO_COMMERCE_LANES_DESIGN.md`, `CONTACT_SERVICES_ARCHITECTURE.md`.

## 1. The decision

Aim the commerce product at the informal supply chain: **distributors**
(~40k in the initial market) trading with **small manufacturers** above
them and **micro-vendors** (vegetable carts, toy sellers, corner shops)
below them.

Two market facts govern the whole design:

- **Cost decides the purchase.** Reviews only need to clear a floor —
  "as long as it is not horrible" — after which retailers and
  distributors buy from the cheapest supplier. Trust is a filter;
  price is the ranking.
- **The real price is a closely guarded secret.** The MRP printed on
  the packet (₹100) is public. The transacted price between one buyer
  and one manufacturer (₹62 for this account, ₹58 for a bigger one) is
  confidential, per relationship, and no supplier will publish it.
  Price is the differentiator AND price cannot be shown — §3 is the
  resolution of that cross-purpose, and it is the strategic core of
  this document.

What this rules out, deliberately:

- **Medium and large retailers.** Their economics run on floor-space
  charges and slotting fees; a protocol that ranks by trust and quotes
  per-relationship prices has nothing to sell them. Skip, and do not
  half-serve.
- **Consumer shopping as the wedge.** Consumers arrive in phase 3,
  after the trade network exists.
- **Salons / local services as the wedge.** The services machinery is
  built and stays; it becomes the phase-3 payload once density exists.

Why the architecture already fits: the shipped demo — a retailer
photographs a handwritten order, a chairmaker's node prices it, signs
the quote, and signs the acknowledgement — IS a
distributor-to-manufacturer trade. The kernel was built B2B-shaped.
What follows is the honest gap list, with the three big specs (price
discovery, the khata chain, staff grants) worked out.

## 2. What existed when this was designed (verified in code, 2026-08)

> 2026-08-18: this table is the PRE-implementation baseline the design
> was written against. The trade-first build has since landed (khata,
> tender + QuoteDecline, revenue share, staff grants + PIN presence,
> invite incl. the cold lane, order inbox, Tally export, the mobile
> Trade/Invites/Staff screens; migrations v33–v41). Rows below that the
> build moved past carry an updated note in place.

| Piece | Where | State |
|---|---|---|
| Signed quote request with quantities + `requested_terms { currency, credit_days }` | `commerce-protocol/src/quote.ts` | SHIPPED |
| Quote priced against the buyer's location (`priced_delivery_projection_digest`) with `charges[]` incl. `kind: 'delivery'`, arithmetic-verified totals | `quote.ts`, `arithmetic.ts` | SHIPPED |
| Quote `terms_digest` over a FROZEN, vector-pinned terms projection; order binds `accepted_terms_digest` to it | `quote.ts`, `order.ts` | SHIPPED |
| Published catalog REFUSES live stock / buyer-specific terms (§10.4) | `catalog.ts` validator | SHIPPED |
| Signed acknowledgement: accepted / rejected / counterproposal (counterproposal EMBEDS a full `SignedQuote`) | `acknowledgement.ts` | SHIPPED |
| Cancellation + reconcile (`outcome_unknown`, never-guess resubmission) | `cancellation.ts`, `reconcile.ts`, `buyer_reconciliation.ts` | SHIPPED |
| Buyer order lifecycle — **ends at `accepted`**; the §4 khata documents now carry the relationship past acceptance (delivery, payment, statement) | `buyer_reconciliation.ts` (`BuyerOrderState`), `trade_ledger*.ts` | SHIPPED |
| One live conversation per supplier per draft | order draft store | SHIPPED |
| Photo → draft → vouch → quote → approve → submit | photo lanes | SHIPPED |
| Roles `buyer` \| `supplier`, one install each | `install_plan.ts`, `reference_install.ts` | SHIPPED |
| Owner presence: one passphrase, one global 5-min stamp; §6.4's per-device staff PIN stamp now sits beside it | `owner_presence.ts`, `staff_pins.ts` | SHIPPED |
| Device registry roles `rich/thin/cli/agent/plugin` (+ `staff` since the §6 build) + durable revoke; caller types `service/device/agent/plugin` (+ `staff`, explicitly mapped) with a fail-closed authz matrix | `devices/registry.ts`, `auth/caller_type.ts`, `auth/authz.ts` | SHIPPED |
| Persona/service grants (`(grantee_did, service_rkey, capability)`), known_only visibility, contact closeness | `agent/access.ts`, `service/service_grant_repository.ts`, contact services | SHIPPED |

Two load-bearing observations fall out of this table. The catalog
validator already refuses buyer-specific terms in public snapshots —
the architecture took the price-secrecy position before the market
told us why. And the buyer lifecycle ends at `accepted`, while in this
trade acceptance is where the relationship *starts* — delivery,
shortage, credit, payment. §3 works before `accepted`; §4 works after.

## 3. Price discovery — public shortlist, private tender

### 3.1 The cross-purpose, and why marketplaces cannot solve it

Ranking suppliers by price seems to require publishing prices; the
trade refuses to publish prices. Every marketplace resolves this by
forcing transparency and renting out the result — which is exactly why
this trade resists marketplaces (Udaan-class B2B platforms fought this
and largely lost). A platform that *sees* the prices has already
disclosed them.

Dina's structure dissolves the conflict, because the comparison engine
belongs to the BUYER and the price never exists anywhere except the
two vaults it concerns. The public layer answers "who could supply
this?"; the buyer's own agent answers "at what price?" by asking
privately.

### 3.2 The flow

1. **Public shortlist.** AppView search over published catalogs:
   items, pack sizes, fulfilment regions, categories, and **MRP /
   list price only** (safe by definition — it is printed on the
   packet). PeerLens trust applies as a FLOOR: suppliers below the
   threshold drop out; survivors are NOT ranked by trust. Result: a
   shortlist of, say, twelve names.
2. **Private tender (RFQ fan-out).** The buyer's Dina builds ONE
   tender — lines with real quantities (so slab pricing prices
   itself), delivery projection, requested credit terms — and issues
   **N per-supplier `QuoteRequest`s** from it, one per shortlisted
   supplier. The shipped request shape embeds `supplier_did` and its
   digest covers every field, so each supplier receives their own
   request with its own `request_id`, `request_digest`, and
   `idempotency_key`; the tender is the buyer-side aggregate that
   groups the N `(request_id, supplier_did)` conversations under one
   comparison card. One consent card covers the fan-out, and it is a
   real consent: asking discloses the buyer's identity and demand to
   exactly those suppliers, and to nobody else.
3. **Per-relationship pricing at the supplier.** Each supplier's quote
   runner answers with THAT buyer's price, a `QuoteDecline` (§3.4), or
   nothing until the request expires. **Phase-1 tender audience rule,
   stated once:** the supplier quote capability is `known_only` in
   phase 1, so a tender may address only contacts and invited
   counterparties (§8) — a shortlisted stranger is a name the buyer
   INVITES first, and the RFQ follows the accepted invite. This is
   the same statement as §3.5's leak posture: phase-1 tendering runs
   where relationship discipline exists. Stranger-facing quoting (a
   public quote capability answering list-tier prices, the
   `unknown_buyer` decline becoming reachable) is phase-3 behaviour,
   gated with the rest of open discovery on the §3.5 hardener. The
   guarded number lives in one sealed envelope addressed to one buyer.
4. **Terms-adjusted landed cost in the buyer's vault.** Dina ranks the
   arriving quotes by what the goods actually cost delivered and
   financed. Freight is inside each signed total (§3.3). Credit terms
   are valued by a **buyer-local advisory adjustment**:

   ```
   financing_benefit_minor = round_half_even(
       total_minor × rate_bps × credit_days / (10_000 × 365))
   comparison_cost_minor   = total_minor − financing_benefit_minor
   ```

   `rate_bps` is the working-capital rate as an INTEGER in basis
   points (default 1800 = 18%/year, owner-adjustable, bounds
   0–10000); the computation is integer/rational arithmetic over
   minor units with the §9.1 discipline's single rounding step
   (round-half-even to the minor unit — the one rounding rule this
   protocol family permits). A quote with no credit terms values
   `credit_days` as 0. The adjustment is advisory arithmetic in the
   buyer's vault — displayed beside the signed total, never mixed into
   it, exactly the §3.3 transport-estimate rule. With the rate fixed,
   the ranking is deterministic to the paisa on any conforming build;
   ranking vectors include a fractional-benefit case and a case where
   rounding decides a tie.

   The card also carries a **last-paid badge**: for each line resolved
   to a supplier the buyer has bought from before, the unit price from
   the most recent ACCEPTED quote for that product — read from
   `commerce_buyer_quotes`, the verified store that already holds
   every signed revision — and the delta ("last order ₹58, this quote
   ₹66, +14%"). Deterministic lookup keyed by (supplier DID, product
   ref), unit-aware through the §5.5 two-tier arithmetic, advisory
   display beside the signed totals like every other adjustment here.
   This extends the shipped §5.5 badge family, which compares only
   against the catalog's indicative price; the last-paid number is
   the one a distributor actually acts on.

   The comparison card shows each quote's unit cost, freight, credit
   days, financing-adjusted cost, last-paid delta, and validity;
   picking one flows into the existing approve → submit chain.

Nobody's price was published. Every buyer still bought from the
cheapest supplier *for them*.

### 3.3 Distance and freight

Travel cost is already expressible on the wire: every quote is priced
against the buyer's declared delivery location
(`priced_delivery_projection_digest` binds it), and the quote's
`charges[]` vocabulary includes `kind: 'delivery'` inside the
arithmetic-verified total. So a far supplier's freight lands in their
own quote, and the landed-cost ranking punishes distance
automatically. What §3 adds is comparison-side:

- **Shortlist filtering by reach.** Catalog items carry
  `fulfilment_regions`; suppliers who do not serve the buyer's region
  never enter the tender. Too far is filtered before anyone quotes.
- **Basis disambiguation.** A quote with NO delivery charge is
  ambiguous — delivered-free and ex-godown look identical. The
  comparison card must not guess: such quotes are flagged, and an
  advisory transport estimate (the geocode tool exists) may be shown,
  clearly marked as the buyer's estimate and never mixed into the
  signed total. Whether the wire should gain an explicit
  `delivery_basis` declaration is open question 10.

### 3.4 Fan-out discipline, and the decline document

Quoting costs the supplier effort and goodwill; mass RFQ spam would
poison the network. Controls, all supplier-side and policy-shaped:

- Requests are signed and identified (`buyer_did` is in the request
  already) — there is no anonymous tender. Suppliers price by WHO
  asks; anonymity would produce garbage quotes and was rejected.
- A supplier's runner may auto-decline unknown buyers or throttle
  per-buyer request rates.
- Buyer-side default fan-out is small (3–5), user-adjustable, never
  silent.

Declining needs a wire shape — the bounded reason codes in
`acknowledgement.ts` are order-ack scoped, so phase 1 added
**QuoteDecline** to the additive wire inventory (SHIPPED,
`trade_documents.ts`):

```
decline_id, protocol_version
request_id, request_digest               -- pins WHICH request
buyer_did, supplier_did
reason_code                              -- bounded protocol set
                                         -- ('out_of_region', 'capacity',
                                         --  'policy'; 'unknown_buyer' joins in
                                         --  phase 3 when strangers can ask),
                                         -- open for supplier-policy codes
issued_at
decline_digest
```

The tender card then shows each conversation as quoted / declined /
pending / expired; a request with no answer resolves by its own
`expires_at` — silence never blocks the tender, and the decline lets a
polite supplier say no cheaply.

### 3.5 The leak problem — a signed quote is provable, including in v1

One place the cryptography works AGAINST secrecy: in the phone-call
world, "your competitor quoted me 58" is an unverifiable bluff. A
supplier-signed quote makes it PROOF — a buyer could shop one
supplier's secret price around to squeeze another.

Be honest about v1: shipped quotes travel in publicly verifiable
Ed25519-signed envelopes, so **in v1 a leaked quote IS provable**.
Phase-1 tendering therefore runs inside existing relationships and
invited counterparties (§8), where leaking is detectable and
relationship-fatal — the same discipline that polices the paper
quotation today. The supplier-facing pitch must not overclaim; it can
say truthfully: your price goes to one buyer, sealed, and never to a
platform.

The hardener (design-ahead): make the QUOTE stage verifiable only by
its addressee — a designated-verifier construction, or a MAC under the
pair's shared D2D context — so a shown-around quote proves nothing:
the buyer could have forged it. Publicly verifiable signatures return
at the order / acknowledgement stage, where both sides have committed
and provability is the point. Two scoping facts for that work (open
question 7):

- The acknowledgement's **counterproposal variant embeds a full
  `SignedQuote`** inside the supplier-signed ack. A counterproposal is
  a pre-commitment price, so it carries quote-stage secrecy semantics
  and must move to the same deniable construction (or be re-shaped to
  reference rather than embed) when this lands.
- Opening the tender to strangers at network scale (phase 3's open
  discovery) is GATED on this hardener: quote-shopping among
  strangers has no relationship discipline to fall back on.

The khata chain (§4) hangs off order + ack, so it is untouched.

### 3.6 Search-layer change

The discovery surface today ranks results with trust in the score.
For commerce supplier search, trust becomes threshold-filter only
("not horrible"), and the shortlist stays unranked (or ranks by
responsiveness / catalog completeness) until quotes arrive. The quotes
are the ranking. Small change, load-bearing semantics.

## 4. The khata chain — a shared ledger both sides can prove

### 4.1 Why

Indian distribution runs on credit: 7/15/30-day terms, short
shipments, on-account payments, and a paper khata each side keeps for
itself. The recurring dispute is "you never paid for the June 3rd
delivery" — two private ledgers that disagree and no arbiter. Dina
already makes both parties hold identical signed quotes, orders and
acknowledgements. Extending that chain through delivery and payment
gives both sides ONE tamper-evident history: an agreed balance both
can compute, and a disputed remainder both can see (§4.4).

Dina never touches money (Cart Handover holds). The chain records what
the humans did with money, signed by whoever asserts it.

### 4.2 The documents

Four new documents, same construction discipline as the shipped ones
(digest-first, `snake_case`, `protocol_version` on every document,
validators that refuse rather than default, and the §9.13 pairwise
conversation-version rule: every answer document is version-checked
against the document it pins). Authenticity follows the shipped seam
for EVERY document in §3.4 and §4: records carry content digests and
NO signature fields — a record's authenticity is the retained signed
D2D envelope it arrived in (`reconcile.ts` documents why a bare
`{record, signature}` pair is unverifiable by construction):

**DeliveryNote** — supplier-signed, per order, per dispatch.

```
delivery_note_id, protocol_version
purchase_order_id, order_digest          -- pins WHICH order
supplier_order_id
lines: [{ line_id, delivered_quantity }]  -- short shipment is a value, never an error
dispatched_at, expected_by?
note_digest
```

Multiple notes per order are normal (two dispatches against one
order). A note may cover fewer lines and smaller quantities than the
order. Over-delivery is refused by a **cumulative check over the
stored note set**: for each line, the sum of `delivered_quantity`
across all retained notes for the order must not exceed the order
quantity (the §9.11 cumulative-fulfilment pattern — a stateless
per-note validator cannot enforce this, so ingest checks against the
store).

**DeliveryReceipt** — buyer-signed, per note.

```
delivery_receipt_id, protocol_version
delivery_note_digest                      -- pins WHICH note
lines: [{ line_id, accepted_quantity, reason_code? }]
received_at
receipt_digest
```

Validation: per line, `accepted_quantity ≤ delivered_quantity` of the
pinned note, refused otherwise. `accepted_quantity` below the note's
figure IS the dispute record: both sides hold the note AND the
receipt, so the shortfall is a delta both can prove, not a claim
(§4.4 tracks it). `reason_code` is a bounded protocol vocabulary
(`damaged`, `short`, `wrong_item`, `refused`), **buyer-extensible**
(the buyer authors the field; supplier-policy codes have no place in a
buyer-signed document). No free text on the wire; the argument happens
on the phone call, the outcome lands in the receipt.

**PaymentNote** — buyer-signed assertion "I paid".

```
payment_note_id, protocol_version
buyer_did, supplier_did                   -- the RELATIONSHIP, see 4.4
amount: Money (minor units)
method: 'cash' | 'upi' | 'cheque' | 'transfer' | 'other'
external_ref?                             -- UPI ref, cheque number
paid_at
order_refs?: [purchase_order_id]          -- optional, advisory only
note_digest
```

**PaymentAcknowledgement** — supplier-signed, per payment note.

```
payment_ack_id, protocol_version
payment_note_digest
kind: 'received' | 'disputed'
amount_received: Money                    -- REQUIRED when kind = 'received';
                                          -- the credited amount, which may be
                                          -- less than the note's amount
acknowledged_at
ack_digest
```

Kind semantics are exact: `received` credits `amount_received` to the
fold (§4.4) — the field is mandatory for this kind, so a partial
receipt is a visible number, never an inference. Validation binds the
credited amount to the note it answers: `amount_received.currency`
must equal the PaymentNote's currency, and
`0 ≤ amount_received ≤ the note's amount` — an acknowledgement cannot
credit money in another currency or more money than was asserted paid
(vectors: full, partial, over-credit refused, negative refused,
currency mismatch refused). `disputed` credits zero and carries no
amount. There is no third state; an unanswered note sweeps (§4.3).

### 4.3 Chain rules

- The **delivery leg** chains fully by digest: receipt → note →
  order → quote → request. The **payment leg** chains ack → note
  only; a PaymentNote deliberately pins no order (payments settle the
  relationship, §4.4), so its anchors are the relationship pair and
  its own digest.
- **Payment idempotency.** Ingest deduplicates by `note_digest` (a
  replayed note is one note); `payment_note_id` is the buyer's own
  reference — unique as the buyer mints it, never protocol-enforced,
  so nothing downstream may key on it. `external_ref` is advisory
  display data. A buyer double-
  representing one physical payment as two notes is visible to the
  supplier at acknowledgement time — the supplier acknowledges each
  note explicitly, and `disputed` exists for exactly this.
- Both parties store every document they signed AND every counterparty
  document they verified — the stored-verified discipline of the buyer
  quote store.
- Unanswered documents are swept, the reconcile-sweeper pattern, on
  BOTH sides: a DeliveryNote with no receipt sweeps on the buyer's
  node ("confirm what arrived") and, after N days, surfaces to the
  supplier ("uncontested dispatch, no receipt"); a receipt that shorts
  its note sweeps on the SUPPLIER's node ("short acceptance —
  ₹X disputed"); a PaymentNote with no acknowledgement sweeps on the
  supplier's node. Silence is never treated as agreement, in either
  direction.
- The khata documents commit under their OWN digest family:
  `dina:commerce:trade:v1:<domain>` (`TRADE_DIGEST_DOMAINS` in
  `trade_documents.ts`), which also carries §3.4's `quote_decline`;
  the §5 documents get `dina:commerce:revshare:v1:`. The original
  §9.12 ten-domain vocabulary in `digests.ts` stays CLOSED, pinned by
  the frozen vectors — nothing registers beside `terms`.
- Wire versioning: these are **additive minor changes** to
  `@dina/commerce-protocol` — new documents plus one additive field
  (§4.5) — each with new conformance vectors and a changelog entry.
  The shipped order/quote/ack document KINDS are not re-shaped, so no
  protocol major; §4.5 states the one place an existing digest
  preimage grows.

### 4.4 The balance is derived, never asserted

No document carries a balance. Both sides compute two numbers from the
shared set, and the arithmetic is pinned so that two conforming nodes
cannot diverge:

**Agreed balance** (what the buyer has admitted owing, minus what the
supplier has admitted receiving):

```
goods_owed  = Σ over accepted orders, over lines:
                billable_qty(line) × bound unit price      (§9.1 helpers)
              + allocated charges                           (rule below)
billable_qty(line) = Σ accepted_quantity across the line's DeliveryReceipts
payments    = Σ amount_received over PaymentAcks with kind 'received'
balance     = goods_owed − payments
```

- Only orders with an `accepted` acknowledgement enter the fold. An
  order cancelled after acceptance contributes only its receipted
  deliveries.
- **Receipted quantities drive the money.** An unreceipted
  DeliveryNote contributes NOTHING to the balance (it sweeps instead —
  §4.3); a buyer admits debt by signing the receipt, which is the only
  basis a shared ledger can price without one side's unilateral word.
- **Charge allocation, the complete rule.** Order-level `charges[]`
  accrue INCREMENTALLY with acceptance, recomputed cumulatively at
  every receipt:

  ```
  accepted_fraction = Σ accepted line value (all receipts so far)
                      / order's full quoted line-subtotal sum
  accrued(charge)   = round_half_even(charge.amount × accepted_fraction)
  newly_owed        = accrued(charge) − previously accrued(charge)
  ```

  The denominator is the FULL quoted subtotal of the order (fixed at
  acceptance), so partial delivery accrues only the accepted fraction
  of each proportional charge; `subtract` charges (discounts) accrue
  by the same fraction with their sign. Attribution of an accrued
  charge across lines — needed only for per-line display — uses
  largest-remainder on accepted line value, ties broken by ascending
  `line_id`; the balance itself needs only the totals. Two
  exceptions, stated so both sides agree when money becomes owed.
  First, the accrual basis is decided BY CHARGE KIND, normatively,
  because the shipped `Charge` shape carries no fixed/proportional
  discriminator: **every `kind: 'delivery'` charge accrues in full
  with the first receipt whose accepted value is positive; every
  other kind (`tax`, `discount`, `other`) accrues proportionally by
  the formula above.** A future `accrual_basis` field, if suppliers
  need proportional freight, is a minor-versioned addition inside the
  digested charge — until then the kind IS the rule, and vectors
  cover both classes. Second, while total accepted value is zero (a
  fully refused shipment) NO charge of any kind accrues and no
  weights exist to allocate — nothing divides by zero, nothing is
  owed.
- **One currency per ledger.** A relationship's fold runs per
  currency; documents in a second currency open a second ledger
  beside it. No conversion, ever — the shipped one-currency-per-
  document rule extended to the fold.

**Disputed amount** (visible to both, part of no balance):

```
disputed = Σ over receipted lines:
             (delivered_quantity − accepted_quantity, floor 0) × bound unit price
```

The statement renders both numbers — "balance ₹X, disputed ₹Y" — each
line tappable down to the signed documents behind it. Golden fold
vectors (short delivery, split delivery with proportional tax and
discount charges, zero-acceptance refusal, partial payment, disputed
payment, cancelled-after-acceptance) ship with the documents as
conformance material.

Payments settle the relationship, not an order — "₹5,000 on account"
is how this trade actually pays. `order_refs` is advisory display
data. Allocation (which order a payment "went to") is a rendering
choice (oldest-first), never a wire fact, because allocation
disagreements are exactly the dispute class the raw chain exists to
end.

### 4.5 Terms

`requested_terms.credit_days` already exists and the order already
binds the quote's `terms_digest`. One additive field:

- `due_basis: 'from_delivery' | 'from_acceptance'`, **placed inside
  the quote's `payment_terms` object** — the terms projection is
  frozen and vector-pinned (`quote.ts` §9.4), and `payment_terms` is
  inside it, so this placement keeps the due-date basis under the
  digest the order accepts. Introduced at a declared protocol minor:
  the new minor's validator pins the vocabulary; emitting the field
  into a conversation pinned to an earlier minor is refused; readers
  of the new minor tolerate its absence. New conformance vectors for
  the grown preimage.
- Due dates then DERIVE, with the split-delivery case pinned:
  `from_delivery` matures credit **per receipted portion** — each
  DeliveryReceipt starts its own clock (`received_at` + credit days)
  for the value that receipt accepted, so an order fulfilled in two
  dispatches carries two dues; `from_acceptance` runs ONE clock from
  the acknowledgement's `accepted_at` for the whole order. Both sides
  compute identical dues from the same documents; split-delivery
  due-date vectors ship with the fold vectors. The statement view
  flags overdue derived dues. Flagging is Solicited (the owner opened
  the statement) or Engagement (briefing item); it is never an
  interruption — Silence First applies to money reminders too.

### 4.6 Storage and privacy

Khata documents live beside the shipped commerce stores — the same
database tier that already holds buyer quotes, orders and
acknowledgements on a node (contacts themselves are Tier-0 directory
data and are NOT persona-scoped, so "the persona that owns the
contact" is not a seam that exists). Nothing leaves the pair: every
document is already in the counterparty's hands by construction, and
no third party — including any future AppView — sees a ledger.
Finer-grained placement (compartmentalizing one relationship's khata
under a locked persona) is new work, open question 11. Aggregate
reputation ("pays on time") as a PeerLens attestation is phase 3 and
consent-gated; it is an open question (§13.5), not a plan.

## 5. The revenue-share chain — the floor-space model

Micro-vendors often trade under a different arrangement: a retailer
allocates floor space, takes no inventory risk, and charges 7–10% of
whatever the vendor sells. The percentage is the price here, guarded
the same way, and the settlement fight ("you sold more than you told
me") is the khata dispute in another costume. Discovery reuses §3
verbatim (ask three retailers privately, compare in the vault, with a
revenue-share capability schema). Settlement is a second document
chain on the §4 discipline — phase 2, with its own conformance
vectors, and these shapes:

Authenticity follows the shipped seam: commerce records carry content
digests and NO signature fields — each document's authenticity is the
retained signed D2D envelope it arrived in (`reconcile.ts` states this
rule). "Countersigned" therefore means two documents, each with its
own envelope evidence, never two signatures in one record:

**AgreementProposal** — sent by either party.

```
proposal_id, protocol_version
host_did, vendor_did
share_bps                                 -- 700–1000 = the 7–10%
period: 'daily' | 'weekly' | 'monthly'
cash_handler: 'host' | 'vendor'           -- who holds the money
currency
effective_from
replaces_proposal_digest?                 -- supersession lineage
proposed_at
proposal_digest
```

**AgreementDecision** — sent by the other party, one per proposal
(replays dedup by digest):

```
decision_id, protocol_version
proposal_digest                           -- pins WHICH proposal
kind: 'accepted' | 'rejected'
decided_at
decision_digest
```

**AgreementTermination** — sent by either party of an active
agreement:

```
termination_id, protocol_version
proposal_digest                           -- pins WHICH agreement
effective_at                              -- may postdate issuance; never precedes it
terminated_at
termination_digest
```

Lifecycle rules, stated so supersession cannot be read two ways: an
agreement is ACTIVE when a party holds proposal + accepted decision
with verified envelope evidence, and the envelope senders match the
two DIDs the proposal names (the party who proposed cannot also
accept). A re-proposal with `replaces_proposal_digest` changes
NOTHING until its own acceptance arrives — the old agreement stays
active and keeps settling until the replacement is accepted or a
termination takes effect. Settlement periods open under the old
agreement settle under it. Each document family gets its own digest
domain; the §9.13 pairwise version rule binds decision→proposal and
termination→proposal.

**SettlementNote** — issued by the `cash_handler`, one per period.

```
settlement_id, protocol_version
proposal_digest                           -- pins WHICH agreement
period_start, period_end                  -- exactly one live note per
                                          -- (agreement, period); a correction
                                          -- SUPERSEDES by revision with
                                          -- replaces_settlement_digest
gross_sales: Money
computed_share: Money                     -- validated: gross × share_bps /
                                          -- 10_000, round-half-even to the
                                          -- minor unit (§9.1's ONE rounding
                                          -- rule; no second discipline)
replaces_settlement_digest?               -- a revision names the live note
                                          -- it supersedes; digested
issued_at
settlement_digest
```

**SettlementAcknowledgement** — issued by the non-cash-handler party,
per note (the envelope sender MUST be the agreement party that is not
`cash_handler`; any other sender refuses):

```
settlement_ack_id, protocol_version
settlement_digest                         -- pins WHICH note (and revision)
kind: 'accepted' | 'disputed'
acknowledged_at
settlement_ack_digest
```

Replays dedup by digest. The first verified acknowledgement for a
settlement digest is final for that revision; a later conflicting one
refuses. The dispute path forward is a superseding SettlementNote
revision (which needs its own acknowledgement), never a second answer
to the same digest. Version binds pairwise to the note (§9.13).

Fold, same shape as §4.4, over accepted settlements of the latest
revision per period — the direction stated exactly, once per
`cash_handler` value:

- `cash_handler: 'vendor'` — the vendor holds the takings and owes the
  host `computed_share`.
- `cash_handler: 'host'` — the host holds the takings and owes the
  vendor `gross_sales − computed_share`.

Vectors cover both directions. Unanswered notes sweep both ways;
duplicate periods are refused at ingest; supersession keeps history
(the replaced note stays stored, excluded from the fold).

## 6. Staff grants — a business node with more hands than one owner

### 6.1 The problem

`owner_presence.ts` holds ONE global stamp proven by ONE passphrase. A
distributor's order clerk confirms fifty orders a day; the owner
cannot type a passphrase for each, and handing the clerk the owner
passphrase hands them the vault. The single-master principle must
survive: the owner stays the sole authority; staff act under scoped,
revocable grants — the same philosophy as the agent gatekeeper,
applied to humans on the payroll.

### 6.2 The model

- `DeviceRole: 'staff'` in the device registry (SHIPPED,
  `registry.ts`), paired through the existing ceremony
  (`/v1/pair/initiate` + `/v1/pair/complete`).
- **A distinct `staff` caller type with its own fail-closed authz
  rows** (SHIPPED, `caller_type.ts` maps it explicitly). This is
  load-bearing: a role without an explicit mapping would fall through
  to the generic `device` caller class, and generic devices reach
  vault query, persona listing and user-facing APIs (`auth/authz.ts`).
  A staff device must NOT inherit that surface. The `staff` caller type's
  matrix allows exactly: the commerce inbox read routes, and the
  commerce operations its grant names — nothing else. No vault reads,
  no persona listing, no approvals surface, no pairing, no settings.
  Tests prove the refusals route by route.
- A `staff_grants` table, owner-created through a presence-gated
  ceremony:

```
staff_grants(
  device_did,
  scope            -- 'commerce_confirm' | 'commerce_submit' | 'commerce_receive_goods'
  max_order_minor_units, currency,
  installs,        -- 'buyer' | 'supplier' | 'both': which commerce role's
                   -- operations this covers
  created_at, revoked_at
)
```

The grant's boundary is the COMMERCE INSTALL ROLE, deliberately not a
persona: shipped commerce aggregates carry no persona field and §4.6
parks compartmentalization as future work, so a persona-keyed check
would have nothing Core-owned to evaluate — it would trust a label
the caller supplied, which is no check at all. The install role IS
derivable from stored state on every staff-operable route (an order
draft is buyer-side, an inbound order supplier-side). Persona-scoped
staff grants become possible if and when open question 11 gives
commerce data a Core-owned compartment key.

- Durable, revoked when the device is revoked (the agent-grant
  discipline, reused).

### 6.3 The staff surface

What the staff member holds and how it reaches the node, stated
because the mobile app is a full sovereign Home Node and a staff
device must not be one:

- A staff device runs the mobile app in **staff mode**: at onboarding
  it pairs TO the business node as a device (role `staff`) instead of
  provisioning its own identity and vault. It holds only its device
  key. This mode is new phase-1 work and is listed in §11.
- Transport is the shipped device lane: Ed25519-signed HTTP against
  the owner's node, over MsgBox when remote — the same path the CLI
  device uses today. On home-node-lite deployments, the web UI reaches
  the same routes authenticating with the staff device key.
- The staff surface shows the order inbox (§7) filtered to the grant's
  install roles, and nothing else.

### 6.4 Presence becomes attributed

`proveOwnerPresence(passphrase)` generalizes to
`provePresence(principal, secret)`:

- The owner proves with the master passphrase, as today.
- A staff member proves with a per-device PIN set during the grant
  ceremony, stored as an Argon2id record (the `PassphraseRegistry`
  pattern the server already runs for personas). The PIN unlocks
  nothing in the vault; it proves a person is at that device now.
- The module keeps a stamp PER PRINCIPAL, same 5-minute TTL.

Vouch receipts and approvals then carry `vouched_by: <did>` — the
owner DID or the staff device DID. This extends the receipt preimage,
and the versioning decision is made HERE, normatively (it was briefly
an open question; it cannot be, since phase 1 builds on it): the
receipt gains an explicit version discriminator — v1 is the shipped
unversioned shape, v2 requires `vouched_by` — with its own digest
domain and conformance vector. The migration boundary is DURABLE,
because a v1 receipt carries nothing proving its age: creating the
node's first staff grant writes, in the same transaction, an
immutable **migration index of the digests of every v1 receipt then
in the store**. Grandfathered digests stay readable for ever; from
that transaction on, minting and ingest are v2-exclusive, and a v1
receipt outside the index is refused — so a staff-capable node cannot
be handed an unattributed receipt as a downgrade. Dual-read migration
vectors ship with the change.

The same attribution applies at the APPROVAL boundary, versioned
separately (an approval's integrity preimage is its own binding, per
the photo-lane design): the retained approval record gains an
origin/version discriminator whose v2 includes `vouched_by` in the
integrity digest; staff-origin approvals require v2; the same
grandfather-index rule covers stored v1 approvals. The audit question
both fields answer is the whole point: WHO looked at the machine-read
quantity before it became an order.

### 6.5 The threshold gate

Deterministic, compiled, no LLM — the `requireAgentPersonaAccess`
shape. What each scope covers, and what its cap compares, stated
per scope because two of the three operations carry no order total:

| Scope | Operation | Cap basis |
|---|---|---|
| `commerce_confirm` | the draft vouch ceremony (pre-quote — no money exists yet) | no cap applies; scope + install-role check only. Money control lives at submit, which every confirmed draft must still pass. |
| `commerce_submit` | buyer approve/submit; supplier order-accept | the bound quote/order total. A total whose currency differs from the grant currency ESCALATES to owner approval — minor units across currencies never compare, so the gate cannot decide alone. |
| `commerce_receive_goods` | signing DeliveryReceipts | the receipt's value priced from the bound quote (receipt → note → order → quote makes this computable). Same currency rule: a mismatch escalates. |

```
operation under a staff presence:
  grant exists for (device, scope, install role) else refuse
  if scope defines NO cap basis                  -- commerce_confirm
      → allow (money control lives at submit)
  else:
    currency equals grant currency               else escalate
    value ≤ max_order_minor_units                else escalate
escalate = create an approval workflow task for the OWNER
           (Pattern A suspension, the existing card surface)
```

The clerk confirms the routine; the ₹80,000 submit waits for the
owner's own presence. Escalation is idempotent and carries order id +
total + who attempted, never line contents beyond what the card needs.

### 6.6 What staff can never do

Install or uninstall packs, create or edit grants, revoke devices,
export the vault, publish a catalog (public commitments stay
owner-only until real demand says otherwise), read or query personas,
or reach any route outside the staff matrix of §6.2. The caller type
refuses these in code, fail-closed.

## 7. Dual-role node and the order inbox

A distributor is a buyer of manufacturers and a supplier to vendors —
both installs (`buyer`, `supplier`) on one node. The install machinery
already keys by role; the work is surface: one commerce home screen
showing both directions, and an **order inbox** — pending confirms,
pending quotes, open tenders with their comparison cards (§3.2–3.3),
unreceipted deliveries, short-acceptance disputes, unacknowledged
payments — with batch vouch inside a single presence window (already
legal under the 5-minute TTL; the ceremony screen just never
aggregated before).

## 8. The invite — onboarding a counterparty in one step

Growth is relationship-led: a distributor brings their own
manufacturers and vendors. Today that takes a DID paste and manual
grant setup. The invite collapses it into four signed messages and an
idempotent state machine (offered → redeemed → confirmed →
acknowledged, with ordered activation):

1. **InviteOffer** (minted at the owner's consent tap, rendered as QR
   + `dina1:` string): inviter DID, relay route, direction
   (I-supply-you / you-supply-me), the inviter's service rkey(s) and
   offered capability set, a single-use nonce, expiry, inviter
   signature. The offer alone among these messages carries an
   EMBEDDED signature, because the QR / string path travels outside
   any D2D envelope and must prove its own origin; every
   relay-delivered message in this ceremony (redemption,
   confirmation, ack, cold offers) authenticates by its signed
   envelope, the same seam as the commerce records. Shipped grants
   are keyed `(grantee_did, service_rkey, capability)`, so the rkeys
   and capabilities travel IN the offer — nothing is left for the
   redeemer to guess.
2. **Redemption** (the counterparty's node, over the relay): redeemer
   DID + its own service rkey(s) for the reverse direction, signed
   over the offer digest. Redeeming is the redeemer's consent.
3. **Confirmation** (inviter-signed, over the redemption digest).

Activation is ORDERED, not simultaneous — no relay protocol can make
two nodes commit in the same instant, so the design claims safe
ordering instead. The redeemer activates first, on durably storing
the confirmation (contact entry + its grants written), and answers
with an **ActivationAck** over the confirmation digest; the inviter
activates on the ack. The window between the two commits is safe by
construction: each side's grant only ENABLES the other side's
requests, and the not-yet-active side does not send requests — so an
asymmetric moment exposes nothing. Lost messages resolve by
idempotent re-send (every message pins its predecessor's digest and
the nonce keys the whole exchange); an exchange stuck short of both
commits sweeps on whichever side is waiting and, past the offer's
TTL, resolves by compensating revocation. Revocation is TWO-SIDED,
because after the redeemer commits it is no longer "waiting" on
anything and would otherwise keep a phantom relationship the inviter
will refuse for ever: the inviter's compensating revocation sends a
best-effort **RevocationNotice** (pinning the nonce) that the
redeemer honours by tearing down its writes; and independently, the
redeemer runs an ACTIVATION-PROOF check with a pong, never an
idleness guess: any authenticated inbound envelope from the inviter
counts as proof the inviter activated, and an inviter holding the
active relationship answers a re-sent ActivationAck with an
idempotent **AckReceipt** — so a re-send always produces proof when
the inviter is alive and active. A redeemer with NO activation proof
after the retry window tears down its writes AND sends its own
best-effort RevocationNotice to the inviter, so neither direction can
retain one-sided state. Idleness alone is never a trigger: a vendor
who onboards and places their first order weeks later has activation
proof (the AckReceipt) and their relationship stands untouched.
Either path ends with the relationship either live on both sides or
dead on both, and the nonce dead regardless. No message-ordering
assumption is made of the relay: a grant-dependent request that
arrives before its grant is refused, and the sender retries — the
first RFQ after onboarding tolerates one refusal. Re-redemption
of a used or expired offer refuses. Grants written: the supplier side
grants quote-request / order-submit / khata capabilities on its
service rkey; the buyer side needs no execution grant, because
inbound khata documents ride the existing D2D receive pipeline under
known-contact trust.

**The cold invite — reaching a discovered supplier.** The QR /
`dina1:` string serves counterparties the inviter can already reach
out-of-band. A shortlisted stranger from AppView search is a
published DID with no such channel, and the §3.2 phase-1 rule (invite
first, then tender) depends on reaching them. So the same InviteOffer
is also deliverable OVER THE RELAY to any DID with a live published
commerce catalog — publishing a catalog is the act of consenting to
receive introductions, the way printing a phone number on a shop
board is. Guardrails, because a cold-invite channel is the §3.4 spam
vector by another door: the receiving node renders a consent card
(inviter DID, direction, what would be granted) and writes NOTHING
before the owner accepts — a cold offer sits in quarantine-style
holding, never auto-redeemed; per-sender and aggregate throttles
apply at the receiving node; ignoring an offer costs the receiver
nothing (it expires); and a supplier can set policy to refuse cold
invites entirely, which drops them before the card. Acceptance
continues at §8 step 2 unchanged. Hard rule: this ceremony creates a PEER, never a device. It
must not touch `/v1/pair/*` — pairing mints keys under the owner's
authority; an invite connects two sovereign nodes. A vendor with no
node yet gets the app-store link plus the code in one message;
redemption is their step 3 of onboarding.

## 9. Micro-vendors — the smallest buyers

- **Android is the gate.** This segment does not carry iPhones. The
  Android build moves from "in progress" to the launch-critical path.
- **Voice is the second door.** Same draft machinery, same proposed→
  vouch discipline; the capture door is speech instead of a
  photograph. No new kernel lane.
- **Language.** Order sheets and speech arrive in Malayalam and Hindi
  first. Extraction prompts, reason-code labels, and the vouch screens
  localize; the wire stays English-keyed.
- Store-and-forward over the relay already tolerates the connectivity
  these phones live with; nothing to change.

## 10. The Tally bridge (phase 2)

Distributors run Tally or Marg. They will not retype. A runner-mode
plugin on the distributor's machine — its own Ed25519 key, private
lane, out-of-process, exactly the plugin substrate — maps confirmed
orders out and stock/price data in. Boundary: the bridge FEEDS the
firm's internal books; the khata chain between parties remains the
shared truth. The bridge never becomes an authority the counterparty
must trust. (This retargets the WS-8 ERP-connector work from demo-Odoo
to Tally; the seam is identical.)

## 11. Sequencing

**Phase 1 — the trade works end to end**
Dual-role node; order inbox with batch vouch; RFQ fan-out (per-
supplier requests + tender aggregate + consent card, contacts and
invited counterparties only — §3.2 step 3), QuoteDecline,
financing-rate setting + comparison view with the last-paid badge;
trust-as-floor in commerce search; DeliveryNote/Receipt with cumulative over-delivery checks;
PaymentNote/Ack; the derived fold + golden fold vectors; `due_basis`;
invite ceremony (§8's four messages + ordered activation); staff
caller type + staff grants + attributed presence (vouch receipt v2,
§6.4) + staff mode in the mobile app; Android.

**Phase 2 — the trade is convenient**
Per-relationship pricing hook in the quote runner, revenue-share chain
(§5), Tally bridge, voice door, localization, overdue surfacing in the
briefing.

**Phase 3 — the network pays out**
Open discovery via PeerLens — with stranger-facing tendering gated on
the §3.5 hardener — payment-behaviour attestations (consent model
first), salons/services (already built), consumer tier.

Design-ahead only (build nothing, preclude nothing): designated-
verifier quotes incl. the counterproposal path (§3.5), multi-branch
businesses (§13.6).

VC money, if raised, buys onboarding operations, Android polish and
relay scale. The design's contribution to the raise is twofold: the
invite loop (one distributor node pulls in its 50–300 spokes without
per-head acquisition), and the §3 structure — a price-comparison
network no marketplace can copy without becoming the disclosure it is
selling protection from.

## 12. What deliberately does not change

The kernel boundaries (Core never interprets, Brain never holds keys),
the Four Laws, the photo lanes, the quote→approve→submit chain and its
arithmetic verification, single-master authority, Cart Handover, the
egress gates. The market re-aim is a go-to-market decision; the safety
architecture was already pointed the right way — including the catalog
validator's refusal of buyer-specific terms, which turns out to be the
price-secrecy line the whole trade demanded.

## 13. Open questions (decide before building the affected piece)

1. **Receipt preimage versioning — DECIDED (this revision), recorded
   here for the trail.** Version bump: receipt v2 with mandatory
   `vouched_by`, dual-read migration, staff-capable nodes emit v2
   exclusively (§6.4). Parallel attribution outside the signed
   receipt was rejected — attribution nobody can prove is not
   attribution.
2. **On-account vs per-order payments in the statement UX.** The wire
   decision (relationship-scoped) is settled above; how the screen
   renders partial allocation needs a design pass with a real
   distributor's khata book on the table.
3. **Staff presence secret.** Per-device PIN (spec'd above) vs
   platform biometrics unlocking a device-held key. PIN ships first;
   biometrics is a later upgrade on the same `provePresence` seam.
4. **Catalog publish delegation.** Owner-only for now. A distributor
   with a daily price list may need a staff scope for it; wait for the
   demand before widening a public-commitment power.
5. **Payment-behaviour attestations.** Powerful and dangerous; needs
   its own consent design (who may assert, what aggregate leaves the
   pair, revocability). Phase 3, nothing in phases 1–2 depends on it.
6. **Multi-branch distributors.** One business, several
   godowns/nodes. Out of scope for phase 1; the staff model must not
   accidentally preclude it (grants keyed by device DID, never by
   "the second phone", keeps the door open).
7. **Designated-verifier quotes (§3.5).** Which construction — a true
   DV signature, or a MAC under the pair's D2D shared context — and
   how the order's `accepted_quote_digest` binding verifies for both
   parties while proving nothing to a third; the counterproposal
   variant (which embeds a SignedQuote in the ack) moves with it. Also
   the migration story: quotes are Ed25519-signed today, and the two
   schemes must coexist per conversation version.
8. **Trust-floor governance.** Who sets the "not horrible" threshold
   for commerce search — a protocol default, a user setting, or a
   per-category value? A floor too high recreates ranking-by-trust;
   too low makes the filter decorative.
9. **Tender etiquette defaults.** Fan-out size, per-supplier request
   throttles, and whether a supplier sees that a request was a tender
   (competitors asked too) or single-sourced. The trade's phone-call
   etiquette should be studied before the defaults are chosen.
10. **Delivery-basis declaration.** A quote without a delivery charge
    reads two ways (delivered-free vs ex-godown). Add an explicit
    `delivery_basis` field to the quote, or keep it a comparison-side
    flag? A wire field is honest and cheap; decide with a supplier's
    real quoting habits in view.
11. **Khata compartmentalization.** Documents live beside the shipped
    commerce stores (§4.6). Whether a relationship's ledger can be
    assigned to a locked persona (and what an agent grant then
    protects) is a storage-model question to settle before any
    third-party access to commerce data exists.
