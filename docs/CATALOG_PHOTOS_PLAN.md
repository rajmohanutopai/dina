# Catalogue photos — plan

**Status:** DESIGN, 2026-10-02. Nothing here is built.
**Replaces:** the URL form of `CatalogItem.images` (commerce protocol minor 1.1).
**Related:** `docs/PHOTO_CATALOG_LANE.md` (§7: the price-list photo stays in the
vault), `packages/commerce-protocol/docs/conformance.md` (pre-freeze rule,
§9.13 admission), `dina_details.md` ("Transport: MsgBox, and one exception").

This plan says how a supplier's product photos should travel in a published
catalogue, and why. It proposes that each photo be cleaned on the supplier's
node, stored as a blob in the supplier's own PDS repo, named in the catalogue
by its content hash, fetched by buyers from that same PDS, and checked against
the hash before it is shown.

---

## 1. What exists today

- **The field.** `CatalogItem.images?: string[]` — one to four absolute `https`
  URLs with no credentials (`packages/commerce-protocol/src/catalog.ts`,
  `validateCatalogImages`, `MAX_CATALOG_IMAGES = 4`), from minor 1.1. The
  publisher stamps a snapshot and its pointer 1.1 only when an item carries
  images (`catalogProtocolVersionFor`); a reader ignores `images` below 1.1
  (`catalog_item_reader.ts`).
- **Where the URLs come from.** A CSV or connector row's `image_url` column
  (`catalog_import.ts`), published only for rows no model produced
  (`rowImages`, `catalog_draft_ingest.ts`). The photo lane never publishes an
  image.
- **The publication gate.** `buildCatalogSnapshot` runs
  `gateCatalogForPublication` (`catalog_leakage.ts`) before any digest. The gate
  admits only keys in `PUBLIC_CATALOG_FIELDS` and nesting up to
  `MAX_ITEM_DEPTH = 4`; anything else refuses the publication.
- **The draft lifecycle.** `confirmed → prepared → approved → published`
  (`catalog_draft_service.ts`). `prepare` builds the snapshot and freezes its
  digest; `approve` (owner present) binds that digest; publish writes the held
  bytes after re-checking them. A granted connector's refresh runs `confirm`
  and `prepare` with no owner present and stops at `prepared`
  (`routes/commerce.ts`, catalogue refresh).
- **Records.** One snapshot record per publication carries every page inline
  (`catalog_record_writer.ts`); pages hold up to 500 items
  (`MAX_CATALOG_PAGE_ITEMS`), and a snapshot up to 1000 pages. The writer
  writes the snapshot before the pointer, the pointer under CAS.
- **How a buyer sees a photo now.** The phone reads the pointer and snapshot
  straight from the supplier's PDS (`offered_catalog.ts`: PLC lookup →
  `com.atproto.repo.listRecords` / `getRecord`, plain `fetch`), checks the
  digests (`readPublishedItem`), then hands the URL to React Native's `<Image>`
  (`OfferedItemCard.tsx`), which fetches it from whatever host it names.
- **What the reader proves.** `readPublishedItem` checks that the pages, the
  snapshot and the pointer agree with each other. It does **not** check the
  repo commit signature (its own header says so): a PDS that serves a
  self-consistent forged catalogue is believed.
- **Image handling that already exists** (`image_artifacts.ts`, used by the
  photo lane): a bounded header parse that refuses oversized or animated images
  before any decode (`parseImageHeader`, `MAX_IMAGE_DIMENSION = 8192`,
  `MAX_IMAGE_PIXELS = 20_000_000`); an injected re-encoder that strips EXIF
  (`ImageReencoder = (bytes, mime) => {bytes, mime}`, installed by
  `core-server/src/image_pipeline.ts` — sharp, JPEG quality 88, PNG kept as
  PNG — and `mobile/src/services/photo_pipeline.ts` — the image manipulator,
  always JPEG at 0.85); and Core re-checking the re-encoded bytes. JPEG and PNG
  only, inputs up to 4 MiB (`MAX_PAGE_IMAGE_BYTES`). **Neither adapter
  resizes, and the contract has no size, quality or format setting.**
- **Fetching supplier-named URLs** (`catalog_feed_policy.ts`, pure policy;
  `fetchUnderPolicy` in `catalog_ingest.ts`; the server's
  `connector_transport.ts`): URL checks, a redirect check and cap on every hop,
  and `isBlockedAddress` on the connected address — **checked after the
  response arrives**, with the body returned as a UTF-8 string and fixed limits
  (8 MiB, 60 s). That suits text feeds; it does not suit photos (§6.4).
- **The AppView** does not index `images`. It admits any minor of a supported
  major (`checkProtocolVersion`).
- **Age.** `images` was committed on 2026-10-02 (`85a41b79`). No released app
  build reads it. On the test bed, albert's catalogue (snapshot 3) carries one
  photo URL at 1.1; some bed catalogues republished on 30 September carry URLs
  at 1.0 (ignored).

## 2. Why the URL form is the wrong long-term shape

1. **The suppliers Dina is built for have nowhere to put a photo.** The
   trade-first plan targets small distributors who photograph stock on a phone.
   A URL field serves only suppliers who already host images. Every Dina
   supplier already has a PDS repo.
2. **The photo is the one part of a catalogue the digests do not cover.** The
   page digest covers the URL string, not the picture, so the picture can change
   after publishing and every digest still checks. Photos sway purchases, so a
   swapped photo is the obvious abuse.
3. **It sends the buyer's phone to hosts the supplier chooses.** Each photo
   tells that host the buyer's IP address and when they looked — the pattern a
   tracking pixel uses.
4. **Links rot, and nothing bounds what is behind them** (size, type, content).

## 3. Requirements

