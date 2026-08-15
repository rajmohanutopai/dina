# Photo → Catalog (the seller with no catalog software)

**Status:** design. Nothing built. Sequencing is an owner decision (§11).

**Provenance:** the first draft of this document asserted a reuse story that
three separate checks falsified. Every claim below about existing code was
re-read in the source before it was written down, and the places where the
answer is "nobody has decided yet" say so rather than reading as settled.

## 1. Who this is for

Someone selling a few bottles of pickles. A weaver with eleven products. A
bakery whose price list is a photo on their phone. No ERP, no CSV export, no
intention of acquiring either.

Dina's claim is that a buyer finds a supplier by verified truth rather than by
ad spend. That claim is worth most to this seller, because they cannot buy
visibility at any price. If Dina only serves suppliers who already own catalog
software, the Pull Economy is a feature for people who were already findable.

So: the seller photographs what they have, a model reads it, they check it, and
Dina publishes a catalog under their key.

## 2. What actually goes wrong if this is careless

The first draft justified the confirmation step by saying a wrong extracted
price becomes a binding commitment through `quote_digest`. **That is wrong.**
§10.4 is explicit that indicative price is discovery data — "AppView must not
present those fields as a current contractual offer" — and an order binds to a
separately signed quote (`order.ts`), not to the catalog number.

The real costs of a careless lane, in order of severity:

1. **`pack.sell_unit` is load-bearing.** It is a `Quantity` with a `unit_code`,
   and unit arithmetic runs on it. Unit vocabulary v1 is exactly `each`, `case`,
   `pallet`, `g`, `kg`, `ml`, `l` (`units.ts`), and `kg` carries `baseFactor`
   1000 against `g`. A jar read as `kg` when it is `g` is a thousandfold error
   in every downstream comparison.
2. **A signed public misstatement.** The seller's key signs the snapshot. A
   wrong price is their assertion, republished by strangers, and correcting it
   costs a new snapshot at the next sequence.
3. **Wrong ranking.** Buyers compare on these fields. A mis-parsed price makes
   an honest seller look like a liar or a bargain, both of which cost them.
4. **Private text made public.** Covered in §7 — this is the one that can hurt
   somebody who never agreed to anything.

None of these need the quote path to be dangerous. The confirmation step earns
its place on 1 and 4 alone.

## 3. What exists, what does not

The first draft claimed the pipeline was already built except for one reader.
Verified against source, that is false in three places. Current state:

| Stage | Status | Evidence |
|---|---|---|
| CSV → rows | exists | `parseCatalogCsv` |
| REST records → rows | exists | `catalogRowsFromRecords` |
| **photo → rows** | **missing** | this document |
| rows → `CatalogImportItem` | exists | `importCatalogRows` |
| **`CatalogImportItem` → `CatalogItem`** | **MISSING ENTIRELY** | nothing in `packages/core/src` constructs a `CatalogItem`; the only file naming the type is `catalog_leakage.ts`, in a comment |
| items → snapshot + pointer records | exists, **builds only** | `buildCatalogSnapshot` |
| records → repo | exists; **was publishing records AppView could not read, fixed 2026-08-12** | `catalog_record_writer.ts` |
| head resolution + pointer CAS | exists | the owner publish route supplies `expectedPointerCid` |

Two consequences the first draft missed:

**The middle of the chain is absent.** `CatalogImportItem` is flat
(`unit_code`, `pack_size`, `list_price{currency,minor_units}`). `CatalogItem`
needs `supplier_did`, `catalog_id`, `item_revision`, a non-empty `name`,
non-empty `category_ids`, non-empty `fulfilment_regions`, `pack.sell_unit` as a
`Quantity`, and `freshness.generated_at`. Nothing bridges them. Worse,
`buildCatalogSnapshot` takes `readonly unknown[]` and never calls
`validateCatalogItem`, so a flat item publishes happily and AppView then
refuses to project it — a catalog that signs cleanly and is discoverable by
nobody.

**The importer's bounds are looser than the wire's.** It accepts values that
`Money` and `Quantity` reject. Any assembler must re-validate rather than
assume an imported item is publishable.

**A third consequence, found while reviewing this document.** The publish tail
was not merely unfinished, it was wrong, and had been since it was written. The
writer published pointers to `com.dinakernel.commerce.catalogPointer` while
AppView's handler map, record validator and ingest allowlist all key on
`com.dinakernel.commerce.catalog` — the name §10.2 gives — so no pointer ever
reached a handler. Separately, AppView reads `record.snapshot` and
`record.pages`, and the writer spread the snapshot's fields flat and dropped the
pages entirely, though `buildCatalogSnapshot` computes them and `payload_root`
commits to them. Both halves were green throughout: each side's tests asserted
against that side's own constants and fixtures, and nothing put one side's
output in front of the other. Fixed by moving the collection names and both
record envelopes into `@dina/commerce-protocol`, which both sides already
depend on. **This lane inherits that seam, so it inherits the lesson: a
publisher and an indexer that name the wire independently will disagree, and
neither one's tests will say so.**

## 4. The extraction contract

`CatalogRowSource` is the correct seam — its own note says a catalog is rows
"whatever produced them". But rows have to be columns the importer accepts, and
the first draft's set could not import a single row.

`KNOWN_COLUMNS` is: `sku`, `mpn`, `scheme`, `identifier`, `name`,
`description`, `category`, `brand`, `unit_code`, `pack_size`,
`min_order_quantity`, `lead_time_days`, `variant_of`,
**`list_price_minor_units`**, **`currency`**. Anything else is `unknown_column`
at row 1, and the importer is all-or-nothing: any finding returns
`{ok: false}` with zero items.

So the extraction schema is frozen to that vocabulary. Two consequences:

**Price is two fields, not one.** The model reads a printed amount; something
must convert "₹180" into `list_price_minor_units: "18000"` plus
`currency: "INR"`. That conversion is decimal-exact and never floating point,
and the currency must not come from the model guessing a symbol — `₹` alone
does not distinguish several currencies, and a symbol read off a photograph is
the least reliable glyph on the page.

**But the seller has nowhere to put it yet.** An earlier version of this
paragraph said the currency "comes from the seller's settings", asserting a
source in the same breath as complaining that the first draft did that.
`SupplierSettings` has `publicRegions`, `publishIndicativePrice`,
`customerPricingSource` and connector config, and **no currency field**;
`currency` exists on `BuyerSettings` and inside a connector's price config,
neither of which serves this lane. Since `importCatalogRows` refuses any row
carrying `list_price_minor_units` without a non-empty `currency`, every priced
row fails import until a supplier-level currency exists. That field is net-new
work, and §10 records it.

