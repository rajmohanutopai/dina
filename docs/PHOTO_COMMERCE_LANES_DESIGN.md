# Photo commerce: the seller lane on a phone, and the buyer lane

**Status:** design, not built. Supersedes nothing. `docs/PHOTO_CATALOG_LANE.md`
remains the authority on the seller lane's *Core* behaviour, which is built and
running; this covers the two things that are not: the **app surface** a seller
would actually touch, and the **buyer lane**, which had never been specified.

**Revision 22** (2026-08-15). The dual-review trail: r1 → 10 distinct findings
(headline: "one draft machine" was false against the code, and a hardened
buyer approval path already existed unused); r2 closed them, returned 8; r3
closed those, returned 7 (headline: the capability-conditional gate made the
photo lane fail-open); r4 closed those, returned 5; r5 closed those, returned 5
(headline: a retained approval carried no draft binding, so a closed
competitor's approval could still submit); r6 closed those, returned 4; r7
closed those, returned 3; r8 closed those, returned 2 one-sentence
residues; r9 passed BOTH continuity reviewers — and the COLD AUDIT (two
fresh reviewers, no history) then returned 9 distinct findings the
continuity pair had normalized, headlined by the buyer confirm ceremony
vouching lines wholesale in violation of this document's own epigraph.
r10's continuity re-review then returned 6 more — headlined by the cold
fix itself creating a state with no exit; r11 closed those, returned 4
(two identity-precision gaps, two honesty corrections); r12 closed those,
returned 4 residues of its own fixes; r13/r14 converged the continuity
pair again — and COLD AUDIT #2 (a second fresh pair) returned 7 more
distinct findings; r15 closed those, returned 4 (a miscitation and three
corrections — withhold-not-decline, the evidence record, the draft-local
gates); r16 closed those, returned 2 one-line residues; r17 closed them — and
COLD AUDIT #3 (a third fresh pair) returned 6 more: the three frozen
commitments verified alone but proved nothing about belonging together, a
fail-open legacy discriminator on the approval binding, an evidence record
that proved self-consistency but not supplier authority, the SKU mint this
document never decided, a resolution path with no egress contract, and an
"offer" that indicative pricing is not — closed as r18, whose
continuity confirmation then returned 4 findings from both reviewers on
ONE r18 paragraph: the SKU mint was per-draft (so a republication draft,
inheriting its predecessor's minted SKUs, collides with them the first
time it mints), its policy sat in Core against the kernel-vs-pack
boundary, and it decided only half of what the lane doc bundles into the
decision (the `collidesWithProductNumber` suppression on identifier
columns) — closed as r19, whose verification split: one reviewer passed,
the other found the closure incomplete — the ledger made MINTING atomic
while edited and source-provided SKUs were merely "checked", a
time-of-check gap that lets a printed `P-0001` or two concurrent edits
collide past a read-only check — closed as r20 with the atomic-claim
rule, whose verification found the claim keyed to an identity that did not
exist: `productIdentity()` derives from the SKU value itself, so a claim
keyed to it cannot survive the very edit it protects — closed as r21 with
the `assignment_id`, whose revalidation found the claims had a birth and
no death: an abandoned unpublished draft's assignments held their claims
for ever, wedging the seller's give-up-and-re-photograph recovery behind
refusals — closed here as r22 with the claims lifecycle and the v1
one-catalog rule. Three cold audits, three failures of a double-PASS, and
four confirmation rounds that each caught the previous confirmation's own
fix: each fresh look finds a class its predecessors had normalized, and
the stage earns its cost every time it runs. The lessons are recorded where they happened:
familiarity is a blind spot, the cold audit is not a formality, and a fix
is a change like any other — it gets the same scrutiny. Each round's
findings have been progressively narrower: architecture, then mechanism, then
coherence between revisions.

---

## 1. What this covers, and what it does not

| | Core | Mobile | Status |
|---|---|---|---|
| Seller: photo → signed public catalog | built (§5 of the lane doc) | **nothing** | app surface designed here |
| Buyer: photo → signed private order | **more built than r1 knew** (see §5.0) | nothing | designed here, whole |

**Not in scope.** Payment of any kind. §4 of the commerce architecture and the
Cart Handover principle both stop at an approved order, and nothing here moves
that line.

### What already exists, verified against source

Seller side: the phone reaches every `/v1/commerce/catalog/drafts/*` route
in-process through `CoreRouter`, and `commerce_plane.ts` installs the catalog
record writer and reader when a PDS session exists — a phone can publish to its
own repo today. Missing: a camera, an extractor, screens, a presence verifier.

Buyer side — and this is what revision 1 missed — the approve-and-send half is
**built and hardened**, not just typed:

- `POST /v1/commerce/orders/prepare` mints a §15.2 **retained approval**
  (`buildBuyerApprovalPayload`, `RetainedOrderApproval`, 30-minute TTL)
- `POST /v1/commerce/orders/submit` verifies the binding and dispatches through
  `submitApprovedOrder`, with authority resolution and expiry revalidation
- `verifySignedQuoteForBuyer` checks a received quote whole: retained request
  digest, buyer audience, transport-authenticated supplier, expiry,
  substitutions, and the §9.1 arithmetic recomputed line by line
- `verifyOrderAgainstQuote` binds an order to one exact quote digest, line set,
  quantities, total, terms and delivery projection

The buyer lane designed below is a way INTO that machinery. It builds the part
that does not exist — photo → draft → resolved lines → quote conversation —
and hands off to the part that does. It does not build a second approval path.

---

## 2. What the two lanes actually share

> A number a machine read must never become a commitment without a person
> having vouched for it.

The seller's version: ₹18,000 read as ₹1,800 becomes a signed public
commercial assertion — an indicative discovery price, non-binding until a
quote (`CommerceSearchCandidate` projects it as `indicative_price` and
nothing downstream treats it as terms), but public, signed and wrong all
the same.
The buyer's version: "20 dining chairs" read as "200" becomes an order. Same
decimal point, opposite directions, and an order is a commitment in a way a
quote request is not.

**Revision 1 said "one draft machine". That was wrong**, and the review showed
why with the code open: the catalog draft store re-derives every stored item
through `validateCatalogItem` and fails closed to `[]` on anything else, its
provenance is seeded from `Record<keyof CatalogItem, …>`, and its state
machine's `prepare`/`approve`/`publish` build, digest and publish catalog
snapshots. An order line is not a `CatalogItem`; forcing one through those
readers erases it.

What is genuinely shared is smaller and sharper — the **safety kernel**, not
the aggregate:

| shared | what it is | where it lives |
|---|---|---|
| provenance vocabulary | `proposed / accepted / edited / not_model_derived`, unknown → `proposed` | one type, both stores |
| content receipt SHAPE — **not the catalog digest function** | a generic `commit(domain, kind, value)`; the order receipt gets its own domain family (`dina:commerce:order_draft:v1:`) with cross-domain tests proving catalog and order receipts can never be interchanged. `catalogContentReceiptDigest` commits under the catalog prefix and stays catalog-only — its own file states that commitments get separate domains "so neither set can silently widen the other". | `catalog_publication.ts` (pattern), new order module (function) |
| presence | `owner_presence.ts`, one module, one verifier per platform | built |
| extraction seam | one interface, two schemas (§3) | new |
| the design patterns | fail-closed readers, conditional claim writes, state-machine transitions table | reimplemented per aggregate, tested per aggregate |

The **order draft is its own aggregate** with its own store and state machine
(§5.2). The two aggregates share vocabulary and primitives; neither shares the
other's rows, readers, or transitions.

### 2.1 Frozen shapes — to be pinned in `@dina/commerce-protocol` before build

Prose commitments hash nothing. Every new commitment this design names gets a
bounded `snake_case` wire/storage type, a canonical preimage, its own domain
string, and negative vectors (cross-domain and stale-generation) BEFORE any
screen is built:

- **extraction commitment** — a SECOND digest beside the existing receipt,
  never a widening of `catalogContentReceiptDigest`'s shipped preimage (a
  widened preimage breaks every receipt across the change). Own kind under
  each lane's domain; preimage: **the `draft_id`**, the ordered manifest
  `{artifact_id, content_hash, page_index}[]`, the schema id, the model, and
  the extracted rows with their `{page_index, row}` identities. Stored in new
  columns on the draft stores — for `commerce_catalog_drafts` an in-place
  addition to the existing CREATE TABLE, named in §8. And it is BOUND, not
  merely adjacent: cold audit #3 observed that three commitments which each
  verify alone prove nothing about belonging together — an extraction
  commitment from draft A recomputes perfectly beside draft B's vouch, so
  "provably shows which photograph produced the rows" was false until the
  digests were chained. The chain: the order lane's vouch receipt commits
  the extraction digest in its preimage (below); the catalog lane — whose
  shipped `catalogContentReceiptDigest` preimage cannot be widened — gets a
  separately versioned **extraction-binding record** `{draft_id,
  content_revision, extraction_digest}` with its own kind and domain,
  checked at confirm, prepare and publish. Negative vectors for both:
  cross-draft, substituted manifest, detached receipt.