- **P1** A supplier can publish product photos with no hosting of their own.
- **P2** A buyer shows a photo only if its bytes hash to the reference in the
  catalogue the reader checked. (Trust assumption, §11: the reader checks the
  catalogue's digests, not the repo signature, the same as for every other
  field today.)
- **P3** A buyer's device fetches photos only from hosts it already contacts to
  read the catalogue (PLC and the supplier's PDS) or from Dina's own
  infrastructure, and follows no redirect to any other host.
- **P4** A published photo carries no location, device or other metadata.
- **P5** Old readers keep working: an item with photos must not disappear on a
  build that predates them, and a catalogue without photos keeps its current
  bytes and digest.
- **P6** Sizes, counts, pixels, work and storage are bounded on the writer and
  the reader, including totals, not only per photo.
- **P7** Dina can stop a photo being shown — including copies already cached on
  buyers' devices — without the supplier's cooperation.
- **P8** The owner approves the exact photos that publish; nothing changes after
  approval. Core decides what is published; the composition root does repo and
  network I/O.
- **P9** A photo the owner added survives later republishes (a CSV re-import or
  a connector refresh) until the owner removes it.

## 4. Options considered

| | Option | P1 no hosting | P2 hash-bound | P3 known hosts | New work |
|---|---|---|---|---|---|
| A | Keep supplier URLs | no | no | no | none |
| B | URL + byte hash; AppView fetches, checks, serves | no | yes | yes | AppView image service |
| C | **Blob in the supplier's PDS; phone fetches from that PDS and checks the hash** | yes | yes | yes | upload step; phone check; a small takedown list on the AppView (§10) |
| D | Blob in the PDS; AppView proxies the original bytes | yes | yes | yes | C + AppView image service |
| E | Image bytes inline in the catalogue record | yes | yes | yes | impossible within the record limit (§8) |

**Choice: C now, D when needed.** C meets every requirement; its only new
service is a small read-only takedown list (§10). The phone already reads the
catalogue from the supplier's PDS, so fetching a blob from the same PDS adds no
host. D adds caching and one place to stop serving a photo; §12 lists what would
make it worth building. B fails P1. E cannot fit (§8).

## 5. Wire shape and versioning

### 5.1 A new field: `photos`

```jsonc
"photos": [
  {
    "blob": {                       // an AT blob reference
      "$type": "blob",
      "ref": { "$link": "bafkrei..." },   // CIDv1, raw codec, sha2-256
      "mimeType": "image/jpeg",
      "size": 183406
    },
    "width": 1600,
    "height": 1200
  }
]
```

- One to four entries (`MAX_CATALOG_PHOTOS = 4`). `mimeType` is `image/jpeg` or
  `image/png` (the re-encoder's outputs, §6.2). `size` ≤
  `MAX_CATALOG_PHOTO_BYTES` (1 MiB). `width` and `height` are the image's real
  header dimensions, each ≤ 2048 (§6.2), so a reader can lay out before the
  bytes arrive and must refuse bytes whose header disagrees (§9).
- **The supplier's node computes the reference itself**, from the cleaned bytes,
  before `prepare` (§7). The PDS's answer to the upload must equal it (§7.3).
- **A new name, not a new shape for `images`.** A reader that knows the 1.1
  rule validates each `images` entry as an `https` string; an object there fails
  and the reader drops the whole item. Under a new name, a reader that predates
  photos treats `photos` as an unknown additive key and keeps the item (P5).

### 5.2 Version

- Commerce minors are one ladder for the whole protocol: 1.1 carries
  `images` and `payment_terms.due_basis`; 1.2 carries
  `QuoteRequestLine.requirement`. **`photos` takes minor 1.3.**
- The protocol is pre-freeze (`conformance.md`: changes may land without a
  bump). Minors are still used as reader gates where a field must not be acted
  on by builds that predate it — the owner asked for that gate for `images` —
  and `photos` follows that rule. The publisher stamps a snapshot and its
  pointer 1.3 only when an item carries photos; a catalogue without photos
  keeps its bytes and digest. A reader ignores `photos` below 1.3. The change
  is recorded in the conformance changelog.

### 5.3 What happens to `images`

- Writers stop emitting `images` once photos ship. A row's `image_url` becomes
  an offer the owner may copy in (§6.3); it is never published as a URL.
- Readers keep validating `images` per the 1.1 rule, so an item carrying it is
  still readable, but **do not render it**: rendering means fetching a
  supplier-chosen host (§2.3). Decision D1 (§13).

### 5.4 The digest and the PDS's rewriting

The PDS stamps `$type` into stored records (the epoch-record failure of
2026-08-16) and stores blob references in its own binary form, returning them as
`{"$type":"blob","ref":{"$link":…},"mimeType":…,"size":…}`. The page digest is
canonical JSON over each item, so a reference that comes back in any other form
breaks every photo-carrying page on read.

**Phase 0 gate (§15):** on the real test PDS, write a snapshot whose item
carries the §5.1 reference, read it back with `getRecord` and `listRecords`, and
confirm the page digest recomputes exactly. The fake PDS used by tests must then
do the same conversion.

**Fallback if the round trip is not exact:** the item carries
`{"cid", "mime_type", "size", "width", "height"}` (plain strings and numbers,
digest-covered), and the snapshot record gains a top-level `photo_blobs` list of
blob references — outside `snapshot` and `pages`, so outside every digest —
whose only job is to make the PDS keep the blobs (§7.4). Every record-level
reader must then accept that one extra key.

### 5.5 The publication gate

`photos` is admitted the way `attributes` is: by name, with its own structural
check, so the closed vocabulary stays closed.

- `photos` joins `PUBLIC_CATALOG_FIELDS`. The gate validates its subtree against
  the exact §5.1 shape (or the §5.4 fallback shape): only those keys, those
  types, those bounds; any extra key anywhere under `photos` refuses the item.
- Only the `photos` subtree may reach depth 5 (`photos[i].blob.ref.$link`);
  `MAX_ITEM_DEPTH` stays 4 for every other path.
- The gate's string scanners (`§12.1` patterns) run over the CID like any other
  string; a CID is base32 lowercase and is checked against them in phase 1.
- Tests: an item with the exact shape passes `buildCatalogSnapshot`; a stray key
  inside `photos`, a sixth level outside `photos`, and a fifth photo are each
  refused.

## 6. The photo library

### 6.1 Photos belong to the catalogue, not to one draft

Every publication is a full snapshot built from a fresh draft (a CSV import, a
connector refresh, a photo-lane extraction), and none carries anything from the
previous publication. Photos held on a draft would vanish at the next
republish. So the node keeps two things in `identity.sqlite`:

- **A byte store keyed by CID.** Each cleaned photo is stored once under its
  CID, with its MIME type, size and dimensions. An entry stays while a library
  association, an unpublished draft or an unresolved publication attempt
  refers to it, and is deleted when none does. Published snapshots do not pin
  bytes: once a snapshot record exists the PDS keeps its blobs, and publish
  never re-uploads them (§7.2 step 0), so the owner can always free space by
  removing photos. The byte-store cap (§8) counts every stored CID once.
- **A photo library per catalogue:** associations
  `(catalog_id, product key, position) → CID`. The product key is the canonical
  form of the item's `ProductRef`. An association lasts until the owner removes
  it (P9); a product that leaves the catalogue for a season keeps its photos
  for when it returns. The review screen lists photos whose product is not in
  the current catalogue, so the owner can remove them, and they count toward
  the cap.

How drafts use them:

- **A draft holds CIDs, never library positions.** When a draft is built, each
  item takes the library's CIDs for its product key, and those CIDs (pinned in
  the byte store) are what `prepare` commits to and publish uploads. A
  connector refresh therefore keeps the owner's photos (P9) without fetching
  anything.
- **The owner changes photos on a draft's review screen.** The change goes
  through the draft service's existing edit path (`recordEdit`): the draft
  returns to `created`, its content revision goes up, and its receipt, held
  snapshot and approval are cleared, so it must be confirmed again — with
  presence and a fresh content receipt for a model-derived draft — before it can
  be prepared and approved (P8). Edits are refused while a publication claim is
  held, as for any edit.
- **A library change is one catalogue-wide operation**, in one database
  transaction: it updates the associations, applies the edit to every other
  unpublished draft of that catalogue (each back to `created` with the new
  CIDs), and moves the pins. If any draft of the catalogue holds a publication
  claim, the whole change is refused and nothing changes.
- **Telling a live publication from a dead one.** A claim's age cannot tell a
  slow publish from a dead one — with photo uploads inside publish, a phone on a
  slow link can stay live well past today's five-minute claim TTL — so nothing
  here decides by age. Instead:
  - each claim records the **boot id** of the Core process that took it (a
    random id minted at each start), and the process keeps an in-memory set of
    the drafts it is publishing right now;
  - one Core process writes a node's repo (the restore epoch already fences a
    second device), so a claim taken under an **earlier boot id is certainly
    dead**: that process cannot write any more;
  - a claim under the **current boot id is live exactly while the draft is in
    the in-memory set**.

  A live claim refuses the photo change with "a publication is in progress".
  The same rule governs a second `publish` taking over a claim: it may take
  over a dead claim, never a live one, whatever its age.
