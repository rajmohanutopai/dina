# Shelf-space negotiation (Zeev)

> **Status:** design note, draft 6 (2026-10-13), after four rounds of
> dual review (§13). Round 4's findings are taken in this draft and have
> not been re-reviewed. Not built.
>
> **Source:** a request from Sudhir (Zeev). Small D2C brands rent shelf
> space in neighbourhood stores. Zeev lists the stores and their open
> slots. The two ends, store and brand, negotiate through their own Dinas.
> Both owners see and approve the result. Zeev never sees a price.
>
> **Order of authority:** `dina_details.md`, then README and ARCHITECTURE,
> then `docs/PLUGIN_ARCHITECTURE.md`, `docs/TRADE_FIRST_STRATEGY.md`
> (§3 price secrecy, §3.5 the leak limit, §5 the revenue-share chain, §8
> the invite) and `docs/NEGOTIATION_PLAN.md` (floors in Core, counters,
> revisions). This note reuses their rules and code, and says so where
> it departs.

## 1. The problem and the people

Neighbourhood stores are squeezed from below by discount chains
(D-Mart) and from above by quick commerce (Blinkit, Zepto). To carry
more products without buying more stock, a store will rent shelf space
to small D2C brands. Brands want shelves, and stores want rent and
variety.

| Party | Who | What they hold |
|---|---|---|
| **Store** (seller of space) | The store manager, in the Dina app on their phone | Open slots, lowest terms, rules, the deals already agreed |
| **Brand** (buyer of space) | A D2C business, in the Dina app or on its own Home Node | Its products, its category, what it will pay |
| **Zeev** | Sudhir's app and network (about 300 stores) | The directory of stores and open slots, and the matching |

Owner decisions this note works within:

1. Zeev is a directory and an interface, never a party to a deal.
2. Dina negotiates for each side. Both owners see the result and must
   approve it. A deal exists only when both have approved.
3. Zeev never sees a price.
4. Shelf knowledge lives in a plugin. Core gains only general trade
   pieces.
5. Zeev hosting the stores' Dinas is out of scope.

## 2. Fit with Dina's rules

- **One master per Dina.** The store's Dina works for the store, and the
  brand's Dina works for the brand.
- **Kernel, not platform.** Core learns nothing about shelves or juice.
  It gains a general way to offer, counter and agree on named terms for a
  resource (§5). Shelf vocabulary arrives in a plugin (§4). A co-working
  desk or cold-storage space would use the same Core pieces.
- **Agent safety.** Committing to rent is a risky action. Dina bargains
  on her own inside the owner's limits, and each owner approves the deal
  with presence (§7.2).
- **Price secrecy (TRADE_FIRST §3).** No price is ever published: not a
  floor, not an asking price (§6). Offers travel sealed, Dina to Dina.
- **The leak limit (TRADE_FIRST §3.5), stated plainly.** A signed offer
  can be proved. A brand that receives one can show it to Zeev or to
  another store, and Dina cannot stop that. The honest claim to stores
  is: "your terms go to one brand, sealed, and never to a platform."
  Deniable offers are TRADE_FIRST's planned hardener, not built.
- **Cart Handover.** Dina records the deal and what each period owes,
  and both sides accept or dispute each period's figures. She never
  moves money, and in version 1 she does not record payments (§5.6).
- **Scope changes the owner must confirm (Q4):**
  - TRADE_FIRST lines 30–38 rule out slotting fees for larger retailers;
    this adds them for small stores.
  - Zeev-matched brands are strangers to the store. TRADE_FIRST keeps
    phase-1 quoting to known and invited counterparties (§6.2 here).

**Out of scope:** any Zeev-run software that holds keys or shows terms.
That covers Zeev hosting a store's Dina, a Zeev-built app that contains
Dina, and a Zeev web console for brands. Each would put Zeev inside the
trust boundary, where it could read every price, so condition 3 would
rest on Zeev's promise (TRADE_FIRST §3.1: "A platform that sees the
prices has already disclosed them"). Stores and brands use the stock
Dina app or a Home Node they own (§9).

## 3. What exists, and what this note must add

Commerce is already a plugin. The Commerce Pack manifests are compiled
into Dina (`packages/core/src/commerce/reference_manifests.ts`) and
install through the first-party door (`local_publisher_key`,
`reference_install.ts`). Core mints a runner device for an install and
the runner answers on the owner's own node (`supplier_runner.ts`).

| Piece | Where | Reused as |
|---|---|---|
| The `commerce.trade` D2D family: signed documents stored on arrival, not answered in a 5-minute query | `d2d/families.ts:151`, `commerce/trade_ingress.ts:45-54` | The transport for every term document (§5.3) |
| Revenue-share decision, termination, settlement and acknowledgement | `commerce-protocol/src/revenue_share.ts:70-130`, `commerce/revshare_service.ts`, `revshare_ledger.ts` | Pinned to the new term agreement (§5.5) |
| Floors with an owner card between them | `commerce/negotiation_policy.ts:139-188`, `negotiation_supplier.ts` | The pattern for per-term floors (§5.4) |
| Counter admission, probing budget, daily cap | `plugins/provider_ingress.ts:366-382`, `negotiation_supplier.ts` | The same gates, applied at trade ingress (§5.3) |
| Buyer loop with fixed rules | `commerce/buyer_negotiation.ts` | The brand's loop (§8) |
| Approval bound to what the owner saw | `commerce/approval_payload.ts:138-198` (order and acknowledgement kinds only) | New kinds for agreements (§7.2) |
| Owner-only redaction for Brain | `server/routes/workflow.ts:585-661` (by card type) | Extended to every new card (§7.4) |
| Quote access setting | `commerce/commerce_settings.ts:117` (`quoteAccess`) | Who may ask for an offer (§6.2) |

