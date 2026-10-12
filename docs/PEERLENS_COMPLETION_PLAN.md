# PeerLens — closing the gaps between the design and the code

**Status:** PLAN, 2026-10-12. Nothing here is built. Revised the same day after
the owner's review: scores come from the viewer's circle first (W1), and
curation engines review what nobody has reviewed yet, and flag fakes (W11).
**Why now:** a code check for the CEO deck (`PeerLens Overview`) found features
the design docs describe that the code does not do. This plan closes them. Each
one appears in the deck with a red `*` ("in plan") until its acceptance check
(§4) passes; then the star comes off.
**Related:** `docs/trust-network-walkthrough.md`, `docs/appview-walkthrough.md`,
`docs/peerlens-network/threat-model.md`, `SECURITY.md` §trust rings,
`packages/protocol/src/peerlens/score_v1.ts` and its vectors.

---

## 1. Where the code is today

| # | Gap | Evidence |
|---|---|---|
| G1 | **A vouch counts whoever gives it.** The reviewer-weight gate asks only whether *any* inbound vouch exists, so a ring of new accounts that vouch for each other passes it. | `appview/src/scorer/jobs/refresh-profiles.ts:273-283` (count of vouches, no voucher trust) |
| G2 | **Verified identity (trust rings) is not built.** A type and an unused helper exist; there is no verification method and no use in scoring. | `packages/core/src/peerlens/levels.ts:12-16,96-98`; `SECURITY.md:511-524` ("Phase 3"); `tests/integration/test_trust_rings.py` skipped |
| G3 | **Account age and the fake-account detectors do not affect scores.** Weights for account age, volume, co-signature count and consistency are seeded and never read. The coordination and sybil jobs only write `anomaly_events`, which only the cleanup job reads. | `appview/src/db/seeds/peerlens-v1-params.ts`; `appview/src/scorer/jobs/detect-coordination.ts`, `detect-sybil.ts`, `cleanup-expired.ts` |
| G4 | **Nothing checks review signatures.** Jetstream delivers records without commit signatures; the ingester checks only the CID's format. The co-signature `sig` is stored and never verified, yet its presence multiplies weight by 1.4. A "verified" mark can come from any account. | `appview/src/ingester/jetstream-consumer.ts:896-931`; `appview/src/ingester/handlers/attestation.ts:44-45`; `appview/src/ingester/handlers/verification.ts:46-50`; unused `signAttestation`/`verifyAttestation` in `packages/core/src/peerlens/pds_publish.ts` |
| G5 | **Two intake checks are built and switched off:** the PDS-suspension gate and the namespace-signature gate. Nothing calls their setters at boot, so the suspend-a-host command does not block records. | `jetstream-consumer.ts:261-272,394-405,774-785,957-976`; `appview/src/ingester/main.ts` |
| G6 | **The app promises link-only and contacts-only reviews.** No field or flow exists; every review is a public record. | `apps/mobile/src/peerlens/explainer_content.ts:218` |
| G7 | **Dina's assistant does not personalise trust lookups.** `search_peerlens` is registered without the owner's DID. | `packages/brain/src/composition/agentic_ask.ts:459-464` |
| G8 | **Two record types are stored and never used:** `trustPolicy` (the viewer's own depth limit, blocked accounts, require-vouch) and `subjectClaim` (two subjects are the same thing). | `appview/src/ingester/handlers/subject-claim.ts`; `record-validator.ts:445-460` |
| G9 | **Smaller defects.** Person-score inputs drop revoked and imported reviews but not moderator takedowns; `authenticity` is always `null` in `resolve`; rate limits live in memory per instance; `FRIEND_BOOST` and `friendBoostFor()` are dead; `refresh-reviewer-namespace-stats` is never scheduled; several docs disagree with the code. | `refresh-profiles.ts:244-256`; `sentiment-aggregation.ts:213-214`; `rate-limiter.ts:44-47`; `friend-boost.ts`; `scheduler.ts` |
| G10 | **Scores ignore the viewer's circle.** Person and subject scores are computed once, the same for every viewer, from every review and vouch on the network. The viewer's circle only reorders results: contacts' reviews first, and advice lifted ×1.15 for one hop and ×1.05 for two. So the score a person sees leans on strangers as much as on people they know, and there is no way to follow a reviewer one trusts. | `appview/src/scorer/algorithms/peerlens-score.ts` (no viewer input); `recommendation.ts:85-88`; `resolve.ts:120-128` |
| G11 | **No curation engines.** Nothing reviews items nobody has reviewed yet, so a maker with no marketing budget starts invisible, and nothing checks reviews for fakes beyond the two detector jobs (G3). Curation Services designs specialist curators and probe operators; none of it is built. | `docs/CURATION_SERVICES_ARCHITECTURE.md` §1, §4.8 ("No probe-operator implementation exists"); no curation code |

## 2. The work

Each item says what changes, where, how it is tested, and which deck slide it
un-stars.

### W1 — Trust from your circle first, then from anchors (closes G1, G10)

Someone can make a million fake accounts, but they cannot make the viewer's
friends vouch for them. So trust is counted from two starting points, and a vouch
counts only as much as the voucher is trusted from one of them.

- **Layer 1, the viewer's circle (per viewer).** The circle is the accounts the
  viewer vouches for, endorses, delegates to or reviews well (the public graph),
  plus, on the phone, the private contact list and the reviewers the viewer
  follows. Reviews and vouches from one hop count at full weight; from two hops
  at a reduced weight (parameter, D4). Beyond two hops, the circle adds nothing.
- **Following a reviewer.** A viewer can follow a public reviewer they trust but
  don't know, such as MKBHD for technology. A followed reviewer is one hop, so
  their reviews count like a contact's for that viewer. A follow can name
  topics, so a tech reviewer counts in tech and not in restaurants. Fakes can't
  enter this way unless the viewer follows them, and the app shows the
  reviewer's AT Protocol handle, which is a web address, so a look-alike can't
  pass for the real one. Follows stay private on the phone, like contacts; there
  is no PeerLens follow record today, and a public one can come later if people
  want to share who they follow. Curation engines are followed the same way
  (W11; Curation Services §1).
- **Layer 2, anchors (global).** Replace "has at least one inbound vouch" with a
  **vouch weight**: trust propagated from anchor accounts along vouch edges, a
  few hops, decaying each hop. A voucher contributes its *propagated* trust,
  never its base score, because every new account starts at the same base and a
  plain sum would let a ring lift itself. Anchors are verified people (W2) and
  accounts with real transaction history. A reviewer's weight is the vouch weight
  run through a saturating curve (zero gives zero, as today).
- **Combining them.** When enough of the viewer's circle (K reviewers, parameter)
  has reviewed a subject, the circle layer sets the score that viewer sees;
  otherwise it leans on the anchor layer. The app always says which:
  one number, each person counting once: "4.4, from 4 of your contacts (4.5
  on average) and MKBHD, who you follow (4.0)," or "3.6. No one you know or
  follow has rated it yet; this is from verified reviewers." A new user with no circle sees the anchor layer. Contacts'
  ratings reach the viewer as sealed totals (W12).