- **A dead process does not prove its last request is dead.** A pointer write
  sent just before a crash can still commit at the PDS afterwards (the PDS
  finishes a request whether or not the client is still there). So each claim
  also records, durably and **before** each send, how far the attempt got:
  `uploading` → `snapshot_sent` → `pointer_sent`. A dead claim makes the finding
  name the draft ("an unfinished publication of draft X holds this catalogue"),
  and what the owner may do depends on that stage:
  - **`uploading` or `snapshot_sent`: Discard.** No pointer write was ever
    sent, and a snapshot record without a pointer is inert (it only keeps its
    blobs). Under the draft store's lock, and only if the claim is still that
    same dead one, Discard runs §7.2 step 0's read; if the publication somehow
    landed it is recorded as published; otherwise the approval is voided, the
    claim released and the draft returns to `created`.
  - **`pointer_sent`: Resume.** The pointer write may still arrive, so the draft
    stays locked and the offered action is Resume — publish again from step 0
    under a new claim, which either finds the publication landed and records it,
    or completes it. Either way the result is the publication the owner
    approved. Discard becomes available only 10 minutes after the recorded send
    time, with a plain warning that the earlier, approved publication could
    still appear; if it does, the next publish loses its swap, adopts that head
    (§7.3) and publishes after one rebuild, and Discard also marks the catalogue
    so its next `prepare` re-reads the head. That residual case is an accepted
    risk (§14).

  Then the photo change can be made. So once a change succeeds, no unpublished
  draft still carries the replaced photos.
- **`prepare` checks the draft's revision before it writes its result.** Today
  `prepare` reads a draft, awaits reconciliation, then writes the draft it read;
  an edit landing in between would be overwritten. With photos that would
  restore replaced CIDs, so `prepare` writes only if the draft's
  `contentRevision` is unchanged and otherwise discards its result and reports
  the draft as changed. (The same race exists today for any edit; this closes
  it.) Pins are released only after the transaction that drops the last
  reference commits.
- Library photos are product photos the owner chose to publish. They are not the
  photo-lane price-list image, which stays out of every public record.

### 6.2 Cleaning