- **batch vouch receipt (order lane)** — domain `dina:commerce:order_draft:v1:`
  kind `vouch_receipt`; preimage: draft id, the **ceremony counter** (the
  §5.1 per-draft monotonic integer, bumped only by confirm ceremonies —
  that definition, not a reinvention), **the extraction commitment digest**
  (the chain that makes the vouch provably about THESE photographed rows),
  the ordered included lines as
  `{line_id, generation, quantity, resolved product, supplier}` and the
  requirements as `{key, value | omitted, generation}`.
- **conversation snapshot** — kind `conversation_snapshot` under the
  order-draft domain; its digest is what "snapshot digest" MEANS everywhere
  this document says it, including in the source-bound approval. Canonical
  preimage: draft id, conversation id, supplier DID, the retained
  `QuoteRequest` digest, the ordered included lines as `{line_id,
  generation, vouch_receipt_digest}`, and the carried requirements as
  `{key, value | omitted, generation}` — maps in sorted-key order, lists in
  stated order, the same canonicalization discipline as every §9.12 digest.
  `assignment_generations` and `requirement_generations` in the approval
  binding are these same pairs, in this same canonical representation.
- **source-bound retained approval** — the additive fields on the shipped
  approval record: `{draft_id, conversation_id, assignment_generations,
  requirement_generations, snapshot_digest}` — plus a versioned **origin
  discriminator inside the approval's integrity digest**. Revision 15's
  "absent = legacy" failed open, cold audit #3 observed: a photo approval
  whose source fields were lost to corruption or a partial migration would
  hydrate as a legitimate legacy approval and take the unrestricted path —
  a downgrade at exactly the boundary the binding defends. Now: origin
  `photo_order_draft` requires EVERY source field present at hydration and
  again at submit, fail-closed; only records provably predating the
  migration hydrate as legacy. Tests: missing source field, stripped
  discriminator, altered generation, downgrade attempt.
- **catalog evidence record** — the §5.1 per-resolved-line retention:
  `{page, page_index, page_digest_list, snapshot fields, snapshot_digest,
  the authenticated pointer record with its CID and repo verification
  context (repo DID, collection, rkey)}` — bounded (pages are bounded).
  Internal consistency alone proves nothing, cold audit #3 observed: a
  fabricated pointer→snapshot→page→item chain recomputes perfectly for any
  `supplier_did` an attacker writes into it. So hydration verifies
  supplier AUTHORITY first — the retained pointer really is the record the
  named supplier's repo published — and only then the digest chain: page
  digest → payload root → snapshot digest. Fail-closed, with
  forged-supplier / wrong-repo / wrong-rkey vectors beside the r16
  stale-item / wrong-page / wrong-snapshot set.

---

## 3. Extraction, and the image-egress decision

A real vision call against `scripts/commerce/fixtures/chairmaker_price_list.png`
returned all three rows with correct SKUs and prices, so the seam is worth
building. Two honest limits: that fixture is a clean render, not a photograph —
acceptance needs a deliberately poor one (creased, angled, half-lit), and the
misread it produces is the test; and a model that reads three rows right reads
the fourth wrong eventually, which is why nothing depends on extraction being
good, only reviewable.

### The seam

```
extractRows(authorization, schema) -> { rows, model, schemaVersion } | refusal
```

The signature takes an AUTHORIZATION, not image bytes — revision 3 added a
broker whose whole point is that Brain never holds the image, and then left a
seam signature that handed Brain the image. The division of labour, stated:

- **Core** stores the artifact and serves its stripped bytes only against a
  single-use authorization (§3 requirement 1).
- **Brain** composes the schema-constrained provider request, asks Core for
  the authorization, invokes the broker with it, validates the returned rows
  against the schema, and decides `refusal` when the rows are unusable. The
  analyst reasons about ROWS; it never touches bytes.
- **The broker** binds bytes to the authorization, performs the provider
  call, and returns raw rows. It validates nothing and decides nothing.

Two schemas: `catalog-rows-1` (seller) and `order-lines-1` (buyer).

### Image egress — the lane doc's Hop 1, carried whole this time

`PHOTO_CATALOG_LANE.md` §7 calls this hop its most serious unresolved question
and names four requirements before build. Revision 1 kept a consent fragment
and dropped the rest; this revision carries all four:

1. **A Core-authorized egress gate WITH a data plane that cannot be walked
   around.** An authorization alone is advisory: Brain is the untrusted
   tenant, and Core approving `{hash, provider, purpose}` does not stop a
   different byte stream leaving. So the transmission itself is an **egress
   broker** — an injected adapter installed by the composition root, exactly
   the pattern `installCatalogRecordWriter` already uses — and it is the ONLY
   component holding a vision-provider credential or transport. The broker:
   takes a **single-use** Core authorization (provider, purpose
   `catalog_extraction` / `order_extraction`, image content hash, size/MIME
   limits, expiry); fetches the EXIF-stripped bytes from Core bound to that
   authorization; **re-hashes the actual outgoing bytes immediately before
   transmission** and refuses on mismatch; consumes the authorization
   atomically; and returns extracted rows only. **Brain never receives the
   image at all** — it receives rows, which is all the analyst needs and all
   the untrusted tenant may hold. Fail-closed tests cover: broker bypass,
   hash substitution, authorization replay, wrong provider, and mutation
   after authorization.
2. **Scoped consent.** The owner approves a provider *for photo extraction* —
   not a blanket cloud toggle — once per provider, revocable in settings, and
   the approval names what leaves (the photograph, nothing else).
3. **EXIF stripping.** The image is re-encoded with metadata dropped before it
   crosses the gate. Location, capture time and device identity in EXIF are
   disclosures the seller never saw on screen.
4. **A fail-closed test.** A conformance test proves raw image bytes cannot
   reach a remote provider without a gate authorization — the same falsifiable
   shape every other guard in this codebase carries.

**Owner decision (2026-08-15): hosted extraction is approved** — the owner
selected an OpenAI vision backend for this lane — *under the four controls
above*. On-device extraction answers the same seam interface when a local model
exists and is preferred automatically when present. Storage remains local
and encrypted (§6); this section is the transit story, stated as a decision
rather than a footnote.

---

## 4. Part A — the seller lane on a phone

### 4.1 Capture