What does **not** carry over:

- **The quote chain is goods-only.** Core's clamp, sign and revise path
  works on `SignedQuote` lines keyed by product (`negotiation_supplier.ts:443-575`),
  and the counter and probing gates fire by fixed capability names
  (`provider_ingress.ts:366-382`). §5 adds general term documents with
  their own gates.
- **Service queries live five minutes.** `service.query` caps its TTL at
  300 seconds (`packages/protocol/src/constants.ts:206-207`,
  `validators.ts:251-255`), and goods counters expire in 60 seconds
  (`buyer_negotiation.ts:63-76`). A store's phone may sleep for hours, so
  term documents travel on `commerce.trade` instead (§5.3, §9).
- **Initial quotes are not floor-checked.** Today Core clamps only
  revisions; the first quote's prices are the runner's
  (`quote_issuance.ts:278-362`), and `lineBounds` caps every floor at
  that first price (`negotiation_policy.ts:139-153`). Term offers check
  floors on every offer, with no cap (§5.4).
- **First-party gates name the two Commerce Pack ids.** The runner
  (`supplier_runner.ts:96-103`, one device per node at `:61-70`) and the
  money stores (`runtime.ts:452-489`) serve only those ids. §4 replaces
  both with one Core-owned table.
- **The runner prices from the public catalog** (`supplier_runner.ts:187-215`).
  Slot terms are never public, so the runner reads a private store
  (§5.4).
- **The revshare fold covers only the share** (`revenue_share.ts:295-348`),
  rejects only identical settlement periods (`revshare_ledger.ts:542-548`),
  and ends a replaced agreement when its successor is accepted
  (`revshare_ledger.ts:248-270`). §5.5–5.6 define rent, periods and
  renewal for term agreements.

## 4. The Slot Pack (first-party plugin)

**It ships in the Dina build as a first-party manifest,** like the
Commerce Pack. Zeev contributes its content (the category list, default
rules, wording) to the Dina repository, and Dina publishes it. Zeev is
not the publisher, so the first-party gates stay closed to anyone else.
Opening them to other publishers is a separate design (Q6).

**One Core-owned table of first-party packs** replaces the two hard-coded
ids. It names each pack's `plugin_id`, its schema major version, its
runner handler, and whether it may use the money stores. The runner
binding (`bindReferenceRunner`) and the money-store gate
(`runtime.ts:452-489`) both read it. The runner mints one device per
install, keyed by `install_id`. Pause, revoke and update follow the
install. The Slot Pack needs no Commerce Pack beside it.

**Identity across nodes.** A first-party install records the node
owner's own DID as publisher (`reference_install.ts:92-101`), and its CID
changes with each build. So documents identify the pack by
`(plugin_id, schema_major)` and never by publisher DID or CID. Two nodes
interoperate when their schema majors match. A minor change may add
`enum` values: a receiver that does not know a value refuses that
request and nothing else. A listing and an open offer chain survive an
app update that keeps the major. A major change refuses open chains,
which the brand sees as a closed negotiation.

The store installs the seller half and the brand the buyer half, through
the normal consent card.

**What the pack holds, mapped to manifest fields the validator accepts**
(`packages/protocol/src/plugins/validate.ts:71-112`):

| Content | Field |
|---|---|
| A slot's descriptive attributes (type: shelf, end cap, chiller; size) | `params_schema` of the term-request capability, with `enum` lists |
| The category list | `enum` in that schema; its values are the tags Core counts (§5.4) |
| Default rules ("each brand already in a category adds 15%, at most four") | `config_schema` `default` annotations. The rule form shows them as suggestions; Core stores a rule only from the owner's own submission (§5.4). |
| The runner's step size and pace | `config_schema`, pinned per task by the existing config revision |
| Card layouts | §15.6 pinned card templates, for display only |

**What the pack never holds:** prices, floors, rules in force, or
deals. Those live in the store's Core.

**Capabilities.** The pack declares the general term capabilities Core
defines in §5 and supplies their attribute schema. Core supplies the
gates, floors, signing and transport. The seller half is `provider`
kind and the buyer half `tool` kind, as with the Commerce Pack.

## 5. General additions to Core and the protocol

Each piece is written for any resource. None names a shelf.

### 5.1 Terms

A **term** is one negotiable value: `{ name, value }`. Core owns a table
of term names, so the other party cannot redefine one:

| Name | Kind | Unit and bounds | Buyer favours |
|---|---|---|---|
| `fee` | money | minor units, in the document's `currency` | lower |
| `share_bps` | bps | integer 0–10,000 | lower |