Every photo, from any source, goes through the same steps before it enters the
byte store. All of them run in Core (P8). Steps 1 and 3 use what exists in
`image_artifacts.ts`; step 2 needs new adapter work (phase 1).

1. **Header parse, before any decode** (`parseImageHeader`): JPEG or PNG only,
   input ≤ 4 MiB (`MAX_PAGE_IMAGE_BYTES`); refuse anything over the existing
   pixel and dimension caps, and animated PNG.
2. **Re-encode in catalogue-photo mode.** The `ImageReencoder` contract gains an
   options argument — target long edge, JPEG quality, output-format rule — and
   both adapters implement it: sharp on the server (`resize` with
   `fit: 'inside'`, `withoutEnlargement`), the image manipulator on the phone
   (`resize`). Catalogue mode: at most 2048 px on the long side, JPEG at
   quality 80; a PNG input with an alpha channel stays PNG, everything else
   becomes JPEG. With no options the adapters behave exactly as today, so the
   photo lane is unchanged. A full re-encode drops every metadata segment —
   EXIF, XMP, comments, embedded secondary images, trailing bytes — so P4 does
   not depend on a list of segment types.
3. **Re-check the output** against the caps (header parse again; size ≤ 1 MiB;
   dimensions ≤ 2048). The adapter is not the trust boundary; Core is.
4. **Compute the reference** from the output bytes: CIDv1, raw codec, sha2-256,
   plus MIME type, size and header dimensions.

A host with no re-encoder installed cannot add photos (a refusal, not a
fallback). Phone uploads reach Core in-process. Browser uploads through Core's
`/app` cannot use the ordinary owner routes, whose bodies are capped at 2 MiB
by the server's Fastify `bodyLimit`; they use a dedicated owner route that
takes the raw image bytes (`image/jpeg` or `image/png` body, no base64) with its
own 4 MiB limit and the same owner authentication. Both arrive as bytes of up
to 4 MiB and are resized here; the phone may also shrink before upload to save
bandwidth.

### 6.3 Where photos come from

- **The owner's device.** Camera or gallery on the review screen; the phone's
  manipulator resizes before upload to save bandwidth, then Core cleans as in
  §6.2 regardless.
- **Copy-in from a URL, by owner action only.** When a CSV or connector row
  names `image_url`, the import records it as an offer on that row; nothing is
  fetched. The owner, present (presence-gated like other catalogue
  operations), taps **Copy photos in** on the review screen; only then does the
  node fetch. A connector refresh never fetches images, and an unattended
  `prepare` never fetches anything.
- **Copy-in fetch rules (§6.4).** Per fetch: 10 s, 4 MiB raw read cap (the
  §6.2 input cap; the 1 MiB cap applies after cleaning), type sniffed from the
  bytes. Per operation: at most 200 photos, 4 at a time, 5 minutes in total;
  rows past any bound get a finding. Each fetched photo is cleaned as in §6.2.
- **The transport rule.** Copy-in is a new outbound fetch, so it needs a second
  narrow exception in `dina_details.md`: an owner-initiated, presence-gated
  fetch of URLs that appear in the owner's own draft, through the copy-in
  fetcher (§6.4), on the server Home Node only, never scheduled, never
  credentialed, never triggered by a connector. Decision D2 (§13). Without it,
  photos come only from the owner's device.

### 6.4 The copy-in fetcher

The connector fetcher cannot be reused as it is: it checks the connected
address only after the request has gone out and the response has come back, it
returns text, and its limits are fixed for feeds (§1). Copy-in gets its own
injected transport, built on the same pure policy (`checkCatalogFeedUrl`,
`isBlockedAddress`, `checkCatalogFeedRedirect`):

- **Address checked before any HTTP byte is sent.** The transport resolves the
  host itself, refuses if any resolved address is blocked, and connects only to
  a checked address (on Node, a custom `lookup` on the request), then confirms
  the socket's remote address before writing the request. The same on every
  redirect hop; at most 3 hops; no credentials or cookies on any hop.
- **Blocked addresses** are `isBlockedAddress`'s ranges plus the node's own
  interface addresses, injected by the host (on Node, `os.networkInterfaces()`).
- **Bytes, bounded.** The response is returned as a `Uint8Array`; the transport
  aborts as soon as the 4 MiB cap or the 10 s deadline is passed, without
  reading further.
- **Where it runs.** Only the server Home Node can pin connections this way.
  The phone's `fetch` cannot, so a phone node offers no copy-in; its owner adds
  photos from the device (§6.3).

## 7. Publishing

### 7.1 What the digest covers

The draft's items carry their photo references (§6.1) from the moment the draft
is built or the owner changes a photo. `prepare` builds the snapshot with those
references inside, so the digest the owner approves covers the exact photos
(P8). Every check that can refuse — the per-catalogue budget (§8), the record
budget (§8), the gate (§5.5) — runs at `prepare`, before approval; nothing is
dropped after it.

### 7.2 Order of writes at publish

Core owns the publish sequence (`publishHeldDraft` → `publishCatalogRecords`),
so Core decides; the composition root does the I/O through a new injected seam,
`installCatalogBlobUploader` / `getCatalogBlobUploader`, the counterpart of the
record writer's seam, installed on both hosts beside it
(`packages/home-node/src/commerce_catalog_repo.ts`, with the same per-write
repo-identity check). The repo clients (`EpochRepoClient` / `PDSClient`) gain
`uploadBlob(bytes, mimeType)`.

**Before any upload, in `publishHeldDraft`**, beside the existing
reconciliation in `catalog_draft_publisher.ts` (a node with a record writer
already must have a record reader):