- **Display: 5 points.** The app shows review scores out of 5, one decimal
  (4.4), as the deck does; today it shows a number out of 100 ("82",
  `apps/mobile/src/peerlens/subject_card.ts`). The rule that a number appears
  only from 3 reviews up, with a band below that, stays. Internal scores stay
  0 to 1. Tests: the card shows 4.4 for 0.88 with 3 or more reviews, and a band
  with fewer.
- **Fake rings.** A ring with no vouch from the viewer's circle and no path to an
  anchor counts for nothing in either layer.
- **Bootstrap.** Until W2 has verified enough people, the anchor set is the
  accounts with completed commerce orders (signed receipts already exist) plus a
  small operator-named seed list kept in the AppView config and published, so
  anyone can audit it.
- **Privacy.** The phone fetches its owner's two-hop circle once from the public
  graph and refreshes it daily. Each search then fetches the subject's reviewers
  **without** a viewer DID, and the phone computes the circle layer itself, so
  our index never learns who searched for what. Brain does the same (W7). Server
  nodes may send the DID instead (D3).
- **Where.** AppView: an anchor-propagation job in `appview/src/scorer/jobs/`,
  `refresh-profiles.ts` (gate and weights), `peerlens-score.ts`, and an xRPC that
  returns a DID's two-hop circle (built on `getCachedGraphContext`). Shared: the
  circle layer as a pure function in `packages/protocol/src/peerlens/score_v2.ts`
  (W10), so the phone, Brain and any other client compute the same number. Phone:
  `apps/mobile/src/peerlens/contact_rerank.ts` becomes the circle-score caller;
  a Follow button on reviewer profiles, with an optional topic, writes to a local
  follow list in Core that the circle function reads.