`expo-image-picker` (camera + library; neither dependency exists yet). A
price list is often MORE THAN ONE PAGE, and the seller authority says "one
or more images" — so capture produces an **ordered list of commerce image
artifacts** (§6). The numbering SCHEME, defined here because retrofitting it
changes the hashing (and the lane doc's §10 item 5 left it open — this
closes it): rows are numbered **continuously across pages in page order**,
data from row 2, matching the CSV convention the importer already speaks —
so `row` means one thing in findings, repairs and receipts whether the
source was one page or five. The extraction commitment binds the ordered
manifest `{artifact_id, content_hash, page_index}[]` plus, per row,
`{page_index, row}` — the repair screen shows page 2's photograph beside
page 2's rows by that pair. The draft stores the manifest — never raw bytes
in a draft row, which the store has no column for.

### 4.2 Two screens, because the lane doc requires two

Revision 1 designed one review screen. The lane doc §6 is explicit that there
are two, shown at different times, and only the second has anything a receipt
can cover. The distinction is load-bearing: a photographed price list's normal
FIRST state is a draft with findings and `items: []` — a provenance table has
nothing to show, and `/drafts/edit` (which edits assembled items) has nothing
to touch.

**Screen 1 — repair.** Rows and findings, beside the photograph. Drives
`POST /drafts/repair {row, column, value}` — set, clear, or remove-row — which
re-imports and re-assembles after every change. This is the screen the smudged
photo lands on, and the seller works here until the findings are gone and
items exist.

**SKU minting — the lane doc's open decision, decided here, because the
headline seller has none.** `importCatalogRows` refuses an identifier-less
row, so the pickle seller — whose jars have never had a SKU — would land in
repair facing a `missing_required` finding per row with no way out but
inventing identifiers by hand. Instead, when a row lacks an identifier,
one is MINTED (`P-0001`, `P-0002`, …) at first repair, stored on the
draft, and NEVER re-derived — a re-mint on republication would change a
product's identity and orphan its order history. The repair screen shows
the minted value like any other cell — editable, and provenance
`not_model_derived` because no model produced it.

The allocator behind the mint is **durable and scoped to the ISSUER, not
the draft** — because the protocol identity `catalog_import.ts` builds is
`(issuer_did, scheme, value)`, and a counter that restarts per draft
re-issues `P-0001` the first time a republication draft (which inherits
the minted SKUs of its predecessor, lane doc §6) meets a new
identifier-less row — whereupon the import refuses itself
`duplicate_identifier` and the seller's ordinary growth flow, one new
product on a new photograph, dead-ends in the exact hand-editing the mint
exists to remove. So: a **reservation ledger plus high-water mark**, kept
in the same database that already holds `commerce_catalog_drafts`
(`identity.sqlite`, where the commerce tables live), durable across all
catalogs and drafts — and the
ledger's rule is a CLAIM, not a check, because a read-only check is a
time-of-check gap: EVERY supplier-scoped identifier entering a clean
draft — minted, inherited, seller-edited, or source-provided (a printed
SKU the model read off the page) — atomically claims the ledger under the
product's **`assignment_id`**: an immutable internal identity, minted
once when a row first becomes a product and never derived from anything
the seller can edit. It is NOT `productIdentity()` — that derivation
(`catalog_assembler.ts`) includes the SKU value, which is exactly the
thing an edit changes, so a claim keyed to it would read every edit as a
new product and every republication as a stranger. The `assignment_id`
is stored on the draft beside the row, hydrated fail-closed (a missing or
corrupt id refuses the draft, never invents a fresh identity), and
inherited by a republication draft with the assignments it carries. A
claim the row's own `assignment_id` already holds succeeds idempotently,
which is what an SKU edit and a republication both are; a claim held by
another `assignment_id` refuses, and the refusal routes through repair
like any other finding. Assignment creation or inheritance, the ledger
claim, and the draft mutation that records them commit in ONE
transaction — the ledger and `commerce_catalog_drafts` live in the same
SQLite database, so a crash between claim and draft leaves nothing
half-owned. Allocation skips every claimed value, so the mint can
never issue a value a photographed row already carries, and a reserved
value is never re-issued, even for a product since removed; a
republication draft inherits assignments AND the high-water mark.

And the claims have a LIFECYCLE, not only a birth — without one, an
abandoned half-repaired draft holds its claims for ever, and the seller's
most ordinary recovery (give up, re-photograph the same page) meets a
refusal on every printed SKU whose only repair-screen exit is renaming
real products — the identity fork this paragraph exists to prevent,
arriving through its own machinery. The rule: a claim held by an
assignment that has NEVER been published is RELEASED when its draft is
erased or abandoned — safe, because nothing public references it, and
"never re-issued" still holds for minted values since the high-water mark
stays monotonic and never rewinds. A claim that has been published
survives for ever. And the cross-catalog question is decided, not left
implicit: claims are issuer-scoped while assignments are per-catalog, so
in v1 a photo-lane product belongs to ONE catalog — the same printed SKU
in a second catalog's draft refuses with a finding that says which
catalog owns it; an explicit adopt operation (equality cannot be derived
from editable values, so it must be a seller act) is recorded as future
work, not designed here. Named tests: erase an unpublished draft →
re-photograph the same page → every claim succeeds; the same printed SKU
in a second catalog's draft → refused, naming the owning catalog. Named
tests: inherit `P-0003` → mint `P-0004` → import clean; a source row
carrying `P-0001` before the mint reaches it; two concurrent edits
claiming one value (exactly one wins); an SKU edit under the SAME
`assignment_id` re-claims cleanly; row reordering leaves assignments
untouched; restart between claim and draft persistence (the transaction
makes it unobservable); missing/corrupt `assignment_id` refused at
hydration; idempotent re-claim on republication; deleted-product value
never re-issued; edit collision refused.

WHERE the mint lives honours the lane doc's §9 ownership rule: minting is
commerce normalization, so the POLICY — which rows mint, what shape, when —
sits with the pack's importer/assembler, beside `catalog_import.ts`. Core
contributes the durable atomic reservation primitive, persists the
assignment, and gates/signs as it already does; no product policy enters
the kernel, and §8 step 3 carries the boundary test.

And the decision closes BOTH halves the lane doc bundles into it: its §7
records that `collidesWithProductNumber` deliberately suppresses
PHONE/PAN/IFSC findings in `sku`, `mpn` and `value` — an excuse that holds
when a seller types their own SKU and fails when a model reads digits off
a photographed counter. For PHOTO-DERIVED drafts the suppression is
removed on those columns: the publication gate scans them like any other
field, a minted SKU never trips it (the `P-` shape carries no such
digits), a genuinely printed part number rarely does, and a phone number
misread into the `sku` cell surfaces as a repair finding instead of
publishing inside a signed public record. Named test: a
phone-number-shaped string in a photo-derived `sku` cell is reported, not
published. This decision — allocator, ownership and gate together — gates
build step 3.

**Screen 2 — review.** Assembled items with per-field provenance:

| state | what the seller sees | what it means |
|---|---|---|
| `proposed` | needs your eye | a model produced this and nobody has vouched |
| `accepted` | ✓ you confirmed | the seller vouched for what the model produced |
| `edited` | ✎ you wrote this | the seller replaced it |
| `not_model_derived` | from your settings | Core knows no model touched it |