0. **Is it already there?** Read the head pointer and the snapshot record under
   the held digest. A read that fails refuses the attempt as transient, with
   nothing uploaded. Then, using the existing pointer validation and the same
   current-and-predecessor comparison the reconciliation already makes:
   - the pointer names the held snapshot **and** the fetched snapshot record
     re-derives (snapshot digest and every page digest) to the held
     publication: the publication happened (a lost answer). Return
     `already_published` with the live pointer, which `publishHeldDraft`
     records through `recordPublication`; upload nothing.
   - the snapshot record re-derives to the held publication but the pointer
     does not name it: its blobs are kept by that record; call
     `publishCatalogRecords` in its pointer-only form (steps 1–3 skipped) and
     write only the pointer.
   - the record under the held rkey is missing: continue at step 1 (the
     snapshot write is content-addressed, so writing it is safe).
   - the record under the held rkey exists but does not re-derive to the held
     publication: refuse `remote_snapshot_mismatch` with a finding; write
     nothing.

   Whenever step 0 decides new writes are needed (the pointer-only form
   included), the node's takedown check (§10) runs next; a listed CID refuses
   `photo_taken_down` before anything is uploaded or written.

**Then inside `publishCatalogRecords`**, after the existing page checks and
before the snapshot write:

1. **Blobs.** For each photo in the held snapshot, take its bytes from the byte
   store by CID and upload them (`com.atproto.repo.uploadBlob`). Uploading the
   same bytes again is harmless. Each upload has its own 120 s timeout (sized
   for 1 MiB on a slow link), never the 15 s default the repo client uses for
   record writes (`PDSPublisher`); the whole publish has a deadline of 120 s per
   photo plus 60 s, capped at 60 minutes. Passing either aborts the attempt
   with `blob_upload_failed`. No uploader installed and the snapshot carries
   photos: refuse `no_blob_uploader`. Bytes missing from the store: refuse
   `blob_bytes_missing`. Upload refused: refuse `blob_upload_failed`. (Whether
   a PDS refuses to accept again a blob it has taken down is confirmed in
   phase 0; the plan does not rely on it — see §10.)
2. **Check each answer.** The PDS's returned reference must equal the committed
   one — CID, MIME type and size — else refuse `blob_ref_mismatch`.
3. **Snapshot**, carrying the references (unchanged approved bytes).
4. **Pointer**, under CAS, as today.

Any refusal in steps 1–2 happens before any record is written; the draft returns
to `confirmed` with a finding naming the photo (for a takedown, the owner
removes that photo, which is an edit, §6.1).

### 7.3 Retries and crashes

- Every attempt starts at step 0, so a publication that already landed — with
  its records checked, not merely named — is recognised before anything is
  uploaded again.
- Crash or error before the snapshot write: the next attempt uploads again
  (idempotent); unreferenced uploads expire on their own (§7.4). The byte store
  keeps the bytes pinned until the attempt is resolved.
- Snapshot written, pointer not: step 0 skips the uploads and writes the
  pointer; the existing reconciliation in `catalog_draft_publisher.ts` still
  handles an ambiguous pointer write.
- A CAS loss returns the draft to `confirmed` as today; its CIDs stay pinned.
  **And the live head is adopted when it is newer.** Today a lost swap whose
  live head names neither this draft's snapshot nor its predecessor is
  recorded nowhere, and `prepare` re-reads the repo only when the local pointer
  row is missing — so every later draft is built on the stale head and loses
  its swap again, until someone calls `/v1/commerce/catalog/adopt` by hand. A
  late pointer write after a Discard (§6.1) produces exactly that. So: on a lost
  swap, if the live head is a valid pointer of this catalogue in the node's own
  repo at a sequence ≥ the local one, it is adopted into the pointer store
  through `reconcileHead`'s existing adoption; and a Discard at `pointer_sent`
  marks the catalogue so its next `prepare` re-reads the head. The next draft
  then publishes after one rebuild.
- A crash mid-publish leaves the claim under that boot id; after restart it is
  dead (§6.1), and the next publish (or Resume) takes it over and starts at
  step 0.
- **When an attempt ends** — succeeds, fails, times out or throws — the draft
  always leaves the in-memory set of live publishes (in a `finally`). The claim
  is released at the same time **unless the attempt reached `pointer_sent` and
  did not learn the outcome** (the pointer write timed out, or the following
  reconciliation could not read the head). Then the claim stays, now dead
  (current boot id, not in the live set), at `pointer_sent` with its send time,
  and the §6.1 rule applies exactly as after a crash: Resume first, Discard only
  10 minutes after the send, with the warning. A failed Resume keeps that state
  and its original send time. This applies to every publication, with or
  without photos, because the ambiguity exists for any pointer write; it
  changes one existing expectation — today a failed publish releases its claim
  at once and the draft is editable (the failure-path test in
  `catalog_draft_service.test.ts`), which becomes true only when the failure
  happened before `pointer_sent` or its outcome is known.

### 7.4 Keeping and removing blobs

Where the PDS keeps a blob's bytes — local disk or an S3-compatible bucket — is
a PDS setting that no record mentions, since records name blobs by hash. Before
photos ship, the community PDS keeps them in a bucket (§14, D4).

The PDS keeps a blob while a record refers to it and removes uploads no record
refers to after a while (phase 0 confirms the interval, and that the PDS finds a
reference inside a record of an unknown collection). Snapshot records are never
rewritten, so every photo in every retained snapshot stays stored on the PDS. Deleting old
snapshot records frees their blobs (decision D4).

## 8. Limits