- **Tests.** A ring of 20 fresh accounts vouching for each other moves no score
  in either layer; one vouch from an anchor lifts a reviewer above zero;
  propagation stops at the hop limit; for one viewer, one review from a
  one-hop account outweighs ten from strangers; two viewers with different
  circles see different scores for the same subject; following a reviewer makes
  their review weigh like a contact's for that viewer only, a topic follow counts
  only in that topic, and unfollowing removes it; an empty circle falls back
  to the anchor layer with the right label; no per-search request carries the
  viewer DID.
- **Deck.** PeerLens slides 2 (summary), 9 (score), 11 (your circle), 13 (fake
  reviews).

### W2 — Verified identity: three trust rings (closes G2)

- **The rings.** *Ring 1, unverified:* any account. *Ring 2, verified:* proved
  to be one real person, without revealing who. *Ring 3, verified and active:*
  Ring 2 plus a record over time: completed transactions, outcomes, vouches
  from other Ring 2 or 3 people, and account age.
- **How Ring 2 is proved.** Decision D1 (§5). Whichever method, the result is the
  same shape: a **verification credential** naming the person's DID and a
  per-method **uniqueness token** (so one person cannot verify two accounts),
  signed by a verifier key that the AppView trusts and publishes. The
  credential reveals nothing else.
- **Where it lives.** The credential is a `com.dinakernel.peerlens.verification`
  record of a new kind (`identity`), or a new lexicon if the existing one cannot
  carry it cleanly; the AppView indexes it, checks the verifier's signature and
  the uniqueness token, and sets the account's ring.
- **Use.** Ring feeds W1 (anchors), the score (W10: ring 2 and 3 reviews weigh
  more), the advice (`resolve` returns the ring), and the app (a ring badge on
  reviewers).
- **Where.** `packages/core/src/peerlens/levels.ts` (wire `minRingForAction`),
  `appview/src/ingester/handlers/verification.ts`, a ring column on profiles,
  `resolve.ts`, mobile reviewer badge, the skipped `test_trust_rings.py`.
- **Tests.** A valid credential sets Ring 2; a second account with the same
  uniqueness token is refused; a credential from an unknown verifier is ignored;
  Ring 3 needs Ring 2 plus the activity threshold.
- **Deck.** PeerLens slide 13 (fake reviews: verified identity).

### W3 — Account age and fake-account signals in the score (closes G3)

- **Account age.** The AppView resolves each reviewer's DID once and reads the
  creation time of its PLC genesis operation (the existing DID resolver,
  `appview/src/shared/a2a/did-resolver.ts`, extended to read the audit log); it
  caches the date. A reviewer's weight ramps from a reduced value on day one to
  full weight over a set period (parameter, W10).
- **Detectors that act.** Coordination and sybil events from
  `detect-coordination.ts` and `detect-sybil.ts` attach a penalty to the
  accounts and reviews involved, decaying over time, and a moderator can clear a
  false positive. The penalty enters W10's formula; the events stay as the
  record of why.
- **Where.** The two detector jobs, `refresh-profiles.ts`,
  `refresh-subject-scores.ts`, `anomaly_events` (add `resolved` and `penalty`),
  the moderation CLI (clear an event).
- **Tests.** A burst of three same-sentiment reviews in 48 hours lowers those
  reviews' weight; clearing the event restores it; a one-day-old reviewer weighs
  less than a year-old one.
- **Deck.** PeerLens slides 9 (score), 13 (fake reviews).

### W4 — Signatures checked (closes G4)

