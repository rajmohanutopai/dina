# Commitments in the kernel, agents in the bargaining

> **Status:** design note, draft 3 (2026-10-15). Not built. The owner
> answered the open questions on 2026-10-15 (§16); the note still needs
> the owner's go-ahead before any code changes.
> Draft 2 replaced per-term limits with a value model and an open deal
> structure, and made legibility and evidence kernel duties. Draft 3 adds
> the purpose behind all of it: lowering the combined cost across
> independent businesses (§3), with offers that carry alternatives and
> deals that depend on smaller deals (§6).
>
> **Why now:** Core holds three separate engines that each negotiate
> (§4), each written for one domain, and none lets an agent bargain. The
> Commerce Pack extraction (`RESEARCHER_KERNEL_ARCHITECTURE.md` §5.B1)
> needs to know which half of negotiation stays in Core.
>
> **Order of authority:** `dina_details.md`, then README and ARCHITECTURE,
> then `RESEARCHER_KERNEL_ARCHITECTURE.md` (the money line), then this
> note. Where this note is narrower than the money line, it says so (§12).

## 1. The idea

- **Negotiating is a kernel concept.** Agreeing to anything with another
  party is a commitment, and only Dina may decide whether you are
  committed. Core runs one engine for it, whatever the domain.
- **A deal is an open structure, not a price.** Terms, promises,
  conditions, alternatives, bundles, deals that depend on smaller deals,
  and deals that run for months.
- **Your side is a value model, not a list of floors.** What things are
  worth to you, what you would trade for what, and what you will never
  accept. You confirm it; Core checks every deal against it, with no model
  in that check.
- **What is negotiated is mostly a plugin's.** Beyond the built-in kinds
  (time, place, goods), a pack brings the vocabulary and defaults. It
  never holds your values.
- **The bargaining is open to agents.** An agent may find, shape and
  explain a deal. Its move is only a proposal; the kernel decides what
  binds, and you must be able to understand what binds you.
- **The purpose is a lower combined cost.** Independent businesses, each
  with its own Dina, can plan across their links the way one large company
  plans inside itself (§3).

Agents act freely; Dina holds the line. Negotiation is the plainest case
of that thesis (README, "Agent Safety Layer").

## 2. Why prices, and why that changes

Trade settled on prices because anything richer cost too much to work
out: writing it down, comparing offers, checking it was kept. A price
squeezes what a person wants into one number. Deals were made simple to
fit what people and software could handle, not because simple deals are
better. A shopkeeper and a supplier who know each other already trade in
favours, credit and "I'll take your slow stock if you hold my slot"; they
cannot do it with strangers, or at scale.

Agents make a tailored deal cheap. An agent can find a trade a price never
shows (the brand's lorry passes the store's wholesaler), weigh many issues
at once, write conditions, close a loop among three parties that no pair
could, and keep a running balance between two shops over months.

So Dina should not rebuild the price-era model with an agent bolted on.
What it must keep is the part prices never did: making sure you
understand and agree to what binds you (§9).

## 3. The purpose: a lower combined cost

**Why large companies win.** A small business tunes each layer on its own.
The shop buys stock at a price, ships at a price, sells at a price; every
hand-off is priced, and each price is set without seeing the others. A
large company owns the chain. It sees that its own lorry passes that way on
Tuesday and plans the whole cost at once. Much of the advantage of scale is
this: not better layers, but layers planned together.

**What Dina makes possible.** Separate businesses, each with its own Dina,
can do some of that planning together without merging. Each Dina knows
its own costs, routes and spare capacity. Each proposes a change that
lowers its own cost and shares part of the saving. Step by step the
combined cost falls, the way one firm would plan it inside. This narrows
the advantage of scale. It does not erase it: large companies keep their
capital, volume, brand and risk spread over many products. But the part of
their advantage that comes from planning together shrinks.

This is the spirit of Dina, not a feature beside it. Dina serves one
master, the person or small business that runs it, and the network it
joins has no owner in the middle. The same loyalty that keeps a buyer's
data private lets a small shop keep its costs private while still
co-operating with its neighbours. No central platform takes a cut or sees
the books; each Dina reveals only the change it offers.

**Two kinds of deal it needs, besides the ones in §5:**

1. **An offer with alternatives.** The seller reshapes its offer from its
   own situation: "the price is X; my vehicle passes your way on day Z, so
   if you take delivery on day Z, shipping is ₹40 less." The seller is not
   conceding on price; it has found a cheaper way to serve you and shares
   the saving. Your Dina chooses with your value model: does day Z suit
   you, and is ₹40 worth it?
2. **A deal that depends on smaller deals.** The seller asks its own
   suppliers on your behalf: "my shippers are X and Y; let me ask them
   with your location. If Y is near you on day Z anyway, it costs less."
   The offer to you holds only if the shipper agrees.

**How the combined cost falls, without anyone opening their books:**

- **Costs stay private.** No Dina shows its cost structure. Each offers
  only a change ("₹40 less if day Z") and the share of the saving it will
  pass on.
- **Savings are shared, by bargaining.** How a saving is split is itself a
  term the parties agree. Agents start from an even split and move from it
  by their own judgement (who bears the risk, who did the work, what the
  other side has shown it values); there is no fixed rule.
- **Step by step.** Each change must leave every party at least as well off
  by its own value model. The chain climbs to a point no single change can
  improve. That point may not be the best possible; it is still better
  than each layer alone.
- **Bounded.** Each negotiation has a round limit and a deadline, so the
  climb ends.

**One rule, fixed in the kernel:** Dina helps businesses share routes,
capacity and timing. It never helps competitors agree their prices to
customers. Co-ordinating logistics is co-operation; co-ordinating prices
among competitors is a cartel. What Core can enforce, it does:

- every money part in a vocabulary declares who pays and who is paid,
  and both must be parties to the deal; Core refuses, at pack install and
  on every deal, a money part whose payer or payee is not a party;
- the kernel has a kind for "a price charged to someone outside the
  deal" (a store's price to its customers, a rival's rate), and Core
  always refuses it; a pack may not declare a part of that kind as
  anything else;
- ratio and percentage parts (`share_bps`, a markup) can express a
  price, so they declare payer and payee and are checked like money
  parts; only plain counts and dates (crates, days) are exempt.

What Core cannot see is a pack that mis-declares a part's meaning. For
first-party packs the declarations are reviewed before signing; for third-
party packs this is a stated limit. Free text is not checked by Core;
strategy-written text needs the owner's yes (§11).

## 4. What exists today

| Engine | Domain | Where |
|---|---|---|
| Group coordination | a time and place for many households | `packages/core/src/coordination/group_*` |
| Goods negotiation | the price of a quote | `packages/core/src/commerce/negotiation_*` |
| Term negotiation (shelf space) | rent and share of sales for a slot | `packages/core/src/commerce/term/*` |

The two commerce engines each built their own offer chain, limits, owner
cards, delivery and binding. Term negotiation fixes two terms in
`TERM_TABLE` (`fee`, `share_bps`, `@dina/commerce-protocol` `term.ts`),
with a hard and an automatic floor per term (`term_policy.ts`) and a
holding premium per overlapping agreement. Goods negotiation fixes price,
with floors per line taken from the first quote (`negotiation_policy.ts`).

Their next moves come from different places. In term negotiation it is
Core code, an in-process runner that steps halfway (`term_runner.ts`). In
goods negotiation it is a runner on the plugin lane, first-party or
outside, whose answer Core checks against the floors before it signs
(`supplier_runner.ts`, `negotiation_supplier.ts`).

Group coordination is a different shape. The organiser keeps a private
plan over ordinary one-shot calls; no guest's node depends on it
(`group_plan.ts`). It intersects the guests' free times in the
organiser's order of preference (`group_fold.ts`) and then sends a round
of confirmations (`group_coordination_service.ts`). It has no offer chain
and no binding record on both sides. Moving it onto the engine (§15, step
6) adds commitment it does not have today, so that step must say what it
keeps (required and optional guests, withdrawal, partial confirmation)
and what is new.

None of the three can offer alternatives or depend on a smaller deal.
Brain has no negotiation tool, and shelf space keeps every number away
from Brain on purpose (`SHELF_SPACE_NEGOTIATION.md` §7.4; the Brain
projection in `server/routes/workflow.ts`). §11 replaces that rule for
values.

## 5. Negotiation outside commerce