| Limit | Value | Enforced |
|---|---|---|
| Photos per item | 4 | gate (§5.5), library |
| Bytes per photo | 4 MiB in, 1 MiB after cleaning | §6.2; reader (1 MiB) |
| Dimensions | ≤ 2048 px each side, real header values | §6.2; reader |
| Pixels before decode | existing `MAX_IMAGE_PIXELS` / `MAX_IMAGE_DIMENSION` | `parseImageHeader`, writer and reader |
| Types | JPEG, PNG; no animation | §6.2; reader |
| Byte store per catalogue | 200 MiB, every stored CID counted once (published snapshots pin nothing) | when a photo is added; adding past it is refused |
| Snapshot record | serialized JSON under the PDS request limit with a margin | at `prepare` |
| Copy-in per operation | 200 photos, 4 at a time, 5 minutes | §6.3 |
| Reader cache | 100 MiB, least-recently-used eviction | §9 |

- **The record limit.** Pages are inline in one snapshot record, and the
  reference PDS limits a `putRecord` JSON body to about 1,000,000 bytes (phase 0
  confirms on our deployed PDS). Each photo adds about 200 bytes of reference;
  four photos on 500 items add about 400 KB. `prepare` measures the serialized
  record and refuses with a finding past the limit less a margin. This also
  protects catalogues without photos, which face the same limit today. Inline
  image bytes (option E) cannot fit at all.
- **The community PDS.** The 200 MiB cap binds only an honest node: any
  account can call `uploadBlob` directly, and the PDS has no per-account quota.
  The deploy sets `PDS_BLOB_UPLOAD_LIMIT` to 1 MiB (phase 1), and blob storage on
  the community PDS is monitored; anything beyond that is an accepted risk until
  usage shows a need (decision D4).

## 9. Reading and showing photos

- **Fetch** each photo from the supplier's PDS (the endpoint already resolved
  from PLC for the catalogue) with `com.atproto.sync.getBlob?did=…&cid=…`.
  **Before fetching**, the takedown list must have no entry for
  `(supplier DID, CID)` and must have been fetched at least once (§10).
  **Redirects are refused**, so no other host receives the request (P3): fetch
  with `redirect: 'error'`; where a platform does not honour it, `redirect:
  'manual'` and refuse any 3xx or opaque-redirect response; where a platform
  follows redirects regardless, photos do not render on it until that is solved
  (a phase 0 outcome, §15). Only when the item is on screen; at most 4 fetches
  at a time; 15 s timeout; 1 MiB read cap.
- **Check, in this order, before any decode:**
  1. the takedown list still has no entry for `(supplier DID, CID)`;
  2. the CID is v1, raw codec, sha2-256, and the bytes hash to it (multiformats
     is already bundled on the phone for the plugin repo proof);
  3. size ≤ 1 MiB; the bytes sniff as the declared type;
  4. `parseImageHeader` passes, no animation, and the header dimensions equal
     the declared `width`/`height`.

  Any failure shows the placeholder and logs metadata only (supplier DID
  prefix, reason) — never bytes or URLs.
- **Cache** checked bytes keyed by `(supplier DID, CID)`: a file in the app
  cache on native, an object URL in the browser; 100 MiB with
  least-recently-used eviction. **Every display, including a cache hit, re-checks
  the takedown list first**, and a listed entry is purged from the cache.
- **Old snapshots:** below 1.3, `photos` is ignored; at 1.1 or later, `images` is
  validated but not rendered (D1).

## 10. Takedown

A photo can be stopped in two places, and P7 needs both.

- **At the source.** For suppliers on Dina's community PDS, the PDS admin takes
  the blob down; later `getBlob` calls fail.
- **On devices, including cached copies: a takedown list.** A new read-only
  AppView endpoint, `com.dinakernel.commerce.listPhotoTakedowns`, returns
  `(did, cid, at)` entries since a cursor. Entries are added only by the
  operator, with one CLI command (`catalog-photo takedown <did> <cid>`, beside
  the PeerLens moderation CLI, and run like it through the `dina-moderate`
  wrapper, so every entry is journalled off-server and survives a restore —
  `docs/DISASTER_RECOVERY_PLAN.md` §4.2). It first commits the list entry with
  `pds_status = pending` (so devices hide the photo at once), then, for a
  supplier on the community PDS, takes the blob down there
  (`com.atproto.admin.updateSubjectStatus`) and marks the entry `done`. The
  two systems cannot share a transaction, so the command is idempotent: run
  again, it finishes any `pending` entry; `catalog-photo pending` lists them;
  a failure is reported as "listed, PDS takedown pending". For a supplier on
  another PDS the entry stays `external` and the runbook adds a request to
  that operator. Readers fetch the list from the AppView they already use, at most
  every 15 minutes while photos are on screen, keep it on the device, and check
  it before fetching and before every display.
- **When the list has never been fetched** (a fresh install, a cleared cache):
  placeholders until the first fetch succeeds.
- **When the list cannot be refreshed:** for up to 24 hours readers use the
  last copy; after that they show placeholders until a refresh succeeds (fail
  closed). Decision D5 (§13).
- **For suppliers on other PDSes,** the list is Dina's only lever over what its
  apps show; the bytes stay with that PDS's operator.
- **Content that must be removed outright** (an illegal image, a legal order):
  after the takedown, the bytes are purged from every version in the community
  PDS's blob bucket and its archive (`docs/DISASTER_RECOVERY_PLAN.md` R13).