- **Review records, at the AppView.** For every PeerLens record, fetch its proof
  from the author's PDS (`com.atproto.sync.getRecord`, which returns the signed
  commit and the path to the record), verify the commit signature against the
  `atproto` key in the author's DID document, and check the record's CID is in
  the commit. Records that fail are rejected with a reason
  (`ingest_rejections`); DID documents are cached. Volume is small, so one
  fetch per record is acceptable; moving to the full signed firehose
  (`subscribeRepos`) is a later option.
- **Review records, in the app.** The review detail screen fetches the same
  proof and verifies it on the phone, showing "signature checked". The protocol
  package gains the commit and MST verification code, with conformance vectors.
- **Co-signatures.** Define what a co-signer signs: the canonical JSON of the
  record without `coSignature`, signed by the co-signer's `dina_signing` key
  from their DID document (the existing `signAttestation` helper). The ingester
  verifies it, and only a valid one earns the ×1.4.
- **Verification records.** Count a `verification` only from a verifier at
  Ring 2 or above, or above a trust threshold; weight it by the verifier's trust.
- **Where.** `jetstream-consumer.ts` (a new gate after the schema check),
  `attestation.ts`, `verification.ts`, `packages/protocol` (repo-proof
  verification and vectors), the mobile subject and review screens.
- **Tests.** A record whose proof does not verify is rejected; a forged
  co-signature earns no bonus; a verification from a new account does not count;
  the app shows the checked state for a real record and a warning for a
  tampered one.
- **Deck.** PeerLens slides 5 (record), 8 (signatures), 9 (score); security
  deck slide 14.

### W5 — Switch on the two intake checks (closes G5)

- **Change.** In `appview/src/ingester/main.ts`, build the namespace-signature
  gate (it needs the PLC resolver) and the PDS-suspension gate, and call
  `setNamespaceGate` and `setPdsSuspensionGate`. Behind config flags that default
  on.
- **Tests.** A record from a suspended PDS host is rejected and logged; a
  pseudonymous record with a bad namespace proof is rejected; both pass when
  valid. An end-to-end run of the suspend command on the test AppView.
- **Deck.** PeerLens slide 8 (signatures).

### W6 — Link-only and contacts-only reviews (closes G6)

AT Protocol repositories are public, so a private review cannot be an ordinary
record. Two designs, decision D2:

- **Contacts-only, through Dina-to-Dina.** The review is sealed to each contact
  and sent over MsgBox, like any D2D message. Each contact's Dina keeps it in
  their vault and shows it in their app beside public reviews, ranked first.
  It never reaches the PDS or the AppView, so it doesn't count in public scores.
- **Link-only, sealed in the repository.** The review body is encrypted with a
  random key and published as a new record type
  (`com.dinakernel.peerlens.sealedAttestation`); the key travels only in the
  link's fragment, which never reaches a server. The AppView indexes that a
  sealed review exists, never its content.
- **Fallback, if D2 says not now:** change the explainer text to say every
  review is public, which takes minutes.
- **Where.** Mobile write form (an audience picker), a D2D message type for
  shared reviews, Core vault storage for received ones, the new lexicon in the
  AppView registry and the record validator (a new collection must be added in
  every place the ingester lists collections), the explainer text.
- **Tests.** A contacts-only review reaches a contact's app and never appears in
  the AppView; a link-only review opens with the link and shows nothing without
  it; the write form defaults to public.
- **Deck.** PeerLens slide 5 (record).

### W7 — Dina's assistant uses the person's network (closes G7)

- **Privacy first.** Passing the owner's DID to the AppView tells our index who
  looked up what. The phone already avoids this by re-ranking locally. So the
  assistant does the same: Brain fetches results without a viewer DID and
  applies W1's circle layer itself, using the owner's cached two-hop circle and
  contact list from Core (the shared function in `score_v2.ts`). Decision D3
  allows sending the DID instead, if the owner prefers.
- **Where.** `packages/brain/src/reasoning/peerlens_tool.ts`, `agentic_ask.ts`,
  the shared circle-score function (W1).
- **Tests.** The same question from two owners with different circles returns
  different scores and order; no request to the AppView carries a viewer DID
  (unless D3 says otherwise).
- **Deck.** PeerLens slides 10 (network), 11 (your circle).

### W8 — Trust policies and subject merging (closes G8)