**Every row needs an identifier, and the pickle seller has none.**
`IMPORTABLE_SCHEMES` is `{gtin, sku}`, and a row with neither is refused
`missing_required` — "every row needs a product identifier". §9.3 forbids
identity by name, and AppView's projection refuses an unattributed identifier.

**A required public field with no source — `category_ids`.** Every published
item needs a non-empty `category_ids`, and each entry goes through
`validateId`, which permits only `[A-Za-z0-9._:-]`. The extraction vocabulary
offers free-text `category` read off a photograph, so "Pickles & Preserves"
cannot become an id at all. Nothing in this lane can invent one either: §12.1
step 10 requires closed, category-governed vocabularies, and which vocabulary
is still open (§27 Q3). The lane therefore cannot take its categories from the
model. The workable source is the seller: a category chosen once in settings
for the whole catalog, or picked per item **during repair** from the governed
list, with the extracted `category` used only as a hint for that choice and
never published. Per item at *confirm* is not available, for the same reason
the SKU is minted at repair: `validateCatalogItem` refuses an item with an
empty `category_ids`, so nothing assembles before the category exists, and
supplying one at confirm is an edit — which returns the draft to `created` and
forces re-assembly (§6). **Which of those, and against which vocabulary, is not decided
here** — it depends on §27 Q3 and is recorded in §10.

**And the same defect in its sibling — `fulfilment_regions`.** Required,
non-empty, and every entry validated as a `RegionRef`. It is not in
`KNOWN_COLUMNS`, it cannot be read off a price list, and no model should guess
where a seller ships. The source is the seller's own settings — the regions they
serve are a fact about their business, not about the photograph — chosen once
and applied to the catalog, with a per-item override where it differs. Naming
`category_ids` and leaving this one unnamed would have failed assembly on every
item for the second reason after fixing the first.

**Open decision — who mints the SKU.** The lane must mint a stable
supplier-scoped SKU and show it to the seller. It has to be minted during
**repair** (§5 step 4), not at confirmation: a row with neither `gtin` nor
`sku` is refused `missing_required`, so the import that gates assembly cannot
succeed until the identifier exists. Stability is the hard part: derive it from
the product name and a corrected typo becomes a different product on
republication, breaking dedup and §9.4 substitution. A monotonic per-catalog
counter assigned when the row is first repaired, stored with the draft, and
never re-derived is the obvious candidate. **Not decided here** — it needs its
own note, because it determines whether a seller can ever edit a name.

## 5. The pipeline

1. **Capture.** One or more images; a price list runs to two pages often.
2. **Extract (Brain).** Schema-constrained rows against §4's vocabulary.
   Unreadable cells come back empty, never guessed.
3. **Draft.** Rows plus findings are persisted as a draft (§6).
4. **Repair.** The seller resolves every finding until `importCatalogRows`
   returns cleanly. Nothing is signed here; this stage exists because the
   importer is all-or-nothing and yields zero items while any finding stands.
5. **Assemble.** Clean rows → `CatalogItem[]`, then `validateCatalogItem` on
   each. This stage does not exist and must be built (§3). It runs **before**
   confirmation, not after, and the reason is in §6: the seller has to be shown
   the bytes that will actually be published, and those bytes only exist once
   the assembler has added what the wire requires.
6. **Confirm.** The seller accepts every model-derived value on the assembled
   items, and the content receipt is taken over exactly those bytes (§6).
7. **Gate.** `gateCatalogForPublication` runs inside `buildCatalogSnapshot`, so
   the refusal arrives during step 8 and refuses the **whole publication**. It
   cannot be cleared by re-confirming: the offending bytes came from a row
   repaired at step 4 and assembled at step 5, so the return path is **edit the
   value → re-import → re-assemble → re-confirm → new content receipt**. §7
   explains why this is the most likely first failure.
8. **Build, in memory, writing nothing.** Core loads the draft, verifies the
   content receipt against it (or, on an exempt class, that its absence is
   legitimate), and builds the snapshot and its pages. Nothing
   leaves the node. `buildCatalogSnapshot` is pure — it computes
   `snapshot_digest` without touching a repo — so the review below needs no
   write to have something to review.
9. **Review.** Core presents the canonical `snapshot_digest` and the item set to
   the owner, who approves it. This is §12.1 step 11.

   **It runs before the first write, and an earlier version of this document
   put it between the two writes.** That version argued a snapshot with no
   pointer naming it is unreachable, so a refusal cost nothing. That is false.
   The writer puts the snapshot into the node's own AT Protocol repo, where it
   is publicly readable and on the firehose the moment it lands — AppView even
   has a path for a snapshot that arrives before its pointer. So the bytes an
   owner might decline would already be disclosed, permanently, and the review
   exists precisely for the disclosure the automated gate disclaims: person
   names and addresses off a photograph, which §12.1 step 10 says it does not
   promise to detect. A review after publication is not a review.

   Because the build is pure, the approved bytes have to be **held on the
   draft** across the owner's decision (§10 item 8), not rebuilt afterwards: a
   rebuild re-mints `published_at` and changes the digest the owner approved.