A document naming a term outside the table, or giving a value outside
its bounds, is refused. A new term name is a protocol change.

### 5.2 The general block

Every term document carries a Core-owned block of conditions, separate
from the pack's descriptive `attributes`. Core reads only this block:

```
general: {
  tag,                          // one of the pack's enum values
  currency,
  period: 'monthly' | 'weekly',
  cash_handler: 'host' | 'vendor',
  start,                        // UTC instant
  end,                          // UTC instant, carried, never computed by a receiver
  trial?: { end, fee: Money },  // trial.end ≤ end
  exit_notice_days,
  stock_duties?: { min_skus?, restock_days? }
}
```

The offering side computes `end` once, as `start` plus N calendar months
in UTC, clamped to the month's last day (31 January + 1 month = 28 or 29
February). Every later document carries the same `end`, so both nodes
agree on the last day. A conformance vector pins the arithmetic. The
`general` block is fixed in version 1: only `terms` are bargained over.

### 5.3 Term documents and their transport

Four new commerce documents, each with its own digest domain in
`digests.ts`, a conformance vector, and a `protocol_version` that must
match across the chain (`verifyConversationVersion`,
`common.ts:103-124`):

```
TermRequest   { protocol_version, request_id, buyer_did, seller_did,
                listing_uri, listing_digest,
                pack: {plugin_id, schema_major}, resource_ref,
                attributes, general, wanted_terms[], issued_at,
                respond_by, request_digest }

TermOffer     { protocol_version, offer_id, request_id, request_digest,
                seller_did, buyer_did, pack, resource_ref, attributes, general,
                terms[], valid_until, revision, previous_offer_digest?, offer_digest }

TermCounter   { protocol_version, counter_id, offer_id, offer_digest, buyer_did,
                seller_did, round, targets: {name: value}, issued_at,
                respond_by, counter_digest }

TermReceipt   { protocol_version, receipt_id, of_digest, issued_at, receipt_digest }
```

- **Transport.** All of them travel as `commerce.trade` pushes
  (`trade_ingress.ts` gains the kinds), which Core stores on arrival and
  processes when it runs, not as 5-minute service queries.
- **First contact with a stranger.** Today `commerce.trade` is refused to
  and from anyone who is not a contact or an order counterparty
  (`d2d/gates.ts:174-190`, `receive_pipeline.ts:633-670`,
  `trade_counterparty.ts:31-44`). A narrow waiver is added on both sides,
  and nothing wider:
  - **Request scope.** Authority starts from one request, on both
    nodes, and covers only documents that name that `request_id`, its
    offer chain, or the agreement it produced. It is recorded on the
    `trade_counterparty.ts` pattern, keyed by `(peer DID, request_id)`.
  - **Brand, sending.** A `TermRequest` may go to a stranger only when its
    `listing_uri` and `listing_digest` name a term listing that the
    stranger's DID signed, as fetched from AppView. Sending it records
    the store as a request-scoped counterparty, so the brand's receive
    gate admits that store's receipt, offer or rejection for that
    request, and nothing else from it.
  - **Store, receiving.** A `TermRequest` from a stranger is admitted
    only when its listing fields name a listing this node currently
    publishes. Admitting it records the brand as a request-scoped
    counterparty. The store may then send that brand a receipt at once,
    and an offer or a rejection for that request.
  - **Under `contacts_or_card`,** the request is answered `held` and raises the
    stranger card (§6.2). No offer is made until the owner approves. A
    decline sends a rejection. Nothing else from that sender is admitted
    while the card is open.
  - **Scope ends** when the request's `respond_by` passes with no offer,
    or when the chain or agreement ends.
  - Blocking, sharing and probing gates still apply. A blocked DID never
    reaches the waiver. No term kind outside this scope may go to or
    come from a stranger.
- **Gates at trade ingress.** A `TermRequest` and a `TermCounter` spend
  probing budget. A counter goes through admission as goods counters do:
  replay by `counter_id`, the current head, rounds counted by Core, the
  window, and the daily cap per buyer.
- **One chain per offer.** Every change is revision N+1 with
  `previous_offer_digest` pointing at the head (NEGOTIATION_PLAN rule 5).
  `protocol_version`, `currency`, `pack`, `resource_ref` and `general`
  cannot change within a chain. A counter on a stale head is answered
  with the current head.
- **No refusal names a floor.** Counters bind nobody, and one buyer's
  terms are never sent to another (NEGOTIATION_PLAN rules 1–4).
- **Delivery is confirmed by the other party, not the relay.** MsgBox
  deletes what it holds after 24 hours (`msgbox/internal/buffer.go:21`).
  So every term document, from request to settlement, is resent until a
  final receipt for its digest arrives: at once, then every 6 hours. For
  requests, offers and counters, resending stops at the document's own
  deadline (`respond_by`, or `valid_until` for an offer). A request's
  `respond_by` defaults to 3 days, at most 7, and is the brand's deadline
  for a first offer. For agreement documents (proposal, decision,
  termination, settlement and acknowledgement) resending stops after 33
  days: the receiver may hold one for 30 days from its arrival, arrival
  trails sending by up to two days, and the sender must still be resending
  when that final answer comes. A document that runs out of resends shows "not delivered" on its
  card, and the owner is told once.