- **Trust policy.** When the viewer's own `trustPolicy` exists, personalised
  reads apply it: graph depth limit, blocked accounts hidden, and
  require-a-vouch filtering. The phone reads its owner's policy locally.
- **Subject merging.** A `subjectClaim` saying two subjects are the same proposes
  a merge; the merge applies when claims from at least N independent accounts at
  Ring 2 or trust above a threshold agree, or when an operator runs the new
  `merge_subjects` command (the audit verb already exists). Merges are
  reversible and audited.
- **Where.** `search.ts`, `subject-get.ts`, `network-feed.ts`, `subject-claim.ts`,
  the moderation CLI, `admin-audit-log.ts`.
- **Tests.** A blocked account's reviews disappear for that viewer only; two
  independent trusted claims merge two subjects; a single claim does not.
- **Deck.** PeerLens slides 6 (record types), 10 (network).

### W9 — Smaller fixes (closes G9)

- Exclude moderator takedowns from person-score inputs
  (`refresh-profiles.ts:244-256`), as subject scores already do.
- `authenticity` in `resolve`: compute it from W4 (share of verified-signature,
  evidence-backed reviews) or remove the field.
- Rate limits shared across instances (a Postgres-backed counter), or document
  that the ingester runs as one instance.
- Remove `FRIEND_BOOST` and `friendBoostFor()`; W1's circle layer replaces them.
- Schedule `refresh-reviewer-namespace-stats` or delete it.
- Bring the docs in line with the code: `docs/appview-walkthrough.md` (job and
  endpoint counts, file names, the 0.206 base, "time constant" not "half-life"),
  `docs/TRUST_NETWORK_V1_PLAN.md` (flags, bands), `docs/APPVIEW_ARCHTECTURE.md`
  (server, no EigenTrust), the threat model's suspension claim (true after W5).
- **Deck.** PeerLens slide 7 (the deletion and moderation line: scores leave
  takedowns out once person scores do too).

### W10 — Score v2 (needed by W1, W2, W3, W4, W11)

- `trust_score_v1` is frozen by 14 conformance vectors, so W1–W4 and W11 change
  the formula as **v2**: a new reference
  `packages/protocol/src/peerlens/score_v2.ts` and new vectors, v1 kept for
  comparison, and a conformance changelog entry.
- New inputs: the circle layer and propagated vouch weight (W1), ring (W2),
  account-age ramp and anomaly penalty (W3), verified co-signatures and
  verifications only (W4), and curation-engine reviews and flags weighted by
  engine standing (W11).
- The score stays deterministic arithmetic: given the same records, anyone gets
  the same number. No model runs inside it.
- The AppView switches to v2 behind a config flag, recomputes every score, and
  `resolve` reports which version produced a score.
- **Tests.** v2 vectors, including the circle, ring, age, anomaly and engine
  cases; a dry run on test data comparing v1 and v2 rankings before switching.

### W11 — Curation engines (closes G11)

Curation engines are specialist reviewers, usually AI, that review what nobody
has reviewed yet. A first-time author, an independent filmmaker or a small app
maker with no marketing budget gets a careful review from day one. They follow
the curator model in `docs/CURATION_SERVICES_ARCHITECTURE.md`; W11 builds the
smallest useful part.

- **What they review.** Anything an engine can examine directly: books (it reads
  them), movies and shows (it watches them), apps and software (it installs and
  runs them), podcasts, online courses. Hardware is harder: without the physical
  item an engine can review only specs, manuals and claims, and its review says
  so. Examples: a book engine for new fiction, a movie engine for independent
  films, an app engine for new iPhone apps.
- **Unbiased, and accountable for it.** Each engine has its own DID and a
  published declaration: operator, method, domains, and any sponsorship or
  conflict, which the app shows on every review it covers. Every review is
  signed. An engine's standing in each domain rises or falls with outcomes:
  whether people who tried the item later agreed. An engine found with an
  undeclared sponsor, or one people keep disagreeing with, loses standing, and
  its reviews stop counting.
- **Marked as engines.** Engine reviews show as from an engine, sit apart from
  people's reviews, and never count in the 40% "what people say" part, as
  Curation Services requires (§2.2: human reviewers and automated curators are
  not treated as the same). An item with only engine reviews says so:
  "Reviewed by 2 curation engines; no people yet."