10. **Publish.** Re-check the §16.2 restore fence and commerce availability
    **before the snapshot write**, not only before the pointer. The shipped
    route checks once at request start and once immediately before the pointer,
    which was sound when build and write were milliseconds apart and is not
    once an owner decision sits between them. Then write the approved snapshot,
    then the pointer under CAS on `expectedPointerCid`. Snapshot first, pointer
    last, always.

    **A failed pointer write is not the same as a lost race, and Core cannot
    currently tell them apart:** `publishCatalogRecords` wraps that write in one
    `try/catch` and returns `pointer_write_failed` for every error. The
    distinction has to exist before the recovery rule can, because the two need
    opposite responses.
    - **Lost swap** (the head moved): rebuild against the new head, which
      changes `snapshot_sequence` and therefore the digest, and take a fresh
      review. The content receipt survives; the items did not change.
    - **Write failure with the head unchanged** (a network blip): retry the
      pointer write with the already-approved bytes. No rebuild and no new
      review. Rebuilding here would re-mint `published_at`, produce a second
      snapshot at the same chain position, and spend an owner's review on a
      mechanical retry — and the writer's own documented recovery is the
      opposite: the snapshot is durable, so a retry only rewrites the head.

    Distinguishing them needs either a refusal that separates the repo's
    `InvalidSwap` from other errors, or a re-read of the head before deciding.

    **And a third case the other two would misclassify.** The shipped route
    records the new head only after the repo accepts the pointer, so a crash or
    lost response in between leaves a draft holding a stale
    `expectedPointerCid` for a catalog that is already published. A retry sees a
    moved head, calls it a lost swap, rebuilds at the next sequence and asks the
    owner to review a publication they already approved — spending a chain
    position and a review on work that succeeded. So the head re-read has to ask
    *which* head: if it already names this draft's own held `snapshot_digest`,
    the answer is **already published**, the draft goes terminal, and no rebuild
    or review happens.

    Digest equality alone is not enough, because it only holds while nothing
    else has advanced the chain — and case 1 exists precisely because something
    can. **But the chain this would need is not one the records carry.** There
    is a single pointer record per catalog, rewritten in place at
    `rkey = catalog_id`; it holds one `previous_snapshot_digest`, and
    `CatalogSnapshot` carries no predecessor link at all. A walk back through
    history terminates after one hop, always — not merely when history has
    aged out.

    So the check is exactly two comparisons, stated as the limit it is: the
    draft is already published if the live head's `snapshot_digest` **or** its
    `previous_snapshot_digest` equals the held digest. Anything further back is
    **inconclusive**, which is the normal outcome once two more publications
    have happened, not a rare one. An inconclusive answer must not silently
    republish: it goes to the owner as a question.

    Making this exact would need a predecessor link on the snapshot record — a
    §10.2 wire change, recorded in §10 as an open decision rather than assumed
    here.

## 6. The confirmation contract

The first draft described this as UI behaviour and called it the safety
mechanism. It was not enforceable and nothing checked it — the same shape as a
test that cannot fail. §12.1 step 11 already states the requirement:

> The owner's publication review binds the digest of the exact canonical
> snapshot bytes: what the owner approved is byte-identical to what is
> published, and a changed snapshot is a new review.

So confirmation is a **persisted state machine with a cryptographic receipt**,
not a screen. The states, in order, are:

`created → confirmed → prepared → approved → published`

Each of §6's four operations advances exactly one of those transitions and
refuses a draft that is not in the state before it, so the order is enforced
rather than assumed.

**The two bindings answer different questions, so only one of them is
class-conditional.**

- The **content receipt** asks *did a person vouch for values a machine
  invented*. On an `owner_authored` or `source_parsed` draft nothing was
  invented (§6), so there is nothing to vouch for: `confirm` runs on every
  draft, but on those two classes it demands no presence, mints no receipt, and
  exists only to advance the state. `publish` verifies a receipt for
  `model_derived` drafts and verifies its absence is legitimate otherwise.
- The **snapshot approval** asks *did the owner approve these exact public
  bytes*. That is §12.1 step 11, it applies to every publication regardless of
  where the values came from, and `approve` therefore **requires presence on
  every class**. An `approve` that skipped presence for connector drafts would
  let the client holding the owner capability record its own approval, which is
  the software asking itself.

**So a fully unattended publication is not possible in this design, and that is
a real constraint rather than an oversight.** A nightly ERP sync cannot push a
new catalog while nobody is looking; someone approves the digest. §12.1 step 11
says the owner's review binds the published bytes, and a lane that quietly
exempted its automated path would be claiming compliance it does not have.

**This is the one decision in this document that belongs to the owner rather
than to the lane, and §10 item 14 states it rather than leaving it here.** The
rule reaches every catalog publication in the commerce vertical, not only
photographs, and it contradicts §8.3's `catalog refresh cadence` setting and
§17.3's treatment of catalog refreshes as scheduled work. Nothing below assumes
the answer.

**A lost swap or a fence abort resets the draft to `confirmed`, performed by
Core.** After either, the draft sits in `approved` holding bytes that are now
wrong, and the recovery is to rebuild — which is `prepare`, which requires
`confirmed`. Rather than widening `prepare`'s precondition and breaking the
invariant that each operation refuses a draft not in the preceding state, Core
moves the draft back to `confirmed` itself as part of handling the failure,
voiding the held snapshot, its pages, `expectedPointerCid` and the approval,
and leaving the assembled items and the content receipt intact. The next
`prepare` then sees exactly the state it expects. Note the asymmetry with an
edit: an edit changes the items, so it voids the receipt too and returns the
draft to `created`; a CAS loss does not touch the items.

**`published` is terminal.** Once the pointer write is accepted the draft
accepts no further operation, and a publish call against a terminal draft
returns the existing publication rather than starting a second one.

**A republication starts a NEW draft.** Correcting a price or adding a product
after publication does not reopen the terminal one — that would make "terminal"
a comment rather than a rule. The new draft inherits the assembled items, the
minted SKUs and the per-field provenance of its predecessor, and is
`model_derived` if the original was, so the edited fields need confirming again
and the unchanged ones do not.

Inheritance is not verbatim, and two fields say so. Assembly **re-mints
`freshness.generated_at` and bumps `item_revision`** for the new draft: the
first is a required published field AppView indexes, so carrying the original
forward would publish a false statement about when the data was generated, and
the second identifies contents that have changed. The "minted once and never
re-derived" rule of §10 item 8 holds **within one draft's life**, which is what
it is for — it stops a rebuild during the review pause from moving the digest
under an approval.

Naming the states matters for one case in particular, covered in §5 step 10: a
crash between the accepted pointer write and Core recording the new head leaves
a draft that has published but does not know it.

**Per-field provenance.** Every field carries `proposed | accepted | edited |
not_model_derived`, and where a model produced the value, the extraction's
model and schema version with it.

The fourth state is not decoration. An earlier version listed three and then
said elsewhere that seller-supplied and deterministically-derived fields "do
not need accepting" — with no state in which to say so. Most of a published
item is in that position: `category_ids`, `fulfilment_regions`, the currency
and the minted SKU come from the seller or the system (§4), and
`supplier_did`, `catalog_id`, `item_revision` and `freshness.generated_at` are
minted by the assembler (§3). All are required. Without a state for them the
Core-side check "no model-derived field is still `proposed`" has no defined
answer: fail-closed refuses every publication, and fail-open makes
model-derived something the caller asserts, which is the enforcement standard
this section rejects.