| Case | What is agreed | What the owner values or rules out | Who may agree | What binds | What happens after |
|---|---|---|---|---|---|
| Dinner with a friend | time, place | calendar, "not before 9", places I like | the agent | an event both hold | reminder, change, cancel |
| Group trip | dates, who comes, cost split | free dates, what I will reveal | the organiser chooses; guests disclose | a confirmed plan | reminders; maybe a split |
| School-run swap | who drives which day | my days, fairness over a term | the agent, within the value model | a standing rota | reminders; a balance of turns |
| Health data for a doctor | what, how long, what for | privacy rules, sensitive personas | the owner, in person | a grant | enforcement, expiry, revocation |
| An outside agent's task | scope, budget, deadline | persona tiers, spend limits | the owner, or a standing grant | a delegation | runs under the grant; audit |
| Shelf space | rent, share, period, a lorry run, a festival back room | rent I'd walk away at, what a run is worth to me | the owner, beyond what the model covers | an agreement | settlements (pack); promises (kernel) |
| Buying stock | price, delivery day, shipping | price I'd walk away at, which days suit me | the agent, within the model | an order with a delivery day | the seller's shipper deal; reminders |

**What every case shares:** a chain of offers each naming the last; a
judgment of whether the deal is good enough for the owner, checked
without a model; three zones (agree alone, ask the owner, never); a
binding record both sides hold; a life after agreement (amend, end,
dispute); delivery to people who are often offline.

**Where they differ:** what a deal is made of (§6), how agreement is
reached (step towards each other, find the overlap, narrow, choose), how
many parties, and what happens after, which belongs to whoever owns the
domain.

## 6. The deal: an open structure

A deal is a set of parts, each of one kind the kernel knows. A pack's
vocabulary names and describes its parts in these kinds. Every deal
document pins the exact vocabulary on the wire: a digest of the vocabulary
itself (parts, kinds, directions, payers), not of a manifest. A pack's two
halves have different manifests (the Slot Pack's seller and buyer halves,
`slot_pack_manifests.ts`) but share one vocabulary (`SLOT_PACK_VOCABULARY`
in `first_party_packs.ts`); each half's signed manifest names the
vocabulary digest it carries, so the digest is authenticated by whichever
manifest a node installed. Built-in vocabularies have digests shipped with
Core. Today `TermPackRef` pins only the pack and its major version.

A node keeps every vocabulary version pinned by a live chain or a live
agreement, by digest, never deleting one while anything refers to it,
and accepts a move pinned to any version it holds. So a chain in flight
finishes on the version it started on, and an agreement can be amended,
ended or disputed years later. For a new deal the sender pins a version
the receiver advertises (in its listing, or in its reply to a request);
the two refuse only when they share none. Tests: a buyer-only and a
seller-only install negotiate on a shared vocabulary; a part whose
direction, payer or kind differs is refused; a chain in flight survives
an upgrade on one side; an agreement is amended after an upgrade.

| Kind | Example | What the kernel can check on its own |
|---|---|---|
| **Number with a direction** | rent; share of sales | against the value model (§7) |
| **Choice** | a time slot; a delivery day | inside the allowed options |
| **Set** | which data is shared; which categories | inside the allowed set |
| **Flag** | exclusive or not | allowed or not |
| **Promise** | the brand carries the store's stock from the Hosur wholesaler on its weekly run (dimensions: up to 2 crates, Tuesdays, for the length of the deal) | only through a value the owner gave it (§7) |
| **Price to a non-party** | a store's price to its customers; a rival's rate | always refused (§3) |
| **Condition** | "rent drops 10% if the month's sales pass ₹50,000" | its outcomes, each checked as a deal |

A **promise** carries who does it, for whom, what, how much, how often
and until when, all as structured dimensions; every quantity and time
lives there. Its description is the owner's own words, carries no
numbers, and goes out only as the owner wrote it. It is not
commerce-specific: "Tuesday works if I bring the cake" is one.

A **condition** names a measurable event and the parts that change when it
happens. The kernel checks every outcome a condition allows, so a
condition can never hide a branch the owner would refuse.

Beyond the parts:

- **Alternatives:** one offer may carry several versions, each a full set
  of parts ("₹X any day; ₹X − 40 if delivery is day Z"). The other side
  accepts at most one, and may name a second that binds only if the first
  cannot (below). Each version is checked on its own (§8).
- **Bundles:** one deal across several resources ("two slots for less").
- **Deals that depend on smaller deals:** an offer may rest on deals its
  maker opens with third parties (the seller with its shipper). The
  dependent offer names them and ends a set margin before the earliest of
  their holds. A version that rests on them binds only with all of them
  (below).
- **More than two parties** (decided, §16): built from two-party deals.
  A group (four families choosing a date) is a two-party deal between the
  organiser and each family; the organiser chooses and confirms each, as
  `group_*` does today. A loop (store gives the brand a slot, the brand
  gives the wholesaler a lorry run, the wholesaler gives the store cheaper
  stock) is one two-party deal per link. A deal with smaller deals beneath
  it is the same shape: one two-party deal per link. In both, the links
  are **bound together or not at all**. For a deal with smaller deals
  beneath it, the order below makes that hold. A loop has no middle party
  to run that order, so loops wait for their own design (§15, step 9).
  One deal document signed by many parties may come later if
  loops become common and the middle-person setup gets in the way;
  nothing in the two-party engine changes for it.
- **Standing deals:** a relationship that runs for months, with a running
  balance of turns or favours, adjusted by small amendments rather than
  new deals.

**How linked deals bind.** The middle party (the seller) sits between
the links, and nodes go offline, so the order of acts is fixed. When
dependent deals ship (§15, step 7), a version may rest on **one option
only**; that keeps every outcome decided by one signed act. Versions
resting on several options need a reserve, confirm and release protocol,
which waits for its own design (§15, step 9).

0. **Your grant comes first.** Before the seller asks anyone with your
   data (your pincode), your Dina sends an onward-sharing grant (§11),
   after its own disclosure check, or after your card where the rules
   send it there. The seller's Core refuses to open a smaller deal that
   carries your data without that grant in hand. Nothing about you
   reaches a third party before you or your Dina agreed.