- **How they count for a viewer.** Through the circle (a viewer follows an
  engine the way they follow MKBHD, W1 layer 1), through anchors, and through
  standing.
- **Checking fakes, a second job.** An engine may also publish signed `flag` or
  `verification` records, with a reason code, when reviews look fake: copied or
  templated text, bursts, accounts that only ever praise one seller. These count
  only as far as the engine's standing; a flag a moderator overturns lowers it.
- **Bootstrap.** We run the first engines with published DIDs and methods (D5).
  They start at zero standing and earn it. Anyone may run one.
- **Where.** Engines run outside Dina and the AppView, as their own services
  with their own DID and PDS. AppView: an engine-declaration handler, an engine
  kind in `attestation.ts`, `flag.ts` and `verification.ts`, and an
  engine-standing job fed by outcomes. App: the engine label, Follow on engines,
  and the disclosure line.
- **Tests.** An engine review never enters the people part of the score; a
  followed engine counts for that viewer like a followed reviewer; an engine
  whose reviews people later disagree with loses standing; a declared sponsor
  shows on every review it covers; a flag from an engine with zero standing
  changes nothing; re-running the score on the same records gives the same
  number (a v2 vector).
- **Deck.** PeerLens slides 13 (fake reviews), 14 (curation engines).

### W12 — Sealed circle ratings: your contacts' total, and nobody knows who (closes G10's private half)

The viewer learns "4 of your contacts rated Blue Door Diner, average 4.5". Nobody
learns which contacts rated it or what any one of them gave, our index never
learns the place, who rated or who asked, and contacts never learn what the
viewer looked up.

- **Setup, once per contact.** When Sarah adds Jake as a contact, Sarah's Dina sends
  Jake, over Dina-to-Dina messaging, her **circle key** (a random secret shared
  by all her contacts) and her **tally key** (a public key; Sarah alone holds
  the private half).
- **Rating.** When Jake rates Blue Door Diner, Jake's Dina makes one pair for each
  of his contacts: a **tag**, a keyed hash of (the subject, that contact's
  circle key, this week), and the score **locked** under that contact's tally
  key with additive ElGamal on ristretto255, which lets locked numbers be added
  without opening them. It pads the batch with dummy pairs to a fixed size and
  posts it to an anonymous pool at the AppView, through MsgBox acting as an
  Oblivious HTTP relay (RFC 9458), with a one-use blind token (Privacy Pass
  style, on `ristretto255_oprf`) that proves a real Dina sent it without saying
  which.
- **Lookup.** Sarah's phone computes her tag for the subject this week and sends
  it through the relay. The pool adds every locked score carrying that tag and
  returns one locked total and the count. Sarah's phone opens the total.
- **The minimum is on ratings.** The pool returns nothing unless at least **3**
  ratings match (D6), so no single score stands alone and any contact could be a
  rater. This already needs at least 3 contacts; a minimum on contacts alone
  would hide who but expose the score whenever only one contact had rated.
- **What each party learns.** The pool: random-looking tags, locked numbers, how
  many matched a tag; never the subject, rater or viewer. The relay: that a Dina
  sent something. The viewer: the count and total; never which contacts or any
  one score. Contacts: nothing about the viewer's lookups.
- **Fakes.** Fake accounts can post to the pool, but their tags match nothing
  without the viewer's circle key, which only real contacts hold. Tokens cap how
  much any Dina posts. A total above 5 × count marks a contact who locked in an
  out-of-range score; a later version adds a proof that each score is 1 to 5.
- **Limits, stated in the app and the deck notes.**
  - One hop only. Two hops would tag every rating for every friend of a friend,
    tens of thousands of tags per rating; two hops stay on the public graph and
    anchors (W1).
  - When every rater gives the same score, the total reveals all of them; when
    the count steps from 3 to 4, the change reveals the new score. Daily batches
    and showing bands ("mostly good") make this harder, not impossible.
  - Removing a contact rotates the circle key and sends the new one to everyone
    else; the removed contact's later posts stop matching.
  - A contact running modified software could use the circle key to ask how many
    of the viewer's contacts rated something (the count, never the scores).
  - The pool sits outside AT Protocol: anonymous ratings cannot live in a public
    repository. Public reviews stay where they are.
  - Each rating carries a deletion code only its rater holds, for withdrawals.
  - About 80 bytes per contact per rating: roughly 24 KB for 300 contacts.