Inline value corrections here call `POST /drafts/edit` — one field per call,
the route's existing contract. Two rules the screen must obey: **no "accept
all" button** — a SCREEN rule, stated honestly: the shipped `accept` route
takes a field list and does not stop a caller naming every field at once;
what it enforces is that nothing invented, unnamed or not-`proposed` can be
accepted, and the deliberation lives in this screen showing each field
beside the photograph — and **the price is never pre-accepted**
(`CATALOG_FIELD_ORIGIN` marks it row-derived; the digits are the model's).

### 4.3 Presence on the phone

The passphrase sheet appears before `confirm` and before `approve` — both
`POST /drafts/presence` — and the five-minute window means a brisk review
types once.

Two things revision 1 left ambiguous, now stated:

- **Biometric satisfies the sheet.** Mobile's unlock flow can retrieve the
  cached passphrase via Face ID / keychain with nobody typing. That still
  proves the enrolled person is present *now* — which is the property presence
  exists for; arguably more strongly than a typed secret proves it. The mobile
  verifier therefore accepts a biometric-released passphrase, and
  `owner_presence.ts`'s doc comment is updated from "typed" to "presented by
  the person, by passphrase or enrolled biometric". Auto-unlock users — who
  may not remember a passphrase cached at onboarding — are not locked out of
  commerce. (Reversible; flagged for the owner.)
- **The convenience-mode boundary carries over.** The server installs no
  verifier in convenience mode (plain keyfile, no secret only the owner
  knows) and the lane refuses there. The phone always has a passphrase or
  biometric, so the boundary is server-only, and this design says so rather
  than implying phones inherit it.

### 4.4 Publish

Shows what actually happened — sequence, predecessor, a link to the live
record — because "published" with no evidence is the claim this project's
whole review history exists to distrust.

---

## 5. Part B — the buyer lane

### 5.0 The story, corrected for how trade actually works

A retailer photographs a page from their order book:

> *20 dining chairs — oak*
> *6 benches, the 4ft teak ones*
> *need by Friday*

Revision 1 drew one pipeline to one supplier. But a `QuoteRequest`, a
`SignedQuote` and a `PurchaseOrderProposal` are each **per-supplier documents**
(one `supplier_did`, one currency per §9.1), and a real page resolves across
suppliers. So the true shape is a fan-out:

```
photo → ORDER DRAFT (one, holds the whole page)
          ├─ lines resolve → partition by supplier
          ├─ supplier A conversation: QuoteRequest → SignedQuote → order → approval
          ├─ supplier B conversation: QuoteRequest → (waiting…)
          └─ line 3: unresolved, visible, waiting on the buyer
```

One draft per photograph. One **LIVE conversation per supplier per draft** —
stated precisely, because two frozen digests hash `conversation_id` and an
undefined identity is two incompatible implementations: a conversation id is
minted by Core (random, unique within the draft) when the first request for
that supplier is prepared; at most one conversation per supplier is LIVE at
a time; terminal conversations (timed out, rejected, superseded) are
retained history under their own ids. A RETRY after timeout opens a NEW
conversation with a new id — the old one's snapshot is immutable. A line
that resolves to a supplier whose live conversation has already SENT waits,
visibly, and joins that supplier's next conversation. Each conversation has
its own quote, its own order, its own approval. Totals are never merged
across suppliers — two currencies cannot share a sum, and two counterparties
cannot share an approval.

### 5.1 The order draft — its own aggregate

A new store and state machine beside (not inside) the catalog draft's, per the
owner's storage decision. What a row must hold, none of it expressible in
`CatalogDraft`:

- the photograph's pages as an ORDERED MANIFEST: `{artifact_id,
  content_hash, page_index}[]` — one entry per page, the shape §4.1's
  capture produces. The extraction commitment binds the manifest whole, not
  "the image's" hash
- extraction `{model, schemaVersion}` and the raw extracted lines
- per-line: text, parsed quantity/product hint, **provenance** (the shared
  vocabulary — `quantity` starts `proposed`, exactly as `indicative_price`
  does on the seller side)
- per-line **resolution state**: `unresolved | ambiguous(candidates) |
  resolved(ProductRef, supplier_did, flagged_new_supplier)` — resolution is
  CONTENT, it happens before confirm, and the receipt covers it (§5.3)
- per-line **assignment generation**: a monotonic counter binding the line to
  at most one supplier conversation at a time (§5.4a)
- per-resolved-line: a **catalog evidence record** — not a bare retained
  item, because an item beside a snapshot digest proves nothing:
  `snapshot_digest` commits to `payload_root`, a flat ordered commitment
  over page digests, so proving an item was ON a page needs the material
  to recompute the chain. The record (frozen in §2.1) retains the
  digest-verified PAGE the resolution fetched, its `page_index`, the
  snapshot's ordered page-digest list, and the snapshot fields — enough to
  recompute the page digest, the payload root and the snapshot digest —
  plus the authenticated pointer record with its CID and repo context,
  because a chain that only recomputes proves self-consistency, not that
  the named supplier published it. Hydration verifies supplier AUTHORITY
  first, then the chain, fail-closed on any mismatch (forged supplier,
  wrong repo, wrong rkey, stale item, wrong page, wrong snapshot: each a
  named test). The §5.5 pack-evidence tier reads
  `pack.units_per_pack` from the verified item inside this record; the
  `CommerceSearchCandidate` projection carries only `indicative_price`, so
  a discovery-only candidate with no evidence record gets the "no
  comparable basis" badge by construction
- **page-level requirements, with the same discipline as lines — including
  the same STORED shape**: "need by Friday" is on the photograph too, and a
  model misreads a date as easily as a quantity. Draft-level requirement
  fields, each with provenance (`proposed`/`accepted`/`edited`), a
  generation, and a **vouch entry `{value | omitted, generation, receipt
  digest}`** exactly as lines have. TWO KINDS, because the wire carries one
  and not the other: **transmitted requirements** (delivery date,
  destination) map onto `QuoteRequest.delivery.{projection, required_by}` —
  a requirement still `proposed` blocks any request that would carry it:
  vouched, explicitly omitted, or the request waits. **Draft-local
  requirements** (the free-text instruction) are NEVER transmitted — the
  wire has no free-text field, deliberately (§9.7's `QuoteRequest` shape;
  §9.5's bounded-attributes posture against free-text prompt channels —
  §9.6's `query_text` is a DISCOVERY field, outbound-capable and
  owner-opt-in under the §5.2 egress contract, and never on the
  supplier-bound quote wire) —
  they are review context shown beside the lines, covered by the receipt so
  a misread instruction is still caught at confirm, and the screen says
  "not sent to the supplier" so the buyer is not misled about what the
  counterparty saw. Nothing machine-read reaches a supplier unvouched, and
  nothing free-text reaches a supplier at all
- per-supplier conversation state: sent `QuoteRequest` + its retained digest,
  received quote revisions (monotonic head, fork-checked), the exact accepted
  `quote_digest` + `valid_until`, the built order + retained approval id,
  submission outcome
- a **ceremony counter**: a per-draft monotonic integer, bumped once per
  confirm ceremony and by NOTHING else — never by Core bookkeeping, never
  by repairs (which bump line generations instead). It exists so a receipt
  can say WHICH ceremony minted it; the catalog lane needed three rounds to
  pin exactly this scope question, so it is pinned here at birth
- **per-line vouch entries**, not one draft receipt: each confirm ceremony
  mints an IMMUTABLE receipt over the batch it confirmed, and every line
  records `{quantity, resolved target, line generation, receipt digest}` from
  the ceremony that vouched it. A single draft-level receipt cannot express
  what the matrix demands — void for the repaired line, standing for the
  rest, mixed revisions across conversations sent days apart — and the
  fail-open reading (receipt as advisory after send) converts "a person
  vouched for what leaves" into "a person vouched at some prior revision".
  Receipts are never partially void: a line's entry either matches its
  current generation or the line is unvouched

**The transition and invalidation matrix.** Top-level state is DERIVED from
line and conversation states, never stored beside them where the two could
disagree. The rules an implementer needs, as rules rather than an arrow
sketch:

| mutation | allowed when | what it voids |
|---|---|---|
| repair a line (text/quantity) | unless the line is part of a SUBMITTED order (rejected/timed-out lines reopen precisely so they can be repaired) | the line's generation bumps; the field the buyer TYPED → `edited` (they wrote it — demanding they "accept" their own words confuses the vocabulary §2 pins), any re-parsed derivative fields → `proposed`; its vouch entry voids; every non-terminal conversation containing the line (their requests become history, quotes non-approvable, retained approvals invalidated). Other lines' entries stand |
| resolve / re-resolve a line | line not in a submitted order | as the repair row, scoped to that line |
| defer an ambiguous line | buyer action | line → `unresolved` (excluded from confirm rather than blocking it) — without this, one undecided candidate set parks every other line |
| **accept line fields** | buyer names `{line, field}` refs, each currently `proposed` | Core writes `accepted` per named field — the seller lane's `accept` shape exactly. STATED HONESTLY: the route enforces that nothing invented, nothing unnamed, and nothing not-`proposed` can be accepted — it does NOT enforce per-field deliberation, because a caller may name every field in one call, exactly as the shipped seller route permits. Per-field consideration is the REVIEW SCREEN's duty (§4.2's no-accept-all-button rule is a screen rule), and claiming the route enforces it would be the overclaim r11 caught. Negative tests: invented field, unnamed field, already-accepted field — each refused. Without this row the confirm gate below is a state with no exit — the seller lane's own recorded history, which r10 reintroduced for one round |
| edit / accept / omit / reinstate a REQUIREMENT | **always** — a requirement is a draft-level value, and submitted history is protected by the conversation SNAPSHOTS, so no state exists in which this mutation rewrites what an order meant. (Revision 6's precondition was vacuously true over zero carriers, which forbade deciding a freshly extracted date at all — and its `terminal` re-conflated what the line-repair row untangled in r4) | the requirement's generation bumps, provenance → `proposed` (edit) or per the action; its vouch entry voids; every non-terminal conversation whose request CARRIED it is invalidated (requests history, quotes non-approvable, retained approvals revoked) — a changed delivery date changes what every outstanding request asked for |
| confirm (presence) | every INCLUDED line resolved (`ambiguous` deferred or decided; `unresolved` excluded and named as excluded); **every model-derived field of every included line out of `proposed`** (accepted or edited, per field — the per-line mirror of the requirement rule and of the seller lane's publish gate: a batch tap cannot vouch a quantity nobody looked at, which is this document's epigraph); every requirement the ceremony covers decided (vouched or omitted), **including every DRAFT-LOCAL requirement** ("non-deferred" stood here for one revision and named a state requirements cannot occupy — defer is a LINE operation) — the instruction is receipt-covered or it is not caught at confirm, and r15's "the ceremony covers" let it be silently left out | mints an immutable batch receipt; each included line's AND requirement's vouch entry updates to it |
| send a QuoteRequest | every line's vouch entry current at its generation with **no model-derived field still `proposed`**, AND every requirement the request carries vouched (or recorded `omitted`) at its current generation, AND every draft-local requirement decided at its current generation (never transmitted, but a page cannot send while its instruction sits unreviewed and the screen calls it checked) | the conversation SNAPSHOTS the line and requirement generations and vouch entries it was sent under — immutable from here, so later repairs create new generations rather than rewriting what this request meant |
| approve (presence, `/orders/drafts/approve`) | quote verified (§5.4), covers only current-generation assignments and vouched requirements | mints the source-bound retained approval (§5.4 stage 4) |
| reopen after rejection / timeout | conversation terminal | affected lines' assignments retire (generation bumps) and their vouch entries void — re-routing to a new counterparty is a new decision, and a fresh confirm ceremony covers them before any new request |
| submit (`/orders/drafts/submit`) | conversation approvable; source-bound approval current | runs the four-class protocol below: intent persisted with the approval RESERVED and competitors closed, dispatch, outcome recorded |
| abandon draft | explicit buyer action | all open conversations closed; submitted ones remain immutable history |

A submitted conversation is immutable history for ever — and immutability is
carried by the SNAPSHOT, not by freezing shared lines: the conversation holds
the generations and vouch entries it was sent under, so a later repair
creates generation N+1 without rewriting what generation N's order meant.

**Submission is a protocol, not an adverb — and it has a named
orchestrator.** The protocol below is performed Core-side by
`POST /v1/commerce/orders/drafts/submit {draft_id, conversation_id}` — the
submit sibling of the draft-scoped approve route, and necessarily so: only
step 1 creates the dispatch intent that the source-binding check verifies,
so an app calling `/orders/submit` directly with a photo-minted approval
fails closed BY DESIGN. Crash replay and transient retry are driven by the
commerce sweeper tick both composition roots already start — the intent row
has a Core-side reader, which is what makes "restart-recoverable from the
row alone" true rather than aspirational.

 "Atomically closes competing
assignments" spans the draft store, the reserved approval, and an external
send, and no one transaction covers all three. The steps: (1) persist, in
one draft-store transaction, the chosen snapshot + the approval id
RESERVED (referenced, not consumed — the transient class below needs the
approval intact for retry, and actual consumption is `/orders/submit`'s own
send-boundary behaviour, exactly as it is today) + the competing
assignments closed + a dispatch intent; (2)
dispatch through `/orders/submit`; (3) record the outcome. Step 2 has FOUR
outcome classes — revision 4 conflated refusal with uncertainty, and
revision 5 had no class for transients at all:

- **Definitive refusal, nothing durable created or sent** — expired
  approval, expired quote, binding mismatch: the deterministic 409s the
  route already answers. Nothing left the node and nothing could have. The
  intent terminates as `dispatch_refused(reason)`, the competing assignments
  REOPEN through the ordinary reopen row, and the reserved approval is
  invalidated — it bound a quote context that is now dead, and it was never
  consumed: a pre-send refusal never reaches the send boundary. Replaying a
  deterministic refusal loops for ever; revision 4's "competitors stay
  closed either way" would have wedged the draft on its most common failure.
- **Durable record created or send attempted, outcome uncertain** —
  `submitted_unconfirmed`, resolved by the §12.7 reconcile machinery, never
  by guessing. Competitors STAY closed: a doubtful dispatch must block
  double-purchase exactly as a confirmed one does.
- **Confirmed send** — closure finalises.
- **Transient — the node itself briefly cannot act** — the rule is "any
  TYPED node-cannot-act unavailability refusal", currently four:
  `buyer_sender_unavailable`, `install_registry_unavailable`,
  `commerce_unavailable`, `authority_provider_unavailable` (r14 enumerated
  two and the other two would have defaulted into "uncertain" — a never-sent
  intent parked in reconcile). All four are named test boundaries. Nothing was
  created, nothing sent, and the SAME intent succeeds on retry. The intent
  stays live, competitors stay closed, and the approval is untouched — its
  own 30-minute TTL still governs. Repeated transients surface as a
  Solicited "couldn't reach the courier"; the state is never terminal. The
  route already draws this line on purpose (503 for a node that cannot
  answer, 409 for a request the world disagreed with), and revision 5 had no
  class for its most ordinary failure: reading a sender outage as refusal
  burns the approval; reading it as uncertain sends reconcile chasing an
  order that never existed.

A crash between (1) and (3) replays from the intent row — and replay
CANNOT classify by HTTP status alone. The poisoned case: dispatch
succeeded, the approval was consumed at the send boundary, the crash landed
before step 3 — a naive replay now meets a consumed-approval 409 and reads
it as definitive refusal, reopening competitors against an order that is
durably on its way: a double purchase by misclassification. So replay FIRST
resolves the intent against the buyer-order record and idempotency key
(`already_submitted` with a tracked record is a real answer, and that
record's own state may still be `submitted_unconfirmed`); only when no
record exists does the four-class map apply — and classification keys on
the TYPED refusal, not the HTTP status alone. Deterministic pre-send
refusals → refusal class: the 409s, AND 403 `no_authority_record`, AND 404
`unknown_approval` (an absent or integrity-failed approval row — which this
design's own competitor revocation can produce mid-race). Routing those
into "uncertain" would park a never-sent intent in §12.7 reconcile with no
order to reconcile: competitors closed for ever, the wedge this document
criticizes by name. 503s → transient; 200 with a durable outcome →
confirmed; only a genuinely ambiguous answer (transport failure after
send, malformed response) → uncertain. The record, when one exists, wins
over everything. Tests cover the crash, each refusal boundary INCLUDING
the 403 and 404, the transient boundary, and the
consumed-approval-after-send replay specifically.

`closed` means every line is either in a submitted order, explicitly
abandoned, or expired-and-acknowledged — a draft may close while some
conversations succeeded and others died, and the record shows which. Every
intermediate state is restart-recoverable from the row alone: fail-closed
readers, no in-memory-only state, the discipline the catalog store already
proves.

### 5.2 Resolving lines

"the 4ft teak ones" is not a `ProductRef`. Each line resolves against catalogs
the buyer can see — known suppliers first, then discovery — producing
candidates the buyer picks from. Rules, unchanged from r1 plus the owner's
decision: a line resolving to nothing stays visible and unresolved; a line
resolving to several products asks; an unknown supplier appears **flagged as
new** and is never auto-selected.

**The resolution egress contract — stated here because resolution runs
BEFORE confirm, on unvouched photo-derived text** (the same page that can
carry a name or a phone number the model copied into a line): resolution
against known suppliers matches LOCALLY, against fetched, digest-verified
catalog pages — nothing leaves the node. Discovery queries carry closed
fields only by default (§9.6's v1 default); extracted free text may leave
only through §9.6's opt-in path — Core-side projection, structured
scrub, length bound, owner-visible outbound view — and never before the
owner has seen the line it came from. Fail-closed test: raw extracted line
text cannot reach a discovery query outside that path. (Revision 16's §5.1
parenthetical calling `query_text` "local" was imprecise: the field is
outbound-capable and owner-opt-in in `search.ts`; the v1 default is what
keeps it off the wire, and this contract is what keeps that true for
photo-derived lines.)

### 5.3 Presence, and the contradiction r1 contained

Revision 1 said "one mechanism" and "presence binds only at the order". Those
cannot both be true: the shared receipt is minted at `confirm`, and `confirm`
on model-derived content requires presence — that pairing is what a receipt
*means*. The resolution mirrors the catalog lane exactly, and it is better
than what r1 promised:

- **Confirm, with presence** — the buyer vouches for the machine-read
  quantities *before anything egresses to a supplier*. A quote request
  carrying "200 chairs" nobody checked is already a disclosure and already an
  embarrassment; the receipt stops it at the door.
- **Approve, with presence** — per supplier conversation, on the exact
  verified quote, through the existing retained-approval path (§5.4).

**These are normally TWO presence moments, and the design says so.** Confirm
happens before the quote request leaves; approve happens after the supplier
answers — and a supplier answers in hours or days, not inside a five-minute
TTL. Revision 2 claimed one window covers both; it cannot, except in a demo.
The honest reading of the owner's "one approval is enough" decision:
**confirm is a review step** (vouching what leaves the building), and the
approval card — the exact verified quote, the exact total — is the **one
commercial approval** per order. One approval per order stands; a presence
proof (passphrase or Face ID, a two-second ceremony) accompanies each of the
two moments because they happen on different days. Re-confirmed against this
reading in §7 item 3.

### 5.4 Quote verification and the handoff to the machinery that exists

Named stages — stages 1–3 reuse the existing protocol types and verifiers
but run inside the NEW draft/conversation orchestration this document
specifies (the conversation store, the per-line reconciliation, the
assignment state); stage 4 adds the draft-scoped route, the source binding
and the submit-time check; stage 5 is the existing dispatch path:

1. **Send** — a Core operation, not a description:
   `POST /v1/commerce/orders/drafts/request-quote {draft_id,
   conversation_id}`. The quote request is the buyer's FIRST private
   commercial disclosure, and it gets the same discipline as the order:
   Core loads the conversation, verifies every carried line and requirement
   against its current vouch entry (the send-gate row), builds the
   `QuoteRequest` itself, persists it with its digest and an idempotent
   send intent BEFORE egress, and dispatches through the existing D2D
   service-query lane. Retry, duplicate-send, timeout and crash follow the
   same intent-row discipline as submission — and BOTH wire identity
   fields are assigned, because `QuoteRequest` carries two and a design
   naming only one leaves the other to be invented at a keyboard: Core
   mints ONE identity with the intent and writes it to `request_id` AND
   `idempotency_key`, durable on the conversation, scoped to the
   buyer↔supplier pair. **Supplier-side absorption is what already ships,
   not new work**: the supplier derives quote identity from
   `request_digest` (its retained request evidence is keyed by it), so a
   crash replay — same intent, same bytes, same digest — is absorbed by
   the existing derivation with no supplier change; r12's "supplier dedups
   on `idempotency_key`" would have invented an unplanned supplier-side
   store and is retracted. `idempotency_key` is populated for wire
   validity and carries the same value as `request_id`; it is not relied
   on for supplier dedup. The buyer side absorbs a replay on `request_id`
   + `request_digest`. The same identity with a DIFFERENT digest is
   refused locally as corruption, never sent. An unanswered request expires into the §5.5 timeout row. Brain
   and the app never construct or transmit the request themselves.
2. **Receive**: every quote revision passes `verifySignedQuoteForBuyer` —
   audience, supplier binding, request digest, expiry, substitutions, §9.1
   arithmetic recomputed. A quote that fails is recorded as invalid, never
   shown as approvable.
3. **Reconcile lines**: a supplier may lawfully quote a **subset**. Each
   request line gets `quoted | unquoted | substituted | unavailable`; unquoted
   lines are shown prominently and proceeding on a partial quote is an
   **explicit buyer decision** — unquoted lines stay open for another supplier
   or are explicitly abandoned, never silently dropped.

   **3b (stated before 3a because it scopes it): partial quotes are a
   DEFENSIVE lane, not a Dina-supplier behaviour.** The protocol lawfully
   permits a quote covering a subset (`verifyQuoteLinesAnswerRequest`), so
   the buyer handles subsets from ANY supplier — but a v1 Dina supplier
   cannot produce one: `settleInboundQuote` requires every requested line
   priced and answers `terms_unusable` otherwise — and that answer is a
   WITHHOLD, not a decline: the buyer receives nothing. In a two-Dina flow
   a partial fulfilment therefore surfaces as an UNANSWERED request that
   expires into the §5.5 timeout row (retry/re-route options) — r15 said
   "rejection path", wrong twice: no rejection reaches the buyer, and the
   rejection state is post-submission anyway. A typed quote-stage refusal
   that would make this immediate is optional future work beside
   supplier-side partial issuance. The per-line `quoted | unquoted |
   substituted | unavailable` reconciliation fires when a non-Dina or
   future supplier sends a lawful subset. Supplier-side partial issuance is
   named as OPTIONAL FUTURE WORK, not v1 build scope — the build order
   carries no supplier change.

   **3a. One line, one live assignment.** Re-routing a line retires its old
   assignment (the generation bumps); a late quote against a retired
   generation stays visible as history and can never become approvable — so
   the same photographed requirement cannot be bought twice by a race between
   supplier B's approval and supplier A's late answer. Submitting any order
   containing a line atomically closes competing assignments of that line and
   invalidates their retained approvals.
4. **Build + approve**: the order is built from one exact quote revision;
   `verifyOrderAgainstQuote` runs before the approval card is shown.
   **Presence at the approval — two rules, two populations, and the
   selection is a fact Core derives, never one a caller states.** Revision 4
   said "photo-derived by construction" and named no construction: nothing
   on a `PurchaseOrderProposal` identifies a draft, so a caller posting a
   hand-built order to the legacy route would select the weaker rule by
   omission — a caller-asserted flag wearing a disguise. The construction,
   stated:

   The photo lane's approve step is **draft-scoped**:
   `POST /v1/commerce/orders/drafts/approve {draft_id, conversation_id}`.
   Core loads the conversation, **builds the `PurchaseOrderProposal`
   itself** from the accepted quote revision and the snapshotted vouch
   entries — the caller supplies no order, the same shape as catalog publish
   taking a draft id and no item list — verifies every carried requirement
   against its current vouch entry, runs `verifyOrderAgainstQuote`, and
   calls the retained-approval machinery internally. Provenance is Core's
   own fact: this path is unconditionally presence-gated and fails closed;
   on a no-presence deployment a photo-derived order is unapprovable and the
   app says so. **The legacy route, stated truthfully: `/orders/prepare`
   today has NO presence involvement of any kind** — the
   capability-conditional pattern exists only on the catalog item-list
   route, and earlier revisions of this document wrote "stays" as if the
   gate were already there. Adding it is a CHANGE this design specifies: on
   a presence-capable node, `/orders/prepare` refuses a hand-built order
   without a live presence proof; on a convenience-mode node it behaves as
   today, so convenience-mode ordering survives. The retained approval
   binds the canonical order digest and quote context, 30 minutes,
   single-use, on both paths.

   **The approval carries its source binding, because the approval row is
   otherwise a second, independent authority.** A retained approval lives in
   its own store with only put/get/consume; "competitor closure invalidates
   their approvals" is unenforceable prose unless something at SUBMIT time
   reads the draft. So a photo-minted approval records, Core-derived at
   mint: `{draft_id, conversation_id, assignment generations, carried
   requirement generations, snapshot digest}` — and `/orders/submit`, on
   seeing a source-bound approval, verifies the binding against the draft's
   CURRENT dispatch intent, assignment generations AND carried requirement
   generations before sending, failing closed on any mismatch. The
   requirement generations are in the binding for the same reason the
   assignment generations are: revocation on a requirement edit is the
   courtesy, and if it races or fails, the stale approval must die at submit
   because the date it was approved under is no longer the date the draft
   holds.
   Competitor closure additionally revokes the losing conversations'
   approvals in the same draft-store transaction — but the submit-time check
   is the enforcement, and the revocation is the courtesy: two approvals
   minted before either submitted is the reachable race, and the second one
   dies at submit because its generations are stale, not because a cleanup
   ran in time. Legacy approvals carry no binding and submit as today. The
   named test: mint approvals on two competing conversations, submit one,
   prove the other refuses.

   **The residual bypass is recorded, not claimed closed — and recorded
   accurately: it is a SOFTWARE path, not only a human one.** On a
   convenience-mode node, ANY client holding the boot-minted owner
   capability — a person retyping a photograph, or a program that never
   showed anyone anything — can post a hand-built order to the ungated
   legacy route and obtain an approval. On a presence-capable node the new
   conditional gate closes the software path (named test: software holding
   only the owner capability cannot mint a commercial approval without
   presence). What remains everywhere is the §10-item-11 laundering
   analogue — an owner's authority used to restate machine-read values as
   their own — which Core cannot distinguish and this design does not
   pretend to.
5. **Submit**: `/orders/submit` remains the single dispatch path and
   revalidates expiry. Any newer quote revision, changed destination, expired
   quote, or changed order invalidates the retained approval — no
   stale-approval dispatch.

### 5.5 The lifecycle does not end at "sent"

Revision 1 stopped there; the code does not, and neither does week one of a
real retailer's life:

| event | state | what the buyer sees | Law |
|---|---|---|---|
| no quote before request `expires_at` | conversation `timed_out` | "no answer from X" + retry/re-route options | Solicited |
| quote expires during the human pause | `quote_expired`; approval (if any) invalidated | "X's price lapsed — ask again?" | Solicited |
| quote diverges from the reference price (see below) | approvable, warning prominent ON the approval card | the buyer sees it exactly where they decide | Solicited |
| order rejected | conversation `rejected` | reason shown; lines reopen | Solicited |
| counterproposal (§12.6) | new quote revision; old approval invalidated | re-approval required, diff shown | Solicited |
| submit outcome unknown | `submitted_unconfirmed` → §12.7 reconcile machinery | "sent, awaiting confirmation" | Solicited |
| submit refused deterministically (expired approval/quote, binding mismatch) | `dispatch_refused(reason)`; competitors reopen; approval invalidated | "couldn't send — the quote lapsed" + a re-quote option | Solicited |
| submit transient (sender/registry briefly unavailable) | intent stays LIVE; competitors stay closed; approval untouched | nothing on first tries; repeated transients: "couldn't reach the courier" | Solicited |
| buyer abandons draft | `closed(abandoned)` | explicit action; retention per §6 | — |

**The divergence check, defined — including its UNITS, in two tiers.**
Deterministic Core-side arithmetic, no LLM in any enforcement path. A quote
priced per case compared raw against a catalog price per each is a 12×
false alarm on identical real prices — and the §9.2 vocabulary ALONE
cannot fix that case, deliberately: `case` and `pallet` carry
`baseFactor: null` because a case is however many the product says it is,
and r10's "convert through the vocabulary" would have sent the headline
case to the badge instead of the warning. The two tiers:

1. **Vocabulary tier** — both units carry a `baseFactor` (g↔kg, ml↔l):
   convert and compare.
2. **Pack-evidence tier** — case/pallet against each: relate them through
   the RESOLVED candidate's own `pack.units_per_pack`, the per-product
   evidence the catalog item already carries for exactly this. The
   relationship must belong to the exact resolved variant; pack evidence
   from a different variant does not transfer.

Only when neither tier applies — no factor, no pack evidence, or
mismatched variants — does the pair get the "no comparable basis" badge,
stated, never guessed. After conversion: flagged when the ratio exceeds an
owner-set threshold (default 25%). Golden vectors pin both tiers,
including case-vs-each through pack evidence and the absent-evidence badge
case. `indicative_price` is optional, so the no-baseline case is
stated, not implied: a candidate with no reference price gets a "no reference
price" badge on the approval card — most likely exactly the flagged-new
supplier the owner asked to see clearly. Revision 2 classed divergence as
Fiduciary; that was wrong by Law 1's own test — no order can dispatch without
the owner reviewing this very card, so silence causes no harm. It escalates
to Fiduciary only when something could dispatch WITHOUT fresh review: a
standing grant that auto-submits, or an already-approved order about to
dispatch against changed terms.

Silence is never acceptance, a dead conversation never wedges the draft, and
every terminal state is reachable by an explicit buyer action as well as by
timeout.

---

## 6. The photograph, as a defined artifact

"A blob on the draft" (r1) named no store, no bounds, no lifecycle. Defined:

- **Where**: there is no "commerce persona" to put it in — personas are
  user-configurable and never hardcoded. The artifact lives in an
  `commerce_image_artifacts` table in the SAME encrypted store as the draft
  row that owns it (the commerce tables, SQLCipher like everything else), so
  the repair and review screens always have the photograph beside the values
  regardless of which personas happen to be locked — which is the screens'
  whole point. The consequence is named rather than hidden: images ride in
  the identity store and its backups, which is why the byte ceiling below is
  a hard limit and erasure is tied to the draft's. The draft row stores the
  ordered manifest (`{artifact_id, content_hash, page_index}[]`); a restored
  backup missing a page shows "page N unavailable" for that page — the
  others render, and the manifest hash still verifies any retained evidence.
  Erasure removes every page with the draft.
- **Bounds — enforced at the trusted artifact-INGEST boundary in Core, not
  at capture**: a capture-side limit is a client convention, and an alternate
  client holding the owner capability walks straight past it. Ingest
  enforces page count, per-page and aggregate byte ceilings (default 8 MB
  aggregate), a MIME allowlist, and a TWO-PHASE decode: first a bounded
  header parse that reads the declared dimensions and refuses anything over
  the caps (max width, height, total pixels, frame count, projected decoded
  allocation) WITHOUT decoding — a decompression bomb is a small file
  declaring an enormous image, and a byte ceiling alone admits it to
  exhaust memory during the decode; then the full decode + re-encode,
  which strips EXIF and disarms structural decoder attacks. It refuses
  anything malformed. The stored artifact is revalidated against these bounds before
  any egress authorization is issued. Named tests: malformed image,
  decompression-bomb (proving rejection WITHOUT the declared allocation
  ever happening), oversize, wrong-MIME — each refused at ingest.
- **Linkage**: the extraction commitment records the ordered manifest's
  hashes AND the `draft_id`, and the vouch receipt commits the extraction
  digest (§2.1's chain — without it, a commitment that verifies alone
  proves nothing about belonging to THIS draft), so the retained evidence
  provably shows *which* photograph produced the rows a person vouched for —
  "I wrote 20, not 200" is settled by an image whose hash the chain names.
- **Lifecycle — a policy, not a deferral**: kept after sending (owner
  decision, default keep — evidence is the point), included in export,
  erased when the draft is erased. What "erasable" means: the owner may
  erase any draft EXCEPT one holding a `submitted_unconfirmed` conversation
  — ambiguous commercial evidence is held until §12.7 reconciles it, and
  the screen says why. Erasure is transactional across the draft row, the
  manifest and every page. Named limitation, stated to the owner: erasure
  cannot reach into backups already taken; the data leaves the backup chain
  as backups rotate. A retention screen lists drafts with their sizes so
  "keep after sending" never silently becomes unbounded, invisible growth.
  This policy is REQUIRED work at build steps 2 and 5 — the §10-item-7
  deferral that still stands for the CATALOG draft store does not extend to
  this store, whose policy is the paragraph above. **Its protection is the commerce store's
  SQLCipher encryption at rest — NOT persona lock.** Revision 2 promised
  persona-lock coverage; revision 3 moved the artifact precisely so locks
  cannot hide it from the repair screen, and both claims briefly stood. The
  trade is named as a decision: the photograph gains
  always-available-for-review and loses persona-tier protection, riding in
  the commerce store and its backups — which is why the byte ceiling is hard
  and erasure is tied to the draft's. Unlike the CATALOG draft store, which
  still awaits its §10-item-7 retention policy, this store's policy is the
  Lifecycle paragraph above — required work at build steps 2 and 5, not
  deferred — and it is the more sensitive of the two, holding a retailer's
  demand and photographs.

---

## 7. Owner decisions

Settled 2026-08-15 (r1 set, restated):

1. **Order drafts live beside catalog drafts** in one commerce area.
2. **Unknown suppliers appear flagged as new, never auto-selected.**
3. **One approval is enough** — no threshold re-prompt, no two-person rule in
   v1. Re-read against §5.3's honest timing: this means one COMMERCIAL
   approval per order (the card with the verified total). The earlier confirm
   is a review step on a different day, with its own two-second presence
   proof. If the owner meant "one presence ceremony ever, total", that is not
   deliverable across a supplier's response time and needs a fresh decision.
4. **The photograph is kept** after sending, per §6.

Settled 2026-08-15 (this revision):

5. **Hosted extraction approved** — the owner selected an OpenAI vision
   backend — under the four Hop-1 controls of §3, with on-device preferred
   automatically when a local model exists.

Made by the design, reversible, flagged:

6. **Biometric satisfies presence** (§4.3). If the owner wants typed-only,
   the change is one flag and a recovery story for auto-unlock users.
7. **The five-minute window supersedes per-action binding — recorded as a
   deviation, reversible.** The lane doc's §10 item 9 asked for per-action
   presence ("verifying once is not the same as vouching for THIS
   confirmation"); the shipped `owner_presence.ts` implements a node-global
   window, and this design adopts it: one proof covers any draft operation
   in either lane for five minutes. The honest cost: a passphrase typed for
   a seller review also covers a buyer approval made moments later. The
   upgrade path, if the owner wants it, is per-draft binding on the same
   module.

## 8. Build order

1. The §2.1 frozen shapes in `@dina/commerce-protocol` (extraction
   commitment with `draft_id`, the catalog extraction-binding record, vouch
   receipt committing the extraction digest, conversation snapshot,
   source-bound approval fields with the origin discriminator inside the
   integrity digest, catalog evidence record with pointer authority context
   — with negative vectors: cross-draft, substituted manifest, detached
   receipt, stripped discriminator, forged supplier), plus the
   `commerce_catalog_drafts` in-place column additions; then the extraction seam + the image-egress
   gate + fail-closed test + a deliberately poor fixture (everything
   downstream depends on these)
2. Image artifact store (§6)
3. Seller: picker, repair screen incl. the §4 SKU mint (issuer-scoped
   durable reservation ledger + high-water mark, atomic CLAIM for every
   identifier entering a clean draft — minted, inherited, edited or
   source-provided — keyed to the immutable `assignment_id`, idempotent
   per assignment, single-transaction with the draft mutation; claim
   primitive in Core, minting policy in the pack's importer/assembler,
   with the boundary test; inherited-high-water, source-SKU-vs-mint,
   concurrent-claim, same-assignment-edit, row-reorder,
   crash-between-claim-and-persist, corrupt-assignment-hydration,
   idempotent-republication, deleted-product-reuse, edit-collision,
   erase-unpublished-then-rephotograph and second-catalog-refusal tests; the photo-lane removal of the `collidesWithProductNumber`
   suppression on identifier columns, with its phone-in-sku test), review
   screen, presence wiring on mobile, publish — iOS simulator
4. Maestro flow for the seller journey
5. Buyer: order-draft aggregate + store + state machine (new work, shared
   kernel)
6. Buyer: line resolution + supplier partition, with the §5.2 egress
   contract's fail-closed test (raw extracted line text cannot reach a
   discovery query outside §9.6's opt-in path) and authority-first
   evidence hydration
7. Buyer: quote stages on the existing verifiers; the NEW draft-scoped
   `/orders/drafts/request-quote` operation (Core builds and sends the
   request; idempotent send intent; §5.4 stage 1); the NEW draft-scoped
   `/orders/drafts/approve` route (Core builds the order; unconditional
   presence gate; mints the source-bound approval; internally invokes the
   shared retained-approval builder); the NEW `/orders/drafts/submit`
   orchestrator (steps 1–3 Core-side, four outcome classes, the intent row)
   and the commerce sweeper's intent-replay + transient-retry duty; the
   submit-time source-binding check in `/orders/submit`; the NEW
   conditional presence gate on legacy `/orders/prepare` (refuse a
   hand-built order without a live proof wherever presence can be
   established; behaviour unchanged on convenience-mode nodes), with the
   software-path named test

   *(Standing rule for this list, because the same omission has now happened
   three times: any route or background duty added in §5 MUST appear here in
   the same revision. A route the plan does not build is the "built and
   nothing calls it" defect at the planning stage.)*
8. Buyer lifecycle states + the Solicited divergence warning on the approval
   card (Fiduciary only for the two §5.5 auto-dispatch escalations)
8a. Buyer APP SURFACE — absent from every earlier revision of this list
   while step 9 depended on it: buyer capture (the ordered-manifest picker),
   the order repair and review screens (lines + requirements, provenance
   vocabulary, the two-kinds requirement display incl. "not sent to the
   supplier"), the conversation and approval cards, buyer presence wiring
   on mobile, the §6 retention screen, and a buyer Maestro flow
8b. Observability, metadata-only, BOTH lanes — the lane doc's §10 item 6
   extended rather than silently inherited: named events (capture, ingest
   refusal, extraction, egress authorization, confirm, send, quote
   received, approval, dispatch outcome, reconcile) carrying ids, states,
   counts and latencies ONLY; image bytes, extracted values, quantities,
   prices and free text are prohibited log content, per the codebase's
   PII-never-in-logs rule
9. Two-phone run: retailer's photo to ChairMaker's catalog and back