- **What a receipt says.** `TermReceipt` gains
  `outcome: 'stored' | 'held' | 'refused'`, with no reason:
  - `stored`: processed;
  - `held`: kept durably because something it depends on has not
    arrived (for example, a settlement before the decision);
  - `refused`: invalid, permanently.

  `stored` and `refused` are final; `held` is not.
  - **Final receipts stop resends.** On a `held` receipt the sender
    keeps resending, but once a day instead of every 6 hours, until a
    final receipt arrives or its stop point passes.
  - **The receiver always answers with the current outcome.** A resend
    of a stored document gets `stored`. A resend of a held one gets
    `held`, or the final outcome once there is one. When a held document
    becomes `stored` or `refused`, the receiver also pushes a fresh
    receipt at once.
  - **A final receipt is never replaced.** A late `held` receipt
    arriving after a final one is ignored.
  - **Cards.** The sender's card shows "sent", then "waiting on the
    other side" while held, then "delivered" or "refused".
- **Order of arrival.** The existing spool drops an entry whatever its
  verdict (`trade_ingress.ts:128-168`), and the revshare ledger refuses a
  termination or settlement for an agreement it does not yet hold as
  accepted (`revshare_ledger.ts:485-487`, `565-567`). For term documents,
  a document whose prerequisite is missing is kept in a durable holding
  table and answered `held`. It is processed again whenever a document
  for the same chain or agreement arrives, and at every start. After 30
  days unresolved it becomes `refused`. Only a document that is invalid
  in itself is refused at once.
- **Compatibility.** A node without these kinds refuses the push, so
  nothing is read half-understood. `conformance.md` records the kinds and
  domains under a commerce minor version.

### 5.4 The seller's term policy (Core)

An owner setting off the integration allowlist, so no connector or
plugin can change it, set only through a presence-gated owner route:

```
termPolicy: {
  resources: [{
    resource_ref,
    asking: { <term name>: value },            // private: where offers start
    floors: { <term name>: { hard, auto? } },  // hard: never past; auto: Core alone, between needs the owner
    available: { from, to },
  }],
  holding_rules: [{ tag, max_count?, premium_bps_per_count }],
  manual_holdings: [{ holding_id, tag, resource_ref?, start, end }],  // deals made outside Dina
  maxRounds, windowSeconds, maxCountersPerBuyerPerDay,
}
```