- **Relation to other items.** W12 is how contacts count in W1's circle layer;
  follows stay public (their reviews are public). W6's contacts-only reviews
  remain for named, full-text reviews; a friend who wants to be named turns that
  on.
- **Where.** `packages/protocol/src/peerlens/sealed_circle.ts` (tags, the
  lock, padding, totals) with conformance vectors; Core: circle and tally keys
  derived from the master seed on their own path, so a restore brings them back,
  plus a D2D message type for key handout and rotation; AppView: the pool
  (store pairs, add matches, enforce the minimum) and a blind-token issuer for
  signed-in Dinas; MsgBox: the Oblivious HTTP relay; app: the circle line on a
  subject page.
- **Tests.** Four contacts' ratings give the right count and average; two give
  nothing; a fake account's posts never match; the pool's stored rows contain no
  DID, subject or score in the clear; removing a contact rotates the key; a total
  above 5 × count is flagged; a withdrawn rating drops out; phone and server
  produce identical vectors.
- **Deck.** PeerLens slides 11 (your circle), 12 (sealed circle ratings).

## 3. Order

1. **W9 and W5** first: small, and they remove false statements fast.
2. **W4** (signatures): it is the base for trustworthy co-signatures and
   verifications, which W1–W3 rely on.
3. **W2** (rings), then **W1** (circle first, anchored on rings) and **W3**
   (age and detectors), all landing together in **W10** (score v2).
4. **W7** (assistant uses the circle) and **W8** (policies, merging): W7 after
   W1's shared function; W8 can run alongside.
5. **W11** (curation engines), after W4 (signed records) and W1 (standing).
6. **W12** (sealed circle ratings), after W1's circle function; independent of
   W2–W4.
7. **W6** (private reviews), after D2.

## 4. Acceptance: when a star comes off

A deck star comes off only when all three hold:

1. the item's tests above pass in CI;
2. a live check on the test AppView and a phone shows the behaviour (for
   example, a forged co-signature visibly earns no bonus);
3. a fresh code check confirms the deck's wording matches what shipped.

The day before the demo, one pass over both decks against the code removes the
stars that are done and leaves the rest for the presenter to mention.

## 5. Decisions for the owner

- **D1 — how Ring 2 is proved.** Options: (a) a zero-knowledge proof from an
  identity document (for example a passport chip or a national ID scheme), the
  design's intent, strongest and most work; (b) vouches from several existing
  Ring 2 people (web of trust), quick but circular at the start; (c) a
  device-attestation signal (Apple DeviceCheck, Google Play Integrity), which
  proves a real device, not a unique person. Recommended: (a) as the target,
  with (b) seeded by an operator-named group so rings work from day one.
- **D2 — private reviews.** Build contacts-only (D2D) and link-only (sealed
  record), or change the explainer text for now. Recommended: build
  contacts-only first; it reuses D2D and the vault.
- **D3 — where the circle is computed.** On the phone and in Brain, with no
  viewer DID sent per search (recommended), or at the AppView from a sent DID.
- **D4 — score v2 parameters:** two-hop weight, the circle threshold K,
  age-ramp period, anomaly penalty and decay, hop limit and decay for propagated
  trust, ring weights, engine-standing gains and losses. Recommended: set them by
  replaying test data and comparing rankings, then freeze them in the v2
  vectors.
- **D5 — curation engines, first scope.** Which engines we run first
  (recommended: books and apps, which an engine can examine fully), and whether
  checking fakes is in the first version (recommended: yes, it defends the
  score).
- **D6 — sealed circle ratings:** the minimum number of ratings in a total
  (recommended 3), whether a friend may choose to be named, how often tags
  change (recommended weekly), and whether totals show as numbers or bands.

## 6. What the deck says meanwhile

Every feature above appears in the `PeerLens Overview` deck with a red `*`,
footnoted "in plan". The security deck's slide 14 uses the same mark. §4's final
pass removes stars for what shipped.