1. **A firm option.** A party asked for a smaller deal (the shipper)
   answers with a signed option that holds until a stated time and cannot
   be withdrawn before then. It binds the shipper if, and only if, the
   seller's acceptance is signed before the hold ends. The option also
   carries an agreed **delivery condition**: if the acceptance has not
   reached the shipper's node by the hold's end plus a grace, the option
   ends without fault. The grace equals the acceptance's resend life,
   48 hours (twice the relay's 24-hour keep), and resends stop when it
   ends. The shipper cannot check a signed time within that window, so in
   effect the option can be taken up until the hold's end plus the grace;
   the shipper prices it and keeps the capacity held on that basis.

   Issuing an option is the shipper's own commitment, checked by the
   shipper's envelope at issue, with its model version recorded. Taking
   it up within the hold is checked against that recorded version only,
   not the shipper's model at the time: this is the one exception to
   "binding checks the current model" (§7), and it is what firm means. A
   later change to the shipper's model, a closed persona, or a paused or
   removed pack does not revoke an issued option; the owner sees the
   options still out when changing the model, and they run out at their
   hold. A test issues an option, tightens the shipper's model, restarts,
   and takes the option up within the hold; both nodes record it bound.
2. **Dates must fit.** The hold, the grace and the shipper's lead time
   together must end before the date the service is performed (day Z).
   An option that does not fit is refused, and the hold stays within the
   protocol's 7-day cap on deadlines (`term.ts`). So the shipper always
   knows before day Z whether it is bound.
3. **The seller clears the option first.** A version that rests on an
   option is always firm, whatever the kind's usual rule, because a final
   card after your yes could outlast the hold. So before the seller's Dina
   signs it, the seller's envelope (§8) has passed accepting the option,
   capacity included, and the seller's owner has cleared that version on
   a card unless the owner has made this kind firm (§8, "Signing and
   binding").
4. **The upper offer holds for less.** Your yes to an offer that rests on
   an option has its own, shorter delivery grace and resend life: 24
   hours, the relay's keep, replacing the 7-day grace today's proposals
   get (`term_context.ts`). The offer to you ends a margin before the
   option's hold that is longer than those 24 hours. A yes signed in time
   therefore always reaches the seller while the option still holds.
5. **One act binds both.** When your yes arrives, the seller's Core, in
   one local transaction, records your acceptance and signs its
   acceptance of the option, with the option's hold not yet ended. Both
   links bind at that moment, on the seller's signed time; delivery only
   tells the shipper. If the hold has already ended, neither binds: your
   second-choice version binds if your yes named one, otherwise the deal
   lapses, and your Dina is told which and why.
6. **The shipper's answer settles delivery.** The shipper's node answers
   every acceptance with a signed receipt: "admitted at time T", or
   "arrived after the grace". It stores that answer for as long as it
   keeps the deal's records and gives the same one to every resend or
   query, so the answer never changes. A seller that crashes after the
   shipper admitted the acceptance learns this on its next resend, and
   the option stays bound. Only "arrived after the grace" ends the option,
   under the delivery condition both sides agreed in step 1: a bound
   obligation ended by its own terms, not one that never bound. For your
   deal this is a broken link after binding: its fallback, already
   checked by the envelope, applies, and you and the seller are told. It
   is a no-fault lapse: only the shipper's node can see arrival, and the
   relay signs nothing, so neither side can prove who was slow. Both
   sides' signed facts are kept (the seller's acceptance time and
   resends, the shipper's arrival answer), and no party is named at
   fault.
7. **When resends stop without an answer.** After the grace the seller
   stops resending and asks instead: a status query, answered from the
   shipper's stored state, sent whenever the seller next reaches the
   shipper's node. Until an answer comes, the seller's owner sees the
   link as "delivery unknown", and if it is still unknown at the
   shipper's lead time before day Z, the seller's owner gets a card.
8. **Expiry needs no message.** At the hold's end plus the grace, the
   shipper's node records the option as expired unless it has admitted an
   acceptance, and releases the capacity then. An acceptance or query
   that arrives later gets the stored answer. An admitted acceptance is
   never undone by expiry.

**A worked timeline** (t0 is when the option is issued):

| When | What |
|---|---|
| t0 | shipper issues the option; hold ends t0 + 3 days |
| t0 + 1 day | the offer to you ends (margin 2 days, longer than your 24-hour yes grace) |
| t0 + 2 days at the latest | your yes, signed by t0 + 1 day, has reached the seller; the seller signs its acceptance at once, before the hold ends |
| t0 + 5 days | hold plus the 48-hour grace: the option is admitted or expired |
| t0 + 6 days | the shipper's 1-day lead time is over |
| day Z, at t0 + 6 days or later | the delivery |

A test builds this timeline and its edges: a yes at the last moment, an
acceptance at the end of the grace, and a day Z one hour too early
(refused).

"Bound together or not at all" therefore means: the upper version and its
option bind in the same act or not at all. A second-choice version is not
an exception; it is a separate version you named. Before step 7 of §15
ships, tests cover a crash between recording and sending, a lost
acceptance, a resend after restart, a yes arriving as the hold ends, a
crash after the shipper admitted but before the receipt reached the
seller, a seller down past the grace, a shipper's node offline past the
grace (no fault recorded against the seller), an option never exercised,
an acceptance first arriving after expiry, neither node reconnecting
until after the grace, a day Z inside the hold and grace (refused), and a
smaller deal attempted before the grant (refused), each through a
restart. In each, both nodes end with the same binding history and the
same capacity held, and expired capacity can be reused.

**After a chain binds, a link can still break** (the shipper drops out).
Every dependent deal therefore names its **fallback**: what applies if a
smaller deal fails after binding ("standard shipping applies"). The
fallback is checked by the full envelope (worth, limits, disclosure,
capacity) before the deal first binds, as if it were the deal; a deal
whose fallback would fail the envelope does not bind. A broken link is
recorded as evidence against the party that broke it (§13); a lapse under
the delivery condition is no-fault (step 6).

Steps 1 to 3 of §15 bring parts of the first five kinds, alternatives,
two parties and bundles. Dependent deals, conditions, loops and standing deals
follow (§15).

## 7. The value model

The owner's side is a **value model**, kept privately in Core. Each entry
is tagged with the persona it draws on (a value about sharing health data
is tagged health; a business's costs are tagged with the persona the
owner keeps them in). A tagged entry is stored in that persona's own
encrypted vault file, so it is sealed while the persona is locked;
untagged entries live in the identity store. Beside them, the identity
store keeps an **index**: which part kinds and data categories each
persona's entries cover, with no values, limits or rules. A deal that
touches an indexed kind or category of a persona that is closed or
locked goes to the owner's card, since the envelope cannot read the
entry, which may be a never-rule ("never share health data with a
business"). The card asks the owner to open the persona (§8, "Closed and
locked personas"). Tests check that a locked persona's entries cannot be read
at rest or by the envelope, and that a deal breaking a never-rule kept
in a closed persona is carded, not signed.

- **Values:** what each kind of part is worth to the owner, in one unit:
  rupees a month, for every kind of deal at first (§16, item 4). A money
  part in any other currency is unvalued and goes to the owner's card.
  Rent at face value; a weekly transport run, ₹300 a month; a trial one
  month longer, ₹400 a month; delivery on a day that suits, ₹0, and on
  one that does not, minus ₹50 a month.
- **Walk-away point:** the least a whole deal must be worth for the owner
  to take it, per kind of deal.
- **Never:** parts or combinations the owner rules out whatever the
  value ("no exclusivity", "no notice under 15 days", "never share
  health data with a business").
- **Comfort zone:** an auto-sign worth, at or above the walk-away point.
  A deal worth at least this much Dina may sign alone; one worth between
  the walk-away point and this goes to the owner's card. A new model sets
  it high, so little is signed alone at first.
- **Totals:** how much Dina may commit alone in a period, overall and per
  counterparty (rupees a month committed, orders placed). Past a total,
  every further deal goes to the owner's card, however good. Entered on
  the Core form below. Dina still never pays: an order it binds is paid by
  the owner or by an agent under its own spend allowance (Cart Handover).

**How Core counts worth.** Core adds values deterministically, so the
rules are fixed:

- a weekly figure is turned into a monthly one at 52/12, a one-off amount
  is spread over the deal's length in whole months (at least one), and
  each sum is rounded to the rupee against the owner (gains down, costs
  up);
- a value applies to a part only when it matches exactly. A promise's
  value names its dimensions (who does it, what, how much, how often, for
  how long), and the vocabulary says for each dimension which way is
  better. A promise matches a value only if every dimension is the same or
  better. A monthly run does not inherit a weekly run's value; a changed
  or unknown dimension leaves the part unvalued;
- each deal records the version of the vocabulary and of the model it was
  checked against. Binding needs the deal to pass both that version and
  the model in force at the moment of binding; both are recorded. What
  happens when it does not is set once, in §8 ("A yes that fails at
  binding"). An option already issued is the one exception (§6, step
  1).

A business's model also holds its own **costs**, privately: what a
delivery on each day costs it, what spare capacity it has and when. These
let its Dina find a change worth offering (§3); they never reach the
other side or any third party (§11).

**Per-part limits.** Today's floors do not trade one term against
another: a hard floor on share of sales holds however good the rent is.
The model keeps that. A part may carry its own limits: a hard limit acts
as a never-rule, and an automatic limit sends the deal to the owner's card
when the part falls past it, whatever the whole deal is worth. Trading
parts against each other starts only when the owner sets a whole-deal
walk-away point and confirms it. Until then, a part that has a value but
no limits (a promise the owner valued, say) sends the deal to the owner's
card, since nothing weighs it against the rest. Rules that move a limit
(the holding premium for overlapping agreements, goods floors taken from
the first quote) stay as rules the vocabulary declares and Core applies.

**Limit-only models** keep today's behaviour exactly. A model may have
per-part limits only, with no values and no whole-deal walk-away point;
every migrated model starts this way. In it:

- a part governed by limits counts as valued (§8, step 2); only a part
  with neither a value nor limits is unvalued;
- a proposal is first clamped as today, before the envelope runs (§8).
  The signed value and the value the owner is asked about are separate,
  as in `clampTerm`: a part past its automatic limit is signed at that
  limit, or at a value the owner authorised on an earlier card; the card
  asks about the proposal if it is within the hard limit, and about the
  hard limit if it is past it; when the hard and automatic limits are
  equal, no card is raised. The envelope then checks and signs the
  clamped document, and the approval is bound to its exact contents.
  Never-rules still refuse;
- a revision never goes back on what the other side already holds: a
  clamped value is capped at the current offer's, and when the clamp
  would retreat the current offer is kept and only the card is raised, as
  `answerCounter` (`term_seller.ts`) and `settleCounterTerms`
  (`negotiation_supplier.ts`) do today. So a yes to the previous offer
  can still bind it (`bindsAsHead`). Example: current ₹900, hard limit
  ₹800, automatic limit newly raised to ₹950, proposal ₹850: the offer
  stays at ₹900 and a card is raised, as today;
- Core signs an offer alone when every part is within its automatic limit.
  Whether a yes to that offer binds is a separate question (§8, "Signing
  and binding");
- first offers start where today's do: for term deals, from the owner's
  **asking terms**, raised to the limits; for goods, from revision 1 of
  the quote as the runner priced it, with floors taken from it by the
  declared rule.

In a model with values, a revision may make one part worse for the
other side in exchange for another. Then a yes binds only the exact
version it names; an earlier offer cannot be bound in its place.

**Asking terms** (term deals only) are a private starting point per
resource, entered on the same Core form as the limits and migrated from
today's `asking` policy. Brain does not see them before the first offer;
after it, Brain and the other side see only what the offer states, where
a term raised to a limit shows that limit.

A clamped offer shows the automatic limit exactly, to the strategy and
to the other side, as it does today. In limit-only models the automatic
limit is therefore not secret once a proposal falls past it; §11 says
so.

Today's code is the reference: `clampTerm` in `term_policy.ts`,
`clampProposal` in `negotiation_policy.ts`, and the first offer in
`term_seller.ts`.

**The buying side migrates too.** Today's buyer policies map as follows:

| Today | In the model | Secrecy |
|---|---|---|
| Brand's ceilings per term | hard limits | never leave Core |
| Brand's targets | opening position, sent in the request's `wanted_terms` and in every counter, as today | public once sent, like asking terms |
| Brand's `expected_sales_minor` | ranking data only: it ranks offers and shows a cost line on the card, as `rankTermOffers` does today; it is not a value and does not enter worth, so the model stays limit-only and counters within the ceilings go out alone | owner's data: kept from Brain's projection for a migrated model |
| Brand's `max_rounds`, `deadline_seconds` | the negotiation's round limit and deadline | owner's settings, not secret |
| Goods buyer's `target_total` | opening position | public once sent |
| Goods buyer's `budget_ceiling` | hard limit | never leaves Core |

The store, unlike the brand, has no expected sales figure, so on the
store's side share of sales stays a per-part limit.

**The owner does not write the model by hand.** An agent draws out the
values, costs and never-rules: questions ("would you give up ₹200 of rent
for a lorry run each week?"), the owner's past decisions ("you turned down
the last two deals with long notice"), and plain statements. Every change
is shown to the owner and confirmed before it takes effect. The agent
helps the owner say what they want; it never decides it.

The walk-away point, the comfort zone, per-part limits, totals and asking
terms are different. The owner enters them on a Core form that needs the owner
present, as shelf space does today (`SHELF_SPACE_NEGOTIATION.md` §7.4).
Brain never reads that form, never asks for these numbers, and its confirm
cards for model changes leave them out.

**A part the model cannot value** (a kind of promise the owner never
valued, a part the vocabulary does not know) makes the whole deal go to
the owner's card.

## 8. The envelope

Every deal, and every move towards one, passes one deterministic check in
Core before anything is signed. No model takes part. In a limit-only
model the proposal is clamped first (§7), and the steps below check the
clamped document.

0. **Size:** more versions, parts, bundle members or condition outcomes
   than the kernel's caps → refused whole, never cut down.
1. **Never:** any ruled-out part or combination, or (in a model with
   values) a part past its hard limit → refused.
2. **Unvalued parts:** any part with neither a value nor limits → the
   owner's card.
3. **Alternatives:** each version is checked on its own; the owner (or
   Dina, inside the comfort zone) picks among the versions that pass.
4. **Conditions:** every outcome is checked; the deal's worth is its
   worst allowed outcome.
5. **Dependent deals:** each version is checked on its own, and so is
   its fallback after a broken link; a version that rests on an option
   binds only in the same act as the option (§6).
6. **Worth** (in a limit-only model, the clamping rules of §7 apply
   instead): the deal's worth to the owner, from the model:
   - below the walk-away point → refused;
   - any part past its automatic limit → the owner's card;
   - at or above the auto-sign worth → Core may sign alone;
   - otherwise → the owner's card.
7. **Disclosure:** anything the deal or its smaller deals would reveal
   about the owner passes the disclosure rules first. Anything received
   from the other side may go to a third party only under that side's
   onward-sharing grant (§11).
8. **Totals:** a deal that would take the owner past a total for the
   period, overall or for this counterparty, goes to the owner's card
   (§7); at binding, see "A yes that fails at binding".
9. **Capacity:** the deal must fit beside the owner's live agreements and
   holds: the same resource on overlapping dates, promised capacity (two
   crates of spare room promised twice), holding counts. This check runs
   again, with the model version, in the same transaction that records
   the agreement, as the term engine does today (`term_seller.ts`,
   `term_agreements.ts`). Of two deals that each pass alone, only the
   first to bind can take the room.
10. **Binding:** what is signed is exactly what the check saw, bound by
    digest, as today.

The envelope's inputs are the confirmed model, the structured deal and
the owner's live agreements, holds and totals. Conversation, notes and
anything an agent says never reach it.

**Signing and binding.** Passing the envelope lets Core sign an *offer*.
Whether the other side's yes then binds the owner is a separate rule,
declared per kind of deal:

- **firm:** a yes binds, after the checks above run again at binding;
- **subject to a card:** a yes raises a final card, and only the owner's
  approval binds.

Migrated kinds keep today's rule: shelf deals are subject to a card on
both sides (the store's decision card and the brand's proposal card,
`term_seller.ts`, `term_buyer.ts`); goods quotes follow the supplier's
auto or review policy, and the goods buyer binds only by the owner's
award (`buyer_negotiation.ts`). Making a kind firm, or letting Dina
approve the final card alone, is an owner decision on the Core form,
never a default. A version resting on an option is always firm, and its
seller's owner clears it beforehand unless the kind is already firm
(§6, step 3).

**A yes that fails at binding.** One rule per cause:

- **a hard failure** (the room was taken; the deal now breaks a
  never-rule or a hard limit, or its worth is below the walk-away point
  now in force; it needs the entry of a persona that is closed or locked
  and the owner does not open it): the yes
  does not bind, and no card can make it bind. If it named a second
  choice, that version is tried in the same transaction; otherwise the
  other side gets the uniform refusal ("no longer available") and the
  owner is told why;
- **a softer failure in a firm kind** (an automatic limit or the
  auto-sign worth was tightened, or a total was reached): the yes is held
  and goes to the owner's card, which shows the limit the deal now
  breaks. If the owner approves, every hard check and capacity runs again
  in the transaction that binds; if the owner refuses, or 24 hours pass,
  the other side gets the uniform refusal. For a version resting on an
  option, the card lapses at the option's hold end instead, and an
  approval after that binds nothing (second choice or refusal);
- **in a kind subject to a card:** the owner is approving in person, so
  after the approval only the hard checks run again: never-rules, hard
  limits (with any premium), the walk-away point, capacity, holding counts
  and locked or closed entries. Automatic limits, the auto-sign worth and
  totals limit what Dina does alone and do not apply. A hard failure
  refuses with "no longer available", as the store's decision does today
  (`term_seller.ts`, `acceptanceFailure` checks the hard floor, not the
  automatic one). Today a raised floor holds only a revision in
  mid-negotiation (`resendHead`); it never turns a failed acceptance into
  a new card.

Tests change the model between offer and yes, then approve the card.
Tightening a hard limit, adding a never-rule, raising the walk-away
point, or lowering a part's value so far that worth falls below the
walk-away point: none of these binds. Tightening an automatic limit, or
lowering a value while worth stays above the walk-away point: binds,
in both a firm kind and a kind subject to a card. A migration fixture: a
shelf offer of ₹1,100 with a hard floor of ₹800, the automatic floor
raised from ₹1,000 to ₹1,200 before the store decides; the owner
approves, and the agreement binds, as today.

**Closed and locked personas.** When a deal touches an indexed entry of a
persona that is closed or locked (§7), the owner's card asks the owner to
open it: a confirmation for a sensitive persona, the passphrase for a
locked one. Once it is open, the envelope reads the entry and runs every
check, and only then may the deal bind. If the persona stays closed or
locked, the deal does not bind; this holds at binding too. The card
lapses like a softer failure: after 24 hours, or at the option's hold end
for a version resting on an option; then the second choice is tried, or
the uniform refusal sent.

**Inbound gates.** Offers from the other side pass the gates today's
engines already have before the envelope sees them: a probing budget per
counterparty over a window, a daily cap on counters, replay by offer id,
and a refusal that looks the same whatever its reason
(`probing_resistance.ts`, `negotiation_policy.ts`). The general engine
keeps them, and each version of an offer with alternatives counts as
one offer against them. They bound, but do not remove, what the other
side learns:
an offer accepted at once fell in the comfort zone, one answered after
hours went to the owner, one refused fell short. Hiding this would mean
holding every quick yes as long as an owner takes, which defeats the
comfort zone, so the note accepts it, as today's engines do. The other
side learns the zone of each offer it sends, within its probing budget
and daily cap.

## 9. Legibility: a kernel duty

An agent can build a deal far more complex than its owner can follow.
Dina's loyalty means it must not bind the owner to something they could
not follow if it mattered.

So every card that binds a deal carries, in the owner's words:

- **what binds:** every part, exactly, as signed;
- **what it is worth to you:** the model's view, and the walk-away point
  (shown to the owner by Core; Brain's copy of the card leaves it out,
  §11);
- **where the risk is:** promises the other side must keep, conditions
  and their worst outcome, smaller deals it depends on and its fallback,
  how to end the deal;
- **what you would reveal:** anything about you the deal or its smaller
  deals share (your pincode to a shipper);
- **what changed** since the last version the owner saw.

The parts, the worth and the disclosures come from Core. Core renders each
part from its kernel kind, unit and direction ("₹1,600 a month, paid by
you to the brand"); the pack's label and description for it appear
beside it in quotes, marked as the pack's words, so a pack cannot pass
off share of sales as "a small admin fee". A card test uses a misleading
pack label. An agent may add
an explanation, but it sits in its own block, marked as the agent's
words, never beside a bound part or an amount, as `PLUGIN_ARCHITECTURE.md`
§10.4 requires for outside text. Core's list is the authority. What Core
can test: every bound part appears in Core's list; the agent's block
carries no part values; the card's digest matches what is signed. Core
cannot test whether the agent's words are true, and the card says so.

The owner's attention is limited (Silence First). The value model decides
how much Dina agrees alone; a good model keeps the owner out of routine
choices and brings them only what matters.

## 10. The line

**The kernel owns whether an agent may commit the owner, and whether all
sides committed to the same thing.** A plugin owns what is agreed and the
domain's own work afterwards.

| Piece | Kernel or plugin |
|---|---|
| Offer chain: digests, signatures, each step bound to the last | Kernel |
| The kinds of part, alternatives, dependent deals and holds (§6) | Kernel |
| Binding a chain together or not at all; fallbacks | Kernel |
| The value model and the envelope (§7, §8) | Kernel; the values and costs are the owner's |
| Legibility on binding cards (§9) | Kernel (the structure); an agent (the words) |
| Owner cards, presence, approval binding | Kernel |
| The agreement and its life: amend, end, dispute | Kernel |
| Delivery: outbox, receipts, holds, the first-contact gate | Kernel |
| The strategy slot and its brief (§11) | Kernel (the slot); anyone (what fills it) |
| The conversation channel | Kernel |
| Disclosure rules: what an agent may reveal; onward-sharing grants | Kernel (the vault's own policy) |
| Inbound gates: probing budget per counterparty, daily caps, replay, uniform refusal, size caps | Kernel |
| The rule against fixing competitors' prices (§3) | Kernel |
| Promises after agreement: reminders, evidence (§13) | Kernel |
| Built-in vocabulary: time, place, and the parts scheduling needs; goods (price, quantity, shipping, delivery day); delivery (a run on a day, for a fee, with capacity) | Kernel data, shipped with Core, money-free |
| Any other vocabulary: which parts, what they mean, how they read | Plugin data |
| Default values and walk-away suggestions | Plugin data |
| Matching style when no agent is set, for built-in kinds (the group fold; the goods buyer's counter loop) | Kernel data, shipped with Core |
| Matching style when no agent is set, for pack kinds | Plugin data |
| Listings and catalogs: storage, publishing, discovery (money-free) | Kernel, as the money line says |
| Outside sources of offers (a connector's catalogue feed) | Plugin |
| Money after agreement: settlements, statements, khata | Commerce Pack |

A scheduling deal needs no plugin: its vocabulary is built in, and its
after-work is reminders. The Commerce Pack is a plugin because it runs
the money afterwards (ledger, settlements, statements), not because its
deals have prices.

### Where the agent decides alone

The agent is often better at judging a deal than any rule written in
advance, so intelligence is not what draws the line. Four facts draw it,
and they hold however capable the agent becomes:

1. **The other side writes part of what the agent reads.** Its offers,
   labels and messages reach the agent, and a clever counterparty can
   steer it. Core's checks cannot be talked round.
2. **What the agent sees, its model provider sees.** Core never shows the
   walk-away point or the limits to anyone.
3. **Some moves cannot be undone:** a bound deal, money owed, a figure
   revealed.
4. **The owner must be able to check it.** "Code refused it" can be
   tested and audited; "the model judged it fine" cannot.

**The rule.** The agent acts alone wherever it chooses among outcomes the
owner has already accepted. Core decides, or the owner on a card,
wherever a move binds, reveals a private figure, cannot be undone, or
goes past what the owner said yes to.

| The agent decides alone | Core decides, or the owner on a card |
|---|---|
| Which offer to make, when to counter, how hard to push | Whether a deal binds past the automatic limit |
| Which version or partner to prefer, within the owner's values | Never-rules, hard limits, the walk-away point |
| Which smaller deals to explore with known partners | Clearing a version that rests on a partner's run, unless the kind is firm |
| Proposing changes to the value model | Making them |
| Asking the owner a question | Revealing a private figure, or adding a partner |

The rule applies to every agent in a strategy slot, the goods runner
included: anything a runner sends that binds passes the same checks as
a counter (§15 step 10). Where the agent is held back further than the
rule needs, that is a phasing choice to be lifted (§15 step 11), not a
fixed line.

## 11. The strategy slot

The next move comes from a strategy: a fixed style chosen by the pack as
data (the fallback), Brain with a negotiation tool, or an outside agent
through the plugin runner lane (`commerce/supplier_runner.ts` shows the
shape) or MCP. Step 4 of §15 brings the fixed style and Brain; outside
agents come later (§16, item 2). Goods keeps its plugin-lane runner
(§4), which today sees no values or costs and keeps it that way: its
brief is the vocabulary, the deal so far and the catalogue, and its
proposals are charged to the verdict budget like any strategy's. It is
the existing goods path, not a new outside agent, so item 2 holds.

**Judgement, not rules.** Where this note gives the strategy a default (an
even split of a saving, a starting offer, which change to try first), it
is a place to start, and the agent may move from it on its own judgement.
The fixed lines are only those listed below and in the envelope (§8). Code
that pins every choice would make Dina a rule engine with a model attached.

**The brief Core gives the strategy, each turn:** the vocabulary; the
deal so far; the owner's values, costs and preferences, **never** the
walk-away point, the comfort zone or per-part limits; the other side's
moves and messages, marked as data; what the agent may reveal (disclosure
rules); the rule against fixing competitors' prices (§3); time and rounds
left. Values and costs tagged with a persona Brain may not read now are
left out: a sensitive persona's entries need the owner's approval, a
locked persona's are never sent.

**One projection for everything Brain sees.** The brief, and every card,
task, event and list Core returns to Brain about a commitment, pass
through one Core projection. It always leaves out the walk-away point,
the comfort zone, per-part limits, totals and (before the first offer)
asking terms. It also leaves out values, costs
and any worth computed from them when the kind of deal has values
switched off, or when they are tagged with a persona Brain may not read
now. Inbound offers' outcomes reach Brain only through this projection,
under the budget rules below.

This widens the shelf-space rule that Brain sees no number at all
(`SHELF_SPACE_NEGOTIATION.md` §7.4, the Brain projection in
`server/routes/workflow.ts`), but only where the owner has chosen it. A
migrated model keeps today's projection (ids only, no numbers) until its
owner turns Brain on as the strategy for that pack, with a card that says
plainly which numbers Brain, and its cloud provider, will then see. The
same holds wherever Brain is not the strategy. Route tests read cards,
tasks and lists for a migrated model, with values switched off, with
sensitive approval absent and with the persona locked, and check that
nothing withheld appears.

**What the strategy returns:** a proposal (parts or alternatives, and a
note explaining it); a request to open a smaller deal with a named third
party, with what it would reveal; a question for the other side; a
question for the owner; or "stop".

**What Core answers, and what it costs.** A verdict is an act, never a
dry run. `sign` means Core signs the proposal and sends it; `needs the
owner` raises the owner's card, and the strategy waits for it; `refused`
names the part only when a never-rule caused it, and says only "not
enough" when worth or a per-part limit did. Since the strategy knows the
values, every verdict tells it which side of some threshold a proposal
fell: refusals, signatures, cards, and each version of an offer with
alternatives (each version counts as one verdict). So the verdicts on a
strategy's own proposals are charged to budgets kept durably and shared
across restarts, new negotiations and a changed strategy: a small number
per negotiation, and one per owner for each threshold, which no new
negotiation or counterparty resets. The per-owner budget refills at a
set rate each month, sized to the owner's normal trade, and when the
owner changes the threshold.

When a budget is spent, trade does not stop: the strategy is replaced by
the pack's fixed style for the rest of the period, and the owner is told.
The built-in kinds have fixed styles shipped with Core (§10): the group
fold for scheduling (`group_fold.ts`) and the goods buyer's counter loop
(`buyer_negotiation.ts`), both deterministic and model-free today. For
the goods supplier, the plugin-lane runner keeps today's rule: its
per-negotiation budget counts rounds exactly as `maxRounds` does, where a
round that only waits for the owner is not counted, so an approval can
still reach the buyer (`negotiation_supplier.ts`). A test with
`maxRounds` of 1 holds a counter for the owner, the owner approves, and
the next counter carries the approved revision.

A strategy need not see values to probe a limit: it can vary one part and
find where refusals start. So every verdict is charged to the per-owner
budget, whatever the strategy's brief holds, Brain with values off
included. The exceptions are strategies whose output reaches no model
and no outside party: the fixed styles (the pack's, such as the Slot
Pack's step-halfway runner, and the built-in ones). They keep their
existing round limits and nothing more, as today, and so does the goods
runner. Fixed styles are therefore always available as the fallback.

The outcomes of inbound offers (signed at once, carded, refused) are
charged to the sending counterparty's own probing budget (§8), never to
the owner's, so other parties cannot use up the owner's budget. Brain
still learns each inbound outcome's zone: it sees agreements as they
form and cards as they are raised, because it helps the owner with them.
Hiding that would hide the owner's own business from the owner's
assistant, so the note does not try; it counts it instead.

The exposure is stated, not hidden: each verdict gives the strategy at
most about one and a half bits (three outcomes) about the walk-away point,
the auto-sign worth and the per-part limits. In a month Brain can see at
most N verdicts on its own proposals (the per-owner budget) and I inbound
outcomes (bounded by the counterparties' probing budgets and daily caps),
so it learns at most about 1.6 × (N + I) bits. This
bound holds for models with values. In a limit-only model a clamped offer
shows the automatic limit exactly, in one step, to the strategy and the
other side, as today (§7); there the automatic limit is protected only
until a proposal falls past it. With few possible values, 1.6 × (N + I)
bits may be enough to find a threshold exactly. Brain is the owner's own
tenant, and the thresholds are guarded first of all from the other side
(§8, inbound gates); the budget limits what a compromised Brain or a cloud
provider can collect. Tests run an adaptive search over a narrow range, a
campaign of mostly successful proposals, calls at the same time, a
restart, many counterparties sending offers (the owner's budget
untouched), a high-volume seller whose fixed style takes over when the
budget runs out, Brain with values off searching for a hard limit across
new negotiations (charged), and a count of what Brain could observe from
agreements, cards and reminders against the stated bound.

**What offers themselves reveal.** The strategy chooses the terms it
offers, inside the envelope. Core constructs nothing from the owner's
costs; it checks what the strategy proposes. So a strategy that holds
the costs can set a price equal to one, or encode it across several
terms, and the offer will carry it to the other side. Core cannot tell
that from an ordinary offer. Any offer says something about its maker's
costs; this is the same, made exact. The guarantee is therefore: values
and costs never go out as fields of their own or in text; what offers
reveal is bounded only by what the strategy chooses. The defences are
the owner's switch (values off, §16 item 3), the verdict budget, and the
record of every offer kept for the owner. A test copies a cost into an
offer and checks that the owner's record shows it.

**The disclosure rules.** These build on the owner's sharing policy: a
tier per contact (`gatekeeper/sharing`), read the way group coordination
reads it (`coordination/disclosure_policy.ts`). Each field a deal or
smaller deal may reveal names its data category in the vocabulary (a
pincode is location; a dietary need is health). A field goes out only if
the recipient's tier admits its category; the default, with no tier set,
admits nothing, and the owner's card asks.

Today this falls short in three ways, and step 2 of §15 fixes them, with
tests through a restart: per-category tiers live only in memory and are
lost on restart (they become durable); the group resolver knows only
health and general (a location category is added); and only the
`summary` and `full` tiers admit a disclosure. No existing tier changes
meaning: `eta_only` still means arrival times only, and
`exact_location` keeps its meaning. A new tier, `pincode_only`, admits a
pincode and nothing finer; the owner sets it on purpose, per contact. A
test shows a contact on `eta_only` receives no pincode, before and after
migration and through a restart.

**Smaller deals and onward sharing.** A request to open a smaller deal is
checked against the disclosure rules first. From step 7 of §15 the third
party must be a known partner: a contact in the owner's contacts, not
blocked, whose `preferred_for` names the role asked (`shipper`). Revealing
anything the rules do not allow goes to the owner ("may I share your
pincode with my shippers?"). The default is the least that works: a
pincode, never an address.

Your pincode is your data, but it is the seller's Dina that would pass it
on. So your Dina gives a per-deal **onward-sharing grant** before the
seller asks anyone (§6, step 0): which field, for what purpose, to which
kind of recipient (the seller's known shippers). The seller's Core refuses
to put anything it received from you into a smaller-deal request beyond
that grant. Your Core cannot enforce what the seller's node does, so your
card says plainly that this rests on the seller's promise, and a breach is
recorded as evidence (§13).

**What outbound text may carry.** The strategy holds the owner's values
and costs, and Core runs no model, so Core cannot judge prose. Prose can
leak a figure without writing one ("my delivery cost equals the rent you
last offered"). So from step 4 of §15 the strategy writes nothing that
goes out on its own:

- **Sent automatically:** messages Core renders from a fixed set of kinds
  (ask about a part, explain which part changed, offer a version, decline,
  stop), filled only with parts already on the table. No free text.
- **Free text from the strategy** (a note, a question in its own words)
  goes out only after the owner reads it and says yes, like any other
  disclosure.
- **Promise descriptions** are the owner's own words (§6).

Everything outbound also passes the disclosure rules above and is kept
for the owner. (The PII scrub guards text sent to a model; it is not the
check for text sent to a peer.)
Later builds may widen what goes out automatically, once tests show what
leaks. Tests try to send a cost, as a figure and as a reference to a
figure, through each outbound path: rendered message, free text, promise
description and smaller-deal request.

**Fixed, whoever fills the slot:** the walk-away point, comfort zone,
per-part limits, totals and asking terms never leave Core, except as the
offers themselves show them: a first offer shows the asking terms (or a
limit it was raised to), and a clamped offer in a limit-only model shows
the automatic limit (§7); no strategy-written text goes out without the
owner's yes; values and costs never go out as fields or text, though
offers may reveal them (see "What offers themselves reveal"); nothing
binds without the envelope; unvalued parts always reach the owner; nothing
in conversation binds; every negotiation, and every smaller deal under it,
has a round limit and a deadline.

**Values and cloud models.** To bargain well an agent sees the owner's
values and costs. If Brain runs on a cloud model, they go to the provider
the owner chose, through the same router and PII scrub as every other
call. This is on by default (§16, item 3): a provider seeing these numbers
is a small risk. The switch is per pack, as the owner decided. Built-in
kinds, such as scheduling and goods, have no pack, so each gets its own
switch, on by default like the rest. Off means Brain still bargains, but
nothing it sees carries values or costs (the projection above); the owner
may instead pick the fixed style. What must stay hidden is the owner's
hand from the other side: the walk-away point and comfort zone never leave
Core, and values and costs never reach the counterparty, the directory or
any third party as fields or text (offers themselves may reveal them, as
above).

**The conversation channel.** Short messages beside the offers. They never
bind; Core treats every incoming message as data, never an instruction;
they are kept for the owner and fall under the PII rules. The channel is
Dina to Dina only for now (§16, item 5), and outbound messages follow the
rule above. A counterparty without Dina comes later; its offers
will bind only when a Dina side writes them as structured parts and its
owner approves.

## 12. How this relates to the money line

`RESEARCHER_KERNEL_ARCHITECTURE.md` draws the line at money: finding,
comparing and closing stay in the kernel; running the money is the
Commerce Pack. This note agrees, and is narrower in two ways:

- shelf-specific bargaining leaves the kernel: its vocabulary (`fee`,
  `share_bps`) and matching style become the Slot Pack's data. Goods
  vocabulary (price, quantity, shipping) stays kernel data, so signed
  quotes and orders work with the money plugin uninstalled, as the money
  line requires (its B1 and B2 checks);
- promises after a deal are kernel, even inside a commercial deal: the
  lorry run is a reminder and a record, not a ledger entry;
- every shelf agreement settles through the Commerce Pack's `money()`
  adapter. There are no agreements from before step 1 (no users yet, so
  no upgrade), so no old path is kept.

  A kind whose after-work needs the Commerce Pack cannot bind while that
  pack is not active on the node, as money-only capabilities return a
  typed `unavailable` without it (the money line, §5.B1). The owner's
  card says the pack must be installed first, and the other side gets
  the uniform refusal. A test: a Slot-only node tries to renew an
  agreement and is refused, with that card.

  The owner may remove the Commerce Pack at any time: the two sides may
  settle a month between themselves, and Dina serves the owner. Before
  removing it, the owner is told how many shelf deals still have
  settlement work open. The records stay. What the other side sends
  meanwhile is held for 30 days and lands if the pack is back by then;
  after that it is refused, and they can send it again.

**Favours and money.** A running balance of favours between two shops is
kernel (promises and their record). A deal that turns a favour into
rupees owed is the Commerce Pack's. In-kind trade between businesses can
carry tax (in India, GST applies to barter like a sale); that is a
country pack's after-work, not the kernel's.

## 13. After agreement, and evidence

The kernel hands each part to whoever owns its domain:

- **Promises:** a reminder for the party who owes it; the other side's
  Dina may ask "did it happen?" and record the answer as **evidence**:
  who said what, when, with any proof the owner attached. A broken
  promise can be disputed, or be a reason to end the deal.
- **Smaller deals:** a link that breaks after binding triggers its
  fallback and is recorded as evidence against the party that broke it,
  except a no-fault lapse under the delivery condition (§6).
- **Times and places:** reminders and calendar entries.
- **Grants:** the kernel's grant machinery.
- **Money:** the Commerce Pack's settlements and statements.

Kept and broken promises are outcome data that trust (PeerLens) can use.
Only a summary is published ("kept 11 of 12 promises"), never the terms of
a deal, and only once both owners have turned it on for that relationship
(§16, item 6). Past deals are remembered in Core's commitment store, so
the next negotiation with the same party starts from what both know. Brain
reads them only through the one projection (§11). What goes into the vault
for Brain's search is no more than that projection shows for that kind:
for a migrated model or with values off, the deal's parties and dates, not
its numbers. A test searches the vault for a migrated model and with
values off and finds no withheld number.

## 14. Costs and risks

- **Model calls cost money and time.** Agents work in short bursts; the
  fixed style covers gaps and offline phones; built-in kinds have their
  own (§10).
- **Agents fail in new ways:** stalling, odd offers, being talked round.
  The envelope stops harm, not waste; round limits and deadlines bound it.
- **Injection through the other side's words.** Conversation never
  reaches the envelope (§8).
- **Probing.** From the other side: the inbound gates bound what it
  learns, and it does learn the zone of each offer it sends (§8). From
  the owner's own strategy: verdicts are acts, and every verdict is
  budgeted (§11); the exposure is stated in bits, and within it a
  threshold can be found.
- **Leaks through text.** Automatic messages are rendered by Core from
  parts on the table; the strategy's own words need the owner's yes
  (§11).
- **A wrong value model** is the new failure: Dina agreeing alone to deals
  the owner would not want. Every model change is confirmed; the auto-sign
  worth starts high, so the comfort zone starts small; the first deals
  under a new model go to the card.
- **Complexity the owner cannot follow.** Legibility (§9) is tested, not
  hoped for.
- **Chains are slow.** A smaller deal may wait on a shipper who is
  offline. Holds and deadlines bound the wait, and the fallback version
  needs no smaller deal.
- **The climb stops at a good point, not the best.** Accepted: it is still
  better than each layer alone.
- **Over-sharing in smaller deals.** Every disclosure to a third party
  passes the disclosure rules, defaults to the least that works, and is
  shown on the owner's card (§9).
- **Co-operation turning into a cartel.** Core refuses money parts whose
  payer or payee is not a party, and the kernel kind for a price charged
  to a non-party (§3). A third-party pack that mis-declares a part is
  beyond what Core can see. Strategy-written text needs the owner's yes
  (§11), and the brief forbids it.
- **The refactor.** Three engines carry real history (shelf space on the
  test servers, goods on devices). Each move keeps stored documents
  readable, as the money line's extraction plan requires.
- **Mixed versions on the wire.** New document kinds (open-structure
  deals, versions, options, onward-sharing grants, channel messages) come
  under a new protocol version recorded in `@dina/protocol`'s conformance
  changelog. A node refuses kinds it does not know, as shelf space does
  today, and a chain in flight is never moved across versions; it
  finishes on the version it started on.

## 15. Phasing

1. **The commitment engine, from the term engine.** Chain, envelope, cards,
   agreement life and delivery become the kernel engine; `fee` and
   `share_bps` become the Slot Pack's vocabulary; settlements move behind
   the Commerce Pack's `money()` adapter. A node with only the Slot Pack
   (which by design opens no money stores, `first_party_packs.ts`) is
   offered the Commerce Pack before it can bind a shelf deal.
2. **The value model, in its simple form.** Values, per-part limits,
   never-rules, totals, and the Core form for the walk-away point, comfort
   zone, limits, totals and asking terms; storage of tagged entries in
   persona vaults with the index; the per-kind setting for firm or subject
   to a card; the checks at binding; durable per-category sharing tiers
   with a location category (§11, "The disclosure rules"). Today's floors
   migrate with no change in behaviour, as limit-only models (§7): each
   hard floor becomes a hard limit on its part, each automatic floor an
   automatic limit, today's `asking` becomes the asking terms, and there
   is no whole-deal walk-away point until the owner sets one; the holding
   premium and goods floors stay as declared rules. Share of sales stays a
   per-part limit, since the store has no expected sales figure to value
   it in rupees. A migration test replays recorded negotiations, including
   first offers, proposals below the hard limit and values the owner
   authorised, and shows each signs the same terms and raises the same
   cards as before. The replay covers both sides of the recorded shelf
   negotiations, the store's and the brand's. Its fixtures include a
   proposal below the hard limit, equal hard and automatic limits, a value
   the owner authorised, a limit raised during a negotiation (the ₹900 /
   ₹800 / ₹950 / ₹850 case), and agreement binding as well as offers.
   Goods floors, on both the supplier's and the buyer's side (§7, "The
   buying side migrates too"), migrate with goods onto the engine in step
   6, which runs the same replay for them.
3. **Promises, alternatives and bundles, with legibility on binding
   cards.** One release: owner values for kinds of promise and for
   choices such as delivery days, the capacity check across bundles,
   Core's "what binds" list, the agent's marked block, and the card tests
   (omission, the version chosen, a changed promise field). Tested end to
   end on a shelf deal with the lorry case and an owner-entered
   alternative ("₹200 less rent if your run comes on Tuesday"), and a
   test that a valued promise in a model with no walk-away point goes to
   the owner's card (§7). Bundles across several shelf slots (one
   request, offer and agreement over several resources) come with step 9:
   they change listings, holdings, schedules and settlements; step 3
   brings the capacity check that counts every member of a bundle.
4. **The strategy slot.** Fixed style first, then Brain with a
   negotiation tool, values in its brief by default and off per kind of
   deal; the one projection for Brain; the verdict budgets and the
   fallback to the fixed style; the
   conversation channel with Core-rendered messages, Dina to Dina only.
5. **Drawing out the value model with an agent,** every change confirmed,
   including a business's own costs; the walk-away point and limits stay
   on the Core form.
6. **Goods negotiation onto the engine; group coordination onto it.**
   Goods floors migrate here as limit-only models, with step 2's replay
   for goods on both sides, including the ₹900 / ₹800 / ₹950 / ₹850 case.
   Goods keeps its plugin-lane runner, which fills the strategy slot with
   no values or costs in its brief (§11); the goods buyer's counter loop
   and the group fold become the built-in kinds' fixed styles (§10).
   Group coordination keeps required and optional guests, withdrawal and
   partial confirmation, and gains a binding record. Scheduling should fit
   with built-in vocabulary and no plugin; if not, the engine is not yet
   general. The "₹40 less on day Z" case is tested end to end here, with
   the seller's costs (step 5) and Brain (step 4) producing it.
7. **Deals that depend on smaller deals,** one option per version, with
   the binding order (§6), fallbacks checked by the envelope,
   onward-sharing grants and the known-partner check. Tested end to end
   with a goods seller (on the engine since step 6) asking its shippers,
   whose options use the built-in delivery vocabulary (a run on a day, for
   a fee, with capacity), and with the failure tests listed in §6.
8. **Evidence for promises and broken links,** feeding trust under consent.
9. **Later:** bundles across several shelf slots; conditions; versions
   resting on several options, and loops, each with their own binding
   design; standing deals with a running balance; wider automatic
   outbound text.
10. **Close the places looser than the rule (§10, "Where the agent decides
    alone").** Goods floors are measured from the owner's catalogue price,
    or the item's own floors, never from the runner's first price. Every
    price and charge the goods runner sends that a buyer can take up (a
    first quote, its alternatives, the replacement quote with an order
    decision) passes the floor checks a counter passes. A first quote
    cannot wait on the owner, so one below the automatic floor is
    withheld; a replacement quote below it is refused and the order stays
    undecided. An item's own floors stand as set; without a published
    price they hold only in the trading currency and the unit they name.
    No version's total falls below the goods at their floors, so a
    discount written as a charge counts as a price, and Core's own cheaper
    days and partner runs that would go under are not offered. Every
    version, its own terms included and each counter revision, passes the
    seller's never-rules; while a persona holding them is closed, or they
    cannot be read, nothing is quoted or revised
    (`commerce/runner_bounds.ts`). With quotes bounded, automatic order
    acceptance stays. The runner's credit days and how long a quote stays
    open remain its own: the owner has no setting for them yet. The text
    shown when the owner turns Brain on says that, with values on, Brain
    can carry what a part is worth into the terms it offers.
11. **Let the agent decide where the rule allows (owner decision,
    2026-10-17).** Each inside Core's checks:
    - Brain bargains goods counters for the buyer, between the owner's
      target and budget ceiling, through the strategy slot.
    - Brain sets the share of a cheaper day's saving passed to the buyer,
      starting from half (§16, item 7); the owner's chosen share becomes
      a starting point, not a fixed figure.
    - Brain picks a shipper's fee for a run, between the automatic limit
      and the asking fee.
    - Brain makes the store's opening shelf offer.
    - Brain picks the slot in a group booking, among slots every required
      guest accepted; the confirming round still follows.
    - Brain may ask the owner a question mid-deal, as a card; nothing
      binds until the owner answers.

    How each one runs, chosen so a slow or absent Brain never stalls a
    deal (the fixed style plays whenever Brain does not answer in time):
    - **Goods counters:** a tender's window is short (90 seconds by
      default), so each round's counter waits at most a few seconds for
      Brain's target and otherwise goes at the owner's target. Core keeps
      Brain's target between the owner's target and the budget ceiling,
      below the quote it answers; the ceiling stays out of the brief.
    - **The saving share:** quotes are answered at once, so Brain cannot
      choose per quote. Brain sets a standing share, in hundredths of a
      percent of the saving (basis points, 0 to 10,000), which Core uses for every cheaper day and partner run until
      Brain or the owner changes it; with none set, the owner's choice
      (half by default) stands. Each change spends the verdict budget and
      is logged. The floors and never-rules still apply to every version.
    - **The shipper's fee:** the shipper does not answer a request at once;
      it asks Brain and answers the seller's hourly resend. Core keeps the
      fee between the automatic limit and the asking fee and re-runs the
      never-rules. With no answer by the first resend, the asking fee goes.
    - **The opening shelf offer:** the store asks Brain before the first
      offer, with a brief that holds no asking terms, and plays the fixed
      first offer if Brain has not answered within the turn's wait. Core
      raises short parts to their automatic limits and runs the envelope,
      as for any first offer.
    - **The group slot:** a new built-in kind, `group.organizer`, carries
      the strategy setting. With Brain chosen, a fold that leaves agreed
      slots asks Brain to pick one; Core accepts only a slot in the fold's
      agreed list and opens the confirming round. With no answer, the
      owner picks, as today.
    - **Asking the owner:** a yes-or-no question, shown on a card with the
      text scrubbed of anything private. The turn waits for the answer (and
      is not taken by the stale-turn sweep) until the card lapses or the
      deal's deadline comes; the answer goes into the next brief. Free-text
      answers come later.
12. **An exit right when a partner's run fails.** A condition both sides
    sign at binding: if the run a version rests on falls through, the
    buyer may cancel without charge instead of taking the fallback. The
    buyer asks for it in its quote request (`exit_if_run_fails`, minor
    1.5, only with the onward-sharing grant; the owner's buyer setting,
    on unless turned off); the seller grants it on its partner-run
    versions (its own setting, on unless turned off), inside each such
    version's terms digest, so an order naming the version holds it. When
    the run falls through, the seller's fallback notice says so; the
    buyer's owner chooses on a card (a person present) to cancel or keep
    the order on the quote's own terms; a yes sends the cancellation in
    the option family, and the seller's Core cancels without asking its
    runner, but only for an order that holds the right and whose fallback
    it recorded (the race against dispatch still decides). What the buyer
    gives for the right, and Brain deciding either side, come later. A new
    deal with another supplier is an ordinary deal.

Each step ships on its own, with its tests and a dual review.

## 16. Owner decisions

Items 1 to 8 decided by the owner on 2026-10-15.

1. **Groups and loops:** built from two-party deals; a loop, and a deal
   with smaller deals beneath it, are linked two-party deals that bind
   together or not at all (§6).
2. **Who fills the strategy slot first:** Brain only, beside the fixed
   style. Outside agents later (§11).
3. **Values, costs and cloud models:** on by default. Values and costs may
   go to the owner's chosen model provider; the owner can turn this off
   per pack. They never go to the other side or any third party, and the
   walk-away point and comfort zone never leave Core (§11).
4. **The unit of value:** rupees a month for every kind of deal at first.
   The owner is not settled on this: a model can judge across different
   units, so a unit per kind of deal stays open for a later build (§7).
5. **Conversation with people:** Dina to Dina first; a counterparty
   without Dina later (§11).
6. **Evidence and trust:** a summary of kept and broken promises, never
   the terms, published only once both owners turn it on for that
   relationship (§13).
7. **Splitting a saving:** agents start from an even split and move from
   it by their own judgement. More widely, wherever the note gives a
   default, the agent judges; only the envelope and the fixed lines are
   rules (§3, §11).
8. **Who may be asked in a smaller deal:** only the seller's known
   partners (contacts whose `preferred_for` names the role) at first.
   Asking anyone found through the directory comes later, per pack, and
   sharing anything about the owner with a stranger needs the owner's yes
   (§11).

Decided by the owner on 2026-10-17:

9. **Where the agent decides alone:** the rule in §10. Places looser
   than it are defects and close at once (§15 step 10).
10. **Lifting the stricter places:** all six in §15 step 11.
11. **The exit right (§15 step 12):** the buyer asks for it in its quote
    request (the owner's buyer setting); the seller grants it on its
    partner-run versions by its own setting. What the buyer gives for it,
    and Brain deciding either side, come later.

## 17. Not in this note

- Payments of any kind (Cart Handover: Dina never touches money).
- A marketplace or a central catalogue of deals; no platform in the
  middle that sees costs or takes a cut.
- Any plugin or agent changing the envelope or the value model at run
  time; only the owner, by confirmation, changes the model.
- Any help agreeing prices among competitors (§3).
- Grants and agent delegations (§5): they stay on the kernel's own grant
  and gatekeeper machinery. §5 lists them to show what every commitment
  shares, not to move them onto this engine.