- **Private asking terms** reach the runner through a bounded projection
  (this resource's asking terms and the counter only). They are never
  published.
- **Every offer is checked,** the first and every revision. Core moves
  each term to at least its auto floor in the seller's favour, raises an
  owner card when the runner asks between the auto and hard floors, and
  never signs past a hard floor. Floors are not capped at the first
  offer.
- **The holding count** for a deal with tag *t* over `[start, end)` is
  the number of other commitments with tag *t* whose term overlaps it:
  - term agreements this store has accepted and not ended, whether or
    not they have started yet;
  - manual holdings.

  A renewal and the agreement it replaces count once (§5.5). The same
  definition prices the offer and decides acceptance (§7.1).
- **Manual holdings and resources.** A manual holding with a
  `resource_ref` must name one of this store's resources, and it
  occupies that resource for its dates. One without a `resource_ref`
  counts toward its tag and occupies no resource.
- **Holding premium.** Each counted commitment moves every floor in the
  seller's favour by `premium_bps_per_count`. At `max_count` the request
  is refused, with no reason given. The arithmetic uses integers and
  rounds once, in the seller's favour.
- **The juice example.** Two juice agreements overlap the requested
  term, with `premium_bps_per_count: 1500` and `max_count: 4`. A third
  juice brand's rent floor of ₹1,500 becomes ₹1,500 × (1 + 2 × 0.15) =
  ₹1,950. A fourth brand faces ₹2,175, and a fifth is refused. Core never
  knows the tag means juice.
- **Rule changes** apply to new offers. An offer already sent stands
  until it expires, but acceptance re-checks the rules in force (§7.1).

### 5.5 The term agreement

`TermAgreementProposal` is a new document with its own digest domain.
The revenue-share decision, termination, settlement and acknowledgement
documents pin it by digest, so a node that does not know the kind never
holds the proposal and refuses everything that points at it.

```
TermAgreementProposal {
  protocol_version, proposal_id, host_did, vendor_did,   // host = seller, vendor = buyer
  offer_digest,              // the final TermOffer
  pack, resource_ref, general, terms[],   // must equal the offer's, field by field
  replaces_proposal_digest?,
  proposed_at, proposal_digest
}
```

- **Rent only, share only, or both.** `share_bps` may be 0 when `fee` is
  above 0, and the reverse.
- **States.** *Accepted* when the decision exists; *in force* from
  `start`; *ended* at `end`, or at a termination's `effective_at` if that
  is earlier. An accepted agreement counts as a holding (§5.4) from
  acceptance until it ends.
- **Ending is not forgetting.** After an agreement ends, settlements for
  periods inside its lifetime are still accepted, corrected and
  acknowledged. Settlements for periods outside it are refused.
- **Termination.** During a trial, either party may end the deal with
  immediate effect. After the trial, `effective_at` must be at least
  `exit_notice_days` after the termination is issued. Core enforces this
  on what it sends and on what it receives. The issue date is the
  sender's own `terminated_at`, so the receiver also refuses a termination
  dated more than 3 days before it arrived, or after it arrived: a party
  cannot backdate one to skip the notice. A termination dated in the
  trial is granted the trial's immediate effect only if it arrives before
  the trial ends. A refused termination takes effect on neither side; the
  owner who sent it is told, and terminates again, with notice from now.
- **Renewal.** A renewal is a new proposal with
  `replaces_proposal_digest`, the same parties and resource, and
  `start` equal to the old agreement's `end`. Accepting it leaves the old
  agreement in force until its `end`, unlike today's revshare
  supersession, which ends the old one at acceptance. Both count as one
  holding, so a renewal at `max_count` is allowed.

### 5.6 What each period owes

**Periods** are fixed by the agreement, and Core derives the same
schedule on both sides:

- **Trial.** If there is a trial, it is one period from `start` to
  `trial.end`, with full fee `trial.fee`.
- **Regular periods.** The anchor is `trial.end`, or `start` if there is
  no trial. Boundary *k* is the anchor plus *k* calendar months (or *k*
  weeks) in UTC. Month addition always counts from the anchor, with the
  §5.2 month-end clamping, so boundaries do not drift: 31 January, 28
  February, 31 March. Each full regular period's fee is the `fee` term.
- **The ended instant** is `end`, or a termination's `effective_at` if
  that is earlier (§5.5). The period containing it is cut there, whether
  it is the trial or a regular period. No period starts at or after it.
- **A cut period's fee** is `full fee × (seconds in the cut period) /
  (seconds in the full scheduled period)`. It is computed in integers and
  rounded once, half-even, to the minor unit (the one rounding rule,
  `COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md` §9.1).
- **Matching.** A settlement note must match one scheduled (or cut)
  period exactly. A note that overlaps another live note for the same
  agreement is refused, and a correction supersedes by revision, as
  today.
- **A termination that cuts a period already settled.** For term
  agreements only, a correction may also move the note's end back to
  the ended instant, with `fee_due` recomputed. Until that correction
  arrives, the fold uses the cut fee for that period, not the old
  note's figure.

Conformance vectors cover a termination inside the trial, a
termination inside a regular period, and a cut period that was already
settled.

**Each note carries** `gross_sales` (zero is allowed, and a rent-only
deal always has zero), `computed_share` (as today), and `fee_due`, which
Core derives from the schedule and checks on receipt. The
`cash_handler` issues the note, as today. For a rent-only deal the
`cash_handler` must be `vendor`, and the note shows only the fee.

**Who owes whom for the period**, with all amounts in minor units:

- `cash_handler: vendor` (the brand keeps the takings): the brand owes
  the store `fee_due + computed_share`.
- `cash_handler: host` (the store keeps the takings): `net = gross_sales
  − computed_share − fee_due`. If `net` is above zero the store owes the
  brand `net`; if below, the brand owes the store `−net`.

The fold adds these per period, signed, with checked arithmetic that
refuses overflow. Rent never enters the goods ledger: these documents
pin the agreement, and the goods fold (`trade_ledger_service.ts:501-511`)
never reads them. Conformance vectors cover rent only, zero sales, a fee
larger than the takings, a trial boundary, a prorated last period, and a
check that the goods balance does not change.

**Accepted is not paid.** A `SettlementAcknowledgement` accepts or
disputes the figures. It never marks a period paid. Version 1 records no
payments; recording them is Q7.

## 6. Listings, Zeev, and who may ask

### 6.1 What is public

| Data | Lives in | Seen by |
|---|---|---|
| Store, area, slot kind and size, dates free, tags wanted | A **term listing** (a general lexicon, `com.dinakernel.commerce.termListing`) the store's Dina publishes, signed by the store's DID | Zeev, brands, AppView, anyone |
| Asking terms, floors, rules, holdings | The store's Core | The store owner only |
| Requests, offers, counters, agreements, settlements | Both Dinas, sent sealed over D2D | The two parties only |

The listing has a **Core-owned public vocabulary**: `resource_ref`,
`kind`, `size`, `region`, `available`, `tags`, and the pack's
`(plugin_id, schema_major)`. It has **no money field of any kind**. The
pack's schema can narrow `kind` and `tags` to its own lists but cannot
add a field. Core runs a leakage check before publishing, as catalog
publication does (`catalog_publisher.ts:38-50`), and refuses any field
outside the vocabulary. AppView indexes this one general lexicon. It
never indexes a plugin's own schema.

### 6.2 Who may ask

A per-listing access setting, on the `quoteAccess` pattern:
`contacts_or_card` by default, or `anyone`. A brand Zeev matches is a
stranger. Under `contacts_or_card` its first request raises one card for the
store ("Brand X asks about Slot 3. Let them negotiate?"). Approving it
lets that one request go ahead, with request-scoped authority only
(§5.3). It does not make the brand a contact, so its next request meets
the card again. A store that wants a lasting relationship sends a
TRADE_FIRST §8 invite.
Under `anyone` the store skips that card and accepts the leak limit in
§2. The pilot default is Q4.

### 6.3 What Zeev does and learns

- It reads term listings, matches them with brands by area, tag and
  dates, and shows ratings from PeerLens.
- **It hands off without prices.** "Talk to this store" in Zeev's app
  opens the Dina app with the listing URI and nothing else. Zeev's app
  never receives an offer, a card or a result.
- It is not a party, and its DID appears in no document.
- It learns who listed, who searched, and which brand followed a link to
  which store. It never learns a price.
- Its fee is a separate arrangement with each store or brand (Q2). A
  share of the rent would mean Zeev learns the rent; a flat fee does
  not.

## 7. The flow

### 7.1 Steps

1. **Request.** The brand's Dina sends a `TermRequest` to the listing's
   store. It spends probing budget and passes the access check (§6.2).
2. **First offer.** The store's runner proposes from the private asking
   terms. Core applies the floors and the holding premium (§5.4), signs
   a `TermOffer`, and starts its chain.
3. **Counters.** The brand's loop sends `TermCounter`s with its targets.
   The store's runner proposes a revision. Core checks every term and
   answers with revision N+1, a hold, or an owner card.
4. **Ready.** The brand's loop stops when an offer meets every target,
   when rounds run out, or at the deadline (§8). Then the brand's owner
   gets one card.
5. **The brand approves** (§7.2), which sends the proposal. The store's
   Core checks it on arrival:
   - the offer is its own, the head of its chain, unexpired, and
     addressed to this brand;
   - `pack`, `resource_ref`, `general` and `terms` equal the offer's,
     field by field.

   **Offer expiry** is judged on the proposal's own `proposed_at`, which
   the brand signs. The proposal is in time when `proposed_at` is no
   later than the offer's `valid_until`, and it reaches the store no more
   than 7 days after `valid_until`. Judging by arrival time would let a
   sleeping phone expire a deal both sides wanted. A brand that backdates
   `proposed_at` gains nothing past the 7 days, and step 6 re-checks the
   rules in force anyway.

   A failure gets an automatic `AgreementDecision: rejected` with no
   detail, so the brand's card closes. On success, the store's owner
   gets a card showing the deal and a decide-by time, 3 days after
   arrival. After that the card lapses and the brand gets a rejection.
6. **The store approves,** before the decide-by time, which runs the
   **acceptance check** in one Core transaction:
   - the offer is still the head (its expiry was judged in step 5);
   - the floors and holding premium in force still allow these terms;
   - the holding count (§5.4) is below `max_count`;
   - no accepted, unended agreement or manual holding holds the same
     resource on overlapping dates.

   The same transaction records the agreement as accepted, so a second
   acceptance counts it. It then sends the decision. If the check fails,
   the store's card says "no longer available" and the brand gets a
   rejection.
7. **After.** Each period is settled (§5.6). The agreement ends at
   `end`, or earlier by termination with notice (§5.5).

### 7.2 Approval, presence and binding

- **Two new approval payload kinds** in `approval_payload.ts`:
  `term_agreement_proposal` (the brand) and `term_agreement_decision`
  (the store). Each binds every field of the proposal and the offer
  digest. A change to any bound field needs a new approval.
- **Core writes the cards.** Every term, date, duty and label comes from
  the agreement record. Pack text appears only in a block marked as the
  pack's (PLUGIN_ARCHITECTURE §10.4 rule 2), never next to a money term.
- **Presence.** Both approvals need owner presence. A node that cannot
  establish presence at all (a phone with no passphrase) lets the owner
  approve, as for every other gated card, and the card warns that presence
  went unchecked (owner decision, 2026-10-14).
- **One path.** Term agreements are created only by consuming these
  approvals. The direct revshare propose and decide routes
  (`commerce.ts:7651-7711`) refuse term agreements.
- **Retries.** The approval id is the operation id. Approving mints the
  document once and stores it with a send intent in one transaction. A
  retry returns the same document. The send then follows §5.3: resend
  until a receipt arrives, including after a restart between storing and
  sending.

### 7.3 "Results shown only"

Neither owner sees the rounds unless they open them. Each sees one card
at the end. A store sees a mid-way card only when the runner asks
between the auto and hard floors, or for a stranger's first request
under `contacts_or_card`.

### 7.4 Keeping numbers from Brain

- Every new card type, task description, event, result and list response
  gets an owner-only projection: terms, floors and holdings reduced to
  ids, on the pattern of `workflow.ts:626-634`. Unlike today's ready
  notice (`buyer_negotiation.ts:783-803`), no description carries a
  price.
- **Brain may help draft only the parts without numbers:** which tags,
  which rule shapes. The owner enters every number on the form, on all
  hosts, so no price reaches a cloud model.

## 8. The brand's side

The brand's policy:

```
{ targets: {fee, share_bps}, ceilings: {fee, share_bps},
  expected_sales?: Money per period, max_rounds, deadline_seconds }
```

- Directions come from Core's term table (§5.1), never from the offer.
  An offer above any ceiling drops out.
- **Ranking.** With `expected_sales` set, offers are ranked by cost per
  period, `fee + expected_sales × share_bps / 10,000`. Ties go to the
  lower fee, then the seller DID. Without it, the brand's card lists the
  eligible offers side by side, and the owner chooses. Only offers with
  the same currency and period are compared.
- The owner approves the proposal (§7.2), so NEGOTIATION_PLAN's deferred
  "approval within a spending limit" is not needed.

## 9. Where the Dinas run, and the clock

| Option | Keys | Fits? |
|---|---|---|
| **A. The stock Dina app** on the store manager's phone | The store | Yes |
| **B. A Home Node the store owns** | The store | Yes |
| **C. Anything Zeev runs** that holds keys or shows terms | Zeev | No (§2) |

**The clock.** A store's phone may be asleep for hours. Term documents
travel on `commerce.trade`, so they wait in MsgBox (up to 24 hours) and
are resent until a receipt arrives (§5.3). The runner answers when the
app runs. Timings:

- **Counter `respond_by`:** default 12 hours, at most 7 days.
- **Offer `valid_until`:** default 3 days, at most 7. A brand's
  proposal is judged against it as in §7.1 step 5.
- **Seller window:** up to 7 days.
- **Brand deadline:** default 3 days, at most 7.
- **Silence:** a store that has not answered a request or counter by
  its `respond_by`, with resends on the §5.3 schedule, is treated as
  silent, as today.

Waking the app in the background is out of scope for version 1.

## 10. Build steps

1. **Protocol:**
   - the term table and the `general` block, with the date arithmetic;
   - `TermRequest`, `TermOffer`, `TermCounter`, `TermReceipt` and
     `TermAgreementProposal`;
   - `fee_due` and the schedule rules on settlement notes for term
     agreements;
   - the term listing lexicon;
   - digest domains and `conformance.md` entries;
   - conformance vectors: each digest, month-end dates, old-node
     refusal, version and currency mismatch, and the §5.6 money cases.
2. **Core, transport:**
   - the term kinds on `commerce.trade`, with their ingress gates;
   - the listing-bound stranger waiver on send and receive;
   - receipts with outcomes, resend schedules and limits;
   - the durable holding table for documents that arrive out of order.
3. **Core, seller side:**
   - `termPolicy` with its presence-gated route;
   - floor, holding and premium arithmetic;
   - the arrival and acceptance checks;
   - agreement states, notice, renewal and the period schedule;
   - the listing leakage check.
4. **Core, buyer side:**
   - the term loop and its clock;
   - ranking;
   - the proposal approval.
5. **Core, shared:**
   - the first-party pack table, read by the runner binding and the
     money-store gate;
   - the two approval kinds;
   - the one creation path and refusal on the direct routes;
   - send intents;
   - owner-only projections.
6. **Runner:** a term handler that moves halfway on each term, from the
   private asking terms, one device per install.
7. **The Slot Pack:** the first-party manifest (§4), with content from
   Zeev, plus a validator test.
8. **AppView:** index term listings, and refuse any record with a field
   outside the vocabulary.
9. **Phone:**
   - the store's slot and rule form, and the holdings screen;
   - the stranger card;
   - both agreement cards, with "sent" and "delivered";
   - the brand's request flow;
   - the deep link from Zeev.
10. **Tests:**
    - floor, holding and premium arithmetic, including the juice
      example and no first-offer cap;
    - two acceptances racing for the last place in a tag, including
      deals that start in the future;
    - renewal at `max_count`;
    - notice, end, and settling a final period after the end;
    - a store offline for more than 24 hours, recovered by resends;
    - a stranger brand reaching a `contacts_or_card` store and an `anyone`
      store, end to end: the `held` receipt while the card is open, the
      first offer, and a decline; a blocked DID refused;
    - a held document that later becomes `stored`, and one that becomes
      `refused` after 30 days, each with lost receipts and a restart;
    - an unanswered request across a restart, through its `respond_by`;
    - a settlement or termination arriving before the decision, with a
      restart in between;
    - a manual holding blocking its own resource and leaving another
      free;
    - a proposal sent before `valid_until` and processed after the
      store's phone wakes;
    - an app update within a schema major;
    - Brain projections on every surface;
    - a fleet scenario in which a store with two juice brands placed
      gets a third juice brand and a snack brand, and both deals are
      approved on both sides.

A demo for Sudhir needs steps 1–9.

## 11. Open questions

The owner accepted this note's recommendation for each of Q1–Q7 as the
basis of the build (2026-10-14); the questions put to Zeev stay open
with Zeev.

- **Q1 (Sudhir).** Stores and brands use the stock Dina app or their own
  Home Node, and Zeev's app links into it. Is that acceptable for Zeev's
  product?
- **Q2 (Sudhir).** How is Zeev paid? A share of the rent means Zeev
  learns the rent.
- **Q3 (Sudhir).** Will Zeev contribute the category list and default
  rules to the Dina repository, with Dina as publisher (§4)?
- **Q4 (owner).** Confirm the scope changes in §2: slot fees for small
  stores, and strangers asking for offers. Choose the pilot's access
  default (§6.2).
- **Q5.** One resource per deal in version 1. A brand entering ten
  stores runs ten negotiations side by side. Confirm.
- **Q6 (later).** Opening the runner and money stores to plugins from
  other publishers needs its own design and security review.
- **Q7 (later).** Recording payments against settled periods, including
  part payments.

## 12. Not in version 1

- Bargaining over the `general` block (dates, trial, notice, duties).
- Waking a sleeping app to answer.
- Deniable offers (the TRADE_FIRST §3.5 hardener).
- Third-party publishers for the Slot Pack (Q6).
- Recording payments (Q7).

## 13. Review log

**Round 1** (Claude continuity reviewer, 15 findings; Codex, 16; merged
into 17, all taken in draft 3):

| # | Finding | Where fixed |
|---|---|---|
| 1 | Core's signing path is goods-only; a pack schema skips the gates | §5.1–5.3 |
| 2 | Runner and money stores are first-party only | §4 |
| 3 | Pack contents had no manifest fields | §4 table |
| 4 | Listing schema written by Zeev could leak a floor; no general lexicon | §6.1 |
| 5 | The opt-in asking price broke "Zeev never sees a price" | §6.1, removed |
| 6 | A Zeev-built app or console is inside the trust boundary | §2, §6.3, §9 |
| 7 | Strangers and the leak limit were not stated | §2, §6.2 |
| 8 | A minor-version field add lets old nodes mis-bind | §5.3, §5.5 |
| 9 | Timings cannot survive a sleeping phone | §5.3, §9 |
| 10 | Holding counts race; slot let twice; acceptance not re-checked | §5.4, §7.1 |
| 11 | First offers are not floor-checked; floors capped at the first price | §3, §5.4 |
| 12 | The runner prices from the public catalog | §5.4 |
| 13 | Agreement lacked tag, rent-only, expiry, notice; cards incomplete | §5.2, §5.5, §7.2 |
| 14 | Term types, directions and ranking undefined | §5.1, §8 |
| 15 | Rent had no ledger | §5.6 |
| 16 | Approval kinds, presence, direct-route bypass, retries | §7.2 |
| 17 | New cards not redacted for Brain; Brain drafting floors | §7.4 |

**Round 2** (Claude, 9 findings; Codex, 9; merged into 14, all taken in
draft 4, not re-reviewed):

| # | Finding | Where fixed |
|---|---|---|
| 1 | `service.query` lives 300 seconds, so long timings could not work | §5.3 (`commerce.trade`), §9 |
| 2 | Accepted future deals were not counted; count not tied to dates | §5.4 holding count, §7.1 step 6 |
| 3 | Renewal ended the old deal early and was blocked at `max_count` | §5.5 renewal |
| 4 | Ending a deal removed it from settlement | §5.5 "Ending is not forgetting" |
| 5 | The fold had no rule for rent; direction and netting undefined | §5.6 |
| 6 | Periods, trial boundary and part periods undefined | §5.6 |
| 7 | An acknowledgement accepts figures; it is not a payment | §2, §5.6, Q7 |
| 8 | Resends stopped at the relay, which deletes after 24 hours | §5.3 receipts |
| 9 | Term documents lacked `currency` and `protocol_version` | §5.2, §5.3 |
| 10 | Pack pinned by publisher DID and CID, which differ across nodes | §4 identity |
| 11 | The money-store gate still named the Commerce Pack | §4 table of packs |
| 12 | Core read fields that only the pack's schema named | §5.2 `general` block |
| 13 | The seller's offer set the direction of each term | §5.1 Core table, §8 |
| 14 | Month arithmetic and a broken cross-reference | §5.2, §5.4 |

Corrected citations: `negotiation_policy.ts` is 188 lines; the probing
budget is in `provider_ingress.ts`.

**Round 3** (Claude, 4 findings; Codex, 4; merged into 7, all taken in
draft 5):

| # | Finding | Where fixed |
|---|---|---|
| 1 | `commerce.trade` refuses strangers both ways, so a Zeev-matched brand could not ask | §5.3 first contact |
| 2 | A refused proposal was receipted "delivered" and never answered; requests, offers and counters had no resend; resends had no limit | §5.3 receipts, §7.1 step 5 |
| 3 | A document that arrived before its prerequisite was dropped after its receipt | §5.3 order of arrival |
| 4 | Offer validity was unset and judged at processing time, so a sleeping phone could expire a wanted deal | §7.1 steps 5–6, §9 |
| 5 | Period boundaries, proration and the cut instant were undefined | §5.6 |
| 6 | Termination inside a period, or after it was settled, had no rule | §5.6 |
| 7 | Manual holdings named no resource | §5.4 |

**Round 4** (Claude, 2 findings; Codex, 3; merged into 3, all taken in
draft 6, not re-reviewed):

| # | Finding | Where fixed |
|---|---|---|
| 1 | The stranger waiver let the request in, but the store's receipt, offer and rejection were still blocked both ways; the request had no listing fields; §6.2 and §5.3 disagreed on what the card grants | §5.3 first contact, `TermRequest`, §6.2 |
| 2 | A `held` receipt had no rules: whether it stops resends, how a later outcome reaches the sender, its card state; §9's "one resend" contradicted §5.3 | §5.3 receipts, §9 |
| 3 | A request had no deadline to stop its resends | `TermRequest.respond_by`, §5.3 |