**A field with no recorded provenance is treated as `proposed`**, so the
missing case blocks rather than passes.

**Core writes the provenance; the caller never supplies it.** Same rule as the
draft's class, and for the same reason — a state that exempts a field from
confirmation is worth forging. Core knows which fields the extraction produced
(they came back from the model in `prepare`'s upstream step) and which the
assembler minted or the seller's settings supplied, so it can mark
`not_model_derived` itself. A caller-supplied marker would let a client label
every extracted field exempt and satisfy "no model-derived field is still
`proposed`" with nothing confirmed at all, which is the caller-asserted shape
this section rejects for the receipt and the approval. `publish` is the
operation that enforces the rule.

**No model-derived field publishes while `proposed`.** An earlier draft blocked
three fields — `list_price_minor_units`, `currency`, `unit_code` — and let the
rest publish unconfirmed. That list was wrong twice over. It omitted
`pack_size`, which multiplies into `pack.sell_unit` and carries exactly the
thousandfold risk §2 opens with. And the principle behind it does not survive
contact with `name` and `description`, which are the fields a private phone
number actually lands in (§7) and which reach the public record verbatim.
Enumerating the dangerous fields is the same mistake as enumerating the
dangerous inputs: the rule is that **a machine-derived value the seller never
looked at does not get signed by the seller's key.** Fields the seller supplied
themselves, and fields derived deterministically from confirmed values, are not
model-derived and do not need accepting.

**Two receipts, because one cannot exist yet.** An earlier draft had
confirmation produce a receipt over the canonical snapshot digest. That
sequencing is impossible. `snapshot_digest` is computed in
`buildCatalogSnapshot` over a record that includes `snapshot_sequence` — read
from the chain head at publish time — and `published_at`, which the publish
route defaults to now when the caller omits it. Neither value exists while the
seller is confirming, so the digest they would be signing cannot be computed
until after they have finished.

So the binding is in two steps:

1. **At confirm — a content receipt** over the digest of the **assembled
   `CatalogItem[]`** and its per-field provenance.

   **Core mints it and Core keeps it; no caller ever presents one.** An earlier
   version said only "cryptographic receipt", which left two readings with
   opposite trust properties — and the caller-presented reading is exactly the
   forgeable token this section rejects, since the client holding the owner
   capability could mint its own. So: on the confirm call, after the presence
   check below, Core writes the receipt onto the draft. Its preimage is the
   canonical encoding of the assembled items, the per-field provenance, and the
   content revision it was taken at (§10 item 8). Because it never travels,
   replay by a caller is not a threat the design has to answer; what Core must
   refuse is a receipt whose content revision is **not equal to** the draft's
   current one, which is a comparison it makes against its own stored value.
2. **Before publishing — the §12.1 step 11 snapshot review**, binding the exact
   canonical snapshot bytes, as the spec already requires. It is §5 step 9 and
   it runs before any record is written, because the first write is already a
   public disclosure.

**The receipt covers assembled items, which is why §5 assembles before it.** A
previous version of this section had the content receipt cover the confirmed
*rows* and then asked Core to check those against the published item set. Those
two can never match: §3 lists what the assembler adds — `supplier_did`,
`catalog_id`, `item_revision`, `category_ids`, `fulfilment_regions`,
`pack.sell_unit` as a `Quantity`, `freshness.generated_at` — and the last is a
timestamp minted during assembly, so the comparison was not merely unequal but
non-deterministic. Reordering fixes it: the seller confirms the bytes that will
be published, and `freshness.generated_at` and `item_revision` are minted at
assembly, stored in the draft, and never re-derived afterwards. A rebuild that
re-mints either of them breaks the receipt, which is the correct outcome.

**Core publishes from a draft, and the item-list body is retired.** An earlier
version of this section had the lane publish a draft id while leaving
`POST /v1/commerce/catalog/publish` accepting `body.items` as before, and
claimed a caller then "cannot substitute an item set it was never given the
chance to name". That was wrong, and wrong in the way this document keeps
catching: both routes sit behind the same `ownerOnlyGuard`, holding the same
boot-minted capability, and the client running the photo lane holds it. Nothing
stopped that client from assembling `CatalogItem[]` and posting them to the
unreceipted route. A rule the caller can decline to use is a convention, not an
enforcement point.

So the rule is Core-checkable or it does not exist:

- **Every** catalog publication goes through a draft. The item-list request
  body is retired; the publish route takes a draft id.

**Which means more than one operation, and the document has to say so.** The
review sits between building and writing and can outlast a process restart, so
the single shipped handler — which builds and writes inside one request — is
not a shape this lane can use. Four Core operations, each owner-guarded and
each taking a draft id:

| Operation | Does | Writes to the repo |
|---|---|---|
| confirm | on `model_derived`: presence check, mint the content receipt. On the other classes: advance the state only | no |
| prepare | build the snapshot and pages, hold them with their content revision, return the canonical digest for review | no |
| approve | presence check (**every class**), record the owner's approval of the held snapshot | no |
| publish | verify the content receipt (`model_derived`) or that its absence is legitimate; verify the approval, the content revision and per-field provenance; re-check the §16.2 fence; write snapshot, then pointer | yes |

**`approve` is separate because otherwise nothing records it.** An earlier
version of this table had three operations and still had `publish` verify an
approval, which left only one way for that approval to arrive: in the publish
call, from the caller. That is the caller-presented token this section rejects
above — the client holds the owner capability, so it could approve its own
snapshot with no person present, and §12.1 step 11 would be satisfied on paper
by the software asking itself.

So `approve` takes the draft id and the digest being approved, and **Core
compares that digest against the snapshot it is holding** rather than trusting
it; a mismatch is a refusal, not a new approval. It carries the same presence
requirement as `confirm` (§10 item 9), because it is the step where the person
is doing the actual looking.

`POST /v1/commerce/catalog/publish` becomes the last of these and loses its
`items` body. Only that one writes, which is what makes "nothing was disclosed"
true of a declined review.
- Each draft records the **provenance of its values**: `owner_authored`
  (a file the owner wrote and uploaded), `source_parsed` (rows fetched
  deterministically from a source the owner configured), or `model_derived`
  (this lane).
- **Core assigns the class from the entry point used, and the caller never
  states it.** A draft created by the extraction route is `model_derived`; by
  the connector sweep, `source_parsed`; by an uploaded file, `owner_authored`.
  A draft whose class cannot be established is `model_derived`, so the
  fail-closed direction is the one that demands a receipt.
- Core requires a content receipt for `model_derived` drafts and refuses to
  publish one without it.

**And there is a residual hole, which belongs in the open rather than in a
claim.** An earlier version of this section asserted "the caller cannot choose
which rule applies to it". That is not earned. Every owner commerce route sits
behind one guard holding one secret, so a client that holds the owner
capability and has model-extracted rows can serialise them as CSV and create a
draft through the deterministic-parse entry point. Core cannot tell that file
from one the seller typed. Assigning the class server-side removes the *easy*
bypass — no caller can simply declare itself exempt — and does not remove that
one. It is recorded in §10 rather than papered over, because a rule whose
limits are undocumented gets trusted past them.

Retiring the item-list body is a change to a shipped route, and this document
is proposing it rather than assuming it. The alternative — leaving the route and
documenting the bypass — means the safety property in this section is advisory,
and §6 already rejects that standard for the first draft's version of itself.

**Why `source_parsed` is exempt, stated on the property that actually
distinguishes it.** An earlier version said the other lanes were exempt because
"the owner authored the file", which is false for two of the three connector
kinds: `spreadsheet_url` and `rest` fetch a remote document through the
credential broker, and the owner never saw those rows either. The real
distinction is not authorship but **inference**. A CSV parser and a REST reader
map bytes to fields deterministically; a wrong value there is the source's
error, faithfully carried, and the owner can correct it at the source. A model
reading a photograph *invents* values, and no amount of care at the source
prevents that. Receipts are required where something was invented.

That line is defensible but not free: an ERP connector can still publish under
the owner's key values the owner never read. That risk is real, it is out of
this lane's scope, and §10 records it rather than leaving it implied.

**What "owner-authenticated" has to mean here, because the default is not
enough.** On mobile both halves share one VM, the owner's calls run
`trustedInProcess` with no signing, and the owner surface is a boot-minted
capability held by the app — its own comment calls it defence in depth rather
than a hard boundary. A receipt minted under that alone proves the app called
Core, not that a person read anything, and person-proof is the entire claim
this section rests on. Confirmation must therefore require a **user-presence
step Core itself demands**, not a token the process already holds.

An earlier version pointed at "the same class of check that guards a sensitive
persona". That was the wrong target and would have shipped nothing: the
sensitive tier is gated by an `approved` boolean the caller passes, and the
shared boot helper passes `approved: true` for every persona, so on mobile the
named mechanism is a flag the calling process already sets for itself. Naming a
remedy without checking what it does is how the first draft of this document
went wrong, and it happened again here.

**The mechanism exists, and two earlier revisions of this paragraph said
otherwise.** The first named the sensitive-persona tier, which takes a caller
boolean. The second named "passphrase re-entry of the locked-persona class" and
asserted that seed unwrapping was the only secret Core validates, and that the
presence step was therefore net-new in both storage modes. That is false.
`apps/home-node-lite/core-server/src/persona/passphrase_unlock.ts` holds a
per-persona Argon2id verifier — `verifyPassphrase`, `PassphraseRegistry.verify`,
constant-time compare — and `registerPersonaRoutes`' unlock handler gates the
**locked** tier on it: 501 when no verifier is configured, 401 unless
`passphrases.verify(persona, passphrase)` succeeds, and no `approved` boolean
anywhere on that path. Core tests the input rather than being told it was
tested, which is exactly the shape required, and it does not depend on the
storage mode.

Three rounds of review found this paragraph naming a remedy without reading it,
which is worth recording as a habit rather than three separate slips: a
plausible mechanism name is not a mechanism.

**What is actually missing is narrower, and it is the difference between
"absent" and "unwired".** `registerPersonaRoutes` has no production caller —
only a test registers it — and `PassphraseRegistry` keeps its records in a
`Map` with no SQLCipher backing, so nothing survives a restart. There is no
mobile equivalent, and nothing binds a verification to a single action rather
than to a session. So the work is persistence, a production caller, a
per-action binding, and a mobile path; it is not designing a presence primitive
from nothing. §10 item 9 records it that way.

Until that wiring exists, the honest statement is weaker, and the document says
it plainly: the receipt records that the lane ran and that a confirmation call
was made, and nothing more.

**Findings drive the repair surface; assembled items drive the confirm
surface.** Because `importCatalogRows` returns zero items on any finding, the
*repair* screen (§5 step 4) is built from the extracted rows plus findings —
imported items will not exist on a first pass. Re-running `importCatalogRows`
cleanly is the gate to assembly, and only then does the *confirm* screen
(§5 step 6) show assembled items. Two screens, because they are shown at
different times and only the second has anything a receipt can cover.

**What this cannot do.** At best — with the user-presence step above — a
receipt proves a person acted. It cannot prove they read anything. The contract
makes an inattentive confirmation *possible*; it makes an *unnoticed* one
impossible.

**Tests that must exist.** Publication refused when: any model-derived field is
still `proposed`, asserted per field rather than on a sample of three; the
content receipt is missing **on a `model_derived` draft**, with the mirror case
asserted too — a `source_parsed` draft publishes with none; the draft changed
after the receipt was taken, so
the stored receipt's content revision no longer equals the draft's; a rebuild re-mints
`freshness.generated_at` or `item_revision`; confirmation is attempted without
the user-presence step **on a `model_derived` draft**; `approve` is attempted
without the presence step **on any class**, including `source_parsed`, since
§12.1 step 11 is not class-conditional; and the owner has not approved the
snapshot digest at §5 step 9.

That last one is asserted by checking that **no record of either kind was
written** — not that an error was returned, and not merely that no pointer
exists. A version of this design wrote the snapshot before the review, so a
test watching only the pointer would have passed while the reviewed bytes were
already public.

Two more that follow from the review preceding the writes. After an owner
approves, restarting the node between step 9 and step 10 must publish **the
approved digest**, not a freshly built one; that fails if the built snapshot is
not durable, which is the state §10 item 8 now requires. And editing the draft
during the pause, then re-confirming, must be **refused at publish with no
record of either kind written** — the new content receipt is current, so only
the content revision recorded on the held bytes catches it, and without that
test the lane publishes precisely the content the seller removed.

Three on the state machine and provenance. Publication is refused when no
approval was recorded **through the `approve` operation**, so a digest supplied
in the publish call cannot stand in for one; the operations refuse a draft that
is not in the preceding state, so they cannot run out of order — with a CAS
loss asserted separately, because Core resets the draft to `confirmed` first
and the rebuild must then be accepted rather than refused; and a publish
against a `published` draft returns the existing publication rather than
starting a second one, asserted by checking that **no second snapshot was
written**. On provenance, an assembler-minted field and a seller-supplied field
must both publish while marked `not_model_derived` and never `accepted` — and a
field with no provenance at all must block, which is the case a fail-open
implementation passes and a correct one refuses.

Two more that are properties of the design rather than cases. The publish path
must take a draft id and no item list, so a test handing it items should fail
to compile or be refused outright — and it must fail when the draft lookup is
replaced by a caller-supplied set, not merely exercise a happy path. And a
`model_derived` draft must be refused publication with no content receipt while
a `source_parsed` draft publishes without one, so that the exemption is
exercised in both directions; a test that only ever publishes model-derived
drafts would pass with the provenance check deleted.

## 7. Privacy

Three distinct hops. The first draft addressed only the third.

**Hop 1 — the image reaching a model. Unresolved and the most serious.**
Brain routes to cloud providers (BYOK), and the egress gate is text-only:
`checkCloudGate` scrubs a string, and `ChatMessage.content` is a `string`. No
scrubber removes a neighbour's phone number from a photograph. A design that
sends the frame to a third party while claiming Absolute Loyalty is
contradicting itself.

**Required before build:** either on-device extraction by default, or an
explicit Core-enforced egress decision naming the destination provider, with
scoped consent, EXIF stripping, and a fail-closed test proving an image cannot
reach a remote provider without approval. This document does not choose;
choosing is a security decision for the owner.

**Hop 2 — private text the model copies into public fields.** A phone number on
the same page can land in `name` or `description`. `gateCatalogForPublication`
catches some of this, but it does not promise person-name detection and
excludes addresses. AppView does **not** rescue it: the earlier claim that
AppView "sweeps every text and jsonb column" was wrong on both halves. §25.2 is
a list of plugin security tests; the runtime gate is Core-side; and AppView
retains publisher bytes in `pages_json` verbatim because it "cannot classify a
stranger's string as a secret". Treat every extracted string as private-origin
until reviewed.

**And the gate has a hole this lane walks straight into.**
`collidesWithProductNumber` returns true for `PHONE`, `PAN` and `IFSC`
unconditionally, and `PRODUCT_NUMBER_FIELDS` is `{value, sku, mpn}` — so a
phone number sitting in `sku`, `mpn` or a `value` field is deliberately not
reported, on the reasoning that product numbers and phone numbers are hard to
tell apart and false refusals are worse. That reasoning holds for a supplier
typing their own SKU. It does not hold for a lane whose `sku` is minted by this
system (§4) and whose neighbouring text came off a photograph of somebody's
shop counter. Either the minted-SKU path must be exempt from the collision
excuse, or extraction must never place model-read digits in those three fields.
Not decided here; it is a change to a shared gate and belongs with the SKU
minting decision.

**Hop 3 — the image in the public record.** It stays out. `CatalogItem` has no
media field, so there is nothing to publish.

**But the exclusion is not structural today, and validating does not make it
so.** `image_url` is in `PUBLIC_CATALOG_FIELDS` (`catalog_leakage.ts:107`) and
`buildCatalogSnapshot` never calls `validateCatalogItem`, so an item carrying
`image_url` passes the gate and publishes. An earlier draft said the assembler
would enforce the exclusion by validating. It would not:
`validateCatalogItem` checks known fields one at a time and never rejects an
unknown key, so it accepts `image_url` — and any other extra field — in
silence. Structural exclusion needs exact-key validation, meaning the assembler
emits only the declared `CatalogItem` fields and refuses an item carrying
anything else. Without that, "the lane must not emit it" is a convention, and a
convention is what the confirmation contract already assumes we cannot rely on.

**Retention is unspecified and must be specified.** Where the image lives
(persona and tier), size caps, retention window, and erasure. Vault deletion is
a soft delete today, and the archive hex-encodes blobs, so retained images ride
into every backup at roughly double size, unbounded. The retained image is also
useless as provenance unless it is hash-linked to the extraction and the
published snapshot digest.

## 8. Failure modes

| Failure | Handling |
|---|---|
| Hallucinated price | `proposed` blocks publication (§6) |
| Wrong unit | Same; `unit_code` from the vocabulary, not free text |
| Invented product | Seller deletes the row |
| Unreadable handwriting | Empty cell + finding |
| No GTIN/SKU | Minted supplier-scoped SKU — **open** (§4) |
| Private text in a public field | Gate refuses the whole publication (§5 step 7) |
| `leakage_refused` after confirm | Edit the value → re-import → re-assemble → re-confirm → new content receipt. Findings must route back per item, or the seller is stuck |
| Multi-page price list | One extraction; row numbering across images **undefined** (§10) |
| Republish after edit | A **new draft** (§6) inheriting the previous items, minted SKUs and provenance — the published one is terminal. New snapshot at the next sequence, pointer CAS |
| Pointer CAS conflict (head moved) | Rebuild against the new head. **Everything below the items changes**: `paginate` stamps `snapshot_sequence` into every page, so the pages, their digests, `payload_root`, `snapshot_digest` and `snapshot_rkey` are all new and must be re-held and re-approved. Only the assembled items and the content receipt survive — re-holding the previous pages beside a rebuilt snapshot is refused as `snapshot_without_pages` |
| Pointer write failed, head unchanged | Retry the pointer write with the approved bytes. No rebuild, no new review — rebuilding would re-mint `published_at` and orphan a second snapshot (§5 step 10) |
| Owner declines the snapshot digest | Nothing has been written yet (§5 step 9 precedes both writes), so nothing was disclosed. Same return path as `leakage_refused`: edit the value → re-import → re-assemble → re-confirm → new content receipt → rebuild → new review. Returning to Confirm alone would re-approve the same bytes and loop |

## 9. Ownership

Commerce currently compiles into Core, which §3.2/§3.4 says it should not;
extracting the commerce pack out of the kernel is deferred by owner decision
(2026-08-10). This lane must not deepen that.

- **Client** captures and presents confirmation.
- **Brain** performs inference. Core never interprets an image.
- **Commerce Pack** owns normalization and canonical assembly — placed
  alongside the existing importer while that extraction is deferred, and moving
  with it.
- **Core** stores the draft, gates, records the receipt, signs, and publishes.

No new interpretation logic in Core.

## 10. Known gaps in this document

Stated rather than hidden:

1. **No multimodal interface exists.** `ChatMessage.content` is a string; no
   adapter declares vision; `capability_runtime` serializes params to text; no
   image capture in `apps/mobile`. An image-reference contract — ordered source
   ids, content hashes, MIME, size and page bounds, partial-failure behaviour —
   must be designed before step 2 is buildable.
2. **SKU minting undecided** (§4).
3. **Image egress undecided** (§7).
4. **`category_ids` source undecided, and blocked on someone else's
   decision** (§4). The field is required on every published item and the lane
   has no lawful way to produce one until the governed vocabulary of §27 Q3 is
   settled. This is the only open item here that another decision gates.
   `fulfilment_regions` has the same shape of problem but a named source
   (seller settings) and no vocabulary dependency, so it is not open.
5. **Row numbering undefined for photos.** The CSV convention is header = 1,
   data from 2, and `catalogRowsFromRecords` offsets by +2 to match. Photo rows
   must satisfy the same convention, and multi-image numbering has no answer
   yet. A related defect exists in the importer: `unknown_variant_parent`
   reports `index + 2` rather than the source row, exact only when no row was
   skipped.
6. **No observability contract.** §22 requires PII-safe metrics and
   tenant-private decision logs. Capture, extraction, confirmation, refusal,
   retry, CAS conflict and publication need metadata-only events, with image
   bytes and OCR text prohibited from shared logs.
7. **Retention, erasure and export undefined** (§7) — **for the draft store as
   well as the image.** The draft holds extracted rows, findings and assembled
   items, which §7 says to treat as private-origin until reviewed, including
   values the leakage gate refused. This document names no persona, no tier, no
   retention window and no erasure rule for that store, and "must survive
   persona lock" (item 8) implies placement outside the persona that would
   protect it. The archive hex-encodes blobs, so whatever is stored rides into
   every backup. Undecided, and recorded here rather than left implied.
8. **~~Nothing this design needs to store exists yet.~~ CLOSED 2026-08-13.**
   `commerce_catalog_drafts` (v31) holds every field below, and
   `catalog_draft_ingest.ts` is the interface that accepts extracted rows —
   two routes, one per provenance class Core assigns. The list stays as the
   requirement the store is checked against. Durable contents:
   - the extracted rows, the findings, and per-field provenance;
   - the **provenance class** of the draft (`owner_authored`, `source_parsed`,
     `model_derived`), which decides whether a receipt is required;
   - the **assembled `CatalogItem[]`**, because Core loads and publishes from
     it rather than from a request body;
   - `freshness.generated_at` and `item_revision`, minted once at assembly and
     never re-derived, since a rebuild that re-mints either breaks the receipt;
   - **the draft's state** (`created | confirmed | prepared | approved |
     published`), without which the state machine §6 calls persisted is not
     persisted at all — after a restart a draft reset by a CAS loss would be
     indistinguishable from a healthy `approved` one;
   - **the publication result** on a `published` draft, so a repeat publish can
     return the existing publication rather than starting a second one;
   - the content receipt. There is no separate second receipt to store: §6's
     "second binding" IS the approval recorded by `approve`, listed below.
     Naming both would either duplicate one artefact or invent a second whose
     contents are defined nowhere. What the approval holds is the approved
     `snapshot_digest`, the content revision it was taken at, and whatever
     evidence the presence step produced;
   - **the built snapshot and its pages, plus `expectedPointerCid` and the
     owner's snapshot approval**, held across the §5 step 9 review. The review
     suspends the publication on an owner decision, and nothing else on this
     list survives that pause. It matters most for `published_at`, which the
     publish route defaults to the current time when the caller omits it and
     which `snapshot_digest` commits to: rebuild after a restart and the digest
     the owner approved no longer exists. Step 10 publishes the approved bytes;
     it does not rebuild them.
   - **the content revision each of those four was built from.** Without it the
     approval outlives the thing it approved.

     **What it counts, exactly.** A monotonic counter over the draft's
     *content* only — the rows, the findings, the per-field provenance and the
     assembled items. Core's own bookkeeping writes do **not** bump it: minting
     the content receipt, holding the snapshot and pages, storing
     `expectedPointerCid`, and recording the approval all leave it unchanged.
     Otherwise `prepare` would invalidate its own output and every publication
     would be refused — a rule that fires on itself is as useless as one that
     never fires.

     **One comparison rule, not two.** Publication requires the content
     receipt, the held snapshot and pages, `expectedPointerCid` and the
     approval to each carry a revision **equal to** the draft's current one. An
     earlier draft of §6 said the receipt must not be from an *earlier*
     revision, which permits a receipt from a later one — precisely the
     edit-during-the-pause hole this exists to close.

     Called **content revision** and not "draft revision", because
     `item_revision` is an unrelated wire field on `CatalogItem` two bullets up
     and the two must not read as siblings. A seller who edits a row during
     the pause, re-imports, re-assembles and re-confirms holds a *current*
     content receipt at the new revision while the held snapshot and its
     approval still carry the pre-edit bytes — both checks pass and step 10
     publishes exactly the content the seller edited away, which is the
     disclosure the review exists to prevent. Any edit to the draft voids the
     held snapshot, its pages, `expectedPointerCid` and the approval together,
     and Core refuses to publish held bytes whose recorded revision is not the
     draft's current one.

   It must survive app restart and persona lock (covered by
   `catalog_draft_store.test.ts` and the reopen case in the route suite).
   The interface that accepts extracted rows now exists; it was missing, and
   what follows is the reasoning that specified it. That one is worth naming precisely, because §4
   calls `CatalogRowSource` "the correct seam" and that is true of the shape
   and not of the plumbing — `parseCatalogCsv` and `catalogRowsFromRecords` are
   the only producers, and there is no route, no `CoreClient` method and no
   repository behind them. A design that says "rows go in here" without a store
   behind it is describing a funnel with no bucket.
9. **The user-presence primitive exists but is unwired and unpersisted.** §6
   requires confirmation to be gated by something Core verifies for itself, and
   `passphrase_unlock.ts` is that: a per-persona Argon2id record with
   `verifyPassphrase` / `PassphraseRegistry.verify` and a constant-time
   compare, which the persona unlock route makes the locked tier's only gate.
   What is missing:
   - **no production caller** — `registerPersonaRoutes` is registered from a
     test and nowhere else;
   - **no persistence** — `PassphraseRegistry` is a `Map`, so every record dies
     with the process;
   - **no per-action binding** — verifying once is not the same as vouching for
     this confirmation;
   - **no mobile equivalent**, which is the platform §6's worry is about.

   The in-process registry API *is* as §6's earlier drafts described — the
   `approved` boolean, with the boot helper passing `true` for every persona —
   so the two statements are about different paths and only one of them is the
   server's HTTP unlock. Getting that distinction wrong three rounds running is
   why it is spelled out here.
10. **~~No supplier-level currency field exists~~ CLOSED 2026-08-13** — `tradingCurrency`
    and `catalogCategoryIds` are on `SupplierSettings`, both optional and both
    validated. The original statement follows. (§4) `SupplierSettings` has
    none, and `importCatalogRows` refuses a priced row without one, so every
    priced row fails import until it is added. Net-new work, small, and
    blocking the price half of the lane.
11. **An owner-capability client can launder model rows through the
    deterministic-parse entry point** (§6). Core assigns the provenance class
    from the entry point, which stops a caller declaring itself exempt, but a
    client holding the owner capability can serialise model-extracted rows as
    CSV and create an `owner_authored` draft that Core cannot distinguish from
    a file the seller typed. Closing it needs something that binds rows to the
    surface that produced them; nothing here does that today.
12. **A snapshot record carries no predecessor link** (§5 step 10). The
    already-published check after a crash can compare only the live head's
    `snapshot_digest` and its one `previous_snapshot_digest`, so anything
    further back is inconclusive and goes to the owner. Making it exact needs a
    §10.2 wire change, which is an owner decision and not one this lane should
    take on its own.
13. **An ERP or hosted-sheet connector can still publish unread values.**
    `source_parsed` drafts are exempt from confirmation on the grounds that
    nothing was inferred (§6), which is true and still leaves a supplier
    publishing, under their own key, rows they never read from a system they
    configured once. Out of scope for this lane; recorded so the exemption is
    not mistaken for an argument that the risk is absent.
14. **THE ONE DECISION THAT IS NOT THIS LANE'S TO TAKE — and it is the largest
    thing in this document.** To make its safety property Core-checkable, §6
    retires the shipped publish route's item-list body and makes a
    presence-gated `approve` mandatory for **every catalog publication in the
    commerce vertical**, not only for photographs. That is a product decision
    about the whole vertical, taken here on the strength of one line in
    §12.1 step 11.

    It also collides with two other parts of the same authoritative document.
    §8.3 lists **catalog refresh cadence** as a supplier configuration setting,
    and §17.3 counts catalog refreshes among the scheduled work that wakes a
    sealed cell — both of which describe publication happening on a timer with
    nobody watching. A rule requiring a person at every publication and a
    setting scheduling publications unattended cannot both hold.

    Three ways out, none of which this lane should pick for itself: require
    presence always and drop cadence-driven refresh; exempt `source_parsed`
    republication from `approve` and accept that §12.1 step 11 is not satisfied
    for it, recorded as a deviation; or bind an approval to a *policy* the owner
    set once rather than to each publication, which is a different and weaker
    guarantee that would need its own argument. **Owner's call**, and if
    cadence-driven refresh survives it, both §6's state machine and the retired
    request body reopen.

    **DECIDED 2026-08-13 — the first way out. Presence stays required on every
    class, and no catalog publishes unattended.** A published catalog is a
    public commercial commitment, and "it refreshed itself overnight" is how a
    wrong price gets signed with nobody to have noticed. §8.3's cadence setting
    and §17.3's scheduled refresh therefore describe work that *prepares* — a
    refresh may fetch, assemble and build a snapshot on a timer, and then waits
    at `approve` for the owner. The state machine already implements this: the
    scheduled part ends at `prepared`, and `approve` is the human step. What
    the decision costs is honest and small: a supplier whose prices move daily
    sees a daily review, and a supplier who ignores the review publishes
    nothing rather than something unread.
15. **The photographed text is untrusted input to a model.** A page can carry
   text addressed to whatever reads it — "ignore previous instructions", or a
   line shaped like a system prompt. Everything else in this document treats
   extraction output as *possibly wrong*; this treats it as *possibly
   hostile*, which is a different threat. The extraction call must therefore
   run with no tools, no vault access and no conversation history, take the
   image as data and return schema-constrained rows only, so that the worst a
   crafted page achieves is a bad row the seller then declines to confirm.
   Prompt-injection defence is Tier 1 only today (regex PII plus guard scan),
   so this constraint has to be structural rather than something the prompt
   asks for politely.

## 11. Sequencing

One capability remains genuinely absent and is worse for buyers than this lane
is for sellers: **buyer-side cancellation (§12.8) does not exist.** No
`CancellationRequest` producer in production; `buyer_response.ts` returns
`cancellation_not_applied` and states the buyer has no state machine to apply a
supplier's result to.

A second claim in the first draft — that prior-major lifecycle routing (§9.13)
is unwired — was withdrawn in the second draft and is **restored here**, because
the withdrawal was itself wrong.

What is wired is release-major continuity: `update_rebind.ts` writes
`lifecycle_continuity` rows carrying `priorVersion`, `dispatch.ts` stamps
`prior_version` onto the continuity envelope, and `claim_guard.ts` checks the
majors agree. That machinery is real, which is what the withdrawal saw. But
`claim_guard.ts` says in its own comment what those majors are: "THE PLUGIN
RELEASE MAJOR, not the commerce protocol major", and, plainly, "nothing on the
claim path compares the commerce `protocol_version` … cross-major PROTOCOL
continuity is a separate, currently unimplemented question." The two mechanisms
share a word and are not the same thing.

So §9.13 protocol-major routing remains absent, and a lane that will publish
catalogs across a future protocol bump should know that. The first claim was
right about the gap and wrong about its evidence; the withdrawal was wrong about
the gap. Both errors have the same cause — reading whether symbols exist and
flow, rather than reading what they mean.

Owner's call. My reading: buyer cancellation first.