- **The supplier's node checks the list too**, so a taken-down photo cannot be
  republished whatever the PDS does with a repeat upload.
  - **Seam.** Core has no AppView client, so the list reaches it through an
    injected reader, `installCatalogPhotoTakedownReader` /
    `getCatalogPhotoTakedownReader`, installed by both composition roots (which
    already talk to the AppView). Core keeps the last copy it received, with its
    fetch time, and asks for a refresh at most every 15 minutes when it needs
    the list.
  - **Where it is checked:** when a photo is added to the library; at
    `prepare`; and at publish, after step 0 has decided that new writes are
    needed and before any upload or pointer-only completion (§7.2). A listed
    CID refuses with a finding naming the photo (`photo_taken_down`); the owner
    removes it, which is an edit. Read-only reconciliation of a publication
    that already landed (step 0's `already_published`) is never blocked.
  - **Only photo-carrying work consults it.** A catalogue without photos never
    asks for the list, so no existing flow — including a connector's unattended
    refresh of a catalogue without photos — gains a dependency on the AppView.
  - **When the list cannot be refreshed:** adding a photo is refused if no copy
    has ever been fetched; `prepare` and publish use the last copy while it is
    under 24 hours old, and past that refuse with a transient finding
    (`takedown_list_stale`) and change nothing. An unattended connector
    `prepare` of a photo-carrying catalogue during a longer AppView outage
    therefore stops with that finding, and the next refresh retries.
- A report path for catalogue photos (like PeerLens reports) is later work.

## 11. Privacy and trust

- **Hosts a buyer contacts:** PLC, the supplier's PDS, and the AppView — the
  same as for reading a catalogue and searching today. No supplier-chosen host.
- **What a supplier publishes:** pixels only; §6.2 removes all metadata.
- **Trust assumption (P2).** The reader binds photo bytes to the catalogue it
  checked, but, as for every catalogue field today, it does not check the repo
  commit signature, so a PDS that serves a forged, self-consistent catalogue
  could serve matching forged photos. Closing that gap means verifying the repo
  proof when reading a catalogue; the plugin install path already has a
  verifier (`@dina/home-node/repo_proof_chain`). That is separate work and
  covers every catalogue field, not only photos.

## 12. When to build the AppView proxy (option D)

Build it when any of these holds: photo bandwidth on the community PDS becomes a
cost; takedowns need a faster or wider choke point than §10; or suppliers
commonly sit on PDSes buyers should not have to contact. The proxy fetches by
CID, checks the hash, and serves the **original bytes** at an immutable
`(did, cid)` URL, so the reader's hash check is unchanged and only the host
moves. Thumbnails change the bytes and so the CID; they need their own
references committed by the writer (a second, smaller blob per photo) and are
outside this plan.

## 13. Decisions for the owner

- **D1 — `images` after photos ship.** Recommended: stop writing it; readers
  validate but never render it. Alternative: keep rendering during a transition
  (keeps §2.3's problem).
- **D2 — copy-in of imported image URLs (§6.3).** Recommended: allow it as a
  second narrow transport exception, owner-initiated, presence-gated and
  server-only, written into `dina_details.md`. Alternative: photos only from the
  owner's device.
- **D3 — option C first (§4).** Recommended. Alternative: the AppView proxy (D)
  from day one.
- **D4 — storage.** Recommended: the 200 MiB byte-store cap per catalogue, a
  1 MiB PDS blob limit with monitoring, keep the last three snapshot records per catalogue (older
  ones deleted, freeing their blobs). Alternative: keep every snapshot. In
  either case the community PDS keeps blobs in an S3-compatible bucket before
  photos ship (§14); which provider holds prod's bucket is decision D10 in
  `docs/DISASTER_RECOVERY_PLAN.md`.
- **D5 — takedown fail mode (§10).** Recommended: fail closed after 24 hours
  without a list refresh. Alternative: keep showing photos while the AppView is
  unreachable (a taken-down photo stays visible during the outage).

## 14. Risks

- **Blob reference round trip** (§5.4) — the class of check that broke the epoch
  record. Phase 0 exists for it.
- **The PDS's upload answer** (§7.2) — if the PDS reports a different MIME type
  than the node computed, every publish refuses; phase 0 checks it.
- **Community PDS storage and bandwidth** grow with adoption; §8 bounds an honest
  node only. Under §8 a supplier tops out near 200 MiB of photos, so a few
  hundred suppliers would fill the prod server's 150 GB disk. So **the community
  PDS keeps its blobs in an S3-compatible bucket before photos ship**
  (`PDS_BLOBSTORE_S3_*`; `docs/DISASTER_RECOVERY_PLAN.md` §4.9 covers the
  blob bucket, the append-only archive at a second provider, the switch, and
  restores). Photos are addressed by
  hash, so this changes no record; doing it first, while the PDS holds a few
  megabytes, means nothing has to be moved off a live, growing disk later. The
  AppView proxy (§12) can later cache through an S3-backed CDN. The supplier's
  PDS stays the place a photo is published.
- **Dina hosts what suppliers upload** on its community PDS, so takedown (§10)
  ships in the same release as photos.
- **Phone memory** — fetch only on screen, cap the cache, decode only after the
  header check.
- **A pointer write that arrives after its publish was discarded** (§6.1). It can
  happen only if a pointer write's outcome was never learned (Core died, or the
  write timed out) and the owner chose Discard more than 10 minutes later. What
  arrives is a publication the owner approved; the next publish loses its swap,
  adopts that head (§7.3) and publishes after one rebuild. Accepted.

## 15. Phases and tests

- **Phase 0 — spike (test PDS).** Upload a cleaned photo; check the returned
  reference equals the locally computed one; write a snapshot carrying it; read
  back with `getRecord` and `listRecords`; recompute the digest. Confirm the PDS
  keeps a blob referenced from an unknown collection; measure unreferenced-upload
  expiry, the upload cap and the `putRecord` body limit; confirm `expo/fetch`
  and the browser refuse redirects with `redirect: 'error'` (else `'manual'`,
  else no photos on that platform, §9); observe what the PDS does when a blob
  it has taken down is uploaded again. Run the spike with the test PDS's blob
  store already switched to S3 (Hetzner Object Storage, Helsinki) and its
  archive running, and confirm the existing blobs were copied across and still
  serve (§14). Outcome picks
  §5.1 or the §5.4 fallback.
- **Phase 1 — protocol, library, publish.** `photos` and the 1.3 gate in
  `@dina/commerce-protocol` with conformance vectors and a changelog entry; the
  gate's `photos` subtree (§5.5); the byte store, library and draft wiring
  (§6.1); the re-encoder's catalogue-photo mode on both adapters and cleaning
  (§6.2); owner-added photos and the browser photo-upload route; `uploadBlob`
  on both hosts and the Core uploader seam; the publish steps 0–4 and refusals
  (§7); the revision check in `prepare`; the stale-claim Discard;
  `PDS_BLOB_UPLOAD_LIMIT` in the infra deploy; prod's PDS blob store switched
  to its S3 bucket, with the existing blobs copied across
  (`docs/DISASTER_RECOVERY_PLAN.md` §4.9).
- **Phase 2 — read, show, take down.** Fetch, check, cache, render on phone and
  browser; the takedown endpoint and CLI; the reader checks; the node's
  takedown reader seam and its checks at add, `prepare` and publish (§10).
  Photos ship to suppliers only when phase 2 is done and prod's PDS keeps its
  blobs in S3 (§14).
- **Phase 3 — copy-in**, if D2 allows: the pinned-connection binary fetcher
  (§6.4) on the server.
- **Tests that must exist:**
  - digest round trip through a fake PDS that stamps `$type` and converts blob
    references as the real one does;
  - a reader that predates photos keeps the item (P5);
  - gate: exact shape passes; stray keys, extra depth and a fifth photo refused;
  - approval: changing a photo on a confirmed model-derived draft returns it
    to `created`, and it publishes only after a new presence-gated confirm with
    a fresh receipt; an approved digest covers the photo references; a PDS
    answer that differs from the committed reference refuses
    (`blob_ref_mismatch`) before any record write; a photo snapshot with no
    uploader installed refuses (`no_blob_uploader`) before any write;
  - library: a connector refresh keeps the owner's photos; removal sticks; a
    product absent for more than 30 days and then re-imported gets its photos
    back; replacing a photo while another draft is approved sends that draft
    back to `created`, and its old bytes stay until released;
  - publish: a lost answer to a successful pointer write, followed by an upload
    failure or a takedown of one blob, still reconciles as published (step 0);
    a pointer naming the held snapshot while the snapshot record is missing,
    corrupt, or holds other content does not reconcile as published; an
    unreadable head refuses with nothing uploaded;
  - concurrency: a photo change while another draft of the catalogue is
    publishing is refused whole; an edit landing during `prepare` is not
    overwritten; a publish paused inside its uploads past the claim TTL keeps
    its claim: Discard, a photo change and a second publish are all refused
    while it is in flight, and when it resumes it completes normally; a claim
    left under an earlier boot id at `uploading` or `snapshot_sent` is named,
    Discard releases it (or records the publication if it landed), and the
    change then succeeds; at `pointer_sent`, with the pointer commit delayed
    across a Core restart, only Resume is offered for 10 minutes, Resume records
    the publication when the delayed write lands, and editing unlocks only
    after; Discard refuses if the claim changed between the offer and the
    action; a stalled upload ends at its deadline, the draft leaves the live
    set, and a photo change is then accepted;
  - ambiguous pointer write without a crash: the pointer request times out,
    reconciliation cannot read the head, and the PDS commits later — the claim
    stays at `pointer_sent`, edits stay blocked, Resume records the late
    publication, and Discard is refused until 10 minutes after the send; a
    failure before `pointer_sent` releases the claim at once;
  - late head: Discard at `pointer_sent`, then the old pointer lands; the next
    draft loses its swap once, adopts the head, and publishes after one rebuild
    with no manual adopt;
  - storage: replace every photo in a catalogue near the cap, publish, then add
    more photos — accepted;
  - ingress: a 3 MiB browser upload is accepted on the photo route; a 5 MiB one
    is refused;
  - cleaning: a 4032×3024 JPEG and a transparent PNG come out at ≤ 2048 px in the
    stated format on both hosts; the photo lane's output is unchanged;
  - cleaning: JPEG and PNG fixtures carrying GPS EXIF, XMP, a comment, an
    embedded secondary image and trailing bytes come out clean; a decompression
    bomb and an animated PNG are refused before decode;
  - reader: tampered bytes, wrong codec, oversize, wrong type, header dimensions
    unlike the declared ones, and a redirect to another host (which must receive
    no request) each show the placeholder;
  - takedown: a listed photo is neither fetched nor shown from cache, and is
    purged; a list older than 24 hours, or never fetched, shows placeholders;
    the CLI command writes both the list entry and the PDS takedown, a PDS
    failure leaves the entry `pending` (photo still hidden) and a rerun
    completes it; a listed CID is refused when added, prepared, or published
    (a CID listed between approval and publication is refused before any
    upload and before a pointer-only completion), while an already-landed
    publication still reconciles; with the AppView unreachable, an unattended
    connector `prepare` of a photo-carrying catalogue proceeds on a copy under
    24 hours and stops with `takedown_list_stale` past it, and a catalogue
    without photos is unaffected;
  - copy-in: loopback, private, link-local, metadata and the node's own
    interface addresses, a DNS answer that changes at connect time, a redirect
    to a blocked address, and a fourth redirect are each refused **with no HTTP
    request reaching the blocked destination**; an over-cap or slow response is
    aborted mid-stream; fetched bytes arrive unchanged; a connector refresh
    never fetches;
  - limits: adding past the byte-store cap and a snapshot over the record budget
    are refused with findings at the right step.
  - Live: publish a photo on the test bed and see it on the phone and in the
    browser.
