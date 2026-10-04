# A2A test plan

Status, 2026-10-04: every scenario below has a test, or is listed under "Owed" with the reason it cannot run here. After the scenarios were written, seven rounds of dual review (Codex and Claude) and six cold audits found 75 more defects (one, C6-8, left as an open question in the notes); each is fixed, has a test, and is listed under "Findings and fixes". The plan covers the A2A gateway as `docs/A2A_GATEWAY_ARCHITECTURE.md` (the design) and `docs/A2A_IMPLEMENTATION_PLAN.md` (the plan) describe it, with the interpretations `implementation-notes.html` records.

## How the plan was made

1. **One agent per area wrote its section** from the design, the plan and the notes. Each listed every normative rule, every "vectors" list item, the invariants in design §3 and the threat-model rows in §10 that touch the area. For each it cited the test that holds it, or wrote GAP. It then ran the area's suites and probed every gap with a throwaway test.
2. **A second agent tried to refute each finding.** Confirmed findings were fixed in the code, with a test and a mutation check: the fix broken on purpose must fail a test.
3. **A completeness critic** read all six sections against the whole design and plan. It listed 47 scenarios no section had; they are marked `X-n` below.
4. **One writer per area** then turned every GAP row, and the critic's scenarios, into permanent tests in new files (prefixes `contract_`, `lane1_`, `lane2_`, `m4_`, `lane3_publish_`, `lane3_directory_`). A test that showed the code breaking a rule was held out and reported as a finding, and the finding was fixed.
5. **A reviewer per area** checked that each new test fails when its rule breaks: a positive control, the exact error, every started step awaited, the real code in place of a fake. A second round fixed what the reviewers found and was reviewed again.

## How to read it

- Each area section keeps its table as first written: `| # | Scenario | Rule | Expected | Test |`. A row's Test column cites `path › test title`.
- **GAP** in a section means no test held the row when the section was written, and **probe** names a throwaway test since deleted. Every such row is closed in the area's **Gap closure** table after its section: the new test that holds it, an existing test found to hold it, or the reason it is owed.
- **VIOLATED** marks a row where the code broke the rule when the section was written. Each is listed under "Findings and fixes", and the code now holds it.

## Areas

| Area | Scope | Gap rows closed | Owed |
|---|---|---|---|
| A | The wire contract (`@dina/a2a`): JSON-RPC and REST, strict JSON, JCS, the card and its JWS, projection, envelopes, result sanitation, the delivery wire, DID-auth wire, the directory envelope | 45 of 46 | 1 |
| B | Lane 1, outbound: registration, credentials, bindings, proposals and provenance, consent, permits, dispatch, result ingest and the guard, the host transport | 46 of 48 | 2 |
| C | Lane 2, inbound: the gateway process, admission, resolution and access modes, normalization, execution and review, settlement, delivery, streams and webhooks, the extended card | 74 of 80 | 6 |
| D | M4: DID credentials and per-request signatures, inbound multi-turn, the REST binding | 37 of 39 | 2 |
| E | Lane 3, publishing: the publication state, the card publisher and its fence, the card key in the DID document, the owner console | 56 of 63 | 7 |
| F | Lane 3, the AppView directory: the spool, revision order, gap generations, verification, the account gate, serving, Brain's search | 51 of 54 | 3 |

## Findings and fixes

Every finding below was confirmed (by a probe, a refuting agent, or both), fixed, and given a test; each fix was broken on purpose to show a test fails. `implementation-notes.html` gives each decision in full.

| Id | Severity | What was wrong | The fix |
|---|---|---|---|
| Test-plan run, area A | medium | The card sampler had no bound: a large schema could throw and break the card. | A total sampler with bounds on length, items, depth, values and example bytes. |
| Test-plan run, area A (F1) | medium | Dina's own card could pass 128 KB (142,308 bytes seen). | Each skill's share is bounded (16 KB, measured in its largest form); a skill past it is left off (`skill_too_large`), and a call to it is refused. |
| Test-plan run, area A (F3) | low | Two version grammars: Core's ingress took non-canonical digits (`01.0`) that the gateway refused. | One rule, `speaksA2AVersion`, on every door. |
| Test-plan run, areas A and D | low | REST params named `__proto__` or other prototype keys were read. | Refused before any lookup. |
| Test-plan run, area A | low | An id-less object that is not a valid Request was taken as a notification. | Answered -32600 with a null id (JSON-RPC 2.0 §5). |
| Test-plan run, area A | low | A skill id longer than a card allows broke the whole card. | Left off the card with its reason (`skill_id_too_long`). |
| Test-plan run, area A | low | A schema example could use an `enum` or `const` value of the wrong type. | The sampler picks a value of the declared type. |
| Test-plan run, area C | high | An unroutable IPv6 webhook address crashed delivery. | Refused when the push config is set. |
| Test-plan run, area C | high | An effectful child cancelled after its effect began read CANCELED. | It ends OUTCOME_UNKNOWN (A2A-I8). |
| Test-plan run, area C | medium | A grant on a public listing skipped the client's scope. | Scope applies whatever the grant. |
| Test-plan run, area D (D8) | low | DID challenges were stored in clear. | Stored as a hash. |
| Test-plan run, area E (F1) | medium | The publisher's stand-down was not guarded on the state it was judged on. | A guarded update: a stale verdict lands nothing. |
| Test-plan run, area E (F2) | medium | A session error could read as a foreign fence. | An unreadable repository never stands the node down. |
| Test-plan run, area E (F3) | medium | A card over the lexicon cap was published. | Not publishable. |
| Test-plan run, area F | low | A recheck replaced a standing conflict's evidence. | The verdict is added to it, never put in its place. |
| Test-plan run, area F | low | AppView faults reached Brain as "closed"; a long query got a 400. | Faults surface; the tool holds the directory's own limits. |
| Test-plan run, area F (F-2) | low | A third conflicting event at a revision was not kept as evidence. | Every one is kept, up to 16. |
| Review, S1 | low | Directory names reached the model raw; `indexedAt` could be any string. | The shared display rule; an ISO timestamp check. |
| Review, S2 | low | A candidate's endpoint needed only `https:`. | The shared `checkOutboundUrl`. |
| Review, S3 | low | "Self" was the owner's DID, not the node's. | `GET /v1/a2a/self`. |
| Review, W1–W3 | low | A huge `const` made the sampler throw; the share bound measured too little; the card's name and description were unbounded. | An iterative count; the whole share measured; both bounded. |
| Gap workflow, C-F1 | high | Brain could complete an in-process inbound child with a result of its choosing. | Brain is refused every executor verb on any inbound child. |
| Gap workflow, C-F2 | medium | The gateway hung on close with streams open. | Streams end in a `preClose` hook. |
| Gap workflow, C-F3 | medium | Rotating a bearer left a thief's webhook and streams. | What a credential set up ends with it (reworked by CX-2). |
| Gap workflow, C-F4 | medium | Brain read an outside client's words on review cards. | Brain's reads are redacted. |
| Gap workflow, C-F5 / C-F6 / C-F7 | low | A row id in the ListTasks cursor; no `receiptId` on results; a tenant served on some methods. | A time-and-id cursor; `receiptId`; a tenant refused on every method. |
| Gap workflow, D-F1 | medium | A suspended DID client's events were still delivered. | They are held, and its streams closed. |
| Gap workflow, D-F2 | low | A task id of `.` or `..` turned a forward into another Core path. | Refused before any forward. |
| Gap workflow, F-X3 | medium | A newer card withheld because PLC had not yet named its key was never checked again. | `recheckWithheld`, on an identity event and daily. |
| Gap workflow, F-X4 / F-F64 / F-E-X1 | low | The tool sent queries AppView refuses; AppView's tests loaded TS source, not the build; the card-key check did not remember the confirmed key. | The tool holds the limits; tests use the compiled build; the check is keyed. |
| Gap workflow, B-X1 / B-X6 | medium | The envelope's skill was scrubbed into a placeholder; the owner's review showed no PeerLens evidence. | The bound skill goes out as written; evidence through the trusted host. |
| Dual review, CL-1 | low | A proven vault quote was not marked restricted if its persona was raised after the read. | "Private when read or now", as the read-set rule. |
| Dual review, CL-2 | low | The edge limit keyed on the raw address and refused every new client when full. | A client is an IPv4 address or an IPv6 /64; the oldest window goes. |
| Dual review, CL-3 | low | The binding revoke decoded the skill id twice. | Decoded once. |
| Dual review, CL-4 | low | With no node DID, approving a review or answering a question threw. | The call ends FAILED, once. |
| Dual review, CX-1 | high | An execution child named no listing, so the Tier 1 runners ran the default one. | Every round names its listing; a named one that cannot be read fails. |
| Dual review, CX-2 | high | A stream close was lost with its claim answer; later, a fence missed late streams and opening frames. | A credential generation: every stream event carries it, a per-client fence repeats for five minutes, and the gateway checks it before a stream's first byte. |
| Dual review, CX-3 | medium | `SendMessage` never waited (`returnImmediately` false is the default). | It waits up to 10 s, then errors naming the task (a recorded deviation). |
| Dual review, CX-4 | medium | Removing the gateway never took the published card down. | The publisher runs whenever there is a PDS. |
| Dual review, CX-5 / CX-6 | medium | The AppView drain had no bound; a reinstatement could erase an identity event's mark. | Bounded passes; the identity guard on every check. |
| Dual review, CX-7 | medium | A call waiting when its bearer was rotated got the result. | 401 when the credential generation moved. |
| Dual review, CX-8 | medium | AppView cleared a batch's "check again" mark before checking it. | A lease; only a card's own verdict clears it. |
| Dual review, CX-9 / CX-10 | medium | ListTasks ordered before views moved timestamps; `statusTimestampAfter` was exclusive. | Reconciled first, as of one time; inclusive. |
| Cold audit, CO-1 / CK-1 | high | A result Dina could not use after an effect began read FAILED, outbound and inbound. | OUTCOME_UNKNOWN; `read` and `quote` stay FAILED. |
| Cold audit, CK-2 | medium | An expired bearer's streams, webhooks and waits went on. | Expiry ends the credential, once. |
| Cold audit, CK-3 / CK-4 | medium | An unenforceable result schema was never audited; a required param was dropped after the check. | Both schemas audited; params checked again after stripping. |
| Cold audit, CO-2 | low | The Tier 1 adapter said it was unsigned and had an unsigned default. | The signed fetch is required. |
| Cold audit, CK-5 | high | A key that became `skill` only once cleaned could make a Dina remote run an unbound skill. | The envelope is checked again as it goes out. |
| Third cold audit, C3-1 | medium | The reference SDK signs another form of the card: its verifier refused every card Dina served, and Dina read genuine SDK-signed cards as invalid. | Dina verifies either form and signs its card over each that differs; SDK-made vectors and a live two-way test. |
| Third cold audit, C3-2 | medium | A DID-signed request named no audience, so it could be replayed to another node the same client uses. | The signed text names the node’s DID. |
| Third cold audit, C3-3 | medium | A capability configured under two names was off the card, yet a call by either name ran one of them. | One rule: ambiguous for the card and for every call. |
| Third cold audit, C3-4 | low | The golden vectors’ positive values were the code’s own output, unchecked. | Derived by other code (the SDK’s JCS, hashlib, cryptography) and checked by the generator. |
| Third cold audit, C3-5 | medium | One transient error to CancelTask disarmed the owner’s cancel, and later presses said a cancel was requested. | Only a final refusal ends it; a refused cancel answers 409 and shows. |
| Third cold audit, C3-6 | low | A resume after a lost lease polled 30 more minutes. | `sent_at` (v61); the poll ends a fixed time after the send. |
| Third cold audit, C3-7 | low | A credential could be created for a scheme or scope its binding would refuse. | Both read the schemes and scopes Dina offers. |
| Third cold audit, C3-8 | medium | A refused plugin child stayed running under the plugin’s lease. | It fails under the claim that was refused. |
| Third cold audit, C3-9 | medium | Core’s per-address limit skipped A2A routes for any caller, and a self-made did:key each grew the per-DID map. | The exemption needs the gateway’s DID; an unknown DID spends no bucket. |
| Third cold audit, C3-10 | low | The notes said the hub keeps events two minutes; it keeps 30 seconds. | Corrected. |
| Third cold audit, C3-11 | medium | A DID a moderator tombstoned kept its old score and could rank first. | Ordered, paged and reported at 0, as resolve gives it. |
| Third cold audit, C3-12 | medium | The owner console had no way to see or work Lane 3. | An Agent directory panel. |
| Third cold audit, C3-13 | low | The publisher read whatever repository the PDS session held, and could stand down falsely. | Every read names the node’s repository. |
| Third cold audit, C3-14 / C3-15 / C3-16 | medium | The pump’s fences, three action classes and a same-kid key change had no test that could fail. | Tests that fail when each rule breaks. |
| Fourth cold audit, C4-1 | low | The digest vector was no valid card record, and the fence had no non-canonical-bytes vector. | A whole record, checked against the lexicon; the fence case added. |
| Fourth cold audit, C4-2 | medium | A token-endpoint blip while polling ended a sent call outcome_unknown. | `token_unavailable` is tried again until the deadline; each good read re-arms the refresh. |
| Fourth cold audit, C4-3 | low | Remote skill ids and the endpoint reached the owner and Brain uncleaned. | Ids not shown as written are not offered; the endpoint is stored parsed. |
| Fourth cold audit, C4-4 | medium | After an in-process effect began, an authority change made the call read FAILED. | A consumed round is authorized again unjudged; a post-effect refusal is OUTCOME_UNKNOWN. |
| Fourth cold audit, C4-5 | low | A DID-bound caller’s review card said it held a token. | The card names the DID whose key signed. |
| Fourth cold audit, C4-6 | low | With a PDS but no gateway, activation said the node had no PDS. | The port is installed; activation answers `not_configured`. |
| Fourth cold audit, C4-7 | low | After an identity event the card stayed served while PLC did not answer. | Withheld until a verdict lands (`identity_check_pending`, migration 0026). |
| Fourth cold audit, C4-8 / C4-9 / C4-10 | medium | The bound-skill rule, the published record’s acceptance and revocation after the send had no test that could fail. | A second bound skill; the record rules shared in @dina/a2a and held by the publisher’s tests; revocation tests. |
| Fifth cold audit, C5-1 | low | The SDK vector called Dina’s card shape was hand-written and had drifted from the card Dina builds. | Built by `projectAgentCard` from Core’s inputs; a test fails if the two part. |
| Fifth cold audit, C5-2 | medium | A persona lowered after a private read, then read again, lost its taint. | A re-read keeps the stricter tier. |
| Fifth cold audit, C5-3 | low | Comments and the design said every credential polls again after a 401. | One OAuth refresh per read that went through; a static key refused while polling is `outcome_unknown`. |
| Fifth cold audit, C5-4 | medium | The review card’s own list of hidden characters missed tag characters and other astral ones. | The shared invisible set decides; astral points as surrogate pairs. |
| Fifth cold audit, C5-5 | low | An approved review card stayed queued and lapsed a day later as “expired”. | It completes, or fails with the reason, in the commit that acts on it. |
| Fifth cold audit, C5-6 | medium | A review card stayed open after its call lost its authority. | The sweep ends the call FAILED and cancels the card in one commit. |
| Fifth cold audit, C5-7 | medium | A step reading between the activation’s fence write and its local record stood the node down. | Activation and deactivation take the step’s slot. |
| Fifth cold audit, C5-8 / C5-9 / C5-10 | medium | Unsigned cards in the directory, four card exclusion rules and round 0’s permit check had no test that could fail. | Tests that fail when each rule breaks, each with a control. |
| Sixth cold audit, found fixing C6-7 | high | Every inbound call that ran posted its result in the owner’s chat: Brain’s event consumer read the execution child as the owner’s delegation. | Migration v62: an inbound execution child’s events never reach Brain’s delivery feed. |
| Sixth cold audit, C6-1 | low | A parse error or invalid request answered with a null id read as malformed, so outcome_unknown. | Those two errors are read with a null id (JSON-RPC 2.0 §5): remote_rejected. |
| Sixth cold audit, C6-2 | low | A skill whose id was too long for a card was off the card but callable. | One predicate, `skillIdFits`, for card and call. |
| Sixth cold audit, C6-3 | low | Some default-ignorable code points passed sanitation. | Added; a test checks every one the runtime knows. |
| Sixth cold audit, C6-4 | low | The SDK vector’s fixture copied Core’s card inputs by hand. | `dinaCardFrame` in @dina/a2a, used by both. |
| Sixth cold audit, C6-5 | medium | A guard scan longer than its lease never ended, and held back every later result. | The scan is bounded by its claim; untried jobs go first; a 3-minute lease. |
| Sixth cold audit, C6-6 | medium | A held task’s lapsed claims stayed due and could stop stream delivery for every client. | The hold gives them back and holds them with the rest. |
| Sixth cold audit, C6-7 | low | Brain could read an inbound execution child’s params and result. | The single read, /running and Brain’s list refuse it. |
| Sixth cold audit, C6-9 | medium | A card drained after a backlog, or reinstated, was served as fresh. | `indexed_at` is the event’s receipt time, on AppView’s clock. |
| Sixth cold audit, C6-10 | low | A failed publish’s wait delayed the unpublish of a withdrawn card up to 30 minutes. | The wait holds back only the operation that failed (migration v63). |
| Sixth cold audit, C6-11 / C6-12 / C6-13 | medium | A credential end’s scope, Brain’s event feed after an approval, and the ack’s claimant binding had no test that could fail. | Tests with a bystander client, the feed read as Brain, and the foreign ack sent while the claim is live. |

Judged not real by the refuting agent (the stated rule holds): B-F1 (the 24 h turn log), B-F2 (a lapsed consent card), D-F1 of the first run (an answer after authority ends), E-F2 (a session signed into another account).

## Tests the dual review added

Each fix from the review rounds came with tests that fail when the fix is undone (checked by mutation).

| File | What it holds |
|---|---|
| `packages/core/__tests__/a2a/execution_listing.test.ts` | Every round of an inbound call names its listing; with no node DID no round runs, and a review or an answer then ends the call FAILED. |
| `packages/core/__tests__/a2a/send_wait.test.ts` | `SendMessage` waits for an end or a question, both bindings, a continuation, a replay; past 10 s an error names the task; a rotated, rebound, expired or revoked credential ends the wait 401. |
| `packages/core/__tests__/a2a/credential_end.test.ts` | A credential that ends (rotation, expiry, DID bind, revocation) raises the generation; the client's fence repeats for five minutes; a lost claim answer loses nothing. |
| `packages/core/__tests__/a2a/list_tasks_order.test.ts` | ListTasks reconciles first, as of one time, so order, total, pages and cursor agree; `statusTimestampAfter` is inclusive. |
| `packages/core/__tests__/a2a/inbound_result_contract.test.ts` | A result Core cannot use after an effect began is OUTCOME_UNKNOWN; unenforceable result schemas; params checked after stripping. |
| `packages/core/__tests__/a2a/binding_revoke_route.test.ts` | The binding revoke takes skill ids holding `%`, `%41` and `/`. |
| `packages/core/__tests__/a2a/delegation_envelope.test.ts` | A key that becomes `skill` only once cleaned is refused. |
| `packages/core/__tests__/a2a/lane1_dispatch.test.ts`, `outbound_lane.test.ts` | A refused outbound answer by action class. |
| `apps/home-node-lite/a2a-gateway/__tests__/server.test.ts`, `delivery.test.ts` | Fences before a stream's first byte, on registration and in replay; per-client fences per claim. |
| `apps/home-node-lite/a2a-gateway/__tests__/core_link_wait.test.ts` | The `SendMessage` forward outlasts Core's wait. |
| `apps/home-node-lite/a2a-gateway/__tests__/boot_parts.test.ts` | The edge limit by client (IPv4, IPv6 /64, mapped addresses), eviction, stream slots per client. |
| `apps/home-node-lite/core-server/__tests__/http_tier1_runner.test.ts` | The Tier 1 adapter runs the named listing and refuses an unreadable one. |
| `apps/home-node-lite/core-server/__tests__/lane3_publish_boot.test.ts` | A card published under a gateway is taken down after a restart without one; the fence stays. |
| `appview/tests/integration/lane3_directory_ingest.test.ts` | Bounded drain passes; identity events during a check; the revalidation lease. |
| `packages/a2a/__tests__/card_sdk_form.test.ts` | The SDK’s card form byte for byte, from vectors the SDK made; SDK-signed cards verify; Dina’s second signature covers the SDK’s own payload. |
| `apps/home-node-lite/core-server/__tests__/a2a/sdk_card_signatures.e2e.test.ts` | Live, with the a2a-sdk: the card Core serves verifies in the SDK’s verifier; cards the SDK signs verify in Core’s. |
| `packages/core/__tests__/a2a/did_auth.test.ts` (cold audit) | A request signed for another node is refused; the plain signature naming no audience is refused. |
| `packages/core/__tests__/a2a/inbound_resolve.test.ts` (cold audit) | A capability under two names is ambiguous by every name and path. |
| `packages/home-node/__tests__/a2a_runner.test.ts` (cold audit) | Which cancel errors are final; a resume polls only until the send’s deadline. |
| `packages/core/__tests__/a2a/outbound_lifecycle.test.ts` (cold audit) | Send errors and refused results across all five action classes. |
| `apps/home-node-lite/core-server/__tests__/owner_console.test.ts` (cold audit) | The cancel row and the Agent directory panel, drawn from the page Core serves. |
| `appview/tests/integration/a2a_directory.test.ts` (cold audit) | A tombstoned DID orders, pages and reports at 0, through merges as resolve reads them; an identity event withholds the card until a check lands. |
| `packages/a2a/__tests__/card_record.test.ts` | The card record's rules the publisher and the directory share. |
| `packages/core/__tests__/a2a/multi_turn.test.ts` (fourth audit) | An authority change after an in-process effect began never reads FAILED. |
| `packages/core/__tests__/a2a/delegation_envelope.test.ts` (fourth audit) | With two skills bound, an envelope naming the other is refused. |
| `packages/home-node/__tests__/a2a_runner.test.ts` (fourth audit) | Token-endpoint outages while polling; revocation after the send, while polling and before a resume. |
| `packages/a2a/__tests__/fixtures/dina_card.ts`, `card_sdk_form.test.ts` (fifth audit) | The SDK vector is the card Dina projects; a test fails if they part. |
| `packages/core/__tests__/a2a/provenance.test.ts` (fifth audit) | A persona lowered after a private read and read again keeps the conversation tainted, items and topics alike. |
| `packages/core/__tests__/a2a/inbound_review_card.test.ts` (fifth audit) | Tag characters, variation selectors and fillers spelled out, astral ones as surrogate pairs, in the card and the phone mirror. |
| `packages/core/__tests__/a2a/execution_listing.test.ts` (fifth audit) | An approved review card completes or fails at once and its deadline leaves it alone. |
| `packages/core/__tests__/a2a/lane2_authority_edges.test.ts` (fifth audit) | A review card whose grant was revoked is withdrawn by the sweep, once. |
| `apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts` (fifth audit) | A step asked for between the fence write and its record waits; the node is not stood down. |
| `appview/tests/unit/a2a_card_verify.test.ts`, `appview/tests/integration/a2a_directory.test.ts` (fifth audit) | A card with no signatures, empty or gone, is refused and never served; the same card signed is. |
| `packages/core/__tests__/a2a/inbound_card.test.ts` (fifth audit) | Each excluded capability has its schema pair and falls to its own rule, with a control per rule. |
| `packages/core/__tests__/a2a/multi_turn.test.ts` (fifth audit) | Round 0 claimed as the runner claims it: a permit naming another payload is refused unspent; the minted one is consumed. |
| `packages/core/__tests__/a2a/lane2_authority_edges.test.ts` (sixth audit) | An inbound child hands Brain’s delivery feed nothing, whatever its end; Brain reads no inbound execution child, pinned or in-process, one or listed. |
| `packages/core/__tests__/a2a/store.test.ts` (sixth audit) | v62 stops the delivery of events already queued for an inbound child, and only those. |
| `packages/brain/__tests__/a2a/a2a_brain.test.ts`, `packages/core/__tests__/a2a/outbound_lane.test.ts` (sixth audit) | A guard scan ends inside its claim or posts nothing; a lapsed job goes behind every untried one. |
| `packages/core/__tests__/a2a/delivery_suspended.test.ts` (sixth audit) | A crashed gateway’s full batch of a held task’s claims never keeps another client’s events out; a live claim stays. |
| `packages/a2a/__tests__/codec_and_envelope.test.ts`, `packages/home-node/__tests__/a2a_runner.test.ts` (sixth audit) | A null-id parse error or invalid request is read as refused unread; any other null-id answer stays malformed. |
| `packages/core/__tests__/a2a/inbound.test.ts` (sixth audit) | An id too long for a card is off the card and refused by bare name and reference; one at the limit fits. |
| `packages/a2a/__tests__/hardening.test.ts` (sixth audit) | Every default-ignorable code point is invisible. |
| `appview/tests/integration/a2a_directory.test.ts` (sixth audit) | A card drained a month late, or reinstated after a month withheld, is stale. |
| `apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts` (sixth audit) | A card withdrawn while a failed publish waits is deleted at the next step; a failed unpublish waits its own time. |
| `packages/core/__tests__/a2a/credential_end.test.ts`, `inbound_review_redaction.test.ts`, `gateway_routes.test.ts` (sixth audit) | A credential end spares a bystander client; Brain’s event feed after an approval is redacted; the ack is bound to its claimant. |

## Owed: what cannot run here

These need what this machine lacks. Each is a release gate, not a skip.

- **The official A2A conformance kit (TCK)** against a running gateway (needs the TCK and its Python deps).
- **The Playwright suites** for the owner console and the phone's web build.
- **A reference PDS feeding Jetstream** into AppView, end to end (needs Docker): publish, ingest, search, getCard, and the 14-day envelope bump as a real commit.
- **A run on the phone** (iOS device) for the parts the phone carries: the paired approvals of Lane 1 consent cards.

**Needs Docker (a reference PDS, Jetstream, the images, a clean `npm ci`)**

- A X-3 (image builds and npm ci on a clean tree): Building the lite core, brain and gateway images and AppView's three stages, and running npm ci on a clean checkout, need Docker and network access.
- E E106: Needs Docker: a reference PDS, Jetstream and AppView to show the cadence bump is a real commit that advances indexed_at.
- E E165: Needs Docker: publish, ingest, search, getCard end to end takes a reference PDS, Jetstream and the AppView with Postgres.
- F F140 (reference-PDS to Jetstream run): Needs Docker (a reference PDS and Jetstream); the notes already list it as owed.
- F F172: Needs Docker: publish through a reference PDS, ingest from Jetstream, then search and getCard.

**Needs a phone or its native SQLite adapter**

- B X-8 (phone start()): Needs the phone: the code is apps/mobile/src/services/bootstrap.ts (start(), PublisherConfigError branch), outside the packages this task may add tests to; no test exists for it there either.
- C X-25: Needs a phone run (or the mobile app's tests); apps/mobile is outside the allowed test directories.
- C X-26: Needs the phone's native op-sqlite adapter; it does not run under node jest here.
- E E8: Needs a phone: v59 and its triggers on the op-sqlite adapter cannot run under jest.

**Needs a third-party harness (the A2A TCK, Playwright, the Python agent with an LLM runner, a live PDS or PLC)**

- C X-10: Needs a Playwright run of the web app against a booted Core and Brain, or a device run; neither runs in these jest test directories.
- C X-22: Needs the official A2A TCK, a separate Python project fetched from the network.
- D X-2: Needs a cross-language harness: a live TS Core and gateway over signed HTTP, with the Python daemon paired as a device.
- E E153: No rule in the design, plan or notes covers a nullified last audit entry, and the PLC directory lists the live fork operation last; the real shape needs a live PLC directory with a nullified fork.

**Not yet written: a cross-lane end to end, each half held by its own tests**

- F F166: The §6.1 registration ceremony runs in Core (Lane 1's area); this lane may add files only under appview and packages/brain test folders.

**No rule to hold yet (an open question in the notes, or a documented non-rule)**

- B B229: No rule to hold: the plan judged 6to4, Teredo and 198.18/15 answers outside the design's private/link-local/loopback terms (documented, no finding).
- C C8: A documentation rule about native installs (the README warns not to open the port).
- C C215: An open question for the owner (third-party webhook hosts; no owner view of webhooks).
- D D72: The optional server-nonce route (POST /v1/a2a/ingress/did/nonce, design §4.3 and §5.1) is not built and the design marks it optional, so there is no behaviour to test.
- E E7: Recorded open question (notes 'M5: a raw copy of the database'): no rule yet says what boot should do with a copied database, so there is nothing to hold.
- E E31: Recorded open question (notes 'M5: "gateway live"'): the build reads it as 'a public origin is configured'; whether the gateway process must be up has no rule yet.
- E E95: Recorded open question (notes 'M5: a write that lands after its sender gave up'): accept the window or move the head first is undecided, so no rule to hold.

## How to run

| Package | Command |
|---|---|
| `@dina/a2a` | `cd packages/a2a && npx jest` |
| Core | `cd packages/core && npx jest __tests__/a2a` |
| Brain | `cd packages/brain && npx jest __tests__/a2a __tests__/appview_client` |
| home-node, net-node | `cd packages/<name> && npx jest` |
| Gateway | `cd apps/home-node-lite/a2a-gateway && npx jest` |
| core-server, brain-server | `cd apps/home-node-lite/<name> && npx jest` (core-server's `npm run typecheck` also checks the two-node harness) |
| AppView unit | `cd appview && npm run test:unit` |
| AppView integration | `cd appview && DATABASE_URL=postgresql://dina:dina@localhost:5432/<db> npm run test:integration` (its own database; it migrates and cleans tables) |
| CLI | `cd cli && PYTHONPATH=src <venv>/bin/python -m pytest -q` (a venv with `cli/pyproject.toml`'s pins; the system `python3` may import another checkout) |

---

## Area A — the wire contract (`@dina/a2a`): test plan

Path legend: `[a2a]/` = `packages/a2a/__tests__/`, `[core]/` = `packages/core/__tests__/a2a/`. A title in quotes after `›` is the exact Jest title, `it.each` cases expanded. "GAP → probe held" means no existing test held the rule and a probe showed the code meets it; "violated" means the probe showed the code breaks it (see findings). The spec text and `a2a.proto` were checked against A2A v1.0.1 (`specification/a2a.proto`, `docs/specification.md` §5.4, §8.4, §11). `docs/dina_details.md` does not exist in the repo.

### A.1 Pinned facts, constants, service parameters (design §2, plan §2)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A1 | Card served at `/.well-known/agent-card.json` | plan §2 row 2 | constant is that path | GAP → probe held |
| A2 | Extension URI carries the version (`…/ext/v1`); no `version` field | plan §2 row 8, §7.6 | URI ends `/v1` | [a2a]/card_projection.test.ts › call contract on the card (design §7.6) › carries the contract in the Dina extension, required:false (+probe held) |
| A3 | Extension sits in `capabilities.extensions[]`, `required:false` | plan §2 row 7, §7.6 | one entry, no `required:true` | same test |
| A4 | `supportedInterfaces[]` with `protocolVersion` per interface; JSON-RPC first, then REST | plan §2 row 3, spec §5.3 | order and fields | [a2a]/card_projection.test.ts › the interfaces, in preference order › lists REST after JSON-RPC when the node serves it; › call contract on the card (design §7.6) › declares only the features built today |
| A5 | `A2A-Version: 1.0` (with spaces) accepted | plan §2 row 12 | ok | [a2a]/codec_and_envelope.test.ts › A2A service parameters › A2A-Version "1.0" accepted: true; › A2A-Version " 1.0 " accepted: true |
| A6 | Patch ignored: `1.0.1` reads as 1.0 | design §2 item 9, spec §3.6 | ok | › A2A-Version "1.0.1" accepted: true |
| A7 | Non-canonical digits (`01.0`, `1.00`, `1.0.01`) refused on every door | notes M0 "Version" | refused | `checkRequestedVersion` only: › A2A-Version "01.0" accepted: false, "1.00", "1.0.01"; Core ingress uses `speaksA2AVersion` → GAP → probe **violated** (F3) |
| A8 | Empty/absent version means 0.3 and is refused | spec §3.6.2 | VersionNotSupported | › reads an empty version as 0.3 (spec §3.6.2); [core]/rest_ingress.test.ts › errors… › no version is 400 VERSION_NOT_SUPPORTED; the query parameter is enough |
| A9 | Request parameter read when header absent; header preferred | spec §3.6.1 | | › reads the request parameter when the header is absent, and prefers the header |
| A10 | Other versions (`0.3`, `2.0`, `v1.0`) refused | spec §3.6.2 | | › A2A-Version "0.3" accepted: false; "2.0"; "v1.0" |
| A11 | `A2A-Extensions`: comma list, trimmed, de-duplicated | design §2 items 7, 9 | | › parses A2A-Extensions as a de-duplicated list |
| A12 | -32008 / -32009 codes pinned (Dina declares no required extension) | plan §2 row 12 | | [a2a]/codec_and_envelope.test.ts › JSON-RPC 2.0 request envelope › pins every A2A error code to spec §5.4 |
| A13 | Limits (card 128 KB, payload 256 KB, 16 parts, 65,536 code points, depth 32) hold for every producer | §6.6, §7.2 step 3, §8.3 | Dina's own card ≤ 128 KB | consumers: [a2a]/state_envelope_result.test.ts › result sanitation (design §6.5) › refuses too many parts / refuses an oversized result; producer side GAP → probe **violated** (F1: card 142,308 B) |

### A.2 JSON-RPC 2.0 envelope and error codes (spec §9, design §5.1)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A14 | Well-formed request accepted | spec §9.3 | ok | [a2a]/codec_and_envelope.test.ts › JSON-RPC 2.0 request envelope › accepts a well-formed A2A request |
| A15 | Missing params → `{}` | | ok | › accepts a request with no params (GetExtendedAgentCard) |
| A16 | Bad JSON → -32700, id null | JSON-RPC §5.1 | | › refuses bad JSON |
| A17 | Array (batch) → -32600 | notes | | › refuses an array |
| A18 | Two `method` members refused, never last-wins | design §5.1 | -32600 | › refuses two method members (read last-wins by JSON.parse); [core]/a2a_m0.test.ts › dispatch binding (design §5.1) › refuses a body with two method members rather than reading the last |
| A19 | `__proto__` member → -32600 | design §5.1 | | › refuses a __proto__ member |
| A20 | Lone surrogate → -32600 | design §5.1 | | › refuses a lone surrogate |
| A21 | null id, fractional id refused | notes "no null id" | | › refuses a null id; › refuses a fractional id |
| A22 | Empty-string id, >256-char id, unsafe integer, boolean/object id refused with id null; negative int and 256-char id accepted | notes | | GAP → probe held |
| A23 | `jsonrpc` other than "2.0" refused | JSON-RPC §4 | | › refuses jsonrpc 1.0 |
| A24 | Unknown top-level member refused | notes (open question) | | › refuses an unknown member |
| A25 | Unknown method (incl. v0.3 `tasks/get`) → -32601 | design §2 item 2 | | › refuses an unknown method |
| A26 | Non-object params → -32602 | notes | | › refuses array params |
| A27 | Valid notification (no id) neither run nor answered | JSON-RPC §4.1 | 204 | › neither executes nor answers a notification (no id member; JSON-RPC 2.0 §4.1) |
| A28 | Invalid Request object with no id (`method:1`, `{}`, `jsonrpc:"1.0"`, scalar params) answered -32600, id null | JSON-RPC 2.0 §5, §7 example | error reply | the test above pins the opposite ("A malformed notification is still a notification") → GAP → probe **violated** (F4) |
| A29 | Readable id echoed on refusal | | | › echoes the id it could read on a refusal |
| A30 | Results/errors built with A2A codes; ErrorInfo detail (reason, domain `dinakernel.com`) | errors.ts, A2A-I4 | | › builds results and errors with the A2A codes |
| A31 | All 14 codes pinned | spec §5.4 | | › pins every A2A error code to spec §5.4 |
| A32 | Response: result for expected id; error read | | | › JSON-RPC response parsing › reads a result for the expected id; › reads an error |
| A33 | Response refusals | | malformed | › refuses another id; › refuses both result and error; › refuses neither; › refuses a bad error object; › refuses no jsonrpc |
| A34 | Response text parsed strictly (two `result` members; id `"1"` vs 1) | I-JSON | malformed | GAP → probe held |
| A35 | Method list = the eleven v1.0 operations | design §2 item 2 | | [a2a]/ingress_routes.test.ts › ingressPathFor › serves every A2A v1.0 method, each at its own route (M3) |

### A.3 Strict I-JSON parsing (RFC 7493)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A36 | RFC 8259 texts read as JSON.parse reads them | | | [a2a]/hardening.test.ts › parseStrictJson (RFC 7493) › accepts an object / whitespace around values / escapes, including a surrogate pair / a large finite number exactly as JSON.parse reads it |
| A37 | Grammar violations refused | RFC 8259 | syntax | › refuses empty text; a trailing comma; a leading zero; a leading plus; a bare control character; a bad escape; trailing content; a single quote |
| A38 | Duplicate member refused, incl. escaped spelling | RFC 7493 §2.3 | | › refuses a duplicate member; › refuses a duplicate written two ways |
| A39 | `__proto__` refused, incl. escaped | notes | | › refuses a __proto__ member; › refuses an escaped __proto__ member |
| A40 | Escaped lone surrogates in values and keys | RFC 7493 §2.1 | | › refuses a lone high surrogate; › refuses a lone low surrogate in a key |
| A41 | Raw (unescaped) lone surrogate in a string | RFC 7493 §2.1 | lone_surrogate | GAP → probe held |
| A42 | Number past double range | RFC 7493 §2.2 | | › refuses a number past double range |
| A43 | Depth cap equals canonicalize's | notes | | › caps depth at the same place canonicalize does |
| A44 | 200,000-deep text → too_deep, no stack overflow; BOM, NBSP refused; `constructor`/`toString` members kept as data | | | GAP → probe held |
| A45 | `untrustedJsonProblem` agrees with the parser | | | › untrustedJsonProblem agrees with the parser on depth and __proto__ |

### A.4 RFC 8785 canonical JSON
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A46 | §3.2.4 example | RFC 8785 | byte-equal | [a2a]/jcs.test.ts › RFC 8785 canonicalization › matches the RFC 8785 §3.2.4 example (literals, numbers, string escapes) |
| A47 | Keys sorted by UTF-16 code unit | §3.2.3 | | › sorts members by UTF-16 code units (RFC 8785 §3.2.3 example) |
| A48 | Nested sort, array order kept | | | › sorts nested objects and keeps array order |
| A49 | ECMAScript number form; Appendix-B samples (5e-324, 1e+23, 9.999999999999997e+22…) | §3.2.2.3 | | › writes -0 as 0 and integers without exponent noise; Appendix-B probe held |
| A50 | Non-I-JSON refused | notes | throw | › refuses NaN; Infinity; undefined; a function; a bigint; a Date; a lone high surrogate; a lone low surrogate; an undefined array element; an undefined member; a lone surrogate key |
| A51 | Depth cap | | | › refuses nesting deeper than the cap |
| A52 | Astral and U+2028 written raw | | | › keeps well-formed astral characters; [a2a]/directory_envelope.test.ts › golden vectors: frozen refusals and canonical forms (another runtime replays these) › jcs: non-ASCII, astral and U+2028 are written raw, not escaped |
| A53 | Plain objects judged by shape across realms | | | [a2a]/jcs.test.ts › a plain object is judged by shape, not by realm › accepts a plain object from another realm, and a null-prototype object; › refuses class instances…; › refuses an object built on a bare prototype…; › refuses arrays from another realm as objects |
| A54 | Cross-runtime JCS vectors | §8.2 M0 | | [a2a]/directory_envelope.test.ts › … › jcs: keys sort by UTF-16 code unit, so U+1F600 precedes U+FF5E; jcs: numbers in ECMAScript form; jcs: control characters escaped as JSON.stringify does; solidus left alone; jcs: nested members sorted at every level |

### A.5 v1.0 type validators
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A55 | Part oneof text/raw/url/data | design §2 item 5 | | [a2a]/validate.test.ts › Part (oneof text \| raw \| url \| data) › accepts %p (5); › refuses %p (5) |
| A56 | Message: bounded ids, role USER/AGENT, parts ≥1 | proto REQUIRED, §5.7 | | › Message › accepts a minimal message; › refuses %p (7) |
| A57 | Unknown members ignored | spec §5.7 | | › Message › ignores unknown members (spec §5.7) |
| A58 | Task shape | | | › Task › accepts a completed task with artifacts and history; › refuses %p (5) |
| A59 | Timestamps ISO-8601 UTC `Z`, real dates | spec §5.6.1 | | › timestamps (spec §5.6.1) › %s → %p (7) |
| A60 | SendMessageResponse oneof task/message; bare Message | design §6.4 | | › SendMessageResponse (oneof task \| message) › reads a task; › reads a bare message answer (design §6.4); › refuses %p |
| A61 | Card: REQUIRED fields, required arrays ≥1, boolean flags, tags, examples, signatures | spec §5.7 | | › Agent Card shape › accepts a minimal valid card; › refuses no name; no interfaces; an interface without a version; no capabilities; a non-boolean flag; no skills; a skill with no tags; non-string examples; no input modes; a malformed signature |
| A62 | Card with `__proto__` or excess depth refused | notes | card_forbidden_member / card_too_deep | GAP → probe held |
| A63 | Empty required arrays refused (spec §5.7 vs §8.4.1 example) | notes open question | recorded interpretation | › refuses no skills |

### A.6 Card canonical form and pin (spec §8.4.1, design §6.1)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A64 | Default stripping; REQUIRED kept | §8.4.1 | | [a2a]/card_signing.test.ts › card canonical form (spec §8.4.1) › drops default-valued non-required fields and keeps required ones |
| A65 | `optional` set to default kept | §8.4.1 | | › keeps an optional field set to its default, and drops a plain default |
| A66 | `signatures` excluded; unknown members verbatim | §8.4.1, §5.7 | | › excludes signatures and keeps unknown members verbatim |
| A67 | Struct contents never stripped | notes | | › never strips inside a Struct (extension params) |
| A68 | Omitted REQUIRED restored; null = unset | notes | | › restores REQUIRED fields an emitter left out at their default (spec §8.4.1) |
| A69 | §8.4.1 worked example | | | › matches the spec §8.4.1 worked example |
| A70 | Rule table equals `a2a.proto` (security schemes, OAuth flows, tenant, skill security requirements) | notes M0 | | GAP → probe held (table checked field by field against v1.0.1 proto) |
| A71 | `__proto__`/too deep → CardFormError | | | › has no canonical form for a card carrying __proto__ or nested past the cap |
| A72 | Pin = sha256(JCS{content, sorted signers}); randomized re-sign keeps it; new key, lost signature, content change re-gate | design §6.1 | | › pins content plus verified signers, never signature bytes (+probe held with real ES256 re-signs) |
| A73 | Spelled-out defaults verify the same | | | › card JWS signatures (spec §8.4.2–§8.4.3) › verifies the same signature whether or not the sender spelled out defaults |

### A.7 Card JWS (spec §8.4.2–§8.4.3, plan §3.13)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A74 | ES256 sign/verify; header alg, typ JOSE, kid, jku | §8.4.2 | | [a2a]/card_signing.test.ts › card JWS signatures… › signs with ES256 and verifies |
| A75 | EdDSA | notes | | › verifies the same signature whether or not the sender spelled out defaults |
| A76 | Tampered card invalid | threat "spoofed/tampered card" | | › reports a tampered card as invalid; [core]/inbound_card.test.ts › signature › a change to the card after signing fails verification |
| A77 | No/empty signatures → unsigned | | | › reports a card with no signatures as unsigned |
| A78 | One of several verifies (rotation) | §8.4.3 | | › accepts a card when one of several signatures verifies (key rotation) |
| A79 | Signer named by verifier identity else `jku#kid` | notes | | › names a verified signer by the key identity the verifier returns |
| A80 | DER refused at signing; wrong length refused before verifier | notes | | › will not sign with a DER-encoded ES256 signature (JWS needs raw r\|\|s); › refuses a signature of the wrong length before the verifier sees it |
| A81 | Malformed `signatures` → invalid, not unsigned | notes | | › reports a malformed signatures member as invalid, not unsigned |
| A82 | alg none/HS256, missing/empty kid, crit, non-string jku refused | RFC 7515 §4.1.11 | | › refuses a protected header with alg none; alg HS256; no kid; an empty kid; a crit member; a non-string jku |
| A83 | typ tolerated and reported | §8.4.2 SHOULD | | › reports the typ the signer wrote; › tolerates a typ other than JOSE (SHOULD, not MUST) |
| A84 | Non-base64url or non-object header refused | | | › refuses a protected header that is not base64url JSON |
| A85 | >8 signatures → invalid, verifier never runs | notes cap | | GAP → probe held |
| A86 | Protected header with two `alg` members not read last-wins | I-JSON | | GAP → probe held |
| A87 | Unprotected `header` cannot rename kid/alg | RFC 7515 | | GAP → probe held |
| A88 | Padded signature spelling refused; throwing verifier = failed | notes | | partial: [a2a]/codec_and_envelope.test.ts › base64url (RFC 4648 §5, unpadded, strict) › refuses padding; card-level probe held |
| A89 | Another key's signature under the expected kid fails | | | GAP → probe held |

### A.8 Card projection and the extended card (design §7.1, §7.6)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A90 | Only active+public+services listings | §7.1 | excluded | [a2a]/card_projection.test.ts › card projection inclusion rules (design §7.1) › leaves out a draft listing; a paused listing; an unlisted listing; a known_only listing; a Talk listing |
| A91 | Custom capability excluded | §1.3 | | › leaves out a custom capability |
| A92 | Commerce excluded (configured name) | plan D2 | | › leaves out a commerce capability |
| A93 | Commerce excluded when an alias resolves to commerce | plan D2 | | GAP → probe held |
| A94 | payment / no class excluded | §5.4 | | › leaves out a payment capability; › leaves out a capability with no class |
| A95 | Not publicly exposable excluded | §7.1 | | › leaves out a sensitive capability |
| A96 | No schema pair / empty hash excluded | §1.3 | | › leaves out a schema-less capability; a capability with no hash at all; a capability with no hash |
| A97 | Unenforceable params schema excluded | notes | | [a2a]/hardening.test.ts › card projection › leaves out a capability whose params schema Core cannot enforce exactly |
| A98 | No executor excluded | §7.1, §7.3 | | › leaves out an executor-less capability |
| A99 | Alias-ambiguous skill id excluded | notes | | [a2a]/hardening.test.ts › card projection › leaves out a skill id that a capability and its alias would both claim |
| A100 | Skill id = canonical@rkey | §7.1 | | › projects an eligible capability as an rkey-qualified skill; › uses the canonical name when a listing configures an alias |
| A101 | Sorted, deterministic | | | › keeps one skill per listing and sorts them; › is deterministic |
| A102 | No Dina-field leakage | §7.1, A2A-I5 | | › never copies a field the card does not need (no Dina-field leakage) |
| A103 | Extension params: `did` (no `agentId`), `skills{paramsSchema,schemaHash}`, `requestSigning` | §7.6, plan §3.22, A2A-I6 | | › carries the contract in the Dina extension, required:false (+probe held: keys exactly did/requestSigning/skills, no agentId) |
| A104 | Standard fields: inputModes JSON, example = JCS of `{skill, params}`, prose names required params | §7.6 | | › carries a usable call in standard fields too (+probe held: example equals its own JCS) |
| A105 | Example is a call Core accepts (shipped catalog, live listings) | §7.6, control plane §18.4 | | [core]/a2a_m0.test.ts › card projection over the shipped catalog (design §7.1, §7.6) › gives every projected skill a standard-field example that Core accepts (control plane §18.4); [core]/inbound_card.test.ts › usable with the extension ignored (§7.6) › every skill’s standard-field example is a call Core accepts |
| A106 | Example accepted for any saveable schema (enum of mixed types) | notes "never emits an example the validator rejects" | | GAP → probe **violated** (F6) |
| A107 | Sampler gives up on unsupported keywords and unsatisfiable bounds | notes | | [a2a]/card_projection.test.ts › sample values from a schema › %p → %p; › gives up on %p; › omits the example when no sample can be built, keeping the skill; [a2a]/hardening.test.ts › card projection › gives no example rather than a wrong one (pattern … a required name with no property) |
| A108 | Sampler never throws and never pushes the card past 128 KB | card_projection.ts doc, A2A_LIMITS | | GAP → probe **violated** (F1) |
| A109 | Projected card passes Dina's own card validator for every saveable rkey (≤512) | §7.6 M2 "every projected card validates" | | partial: › projects an eligible capability as an rkey-qualified skill; [core]/inbound_card.test.ts › projection… › projects a bound lane and an instruction-only capability; validates as a v1.0 card (rkey `self` only) → probe **violated** for long rkeys (F5) |
| A110 | Flags reflect input | §7.1 | | › declares only the features built today |
| A111 | No projectable skill → no card | | | inclusion-rule tests expect `no_projectable_skills` |
| A112 | Extended card: no scope → every public skill; examples carry schema_hash | §7.1 M3 | | › the extended card projects for one client (design §7.1, M3) › with no scope and no grants: every public skill, each example a full envelope |
| A113 | Scope by qualified id or canonical | §5.1 | | › a scope narrows the public skills, by qualified id or canonical name |
| A114 | Live grant adds known_only/unlisted skill with grant_id | §7.1 | | › a live grant adds its skill on a known_only or unlisted listing, sensitive or not, with its grant id |
| A115 | Grant on a public listing adds nothing | notes | | › a grant on a public listing adds nothing: invocation applies the public rules and the scope there |
| A116 | Grant on executor-less or paused listing adds nothing | | | › a grant on a capability no executor can run, or a paused listing, adds nothing |
| A117 | Two grants → first by id | | | › two grants for one capability: the first by id is the one shown |
| A118 | Public card has no grant ids or schema_hash in examples | A2A-I6 | | › the public card is unchanged by the audience machinery: no grant ids, no schema hash in examples |

### A.9 Invocation envelope and qualified skill names (design §7.2a, §8.3)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A119 | Exactly one data part; text ignored | §7.2a | | [a2a]/state_envelope_result.test.ts › invocation envelope (design §7.2a) › accepts exactly one data part and ignores text |
| A120 | grant_id / schema_hash kept when well formed; envelopeObject round trip | | | › keeps grant_id and schema_hash when well-formed |
| A121 | none/text-only/two data/raw/url/two contents/array data refused | §7.2a | protocol error | › refuses no parts; text only; two data parts; a raw part; a url part; a part with two contents; data that is an array |
| A122 | Unknown envelope member refused (incl. top-level `__proto__`) | notes | | › refuses an unknown member (+probe held for `__proto__`) |
| A123 | Missing/malformed skill; missing/array params | | | › refuses a missing skill; an unknown-shaped skill; missing params; array params |
| A124 | Malformed schema_hash / grant_id (incl. empty) | | | › refuses an uppercase schema hash; › refuses a grant id with spaces (+probe held for empty) |
| A125 | params with `__proto__` anywhere, or too deep | | | [a2a]/hardening.test.ts › envelope params cannot carry __proto__ or excess depth › refuses a __proto__ member anywhere in params; › refuses params too deep to hash inside the envelope |
| A126 | Prototype-named params (`constructor`, `toString`) are plain data | | | GAP → probe held |
| A127 | Envelope failures = protocol errors; registry/normalization = one REJECTED | §7.2, A2A-I4 | | [core]/a2a_m0.test.ts › ingress failure classes (design §7.2: steps 1–4 protocol error, 7–9 REJECTED) › classifies every envelope, registry, access and normalization reason |
| A128 | Names parse: flat, `@rkey`, dotted custom | §8.3 | | › qualified skill names › parses eta_query; eta_query@self; com.acme.widget_price@shop-1 |
| A129 | Malformed names refused (incl. `:` in rkey) | | | › refuses '' … 'x'.repeat(129) (10) (+probe held for `:`) |
| A130 | rkey grammar equals @dina/protocol's | | | [core]/a2a_m0.test.ts › parity with the sources of truth › rkey %p: @dina/a2a agrees with @dina/protocol |
| A131 | Every catalog id and alias valid | | | › accepts every official capability name and alias as a skill capability |
| A132 | `qualifySkill` | | | › qualifies a skill |

### A.10 Workflow ↔ TASK_STATE maps (design §6.4, §7.4)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A133 | Inbound map total over Core's WorkflowTaskState | §7.4 | | [a2a]/state_envelope_result.test.ts › state maps (design §6.4, §7.4) › maps every workflow state, and nothing else; [core]/a2a_m0.test.ts › @dina/a2a's workflow states are exactly Core's WorkflowTaskState |
| A134 | Each §7.4 row | §7.4 | | › inbound created/queued/scheduled/claimed/running/awaiting/pending_approval/completed/failed/cancelled reads as …; `pending` probe held |
| A135 | outcome_unknown → FAILED+unknown; recorded → FAILED+anomaly; refusal → REJECTED | §7.4, A2A-I4, A2A-I8 | | › reports outcome_unknown honestly and flags recorded as an anomaly |
| A136 | Unknown stored state (incl. `toString`) → FAILED anomaly | §7.4 | | [a2a]/hardening.test.ts › reads an unknown workflow state as a FAILED anomaly |
| A137 | Outbound map total over TaskState | §6.4 | | › maps every A2A task state outbound, and nothing else |
| A138 | INPUT_REQUIRED/AUTH_REQUIRED fail; CANCELED; UNSPECIFIED → unknown | §6.4, §1.3 | | › never keeps a remote INPUT_REQUIRED task running (no outbound multi-turn) |
| A139 | SUBMITTED/WORKING → running; COMPLETED; FAILED → remote_failed; REJECTED → remote_rejected | §6.4 | | GAP → probe held |
| A140 | Unknown remote state → re-poll | §6.4 | | [a2a]/hardening.test.ts › reads an unknown remote state as unknown (re-poll), never as success or failure |
| A141 | Terminal set; streams end at terminal or interrupted states | spec §3.1.5, notes M4 | | [a2a]/delivery.test.ts › a stream ends on a terminal or an interrupted state, never on work in progress |

### A.11 Result sanitation and the default envelope (design §6.5)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A142 | text/data kept; metadata, filename, mediaType dropped | §6.5 | | [a2a]/state_envelope_result.test.ts › result sanitation (design §6.5) › keeps text and data parts and drops part metadata |
| A143 | C0 (not tab/LF/CR), C1, bidi, ZW, BOM, lone surrogates stripped in text, values, keys | §6.5 | | › strips control, bidi and zero-width characters and lone surrogates, keeping tab/newline |
| A144 | Every Cf code point covered | notes | | [a2a]/hardening.test.ts › invisible code points › covers every format character (Cf) this runtime knows, by code point |
| A145 | Controls, Zl/Zp, variation selectors, FVS, fillers, CGJ | §6.5 | | › covers the controls, separators, variation selectors and blank fillers |
| A146 | Tag block stripped; visible astral kept | §6.5 | | › strips astral invisibles (the tag block spelling hidden ASCII) and lone surrogates; › keeps well-formed astral characters |
| A147 | Text cut at 65,536 code points, no split pair, flagged; exact cap not flagged; data strings not cut | §6.5 | | › cuts text at the code-point cap and flags the result (+probe held) |
| A148 | raw/url refuse the whole result; none; >16; >256 KB; non-object part | §6.5 | | › refuses no parts; a raw part; a url part; too many parts; an oversized result; a non-object part |
| A149 | Key collision; `__proto__` key; key that becomes `__proto__` | notes | | › refuses a key collision after stripping; [a2a]/hardening.test.ts › refuses a __proto__ key in data rather than setting a prototype; › refuses a key that only becomes __proto__ after stripping |
| A150 | Depth bounded by what the envelope can canonicalize | notes | | › accepts data exactly as deep as the released envelope can be canonicalized, and no deeper; › refuses data nested deeper than the cap |
| A151 | Never throws (bigint, cycle, Date, Map, NaN, undefined data, null part, non-string text) | result.ts contract | refusal | GAP → probe held |
| A152 | Default schema pinned by hash and frozen | §6.5 M0 | | › default result schema › is pinned by hash; › cannot be mutated at runtime |
| A153 | Default envelope accept/reject | M0 | | [core]/a2a_m0.test.ts › result ingest: sanitize BEFORE validate (design §6.5) › accepts text and object data under the default envelope; › refuses non-object data under the default envelope; › refuses a raw part before any validation |
| A154 | Sanitize before validate (strip flips const/maxLength) | §6.5 M0 | | › validates the final bytes: a stripped zero-width character makes a const match; › validates the final bytes: a pinned const with a hidden character can never match; › validates the final bytes: stripping brings a value under maxLength |
| A155 | Default vs pinned value; pinned needs one data part | | | › feeds the whole envelope to the default schema, and one data part to a pinned schema |
| A156 | Pinned copy of the default = default | notes | | [core]/a2a_m0.test.ts › stores a pinned copy of the default envelope as no pinned schema; › treats a pinned copy of the default envelope as the default (text results still pass) |
| A157 | Released digest = JCS of the value | §6.5 | | › digests the released value canonically (member order does not matter) |

### A.12 Ingress route table and delivery wire (design §4.3, §5.1, §7.5)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A158 | One POST route per method under `/v1/a2a/ingress` | §4.3 | | [a2a]/ingress_routes.test.ts › ingressPathFor › serves every A2A v1.0 method, each at its own route (M3); [core]/a2a_m0.test.ts › dispatch binding (design §5.1) › routes every method as a POST, so the signed body always reaches Core |
| A159 | Ids from the body, percent-encoded | §5.1 | | › maps a served method to its route, ids filled from the body and escaped; › routes streaming, push-config and extended-card calls, ids from the body |
| A160 | Missing id → id_missing | | | › says when a route id is missing |
| A161 | Every template parameter filled | | | › fills every template parameter of every served route |
| A162 | Dot-segment ids (`.`, `..`) | §4.3 | | GAP → probe: internal path `/v1/a2a/ingress/tasks/../get`; Core's signature and route binding refuse it, so no authority effect (observation only) |
| A163 | Signed operation and task bound to the route | §5.1, threat "compromised gateway" | | [core]/a2a_m0.test.ts › refuses a cross-operation substitution (signed GetTask, executed CancelTask); › refuses a cross-task substitution (signed t1, executed t2); › binds both ids of a push-config call; › refuses an extra route parameter |
| A164 | Signed JSON-RPC query may carry only A2A-Version | §5.1 | | › binds the A2A-Version request parameter and refuses any other signed query |
| A165 | Claim parse: streams and webhooks | §7.5 | | [a2a]/delivery.test.ts › parseDeliveryClaim (the gateway reads Core) › reads streams and webhooks |
| A166 | Malformed claims dropped whole | | | › drops a claim with a webhook with no address; a stream item carrying a webhook; an event with two payloads; an event with neither payload; a non-numeric id; a header that is not text; an empty closed task id (+probe held: extra event member, closed not an array) |
| A167 | Ack parse | | | › parseDeliveryAcks (Core reads the gateway) › reads reports; › refuses an unknown outcome, whole; a claim id with odd characters; a zero id; too many reports; no list |

### A.13 REST binding (spec §11, notes M4 step 3)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A168 | v1.0 paths, no `/v1`; GET and POST subscribe | spec §5.3, §11.3 | | [a2a]/rest_binding.test.ts › routes: the v1.0 paths, no /v1 prefix › POST /message:send → SendMessage … GET /extendedAgentCard → GetExtendedAgentCard (12) |
| A169 | Ids percent-decoded; undecodable refused | | | › decodes a percent-encoded id, and refuses one that does not decode |
| A170 | No match for JSON-RPC path, /v1 prefix, other method, trailing segment, unknown action | | | › matches nothing for … (5) |
| A171 | Core route from the match | | | › maps each request to its operation’s Core route, the ids from the path |
| A172 | Allow header | | | › names the methods a path is served by |
| A173 | Body is the request; typed query; version parameter | spec §11.5 | | › params › a message call: the body is the request; › a list: typed query parameters, and the version |
| A174 | Body may repeat the path id, never change it | notes | | › the path names the task: a body may repeat it, never change it |
| A175 | Unknown/duplicate/badly typed query, bad version, body on a read, missing/malformed/duplicate body refused | notes | | › refuses an unknown query parameter … a body with a member twice (11); [core]/rest_ingress.test.ts › Core binds the REST request to the route the gateway called › refuses a query parameter the operation does not read (400 INVALID_REQUEST) |
| A176 | Query names inherited from Object.prototype refused | notes "REST refuses unknown query parameters" | query_not_allowed | GAP → probe **violated** (F2) |
| A177 | No route takes query and body | | | › no route takes both query parameters and a body |
| A178 | Error mapping = spec §5.4/§11.6; Dina reason after A2A's | spec §5.4, §11.6 | | › errors: google.rpc.Status, A2A’s mapping, Dina’s reason kept › taskNotFound → 404 NOT_FOUND … (9); › an error with no Dina reason carries A2A’s alone (+probe held: all nine A2A errors match v1.0.1 table, unknown code → 500) |
| A179 | One receipt book for both bindings | notes | | [core]/rest_ingress.test.ts › every operation, its own method and path › one receipt book for both bindings: the same message by JSON-RPC is a replay |

### A.14 DID-auth wire (design §5.1, M4)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A180 | Binding input: domain, node DID, client id, DID, challenge, one per line | M4 notes | | [a2a]/did_auth.test.ts › signs the domain, the node, the client, the DID and the challenge, one per line |
| A181 | Binding body exactly `{did, challenge, signature}`, strict | | | › parseDidBindingRequest › reads exactly {did, challenge, signature}; › refuses an extra member; a missing member; a DID that is not one; a challenge of another shape; an upper-case signature; a short signature; › refuses a duplicate member rather than reading the last |
| A182 | No newline can enter the signing input via did/challenge | | | GAP → probe held |
| A183 | Card states the request-signing scheme | §7.6 | | [a2a]/card_projection.test.ts › carries the contract in the Dina extension, required:false |
| A184 | Canonical string verified in Core and bound to the body | §5.1 | | [core]/did_auth.test.ts › a DID-signed request › runs a call; › binds the operation to the signed body: a signed GetTask sent to another door is refused |

### A.15 Directory envelope, fence, attempted-record digest (design §8.2)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A185 | card_hash = sha256 of exact card string bytes (incl. non-ASCII) | §8.2, A2A-I13 | | [a2a]/directory_envelope.test.ts › golden vectors: directory envelope › hashes the exact card string bytes; › golden vectors: frozen refusals… › hashes and digests a card with non-ASCII, astral and U+2028 text byte for byte |
| A186 | Envelope frozen; signing text = JCS without sig | §8.2 | | › reproduces the frozen envelope byte for byte (+probe held: signing_text_sha256) |
| A187 | Verifies in its own record | | | › verifies against the record it arrived in |
| A188 | Cross-repo/collection/rkey/card replay refused | A2A-I13, threat "spoofed card in directory" | | › refuses another repository (replay across DIDs); another collection (cross-record replay); another rkey; a different card; vectors › envelope: replayed into another repository; signed for another repository; replayed onto another collection; replayed onto another rkey; paired with a different card |
| A189 | Other key; tampered epoch | | | › refuses a signature by another key; › refuses a tampered epoch even though the shape is fine |
| A190 | Shape refusals | | | › shape check refuses wrong domain; version 2; a negative epoch; a fractional epoch; an unsafe epoch; an uppercase card hash; a non-UUID instance; an uppercase UUID; an unpadded signature; a url-alphabet signature; a short signature; a bad DID |
| A191 | Exact members | | | › refuses extra or missing members |
| A192 | Malformed envelope never signed | | | › will not sign a malformed envelope |
| A193 | Fence: frozen, own repo, wrong repo DID, envelope as fence, raised epoch, throwing verifier | §8.2 | | › golden vectors: fence › reproduces the frozen fence byte for byte; verifies when read from its own repository; refuses a fence read from another repository (signed for another DID); refuses an envelope presented as a fence (domain separation); refuses a replayed fence with a raised epoch; treats a verifier that throws as a failed signature |
| A194 | Non-canonical bytes; malleated S+L | RFC 8032 policy | | vectors › envelope: a signature over non-canonical bytes; envelope: a malleated signature (S + L); fence: a malleated signature (S + L) |
| A195 | Attempted-record digest | §8.2 M0 | | › golden vectors: attempted-record digest › reproduces the frozen digest; ignores member order (a fetched record canonicalizes the same); changes with an envelope-only cadence bump and with a sibling change; distinguishes two different records from the same instance |

### A.16 Multikey codecs and lexicons
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A196 | base58btc round trip; alphabet | | | [a2a]/multikey.test.ts › base58btc › round-trips %j; › refuses a character outside the alphabet |
| A197 | Ed25519 `z6Mk` and P-256 `zDn` both ways | §8.3 | | › multikeys › Ed25519: the z6Mk form did:key uses, both ways; › P-256: the zDn form, a compressed point, both ways |
| A198 | Wrong kind, length, multibase refused | | | › reads nothing from the other kind, a wrong length, or a non-z multibase |
| A199 | Extra leading `1`, uncompressed P-256 prefix byte, 33-byte Ed25519 refused | | | GAP → probe held |
| A200 | Lexicons: literal:self, card members + 128 KB, fence members + domain, only Lexicon types | §8.2 | | [a2a]/lexicons.test.ts › the card record is com.dinakernel.a2a.card, keyed literal:self; the fence record is com.dinakernel.a2a.fence, keyed literal:self; the card record names the members the publisher writes, and the 128 KB cap; the fence names exactly the signed members, and its domain; the lexicons are exactly the two records, and use only types Lexicon has |
| A201 | Lexicon `skills` item bound (200) admits every id the projection can make | lexicon vs projection | | GAP → probe **violated** (F5) |

### A.17 Dependency hygiene, ids, codecs
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A202 | src imports only relative paths | §4.2 | | [a2a]/dep_hygiene.test.ts › dep hygiene › src/ imports only relative paths — no npm deps, no @dina/*, no node builtins |
| A203 | Zero runtime dependencies | §4.2 | | › package.json declares zero runtime dependencies |
| A204 | Sanity | | | › finds source files (sanity) |
| A205 | UUIDv4 ids from host randomness; uppercase refused; input untouched | A2A-I5 | | [a2a]/hardening.test.ts › uuidV4FromBytes › sets the version and variant bits (+probe held) |
| A206 | base64/base64url one spelling | §8.2 | | [a2a]/codec_and_envelope.test.ts › base64url… › round-trips %p as %s; › refuses padding; standard alphabet; impossible length; non-zero trailing bits (1 byte); non-zero trailing bits (2 bytes); whitespace; › refuses invalid UTF-8 when decoding text; › base64… › refuses missing padding; url alphabet; padding in the middle; three padding characters; non-zero trailing bits (+probe held) |

### A.18 Invariants and threat rows that touch area A (cross-reference)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| A207 | Card is projection only, never read for dispatch | A2A-I1, threat "card claims authority" | | A90–A118 (projection); dispatch resolution is Core's (area B) |
| A208 | One collapsed REJECTED; error details never say why | A2A-I4, threat "existence probing" | | A127, A135 |
| A209 | Internal ids never leak | A2A-I5 | | A102, A205 |
| A210 | Extension discipline; grant selector is an envelope field | A2A-I6 | | A103, A118, A114 |
| A211 | One canonical form for every digest/consent hash | A2A-I10, notes | | A46–A54 |
| A212 | Directory relays bytes, never authors | A2A-I13 | | A185–A195 |
| A213 | Compromised gateway cannot pair a signature with another body/operation | §10 row "compromised gateway" | | A18, A163, A164, A175 (REST hole: A176) |
| A214 | Prompt injection through artifacts | §10 row | | A142–A157 |
| A215 | Payment never projected | §10 row "payment" | | A94 |
| A216 | Contact/Talk never projected | §10 row "contact-service reach" | | A90 |
| A217 | Spoofed/tampered card | §10 rows | | A72, A76–A89 |

### Run of the existing suites
`cd packages/a2a && npx jest` with the 15 named files: 15 suites, **451 passed, 0 failed**. Supplementary (cited above): `cd packages/core && npx jest __tests__/a2a/a2a_m0.test.ts`: **126 passed, 0 failed**.

### Probe summary
Two probe files, both deleted (`packages/a2a/__tests__/zz_wf_probe_A.test.ts`: 56 held, 22 failed by design of the assertions; `packages/core/__tests__/a2a/zz_wf_probe_A.test.ts`: 10 failed, end to end through Core). Violations: F1 (sampler crash and card over 128 KB), F2 (REST inherited query names), F3 (two version grammars), F4 (invalid Request without id), F5 (long rkeys), F6 (mixed-type enum example). Everything else probed held, including the riskiest covered rules: strict parsing under hostile depth and spellings, JWS caps and header tricks, canonical form against the proto, sanitation on hostile input, state-map rows, envelope replay, REST error mapping against the v1.0.1 table.

### Gap closure, area A

Every GAP row above, and the completeness critic's scenarios (X-n), with what now holds it.

| Row | Closed by | Test or reason |
|---|---|---|
| A1 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › pinned A2A facts (plan §2) › serves the public card at /.well-known/agent-card.json, the path the gateway routes (spec §8.2; plan §2 row 2) |
| A2 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › pinned A2A facts (plan §2) › puts the extension version in its URI, and the card entry carries no version member (plan §2 row 8) |
| A7 | existing test | packages/a2a/__tests__/codec_and_envelope.test.ts › A2A service parameters › A2A-Version "01.0" accepted: false (also "1.00", "1.0.01"; the same case asserts speaksA2AVersion); packages/core/__tests__/a2a/rest_ingress.test.ts › errors: google.rpc.Status, A2A’s HTTP mapping, Dina’s reason kept › a version in non-canonical digits (01.0) is refused, as on every door |
| A13 | new test | packages/core/__tests__/a2a/contract_wire_A.test.ts › the card Dina builds never passes the card cap (design §6.6, §8.3) › refuses as card_too_large when listings that each fit their share pass the cap together; › builds a card of many large skills while it fits in 128 KB of canonical bytes |
| A22 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › JSON-RPC ids and response text › refuses %s as a request id: -32600 with id null, never echoed (6 cases); › accepts %s as a request id and keeps it (3 cases) |
| A28 | existing test | packages/a2a/__tests__/codec_and_envelope.test.ts › JSON-RPC 2.0 request envelope › answers an id-less object that is not a valid Request (%s): -32600, id null (JSON-RPC 2.0 §5, §7) (5 cases, the §7 example among them) |
| A34 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › JSON-RPC ids and response text › reads a peer response strictly: two result members, or a __proto__ member, make it malformed; › matches a response id by type and value: "1" does not answer request 1 |
| A41 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › strict I-JSON parsing (RFC 7493) › refuses a lone surrogate written raw in a string or a key (RFC 7493 §2.1) |
| A44 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › strict I-JSON parsing (RFC 7493) › refuses a 200,000-deep text as too deep, with no stack overflow; › refuses a byte-order mark and a no-break space, which RFC 8259 does not count as whitespace; › keeps members named after Object.prototype members as plain data |
| A49 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › RFC 8785 number form (Appendix B) › writes the double %s as %s (24 Appendix B vectors, built from their IEEE 754 bits) |
| A62 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › card validator: no __proto__, no excess depth › refuses a card carrying a __proto__ member anywhere; › refuses a card nested deeper than the JSON depth cap |
| A70 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › card canonical form follows a2a.proto v1.0.1 field by field (spec §8.4.1, §5.7) › %s at %s, sent empty, gets back exactly its REQUIRED fields at their defaults; › %s at %s, every field at its default, keeps REQUIRED and optional fields and a set Struct, and drops the rest; › %s.%s, set but empty, is kept as a present message with its own REQUIRED fields; › %s at %s keeps every scalar that is off its default as sent (21 message placements, every security scheme and OAuth flow) |
| A72 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › card JWS: caps, strict headers, one key per kid › keeps the pin across real randomized ES256 re-signs, and moves it on a new key, a lost signature or new content |
| A85 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › card JWS: caps, strict headers, one key per kid › checks at most eight signatures: a ninth makes the card invalid before any verifier runs |
| A86 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › card JWS: caps, strict headers, one key per kid › refuses a protected header that names alg twice, or kid twice |
| A87 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › card JWS: caps, strict headers, one key per kid › reads alg, kid and jku from the protected header only: an unprotected header cannot rename them |
| A88 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › card JWS: caps, strict headers, one key per kid › refuses a padded or standard-alphabet signature spelling before the verifier sees it; › counts a verifier that throws as a failed signature, and still checks the next one |
| A89 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › card JWS: caps, strict headers, one key per kid › fails a signature made by another key under the expected kid |
| A93 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › card projection: commerce and examples › leaves commerce off the card when a listing names it by an alias (plan D2, §3.6) |
| A103 | existing test | packages/a2a/__tests__/card_projection.test.ts › call contract on the card (design §7.6) › carries the contract in the Dina extension, required:false (Its toEqual on params pins exactly did/skills/requestSigning, so an agentId member would fail it.) |
| A104 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › card projection: commerce and examples › writes each example as the RFC 8785 text of its call, on the public and the extended card |
| A106 | existing test | packages/a2a/__tests__/card_projection.test.ts › sample values from a schema › %p → %p ({type:'string', enum:[5,'five']} → 'five'); packages/core/__tests__/a2a/inbound_card.test.ts › one listing can never break the card › an enum member of the wrong type never becomes an example Core would refuse |
| A108 | existing test | packages/a2a/__tests__/card_projection.test.ts › sample values from a schema › gives up on %p (200,000-item const and enum cases); packages/core/__tests__/a2a/inbound_card.test.ts › one listing can never break the card › a saveable listing whose skill is too large for its share of a card leaves only that skill off; the card is built |
| A109 | existing test | packages/a2a/__tests__/card_projection.test.ts › sample values from a schema › a skill id longer than a card allows is left off, with its reason; the rest of the card stands |
| A122 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › invocation envelope: prototype names and bounded selectors › refuses a top-level __proto__ member of the envelope |
| A124 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › invocation envelope: prototype names and bounded selectors › refuses %s (empty grant id, grant id past 256, non-text grant id, empty schema hash, short schema hash); › accepts a grant id of exactly 256 characters |
| A126 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › invocation envelope: prototype names and bounded selectors › treats params named after Object.prototype members as plain data; › refuses an envelope member named after an Object.prototype member as unknown |
| A129 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › invocation envelope: prototype names and bounded selectors › refuses the skill name %p: its listing key is not an rkey (':', '.', '..', '/', space) |
| A134 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › state maps, row by row › reads a pending workflow task as SUBMITTED (design §7.4) |
| A139 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › state maps, row by row › outbound, a remote %s means %j (design §6.4) (SUBMITTED, WORKING, COMPLETED, FAILED, REJECTED, CANCELED) |
| A147 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › result sanitation never throws (design §6.5) › leaves text of exactly the cap whole and unflagged, and never cuts strings inside data |
| A151 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › result sanitation never throws (design §6.5) › refuses %s with a reason and does not throw (14 hostile inputs: bigint, cycle, Date, Map, NaN, Infinity, undefined data, function, symbol, throwing getter, null part, non-string text, non-list parts, no parts) |
| A162 | new test | packages/core/__tests__/a2a/contract_wire_A.test.ts › a task id of . or .. reaches no other task or operation (design §4.3, §5.1) › %s with id %p: neither the path as sent nor the path an HTTP client folds reaches another task or config (16 cases); › refuses a dot-step call a gateway sends to a real task’s route: the route must name the id the client signed |
| A166 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › delivery claims are dropped whole when malformed (design §7.5) › drops a claim with %s (extra event member, closed not a list, items not a list, zero seq) |
| A176 | existing test | packages/a2a/__tests__/rest_binding.test.ts › params › refuses a key named after an Object.prototype member; › refuses toString on a list |
| A178 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › REST errors follow A2A’s mapping (spec §5.4, §11.6) › %s answers %i %s with A2A’s reason %s first (all nine A2A errors); › answers a code A2A does not map as 500 INTERNAL, keeping its message |
| A182 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › DID binding: nothing can add a line to the signing input › refuses %s (5 newline and CR cases); › builds a five-line signing input from any request it accepts |
| A186 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › directory envelope vectors › signs the RFC 8785 text of the envelope without sig, whose sha256 is frozen for other runtimes |
| A199 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › multikeys refuse near misses › refuses a key with an extra leading 1 (a zero byte before the prefix); › refuses a P-256 point that is not compressed, and an Ed25519 key of 33 bytes |
| A201 | existing test | packages/a2a/__tests__/lexicons.test.ts › the card record names the members the publisher writes, and the 128 KB cap |
| A205 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › external ids are fresh lower-case UUIDv4s (A2A-I5) › refuses an upper-case UUID, and leaves the random bytes it was given untouched |
| A206 | new test | packages/a2a/__tests__/contract_wire_A.test.ts › base64 and base64url: one spelling per byte string (design §8.2) › %s: of the 64 characters that could end the text, only the canonical one decodes to the same bytes; › base64 refuses %s (6 whitespace and padding cases) |
| X-1: Service-key index table: core 0, brain 1, phone approval 2, gateway 3; no two users share an index; a source scan flags any deriveServiceKey call outside SERVICE_INDEX | existing test | apps/home-node-lite/core-server/__tests__/derivations.test.ts › deriveIdentity (tasks 4.54 + 4.55) › canonical constants › pins every service-key index: core 0, brain 1, phone approval 2, A2A gateway 3; › gives no two service-key users the same index; › derives every service key through SERVICE_INDEX, never an inline number; › derives distinct keys for every listed service |
| X-2: P-256 derivation at m/9999'/5'/{generation}': SLIP-0010 nist256p1 vectors, frozen Dina vector, non-canonical indices refused on every curve, generation range, P-256 and Ed25519 trees differ | new test | packages/core/__tests__/a2a/contract_wire_A.test.ts › card-key paths take canonical indices on every curve (plan D4, notes M0) › refuses the index in %s on the Ed25519, secp256k1 and P-256 trees alike (7 paths); › derives the card key at its generation and no other: the same path on another curve is another key |
| X-3: @dina/a2a resolves in every build: lockfile, lite core/brain/gateway Dockerfiles, AppView's three Docker stages and CI paths; AppView tests run against a dist rebuilt from current src | new test | packages/a2a/__tests__/contract_packaging_A.test.ts › the lockfile knows @dina/a2a (notes M2: npm ci refused a tree without it) › lists packages/a2a as a workspace and links node_modules/@dina/a2a to it; › records @dina/a2a for every workspace whose manifest depends on it; › every lite image carries @dina/a2a and the rest of its workspace graph (notes M2) › %s copies the manifest of every package %s needs before npm ci, then their sources (core, brain, gateway); › AppView builds and tests the @dina/a2a it ships (notes M5 step 3) › the %s stage installs every workspace package AppView needs, @dina/a2a among them (builder, migrator, runner); › builds @dina/a2a in the builder before AppView compiles, and ships only that build; › runs its CI on any change under packages/a2a; › rebuilds @dina/a2a from source before every test and typecheck run, so a stale dist cannot pass |
| X-3 (image builds and npm ci on a clean tree) | owed | Building the lite core, brain and gateway images and AppView's three stages, and running npm ci on a clean checkout, need Docker and network access. The static test above checks the files those builds read (it would have caught both M2 packaging faults), but no build ran here. |

---

## Area B test plan: Lane 1 outbound delegation, and the ingress move

Path keys: `core/` = packages/core/__tests__/, `brain/` = packages/brain/__tests__/, `net-node/` = packages/net-node/__tests__/, `home-node/` = packages/home-node/__tests__/, `core-server/` = apps/home-node-lite/core-server/__tests__/. Parameterized titles are written as jest expands them. "GAP → probed" means no existing test held the rule; a probe was run (results in the probes list).

### Registering a remote agent (design §6.1, §5.5, §9; A2A-I1, A2A-I13)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B1 | Card URL outside the policy | §6.6 | refused before any fetch | core/a2a/remote_agents.test.ts › refuses a card URL outside the policy without fetching |
| B2 | Card fetch transport failure | §6.1 | card_fetch_<error> | core/a2a/remote_agents.test.ts › refuses a transport failure |
| B3 | Card answers non-200 | §6.1 | card_fetch_status_404 | core/a2a/remote_agents.test.ts › refuses a 404 |
| B4 | Card text not JSON | notes (strict parse) | card_json_syntax | core/a2a/remote_agents.test.ts › refuses text that is not JSON |
| B5 | Duplicate members | RFC 7493 | refused | core/a2a/remote_agents.test.ts › refuses duplicate members |
| B6 | `__proto__` member | RFC 7493 | refused | core/a2a/remote_agents.test.ts › refuses a __proto__ member |
| B7 | Card misses required fields | v1.0 card | card_description_required | core/a2a/remote_agents.test.ts › refuses a malformed card |
| B8 | First JSON-RPC 1.0 interface pinned, candidate status | notes M1a | candidate, endpoint pinned | core/a2a/remote_agents.test.ts › pins an unsigned card as a candidate on its first JSON-RPC 1.0 interface |
| B9 | gRPC only / 0.3 only / plain-HTTP endpoint | §6.6 | card_no_jsonrpc_1_0_interface | core/a2a/remote_agents.test.ts › refuses only gRPC; › refuses only A2A 0.3; › refuses a plain-HTTP endpoint |
| B10 | Endpoint at a literal IP, with userinfo, with fragment | §6.6 | never chosen | GAP → probed (held) |
| B11 | Interface tenant recorded | notes | tenant kept | core/a2a/remote_agents.test.ts › records the interface tenant |
| B12 | Card capped at 128 KB | §6.6 | too_large | net-node/a2a_host_transport.test.ts › stops reading at the byte cap (Core passes A2A_FETCH_LIMITS.card) |
| B13 | ES256 JWS via jku, key named by RFC 7638 thumbprint | §6.1 | verified | core/a2a/remote_agents.test.ts › verifies an ES256 card through its jku and names the key by thumbprint |
| B14 | High-S ES256 | notes | verified | core/a2a/remote_agents.test.ts › accepts a high-S ES256 signature (JWS does not normalize S) |
| B15 | EdDSA | notes | verified | core/a2a/remote_agents.test.ts › verifies an EdDSA card |
| B16 | No jku, unreachable key set, unknown kid, tampered card | §6.1 | invalid, with reason | core/a2a/remote_agents.test.ts › registers no jku as invalid, and says why; › registers an unreachable key set as invalid, and says why; › registers an unknown kid as invalid, and says why; › registers a tampered card as invalid, and says why |
| B17 | ≤8 signatures, ≤2 key sets, ≤32 keys, ≤4 keys per kid | notes | bounded | core/a2a/remote_agents.test.ts › checks at most 8 signatures: a card with more is invalid, and no key set is fetched; › fetches at most 2 distinct key sets for one card; › refuses a key set of more than 32 keys; › tries at most 4 keys under one kid |
| B18 | Key with use ≠ sig | notes | not used | core/a2a/remote_agents.test.ts › does not use a key whose declared use is not signing |
| B19 | JWK with private member | notes | refused | core/a2a/remote_agents.test.ts › refuses a JWK that carries a private member, and thumbprints per RFC 7638 |
| B20 | jku itself fetched only under the policy (http jku, literal-IP jku) | §6.6 "every connection" | never fetched, invalid | GAP → probed (held) |
| B21 | Pin = sha256 RFC 8785 {content, signers}; re-signed same content keeps pin; new key changes it | §6.1 | as stated | core/a2a/remote_agents.test.ts › keeps the pin when unchanged content is re-signed, and changes it when the key changes; core-server/a2a/reference_agent.e2e.test.ts › keeps the pin when the unchanged card is fetched again |
| B22 | One live registration per URL, race answers the winner | notes | already_registered | core/a2a/remote_agents.test.ts › refuses a second live registration of the same URL; › answers already_registered with the winner when a concurrent registration wins the race |
| B23 | Insert failure with no winner | notes | rethrown | core/a2a/remote_agents.test.ts › rethrows an insert failure that no winning registration explains |
| B24 | Remote name and skill names cleaned and bounded for owner and Brain | notes ("card text the owner sees is cleaned and bounded") | no bidi/zero-width, ≤120 code points | GAP for names (schemes covered by core/a2a/credentials.test.ts › shows the owner the card’s scheme names cleaned and bounded, keeping the raw key) → probed (held) |
| B25 | Card change on re-verify | §6.1, §5.5 | status changed, bindings void, re-bind + re-activate | core/a2a/remote_agents.test.ts › activates only with a bound skill, and a changed card needs re-binding |
| B26 | Card that reverts A → B → A | §5.5 "card change voids" | (interpretation) | GAP → probed: A's bindings revive once the owner re-activates; held as an interpretation (bindings key on the pin; consent hash binds card_hash) |
| B27 | Revoked agent | §6.1 | cannot re-verify, bind, activate; URL re-registrable | core/a2a/remote_agents.test.ts › a revoked agent cannot be re-verified, bound or activated, and its URL can be registered again |
| B28 | Activation needs ≥1 live binding on the current pin | notes | no_bound_skill | core/a2a/remote_agents.test.ts › activates only with a bound skill, and a changed card needs re-binding |
| B29 | Unsigned/invalid cards register; card is never authority | A2A-I1, tradeoff | state shown, owner decides | core/a2a/remote_agents.test.ts › pins an unsigned card as a candidate on its first JSON-RPC 1.0 interface |
| B30 | Directory candidate still walks the full ceremony on the live card | A2A-I13 | same path | GAP (structural: one registerRemoteAgent path, live fetch only; Brain's search returns card_url only — brain/composition/agentic_ask.test.ts › search_a2a_agents is offered only where Lane 1 runs and the client can search the directory) |

### Outbound credentials (design §5.3)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B31 | `none` is a real versioned ref | §5.3 | revision per agent | core/a2a/remote_agents.test.ts › creates versioned none credentials, and refuses one for a card that requires credentials |
| B32 | `none` refused for a card requiring credentials | §5.3 | credential_required_by_card | core/a2a/credentials.test.ts › refuses the “none” credential for a card that requires one |
| B33 | `none` stops binding once the card requires one | notes | refused | core/a2a/credentials.test.ts › a “none” reference no longer binds once the card requires a credential |
| B34 | Credential matches a scheme on the pinned card; choices shown | §5.3 as built | — | core/a2a/credentials.test.ts › offers the card’s schemes to the owner, marking what Dina cannot provide |
| B35 | Refusals: scheme not on card, kind mismatch, key outside header, transport-owned header, Basic, CR/LF, space, empty, scope not on card, no scope, unknown kind | §5.3 | each reason, nothing stored | core/a2a/credentials.test.ts › refuses a scheme the card lacks; › refuses the wrong kind for the scheme; › refuses a key outside a header; › refuses a header the transport owns; › refuses HTTP Basic; › refuses a secret with a line break; › refuses a secret with a space; › refuses an empty secret; › refuses scopes the card does not offer; › refuses no scope choice; › refuses an unknown kind |
| B36 | OAuth token endpoint must pass the policy (http, literal IP, userinfo) | §5.3 "exchanges run under §6.6" | token_url_refused | GAP → probed (held) |
| B37 | Material leaves through one door; views never carry it | §5.3 | — | core/a2a/credentials.test.ts › leaves through one door only: the views and lists never carry it |
| B38 | Headers built per request | §5.3 | api key / bearer / none | core/a2a/credentials.test.ts › builds headers per request: API key, bearer, none; home-node/a2a_runner.test.ts › sends the key on every call, built per request |
| B39 | Revocation deletes material | §5.3 | — | core/a2a/credentials.test.ts › revocation deletes the material |
| B40 | OAuth client-credentials with RFC 6749 Basic auth to the card's token URL | §5.3 | — | core/a2a/credentials.test.ts › form-posts the client-credentials grant to the card’s token endpoint, with RFC 6749 Basic auth |
| B41 | Token cache; dropped on refusal | notes | — | core/a2a/credentials.test.ts › caches the token until shortly before it expires, and drops it when the remote refuses it |
| B42 | Unusable token answers | notes | credential_unusable | core/a2a/credentials.test.ts › cannot use the credential after a refusal; › … after a token type other than bearer; › … after no access token; › … after a token with a line break |
| B43 | Rotation: new ref, bindings moved (revision bump), old revoked, material deleted | §5.3 | — | core/a2a/credentials.test.ts › makes a new reference, moves the bindings, revokes the old one and deletes its material |
| B44 | Approval under the old ref voids (cross-credential reuse) | A2A-I10, §10 | stale_authority | core/a2a/credentials.test.ts › voids an approval made under the old reference (cross-credential reuse); core/a2a/outbound_lane.test.ts › voids the permit when the binding moved to a new credential (cross-credential reuse) |
| B45 | Rotate `none`, revoked, bad secret | notes | refused | core/a2a/credentials.test.ts › refuses to rotate “none”, a revoked credential, or with a bad secret |
| B46 | Removing an agent clears every credential (OAuth, rotated) | notes | material gone | core/a2a/credentials.test.ts › removing the agent revokes every credential and deletes its material; › removing an agent clears OAuth and rotated-away credentials alike |
| B47 | Bind a credential the card no longer offers | notes | refused | core/a2a/credentials.test.ts › refuses to bind a credential the current card no longer offers |
| B48 | Material in no card, event, row, view | §5.3 | absent | core/a2a/credentials.test.ts › is in no consent card, workflow event, operation row or view |
| B49 | Token minted during a revoke | notes | not cached or used | core/a2a/credentials.test.ts › a token that arrives after its credential was revoked is neither cached nor used |
| B50 | Card renders the credential scope and "agent can use all of it" | §1.3, A2A-I10 | sentence on card | core/a2a/credentials.test.ts › voids an approval made under the old reference (cross-credential reuse) (asserts the sentence) |
| B51 | Headers built before the permit is consumed; unusable → failed, nothing sent | §5.3 as built | credential_unusable | home-node/a2a_runner.test.ts › a credential Dina cannot use sends nothing; › an OAuth token endpoint that fails before the send: nothing is sent, the permit is voided |
| B52 | Headers built for a different ref than approved | notes | stale_authority credential_changed, permit void | GAP → probed (held) |
| B53 | 401/403 to the send | §5.3 | failed remote_auth_refused | home-node/a2a_runner.test.ts › a refused credential (401) ends the request as refused, not unknown |
| B54 | 401/403 while polling: static ends; OAuth refreshes once | notes | — | home-node/a2a_runner.test.ts › a 401 to a static key while polling ends the request at once, with its cause; › a 403 to a static key …; › refreshes an OAuth token once while polling; refused again, the request ends with its cause; › sends a bearer token from the card’s token endpoint, and fetches a fresh one when the remote refuses it |
| B55 | Reads after the send follow rotation; successor walk stays in one agent | §5.3 as built | result still comes in | home-node/a2a_runner.test.ts › a secret rotated mid-task: the poll follows the new reference and the result still comes in |

### Outbound skill bindings (design §5.5)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B56 | `payment` never assignable | §1.3, §5.5 | refused | core/a2a/a2a_m0.test.ts › never accepts payment |
| B57 | Five classes accepted | §5.5 | ok | core/a2a/a2a_m0.test.ts › accepts the class read (… quote, write, booking, agentic) |
| B58 | Result schema audited (enforced keywords only, size cap) | notes | refused otherwise | core/a2a/a2a_m0.test.ts › accepts a result schema built only from enforced keywords and annotations; › refuses an oversized result schema; › refuses %p rows |
| B59 | Pinned copy of the default envelope is the default | notes | stored as none | core/a2a/a2a_m0.test.ts › stores a pinned copy of the default envelope as no pinned schema |
| B60 | Bind only a skill on the pinned card, credential of the same agent | §5.5 | refused otherwise | core/a2a/remote_agents.test.ts › binds only skills on the pinned card, with an active credential of the same agent |
| B61 | Unbound skill unusable | §5.5 | skill_not_bound | core/a2a/outbound_lane.test.ts › refuses an unbound skill, an inactive agent, and a revoked credential |
| B62 | Rebinding voids an in-flight permit | §5.5, §6.3 | binding_changed | core/a2a/outbound_lane.test.ts › voids the permit in-transaction when the binding replaced |
| B63 | Result schema in force at consent is used | notes | mismatch refused | core/a2a/outbound_lane.test.ts › validates against the pinned result schema in force at consent; core-server/a2a/reference_agent.e2e.test.ts › validates against a pinned result schema in force at consent |

### Brain's proposal tools (list_a2a_agents, delegate_to_a2a_agent)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B64 | Listing framed as data; empty case | notes | — | brain/a2a/a2a_brain.test.ts › returns the callable agents, framed as data; › says plainly when none are set up |
| B65 | Brain sees only active agents with live bindings | §6.2 | — | core/a2a/routes.test.ts › lists callable agents with their bound skills only |
| B66 | Proposal-only, awaiting_approval, never success | A2A-I11 | — | brain/a2a/a2a_brain.test.ts › proposes through Core and reports awaiting approval, never success |
| B67 | Conversation and claimed sources passed for Core to prove | §6.2 step 2 | — | brain/a2a/a2a_brain.test.ts › binds the proposal to its conversation and passes the sources it claims, for Core to prove |
| B68 | Source of another origin | notes | refused | brain/a2a/a2a_brain.test.ts › refuses a source of any other origin rather than reread it as the owner’s |
| B69 | Refusals relayed plainly; non-object data dropped | notes | — | brain/a2a/a2a_brain.test.ts › explains Core’s provenance refusals plainly; › relays a refusal with a plain note; › drops a data argument that is not an object |
| B70 | Tools only where an A2A client exists AND the ask names its conversation | notes M1a/M1b | absent otherwise | GAP → probed (held) |
| B71 | Only Brain reaches its five doors | §4.3 | others refused | core/a2a/routes.test.ts › brain POST /v1/a2a/delegate → true (and the other rows); › refuses agent on every A2A door (device, plugin, connector, admin) |

### Staging, session binding, bounds (design §6.2 steps 0–1)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B72 | Needs a recorded owner turn in this conversation within 30 min | §6.2 step 0 | no_owner_turn | core/a2a/provenance.test.ts › is refused with no conversation, in a conversation with no turn, or after the turn went stale |
| B73 | Conversation recorded on the operation | notes | — | core/a2a/provenance.test.ts › records the conversation on the operation |
| B74 | ≤10 pending per agent | §6.2 step 0 | too_many_pending | core/a2a/outbound_lane.test.ts › bounds the pending cards per agent |
| B75 | ≤50 pending in all | §6.2 step 0 | too_many_pending | GAP → probed (held) |
| B76 | ≤30 proposals per rolling hour, refusals counted, 429 | §6.2 step 0 | too_many_recent | core/a2a/outbound_lifecycle.test.ts › refuses more than the hourly cap, then allows again an hour later; core/a2a/provenance.test.ts › counts refusals toward the hourly cap, so claims cannot be probed for free; core/a2a/brain_compromise.test.ts › the hourly cap answers 429 |
| B77 | Staging, card and child commit together; projection bound by hash | §6.2 step 1 | — | core/a2a/outbound_lane.test.ts › stages the operation, mints the card, and binds the exact projection by hash |
| B78 | Owner says no / card lapses | §6.2 step 1 | refused / expired, told once | core/a2a/outbound_lane.test.ts › a no closes the operation; silence past the deadline expires it; core/a2a/outbound_lifecycle.test.ts › the owner says no; › the card lapses |
| B79 | A card past its 15-minute life cannot be approved into a send | §6.2 step 1 "expiry terminalizes" | not minted | GAP → probed (VIOLATED, finding B-F2) |
| B80 | Staged operation survives a restart | §12 M1a | approval mints after restart | core/a2a/outbound_lifecycle.test.ts › pending decision: the card survives and approval mints |
| B81 | Owner cancels before deciding / after approving | §6.4 | cancelled, card withdrawn in the same commit | core/a2a/outbound_lifecycle.test.ts › the owner cancels before deciding, and after approving |

### Provenance and the release log (A2A-I12, §4.2, §6.2 step 2, M1b)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B82 | Whole owner message proves; doubt labels drop | §6.2 step 2 | proven | core/a2a/provenance.test.ts › proves a whole message the owner sent here, and drops the doubt labels when everything is proven |
| B83 | Several whole messages, 1–2 spaces/new lines between | §6.2 step 2 | proven | core/a2a/provenance.test.ts › proves several whole messages; a space or a new line between them is not content |
| B84 | Message from another conversation | §6.2 step 2 | refused | core/a2a/provenance.test.ts › refuses a message the owner sent in another conversation (utterance mismatch) |
| B85 | Uncovered text and any data part are derived | §6.2 step 2, D1 | unverified + may_contain_sensitive | core/a2a/provenance.test.ts › labels what no proven quote covers as derived: unverified and possibly sensitive; core/a2a/outbound_lane.test.ts › labels a payload with no proven source unverified and possibly sensitive (D1) |
| B86 | A part of a unit proves nothing | §6.2 step 2 | refused | core/a2a/provenance.test.ts › a long message proves only whole: its first part, however long, proves nothing; › refuses a piece of a message; › refuses a negation dropped; › refuses a short piece |
| B87 | Cuts after list numbers, "Yahoo!", ellipsis, titles, a.m., U.S., reported speech, German abbreviation | notes (3rd review) | source_unproven | core/a2a/provenance.test.ts › refuses a cut after a roman-numbered list (and the 7 other rows) |
| B88 | Core keeps a digest only | §4.2 (a) | no words stored | core/a2a/provenance.test.ts › Core keeps a digest of each message, never the words |
| B89 | Quote rules: length, once, boundaries, no overlap, no padding | §6.2 step 2 | each reason | core/a2a/provenance.test.ts › refuses a short piece; › refuses a one-word piece; › refuses a quote the message holds twice; › refuses the same quote claimed twice; › refuses a quote inside a word of the message; › refuses a quote padded with spaces; › refuses a quote that is not in the message |
| B90 | Symbols, emoji, Braille, exotic spaces, punctuation between units | notes (2nd review) | unproven, taint kept | core/a2a/provenance.test.ts › counts circled letters beside the units as unproven, and keeps the conversation’s taint (and 6 rows) |
| B91 | A mark joining two units is content | §6.2 step 2 | derived | core/a2a/provenance.test.ts › a mark between two units, joining them into new words, is content |
| B92 | Quote edge inside a personal detail | §6.2 step 2 | refused | core/a2a/provenance.test.ts › refuses a quote whose end falls inside a personal detail of the message |
| B93 | Vault item: whole body, released here, saved before the conversation | §6.2 step 2 | proven | core/a2a/provenance.test.ts › proves the whole body of an item saved before the conversation and released in it |
| B94 | Item written during the conversation | §6.2 step 2 | source_unproven | core/a2a/provenance.test.ts › refuses an item written during the conversation (Brain could have written it from what it read) |
| B95 | Same rule once the thread's first turns pass the 24 h log window | §6.2 step 2, A2A-I12, provenance.ts header | source_unproven | GAP → probed (VIOLATED, finding B-F1) |
| B96 | An item written in thread A from a restricted read, quoted in thread B | A2A-I12 / §10 laundering | restricted or unverified label | GAP → probed: proven with no labels (part of finding B-F1) |
| B97 | Fabricated handle | §6.2 step 2 | refused | core/a2a/provenance.test.ts › refuses an item never released into this conversation (fabricated handle) |
| B98 | Partial body, changed item, locked persona | §6.2 step 2 | refused | core/a2a/provenance.test.ts › refuses text the item does not hold whole, an item changed since release, and a locked persona |
| B99 | Model-written summaries never prove | §6.2 step 2 | refused | core/a2a/provenance.test.ts › refuses the same cut of a vault item, and the item’s model-written summaries |
| B100 | Private vault quote is restricted and named | §6.2 step 2 | restricted_source | core/a2a/provenance.test.ts › marks a quote from a private vault restricted, and names the vault |
| B101 | Derived text inherits read-set taint (items and topics) | §6.2 step 2 | restricted_source | core/a2a/provenance.test.ts › derived text inherits the conversation’s read-set taint, item reads and topic lists alike |
| B102 | Topic list taints, never proves | §4.2 (b) | — | core/a2a/provenance.test.ts › a topic list can taint, but never prove a quote; core/a2a/release_log.test.ts › records a topic list as a release that taints, under an id no item has |
| B103 | Consent hash covers proven sources | notes | — | core/a2a/provenance.test.ts › the consent hash covers the proven sources |
| B104 | What a proof shows is stated | notes | — | core/a2a/provenance.test.ts › documents what a whole message proves: that the owner sent it, not what a later message added |
| B105 | Read functions record every read surface | §4.2 (b) | rows | core/a2a/release_log.test.ts › search, get, list, browse and subject recall each record what they return |
| B106 | Non-session reads record nothing | §4.2 (b) negative | — | core/a2a/release_log.test.ts › a read with no conversation records nothing (the owner’s browser, a briefing) |
| B107 | One conversation's reads never enter another's | §4.2 (b) negative | — | core/a2a/release_log.test.ts › one conversation’s reads never enter another’s read set |
| B108 | Changed item is a new release | notes | — | core/a2a/release_log.test.ts › records a changed item as a new release, so a proof checks the content Brain saw |
| B109 | Unloggable release fails the read | §4.2 (b) | read fails | core/a2a/release_log.test.ts › fails the read when the release cannot be logged: taint is never under-counted |
| B110 | Releases expire after the window | notes | — | core/a2a/release_log.test.ts › expires releases after the window |
| B111 | Deleted persona keeps taint; unknown persona is private | notes | — | core/a2a/release_log.test.ts › a deleted persona leaves a marker that keeps the conversation tainted and proves nothing; › a read of a persona the registry no longer knows counts as private |
| B112 | Both boots log identically | §4.2 (b) parity | same rows | core/a2a/release_log.test.ts › the server’s Brain, the phone’s in-process router calls and its direct calls record the same rows; brain/a2a/a2a_conversation.test.ts › through Core’s routes (the server) and by direct calls (the phone) |
| B113 | Offset cap | notes | empty page | core/a2a/release_log.test.ts › an offset past the cap answers an empty page, never another page |
| B114 | Release session from Brain only | notes | 403 / 400 | core/a2a/release_log.test.ts › refuses a release session from anyone but Brain, and a malformed one |
| B115 | Owner turn recorded once, Brain's door only | §4.2 (a) | first stands | core/a2a/release_log.test.ts › records the owner’s turn once, through Brain’s door only; core/a2a/brain_compromise.test.ts › cannot rewrite a turn already recorded (the first record of a turn stands) |
| B116 | No release log → 503 | notes | 503 | core/a2a/release_log.test.ts › answers 503 for turns on a host with no release log |
| B117 | Owner words recorded at chat entry before any model; chat goes on if not | §4.2 (a) | — | brain/a2a/a2a_conversation.test.ts › records first, then routes; the payload of a composer lane, not its prefix; › goes on chatting when Core cannot record the turn (its words just stay unprovable) |
| B118 | Session ids; conversation across an approval pause | notes | — | brain/a2a/a2a_conversation.test.ts › names a chat thread, or the ask alone; › digests a thread name Core would refuse, and one that spells the digest mark; › round-trips through the registry adapter; › as the ask’s conversation |
| B119 | Vault tools, classifier, pre-flight pass the conversation on both read paths | §4.2 (b) | — | brain/a2a/a2a_conversation.test.ts › search, browse and get each pass the release session where Core reads it; › search, browse, list and get each record a release into the conversation; › a tool built without a conversation records nothing; › the tool registry, the intent classifier and the pre-flight retrieval; › every read, every argument (the boot installs exactly this) |
| B120 | Cross-audience handle rejection | §9 a2a_disclosures | rejected | GAP (structural: only audience 'brain' exists; every log read filters `audience = 'brain'`, release_log.ts:128,138) |
| B121 | Compromised Brain can invent a new turn (documented limit) | notes | allowed | core/a2a/brain_compromise.test.ts › CAN add a new turn: compromised Brain code can invent owner words (the documented limit) |

### PII scrub, projection, originals (§6.2 step 3, D7, A2A-I9, plan §3.19)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B122 | Placeholders numbered across the message; no original kept (D7) | §6.2 step 3 | — | core/a2a/outbound_lane.test.ts › replaces PII with placeholders numbered across the message, and keeps no original anywhere (D7) |
| B123 | Invisible characters removed | notes | — | core/a2a/outbound_lane.test.ts › removes invisible characters so what the owner reads is what goes out |
| B124 | Empty, non-object data, `__proto__`, text cap, 256 KB | §6.5 caps | refused | core/a2a/outbound_lane.test.ts › refuses an empty message; › refuses data that is not an object; › refuses a __proto__ key; › refuses text past the cap; › refuses a message past 256 KB |
| B125 | Data nested too deep | notes | data_too_deep | GAP → probed (held) |
| B126 | Keys and numbers scrubbed | notes | — | core/a2a/outbound_lifecycle.test.ts › scrubs personal details in data keys and in numbers, not only in strings |
| B127 | One value one placeholder; distinct keys kept; colliding keys refused | notes | — | core/a2a/outbound_lifecycle.test.ts › gives one value one placeholder wherever it appears: text, key and value; › two different values as keys keep two keys; nothing approved is lost; › refuses keys that become one after cleaning, rather than drop one |
| B128 | Placeholder-shaped input | notes | placeholder_in_input | core/a2a/outbound_lifecycle.test.ts › refuses text that already looks like a placeholder; › refuses a value …; › refuses a key … |
| B129 | Runner handed only the scrubbed projection | §6.2 step 3 | — | core/a2a/outbound_lifecycle.test.ts › the runner is handed only the scrubbed projection |
| B130 | No original in any task, permit, snapshot, event, guard row or runner request | plan §3.19 | absent | core/a2a/outbound_lane.test.ts › replaces PII with placeholders numbered across the message, and keeps no original anywhere (D7); riskiest probe (held) |
| B131 | Owner-word originals in the identity file, legend owner-only, never in the remote text | A2A-I9, notes | — | core/a2a/provenance.test.ts › the owner’s own words: kept in the identity file, shown to the owner as a legend, never in the agent’s text |
| B132 | Vault original sealed under a purpose key; moved blob does not open | A2A-I9 | — | core/a2a/provenance.test.ts › a vault original is sealed under a purpose key and opens only while the persona is open; › a sealed original moved to another place does not open |
| B133 | No original for derived text, data part, two sources | A2A-I9 | — | core/a2a/provenance.test.ts › keeps no original for a value in derived text, in the data part, or held by two sources |
| B134 | Persona delete takes originals; failing listener stops delete | notes | — | core/a2a/provenance.test.ts › a deleted persona takes its originals with it; a new persona of the same name finds nothing; › a listener that fails stops the delete, so a persona is never gone while what it sealed remains |
| B135 | Originals at 7 days after end, 30 days hard | §9 | — | core/a2a/provenance.test.ts › forgets originals 7 days after the operation ends, at 30 days whatever happens, and the operation later; › an original whose result is held forever still goes at its hard end |
| B136 | Brain's view has no legend | A2A-I9 | — | core/a2a/brain_compromise.test.ts › its view of an operation carries no placeholder legend |

### The consent card (A2A-I10, §6.2 steps 5–6, plan §3.7)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B137 | Brain cannot create a consent card or dispatch payload | §6.2 step 6 | 400 | core/a2a/outbound_lane.test.ts › Brain cannot create one (400); core/a2a/brain_compromise.test.ts › refuses a consent card payload (400); › refuses a dispatch payload (400) |
| B138 | Brain cannot decide; owner can | §6.2 step 6 | 403 | core/a2a/outbound_lane.test.ts › Brain cannot decide one (403); the owner can; core/a2a/brain_compromise.test.ts › cannot approve the consent card (403); › cannot cancel …; › cannot fail … |
| B139 | Agent and plugin callers cannot decide either | ownerDecisionGuard | 403 | GAP → probed (held) |
| B140 | brain-server /api/v1/ask/:id/approve cannot decide one | §6.2 step 6 | refused | GAP (structural: it forwards as Brain, refused per B138; the route acts only on the ask record's own approvalId, ask.ts:156-168) |
| B141 | Consent payload is A2A-I10's fields + provenance; hash keys card, permit, dispatch | A2A-I10 | — | core/a2a/outbound_lane.test.ts › stages the operation, mints the card, and binds the exact projection by hash |
| B142 | Console renders every field, the full projection, hostile text inert | A2A-I10 | — | core-server/owner_console.test.ts › renders the A2A consent card from its payload: every field as text, the full projection, hostile text inert |
| B143 | Phone mirror only when the full message fits and passes character rules | plan §3.20 | console otherwise | core-server/phone_approval_sync.test.ts › mirrors the card with every byte that would be sent; › keeps a card the phone cannot show in full on the console |
| B144 | a2a- task id and key namespace reserved | notes | 400 | core/a2a/brain_compromise.test.ts › refuses a task id in the A2A namespace (400); › refuses an idempotency key in the A2A namespace (400); › cannot squat the dispatch key of an operation it proposed, so the owner’s yes still mints |

### Approval to permit (§6.2 step 6)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B145 | One permit, one dispatch child on the agent lane, card completed in the same commit | §6.2 step 6 | — | core/a2a/outbound_lane.test.ts › mints one permit and one dispatch child on the agent lane, and completes the card |
| B146 | Crash after the approval commit, before the handler | §6.2 step 6 | sweeper mints once | core/a2a/outbound_lane.test.ts › a crash after the approval commit and before the handler: the sweeper mints exactly once; core/a2a/outbound_lifecycle.test.ts › approved but not minted (the process died before the handler): the sweeper mints once |
| B147 | Crash inside the handler | §6.2 step 6 | nothing half-made | core/a2a/outbound_lane.test.ts › a crash inside the handler leaves nothing half-made; the sweeper then mints exactly once |
| B148 | Handler then sweeper; true race | §6.2 step 6 | one permit | core/a2a/outbound_lane.test.ts › handler then sweeper: the second finds the operation minted and makes nothing; › handler and sweeper truly racing: both read "not minted", the unique index lets one through |
| B149 | Pre-dispatch cancel or drift-voided permit, then sweep | §6.2 step 6 | no new permit, no send | core/a2a/outbound_lane.test.ts › a pre-dispatch cancel followed by a sweep: no new permit, no send; › a drift-voided permit followed by a sweep: no new permit, no send |
| B150 | Drift between proposal and approval | §6.2 step 6 | stale_authority, card failed | core/a2a/outbound_lane.test.ts › refuses to mint when the authority changed between proposal and approval; core/a2a/outbound_lifecycle.test.ts › the authority moved between proposal and approval (after the owner pressed Send) |
| B151 | Approval reuse for another operation | A2A-I10 | refused | core/a2a/outbound_lane.test.ts › an approval cannot be reused for another operation, even relinked to it; › an approval mints once: a second operation cannot ride a used one |
| B152 | Card hash ≠ staged hash | A2A-I10 | not minted | core/a2a/outbound_lifecycle.test.ts › refuses to mint an operation whose card does not hash to what it stages |
| B153 | Real mint fault | notes | rethrown | core/a2a/outbound_lifecycle.test.ts › rethrows a real fault: no stored permit means no race was lost |
| B154 | Runtime fault: approval commits, handler swallows; runtime pairs one connection | notes | boot check stops it | core/a2a/routes.test.ts › an approval still commits when the handler meets the fault; the boot check is what stops it; › pairs the installed store with whichever service is set, and throws on one on another connection |
| B155 | Sweeper isolates each operation; async transaction bodies refused | notes | — | core/a2a/outbound_lifecycle.test.ts › repairs every other operation when one cannot be repaired; › refuse an asynchronous body and roll back what it wrote |

### The a2a: lane and the dispatch transaction (§6.3, plan §3.17)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B156 | Create route refuses reserved lanes (case, trim, empty suffix) | §6.3 | reserved_runner | core/a2a/lane_reservation.test.ts › refuses creating a task on the reserved lane "a2a:ra-1" (and 8 rows) |
| B157 | Tab, newline, NBSP, zero-width, uppercase spellings; device and plugin callers too | §6.3 | refused or never claimable | GAP → probed (held: all refused) |
| B158 | Reasoning kind refused | plan §4.2a | reserved_runner | core/a2a/lane_reservation.test.ts › refuses a reasoning task through the route: only the broker makes one |
| B159 | Claim route refuses an a2a filter from every HTTP caller | §6.3 | 403 | core/a2a/lane_reservation.test.ts › refuses a agent claiming an a2a lane over HTTP (brain, admin, owner rows); core/a2a/brain_compromise.test.ts › cannot claim on an A2A lane (403) |
| B160 | Generic claim never takes an a2a task; a2a filter exact; plugin filter never (both stores) | §6.3 | — | core/a2a/lane_reservation.test.ts › a generic claim never takes an a2a lane task; › an a2a filter claims its own lane exactly, never untagged work or another lane; › a plugin lane filter never takes an a2a lane task |
| B161 | No HTTP caller moves a dispatch child; owner cancels via the operation route | notes | 403 a2a_lane_reserved | core/a2a/brain_compromise.test.ts › cannot approve the dispatch child (403), and the approved operation stands (and 5 verbs); › no owner moves a running dispatch child through the workflow routes (a2a_lane_reserved) (device, admin, agent); › even the owner moves a dispatch child only through the operation route |
| B162 | Dispatch consumes the permit, moves to transmitting, persists a fresh messageId | §6.3 | — | core/a2a/outbound_lane.test.ts › consumes the permit and moves to transmitting with a fresh message id |
| B163 | Runner that lost its claim | §6.3 | touches nothing | core/a2a/outbound_lane.test.ts › a runner that lost its claim touches nothing |
| B164 | Every drift class voids in-transaction | §6.3 | stale_authority + reason | core/a2a/outbound_lifecycle.test.ts › card_changed; › endpoint_changed; › binding_changed; › credential_changed; › credential_revoked; › agent_revoked; › approval_not_intact; › no_permit; › snapshot_unreadable; › consent_mismatch; core/a2a/outbound_lane.test.ts › voids the permit in-transaction when the agent revoked (binding replaced, binding revoked, credential revoked) |
| B165 | Cross-recipient reuse: card changed (real re-verify) | A2A-I10, §10 | void, no send | core/a2a/outbound_lane.test.ts › voids the permit when the remote card changed (cross-recipient reuse); › voids the permit for a re-approved new card: the owner approved the old one (cross-recipient reuse); riskiest probe (held) |
| B166 | Stored consent no longer hashes | A2A-I10 | consent_mismatch | core/a2a/outbound_lane.test.ts › voids the permit when the stored consent no longer hashes to what was approved |
| B167 | Permit past its 1 h life | notes | expired | core/a2a/outbound_lane.test.ts › expires an operation whose permit outlived its window |
| B168 | A second begin under the same claim after transmitting | A2A-I8 | never a second send | GAP → probed (held: ends outcome_unknown) |
| B169 | Repeated mints and sweeps | §6.2 step 6 | exactly one permit and child | riskiest probe (held) |

### Recovery, cancellation, state mapping (§6.4)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B170 | Lease lost at built | §6.4 | dispatch normally | core/a2a/outbound_lane.test.ts › dispatches normally when the lease was lost before anything was sent |
| B171 | Lease lost at transmitting | §6.4, A2A-I8 | outcome_unknown, no resend | core/a2a/outbound_lane.test.ts › never re-sends after transmitting: the operation ends outcome_unknown; core/a2a/outbound_lifecycle.test.ts › transmitting: never sent again; the operation ends outcome_unknown |
| B172 | Lease lost at acknowledged (deviation: resume polling) | notes | polling resumes | core/a2a/outbound_lane.test.ts › resumes polling after an acknowledgement (GetTask re-executes nothing); core/a2a/outbound_lifecycle.test.ts › acknowledged: the next runner resumes polling the same remote task |
| B173 | Stale claim reports | §6.4 | refused | core/a2a/outbound_lane.test.ts › a stale claim cannot report after the task was re-claimed |
| B174 | Dispatch child ended unreported; queued child died | §6.4 | outcome_unknown / expired | core/a2a/outbound_lane.test.ts › marks an operation whose dispatch child ended unreported as outcome_unknown; core/a2a/outbound_lifecycle.test.ts › the sweeper expires a queued operation whose child died, and closes a running one that ended unreported |
| B175 | Restart at queued / quarantined | §12 M1a | — | core/a2a/outbound_lifecycle.test.ts › queued: the next runner claims and sends; › quarantined: the held result waits for the guard and releases once |
| B176 | Cancel request claim-independent, survives re-claim, resolved by the current claim | §6.4 | — | core/a2a/outbound_lane.test.ts › records a claim-independent request that survives re-claim, resolved only by the current claim |
| B177 | Cancel after claim, before the dispatch transaction | §6.4 | no send | core/a2a/outbound_lane.test.ts › a cancel requested after the claim but before the dispatch transaction ends the operation without sending; riskiest probe (held) |
| B178 | Cancel of a finished operation | §6.4 | already_finished | core/a2a/outbound_lane.test.ts › refuses to cancel what has finished |
| B179 | Queued cancel through the real runner | §6.4 | zero SendMessage | GAP at runner level → probed (held) |
| B180 | Owner cancel carried to the remote; confirmed / refused | §6.4 | cancelled / runs to its end | home-node/a2a_runner.test.ts › carries the owner’s cancel to the remote, and records a confirmed cancel; › a remote that refuses the cancel runs on to its real end |
| B181 | Cancel during the in-flight send | §6.4 | one send, CancelTask next | GAP → probed (held) |
| B182 | Renewal between cancel attempt and next GetTask | notes | — | home-node/a2a_runner.test.ts › renews the claim between a cancel attempt and the next GetTask |
| B183 | Bare Message answer | §6.4 | result, remote_task_id NULL, terminal | home-node/a2a_runner.test.ts › sends exactly the approved message, and takes a bare Message answer as the result; core-server/a2a/reference_agent.e2e.test.ts › takes a bare Message answer as the result |
| B184 | Completed task artifacts | §6.4 | result | home-node/a2a_runner.test.ts › takes a completed task’s artifacts as the result; core-server/a2a/reference_agent.e2e.test.ts › takes a completed task’s artifact as the result |
| B185 | WORKING polled with renewals before each call | §6.4 | — | home-node/a2a_runner.test.ts › polls a working task with GetTask until it completes, renewing the claim before every call; core-server/a2a/reference_agent.e2e.test.ts › polls a working task with GetTask until it completes |
| B186 | INPUT_REQUIRED, AUTH_REQUIRED, FAILED, REJECTED, CANCELED | §6.4 | mapped | home-node/a2a_runner.test.ts › maps a remote INPUT_REQUIRED to its outcome (and 4 rows); core-server/a2a/reference_agent.e2e.test.ts › ends INPUT_REQUIRED and FAILED tasks in Dina’s words |
| B187 | INPUT_REQUIRED while polling | §6.4 | remote_needs_input | GAP → probed (held) |
| B188 | UNSPECIFIED | §6.4 | re-poll, then outcome_unknown at deadline | GAP → probed (held) |
| B189 | State outside the enum | §6.4 (state_map) | outcome_unknown | home-node/a2a_runner.test.ts › a malformed or invalid answer leaves the outcome unknown |
| B190 | JSON-RPC error read by code and class | §6.4, A2A-I8 | rejected / error / unknown | core/a2a/outbound_lifecycle.test.ts › code -32602 on a summarize request ends failed (remote_rejected) (and 4 rows); home-node/a2a_runner.test.ts › reads a JSON-RPC error to SendMessage by its code (Core weighs it against the action class) |
| B191 | Transport failure before / after the handshake | notes | not_sent failed / outcome_unknown | home-node/a2a_runner.test.ts › a transport failure before the handshake is not_sent; after it, outcome_unknown; core/a2a/outbound_lane.test.ts › ends the operation and its child together: … (4 rows) |
| B192 | Duplicate members, `__proto__`, wrong JSON-RPC id, task + message in one answer | strict I-JSON | never a result | GAP → probed (held) |
| B193 | Polling deadline; remote forgets the task | §6.4 | outcome_unknown | home-node/a2a_runner.test.ts › gives up polling at the deadline as outcome_unknown; › a remote that forgets the task leaves the outcome unknown |
| B194 | Lease longer than one call plus the longest sleep | notes | constructor refuses | home-node/a2a_runner.test.ts › refuses a lease no longer than one call plus the longest sleep |
| B195 | Runner never rejects; claims only approved work; sweeps each tick | notes | — | home-node/a2a_runner.test.ts › never rejects: a Core fault in a tick is logged, and the next tick works; › a failing claim is logged and leaves the work for the next tick; › claims nothing it was not asked to send, and sweeps on every tick |
| B196 | Remote text never stored as a reason | §6.4 | — | core/a2a/outbound_lane.test.ts › never stores remote text as a reason |
| B197 | GetTask answer naming a different task id | — | (documented) | GAP → probed: accepted as the result (no finding: the remote controls its own answers) |

### Results: sanitize, validate, quarantine, guard, release (§6.5, A2A-I7)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B198 | Sanitize before validate; final bytes validated | §6.5 | — | core/a2a/a2a_m0.test.ts › validates the final bytes: a stripped zero-width character makes a const match; › validates the final bytes: a pinned const with a hidden character can never match; › validates the final bytes: stripping brings a value under maxLength |
| B199 | raw part refused | §6.5 | — | core/a2a/a2a_m0.test.ts › refuses a raw part before any validation |
| B200 | url part, text+data in one part, no parts | §6.5 | refused | GAP → probed (held) |
| B201 | `__proto__` in remote data | §6.5 | refused | core/a2a/a2a_m0.test.ts › refuses a __proto__ key in remote data instead of throwing |
| B202 | Default envelope accepts text/object data, refuses non-object | §6.5 | — | core/a2a/a2a_m0.test.ts › accepts text and object data under the default envelope; › refuses non-object data under the default envelope |
| B203 | Pinned schema that slipped past the audit | notes | refused | core/a2a/a2a_m0.test.ts › refuses a pinned schema that slipped past the binding audit |
| B204 | Unreadable pinned schema never falls back to the default | notes (M1a review) | result_refused:schema_unreadable | GAP → probed (held) |
| B205 | Canonical digest | §6.5 | — | core/a2a/a2a_m0.test.ts › digests the released value canonically (member order does not matter) |
| B206 | Quarantine + guard job; child completes with no remote content | §6.5 | — | core/a2a/outbound_lane.test.ts › quarantines a result, holds it for the guard, and completes the child with no remote content |
| B207 | Nothing remote reaches Brain before the guard | §6.5, A2A-I7 | — | core/a2a/outbound_lane.test.ts › the dispatch child and its events carry operation ids only; core/a2a/brain_compromise.test.ts › the operation view, the child and its events show none of it while held; riskiest probe (held) |
| B208 | Pass releases with exactly one event | §6.5 | — | core/a2a/outbound_lane.test.ts › releases a passed result with exactly one delivery event |
| B209 | Digest- and claim-bound verdict | §6.5 | refused otherwise | core/a2a/outbound_lane.test.ts › refuses a verdict for bytes it did not scan, or under a lost claim; core/a2a/brain_compromise.test.ts › a verdict releases only the bytes the guard was handed |
| B210 | Reason code checked against verdict | notes | bad_verdict | core/a2a/outbound_lane.test.ts › refuses a verdict whose reason code is unknown or does not match it |
| B211 | Operation stopped waiting | §6.5 | job closed, silent | core/a2a/outbound_lane.test.ts › closes the job, and says nothing, when the operation stopped waiting under the claim |
| B212 | Blocked stays held, neutral notice | §6.5 | — | core/a2a/outbound_lane.test.ts › keeps a blocked result held, tells the owner neutrally, and never shows the content |
| B213 | Outage or no model: held, told once | §6.5 | — | core/a2a/outbound_lane.test.ts › holds through a worker outage and tells the owner once (no guard model, or none running) |
| B214 | Lapsed claim re-claimed; unreadable quarantine closed | §6.5 | — | core/a2a/outbound_lane.test.ts › hands a lapsed claim to the next worker; › closes a job whose quarantine cannot be read, and never hands it out; core/a2a/outbound_lifecycle.test.ts › a result whose quarantine cannot be read ends blocked, told once |
| B215 | One ending, one event, every path | §6.5 step 2 | — | core/a2a/outbound_lifecycle.test.ts › the owner says no; › the card lapses; › drift voids the dispatch; › the remote fails, cancels, or leaves Dina unsure; › a released result ends with the release alone |
| B216 | Ending never commits without its event | notes | rollback / untold only without a card | core/a2a/outbound_lifecycle.test.ts › rolls the ending back when no task can carry the event; › ends an operation whose card was never written, untold, and only that one |
| B217 | Purge after 30 days, children first, workflow rows too | §9 | — | core/a2a/outbound_lifecycle.test.ts › deletes children first after the retention window, and nothing earlier |
| B218 | Quarantine excluded from export | §9 | — | GAP (structural: export allowlist IDENTITY_TABLES, packages/core/src/export/archive.ts:118, names no a2a_ table) |
| B219 | Guard worker: patterns, fence, model, retry, outage, logs | §6.5 step 3 | — | brain/a2a/a2a_brain.test.ts › blocks a blatant instruction pattern without asking a model (5 rows); › looks inside data keys and values too; › checks the remote’s own name and skill as well as its result; › passes ordinary text the model passes; › reads a fenced JSON answer; › retries an unreadable answer once, then blocks; › holds the result, posting no verdict, when the model cannot be reached (§6.5: an outage holds); › puts everything the remote wrote inside the fence, as data; › claims, scans and posts a digest-bound verdict with its reason code, and stops when none are left; › logs ids, verdicts and codes only, never content; › posts nothing while the model is down, so the result stays held for the next try; › never rejects: a verdict Core could not take is logged, and the claim lapses; › a fault outside every Core call is caught at the tick, logged, and the tick resolves; › stops the tick when Core cannot be reached; › a timer tick that fails never surfaces as an unhandled rejection; › asks the guard_scan route at temperature 0 and returns its answer; › throws when the router cannot answer, so the scan holds instead of blocking |
| B220 | Brain delivers only from Core's A2A events, to the asking conversation | A2A-I7 | — | brain/a2a/a2a_delivery.test.ts › says nothing for the workflow’s own completed event: only Core’s A2A events speak (and 4 rows); › skips the workflow’s own completed event on the dispatch child: no generic bubble, no second message (and 3 rows); › recognizes A2A tasks by their Core-minted payloads only; › delivers the released result once, with its conversation; › delivers an ending in Dina’s words; › delivers an ending on the consent card, before any dispatch child exists; › skips the consent card’s approved event: the dispatch path, not the chat, acts on it; › skips an A2A event kind on a task that is not an A2A dispatch; › backs off, unacknowledged, when Core cannot be read |
| B221 | Delivery wording | notes | — | brain/a2a/a2a_delivery.test.ts › quotes a released result, text and data; › says nothing for a released event whose result is not there; › says nothing for an ending event whose operation has not ended; › describes a held answer without claiming nothing looked at it; › clips a long result for the bubble |
| B222 | Injection held end to end | §6.5 | — | core-server/a2a/reference_agent.e2e.test.ts › holds back a result that tries to instruct Dina |

### Outbound connection policy (§6.6)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B223 | HTTPS only, no userinfo, no literal IP in any spelling, no fragment | §6.6 | url_refused, no transport call | core/a2a/remote_agents.test.ts › refuses http://agent.example/x (not_https) before any transport sees it (and 5 rows); net-node/a2a_host_transport.test.ts › by literal: a literal address never reaches resolution; › refuses a URL with http before resolving (and 2 rows) |
| B224 | Name resolving to loopback | §6.6 | no connection | net-node/a2a_host_transport.test.ts › by name: a name that resolves to loopback is refused before connecting |
| B225 | Metadata, mapped loopback, 0.0.0.0, ::, link-local, CGNAT, RFC 1918, empty or non-address answer | §6.6 | no connection | GAP for these answers → probed (held) |
| B226 | Mixed public/private answer | §6.6 | refused | net-node/a2a_host_transport.test.ts › by a mixed answer: one private address among public ones refuses the name |
| B227 | DNS answer that changes between lookups | §6.6 | pinned | net-node/a2a_host_transport.test.ts › by a changing DNS answer: the name is resolved once and the socket pinned to that answer |
| B228 | Next vetted address only before anything was sent | notes | — | net-node/a2a_host_transport.test.ts › tries the next vetted address when one cannot be reached, and only before anything was sent |
| B229 | 6to4, Teredo, 198.18/15 answers | §6.6 | (documented) | GAP → probed: not blocked (no finding: not private/link-local/loopback in the design's terms) |
| B230 | SNI and Host carry the original name; POST JSON; GET card | §6.6 | — | net-node/a2a_host_transport.test.ts › POSTs JSON to the vetted address with the original name as SNI and Host; › GETs a card with no body |
| B231 | Non-2xx JSON returned | notes | — | net-node/a2a_host_transport.test.ts › returns a non-2xx JSON answer as it is (JSON-RPC errors may ride one) |
| B232 | No redirects (RPC and webhook) | §6.6 | redirect_refused | net-node/a2a_host_transport.test.ts › never follows a redirect; › a redirect still fails: a push is never sent on |
| B233 | Compressed, oversize, non-UTF-8 | §6.6 | refused | net-node/a2a_host_transport.test.ts › refuses a compressed answer it did not ask for; › stops reading at the byte cap; › refuses a body that is not UTF-8 |
| B234 | Non-JSON content type | §6.6 "JSON responses only" | bad_content_type | GAP → probed (held) |
| B235 | 401/403 body never read | §5.3 as built | status only | GAP → probed (held) |
| B236 | Timeouts; slow-drip body | §6.6 | timeout, possibly sent | net-node/a2a_host_transport.test.ts › times out a silent server, and says the request may have been sent; slow drip GAP → probed (held) |
| B237 | TLS failures and connect failures report nothing sent | notes | sent false | net-node/a2a_host_transport.test.ts › refuses a certificate that does not name the host; › refuses a certificate no trusted CA issued; › reports a refused connection; › reports a name that does not resolve |
| B238 | Core holds its own deadline; a throwing transport counts as possibly sent | notes | — | core/a2a/remote_agents.test.ts › holds its own deadline: a transport that overruns it answers timeout, possibly sent; › treats a transport that throws as having possibly sent |
| B239 | Webhook push: status only, private address refused | §6.6 | — | net-node/a2a_host_transport.test.ts › POSTs the A2A media type and returns the status, never the body; › a compressed or oversized answer does not matter: the body is not read; › a webhook that resolves to a private address gets no connection |
| B240 | A caller-supplied Host header | §6.6 "Host" | (documented) | GAP → probed: transport passes it through; no caller can set it (credential header names refuse `host`, webhook headers are fixed) — no finding |

### Brain-compromise limits (§10, A2A-I11)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B241 | Forge payloads, lanes, ids, keys | §10 | 400 | core/a2a/brain_compromise.test.ts › refuses a task on an A2A lane (400) (and the 4 other rows) |
| B242 | Reach owner routes or credential doors | §10 | 403 | core/a2a/brain_compromise.test.ts › cannot reach the owner’s A2A routes; › cannot reach the owner’s credential doors |
| B243 | Forge provenance or cite another conversation | §10, A2A-I12 | refused | core/a2a/brain_compromise.test.ts › cannot prove text out of fragments of the owner’s words; › cannot cite a release from another conversation |
| B244 | A prompt-injected model cannot launder through a vault item (notes' claim in provenance.ts) | A2A-I12, notes | never proves | GAP → probed (VIOLATED, finding B-F1) |
| B245 | Compromised Brain is the guard (residual) | §6.5 | stated | (design residual; no test) |

### Server-only Lane 1 (the phone refuses; plan §3.20, D6)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B246 | No host transport | §1.3 | unavailable | core/a2a/remote_agents.test.ts › answers unavailable when no host transport is installed (the phone, D6) |
| B247 | No Lane 1 runtime | §1.3 | 503 | core/a2a/routes.test.ts › answers 503 while no host has installed Lane 1 (the phone) |
| B248 | Runner idle without runtime | §1.3 | — | home-node/a2a_runner.test.ts › does nothing while Lane 1 is not available |
| B249 | Phone gets no A2A tools | notes | — | GAP → probed (held, B70) |
| B250 | Phone decides cards it can show; runtime follows the current service | plan §3.20 | — | core-server/phone_approval_sync.test.ts › mirrors the card with every byte that would be sent; core/a2a/routes.test.ts › pairs the installed store with whichever service is set, and throws on one on another connection |

### The ingress move (plan §4.2a, design §6.3)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B251 | Parity corpus: auto path, schema-hash rules, params, stripping, review path, notifiers, service_uri, rkey listing, Tier 1, reasoning, plugin plane | §4.2a | unchanged outcomes | core/service/query_ingress.test.ts (73-case corpus, e.g. › creates a delegation task with the canonical payload; › GAP-SH-01: rejects missing schema_hash when provider has published a hash; › creates an approval task (not delegation) for review-policy capability; › BRAIN-P4-T06: calling executeAndRespond twice yields exactly one successful delegation; › dispatches an auto-policy plugin capability to its install) |
| B252 | Brain cannot create service cards or executions | §4.2a | reserved_payload_type | core/a2a/lane_reservation.test.ts › refuses a brain a service card or execution: only Core’s service-query ingress mints them (agent, admin, owner rows) |
| B253 | Create route refuses dina.local to every caller | §6.3 | reserved_runner | core/a2a/lane_reservation.test.ts › refuses a brain a Tier 1 task on dina.local: Core’s service-query ingress fills that lane (plan §4.2a) (and 3 rows) |
| B254 | Approved card runs only against the live listing | notes (review) | lane/tool from listing; gone/paused unavailable; schema change mismatch; params rechecked | core/service/query_ingress.test.ts › takes the lane and the tool from the listing, never from the card; › answers unavailable and closes the card when the listing is gone or paused; › refuses a card whose listing changed its published schema since admission; › checks the card’s params again, and strips what the schema does not declare |
| B255 | Listing naming a reserved lane never runs, cannot be saved | notes | capability_not_executable / reserved_runner_lane | core/service/query_ingress.test.ts › a listing naming the reserved lane dina.local never runs, at admission or after approval (and 3 rows); core/service/service_config.test.ts › refuses an mcpServer naming the reserved lane dina.local (and 3 rows) |
| B256 | Unapproved, denied, expired card starts nothing; non-service card throws | notes | — | core/service/query_ingress.test.ts › starts nothing for a card the owner never approved; › starts nothing for a card the owner denied, or that expired; › throws on a task that is not a service card, so the event is retried and seen; probe (approved non-service card) held |
| B257 | Failed create logged; admitQuery never throws | notes deviation | — | core/service/query_ingress.test.ts › a task create that fails is logged; admitQuery never throws, notifies no one, answers nothing |
| B258 | Built-in object key names resolve to nothing | notes | — | core/service/query_ingress.test.ts › a capability named after a built-in object key resolves to nothing in the registry; probe (__proto__, constructor, hasOwnProperty, valueOf) held |
| B259 | /v1/service/respond answers only a Core-minted service card | notes (review) | not_a_service_card | core/server/core_router_integration.test.ts › POST /v1/service/respond refuses an approval card Core did not mint as a service card |
| B260 | One schema-hash recipe; stored-hash fallback | notes | — | core/service/query_ingress.test.ts › accepts the stored hash and refuses anything else; › canonical-recipe hash is accepted even when the STORED hash is stale (params-only writer heal) |
| B261 | Capability with no plane, or a partial plugin binding | notes | capability_not_executable | core/service/query_ingress.test.ts › a capability with NO execution plane is rejected `capability_not_executable` and creates NO task; › a PARTIAL binding is not a plane; › an EMPTY pluginInstallId is not a plane either (and 2 rows) |

### Four Laws (§11) touch points
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| B262 | Silence First: owner contact only through cards; results to the asking conversation | §11, A2A-I7 | — | brain/a2a/a2a_delivery.test.ts › delivers the released result once, with its conversation |
| B263 | Absolute Loyalty: every delegation approved against the full projection | §11 | — | core/a2a/outbound_lane.test.ts › stages the operation, mints the card, and binds the exact projection by hash |
| B264 | Never Replace a Human: guard before any human sees remote content | §11 | — | core/a2a/outbound_lane.test.ts › keeps a blocked result held, tells the owner neutrally, and never shows the content |

### Gap closure, area B

Every GAP row above, and the completeness critic's scenarios (X-n), with what now holds it.

| Row | Closed by | Test or reason |
|---|---|---|
| B10 | new test | packages/core/__tests__/a2a/lane1_registration.test.ts › never pins an endpoint at a literal IP, with credentials in its URL, or with a fragment |
| B20 | new test | packages/core/__tests__/a2a/lane1_registration.test.ts › never fetches a key set named over plain HTTP, and its signature verifies nothing (also: over a literal IP; over credentials in the URL; and the control › fetches a key set the policy allows, so the refusals above are the policy at work) |
| B24 | new test | packages/core/__tests__/a2a/lane1_registration.test.ts › cleans and bounds the remote’s name and skill names on every surface: the agent, its skills, the consent card and Brain’s list |
| B26 | new test | packages/core/__tests__/a2a/lane1_registration.test.ts › stays uncallable after the card returns to its first form until the owner activates it again |
| B30 | new test | packages/core/__tests__/a2a/lane1_registration.test.ts › walks the full ceremony on the live card, and grants nothing until the owner binds and activates it |
| B36 | new test | packages/core/__tests__/a2a/lane1_registration.test.ts › refuses a credential whose token endpoint uses plain HTTP, stores nothing, and offers the owner no such choice (also: a literal IP; credentials in the URL; a fragment; and the control › accepts a token endpoint the policy allows, so the refusals above are the policy at work) |
| B52 | new test | packages/core/__tests__/a2a/lane1_dispatch.test.ts › voids the permit when the runner built its headers for another credential than the one approved |
| B70 | new test | packages/brain/__tests__/a2a/lane1_brain.test.ts › offers them to an ask that names its conversation on a host with an A2A client, bound to that conversation; › withholds them from a registry that serves no conversation, even with an A2A client |
| B75 | new test | packages/core/__tests__/a2a/lane1_dispatch.test.ts › holds at most 50 cards pending in all, across agents |
| B79 | new test | packages/core/__tests__/a2a/lane1_dispatch.test.ts › takes no approval once it has lapsed: the approve fails, and Core mints nothing and sends nothing |
| B95 | new test | packages/core/__tests__/a2a/lane1_provenance.test.ts › once the first turns pass the 24-hour window, an item written after the oldest turn Core still holds proves nothing |
| B96 | new test | packages/core/__tests__/a2a/lane1_provenance.test.ts › proves only as an item of its own vault saved before this thread, and the card says so; this thread’s own reads decide its taint |
| B120 | new test | packages/core/__tests__/a2a/lane1_provenance.test.ts › the log refuses a release for any other audience, and a read that names one fails, so nothing leaves unlogged |
| B125 | new test | packages/core/__tests__/a2a/lane1_dispatch.test.ts › refuses data nested deeper than the envelope can carry, and stages nothing |
| B139 | new test | packages/core/__tests__/a2a/lane1_dispatch.test.ts › refuses agent callers the approve and the deny; › refuses plugin callers the approve and the deny |
| B140 | existing test | packages/core/__tests__/a2a/outbound_lane.test.ts › Brain cannot decide one (403); the owner can; packages/core/__tests__/a2a/brain_compromise.test.ts › cannot approve the consent card (403) (Structural: brain-server's /api/v1/ask/:id/approve acts only on the ask record's own approvalId and reaches Core as Brain, which Core refuses (403) on an a2a_delegation_consent card. brain-server is not one of the packages this task may add tests to.) |
| B157 | new test | packages/core/__tests__/a2a/lane1_dispatch.test.ts › a lane spelt with upper case, from a device caller, is refused or never reaches the agent’s runner (15 rows: upper case, leading tab, trailing new line, no-break space, zero-width space × device, plugin, brain) |
| B168 | new test | packages/core/__tests__/a2a/lane1_dispatch.test.ts › never sends twice under one claim: a second dispatch after transmitting ends outcome_unknown |
| B169 | new test | packages/core/__tests__/a2a/lane1_dispatch.test.ts › repeated mints and sweeps, across a restart, leave exactly one permit and one dispatch child |
| B179 | new test | packages/home-node/__tests__/lane1_runner.test.ts › a cancel before the runner claims the work sends nothing; › a cancel that lands between the claim and the dispatch transaction sends nothing |
| B181 | new test | packages/home-node/__tests__/lane1_runner.test.ts › a cancel during the send: the message goes once, and CancelTask is the next call |
| B187 | new test | packages/home-node/__tests__/lane1_runner.test.ts › INPUT_REQUIRED met while polling ends the call remote_needs_input, with no second message |
| B188 | new test | packages/home-node/__tests__/lane1_runner.test.ts › UNSPECIFIED: the runner polls again, and the outcome is unknown at the deadline |
| B192 | new test | packages/home-node/__tests__/lane1_runner.test.ts › duplicate members: the outcome is unknown, and Core holds no result (also: a __proto__ member; another JSON-RPC id; a task and a message in one answer) |
| B197 | new test | packages/home-node/__tests__/lane1_runner.test.ts › Core holds a GetTask answer that names another task for the guard, like any answer, and releases nothing unscanned |
| B200 | new test | packages/core/__tests__/a2a/lane1_dispatch.test.ts › refuses a url part, and holds nothing for the guard; › refuses text and data in one part, and holds nothing for the guard; › refuses no parts at all, and holds nothing for the guard |
| B204 | new test | packages/core/__tests__/a2a/lane1_dispatch.test.ts › refuses a result when the schema pinned at consent cannot be read, and never falls back to the default envelope |
| B218 | new test | packages/core/__tests__/a2a/lane1_archive.test.ts › carries no credential secret, no sealed original and no held result, and a restored node holds none of them |
| B225 | new test | packages/net-node/__tests__/lane1_host_transport.test.ts › refuses the cloud metadata address before any socket opens (14 rows incl. mapped loopback in dotted and hex form, ::1, 0.0.0.0, ::, fe80::1, fd00::1, CGNAT, the three RFC 1918 ranges, multicast, a non-address answer); › refuses an empty answer before any socket opens |
| B229 | owed | No rule to hold: the plan judged 6to4, Teredo and 198.18/15 answers outside the design's private/link-local/loopback terms (documented, no finding). A test would only pin what the code does, which this task's rules forbid. |
| B234 | existing test | packages/net-node/__tests__/a2a_host_transport.test.ts › refuses a HTML answer; › refuses a no content type answer |
| B235 | new test | packages/net-node/__tests__/lane1_host_transport.test.ts › returns the status of a 401 and never reads its body, whatever it is; › returns the status of a 403 and never reads its body, whatever it is |
| B236 | new test | packages/net-node/__tests__/lane1_host_transport.test.ts › cuts a server that drips its body past the deadline, and says the request may have been sent |
| B240 | existing test | packages/core/__tests__/a2a/credentials.test.ts › refuses a header the transport owns (The plan's own reading: no caller can set Host (the credential test uses a Host-named api-key scheme); webhook headers are fixed.) |
| B244 | existing test | packages/core/__tests__/a2a/provenance.test.ts › refuses an item written during the conversation (Brain could have written it from what it read) (As the verifier read it, the provenance.ts claim is this rule: an item written during the conversation never proves. Cross-thread and 24-hour cases are B95/B96 above.) |
| B249 | new test | packages/brain/__tests__/a2a/lane1_brain.test.ts › withholds every A2A tool on a host with no A2A client (the phone), whatever the conversation |
| B258 | new test | packages/core/__tests__/a2a/lane1_ingress.test.ts › a capability named __proto__ resolves to nothing in the registry, and the query runs as its listing says (also hasOwnProperty, valueOf, toString, isPrototypeOf) |
| X-1: Two-node run: Dina A's Lane 1 calls Dina B's Lane 2 gateway; INPUT_REQUIRED from B ends A's call remote_needs_input | new test | apps/home-node-lite/core-server/__tests__/lane1_two_node.test.ts › registers B’s signed live card, calls it with B’s bearer once A’s owner approves, and A’s guard releases B’s answer into the chat that asked; › a question from B (INPUT_REQUIRED) ends A’s call remote_needs_input, and A sends nothing more |
| X-2: Shape of every outbound call: A2A-Version 1.0 header, and the pinned tenant in params | new test | packages/home-node/__tests__/lane1_runner.test.ts › SendMessage, GetTask and CancelTask each carry A2A-Version 1.0 and the pinned tenant; › sends no tenant when the pinned interface names none |
| X-3: Owner cancels after dispatch; remote CancelTask times out or answers a transport error | new test | packages/home-node/__tests__/lane1_runner.test.ts › a CancelTask that times out never reads as cancelled: polling goes on to the remote’s real end; › a CancelTask that cannot reach the remote never reads as cancelled: the outcome is unknown at the deadline |
| X-4: Lane 1 logs: runner, host transport, guard job routes and Core's Lane 1 routes log ids, states and codes only | new test | packages/home-node/__tests__/lane1_runner.test.ts › logs ids, states and codes only: no message text, original, result, secret or remote text; packages/net-node/__tests__/lane1_host_transport.test.ts › writes no request text, credential, or remote answer to the console or the process streams; packages/core/__tests__/a2a/lane1_logs.test.ts › the owner, Brain and guard routes log no secret, no owner words, no original and no remote text |
| X-5: Server delivery path: the same A2A event id arrives twice | new test | packages/brain/__tests__/a2a/lane1_brain.test.ts › one event delivered again after a crash before its acknowledgement, and again after a restart, makes one chat message in the thread that asked |
| X-6: Registration from a search_a2a_agents candidate: review shows PeerLens score and band; agent stays a candidate until bound and activated | new test | packages/core/__tests__/a2a/lane1_registration.test.ts › walks the full ceremony on the live card, and grants nothing until the owner binds and activates it |
| X-7: find_person called inside a conversation hands the model no vault excerpt | new test | packages/brain/__tests__/a2a/lane1_brain.test.ts › hands the model no vault excerpt through Core’s people backend either, so no release goes unlogged |
| X-8 (save and server publisher): listing schema with no canonical JSON form | existing test | packages/core/__tests__/service/service_config.test.ts › refuses a schema with no canonical JSON form; apps/home-node-lite/core-server/__tests__/service_publication_supervisor.test.ts › a schema with no canonical form is a recorded failure, never a crash, and a fixed listing publishes |
| X-8 (phone start()): skips the listing with an owner-visible warning; network and identity failures still fail start() | owed | Needs the phone: the code is apps/mobile/src/services/bootstrap.ts (start(), PublisherConfigError branch), outside the packages this task may add tests to; no test exists for it there either. |
| X-9: What a remote agent receives carries no internal id | new test | packages/home-node/__tests__/lane1_runner.test.ts › gets a fresh UUID messageId and no workflow, operation, permit, claim, credential or vault id |
| X-10: Export and restore of A2A secrets and sealed originals | new test | packages/core/__tests__/a2a/lane1_archive.test.ts › carries no credential secret, no sealed original and no held result, and a restored node holds none of them; › a persona exported on its own takes none of its sealed spans |

---

## Area C — Lane 2 inbound gateway, streams and push (M2, M3)

How to read the Test column: `path › exact test title`. GAP means no existing test holds the scenario; the note says what the probe showed (held / VIOLATED, with the finding id) or why it was not probed. Paths are relative to the repo root.

### C-I. The gateway process: keys, config, isolation (design §4.1; plan §3.14, §3.18; notes M2, M2 preconditions)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C1 | Gateway key is its own random 32-byte seed, checked against the registered DID at boot | §4.1 no keys; notes M2 (own random seed, index 3 reserved) | loads; refuses a missing dir or file, or a wrong size | apps/home-node-lite/a2a-gateway/__tests__/boot_parts.test.ts › loads a 32-byte seed and checks it against the registered DID; › refuses a missing directory, a missing file, and a wrong size |
| C2 | keygen creates the key once, mode 0600; refuses to overwrite a non-key | §4.1 | key file 0600, stable DID | apps/home-node-lite/a2a-gateway/__tests__/boot_parts.test.ts › creates the key once, mode 0600, and prints the same DID on every run; › refuses to replace a key file that is not a key |
| C3 | Loopback default, port 8400 (never 8300), Core 8100, 120 calls per IP per minute | plan D5, §3.14; notes M2 | defaults as stated | apps/home-node-lite/a2a-gateway/__tests__/boot_parts.test.ts › defaults to loopback on 8400, Core on 8100, 120 calls per address per minute |
| C4 | Config refuses a key path with `..`, a non-did:key DID, a bad port, a zero edge limit | §4.1 | ConfigError | apps/home-node-lite/a2a-gateway/__tests__/boot_parts.test.ts › refuses %s |
| C5 | TRUST_PROXY is a hop count; `true`, 1.5, -1, 9 refused at boot | notes M3 (proxy) | refused | GAP — probed (loadConfig): held |
| C6 | Client-written X-Forwarded-For entries never set the client's address | notes M3 | only trusted hops count | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › trusts only the hops it is told: an entry the client wrote cannot change its address |
| C7 | Own container, UID 10003, read-only root, cap_drop ALL, own key volume, a network shared with Core only (not Brain, not the vault) | §4.1 precondition (a); plan §3.18 | as configured | GAP — no automated test; checked by reading docker-compose.lite.yml (a2a-gateway service, `dina-a2a` network) and Dockerfile.a2a-gateway:57-67 |
| C8 | A native install that runs the gateway as Core's user does not meet the precondition | §4.1; notes | README warns not to open the port | GAP — documentation only, not testable |
| C9 | Gateway keeps no durable state beyond live streams | §4.1 | restart loses only open streams | GAP — structural; covered indirectly by C188 (delivery state lives in Core) |

### C-II. What the gateway forwards, and what it answers itself (§4.1, §5.1, §7.2 steps 1–4; notes M2, M3, M4 REST)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C10 | Forwards the raw body byte for byte, the bearer and version, to the route the body names | §4.1 "carries bytes, decides nothing" | exact bytes, right route | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › forwards the raw body, the client’s bearer and version, to the route the body names; › keeps whitespace and member order exactly, and passes the query through |
| C11 | Passes a DID-signed client's four headers as they came | §5.1 | passed through untouched | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › passes a DID-signed client’s four headers through as they came (M4) |
| C12 | Answers parse errors, duplicate members, unknown methods and a missing task id itself, never forwarded | notes M2 | JSON-RPC error, nothing forwarded | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › %s (in "answered at the gateway, never forwarded") |
| C13 | A notification (no id) runs nothing | JSON-RPC 2.0 | 204 | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › runs nothing for a notification |
| C14 | Body over 256 KB → 413; unread content type → 415; a charset parameter is accepted | §7.2 step 3 | as stated | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › refuses a body past 256 KB, and a body that is not JSON; › accepts JSON with a charset parameter |
| C15 | A JSON-RPC batch (an array) is answered at the gateway, never forwarded | strict parse | -32600, nothing forwarded | GAP — probed: held |
| C16 | A `__proto__` member is refused at the gateway (`forbidden_member`), never forwarded | §5.1 strict I-JSON | -32600 | GAP — probed: held |
| C17 | GET on /a2a/v1, or a POST to a Core route path, is a gateway 404, never forwarded | §4.1 allowlist | 404 | GAP — probed: held |
| C18 | Per-IP edge limit with retry-after, JSON-RPC and REST | §4.1 | 429 past the minute's budget | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › limits calls per address per minute; › the edge limit holds for REST too |
| C19 | The edge limiter's memory is bounded | §4.1 | stops tracking at its cap | apps/home-node-lite/a2a-gateway/__tests__/boot_parts.test.ts › stops tracking past its cap rather than growing without bound |
| C20 | Only answers Core's ingress handler marked are relayed; anything else is 503 | notes M2 review (x-dina-a2a-answer) | 503 | apps/home-node-lite/a2a-gateway/__tests__/boot_parts.test.ts › only answers Core’s ingress handler marked as written for the client; apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › answers 503 when Core does not answer for the client |
| C21 | Only `www-authenticate` and `retry-after` are relayed (fake link) | notes M2 | nothing else | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › relays Core’s challenge and slow-down headers, and nothing else |
| C22 | Through the real Core link: the event cursor, cookies, internal headers and the answer marker never reach the client | notes M3 ("the gateway never relays the header") | stripped | GAP — probed (real createCoreLink, fake Core HTTP at the edge): held |
| C23 | Logs carry method, status and latency, never a body, bearer or task id | §12 "no PII in gateway logs" | no secrets in logs | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › never carry a body, a bearer or a task id |
| C24 | The DID-binding door forwards the body as it came, with no credential | §5.1, notes M4 | forwarded to Core's door | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › forwards a DID binding to Core’s binding door, the body as it came and no credential |
| C25 | REST paths go to their operation's Core route; 405 lists allowed methods; errors as google.rpc.Status | plan §4.5 REST | as stated | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › %s %s goes to its operation’s Core route, the request as sent; › answers %s as google.rpc.Status, as the SDK expects; › answers %s on a REST path with 405 and the methods served; › relays Core’s REST answer as it came: status, headers, body; › keeps the plain answers off REST paths; › a Core it cannot reach is 503 UNAVAILABLE; apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › errors are google.rpc.Status with A2A’s HTTP mapping |

### C-III. The public card and its key set (§7.1, §7.6; plan §3.13, §3.22; notes M2)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C26 | The gateway caches the card for 30 s, serves it cross-origin, as canonical bytes; 503 while Core has none | notes M2 tradeoff | as stated | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › serves Core’s card and key set, cached for 30 seconds, readable cross-origin; › serves the card’s canonical bytes, whatever order Core’s object has; › answers 503 while Core has no card to give |
| C27 | Unauthenticated access: only the card (with its JWKS and health) | §5.1 | every A2A method needs a credential | packages/core/__tests__/a2a/inbound.test.ts › answers 401 for no bearer, a wrong one, and a revoked client; packages/core/__tests__/a2a/extended_card.test.ts › requires the client’s credential (401 without it) |
| C28 | Projects a bound lane and an instruction-only capability; validates as a v1.0 card; flags true at M3 | §7.1 | valid v1.0 card | packages/core/__tests__/a2a/inbound_card.test.ts › projects a bound lane and an instruction-only capability; validates as a v1.0 card |
| C29 | Unlisted, known_only, paused and Talk listings are left out entirely | §7.1 | absent | packages/core/__tests__/a2a/inbound_card.test.ts › leaves out %s entirely |
| C30 | Commerce, schema-less, reserved-lane, unbound and non-public capabilities are left out | §7.1, plan D2 | absent | packages/core/__tests__/a2a/inbound_card.test.ts › leaves out commerce, schema-less, reserved-lane, unbound and non-public capabilities, whatever a row says |
| C31 | A revoked runner binding drops the skill and moves the card version | §7.1 | skill gone | packages/core/__tests__/a2a/inbound_card.test.ts › drops a skill when its runner binding is revoked, and the version moves with it |
| C32 | A plugin whose declared class differs (booking/payment under a read name) is no executor: off the card, refused on call | §5.4, §7.3 | absent and refused | packages/core/__tests__/a2a/inbound.test.ts › under a read name, %s is no executor: off the card, refused on call |
| C33 | ES256 JWS verifies under the jku key set, kid is the thumbprint; a changed card fails; the key is the frozen D4 key | §7.1, plan D4 | verifies / fails | packages/core/__tests__/a2a/inbound_card.test.ts › verifies under the key its jku serves, named by its thumbprint; › a change to the card after signing fails verification; › the key is the frozen ES256 card key of the seed; apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › reads a signed card that verifies under the key set the gateway serves |
| C34 | Usable without the extension: every standard-field example is a call Core accepts | §7.6 | accepted | packages/core/__tests__/a2a/inbound_card.test.ts › every skill’s standard-field example is a call Core accepts; apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › calls a skill from the card’s own example, and reads the result once the runner answers |
| C35 | The public origin comes from Core's config: no path, credentials or plain http off loopback; the card route serves the gateway only | notes M2 | refused / 403 | packages/core/__tests__/a2a/inbound_card.test.ts › refuses an origin with a path, credentials, or plain http off loopback; › serves the gateway only, and says when the card is not configured |
| C36 | The same rule decides projection and invocation in every access mode | §7.3 | a skill no card shows cannot be called | Partly: packages/core/__tests__/a2a/inbound.test.ts › under a read name, %s is no executor: off the card, refused on call. GAP for the grant door — probed: VIOLATED (F3) |

### C-IV. The Core ↔ gateway trust boundary (A2A-I2, §4.3, §5.1, §10 "Compromised gateway")
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C37 | The gateway role's authz rows are exactly the allowlist | §4.3 | nothing else opens | packages/core/__tests__/a2a/gateway_routes.test.ts › opens POST %s to the gateway and no one else; › opens nothing else to the gateway |
| C38 | A caller other than the gateway is refused in the handler too | §4.3 | 403 | packages/core/__tests__/a2a/gateway_routes.test.ts › registers a route for every A2A method; a caller other than the gateway is refused in the handler too |
| C39 | The gateway's key opens no other Core route | §4.1 | 403 | apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › the gateway’s key opens no other Core route |
| C40 | A gateway Core never registered gets nothing (unknown service fails closed) | §4.3 mapToAuthzRole | client sees 503 | apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › a gateway Core never registered gets nothing through, and the client sees only 503 |
| C41 | A body for one operation sent to another operation's route is refused | §5.1 dispatch binding | invalidRequest | apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › a gateway that sends a body to another operation’s route is refused by Core; packages/core/__tests__/a2a/inbound.test.ts › refuses a body the gateway sent to the wrong door, and one that is not JSON-RPC |
| C42 | A body for one task sent to another task's route is refused | §5.1 | id_mismatch | apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › a body for one task sent to another task’s route is refused by Core; packages/core/__tests__/a2a/inbound.test.ts › a task body for one id sent to another id’s route is refused |
| C43 | Push-config routes bind both the task id and the config id to the signed body | §5.1 total mapping | id_mismatch, nothing changed | GAP — probed (Get, Delete, Create with swapped ids): held |
| C44 | An envelope changed after the gateway signed it is refused | §5.1 | 401 | apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › an envelope changed after the gateway signed it is refused |
| C45 | The signed query may carry only A2A-Version; as a request parameter it stands for the header | §5.1, spec §3.6 | other queries refused | GAP at the ingress path — probed: held |
| C46 | Strict I-JSON at Core: duplicate members, `__proto__`, lone surrogates, array params | §5.1 | refused before any state | duplicates: packages/core/__tests__/a2a/inbound.test.ts › refuses a body the gateway sent to the wrong door, and one that is not JSON-RPC; the rest GAP — probed: held |
| C47 | A bearer and a DID signature together are refused | §5.1, notes M4 | 401 | GAP — probed: held |
| C48 | A gateway cannot mint a principal: an unknown bearer is 401 | §4.1 compromise model | 401 | packages/core/__tests__/a2a/inbound.test.ts › answers 401 for no bearer, a wrong one, and a revoked client |
| C49 | Residual: a captured bearer replays until rotation; rotation ends it at once | §4.1, §5.1 | old token refused | packages/core/__tests__/a2a/clients.test.ts › rotation ends the old token in the same commit and keeps the history |
| C50 | The shared signature check never throws on malformed parts | notes M2-pre round 2 | refusal, no 500 | packages/core/__tests__/auth/signed_request.test.ts › accepts a good signature; › refuses %s without throwing |

### C-V. Rate limits and budgets (§4.1, §7.2 step 6, §10 "replay floods")
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C51 | Core's per-address limiter skips the gateway's routes with Lane 2 on, and only those | §4.1 | >60/min pass; others counted | apps/home-node-lite/core-server/__tests__/a2a_gateway_limits.test.ts › with Lane 2 on, %s %s passes more than 60 calls a minute; › with Lane 2 off, the same routes are counted; › with Lane 2 on, a route the gateway does not serve stays counted |
| C52 | The gateway's DID is exempt from the per-DID bucket (boot wiring) | §4.1 | never 429 from Core's DID limiter | Unit only: packages/core/__tests__/auth/ratelimit.test.ts › exempts a DID whose ceiling is infinite. Boot wiring GAP — probed (real bootServer, 75 signed calls at the 60/min default): held |
| C53 | More than 60 aggregate new calls from distinct principals at production defaults | §4.1, §12 M2 | all accepted | packages/core/__tests__/a2a/inbound.test.ts › seventy clients calling once each all get through at production defaults |
| C54 | New calls: 60 per principal per minute, own budget, refills | §7.2 step 6 | 429 past budget | packages/core/__tests__/a2a/receipts.test.ts › spends a principal’s own budget only, and refills after a minute |
| C55 | Replays answered under a 10x ceiling, transient 429 beyond | §4.1 | 429 after 600 | packages/core/__tests__/a2a/inbound.test.ts › replays stop at the production ceiling, ten times the new-call budget; packages/core/__tests__/a2a/receipts.test.ts › counts replays apart, under a ceiling ten times the budget |
| C56 | Reads (GetTask, ListTasks, CancelTask) spend a 600/min budget, per client | notes M2 review | one client cannot slow another | packages/core/__tests__/a2a/inbound.test.ts › one client polling past its read budget does not slow another |
| C57 | Push-config Create spends the new-call budget; Get/List/Delete the read budget | notes M3 | 429 on Create past budget, reads pass | GAP — probed: held |
| C58 | Budget memory is bounded (10,000 principals) | receipts.ts | quietest dropped | GAP — probed: held (a dropped principal starts afresh, by design) |

### C-VI. Ingress steps 1–4: protocol errors with no durable state (§7.2)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C59 | No bearer, a wrong one, a revoked client → 401, nothing stored | §7.2 step 1 | 401 + challenge | packages/core/__tests__/a2a/inbound.test.ts › answers 401 for no bearer, a wrong one, and a revoked client |
| C60 | Expired bearer (90 days) → refused | §5.1 | 401 | packages/core/__tests__/a2a/clients.test.ts › refuses an expired token, and a revoked client’s |
| C61 | Header forms: missing, Basic, short, unknown; the scheme is case-insensitive | §5.1 | refused / accepted | packages/core/__tests__/a2a/clients.test.ts › refuses %j as %s; › accepts the live token, case-insensitive scheme, and resolves the principal |
| C62 | Over 256 KB at Core → 413 | §7.2 step 3 | 413 | packages/core/__tests__/a2a/inbound.test.ts › answers 413 past 256 KB |
| C63 | Version 1.0 and 1.0.1 accepted; empty (0.3), 0.3, 1.1, 2.0, 1 refused -32009 | §2 item 9 | as stated | packages/core/__tests__/a2a/inbound.test.ts › speaks A2A 1.0 only; › speaks version %s; › refuses version %j |
| C64 | An agent-role message is refused; an answer to a task not owned is TaskNotFound | §7.2 step 4 | -32602 / -32001 | packages/core/__tests__/a2a/inbound.test.ts › refuses %s |
| C65 | Envelope: several data parts → protocol error, no receipt | §7.2a | -32602 | packages/core/__tests__/a2a/inbound.test.ts › refuses a malformed envelope as a protocol error (raw/url/zero-data parts held by the @dina/a2a M0 envelope vectors) |
| C66 | More than 16 parts → protocol error, no state | §7.2 step 3 | too_many_parts | GAP — probed: held |
| C67 | Empty contextId → invalid params, no state | §2 item 6 | -32602 | GAP — probed: held |

### C-VII. Idempotency receipts (§7.2 step 5, §10 "Message mutation")
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C68 | Same call → same task; same message id with another request → conflict, nothing changed | §7.2 step 5 | replay / message_id_reused | packages/core/__tests__/a2a/inbound.test.ts › the same call returns the same task; a reused message id with another request is refused; packages/core/__tests__/a2a/receipts.test.ts › a miss, then the same call replays, and a different request under the same id conflicts |
| C69 | Receipts keyed by principal and operation | §9 | independent per client | packages/core/__tests__/a2a/receipts.test.ts › keys by principal and operation too |
| C70 | Receipt checked before the rate limit: a replay is served after the new-call budget is spent | §7.2 step 5 | 200 | packages/core/__tests__/a2a/inbound.test.ts › new calls spend the principal’s budget; replays are answered under the ceiling |
| C71 | A refused call replayed returns the same REJECTED task, nothing added | §7.2 step 8 | same id | GAP — probed: held |
| C72 | The streaming and plain doors share one key | notes M3 | one task | packages/core/__tests__/a2a/streams.test.ts › shares one idempotency key with SendMessage: the same call through either door is one task |
| C73 | A replay whose inline webhook differs is a conflict; no config is added | §10 | message_id_reused | GAP — probed: held |
| C74 | Receipts purge with their operation | notes M2 | gone after 30 days | packages/core/__tests__/a2a/inbound.test.ts › an ended call purges 30 days on, with its child and its receipt; an open one stays |
| C75 | Two concurrent calls with one message id make one task | §9 PRIMARY KEY | one task | GAP — not probed: the handler is synchronous over one SQLite connection and the receipt key is the primary key; it cannot race without mocking |

### C-VIII. Resolution, access modes, action registry, grants (§5.1, §5.2, §5.4, §7.2 steps 7–8, §7.2a)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C76 | Registry first: custom, commerce and unknown capabilities refused | §5.4 | refused before listings are read | packages/core/__tests__/a2a/inbound_resolve.test.ts › %s → %s |
| C77 | payment class denied at invocation, aliases resolved first | §5.4 | REJECTED | packages/core/__tests__/a2a/inbound.test.ts › under a read name, %s is no executor: off the card, refused on call (plus @dina/a2a M0 registry vectors) |
| C78 | A bare name resolves among public listings only; two → ambiguous; none → unknown | §7.2a | as stated | packages/core/__tests__/a2a/inbound_resolve.test.ts › a bare capability resolves to the one public listing, alias-aware; › two public listings make a bare capability ambiguous; none makes it unknown |
| C79 | Talk, paused and draft listings never resolve | §7.2 | refused | packages/core/__tests__/a2a/inbound_resolve.test.ts › never resolves a Talk, paused or draft listing |
| C80 | Unlisted by exact reference only, under either policy | §7.2 step 7 | bare name never reaches it | packages/core/__tests__/a2a/inbound.test.ts › an unlisted listing answers a call by exact reference only, under either policy |
| C81 | Unlisted by exact reference ignores scope | §5.1 | passes | packages/core/__tests__/a2a/inbound_resolve.test.ts › unlisted by exact reference passes whatever the scope |
| C82 | known_only only through this client's live grant | §5.2 | REJECTED without it | packages/core/__tests__/a2a/inbound.test.ts › a known_only skill needs this client’s grant; packages/core/__tests__/a2a/inbound_resolve.test.ts › known_only only through this client’s live grant |
| C83 | Another client's grant is no door; scope narrows public skills only | §5.1 | REJECTED | packages/core/__tests__/a2a/inbound.test.ts › scope narrows public skills only; a grant is its own door |
| C84 | Scope decides public skills; an empty scope is every public skill | §5.1 | as stated | packages/core/__tests__/a2a/inbound_resolve.test.ts › public: the client’s scope decides; empty scope is every public skill |
| C85 | A grant on a public listing opens nothing the scope refuses (bare name or `cap@rkey`) | notes M3; §7.3 | REJECTED both ways | GAP — probed: VIOLATED (F3): `cap@rkey` + grant REJECTED, bare name + same grant SUBMITTED |
| C86 | A grant for one capability opens no other capability on its listing, nor its capability on another listing | §5.2 | REJECTED | GAP — probed: held |
| C87 | An expired grant opens nothing | §5.2 | REJECTED | GAP — probed: held |
| C88 | A revoked grant refuses the next call | §5.2 | REJECTED | GAP — probed: held |
| C89 | A Talk listing is unreachable even with a grant; issuance refuses non-services | §5.2, §1.3 | REJECTED / refused | packages/core/__tests__/a2a/inbound.test.ts › a Talk listing is unreachable, even with a grant; packages/core/__tests__/a2a/clients.test.ts › refuses a Talk listing, and a revoked client |
| C90 | A capability never public-exposable is refused on a public listing, named or bare | taxonomy §3, notes M2 | REJECTED | packages/core/__tests__/a2a/inbound.test.ts › a capability the catalog never allows in public is refused on a public listing, named or bare |
| C91 | mcpServer lane executes only with a live runner binding, whose device is the PEP | §7.3 | pinned PEP | packages/core/__tests__/a2a/inbound_resolve.test.ts › an mcpServer lane runs only with a live runner binding, and pins its device as the PEP |
| C92 | Instruction-only runs in process; a reserved lane or unsound plugin runs nowhere | §7.3 | as stated | packages/core/__tests__/a2a/inbound_resolve.test.ts › an instruction and no mcpServer runs in-process; a reserved lane or an unsound plugin binding runs nowhere |
| C93 | The reasoning submitter is never A2A's executor, by name or by reference | §7.3 | in process | packages/core/__tests__/a2a/inbound.test.ts › with D2D’s reasoning submitter wired, instruction-only calls by bare name and by reference stay in process; › an instruction-only capability runs in process; it is never handed to a reasoning backend |
| C94 | An unbound lane and a schema-less capability have no executor | §7.1, §7.3 | REJECTED | packages/core/__tests__/a2a/inbound.test.ts › a lane with no runner binding, and a schema-less capability, have no A2A executor |
| C95 | contextId is never a grant | §5.2 | no authority from contextId | GAP — not probed: no code path reads contextId for authority (read inbound_resolve.ts) |

### C-IX. Refusals (A2A-I4)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C96 | Steps 7–9 refusals: durable rejected op + receipt, internal_id NULL, no child | §7.2 step 8 | one transaction | packages/core/__tests__/a2a/inbound.test.ts › %s (in "refusals (steps 7–9)") |
| C97 | Every refusal looks the same from outside | A2A-I4 | identical shape | packages/core/__tests__/a2a/inbound.test.ts › every refusal looks the same from outside |
| C98 | One timing class across refusal causes | A2A-I4 | same order of time | GAP — probed: held (medians 0.33–0.37 ms over five causes) |
| C99 | A refused call records no event | notes M3 | none | packages/core/__tests__/a2a/delivery.test.ts › a refused call records nothing: its REJECTED answer was the whole story |
| C100 | A refused streaming call opens and ends with REJECTED | notes M3 | one event | packages/core/__tests__/a2a/streams.test.ts › a refused call still opens (and at once ends) its stream with REJECTED |

### C-X. Normalization, snapshot and commit (§7.2 step 9, §9)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C101 | A public read on a bound lane: SUBMITTED, child pinned, no permit | §7.2 step 9 | as stated | packages/core/__tests__/a2a/inbound.test.ts › a public read on a bound lane: SUBMITTED, the child pinned to the runner, no permit |
| C102 | Effectful: owner card; approval mints a permit bound to the post-hash and the PEP | §7.3 | permit bound | packages/core/__tests__/a2a/inbound.test.ts › an effectful call waits for the owner; approval mints a permit bound to the post-normalization hash and the runner |
| C103 | A booking row saying `auto` still goes to the owner | notes M2 | review | packages/core/__tests__/a2a/inbound.test.ts › a booking row saying auto still goes to the owner: the validator’s rule holds at call time |
| C104 | Invalid params, a wrong schema hash → REJECTED | §7.2 step 9 | REJECTED | packages/core/__tests__/a2a/inbound.test.ts › %s (in "refusals (steps 7–9)") |
| C105 | One commit across the A2A and workflow stores | §7.2 step 9 | both or neither | packages/core/__tests__/a2a/store.test.ts › commits both or neither |
| C106 | Migration: tables, revision column, no workflow_tasks rebuild, fresh and upgrade | §9 | as stated | packages/core/__tests__/a2a/store.test.ts › creates every A2A table (M1a v53, M1b v54–v55, M2 v56, M3 v57, M4 v58, M5 v59) with foreign keys on; › upgrades a v52 install without touching existing workflow rows; › no migration drops or renames a table another table references by foreign key |
| C107 | Config drift between acceptance and claim → stale_authority | §7.2 step 9 | refused claim | packages/core/__tests__/a2a/inbound.test.ts › a listing changed between acceptance and claim refuses the claim as stale authority; › a claim after the listing changed fails the call; the runner gets nothing |
| C108 | read → booking reclassification → stale_authority | §7.2 step 9, §12 M2 | refused | packages/core/__tests__/a2a/inbound.test.ts › a catalog change between acceptance and claim voids the call as stale authority; › moves when a capability is reclassified (read → booking), and with nothing else |
| C109 | A runner-binding write between acceptance and claim voids the call | §9 (binding writes bump revision) | stale_authority | GAP end to end — probed (rebind the lane): held |
| C110 | A plugin-update rebind voids a pinned inbound call | §9 named test | stale_authority | Revision bump only: packages/core/__tests__/service/config_revision.test.ts › a plugin-update rebind bumps the listings it rewrites, and only those. End to end GAP — probed: held |

### C-XI. Execution, PEP-bound permits, claim tokens (§7.3, §10 "Rogue paired agent", "Duplicate effects")
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C111 | Another device on the lane never sees the pinned child, nor stalls behind it | §7.3, notes deviation | invisible | packages/core/__tests__/a2a/inbound.test.ts › another device on the lane never sees the child, and does not stall behind it |
| C112 | A rogue device never sees an effectful child; its verbs get 403 | §7.3 | 403 | packages/core/__tests__/a2a/inbound.test.ts › a rogue device never sees an effectful child, and is refused on its verbs |
| C113 | A claim consumes the permit by CAS and starts the effect | §7.3 | consumed, effect_started | packages/core/__tests__/a2a/inbound.test.ts › a claim consumes an effectful call’s permit and starts its effect |
| C114 | Lease lost after the effect started → outcome_unknown, never a rerun | A2A-I8 | FAILED + unknown | packages/core/__tests__/a2a/inbound.test.ts › a lapsed lease after the effect started is outcome_unknown, never a second run; › a lapsed lease after the plugin took the permit ends outcome_unknown |
| C115 | Lease lost on a read → requeued for the same runner | §7.3 | queued | packages/core/__tests__/a2a/inbound.test.ts › a lapsed lease on a read requeues it for the same runner |
| C116 | Every verb needs the pinned DID and the claim token; reads need the pinned DID | §7.3 | 403 / 400 | packages/core/__tests__/a2a/inbound.test.ts › only the pinned runner, holding the claim token, reports on the child |
| C117 | A report under a claim token the lease moved past is refused | §7.3, §12 M2 | refused | packages/core/__tests__/a2a/inbound.test.ts › a report under a claim token the lease already moved past is refused |
| C118 | In process: authorize before the capability runs | §7.3 | not run on drift | packages/core/__tests__/a2a/inbound.test.ts › the in-process runner checks authority before it runs an instruction-only call |
| C119 | Plugin plane: permit consumed at claim, result delivered, never over D2D | §7.3, notes M2 review | as stated | packages/core/__tests__/a2a/inbound.test.ts › an approved booking runs on the plugin, its permit consumed at claim, its result delivered; › a read the plugin serves runs at once, with no permit, and its result never goes out over D2D |
| C120 | A claimed effectful child cancelled outside CancelTask (owner console, or Brain through /v1/workflow/tasks/:id/cancel) must not read CANCELED | A2A-I8, §7.4, §10 "False canceled" | FAILED + outcome unknown | GAP — probed: VIOLATED (F2) |
| C121 | Brain cannot move an inbound execution child | §7.3; Brain is an untrusted tenant | 403 | GAP — probed: VIOLATED (F2: Brain's cancel answered 200) |
| C122 | Brain cannot approve, cancel or fail the inbound review card | plan §3.7, notes M2 | 403 | GAP — probed: held |
| C123 | An expired permit is never consumed | §9 permits | refused | GAP — not probed separately: the permit and the child share the 10-minute deadline and the claim SQL skips expired children |

### C-XII. Revalidation at every egress (§7.3, §10 "Revocation raced")
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C124 | Client revoked while its read runs: result kept for the owner, neutral end | §7.3 | FAILED | packages/core/__tests__/a2a/inbound.test.ts › a client revoked while its read runs: the result is kept for the owner and the end is neutral |
| C125 | Client revoked before the claim: nothing runs | §7.3 | refused claim | packages/core/__tests__/a2a/inbound.test.ts › a client revoked before the claim: nothing runs |
| C126 | Grant revoked after settle ends the result for good; a paused listing does not hold it | §7.3, notes M3 | FAILED / released | packages/core/__tests__/a2a/inbound.test.ts › a settled result: its grant revoked ends it for good (kept for the owner); its listing paused does not hold it back |
| C127 | Client revoked after a booking ran → outcome unknown | A2A-I8 | FAILED + unknown | packages/core/__tests__/a2a/inbound.test.ts › a client revoked after its booking ran gets an unknown outcome, never a plain failure |
| C128 | A listing edit after the claim does not undo a result | notes M2 review | COMPLETED | packages/core/__tests__/a2a/inbound.test.ts › a listing edited after the claim does not undo a result: it was judged at claim |
| C129 | A grant that expires after settle: the next read is FAILED, never flips back | §7.3, notes M3 | FAILED, kept for owner | GAP — probed: held |
| C130 | A listing deleted and made again gives the old call no authority | notes M3 | FAILED | packages/core/__tests__/a2a/delivery.test.ts › a listing deleted and made again under its name gives the old call no authority back; › …even when nothing read or claimed in between; › a call accepted before the pin existed: a listing made after it is still another listing |
| C131 | Revocation at outbox claim suppresses waiting rows and closes streams | §7.3, §7.5 | suppressed, closed | packages/core/__tests__/a2a/delivery.test.ts › when the client is revoked, waiting events are suppressed and the task’s streams are told to close; › a revoked grant suppresses a granted call’s events |
| C132 | A read that finds the egress lost ends the result for good; the next claim drops its events | notes M3 | as stated | packages/core/__tests__/a2a/delivery.test.ts › a read that finds the egress lost ends the result for good; the next claim drops its events and closes its streams; › a revoked effectful result ends outcome_unknown, as settle would have ended it |

### C-XIII. Owner review cards (§7.2 step 9; notes M2)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C133 | Card words name client, skill, listing, effect; invisible characters spelled out; post_hash | notes M2 | as stated | packages/core/__tests__/a2a/inbound_review_card.test.ts › spells out invisible, bidi and control characters, and keeps the rest; › names the client, the skill, the listing and the effect; packages/core/__tests__/a2a/inbound.test.ts › the call waits on an owner-only card; approval mints the execution child |
| C134 | Parse and mirror; malformed refused; too long stays off the phone | notes M2 | as stated | packages/core/__tests__/a2a/inbound_review_card.test.ts › parses a card Core wrote, and mirrors it; › refuses %s; › keeps a card too long for the phone off the mirror |
| C135 | The owner says no → neutral FAILED | §7.4 | FAILED | packages/core/__tests__/a2a/inbound.test.ts › a refusal ends the task as a neutral FAILED; packages/core/__tests__/a2a/delivery.test.ts › the owner says no |
| C136 | The owner never answers → FAILED | §7.4 | FAILED | packages/core/__tests__/a2a/delivery.test.ts › the owner never answers |
| C137 | A missed decision handler is repaired by the sweep | notes M2 | minted by sweep | packages/core/__tests__/a2a/inbound.test.ts › a missed decision handler is repaired by the sweep |
| C138 | Approval after the client was revoked mints nothing | §7.3 | closed | GAP — probed: held |
| C139 | known_only under review: the grant opens it, the owner still decides | §12 M2 | pending_approval | packages/core/__tests__/a2a/inbound.test.ts › a known_only skill under review: the grant opens it, the owner still decides |
| C140 | CancelTask during review cancels and withdraws the card | notes M2 review | CANCELED | packages/core/__tests__/a2a/inbound.test.ts › cancelling a call that waits on review cancels it, and withdraws the card |

### C-XIV. The state map in responses (§7.4)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C141 | queued → SUBMITTED, running → WORKING, completed → COMPLETED with one data part | §7.4 | as stated | packages/core/__tests__/a2a/inbound.test.ts › a valid result completes the task with one data part; packages/core/__tests__/a2a/delivery.test.ts › auto call: no event for its creation, then WORKING, the result, COMPLETED |
| C142 | pending_approval → WORKING; approved → SUBMITTED | §7.4 | as stated | packages/core/__tests__/a2a/delivery.test.ts › review call: WORKING while the owner decides, SUBMITTED once approved, then WORKING |
| C143 | A result breaking the pinned schema → FAILED; a failed run → FAILED | §7.3 | FAILED | packages/core/__tests__/a2a/inbound.test.ts › a result that breaks the pinned schema fails the task; packages/core/__tests__/a2a/delivery.test.ts › the run fails |
| C144 | Pre-effect cancel → CANCELED | §7.4 | CANCELED | packages/core/__tests__/a2a/delivery.test.ts › a cancel is one CANCELED event |
| C145 | outcome_unknown → FAILED with outcome unknown | §7.4 | metadata outcome | packages/core/__tests__/a2a/delivery.test.ts › a lapsed lease after the effect began: never SUBMITTED again; FAILED with the outcome unknown |
| C146 | recorded → FAILED (fail-closed) | §7.4 | FAILED | GAP at the Core path — probed: held (reason child_recorded; the audit anomaly was not checked) |
| C147 | A requeue before any effect reads SUBMITTED again | §7.4 | SUBMITTED | packages/core/__tests__/a2a/delivery.test.ts › a lapsed lease before any effect: SUBMITTED again, stamped inside the requeue |

### C-XV. GetTask, CancelTask, ListTasks (§4.3; notes deviations)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C148 | GetTask never shows one client another's task | §10 "Cross-principal" | TaskNotFound | packages/core/__tests__/a2a/inbound.test.ts › never shows one client another’s task |
| C149 | CancelTask only before any effect; once a runner took it, not cancelable | §7.4 | -32002 | packages/core/__tests__/a2a/inbound.test.ts › cancels before any effect; refuses once a runner took the child |
| C150 | CancelTask by another client → TaskNotFound | §10 | -32001, op still open | GAP — probed: held |
| C151 | CancelTask on a completed or a refused task → not cancelable | §7.4 | -32002 | GAP — probed: held |
| C152 | ListTasks newest status first; an older task updated later moves ahead; pages | §4.3, A2A §3.1.4 | ordered | packages/core/__tests__/a2a/inbound.test.ts › lists the client’s tasks, most recently updated first, a page at a time; › a claim moves an older call to the front of the list |
| C153 | Ties on status time page through once each | §4.3 "ties" | no loss, no repeat | GAP — probed: held |
| C154 | Paging over a restart (cursor is status time and row id) | §4.3 | same order | GAP — held by construction (durable columns), covered by the C153 probe's walk |
| C155 | Filters: contextId, statusTimestampAfter, includeArtifacts; totalSize counts all; status filter refused | notes deviation | as stated | packages/core/__tests__/a2a/inbound.test.ts › lists by context and time, counts every match, and leaves artifacts out unless asked |
| C156 | ListTasks lists only the caller's tasks | §10 | empty for another client | GAP — probed: held |
| C157 | Malformed cursor refused; page size capped at 50; zero means default | §4.3 | as stated | GAP — probed: held |
| C158 | Settling twice changes nothing | §7.3 | idempotent | packages/core/__tests__/a2a/inbound.test.ts › a second settle changes nothing |

### C-XVI. The extended card (§7.1, §5.1; notes M3)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C159 | Requires the client's credential | plan §2 | 401 without | packages/core/__tests__/a2a/extended_card.test.ts › requires the client’s credential (401 without it) |
| C160 | Public skills in scope, signed with the card key | §7.1 | signed | packages/core/__tests__/a2a/extended_card.test.ts › with no grants: the public skills in scope, signed with the card key |
| C161 | A live grant adds its known_only skill; revoking removes it | §7.1, §12 M3 | skill gone | packages/core/__tests__/a2a/extended_card.test.ts › a live grant adds its known_only skill; revoking it removes the skill from the next card |
| C162 | Every example (grant_id, schema_hash) is a call Core accepts | notes M3 | accepted | packages/core/__tests__/a2a/extended_card.test.ts › every example on the extended card is a call Core accepts (grant_id and schema_hash included) |
| C163 | No reachable skill → -32007; no card configured → -32007 | notes M3 deviation | -32007 | packages/core/__tests__/a2a/extended_card.test.ts › a client scoped away from every public skill, holding no grant, has no card (-32007); › a node with no card configured answers -32007 |
| C164 | Named for the granted listing when no public listing exists | notes M3 | named | packages/core/__tests__/a2a/extended_card.test.ts › with no public listing, a grantee’s card is named for the listing its grant opens |
| C165 | Over the wire, signed like the public card | §12 M3 | verifies | apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › the extended card over the wire, signed like the public one |
| C166 | A grant on a public listing adds nothing to the card, and opens nothing at invocation | notes M3 | card and call agree | GAP — probed: VIOLATED (F3): the card answers -32007 (no skill) while the bare-name call with that grant is SUBMITTED |

### C-XVII. Streams: SendStreamingMessage and SubscribeToTask (§7.5; notes M3)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C167 | The streaming door answers the Task and the event cursor it reflects | notes M3 | header set | packages/core/__tests__/a2a/streams.test.ts › answers the Task the stream opens with, and the event cursor it reflects |
| C168 | Subscribe on a running task, cursor past every shown event | §7.5 | as stated | packages/core/__tests__/a2a/streams.test.ts › opens on a running task, with the cursor past every event the Task already shows |
| C169 | Subscribe settles a task whose child ended, so its end is never sent twice | notes M3 | once | packages/core/__tests__/a2a/streams.test.ts › settles a task whose child ended before answering, so its end is never sent twice |
| C170 | Subscribe on an ended task → UnsupportedOperation; another's → TaskNotFound | A2A §3.1.6 | errors | packages/core/__tests__/a2a/streams.test.ts › refuses an ended task (UnsupportedOperationError, A2A §3.1.6); › another client’s task is TaskNotFound |
| C171 | The gateway opens with Core's answer, sends later events under the call id, ends with the task | §7.5 | as stated | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › opens with Core’s answer, carries the task’s later events under the call’s id, and ends with the task |
| C172 | Streams end at INPUT_REQUIRED | notes M4 step 2 | ended | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › ends the stream when the task stops to ask its client (INPUT_REQUIRED), as the reference SDK does; › a stream that opens on a task already asking sends it, then ends |
| C173 | REST stream is the bare StreamResponse | plan §4.5 | bare | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › over REST: the bare StreamResponse, opening with Core’s answer, ending with the task |
| C174 | An event delivered while the call is at Core is replayed; nothing kept with no call on its way | notes M3 | replayed once | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › an event delivered while the call is at Core is replayed to its stream; › with no streaming call on its way, nothing is kept |
| C175 | A client that leaves while Core answers opens no stream; its slot is free | notes M3 review | freed | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › a client that leaves while Core answers opens no stream, and its slot is free again |
| C176 | Lifetime end frees the slot and the hub place | notes M3 | freed | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › a stream ended by its lifetime frees its slot and its place in the hub |
| C177 | Core's JSON-RPC error is the one event; an ended task opens and ends; HTTP refusals stay HTTP | notes M3 deviation | as stated | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › Core’s JSON-RPC error is the one event, and the stream ends; › a task already ended opens and ends its stream at once; › an HTTP refusal (no credential) stays plain HTTP, and frees the slot |
| C178 | Core's order to close ends the stream with nothing more | §7.3 suppression | ended | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › Core’s order to close ends the stream with nothing more sent; apps/home-node-lite/a2a-gateway/__tests__/delivery.test.ts › Core’s order to close a task ends its streams |
| C179 | Per-IP stream limit refused before Core; capacity counts calls on their way | notes M3 | 429 | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › a client over its stream limit is refused before Core sees the call; a closed stream frees its slot; apps/home-node-lite/a2a-gateway/__tests__/delivery.test.ts › stream slots: per client, and never past the hub’s capacity counting calls on their way |
| C180 | Each stream gets events after its cursor, once, in order; a terminal event ends them | A2A §3.5.2 | as stated | apps/home-node-lite/a2a-gateway/__tests__/delivery.test.ts › every stream of a task gets each event after its cursor, once, in order; › a terminal event ends every stream of the task, and frees their places; › a replayed terminal event ends the new stream before open returns |
| C181 | The hub buffer is bounded by age, tasks, events and bytes | notes M3 review | bounded | apps/home-node-lite/a2a-gateway/__tests__/delivery.test.ts › frees the memory of tasks nobody touches once they age out, and all of it when no call is on its way; › keeps recent events for a bounded number of tasks, events and bytes; › while a call is on its way, replays recent events to a stream that opens after them, until they age out; › refuses a stream past its capacity; close ends a task’s streams with nothing sent |
| C182 | Streamed = polled truth, event by event | §12 M3 | equal | apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › a streamed call tells the story GetTask tells, event by event, and ends with the task |
| C183 | Revoking the client ends its open stream with nothing more | §12 M3 | ended | apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › revoking the client ends its open stream with nothing more sent |
| C184 | Keepalive comments; a client too far behind (maxBufferedBytes) is cut | gateway config | ended, slot freed | GAP — probed over a real socket: held |
| C185 | Multi-turn over the wire ends on the question, resumes on the answer | §7.7 (M4) | as stated | apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › multi-turn over the wire: the stream ends on the question, the answer opens the next, and the call finishes (design §7.7) |

### C-XVIII. Delivery outbox (§7.5; notes M3)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C186 | One event per visible change; the creation is no event | notes M3 | as stated | packages/core/__tests__/a2a/delivery.test.ts › auto call: no event for its creation, then WORKING, the result, COMPLETED |
| C187 | Exactly once per (source_event_id, target_kind, target_id), repeated SSE insertion included | §7.5, §12 M3 | one row | packages/core/__tests__/a2a/delivery.test.ts › the same change recorded again writes nothing, and the outbox refuses a second row per target |
| C188 | Restart survival mid-claim: a lapsed lease is claimed again; only the new claim may report | §7.5, §12 M3 | as stated | packages/core/__tests__/a2a/delivery.test.ts › a claim survives a gateway restart: the lapsed lease is claimed again, and only the new claim may report |
| C189 | A report under another claimant's DID changes nothing | §10 "claim/ack CAS" | 0 applied | GAP — probed: held |
| C190 | A lost record is repaired by the sweep; tasks from before v57 | notes M3 | recorded | packages/core/__tests__/a2a/delivery.test.ts › a change whose record was lost (no observer installed) is recorded by the sweep; › its next change is an event, so a stream opened on it sees its end; › the sweep records where it stands once, then nothing more |
| C191 | An inline webhook gets every event the streams get | §7.5 | same events | packages/core/__tests__/a2a/delivery.test.ts › an inline webhook gets every event the streams get |
| C192 | Streams take all due events in order; a webhook its next one, with address and credentials (only inside a claim) | §7.5 | as stated | packages/core/__tests__/a2a/delivery.test.ts › streams take every due event in order; a webhook only its next one, with its address and credentials |
| C193 | Webhook claims bounded by free POST slots | notes M3 | bounded | packages/core/__tests__/a2a/delivery.test.ts › takes no more webhook events than the gateway can start now; apps/home-node-lite/a2a-gateway/__tests__/delivery.test.ts › claims no more webhook events than it has free slots |
| C194 | Retries after 5 s, 30 s, 2 min, 10 min, 30 min; sixth failure final | notes M3 | as stated | packages/core/__tests__/a2a/delivery.test.ts › a failing webhook is retried with growing waits, and its sixth failure is final |
| C195 | Webhook outcome classification | notes M3 | 2xx delivered; 408/429/5xx/unreachable retry; others final | apps/home-node-lite/a2a-gateway/__tests__/delivery.test.ts › %j → %s |
| C196 | Stream rows never stuck behind a webhook backlog; webhook slots shared across clients | notes M3 review | fair | packages/core/__tests__/a2a/delivery.test.ts › a stream event is never stuck behind a webhook backlog larger than the claim; › webhook slots are shared in turn between clients |
| C197 | A config deleted mid-flight gets nothing more; purge takes events and configs | notes M3 | suppressed / purged | packages/core/__tests__/a2a/delivery.test.ts › a webhook config deleted mid-flight gets nothing more; › purging an ended task takes its events and configs with it |
| C198 | Claim queries use the per-target index; dead rows never block a live task | notes M3 round 2 | index plans | packages/core/__tests__/a2a/delivery.test.ts › each claim query checks earlier rows through the per-target index, never by scanning the outbox; › dead rows, more than one claim holds, never keep a live task’s event out of the claim |
| C199 | A pause releases work already done, once | notes deviation M3 | released | packages/core/__tests__/a2a/delivery.test.ts › a paused listing starts no new work but does not hold back work already done; › a pause while a call runs: its result is still released, once, as polled |
| C200 | Every way a task ends is one event matching GetTask | notes M3 review | equal | packages/core/__tests__/a2a/delivery.test.ts › the claim is refused: the listing changed since the call was accepted; › a result settled after the grant went: FAILED, kept for the owner, and the event itself suppressed |
| C201 | Claim and ack doors: gateway only; claim capped | §4.3 | 403 / capped | packages/core/__tests__/a2a/gateway_routes.test.ts › claims and reports task events, the gateway alone; › a claim asks for at most the cap, whatever it says |
| C202 | The pump publishes and reports streams in the same turn, POSTs webhooks as A2A JSON, reports them next turn; stop drains | notes M3 | as stated | apps/home-node-lite/a2a-gateway/__tests__/delivery.test.ts › publishes stream events and reports them in the same turn; POSTs webhooks as A2A JSON; reports them next turn; › stop lets a POST in flight finish and reports it |
| C203 | A webhook over the wire carries its credentials and token header; Core records it delivered | notes M3 (token header) | delivered | apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › a webhook set inline gets each event as A2A JSON with its credentials, and Core records it delivered |

### C-XIX. Push-notification configs and SSRF on push URLs (§6.6, §7.5; notes M3)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C204 | Stored with a server id, handed back as set | A2A §3.1.8 | as set | packages/core/__tests__/a2a/push_configs.test.ts › stores the config with a server id and hands it back as set |
| C205 | Delete is idempotent; Get of a gone config is TaskNotFound | A2A §3.1.10 | as stated | packages/core/__tests__/a2a/push_configs.test.ts › delete is idempotent; get of a gone config is TaskNotFound |
| C206 | At most four per task | notes M3 | capped | packages/core/__tests__/a2a/push_configs.test.ts › holds at most ${MAX_PUSH_CONFIGS_PER_TASK} per task |
| C207 | Another client's or a missing task → TaskNotFound | §10 | -32001 | packages/core/__tests__/a2a/push_configs.test.ts › another client’s task, or one that does not exist, is TaskNotFound |
| C208 | URL rule at set time: https only, no literal IPv4/IPv6, no credentials, no fragment; header-safe token and credentials; scheme token; no tenant | §6.6 | refused | packages/core/__tests__/a2a/push_configs.test.ts › refuses %s |
| C209 | A bad inline config refuses the whole SendMessage, nothing stored | notes M3 | -32602 | packages/core/__tests__/a2a/push_configs.test.ts › a bad inline config refuses the whole call, before anything is stored |
| C210 | Push configs over the wire | §12 M3 | create, list, delete | apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › push configs over the wire: create, list, delete |
| C211 | A name resolving to a blocked address gets no connection: loopback, ::1, mapped and hex-mapped loopback, IPv4-compatible, metadata 169.254.169.254, RFC 1918, CGNAT, 0.0.0.0, ULA, link-local, NAT64, a mixed answer | §6.6, §12 M3 "SSRF vectors refuse" | final failure, zero connections | packages/net-node/__tests__/a2a_host_transport.test.ts › a webhook that resolves to a private address gets no connection (and the Lane 1 cases). Through the gateway pump GAP — probed (15 vectors): held |
| C212 | A push URL naming `localhost` is accepted at set time and refused at POST time | §6.6, notes M3 | final failure, no connection | GAP — probed: held |
| C213 | Pinned socket, no redirects, webhook body never read | §6.6 | as stated | packages/net-node/__tests__/a2a_host_transport.test.ts › POSTs the A2A media type and returns the status, never the body; › a redirect still fails: a push is never sent on |
| C214 | A webhook host the gateway cannot connect to (an IPv6 answer with no route) ends as a delivery outcome; it never takes the process down | §7.5, notes M3 "failure to reach the host is retried" | retry outcome, gateway stays up | GAP — probed: VIOLATED (F1) |
| C215 | Third-party webhook hosts; owner cannot list webhooks | notes M3 open questions | owner decision | not a test (open question) |

### C-XX. Clients, bearer credentials, grants and runner bindings (owner side) (§5.1, §5.2, plan §3.8)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C216 | A bearer minted once, only its hash stored, principal `a2a:<id>` | §5.1 | as stated | packages/core/__tests__/a2a/clients.test.ts › mints a bearer shown once, stores only its hash, and names the principal |
| C217 | Registration input refusals; display name cleaned | §5.1 | refused / cleaned | packages/core/__tests__/a2a/clients.test.ts › refuses %j as %s; › cleans the display name of hidden and control characters |
| C218 | last_used_at at most once a minute | §5.1 | stamped | packages/core/__tests__/a2a/clients.test.ts › stamps last_used_at at most once a minute |
| C219 | Revocation ends the client, its credentials and every grant | §5.1 | cascade | packages/core/__tests__/a2a/clients.test.ts › revocation ends the client, its credentials and every grant issued to it |
| C220 | Grants: issued as configured, listed; refusals; revoke only A2A grants | §5.2 | as stated | packages/core/__tests__/a2a/clients.test.ts › issues a grant for a capability as the listing configured it, and lists it; › refuses %s; › revokes only grants issued to an A2A client |
| C221 | Owner-only routes; Brain and agents refused; the list never carries the token | plan §3.8 | 403 / no token | packages/core/__tests__/a2a/client_routes.test.ts › %s %s refuses Brain and agents, and the matrix never opens it to Brain; › creates, lists without the token, rotates, issues and revokes; › answers 400, 404 and 503 for the wrong input, the unknown and the unwired |
| C222 | Runner bindings: bind, list, unbind, owner only; refusals | notes M2 | as stated | packages/core/__tests__/a2a/client_routes.test.ts › binds a lane to a paired runner, lists it, and unbinds it; owner only; › refuses %s |

### C-XXI. Brain's caller authentication (M2 preconditions; plan §3.18)
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C223 | Serves Core and the owner's devices only, and says which | plan §3.18 | as stated | apps/home-node-lite/brain-server/__tests__/caller_auth.test.ts › serves Core and the owner’s devices, and says which |
| C224 | Unsigned, unknown, tampered and replayed refused; probes open | plan §3.18 | 401 | apps/home-node-lite/brain-server/__tests__/caller_auth.test.ts › refuses the unsigned, the unknown, the tampered and the replayed; the probes stay open |
| C225 | A stranger never reaches the replay cache; unknown routes answer 401 | notes M2-pre | 401 | apps/home-node-lite/brain-server/__tests__/caller_auth.test.ts › a stranger never reaches the replay cache; › other methods are checked too, and an unknown route answers 401: a stranger learns no route names |
| C226 | Fastify's JSON rules kept; malformed signature material is 401 not 500 | notes M2-pre review | 401 | apps/home-node-lite/brain-server/__tests__/caller_auth.test.ts › keeps Fastify’s JSON rules: a poisoned or empty body is refused; › a known DID with malformed signature material gets 401, not 500 |
| C227 | A newly paired device is learnt at once; misses ask Core at most every 5 s; concurrent first calls pass | notes M2-pre | as stated | apps/home-node-lite/brain-server/__tests__/caller_auth.test.ts › a device paired after Brain last asked is learnt at once; misses ask Core at most every five seconds; › two calls at once from a just-paired device both get through |
| C228 | A revoked device stops within 30 s; a copy past 30 s is never used; nobody known when Core cannot say | notes M2-pre | refused | apps/home-node-lite/brain-server/__tests__/caller_auth.test.ts › a revoked owner device stops working once Brain’s copy is thirty seconds old; › a copy past thirty seconds is never used, even while Core is silent; › knows no one when Core cannot say |
| C229 | Refresh ahead and back off | notes M2-pre round 2 | bounded asks | apps/home-node-lite/brain-server/__tests__/caller_auth.test.ts › one failed ask past half-life refuses no one; › while Core fails, Brain asks it a bounded number of times, not once per request |
| C230 | Open streams end when their caller leaves | notes M2-pre rounds 2–3 | ended | apps/home-node-lite/brain-server/__tests__/caller_auth.test.ts › ends the owner device’s stream once the device is revoked; › a watched caller that leaves the set is told, without any request arriving; › while Core fails, a watched stream ends when its copy reaches thirty seconds, not later; › a watch that ends cancels the timer; › a client that leaves while its caller is checked gets no stream, no watch and no timer |
| C231 | The check is on by default; off is refused on a release node | notes M2-pre | as stated | apps/home-node-lite/brain-server/__tests__/scaffold.test.ts › checks every caller by default: unsigned asks are refused, the probes stay open; › refuses to turn the caller check off on a release node |
| C232 | An owner device's ask is the owner's own, whatever its body names | plan §3.18 | requester = owner DID | GAP — probed: held |
| C233 | Core's forwarded ask keeps the requester Core names | notes M2-pre | requester as forwarded | GAP with the check on — probed: held |
| C234 | Approve and deny are owner-device acts; Core gets 403 | notes M2-pre | 403, coordinator untouched | GAP — probed: held |
| C235 | A foreign Host is refused before the approve route runs | brain host guard | 421 | apps/home-node-lite/brain-server/__tests__/host_guard.test.ts › rejects a foreign Host with 421 BEFORE the approve route runs |

### C-XXII. Sweep, retention, restarts
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| C236 | Ended calls purge after 30 days with children, permits, workflow tasks and receipts; open ones stay | notes M2 | purged | packages/core/__tests__/a2a/inbound.test.ts › an ended call purges 30 days on, with its child and its receipt; an open one stays |
| C237 | The sweep mints for approved cards with no child and settles ended children | notes M2 | repaired | packages/core/__tests__/a2a/inbound.test.ts › a missed decision handler is repaired by the sweep |
| C238 | Sweep failures are reported by call id and error class only | notes M2 review | no message text | GAP — not probed (needs fault injection into the store) |
| C239 | The pump logs counts and statuses only, never URL, token, event or task id | delivery_pump.ts header | no PII | GAP — not probed; holds on reading delivery_pump.ts (every log call passes counts or statuses) |

### Gap closure, area C

Every GAP row above, and the completeness critic's scenarios (X-n), with what now holds it.

| Row | Closed by | Test or reason |
|---|---|---|
| C5 | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_edges.test.ts › refuses DINA_A2A_GATEWAY_TRUST_PROXY=%s at boot; › takes a whole hop count, and trusts none by default |
| C7 | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_isolation_config.test.ts › runs in its own container: read-only root, every capability dropped, no new privileges, only its own key volume; › shares a network with Core only: never with Brain; › runs as its own user, UID 10003, distinct from Core’s and Brain’s |
| C8 | owed | A documentation rule about native installs (the README warns not to open the port). No code path decides it, so there is nothing to test. |
| C9 | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_restart.test.ts › a client that subscribes again after a restart gets the current Task, then the rest: nothing lost, nothing twice |
| C15 | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_edges.test.ts › a JSON-RPC batch (an array) is answered -32600 and nothing reaches Core |
| C16 | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_edges.test.ts › a __proto__ member is refused as forbidden_member, and nothing reaches Core |
| C17 | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_edges.test.ts › %s %s is a gateway 404, and nothing reaches Core |
| C22 | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_edges.test.ts › a plain answer carries Core’s challenge and slow-down headers, and never its cursor, cookies, internal headers or answer marker; › a stream’s opening answer carries no cursor, cookies, internal headers or answer marker either; › an answer Core did not write for the client is 503, with none of its headers |
| C36 | existing test | packages/core/__tests__/a2a/inbound_resolve.test.ts › the public rules and the scope decide, named or bare: a client scoped away is refused either way; packages/core/__tests__/a2a/inbound.test.ts › under a read name, %s is no executor: off the card, refused on call |
| C43 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › a body naming one task or config, sent to another’s route, is refused and changes nothing |
| C45 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › carries only A2A-Version, which then stands for the header; any other query is refused |
| C46 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › %s (strict I-JSON at Core: a __proto__ member, a lone surrogate, array params) |
| C47 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › a bearer and a DID signature together are refused with 401 |
| C52 | new test | apps/home-node-lite/core-server/__tests__/lane2_core_boot.test.ts › the configured gateway DID passes more than 60 calls a minute at the default limit; another gateway-type DID is counted |
| C57 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › push-config Create spends the new-call budget; Get, List and Delete spend the read budget |
| C58 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › tracks at most ${MAX_TRACKED_PRINCIPALS} principals, dropping the quietest first |
| C66 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › more than 16 parts is too_many_parts, and nothing is stored |
| C67 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › an empty contextId is invalid params, and nothing is stored |
| C71 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › a refused call replayed returns the same REJECTED task, and adds nothing |
| C73 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › a replay whose inline webhook differs is a conflict, and adds no config |
| C75 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › two calls in flight at once with one message id make one task |
| C85 | existing test | packages/core/__tests__/a2a/inbound_resolve.test.ts › the public rules and the scope decide, named or bare: a client scoped away is refused either way |
| C86 | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › a grant for one capability opens no other capability on its listing, nor its capability on another listing |
| C87 | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › an expired grant opens nothing |
| C88 | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › a revoked grant refuses the next call |
| C95 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › a contextId naming a grant, or another client’s context, opens nothing and shows nothing |
| C98 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › refusals for different causes take the same order of time |
| C109 | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › a runner-binding write between acceptance and claim voids the call as stale authority |
| C110 | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › a plugin-update rebind voids a call pinned to the old release |
| C120 | existing test | packages/core/__tests__/a2a/inbound.test.ts › a booking cancelled outside CancelTask after its effect began is outcome_unknown, never canceled |
| C121 | existing test | packages/core/__tests__/a2a/inbound.test.ts › Brain may not cancel an inbound call’s execution; its read stays the caller’s to cancel |
| C122 | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › Brain cannot %s the inbound review card (403); the card stays pending |
| C123 | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › an expired permit is never consumed: the claim is refused and the permit stays unspent |
| C129 | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › a grant that expires after the result settled: the next read is FAILED, and it never flips back |
| C138 | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › approval after the client was revoked mints nothing |
| C146 | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › a child that ends recorded reads FAILED (fail-closed) |
| C150 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › another client’s cancel is TaskNotFound, and the call stays open |
| C151 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › a completed task and a refused one are not cancelable |
| C153 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › tasks that share a status time page through once each |
| C154 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › a cursor from before a restart pages on in the same order |
| C156 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › lists only the caller’s own tasks |
| C157 | new test | packages/core/__tests__/a2a/lane2_ingress_edges.test.ts › refuses a malformed cursor; caps a page at 50; reads zero as the default |
| C166 | existing test | packages/core/__tests__/a2a/inbound_resolve.test.ts › the public rules and the scope decide, named or bare: a client scoped away is refused either way |
| C184 | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_edges.test.ts › an idle stream sends keepalive comments, and stays open; › a client too far behind has its stream ended, and its slot is free again; a client that reads keeps its stream |
| C189 | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › a report under another claimant’s DID changes nothing |
| C211 | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_edges.test.ts › a name that resolves to %s gets a final failure and no connection |
| C212 | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_edges.test.ts › a push URL naming localhost is accepted when set, and refused when the POST would go |
| C214 | existing test | packages/net-node/__tests__/a2a_host_transport.test.ts › an address the host cannot route to settles as a failure; the process never sees an uncaught error; › a header Node refuses (CR/LF in a value, as a remote token could carry) settles as a failure; nothing is sent |
| C215 | owed | An open question for the owner (third-party webhook hosts; no owner view of webhooks). There is no rule to test until it is decided. |
| C232 | new test | apps/home-node-lite/brain-server/__tests__/lane2_brain_callers.test.ts › an owner device’s ask is the owner’s own, whatever its body names |
| C233 | new test | apps/home-node-lite/brain-server/__tests__/lane2_brain_callers.test.ts › Core’s forwarded ask keeps the requester Core names |
| C234 | new test | apps/home-node-lite/brain-server/__tests__/lane2_brain_callers.test.ts › %s is an owner-device act: Core gets 403 and the coordinator is untouched |
| C238 | new test | packages/core/__tests__/a2a/lane2_sweep_and_card.test.ts › one call that throws is counted and named by its id and error class, never the message; the rest are repaired, and it is retried next sweep |
| C239 | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_edges.test.ts › the pump’s logs carry counts and statuses only: never a URL, a token, an event or a task id |
| X-1: A completed inbound task's result carries the Dina extension's receiptId (beside outcome when the outcome is unknown). | test added with the fix | packages/core/__tests__/a2a/inbound.test.ts › a settled task carries the receipt id: the sha256 of the client’s own canonical params, never a row id (§7.6) (finding C-F6) |
| X-2: One listing called by D2D and by A2A with the same params: both accept or refuse alike and strip alike, apart from the three recorded differences. | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › accepts and refuses alike, and strips alike, apart from the recorded differences |
| X-3: Cross-surface grants: an A2A client presents a D2D contact's grant; a D2D peer presents a grant issued to a2a:<client_id>. | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › an A2A client cannot use a D2D contact’s grant, and a D2D peer cannot use an A2A client’s grant |
| X-4: No internal id in any Lane 2 answer (task and context ids fresh UUIDs; the ListTasks cursor reveals no row id). | test added with the fix | packages/core/__tests__/a2a/inbound.test.ts › refuses a cursor it did not make, the old time:row form included (finding C-F5) |
| X-5: An auto-policy inbound call is accepted, runs and completes (or is refused): no owner notification, chat message or card. | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › an auto call that runs and completes, or is refused, raises no owner card; a review call raises exactly one |
| X-6: Inbound review card on owner surfaces: console renders inert; a phone decision with a post_hash other than the card's is refused. | new test | apps/home-node-lite/core-server/__tests__/lane2_owner_surfaces.test.ts › shows Core’s words as text, with the client’s hostile name and params inert; › a yes on the phone for a mirror bound to another hash is refused, and the card stays pending; › a yes on the phone for the mirror the server proposed decides the card |
| X-7: Remote-written content on an inbound review card reaches the owner with no guard scan; Brain's model must never read it. | test added with the fix | packages/core/__tests__/a2a/inbound_review_redaction.test.ts › Brain’s reads of the card, one or listed, carry none of the client’s words; what Dina wrote stays (finding C-F4) |
| X-8: A request signed with the gateway's own key is sent to every Brain route. | new test | apps/home-node-lite/brain-server/__tests__/lane2_brain_callers.test.ts › a request signed with the gateway’s key gets 401 on every Brain route; Core’s own key is served |
| X-9: Core's five Brain calls are signed under Core's service key and accepted; AppView never carries Brain-bound signature headers. | new test | apps/home-node-lite/core-server/__tests__/lane2_brain_calls.test.ts › the ask bridge, service search and the Tier 1 runner each send a request Brain’s check accepts; › the AppView client beside them carries no signature header; › the A2A result notice and the service result go to Brain through the signed fetch boot hands the workflow plane |
| X-10: Web owner surface (Core's /app as RN-Web) under the caller check. | owed | Needs a Playwright run of the web app against a booted Core and Brain, or a device run; neither runs in these jest test directories. |
| X-11: Stolen-bearer response: rotation while streams and push configs opened under the old bearer still exist. | test added with the fix | packages/core/__tests__/a2a/credential_end.test.ts (every case; finding C-F3, reworked by the dual review’s CX-2) |
| X-12: A grant is revoked while a review call's stream is open and the task records no further event. | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › a grant revoked while a review call waits: nothing more is sent, the call can never run, and its end closes its streams |
| X-13: The gateway restarts while a client's stream is open; the client calls SubscribeToTask again. | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_restart.test.ts › a client that subscribes again after a restart gets the current Task, then the rest: nothing lost, nothing twice |
| X-14: A plugin-bound capability whose install is inactive, uninstalled-and-kept, or lacks provider consent. | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › an install the owner paused is off the card and refused, by bare name and by reference; › an uninstalled plugin whose listing row stays is off the card and refused; › a capability its install never consented to serve peers (not a provider kind) is off the card and refused |
| X-15: A client sends A2A-Extensions naming an unknown extension, or omits Dina's extension. | new test | apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_edges.test.ts › a call naming %s is served as any other; the gateway raises no -32008; apps/home-node-lite/a2a-gateway/__tests__/lane2_gateway_restart.test.ts › a call naming %s is served through to Core; -32008 is never raised |
| X-16: An inbound request carries a tenant (SendMessage, GetTask, ListTasks, CancelTask, both bindings). | test added with the fix | packages/core/__tests__/a2a/inbound.test.ts › every method refuses a tenant alike (Dina serves none, plan D5); an empty one is no tenant (finding C-F7) |
| X-17: A listing is deleted and made again under the same rkey while a call accepted under the old one waits for its claim. | new test | packages/core/__tests__/a2a/lane2_authority_edges.test.ts › a listing deleted and made again under its rkey: the revision continues above the old, and the waiting call never runs |
| X-18: core-server config with DINA_A2A_PUBLIC_URL but no DINA_A2A_GATEWAY_DID, and the reverse; with neither, Lane 2 off. | new test | apps/home-node-lite/core-server/__tests__/lane2_core_boot.test.ts › with neither Lane 2 setting, no card is configured and no gateway gets in |
| X-19: The server swaps its early workflow service for the full plane over one repository; an inbound child's lease then lapses and is requeued. | new test | packages/core/__tests__/a2a/lane2_sweep_and_card.test.ts › after the early workflow service is swapped for the full plane over one repository, a lapsed lease is one event, told to the new observer only |
| X-20: In one runner tick a Lane 1 step (sweep, held notice or purge) throws. | new test | apps/home-node-lite/core-server/__tests__/lane2_runner_tick.test.ts › when the %s throws, Lane 2’s sweep, nonce purge and DID re-check still run, and the tick resolves |
| X-21: The self listing is paused, so the card takes the first other live public listing's name. | new test | packages/core/__tests__/a2a/lane2_sweep_and_card.test.ts › a paused self listing gives the name to the first other live public listing, and the version moves with it |
| X-22: Official A2A TCK run against the gateway for all eleven methods, both bindings, streaming and push. | owed | Needs the official A2A TCK, a separate Python project fetched from the network. |
| X-23: Core's Lane 2 ingress, review, settle, claim and delivery paths log metadata only. | new test | apps/home-node-lite/core-server/__tests__/lane2_core_boot.test.ts › Core’s logs on Lane 2’s ingress, push-config and delivery paths carry no params, bearer, signature, webhook URL or token |
| X-24: Compromised Brain against inbound execution: claim, complete, fail, heartbeat, progress or input-required on an inbound child on dina.local and on a bound lane. | test added with the fix | packages/core/__tests__/a2a/inbound_brain_verbs.test.ts › Brain cannot %s a running in-process inbound child; the call stays Core’s runner’s to settle (finding C-F1) |
| X-25: The phone runs no Lane 2. | owed | Needs a phone run (or the mobile app's tests); apps/mobile is outside the allowed test directories. |
| X-26: A2A migrations v53–v63 (v62's triggers among them) and the revision column on the phone's op-sqlite adapter, fresh and upgrade. | owed | Needs the phone's native op-sqlite adapter; it does not run under node jest here. |

---

## Area D — M4: DID credentials, inbound multi-turn, the REST binding

Sources: design §2 (REST facts), §3 (A2A-I2, I4, I8, I11), §4.3 (did/complete, did/nonce rows), §5.1 (DID part), §7.3–§7.5 (egress, streams), §7.7, §9 (a2a_did_challenges, a2a_clients, permits, a2a_task_children), §10 (compromised gateway, stolen bearer, duplicate effects, rogue paired agent, replay floods, prompt injection), §12 M4; plan §2 (REST paths), §4.5; implementation-notes M4 steps 1–3 and the M4 deviations.

"GAP (probed: held)" means no existing test, and this run's black-box probe found the rule holding. "GAP (probed: VIOLATED)" is a finding. "GAP (not probed)" is listed for completeness.

### DID challenge (owner-issued, §5.1; notes M4 step 1)

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D1 | Owner asks for a challenge for one client and one DID | Challenge is random, single use, 15 min, names client + DID; a new one replaces an unused one | 201 with challenge, DID, node DID, client id, binding path; one live row | packages/core/__tests__/a2a/did_auth.test.ts › the owner challenge › names one client and one DID; a fresh one replaces an unused one; packages/core/__tests__/a2a/client_routes.test.ts › the DID binding challenge (§5.1, M4) › names the client and the DID; a fresh one replaces an unused one |
| D2 | Challenge with no DID, or a string that is not a DID | Owner names a well-formed DID | 400 did_malformed | did_auth.test.ts › the owner challenge › refuses %s; client_routes.test.ts › the DID binding challenge (§5.1, M4) › refuses %s |
| D3 | Client made with an expected DID; owner names another | Challenge only for the expected DID | 400 did_not_expected; the expected one issues | did_auth.test.ts › the owner challenge › holds to the DID the owner expected when the client was made; client_routes.test.ts › refuses %s |
| D4 | Challenge for an unknown client | — | 404 | client_routes.test.ts › the DID binding challenge (§5.1, M4) › refuses an unknown client |
| D5 | Challenge for a revoked client; its earlier challenge | Revoked client binds nothing | refused `revoked`; old challenge → challenge_invalid | did_auth.test.ts › binding › a bound client has no bearer to rotate; a revoked client gets no challenge and its old one binds nothing |
| D6 | Challenge route reached by Brain or an agent | Owner rows admit owner only | 403; matrix never opens it to Brain | client_routes.test.ts › owner-only › %s %s refuses Brain and agents, and the matrix never opens it to Brain |
| D7 | Challenge route with no node DID set | Node DID needed in the signing input | 503 node_did_unavailable | GAP (not probed) |
| D8 | Challenge at rest | Design §9 table keeps `nonce_hash`, not the value | stored hashed | GAP — code reading: stored in clear as the primary key (finding, low) |

### DID binding (completion through the gateway door)

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D9 | Valid binding | One commit: challenge spent, bearer gone, DID + signing key bound, history appended; principal unchanged | 200 {client_id, principal, did}; bearer 401; earlier tasks readable by DID | did_auth.test.ts › binding › trades the bearer for the DID in one commit; the principal and its tasks carry over |
| D10 | Challenge reused, another client's challenge, expired challenge | Single use, bound to one client, 15 min | 400 challenge_invalid / 403 signature_invalid | did_auth.test.ts › binding › a challenge is single use, belongs to one client, and expires |
| D11 | Thief holds bearer + challenge, not the DID key; or names their own DID | Only the named DID's key binds; failed tries spend nothing | 403 / 400; rightful holder still binds | did_auth.test.ts › binding › a challenge binds only the DID it names: the bearer and the challenge without that key bind nothing |
| D12 | Body not the three members; unknown challenge; another key; signature for another node | Strict body; signing input pins node | 400 / 403 | did_auth.test.ts › binding › refuses %s |
| D13 | Body: extra or missing member, bad DID, bad challenge shape, upper-case or short signature, duplicate member | Strict parse | null (refused) | packages/a2a/__tests__/did_auth.test.ts › parseDidBindingRequest › refuses %s; › refuses a duplicate member rather than reading the last |
| D14 | Body with a `__proto__` member; DID with a newline (forging signing-input lines) | Strict I-JSON; DID charset | refused | GAP (probed: held) |
| D15 | Signing input | domain, node DID, client id, DID, challenge, one per line | exact lines | packages/a2a/__tests__/did_auth.test.ts › signs the domain, the node, the client, the DID and the challenge, one per line |
| D16 | Binding sent to another path, with a query, as GET; no node DID | Door is POST /a2a/v1/did-binding, no query | 400; 503 | did_auth.test.ts › binding › refuses a request on any other door than the binding path, and answers 503 with no node DID |
| D17 | Repeated tries with a live challenge | Each try spends the challenge's client's budget | 429 past the budget | did_auth.test.ts › binding › charges each try with a live challenge to the challenge's client |
| D18 | DID already bound to another active client; that client revoked | One active client per DID | 409 did_in_use; binds after revocation | did_auth.test.ts › binding › one DID binds one active client; once that client is revoked, another may take it |
| D19 | Store-level uniqueness of bound_did among active clients | `idx_a2a_clients_bound_did` | second active row on one DID refused | GAP (probed: held) |
| D20 | Bound client binds again to a new DID | Old DID stops at once; history | old 401, new 200 | did_auth.test.ts › binding › binding again moves a bound client to a new DID; the old one stops at once |
| D21 | Bound client asks for bearer rotation | No bearer to rotate | 409 did_bound | did_auth.test.ts › binding › a bound client has no bearer to rotate; … |
| D22 | Races while the DID resolves: two completions; challenge reissued; client revoked; DID taken; challenge expired | Re-check inside the commit | exactly one binds; others challenge_invalid / did_in_use | did_auth.test.ts › what moves while a DID resolves › two completions of one challenge: exactly one binds; › a challenge the owner reissued meanwhile; › a client the owner revoked meanwhile; › another client that took the DID meanwhile; › a challenge that expired meanwhile |
| D23 | Gateway door forwards the body as it came and no credential | No credential beyond the challenge | client_auth {} | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › forwarding › forwards a DID binding to Core's binding door, the body as it came and no credential |
| D24 | Client sends Authorization / X-DID to the binding door | Door forwards none of them | client_auth {} | GAP (probed: held) |
| D25 | Binding route authz | `/v1/a2a/ingress/did/complete` is the gateway's alone | brain/device/agent/plugin/owner refused | packages/core/__tests__/a2a/gateway_routes.test.ts › the authorization matrix › opens POST %s to the gateway and no one else |
| D26 | End to end: bind through the public door | — | 200, principal unchanged | apps/home-node-lite/a2a-gateway/__tests__/e2e.test.ts › M4 through the gateway: a client binds its DID, then signs its calls (design §5.1) › binds through the public door, runs a DID-signed call, and the old bearer stops working |

### Which keys count

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D27 | did:plc document as plc.directory serves it (Ed25519 #dina_signing beside secp256k1 #atproto, no authentication) | No authentication member → Ed25519 verification methods | binds | did_auth.test.ts › a DID the host resolves (did:plc) › binds with the Ed25519 key of the document plc.directory serves, beside its secp256k1 key |
| D28 | secp256k1 only; authentication naming only secp; empty authentication; document for another DID | Only Ed25519; doc id must match | signature_invalid | did_auth.test.ts › a DID the host resolves (did:plc) › refuses %s |
| D29 | authentication by reference and embedded; Multikey and Ed25519VerificationKey2020; JsonWebKey2020 excluded | Key rule | exactly the two Ed25519 keys | did_auth.test.ts › a DID the host resolves (did:plc) › counts the keys a document names under authentication, embedded or by reference, of the two Ed25519 types |
| D30 | No resolver; not_found; deactivated; unavailable; resolver throws (at binding) | Anything but a document refuses at binding | did_unresolvable | did_auth.test.ts › a DID the host resolves (did:plc) › answers did_unresolvable when %s |
| D31 | did:key | Carries its own key; no host lookup | binds | did_auth.test.ts › binding › trades the bearer for the DID in one commit; … (did:key throughout) |
| D32 | did:web | Host lookup answers unavailable (not built) | cannot bind | packages/core/__tests__/d2d/resolver.test.ts › lookup (a DID as it stands, for A2A clients) › reads a failed fetch, a body that is not JSON, and an unsupported method as unavailable, never throwing (binding-level: GAP, not probed) |
| D33 | core-server installs D2D's lookup as the A2A resolver | Wiring (boot.ts:699) | did:plc binds on the server | GAP (not probed) |

### Per-request DID signatures (§5.1, A2A-I2)

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D34 | A signed call | Checked against the bound key, no network on the request path | runs | did_auth.test.ts › a DID-signed request › runs a call |
| D35 | Replayed nonce; body changed; other path; unsigned query; another key; bearer as well | Canonical string over method, path, query, time, nonce, body hash; one credential | 401 | did_auth.test.ts › a DID-signed request › refuses %s (401) |
| D36 | Validly signed outside ±5 min, either side | Time window | 401; same request in window 200 | did_auth.test.ts › a DID-signed request › refuses a request signed — validly — at a time outside the window, either side |
| D37 | Signed GetTask sent to SendMessage's door | Dispatch binding, cross-operation | operation_mismatch | did_auth.test.ts › a DID-signed request › binds the operation to the signed body: a signed GetTask sent to another door is refused; packages/core/__tests__/a2a/a2a_m0.test.ts › dispatch binding (design §5.1) › refuses a cross-operation substitution (signed GetTask, executed CancelTask) |
| D38 | Signed GetTask for task A sent to task B's route | Cross-task substitution | id_mismatch | a2a_m0.test.ts › dispatch binding (design §5.1) › refuses a cross-task substitution (signed t1, executed t2); DID-signed through ingress: GAP (probed: held) |
| D39 | Client signs a query other than A2A-Version on JSON-RPC | Only A2A-Version may be signed | -32600 query_not_allowed | a2a_m0.test.ts › dispatch binding (design §5.1) › binds the A2A-Version request parameter and refuses any other signed query; DID-signed through ingress: GAP (probed: held) |
| D40 | Two `method` members in the signed body | Strict I-JSON | refused | a2a_m0.test.ts › dispatch binding (design §5.1) › refuses a body with two method members rather than reading the last |
| D41 | Only some of the four headers (e.g. X-DID alone) | Never read as the bearer path | gateway passes as sent; Core 401 | GAP (probed: held) |
| D42 | Gateway passes the four headers through untouched | Gateway decides nothing | forwarded as sent | server.test.ts › forwarding › passes a DID-signed client's four headers through as they came (M4) |
| D43 | DID request stamps last_used_at | As the bearer path does | stamped | GAP (probed: held) |
| D44 | DID of a revoked client | — | 401 | did_auth.test.ts › binding › one DID binds one active client; once that client is revoked, another may take it |
| D45 | DID whose key was suspended by the re-check | — | 401 until rebound | did_auth.test.ts › the host's re-check of bound keys › stops a key its owner removed; the owner binds the client again to the new key |
| D46 | End to end: signed call, replay, tampered body, old bearer | — | 200 / 401 / 401 / 401 | e2e.test.ts › M4 through the gateway … › binds through the public door, runs a DID-signed call, and the old bearer stops working |
| D47 | Card states how to sign | Extension `requestSigning` (§7.6) | present | packages/a2a/__tests__/card_projection.test.ts › call contract on the card (design §7.6) › carries the contract in the Dina extension, required:false |

### The nonce replay store

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D48 | Replay after restart | Nonces on disk | 401 | did_auth.test.ts › a DID-signed request › refuses a replay after a restart: the spent nonce is on disk, not in the process |
| D49 | Signer clock ahead | Kept until own time + 5 min | still spent past now + 5 min | did_auth.test.ts › the replay guard › keeps a nonce until its own time plus the window, for a signer whose clock runs ahead |
| D50 | Past-dated request | Kept until now + 5 min | purged exactly then | did_auth.test.ts › the replay guard › keeps a nonce dated in the past for the window from now |
| D51 | Same nonce, two DIDs | Per DID | both pass once | did_auth.test.ts › the replay guard › scopes nonces to their DID |
| D52 | Nonce too short, too long, outside the alphabet | 16–128 of [A-Za-z0-9_-] | refused, nothing stored | did_auth.test.ts › the replay guard › refuses a nonce %s, storing nothing |
| D53 | Unreadable timestamp | — | refused | did_auth.test.ts › the replay guard › refuses a timestamp it cannot read |
| D54 | Same nonce, same DID, a different signed body | Spent per DID, not per request | 401 | GAP (probed: held) |
| D55 | A forged request carrying a nonce | Row only after a proven signature | no row; genuine request with that nonce still runs | GAP (probed: held) |
| D56 | Runner purges expired rows | Purge on tick | old row gone, live row kept | packages/home-node/__tests__/a2a_runner.test.ts › Lane 2 upkeep: bound client DIDs and spent nonces (design §5.1) › purges spent request nonces once their signatures have aged out |

### Background re-checks and the D2D resolver lookup

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D57 | Bound key still in document | — | kept | did_auth.test.ts › the host's re-check of bound keys › leaves a client whose key is still in its document |
| D58 | Bound key removed (another key now) | Suspend; history ends DID binding; owner rebinds | did_key_removed; 401; rebind works | did_auth.test.ts › the host's re-check of bound keys › stops a key its owner removed; the owner binds the client again to the new key |
| D59 | Every key removed (via real DIDResolver) | Suspend | suspended | did_auth.test.ts › through D2D's resolver, looking the DID up as it stands › binds against the live document, then suspends once its owner removes every key |
| D60 | Deactivated (410 tombstone) | Suspend | suspended | did_auth.test.ts › the host's re-check of bound keys › stops a client whose DID its owner deactivated; through D2D's resolver … › %s (410) |
| D61 | not_found (404) | Directory fault: keep | unresolved, kept | did_auth.test.ts › the host's re-check of bound keys › leaves a client whose bound DID the directory says it never knew: that is the directory at fault; through D2D's resolver … › %s (404) |
| D62 | Directory down, lookup throws, 500 | Outage cuts no one off | unresolved, kept | did_auth.test.ts › the host's re-check of bound keys › leaves clients alone when %s: an outage cuts no one off; through D2D's resolver … › %s (500) |
| D63 | did:key clients | Skipped | not checked | did_auth.test.ts › the host's re-check of bound keys › skips did:key clients, whose key cannot change |
| D64 | Binding lands during a re-check (both orders) | Update guarded on the key it read | new key kept | did_auth.test.ts › the host's re-check of bound keys › keeps a key bound while the re-check was resolving; › a re-check that lands first still leaves the binding that follows it in place |
| D65 | Runner cadence | Every 10 min, off the tick, one at a time; logs counts | 1 lookup per interval; tick never waits | a2a_runner.test.ts › Lane 2 upkeep … › re-checks bound DIDs once per interval, off the tick, and stops a removed key; › never makes the tick wait on a slow DID lookup, and runs one re-check at a time |
| D66 | Lookup status classes | 410 deactivated, 404 not_found, else unavailable | as mapped | resolver.test.ts › lookup (a DID as it stands, for A2A clients) › reads HTTP %i as %j |
| D67 | Lookup returns a keyless document | No D2D messaging checks | document | resolver.test.ts › lookup … › returns a document that has dropped every key: none of the messaging checks run |
| D68 | Document for another DID, an array, null | Not a document for this DID | unavailable | resolver.test.ts › lookup … › reads %s as unavailable; did_auth.test.ts › through D2D's resolver … › reads an answer that is not a document for this DID as unavailable |
| D69 | Failed fetch, non-JSON, unsupported method | Never throws | unavailable | resolver.test.ts › lookup … › reads a failed fetch, a body that is not JSON, and an unsupported method as unavailable, never throwing |
| D70 | Stalled directory | 10 s deadline | unavailable | resolver.test.ts › lookup … › gives up on a directory that stalls, past its deadline |
| D71 | No cache; did:key local | — | two fetches; did:key without fetch | resolver.test.ts › lookup … › asks the directory every time, and derives a did:key locally |
| D72 | Optional server-nonce route `POST /v1/a2a/ingress/did/nonce` (§4.3, §5.1) | Optional | — | GAP (not built; optional; not recorded in the notes) |

### Multi-turn: asking (§7.7)

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D73 | Pinned runner holding the claim asks | One commit: child running→awaiting, lease cleared, 24 h deadline, permit voided, question stored, change recorded | parked; INPUT_REQUIRED; WORKING→INPUT_REQUIRED events | packages/core/__tests__/a2a/multi_turn.test.ts › asking (§7.7): only the round holding the claim, only before any effect › parks the round, shows INPUT_REQUIRED with the question, and records it as an event |
| D74 | Malformed question (no prompt, extra member, empty, >2000 chars, control char, non-object schema, unenforceable keyword, >16 KB) | Strict question | request_malformed; round keeps running | multi_turn.test.ts › asking … › refuses a question with %s, leaving the round running |
| D75 | Stale claim token; another runner | Claim-token CAS; pinned runner | claim_lost; not_the_pinned_runner | multi_turn.test.ts › asking … › refuses a stale claim token and another runner |
| D76 | Task that is not an inbound round | — | not_inbound / 409 | multi_turn.test.ts › asking … › refuses a task that is not an inbound A2A round; › the executor route › refuses a task that is not an A2A round |
| D77 | Round already settled | — | operation_settled | multi_turn.test.ts › asking … › refuses a round already settled |
| D78 | External runner of an effectful call | Claim consumed the permit; never interrupt after an effect (A2A-I8) | effect_started; still running | multi_turn.test.ts › asking … › refuses an external runner of an effectful call: its claim consumed the permit |
| D79 | Eighth round asks | 8 rounds a call | too_many_rounds | multi_turn.test.ts › asking … › refuses a round past the last one a call may run |
| D80 | Plugin round | Plugin runner cannot ask | executor_cannot_ask | multi_turn.test.ts › asking … › refuses a round run by a plugin: its runner has no way to ask |
| D81 | Executor route: park; no claim token; another runner; malformed; stale token | Same guard as every executor verb | 200 / 400 / 403 / 400 / 409 | multi_turn.test.ts › the executor route › parks a round for its pinned runner holding the claim token; › refuses %s |
| D82 | Executor route authz | `/input-required` open to `agent` only | others refused | GAP (not probed) |
| D83 | Runner whose lease lapsed (task requeued) asks with its old claim | Claim CAS | claim_lost | GAP (probed: held) |
| D84 | Pinned runner, with its claim token, tries complete / fail / heartbeat / progress on its parked round | A parked round waits for the caller | 403 / 403 / 409 / 409; still INPUT_REQUIRED | GAP (probed: held) |
| D85 | In-process round past its boundary asks | Never after an effect | call ends outcome_unknown | multi_turn.test.ts › an in-process round under review, its effect boundary deferred (§7.3, §7.7) › a round past its boundary can no longer ask: the call ends unknown |

### Multi-turn: what the caller sees (view, events, streams)

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D86 | Status message of an asking task | prompt as text, schema as data `application/schema+json`, id `{task}-input-{round}` | as specified | multi_turn.test.ts › asking … › parks the round, shows INPUT_REQUIRED with the question, and records it as an event |
| D87 | Second question is its own event; continued round reads WORKING, never SUBMITTED | View key includes the message id | two INPUT_REQUIRED events; WORKING | multi_turn.test.ts › answering … › carries every earlier answer into a later round, and each question is its own event; › runs the next round with every answer so far, the original params unchanged |
| D88 | JSON-RPC stream reaches INPUT_REQUIRED | Streams end at an interrupted state | event then end | server.test.ts › streaming calls (JSON-RPC binding §9.4.2) › ends the stream when the task stops to ask its client (INPUT_REQUIRED), as the reference SDK does; packages/a2a/__tests__/delivery.test.ts › a stream ends on a terminal or an interrupted state, never on work in progress |
| D89 | Stream opens on a task already asking | Send it, end | one frame, end | server.test.ts › streaming calls … › a stream that opens on a task already asking sends it, then ends |
| D90 | REST stream reaches INPUT_REQUIRED; REST subscribe on an asking task | Same over REST, bare events | event then end | GAP (probed: held) |
| D91 | Core SubscribeToTask on an asking task | Not terminal, so answered | task + cursor | GAP at Core (gateway side: D89) (not probed) |
| D92 | Over the wire: streamed question equals GetTask; streamed answer opens WORKING and follows to COMPLETED | Streamed = polled | equal | e2e.test.ts › M3 through the gateway … › multi-turn over the wire: the stream ends on the question, the answer opens the next, and the call finishes (design §7.7) |

### Multi-turn: answering (continuation)

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D93 | Valid answer | CAS round++, next child minted with every answer, waiting child retired, receipt stored | WORKING; payload continuation; params unchanged | multi_turn.test.ts › answering (§7.7): the caller continues its own task › runs the next round with every answer so far, the original params unchanged |
| D94 | Later round carries all answers | Oldest first | both inputs | multi_turn.test.ts › answering … › carries every earlier answer into a later round, and each question is its own event |
| D95 | Same answer again; same id other bytes; a second answer | Receipt first; one answer moves one round | same task; message_id_reused; task_not_awaiting_input | multi_turn.test.ts › answering … › answers the same message again with the same task; one answer moves one round |
| D96 | Answer to a task not asking | — | -32004 task_not_awaiting_input | multi_turn.test.ts › answering … › refuses an answer to a task that is not asking |
| D97 | Answer in another context | contextId consistency | context_mismatch; still asking | multi_turn.test.ts › answering … › refuses an answer in another context, and keeps asking |
| D98 | Two parts; text part; non-object data; schema-refused data | Exactly one data part valid against the stored schema | -32602; still asking | multi_turn.test.ts › answering … › refuses %s, and the task keeps asking |
| D99 | Another client answers | Principal owns the task | TaskNotFound, nothing revealed | multi_turn.test.ts › answering … › refuses an answer to a task another client owns: not found, never revealed |
| D100 | Inline webhook with the answer | Stored in the commit | one config | multi_turn.test.ts › answering … › adds a webhook set inline with the answer |
| D101 | Inline webhook past the per-task cap | Cap checked before the commit | too_many_push_configs | GAP (probed: held) |
| D102 | Answer over budget | A new round spends the new-call budget | 429; round unchanged | GAP (probed: held) |
| D103 | Answer data holding `__proto__` | Strict body | -32600 malformed_body; round unchanged | GAP (probed: held) |
| D104 | Answer over REST | Same operation | WORKING | packages/core/__tests__/a2a/rest_ingress.test.ts › every operation, its own method and path › answers a question over REST, as a message that names its task |
| D105 | Answer after the grant was revoked (or the listing deleted), with no read in between | Question is egress; "find INPUT_REQUIRED"; "no answer could let it run" | refused | GAP (probed: VIOLATED — accepted, new round minted, shows WORKING) |
| D106 | Answer after a read that ended the call | — | task_not_awaiting_input | multi_turn.test.ts › a question is egress (§7.3): shown only while the call's authority holds › a read after the grant is revoked ends the call: FAILED, no question |
| D107 | Answer after the call ended (cancel) | — | task_not_awaiting_input | multi_turn.test.ts › the end of a question › an answer after the call ended is refused |
| D108 | Answer after the 24 h deadline, before the expiry sweep runs | Deadline enforced by the sweep (30 s cadence) | accepted within the sweep window | GAP (probed: accepted; window bounded by the sweep, not reported) |

### Multi-turn: permits and the deferred effect boundary

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D109 | Effectful in-process round under review asks before its effect | Interruption voids the minted permit | permit void (input_required); pre_effect | multi_turn.test.ts › an in-process round under review, its effect boundary deferred (§7.3, §7.7) › asks before its effect, then the next round gets one fresh permit under the same approval |
| D110 | Continuation mints one fresh permit under the same approval, bound to (post_hash, turns) | Per-round permit | one minted; approval id equal; hash ≠ post_hash | same test; multi_turn.test.ts › an in-process round … › binds each round's permit to its own payload |
| D111 | Duplicate continuation; voided permit never consumed | Stale-permit gate | refused; consumed_at null | multi_turn.test.ts › an in-process round … › asks before its effect, then the next round gets one fresh permit under the same approval |
| D112 | After the answer, the old round tries to authorize or claim | Old generation has no authority | refused; [void, minted] then [void, consumed] | GAP (probed: held) |
| D113 | Mint while an earlier round's permit is live | Mint refuses (rolls back) | throws | GAP (unreachable by construction, inbound_children.ts:97; not probed) |
| D114 | Payload changed after mint | Permit bound to the round's payload | permit_mismatch | multi_turn.test.ts › an in-process round … › refuses a payload changed after its permit was minted |
| D115 | Capability never authorizes | Runner authorizes before the result goes out | consumed | multi_turn.test.ts › an in-process round … › a round whose capability never authorizes is authorized before its result goes out |
| D116 | Authority lost at the boundary | Refusal ends the call, nothing acts | authority_revoked; permit void | multi_turn.test.ts › an in-process round … › a round whose authority is gone is stopped at its boundary, and its result never goes out |
| D117 | Lease lost before / after the boundary | requeue / outcome_unknown, never a second run; authorize idempotent | queued + minted / outcome_unknown + consumed once | multi_turn.test.ts › an in-process round … › a lease lost before the boundary requeues the round; › a lease lost after the boundary is outcome_unknown, never a second run |
| D118 | Capability not declared as authorizing | Boundary stays at claim | consumed at claim; ask → outcome_unknown | multi_turn.test.ts › an in-process round … › a capability not declared as authorizing its effects stays at its claim on the same runner |
| D119 | may_ask on the payload | Read rounds only | true on read; absent on effectful | multi_turn.test.ts › which rounds may ask (may_ask on the payload) › a read round may; an effectful one, whose claim starts its effect, may not |
| D120 | Stale report from an earlier generation's child (§9 test list) | Children keyed by own id and generation | old round cannot complete, ask or claim; call finishes on the new round | GAP (probed: held) |

### Multi-turn: ends, deadlines, egress loss

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D121 | Unanswered question past 24 h | Sweep fails child; settle reads input_not_received | FAILED | multi_turn.test.ts › the end of a question › an unanswered question ends the call when its deadline passes |
| D122 | Cancel while asked | Pre-effect cancel | CANCELED; waiting child cancelled | multi_turn.test.ts › the end of a question › the caller may cancel while asked |
| D123 | Client revoked while asking | Question shown only while authority holds; sweep ends it | FAILED; authority_revoked; child cancelled | multi_turn.test.ts › a question is egress … › a read after the client is revoked ends the call and shows no question |
| D124 | Grant revoked while asking, then read | Read ends the call | FAILED, no message | multi_turn.test.ts › a question is egress … › a read after the grant is revoked ends the call: FAILED, no question |
| D125 | Listing deleted while asking, then sweep | Sweep ends it | failed authority_revoked; child cancelled | GAP (probed: held) |
| D126 | Open stream when the client is revoked | Delivery claim ends it | stream ends | e2e.test.ts › M3 through the gateway … › revoking the client ends its open stream with nothing more sent |

### CLI agent: daemon, client, MCP server

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D127 | Daemon fallback complete / fail / failed mark_running carry the claim token | Claim token on every report | claim_id sent | cli/tests/test_agent_daemon.py › test_a_fallback_completion_carries_the_claim_token; › test_a_failure_carries_the_claim_token; › test_a_failed_mark_running_fails_the_task_under_its_claim |
| D128 | No report for a task already reported or parked | — | nothing sent | cli/tests/test_agent_daemon.py › test_no_report_for_a_task_already_reported_or_waiting_on_its_requester |
| D129 | Fire-and-forget fallback (mark_running failed) on a parked task | Daemon's own rule | daemon sends a fail; Core refuses it (403) | GAP (probed: daemon sends; Core refuses, no effect; not reported) |
| D130 | Client verbs send claim_id only when given | — | as given | cli/tests/test_client.py › test_workflow_reports_carry_the_claim_token_only_when_given |
| D131 | Client ask verb | POST /input-required {claim_id, prompt, input_schema} | as specified | cli/tests/test_client.py › test_task_input_required_asks_under_the_claim |
| D132 | Client task read unwraps `{task}` | — | task | cli/tests/test_client.py › test_get_task_reads_the_task_out_of_cores_answer |
| D133 | MCP task tools pass the claim token | — | forwarded | cli/tests/test_mcp_server.py › test_task_tools_report_under_the_claim_token; › test_task_tools_without_a_claim_token_send_none |
| D134 | MCP ask tool | — | Core's answer returned | cli/tests/test_mcp_server.py › test_input_required_asks_the_requester_and_returns_cores_answer |
| D135 | Refused ask (409, and 400) tells the agent to finish | Never leave the lease to lapse | status refused + next | cli/tests/test_mcp_server.py › test_a_refused_ask_tells_the_agent_to_finish_the_task (400 variant: GAP, probed: held) |
| D136 | Prompt carries the claim token | — | CLAIM ID line | cli/tests/test_runner.py › TestTaskPrompt › test_prompt_carries_the_claim_token |
| D137 | Ask hint only where Core set may_ask | — | hint only then | cli/tests/test_runner.py › TestA2AMultiTurnPrompt › test_offers_asking_only_where_core_says_the_run_may_ask |
| D138 | Continued run lists answers as data, never instructions | — | data block | cli/tests/test_runner.py › TestA2AMultiTurnPrompt › test_lists_every_answer_so_far_as_data; › test_no_continuation_says_nothing_about_one |
| D139 | Answer text tries to forge a "Question N:" line (prompt injection, §10) | JSON-escaped data | one real question line | GAP (probed: held) |

### REST binding: route table, params, version (A2A §11; plan §2; notes M4 step 3)

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D140 | Every v1.0 path, no /v1 prefix, both :subscribe methods | One table | operation + ids | packages/a2a/__tests__/rest_binding.test.ts › routes: the v1.0 paths, no /v1 prefix › %s %s → %s |
| D141 | Percent-encoded id; undecodable id | — | decoded; no match | rest_binding.test.ts › routes … › decodes a percent-encoded id, and refuses one that does not decode |
| D142 | JSON-RPC path, /v1 prefix, wrong method, trailing segment, unknown action | — | no match | rest_binding.test.ts › routes … › matches nothing for %s |
| D143 | Core route per operation, ids from the path | Same route as JSON-RPC | as mapped | rest_binding.test.ts › routes … › maps each request to its operation's Core route, the ids from the path; server.test.ts › REST (HTTP+JSON, A2A §11) › %s %s goes to its operation's Core route, the request as sent |
| D144 | Methods a path is served by (Allow) | — | e.g. GET, DELETE | rest_binding.test.ts › routes … › names the methods a path is served by (:subscribe GET+POST: GAP, probed: held) |
| D145 | Message call body; typed list query + version; id in body may repeat, never change | — | as specified | rest_binding.test.ts › params › a message call: the body is the request; › a list: typed query parameters, and the version; › the path names the task: a body may repeat it, never change it |
| D146 | Unknown query key; key twice; bad int / negative / bad bool / bad version; undecodable; body on read; no body; non-object; duplicate member | Strict | refused with reason | rest_binding.test.ts › params › refuses %s |
| D147 | Unknown query key named after an Object.prototype member (`constructor`, `toString`, `hasOwnProperty`, `valueOf`, `__proto__`) | Query may carry only the operation's own parameters and A2A-Version | query_not_allowed | GAP (probed: VIOLATED — accepted on read routes; on message:send refused as params_not_canonical) |
| D148 | A2A-Version twice | Each once | refused | GAP (probed: held) |
| D149 | No route takes both query and body | — | none | rest_binding.test.ts › params › no route takes both query parameters and a body |
| D150 | Card lists REST second | Preference order | JSONRPC then HTTP+JSON | card_projection.test.ts › the interfaces, in preference order › lists REST after JSON-RPC when the node serves it; e2e.test.ts › REST through the gateway (A2A §11, M4) › the card offers REST after JSON-RPC |

### REST binding: answers and errors in Core

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D151 | Send, read, list, cancel, stream, subscribe (GET/POST), push configs | Bare answers | bare bodies; cursor header | rest_ingress.test.ts › every operation, its own method and path › sends a message …; › reads, lists and cancels a task; › a streaming call opens with the task and the event cursor, as over JSON-RPC; › push configs: create, list, get, delete |
| D152 | Same message by REST then JSON-RPC | One receipt book | replay, same task | rest_ingress.test.ts › every operation … › one receipt book for both bindings: the same message by JSON-RPC is a replay |
| D153 | Request sent to another op's route; another task's route; unserved path; body on read; unknown query; no body | bindRestDispatch | 400 INVALID_REQUEST + Dina reason | rest_ingress.test.ts › Core binds the REST request to the route the gateway called › refuses %s (400 INVALID_REQUEST) |
| D154 | Error mapping (status, google.rpc.Code, reason) | A2A mapping (matches a2a-sdk A2A_ERROR_MAPPING) | as table | rest_binding.test.ts › errors: google.rpc.Status, A2A's mapping, Dina's reason kept › %s → %i %s |
| D155 | Dina's reason kept after A2A's ErrorInfo; none when absent | — | two details / one | rest_ingress.test.ts › errors … › a refusal keeps Dina's reason after A2A's; rest_binding.test.ts › errors … › an error with no Dina reason carries A2A's alone |
| D156 | Task not found | — | 404 NOT_FOUND TASK_NOT_FOUND | rest_ingress.test.ts › errors … › a task not found is 404 NOT_FOUND / TASK_NOT_FOUND |
| D157 | No credential | — | 401 UNAUTHENTICATED, WWW-Authenticate kept | rest_ingress.test.ts › errors … › no credential is 401 UNAUTHENTICATED, with the challenge kept |
| D158 | No version; query parameter instead | Empty = 0.3 | 400 VERSION_NOT_SUPPORTED; 200 with query | rest_ingress.test.ts › errors … › no version is 400 VERSION_NOT_SUPPORTED; the query parameter is enough |
| D159 | ListTasks status filter over REST | Refused at the operation | 400 Status, status_filter_unsupported | GAP (probed: held) |
| D160 | Dot-segment id `GET /tasks/..` | Never reaches another route | 404 (gateway) / TaskNotFound (Core) | GAP (probed: held) |
| D161 | DID-signed REST read; changed query refused | Signature covers method, path, query, body | 200 / 401 | e2e.test.ts › M4 through the gateway … › binds through the public door, runs a DID-signed call, and the old bearer stops working |
| D162 | End to end REST call to result, both bindings agree | — | bare shapes; same status | e2e.test.ts › REST through the gateway (A2A §11, M4) › a call over REST, from sending to the runner's result, the bare v1.0 shapes throughout; › errors are google.rpc.Status with A2A's HTTP mapping |

### REST binding: the gateway's edge

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| D163 | No route; wrong method | 404 / 405 with Allow, as Status | as specified | server.test.ts › REST (HTTP+JSON, A2A §11) › answers what needs no authority itself, as google.rpc.Status: no route, a wrong method |
| D164 | Body over 256 KB; unread content type; bare REST base | Status form | 413 / 415 / 404 | server.test.ts › REST … › answers %s as google.rpc.Status, as the SDK expects |
| D165 | PATCH, PUT, OPTIONS | 405 + Allow | 405 UNIMPLEMENTED | server.test.ts › REST … › answers %s on a REST path with 405 and the methods served |
| D166 | Plain answers stay off REST paths | — | plain JSON | server.test.ts › REST … › keeps the plain answers off REST paths |
| D167 | Core unreachable | — | 503 UNAVAILABLE | server.test.ts › REST … › a Core it cannot reach is 503 UNAVAILABLE |
| D168 | Edge limit | 429 RESOURCE_EXHAUSTED + retry-after | as specified | server.test.ts › REST … › the edge limit holds for REST too |
| D169 | Core's answer relayed; a2a+json content type; Core's retry-after reaches the client | — | relayed | server.test.ts › REST … › relays Core's REST answer as it came: status, headers, body (retry-after from Core: GAP, probed: held) |
| D170 | REST stream frames | Bare StreamResponse | bare events, end on terminal | server.test.ts › streaming calls … › over REST: the bare StreamResponse, opening with Core's answer, ending with the task |
| D171 | Logs | method/status/latency, never body/token/id | none leaked | server.test.ts › logs › never carry a body, a bearer or a task id |

### Gap closure, area D

Every GAP row above, and the completeness critic's scenarios (X-n), with what now holds it.

| Row | Closed by | Test or reason |
|---|---|---|
| D7 | new test | packages/core/__tests__/a2a/m4_did_credentials.test.ts › the owner challenge route (§5.1) › issues no challenge while the node has no DID to sign into it, and stores nothing |
| D8 | existing test | packages/core/__tests__/a2a/did_auth.test.ts › the owner challenge › names one client and one DID; a fresh one replaces an unused one; packages/core/__tests__/a2a/client_routes.test.ts › the DID binding challenge (§5.1, M4) › names the client and the DID; a fresh one replaces an unused one |
| D14 | new test | packages/core/__tests__/a2a/m4_did_credentials.test.ts › the binding body is strict (§5.1 strict I-JSON, the DID charset) › refuses a body with a __proto__ member, and binds nothing; › refuses a DID with a line break, which could forge a line of the signing input; packages/a2a/__tests__/m4_rest_and_did_wire.test.ts › the DID binding body (§5.1 strict I-JSON) › refuses %s; › refuses a DID with %s, which could forge a line of the signing input |
| D19 | new test | packages/core/__tests__/a2a/m4_did_credentials.test.ts › one active client per DID, in the store itself (design §9, idx_a2a_clients_bound_did) › refuses a second active row on one DID, whoever writes it; a revoked row no longer holds the DID |
| D24 | existing test | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › forwarding › forwards a DID binding to Core’s binding door, the body as it came and no credential (That test sends Authorization, X-DID and X-Signature to the binding door and checks client_auth is {}.) |
| D32 | new test | packages/core/__tests__/a2a/m4_did_credentials.test.ts › did:web (notes M4: the host has no did:web resolver yet) › cannot bind through the host’s lookup, which opens no connection for it |
| D33 | test added with the fix | apps/home-node-lite/core-server/__tests__/m4_did_plc_boot.test.ts › with Lane 2 configured, binds a did:plc through the directory’s document, looked up afresh each time |
| D38 | new test | packages/core/__tests__/a2a/m4_did_credentials.test.ts › a DID-signed call is bound to the task and the query it signed (§5.1 dispatch binding) › refuses a signed GetTask for one task sent to another task’s route, and reveals neither |
| D39 | new test | packages/core/__tests__/a2a/m4_did_credentials.test.ts › a DID-signed call is bound to the task and the query it signed (§5.1 dispatch binding) › refuses a signed query other than A2A-Version, though the signature covers it |
| D41 | new test | packages/core/__tests__/a2a/m4_did_credentials.test.ts › one credential, never half of one (§5.1) › reads a request with only some of the four headers as no credential, even beside a valid bearer; apps/home-node-lite/a2a-gateway/__tests__/m4_gateway.test.ts › a half-signed request (§5.1: the gateway decides nothing) › over %s, forwards X-DID alone beside the bearer as it came, for Core to refuse |
| D43 | new test | packages/core/__tests__/a2a/m4_did_credentials.test.ts › a DID-signed call is a use of the credential (§5.1 last_used_at) › stamps last_used_at as a bearer call does; a refused signature stamps nothing |
| D54 | new test | packages/core/__tests__/a2a/m4_did_credentials.test.ts › the nonce replay store (§5.1, notes M4: per DID, after a proven signature) › spends a nonce for its DID, whatever request it came with: another signed body under it is a replay |
| D55 | new test | packages/core/__tests__/a2a/m4_did_credentials.test.ts › the nonce replay store (§5.1, notes M4: per DID, after a proven signature) › spends nothing for a request whose signature fails: the real signer’s request with that nonce still runs |
| D72 | owed | The optional server-nonce route (POST /v1/a2a/ingress/did/nonce, design §4.3 and §5.1) is not built and the design marks it optional, so there is no behaviour to test. The notes do not record the choice; that is a notes gap, not a test gap. |
| D82 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › who may ask (§7.7: the runner holding the claim) › opens the ask route to paired runners alone in the authorization matrix; › a parked round waits for its caller (§7.7) › refuses an ask from anyone but the pinned runner, at the route |
| D83 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › who may ask (§7.7: the runner holding the claim) › a runner whose lease lapsed cannot ask with its old claim; the round waits for the next claim |
| D84 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › a parked round waits for its caller (§7.7) › refuses %s from its own runner under its claim token, and keeps asking |
| D90 | new test | apps/home-node-lite/a2a-gateway/__tests__/m4_gateway.test.ts › REST streams end where the task asks (§7.7, notes M4 step 2) › a REST :stream sends the INPUT_REQUIRED event bare, then ends; › a REST %s :subscribe on a task already asking sends it, then ends; packages/core/__tests__/a2a/m4_rest_ingress.test.ts › REST subscribe on a task that asks (notes M4 step 2: asking is not an end) › %s :subscribe answers the asking task, the question as its message, and the cursor |
| D91 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › subscribing to an asking task (§7.5, notes M4 step 2) › answers the asking task and its event cursor, since asking is not an end |
| D101 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › what an answer must pass before it moves a round (notes M4 step 2, in order) › refuses an inline webhook past the task’s cap, before the commit: nothing moves |
| D102 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › what an answer must pass before it moves a round (notes M4 step 2, in order) › charges a new round to the caller’s new-call budget: over it, 429 and the round stays |
| D103 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › what an answer must pass before it moves a round (notes M4 step 2, in order) › refuses an answer whose data holds a __proto__ member, and the round stays |
| D105 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › an answer after the call can no longer run (§7.3, §7.7) › an answer that comes after the grant was revoked, with no read between, never lets the call run |
| D108 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › an answer after the call can no longer run (§7.3, §7.7) › an answer after the expiry sweep ended an unanswered question is refused, and no round starts |
| D112 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › the old round has no authority once the caller answers (§7.3 claim tokens, §7.7 generations) › the round that asked cannot authorize an effect or be claimed after the answer; its permit stays void |
| D113 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › the old round has no authority once the caller answers (§7.3 claim tokens, §7.7 generations) › minting a later round refuses, and rolls back, while an earlier round’s permit is %s |
| D120 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › the old round has no authority once the caller answers (§7.3 claim tokens, §7.7 generations) › a stale report from the earlier round lands nowhere; the call finishes on the new round |
| D125 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › an answer after the call can no longer run (§7.3, §7.7) › a listing deleted while its call asks: the sweep ends the call and retires the waiting round |
| D129 | new test | packages/core/__tests__/a2a/m4_multi_turn.test.ts › a parked round waits for its caller (§7.7) › refuses %s from its own runner under its claim token, and keeps asking |
| D135 | new test | cli/tests/test_m4_multi_turn.py › test_any_refused_ask_tells_the_agent_to_finish_the_task |
| D139 | new test | cli/tests/test_m4_multi_turn.py › test_an_answer_cannot_forge_a_question_or_an_instruction_line |
| D144 | new test | packages/a2a/__tests__/m4_rest_and_did_wire.test.ts › REST routes and params (A2A §11, notes M4 step 3) › :subscribe is served by both GET and POST, as the reference SDK serves it; apps/home-node-lite/a2a-gateway/__tests__/m4_gateway.test.ts › the methods :subscribe is served by (A2A §11, notes M4 step 3) › answers %s with 405, naming GET and POST |
| D147 | existing test | packages/a2a/__tests__/rest_binding.test.ts › params › refuses %s (the Object.prototype key cases) |
| D148 | new test | packages/a2a/__tests__/m4_rest_and_did_wire.test.ts › REST routes and params (A2A §11, notes M4 step 3) › refuses A2A-Version twice in the query of %s %s, whatever the values |
| D159 | new test | packages/core/__tests__/a2a/m4_rest_ingress.test.ts › ListTasks over REST › refuses a status filter, as the operation does over JSON-RPC: no stored column can answer it exactly |
| D160 | new test | packages/core/__tests__/a2a/m4_rest_ingress.test.ts › a task id that is a dot segment › GET /tasks/%s reads no task and no list: task not found; packages/a2a/__tests__/m4_rest_and_did_wire.test.ts › REST routes and params (A2A §11, notes M4 step 3) › a task id that is a dot segment (%s) names GetTask for that id, never another operation |
| D169 | new test | apps/home-node-lite/a2a-gateway/__tests__/m4_gateway.test.ts › Core’s slow-down reaches a REST client (notes M4 step 3: the headers stay) › relays Core’s 429, its retry-after and its google.rpc.Status, as Core sent them |
| X-1: The runner's re-check suspends a DID-bound client (key removed, or DID deactivated) while it has an open stream and webhook configs. | test added with the fix | packages/core/__tests__/a2a/delivery_suspended.test.ts › a suspended client gets nothing more on its stream or webhook, and its streams are closed (finding D-F1) |
| X-2: End to end with the real Python dina-agent daemon as the paired runner on a bound lane, through the gateway: claim, report under the claim token, ask (INPUT_REQUIRED), receive the caller's answer, finish. | owed | Needs a cross-language harness: a live TS Core and gateway over signed HTTP, with the Python daemon paired as a device. It also needs an LLM agent runner behind the daemon (OpenClaw or Hermes, third-party and not installed) to call dina_task_input_required. Neither test runner has this. The parts are covered one by one: claim tokens on every report (cli/tests/test_agent_daemon.py, test_client.py, test_mcp_server.py), the ask route (multi_turn.test.ts › the executor route), and multi-turn over the wire (a2a-gateway e2e.test.ts). |

---

## Area E: M5, publishing the card to the directory: test plan

Sources: design §3 (A2A-I1, I13), §8.1, §8.2, §9 (a2a_card_publication, migration), §10 (rows on the directory and Brain), §12 M5; plan §3.8, §3.15, §3.22, §4.6 "As built"; implementation-notes "Design decisions: M5 steps 1–2", M5 open questions, iterations "M5 steps 1–2", review rounds 1 and 2.

"GAP (probe: held)" means no existing test covered the rule and the probe showed the code keeps it. "GAP (probe: VIOLATED)" means the probe showed a break; see findings. Probe files lived at packages/core/__tests__/a2a/zz_wf_probe_E.test.ts, apps/home-node-lite/core-server/__tests__/zz_wf_probe_E.test.ts, packages/home-node/__tests__/zz_wf_probe_E.test.ts and packages/brain/__tests__/pds/zz_wf_probe_E.test.ts. All four are now deleted.

### E.1 The publication row, defaults, migration

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E1 | Row made on demand: switched off, inactive, not_published, epochs 0, generation 0, fence_key_id null, fresh v4 UUID instance | §8.2, §9; notes "The publication row" | Those defaults | packages/core/__tests__/a2a/publication.test.ts › the row › starts switched off, inactive, unpublished, under a fresh UUID instance |
| E2 | Row made once; a second ensure keeps the instance | notes | Same instance | same test |
| E3 | v59 creates a2a_card_publication with foreign keys on (fresh install) | §9 | Table present | packages/core/__tests__/a2a/store.test.ts › creates every A2A table (M1a v53, M1b v54–v55, M2 v56, M3 v57, M4 v58, M5 v59) with foreign keys on |
| E4 | Upgrade from v52 leaves existing rows alone | §9 | Rows intact | packages/core/__tests__/a2a/store.test.ts › upgrades a v52 install without touching existing workflow rows |
| E5 | Fresh install and mixed-listing upgrade default to listing_enabled = 0; isDiscoverable never implies the directory | §8.2 consent | Off, not eligible | packages/core/__tests__/a2a/publication.test.ts › the row › fresh installs and upgrades start switched off: discoverable listings never imply the directory |
| E6 | An archive restore brings no A2A table, so the restored node has no row: off, inactive, new instance, silent until activation | §8.2 boot-inactive; notes | No write before activation | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › activation: the fencing ceremony › a restored node with an eligible card writes nothing until the owner activates it (archive allowlist read: packages/core/src/export/archive.ts:118 has no a2a table) |
| E7 | A raw copy of the database files carries the row, instance and epoch | notes open question "M5: a raw copy of the database" | Recorded as open | GAP (recorded open question; not probed) |
| E8 | v59 and its triggers on the phone adapter ("fresh + upgrade tests, both adapters") | §9 | Same schema | GAP (op-sqlite cannot run under jest; not probed) |
| E9 | M2-only install: config saves and plugin rebinds succeed, make no row, touch no publication state | §9 | No row | packages/core/__tests__/a2a/publication.test.ts › the projection revision: every card-affecting write bumps it, in its own transaction › before the row exists, writes go through and change nothing (saves); rebind: GAP (probe: held) |

### E.2 The projection revision (triggers)

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E10 | Listing insert bumps card_projection_revision | §8.2, §9; notes "by trigger" | +1 | packages/core/__tests__/a2a/publication.test.ts › the projection revision: … › a listing saved, changed, or deleted |
| E11 | Listing edit (revision change) bumps | same | +1 | same test |
| E12 | Listing delete bumps | same | +1 | same test |
| E13 | Runner bind and unbind bump (through the listing revision) | §8.2 | Moves | packages/core/__tests__/a2a/publication.test.ts › the projection revision: … › a runner bound to, or unbound from, a lane a listing names |
| E14 | Plugin install insert, update, delete bump | notes | +1 each | packages/core/__tests__/a2a/publication.test.ts › the projection revision: … › a plugin install made, changed, or removed |
| E15 | Plugin-update rebind (listing_rebind.ts) bumps and so triggers republish | §9 "it also triggers Lane 3 republish" | Moves | GAP (probe: held) |
| E16 | The owner switch bumps in code, either way | notes | +1 | packages/core/__tests__/a2a/publication.test.ts › the row › the switch bumps the projection either way, and drops an earlier failure’s backoff: the owner just acted |
| E17 | The bump is inside the writer's transaction: a rolled-back write leaves it where it was | §8.2 "transactionally" | Unchanged | GAP (probe: held) |
| E18 | Signing-key change and gateway enablement are not DB writes: noticed by key-id compare and the per-tick predicate | §8.2; notes | Republish or unpublish | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › keys › a rotation before any refresh: the fence is re-signed, keeping epoch and instance, and the envelope at once; … › the predicate: each input, and restoring it › gateway disabled: the card goes; restored: it comes back |
| E19 | A runner revocation with no revision bump still changes the card (hash compare) | notes round 1 | New card, then none | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › the predicate: each input, and restoring it › a runner binding revoked (no revision bump): the next tick publishes without the skill, then without the card; restored, back |

### E.3 The publication predicate and its inputs

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E20 | Truth table: listing_enabled && gateway_live && skills > 0 && active && state not in (stood_down, deactivating) | §8.2 normative predicate | Only all-true holds | packages/core/__tests__/a2a/publication.test.ts › the publication predicate (design §8.2) › holds only when every condition does |
| E21 | Gateway disable deletes; restore republishes | §8.2 M5 vector | Card gone, back | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › the predicate: each input, and restoring it › gateway disabled: the card goes; restored: it comes back |
| E22 | Final-skill removal deletes; restore republishes | §8.2 M5 vector | Card gone, back | … › the final skill removed: the card goes; restored: it comes back |
| E23 | Runner-binding revocation | §8.2 M5 vector | Skill dropped, then card gone | … › a runner binding revoked (no revision bump): … |
| E24 | Endpoint = the JSON-RPC interface wherever listed; no JSON-RPC interface means not publishable | notes round 2 | Deleted | … › the endpoint is the JSON-RPC interface’s wherever it is listed; a card with none is not publishable |
| E25 | Card build refused for another reason (invalid origin) counts as predicate-false | §8.2 predicate-false drives unpublish | Deleted | GAP (probe: held; card deleted, state not_published) |
| E26 | Card build throws: step aborts; nothing written or deleted; next step recovers | robustness | No write | GAP (probe: held) |
| E27 | Restore with an eligible card must not publish before activation | §8.2 M5 vector | No write | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › activation: the fencing ceremony › a restored node with an eligible card writes nothing until the owner activates it |
| E28 | Deactivating is never publish-eligible; no publish starts or resumes while deactivating | §8.2 | Claim refused | packages/core/__tests__/a2a/publication.test.ts › the guarded steps: … › a publish claim needs the node active, switched on, and neither stood down nor deactivating; an unpublish only active; extra probe (held) |
| E29 | Stand-down during in-flight I/O | §8.2 M5 vector | Write lands, completion does not, nothing more | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › the predicate: each input, and restoring it › a stand-down during in-flight I/O: the write lands, its completion does not, and nothing more is written |
| E30 | Late completion after deactivation | §8.2 M5 vector | Writes nothing; card then removed | … › a late completion after deactivation began writes nothing; the deactivation then removes the card |
| E31 | "gateway live" read as "public origin configured" | notes open question | Recorded | GAP (recorded open question; not probed) |

### E.4 The owner switch and consent

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E32 | POST /v1/owner/a2a/directory-listing takes a boolean (else 400) and returns the view | §8.2; plan §3.8 | 200 view, 400 | packages/core/__tests__/a2a/publication.test.ts › the owner routes › the switch: a boolean, or 400; the view after |
| E33 | The switch nudges the publisher | notes | nudge called | packages/core/__tests__/a2a/publication.test.ts › the owner routes › activation and deactivation go to the host’s publisher, or 503 without one |
| E34 | The switch drops an earlier backoff | notes | attempts 0, next_retry_at null | packages/core/__tests__/a2a/publication.test.ts › the row › the switch bumps the projection either way, … |
| E35 | Switch off deletes (tombstone); the intent survives a failure and a restart | §8.2 unpublish, durable intent | Card gone after restart | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › the predicate: each input, and restoring it › the switch turned off: the card goes, and the intent survives a failure and a restart |
| E36 | Activated with listings but the switch off: nothing published until switched on | §8.2 consent | No card, then card | … › consent › activated with listings but the switch off: nothing is published until the owner switches it on |

### E.5 Owner routes and authority

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E37 | The four routes refuse Brain in two processes (authz matrix) and in one (handler guard) | §8.2 "Brain cannot publish"; plan §3.8 | 403 / not authorized | packages/core/__tests__/a2a/publication.test.ts › the owner routes › %s %s is the owner’s alone: Brain cannot publish, in one process or two (GET /v1/owner/a2a/publisher; POST /v1/owner/a2a/directory-listing; POST /v1/owner/a2a/publisher/activate; POST /v1/owner/a2a/publisher/deactivate) |
| E38 | An owner caller with the wrong owner capability is refused | plan §3.8 | 403, no row | GAP (probe: held) |
| E39 | In-process agent, device, plugin, gateway, admin, connector callers refused | plan §3.8 | 403 | GAP (probe: held) |
| E40 | activate and deactivate without a host publisher answer 503 | notes | 503 publisher_unavailable | packages/core/__tests__/a2a/publication.test.ts › the owner routes › activation and deactivation go to the host’s publisher, or 503 without one |
| E41 | refence must be boolean (400); a failed ceremony answers 409 with its reason | notes | 400, 409 | same test |
| E42 | The owner view shows stood_down and its notice | §8.2 "owner-visible notice" | state, notice | GAP (probe: held) |
| E43 | Brain's process holds no PDS credentials, so it cannot write the record behind Core | §8.2 placement | No PDS writer in brain-server | GAP (code reading: brain-server/src constructs no PDSPublisher; only core-server wire_publisher.ts:113 does) |
| E44 | Publishing is server-only: only core-server installs an A2APublisherPort | §8.2 | Phone routes answer 503 | GAP (code reading: installA2APublisher is called only in core-server boot.ts:807) |

### E.6 Claim guards and guarded steps in Core

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E45 | A publish claim needs active, switched on, not stood_down, not deactivating | notes "Claims are tied to the state" | Refused otherwise | packages/core/__tests__/a2a/publication.test.ts › the guarded steps: an attempt lands only on the state it was built on › a publish claim needs the node active, switched on, and neither stood down nor deactivating; an unpublish only active |
| E46 | An unpublish claim needs active and not stood_down; deactivating keeps it | same | Allowed in deactivating | same test |
| E47 | A claim refuses a moved projection or generation | §8.2 attempt CAS | false | … › a claim refuses a projection or a generation that moved |
| E48 | A claim refuses another publisher_epoch or instance | §8.2 attempt tuple | false | GAP (probe: held) |
| E49 | A publish claim sets card_maybe_present before the write | notes | 1 | … › a claimed publish completes, and the record is the published one, under this epoch and key |
| E50 | The claim stores expected_repo_commit_cid and expected_prior_cid | §8.2, §9 | Head and prior record CID | GAP (probe: held) |
| E51 | completePublish lands only on its own claim (late after stand-down, deactivation, newer claim) | §8.2 | false, nothing recorded | … › a late completion after a stand-down writes nothing; … after a deactivation writes nothing; … after a newer claim writes nothing |
| E52 | completeUnpublish lands only on its own claim; intent kept | §8.2 | false, maybe-present 1 | GAP (probe: held) |
| E53 | failAttempt releases, counts, keeps maybe-present | notes | failed, attempts+1 | … › a failed publish is released for a retry, counted, and the card stays maybe present: the write may have landed |
| E54 | markPublishedCurrent refuses another hash, a moved epoch, another key, an attempt in flight | notes | false | GAP (probe: held); happy path: apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › the projection › a change the card does not show is recorded without a write |
| E55 | recordFenceKey is guarded on generation and state | notes | false after stand-down | packages/core/__tests__/a2a/publication.test.ts › the guarded steps: … › the fence key is recorded at activation and after a re-sign, guarded on the generation |
| E56 | recordActivation is guarded on the starting generation and clears a stand-down | §8.2 | as stated | … › activation is guarded on the generation it began under, and clears a stand-down |
| E57 | recordStandDown is guarded on the state its verdict was judged on ("Every change here is a guarded update") | publication.ts header; notes | No stand-down over a newer activation | GAP (probe: VIOLATED; unguarded, see finding F1) |
| E58 | Activation while deactivating cancels the deactivation | not specified | State not_published, active | GAP (probe: observed cancel; no rule broken) |

### E.7 Activation: the fencing ceremony

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E59 | Fresh activation: epoch 1, fence signed by the node | §8.2 M5 vector | as stated | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › activation: the fencing ceremony › a fresh repository: epoch 1, a fence this node signed, publication active |
| E60 | Overlapping old and new servers | §8.2 M5 vector | New claims greater epoch; old stands down at next write | … › overlapping servers: the new one claims a greater epoch and publishes; the old one stands down when it next writes |
| E61 | An unverifiable fence: refused without refence; refence claims above its epoch | §8.2 | fence_unverifiable, then epoch 10 | … › a fence it cannot verify is replaced only on the owner’s word, above the epoch it claims |
| E62 | A fence landing during the ceremony loses the race; an unrelated write only restarts it | notes | lost_race; ok | … › another server’s fence landing during the ceremony loses this one the race; an unrelated write only restarts it |
| E63 | Two restores of one backup (one after the other) | §8.2 M5 vector | Later holds | … › two restores from one backup: the later activation holds; the earlier stands down at its next write |
| E64 | Two restores activating at the same moment: the second's conditional fence write fails | §8.2 "cannot both win" | One ok, one lost_race | GAP (probe: held) |
| E65 | Boot before handoff | §8.2 M5 vector | Writes nothing until activated | … › boot before handoff: the new server runs, writes nothing until activated, then takes over |
| E66 | Activation with a session that is not the node's DID writes nothing | §8.2 | repo_unreachable | … › keys › writes nothing when the PDS session is not the node’s DID |
| E67 | Activation with the repository unreachable | §8.2 | repo_unreachable, nothing written | GAP (probe: held) |
| E68 | A fence at the largest safe epoch: no overflow | §8.2 bounded epochs | Refused, nothing written | GAP (probe: held; reason reads lost_race) |
| E69 | Activation marks maybe-present and voids attempts | notes | as stated | packages/core/__tests__/a2a/publication.test.ts › the guarded steps: … › an activation marks the card maybe present: a handoff leaves the previous holder’s card under the new fence |
| E70 | Re-activation republishes the envelope under the new epoch | notes | Envelope epoch 2 | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › keys › a re-activation republishes the envelope under the new epoch |
| E71 | A successful activation is not undone by a step that read the row before it | §8.2 state machine and foreign-fence rule | Node stays active at the new epoch | GAP (probe: VIOLATED; finding F1) |
| E72 | stood_down clears only through activation; A → B → A | §8.2 M5 vector | as stated | … › handoffs › A → B → A: a stood-down server comes back only by activating again, standing the other down |
| E73 | Activation after a rotation whose refresh never ran | §8.2 M5 vector | Refused without refence | … › keys › activation after a rotation whose refresh never ran: refused without the owner’s re-fence; the old key’s node then stands down |
| E74 | Rollback attempt | §8.2 M5 vector | Stand down; activation claims above both | … › keys › a rollback attempt: an older fence of ours written back stops the node, and activation claims above both |

### E.8 The read sequence and swapCommit

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E75 | Every card put and delete carries swapCommit = the head from step (1) | §8.2 | as stated | Fake PDS enforces it in every apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts test; explicit probe (held) |
| E76 | A head that moves between (1) and (3) restarts the sequence | §8.2 step 3 | Restart, then write lands | GAP (probe: held) |
| E77 | A head that never settles: bounded retries, no write, no claim, no stand-down | notes (3 tries) | Quiet failure | GAP (probe: held) |
| E78 | Fence write between steps 3 and 4: publish with no card yet | §8.2 race vector | Nothing written, stand-down | … › a fence landing between the reads and the write › a publish with no card yet: nothing is written, and the node stands down |
| E79 | … for a delete | §8.2 race vector | Delete fails, stand-down | … › a delete: it fails, the card is the new holder’s to answer for, and the node stands down |
| E80 | Unrelated repo write: lost swap, retried after 5 s | §8.2 race vector | Lands on retry | … › an unrelated write: the swap is lost, retried soon, then lands |
| E81 | The fence write carries swapCommit and swapRecord (null when absent) | notes | null sent | GAP (probe: held; PDS client sends swapRecord: null) |

### E.9 Recovery by evidence and the durable attempt

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E82 | Lost swap over an older card is not success | §8.2 | Only the attempted digest counts | … › a fence landing between the reads and the write › a lost swap over an older card is not taken for success: only the record attempted counts |
| E83 | Ambiguous timeout over our own older record | §8.2 M5 vector | Not success; retry publishes | … › handoffs › an ambiguous timeout over our own older record: not taken for success; the retry publishes |
| E84 | Newer cadence record of ours during recovery | §8.2 M5 vector | Re-run desired state | … › handoffs › a newer cadence record of ours during recovery: some other write, so the current desired state runs again |
| E85 | Ambiguous delete | §8.2 M5 vector | Gone = done; present = retry | … › handoffs › an ambiguous delete: gone means done; still there means retry |
| E86 | Cadence against a config change | §8.2 M5 vector | Refresh lands, new card follows | … › the durable attempt › cadence against a config change: the refresh lands, then the new card follows |
| E87 | Cadence against toggle-off | §8.2 M5 vector | Refresh lands, card goes | … › the durable attempt › cadence against the switch turned off: the refresh lands, then the card goes |
| E88 | Late success | §8.2 M5 vector | Writes nothing over newer | … › the durable attempt › a late success (a restart while an answer was held) writes nothing over the newer publish |
| E89 | Late failure | §8.2 M5 vector | Changes nothing | … › the durable attempt › a late failure (a request held while a newer publish lands) changes nothing |
| E90 | Crash between PDS success and local CAS | §8.2 M5 vector | Switch-off still deletes | … › the durable attempt › a crash between the PDS’s success and the local record, the read-back failing too: switching off still deletes it |
| E91 | Restart convergence | §8.2 | Claim taken over, row matches repo | … › the durable attempt › restart convergence: a claim left by a process that died is taken over, and the row ends as the repository is |
| E92 | Concurrent edit while the card is built | §8.2 | Claim refused; next step publishes newer | … › the projection › a concurrent edit while the card is built: that claim is refused, and the next step publishes the newer card |
| E93 | Listing deleted | §8.2 | Card goes | … › the projection › a listing deleted: the projection moves and the card goes |
| E94 | Retry delays 5 s, 30 s, 2 min, 10 min, then 30 min | notes | as stated | Partial (5 s and 30 s used in tests); GAP for the full schedule (probe: held) |
| E95 | A write the PDS applies after the sender gave up | notes open question | Recorded | GAP (recorded open question; not probed) |

### E.10 card_maybe_present: the evidence-based unpublish intent

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E96 | A lost first publish (answer and read-back lost) is still deleted on switch-off | notes review round 1 | Deleted | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › the durable attempt › after an unpublish, a publish whose answer and read-back are both lost is still deleted when the switch goes off |
| E97 | Handoff to a switched-off server deletes the old holder's card | notes review round 1 | Deleted | … › handoffs › predicate false on the new server: it deletes the card the old one left, and the old one stands down |
| E98 | Only evidence clears the intent | notes | 0 only after delete or empty read | packages/core/__tests__/a2a/publication.test.ts › the guarded steps: … › an unpublish clears what was published, and only it clears the evidence bit |
| E99 | Absent-card handoff | §8.2 M5 vector | Reads, finds none, writes only its fence | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › handoffs › an absent card (fence present, card unpublished): the new server reads, finds none, and writes only its fence |
| E100 | Old node's unpublish after handoff | §8.2 M5 vector | Stand-down, new card stays | … › handoffs › the old node’s unpublish after a handoff stands it down and leaves the new holder’s card |
| E101 | Delayed old-node retry | §8.2 M5 vector | Stand-down, new card stays | … › handoffs › a delayed old-node retry stands down; the new holder’s card stays |
| E102 | An unpublish does not wait for the card key | §8.2 | Deleted | GAP (probe: held) |

### E.11 The 14-day refresh

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E103 | Every 14 days the envelope's freshness epoch moves; card bytes unchanged | §8.2 trigger (b) | freshness 1, same card | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › cadence › refreshes every 14 days with a new freshness epoch, the card bytes unchanged |
| E104 | Boundary: 14 days less 1 ms reads and writes nothing; at 14 days a new record CID | §8.2 | as stated | GAP (probe: held) |
| E105 | A projection change that leaves the card unchanged records the revision, writes nothing (no byte-identical put) | §8.2; notes | No write | … › the projection › a change the card does not show is recorded without a write |
| E106 | Reference PDS to Jetstream: the cadence bump is a real commit and advances indexed_at | §8.2, §12 M5 done-when | indexed_at moves | GAP (needs a reference PDS and AppView; not runnable here) |
| E107 | A remote publisher's cadence refresh does not flip a Lane 1 registration to changed | §8.2 M1/M5 cross-test | Bindings intact | GAP (cross-area; card byte stability shown by E103 and E129) |

### E.12 Key rotation

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E108 | dina_signing rotation re-signs the fence (epoch and instance kept) and the envelope at once | §8.2 trigger (c); notes | Both verify under the new key | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › keys › a rotation before any refresh: the fence is re-signed, keeping epoch and instance, and the envelope at once |
| E109 | Rotation on an idle active node re-signs the fence, writes no card | notes | as stated | … › keys › a rotation on an active node with nothing published still re-signs its fence at once, and writes no card |
| E110 | Rotation while deactivating: the delete still runs under the old fence | §8.2 | Deleted, inactive | GAP (probe: held) |
| E111 | A new card key changes the card bytes, so it republishes | notes | Republish | GAP for an explicit card-key change (code reading: boot hard-codes generation 0 for the card and for the DID document, boot.ts:693 and :797) |
| E112 | "Any DID-document change" re-signs and republishes | §8.2 trigger (c) | Re-sign | GAP (not built beyond key-id compare; other document changes leave signed bytes valid; not probed) |

### E.13 Two-phase deactivation

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E113 | Begin only from active; complete only from deactivating | §8.2 | as stated | packages/core/__tests__/a2a/publication.test.ts › the guarded steps: … › deactivation is two-phase: only from active, and completed only from deactivating |
| E114 | Deactivate deletes the card, then inactive | §8.2 | Card gone | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › handoffs › an absent card (fence present, card unpublished): … (uses deactivate) |
| E115 | Crash before the delete: a restart resumes in deactivating and finishes | §8.2 M5 vector | Deleted, inactive | GAP (probe: held; note deactivate() answers {ok:true} while still deactivating) |
| E116 | Crash after the delete, before the local record: a restart reads none and finishes, no extra writes | §8.2 M5 vector | as stated | GAP (probe: held) |
| E117 | Concurrent activation elsewhere: the conditional delete fails, the node stands down, the card stays | §8.2 M5 vector | as stated | GAP (probe: held) |
| E118 | Deactivate on an inactive node | §8.2 | not_active, nothing written | GAP (probe: held) |
| E119 | Deactivating keeps only the delete authority: never a put | §8.2 | No put | GAP at publisher level (probe: held); Core: E45 test |
| E120 | Owner re-activation while the deactivation delete is in its reads | §8.2 | Activation stands | GAP (probe: VIOLATED; finding F1) |

### E.14 Stand-down

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E121 | Greater-epoch foreign fence: stood_down, notice another_server_publishing | §8.2 | as stated | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › activation: the fencing ceremony › overlapping servers: … |
| E122 | Same epoch under another instance | §8.2 | stood_down | GAP (probe: held) |
| E123 | Fence missing while active | notes ("fence_missing") | stood_down, no write | GAP (probe: held) |
| E124 | Stand-down voids attempts in flight | §8.2 | Late completion refused | packages/core/__tests__/a2a/publication.test.ts › the guarded steps: … › a late completion after a stand-down writes nothing |
| E125 | A stood-down node writes nothing, whatever changes | §8.2 | No write | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › the predicate: … › a stand-down during in-flight I/O: …; probe (held, no reads either) |
| E126 | Never stand down on the node's own current fence | §8.2 foreign-fence rule | No stand-down | GAP (probe: VIOLATED; finding F1) |

### E.15 Quiet nodes: no repository reads with nothing to do

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E127 | Active, published, unchanged: no reads, no writes | notes "No reads when nothing changed" | 0 reads | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › the projection › nothing changed: no write, and no read of the repository either |
| E128 | Inactive node switched on: no reads | §8.2 boot-inactive | 0 reads | GAP (probe: held) |
| E129a | Stood-down node: no reads | §8.2 | 0 reads | GAP (probe: held) |
| E129b | After a re-sign is recorded: no reads | notes | 0 reads | … › keys › a rotation on an active node with nothing published still re-signs its fence at once, and writes no card |

### E.16 Record shape, card bytes, lexicons, envelope, fence, digest

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E129 | Record: canonical card string, verifying envelope bound to did/collection/rkey, endpoint, protocol_version, skill ids; 64-byte Ed25519 sig | §8.2 | as stated | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › consent › activated with listings but the switch off: nothing is published until the owner switches it on |
| E130 | The card field carries no directory-lifecycle field | §8.2 | None | same test; probe on a real built card (held) |
| E131 | Card bytes deterministic (RFC 6979) and byte-identical to what the gateway serves | §8.2; A2A-I13; notes | Same bytes | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › serves the card’s canonical bytes, whatever order Core’s object has; determinism GAP (probe: held) |
| E132 | A card over the 128 KB lexicon cap | lexicon card.json maxLength; AppView refuses (card_too_large) | Not publishable | GAP (probe: publisher writes it and records published; finding F3) |
| E133 | Card and fence lexicons keyed literal:self | §8.2 | as stated | packages/a2a/__tests__/lexicons.test.ts › the %s record is %s, keyed literal:self |
| E134 | Card record members and the 128 KB cap | §8.2, §8.3 | as stated | packages/a2a/__tests__/lexicons.test.ts › the card record names the members the publisher writes, and the 128 KB cap |
| E135 | Fence members and domain | §8.2 | as stated | packages/a2a/__tests__/lexicons.test.ts › the fence names exactly the signed members, and its domain |
| E136 | Only the two records | §8.2 | as stated | packages/a2a/__tests__/lexicons.test.ts › the lexicons are exactly the two records, and use only types Lexicon has |
| E137 | Envelope golden vectors | §8.2, M0 | Byte-exact | packages/a2a/__tests__/directory_envelope.test.ts › golden vectors: directory envelope › hashes the exact card string bytes; … › reproduces the frozen envelope byte for byte; … › verifies against the record it arrived in |
| E138 | Envelope replay across DID, collection, rkey, card | §8.2 | Refused | … › refuses another repository (replay across DIDs); refuses another collection (cross-record replay); refuses another rkey; refuses a different card |
| E139 | Envelope other key, tampered epoch, malformed fields, extra or missing members, malformed signing | §8.2 | Refused | … › refuses a signature by another key; refuses a tampered epoch even though the shape is fine; shape check refuses %s; refuses extra or missing members; will not sign a malformed envelope |
| E140 | Fence vectors: frozen bytes, own repo, other DID, domain separation, raised-epoch replay, throwing verifier | §8.2 | as stated | … › golden vectors: fence › reproduces the frozen fence byte for byte; verifies when read from its own repository; refuses a fence read from another repository (signed for another DID); refuses an envelope presented as a fence (domain separation); refuses a replayed fence with a raised epoch; treats a verifier that throws as a failed signature |
| E141 | Attempted-record digest vectors | §8.2 | as stated | … › golden vectors: attempted-record digest › reproduces the frozen digest; ignores member order (a fetched record canonicalizes the same); changes with an envelope-only cadence bump and with a sibling change; distinguishes two different records from the same instance |
| E142 | Cross-runtime frozen refusals and JCS forms | §8.2, M0 | as stated | … › golden vectors: frozen refusals and canonical forms (another runtime replays these) › envelope: %s; fence: %s; jcs: %s; hashes and digests a card with non-ASCII, astral and U+2028 text byte for byte |
| E143 | Multikey Ed25519 and P-256 | notes | Both ways | packages/a2a/__tests__/multikey.test.ts › base58btc › round-trips %j; refuses a character outside the alphabet; multikeys › Ed25519: the z6Mk form did:key uses, both ways; P-256: the zDn form, a compressed point, both ways; reads nothing from the other kind, a wrong length, or a non-z multibase |

### E.17 The card key in the DID document

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E144 | No card before the DID document names #a2a_card | plan §4.6 As built | Held back | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › the predicate: … › no card goes out before the DID document names the card key |
| E145 | cardKeyCheck remembers success, backs off after failure | notes | as stated | … › cardKeyCheck › true once the key is there, remembered; after a failure, not asked again before the retry delay |
| E146 | Key already present: no write | notes | present | packages/home-node/__tests__/a2a_card_key.test.ts › writes nothing when the document already names the key |
| E147 | Chained update that sets only a2a_card, prev = CID of the last op, keeps the rest, signed | notes | as stated | … › adds the key in a chained update that keeps every other field, signed |
| E148 | Replaces an older card key | notes | Replaced | … › replaces an older card key after a rotation |
| E149 | Throws on an unreadable or empty audit log or no rotation keys | notes | No write | … › throws on an audit log it cannot read, writing nothing; … an empty audit log …; … a last operation with no rotation keys … |
| E150 | The posted key decodes to the 33-byte compressed P-256 key the card signs with | plan §3.22 | Same key | GAP (probe: held) |
| E151 | A PLC refusal throws, so the card stays held | notes | Throws | GAP (probe: held) |
| E152 | Tombstone or legacy-format last op | robustness | Throws, no write | GAP (probe: held) |
| E153 | A last audit entry marked nullified | robustness | Not chained onto | GAP (probe: inconclusive; it chains onto it, but PLC lists the live fork op last, so this input should not arise) |

### E.18 The PDS client

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E154 | getLatestCommit reads the head; fails closed | plan §3.15 | as stated | packages/brain/__tests__/pds/publisher.test.ts › PDSPublisher › repository-head preconditions (A2A design §8.2) › reads the repository head; fails closed on a response without a cid; fails closed on a refusal |
| E155 | swapCommit on put and delete; InvalidSwap is casLost | plan §3.15 | as stated | … › sends swapCommit on a put and on a delete, and reads a lost swap as casLost |
| E156 | swapRecord null is sent as null | §8.2 fence write | null in body | GAP (probe: held) |
| E157 | A 5xx is not a lost swap; getLatestCommit on 5xx or empty cid fails closed | plan §3.15 | as stated | GAP (probe: held) |

### E.19 The session DID check

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E158 | Session DID checked before every write: fence, card put, card delete | §8.2 | No write | activation: apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › keys › writes nothing when the PDS session is not the node’s DID; publish and delete: GAP (probe: held) |
| E159 | Reads go to the node's own repository; a session error never reads as a foreign or missing fence | §8.2 read sequence; session check | No stand-down | GAP (probe: VIOLATED; finding F2) |

### E.20 Boot wiring and process lifecycle

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E160 | Publisher starts only with a PDS and a card configuration; otherwise activation answers 503 | notes iteration "M5 steps 1–2" | No port installed | GAP (probe: held; booted with DINA_A2A_PUBLIC_URL and no PDS: card config set, no publisher) |
| E161 | Stopped and uninstalled on close | notes | No port after close | GAP (probe: held for the no-PDS boot; the PDS path read at boot.ts:1214-1216) |
| E162 | A stopped publisher takes no further step | notes | No write | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › activation: the fencing ceremony › a restored node with an eligible card writes nothing until the owner activates it |
| E163 | Envelope and fence keys are the dina_signing key named in the DID document | §8.2, plan §3.22 | Same derivation | GAP (code reading: boot.ts:546 and :776 both use deriveIdentity(...).root) |

### E.21 Cross-cutting M5 proofs and threat rows (§10)

| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| E164 | Two-process Brain-cannot-publish | §8.2, §12 M5 | Refused | packages/core/__tests__/a2a/publication.test.ts › the owner routes › %s %s is the owner’s alone: Brain cannot publish, in one process or two |
| E165 | Publish → ingest → search → getCard end to end | §12 M5 | Works | GAP (AppView E2E; not in this area's runnable set) |
| E166 | Talk, unlisted and known_only listings never enter the published card | §10 "Contact-service reach"; §8.5 | Absent | packages/core/__tests__/a2a/inbound_card.test.ts › leaves out commerce, schema-less, reserved-lane, unbound and non-public capabilities, whatever a row says (the publisher builds the same public card, boot.ts:787) |
| E167 | Directory copy equals the live card bytes (A2A-I13 relay) | A2A-I13 | Same bytes | apps/home-node-lite/a2a-gateway/__tests__/server.test.ts › serves the card’s canonical bytes, whatever order Core’s object has; plus E129 |
| E168 | Lane 3 publishing is owner-opted, never pushed (Silence First) | §11 | Default off | E5, E36 |

Totals: 170 scenarios (E1–E168 plus E129a and E129b). 62 had no existing test (GAP). The probes covered 45 of those 62 and found 3 breaks (F1 twice through E57/E71/E120/E126, F2 at E159, F3 at E132). The rest are recorded open questions, need a reference PDS or AppView, need the phone adapter, or were settled by code reading.

### Gap closure, area E

Every GAP row above, and the completeness critic's scenarios (X-n), with what now holds it.

| Row | Closed by | Test or reason |
|---|---|---|
| E7 | owed | Recorded open question (notes 'M5: a raw copy of the database'): no rule yet says what boot should do with a copied database, so there is nothing to hold. |
| E8 | owed | Needs a phone: v59 and its triggers on the op-sqlite adapter cannot run under jest. |
| E9 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the projection revision › on an install with no publication row, a plugin-update rebind succeeds, bumps only the listing, and makes no row (saves half already in publication.test.ts) |
| E15 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the projection revision › a plugin-update rebind moves the projection, so the publisher looks again |
| E17 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the projection revision › the bump is inside the writer’s transaction: a write rolled back leaves the revision where it was |
| E25 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › the predicate drives the card › a card build refused for any reason counts as predicate-false: the card goes |
| E26 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › the predicate drives the card › a card build that throws ends the step with nothing written or deleted; the next step recovers |
| E31 | owed | Recorded open question (notes 'M5: "gateway live"'): the build reads it as 'a public origin is configured'; whether the gateway process must be up has no rule yet. |
| E38 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the owner routes › %s %s refuses an owner caller with the wrong capability, or none, and makes no row |
| E39 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the owner routes › %s %s refuses every caller but the owner, in one process and in two, capability or not |
| E42 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the owner routes › the owner’s view shows a stand-down and why |
| E43 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_boot.test.ts › placement › Brain’s server builds no PDS writer and no card publisher: it cannot write the card behind Core |
| E44 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_boot.test.ts › placement › publishing is server-only: core-server’s boot is the one place a card publisher is installed (503 without one: publication.test.ts › the owner routes › activation and deactivation go to the host’s publisher, or 503 without one) |
| E48 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the guarded steps › a claim names the epoch and instance it was built under: another of either is refused |
| E50 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the guarded steps › a claim stores the head it read and the record it expects to replace; a completion clears both |
| E52 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the guarded steps › an unpublish lands only on its own claim: after %s it records nothing, and the card stays maybe present |
| E54 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the guarded steps › the record there answers for a new revision only if it is this card, under this epoch and key: refused for %s; and › …and with nothing moved but the projection, it does answer for the new revision |
| E57 | existing test | packages/core/__tests__/a2a/publication.test.ts › the guarded steps: an attempt lands only on the state it was built on › a stand-down judged against a row an activation has since moved lands nothing |
| E58 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the guarded steps › an activation during a deactivation moves the generation: the pending delete lands nothing, and the deactivation cannot complete over it |
| E64 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › activation › two restores activating at the same moment cannot both win: the second fence write fails on the moved head |
| E67 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › activation › an unreachable repository: activation writes nothing and the node stays inactive |
| E68 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › activation › epochs stay bounded safe integers: above %s at the largest safe epoch, nothing is written |
| E71 | existing test | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › keys › the owner re-activating during a step’s reads: the step’s stale verdict lands nothing, the activation stands |
| E76 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › the read sequence › a head that moves between the two head reads restarts the sequence, and the write then lands on the settled head |
| E77 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › the read sequence › a head that never settles: the sequence restarts a bounded number of times, then claims, writes and stands down nothing |
| E81 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › activation › the fence write is conditional on the head and on the fence it replaces: null when there was none |
| E94 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › retries › a failing publish waits 5 s, 30 s, 2 min, 10 min, then 30 min, and reads nothing while it waits |
| E95 | owed | Recorded open question (notes 'M5: a write that lands after its sender gave up'): accept the window or move the head first is undecided, so no rule to hold. |
| E102 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › the predicate drives the card › an unpublish does not wait for the card key: switched off, the card goes though the DID document is not ready |
| E104 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › the 14-day refresh › 14 days less 1 ms reads and writes nothing; at 14 days the record is a new commit with the same card |
| E106 | owed | Needs Docker: a reference PDS, Jetstream and AppView to show the cadence bump is a real commit that advances indexed_at. |
| E107 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the card under one key and under the next › another Dina’s Lane 1 pin of this card: a rebuild with nothing changed keeps it, a new card key changes it |
| E110 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › keys › a rotation while deactivating: the delete still runs under the fence as it stands, and no fence is written |
| E111 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_card_key.test.ts › a new card key reaches the DID document before any card it signs goes out, and the new card republishes on its own; packages/core/__tests__/a2a/lane3_publish_state.test.ts › the card under one key and under the next › a new card key gives new card bytes, and Core hands the gateway the card and the key set that verifies it in one answer |
| E112 | new test | Notes read trigger (c) as either key the directory checks: card key: lane3_publish_card_key.test.ts › a new card key reaches the DID document before any card it signs goes out, and the new card republishes on its own; dina_signing: a2a_card_publisher.test.ts › keys › a rotation before any refresh: the fence is re-signed, keeping epoch and instance, and the envelope at once; any other document change feeds no publisher input: a2a_card_publisher.test.ts › the projection › nothing changed: no write, and no read of the repository either |
| E115 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › two-phase deactivation › a crash before the delete: the restarted node resumes in deactivating and finishes |
| E116 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › two-phase deactivation › a crash after the delete, before the local record: the restarted node reads no card, finishes, and writes nothing more |
| E117 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › two-phase deactivation › an activation elsewhere during the delete: the conditional delete fails, the node stands down, and the card stays |
| E118 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › two-phase deactivation › deactivating an inactive node is refused, and touches the repository not at all |
| E119 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › two-phase deactivation › while deactivating the one authority is the delete: a changed card and a due refresh put nothing |
| E120 | existing test | packages/core/__tests__/a2a/publication.test.ts › the guarded steps: an attempt lands only on the state it was built on › a stand-down judged against a row an activation has since moved lands nothing; apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › keys › the owner re-activating during a step’s reads: the step’s stale verdict lands nothing, the activation stands |
| E122 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › stand-down › a fence at this node’s epoch under another instance is foreign: the node stands down and writes nothing |
| E123 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › stand-down › a fence gone while active stands the node down (fence_missing), with no write |
| E125 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › quiet nodes › a stood-down node reads and writes nothing, whatever changes |
| E126 | existing test | packages/core/__tests__/a2a/publication.test.ts › the guarded steps: an attempt lands only on the state it was built on › a stand-down judged against a row an activation has since moved lands nothing; apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › keys › the owner re-activating during a step’s reads: the step’s stale verdict lands nothing, the activation stands |
| E128 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › quiet nodes › an inactive node switched on reads nothing |
| E129a | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › quiet nodes › a stood-down node reads and writes nothing, whatever changes |
| E131 | new test | packages/core/__tests__/a2a/lane3_publish_state.test.ts › the card under one key and under the next › the card’s bytes are deterministic: built twice under one key, the same canonical bytes (byte match with the gateway already in a2a-gateway/__tests__/server.test.ts) |
| E132 | existing test | apps/home-node-lite/core-server/__tests__/a2a_card_publisher.test.ts › the predicate: each input, and restoring it › a card over the directory’s cap is not publishable: none goes out, and one already there is taken down |
| E150 | new test | packages/home-node/__tests__/lane3_publish_card_key.test.ts › the key it posts decodes to the 33-byte compressed P-256 key the card is signed with |
| E151 | new test | packages/home-node/__tests__/lane3_publish_card_key.test.ts › a PLC directory that refuses the update makes it throw, so no caller takes the key as there; apps/home-node-lite/core-server/__tests__/lane3_publish_card_key.test.ts › a PLC directory that refuses the update keeps the card back; once it accepts, after the retry delay, the card goes out |
| E152 | new test | packages/home-node/__tests__/lane3_publish_card_key.test.ts › a last operation that is %s is not chained onto: it throws and posts nothing |
| E153 | owed | No rule in the design, plan or notes covers a nullified last audit entry, and the PLC directory lists the live fork operation last; the real shape needs a live PLC directory with a nullified fork. |
| E156 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_pds_wire.test.ts › the first fence goes out with swapRecord: null on the wire, and a later one names the fence it replaces |
| E157 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_pds_wire.test.ts › a server failure is not a lost swap › a 5xx on the card put waits the failure schedule; only an InvalidSwap waits the short lost-swap delay; › a head read %s fails closed: nothing is claimed, written or stood down |
| E158 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › the predicate drives the card › the session is checked before every card write: under another DID no put and no delete goes out |
| E159 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › the read sequence › a repository read that fails is never taken for a missing or foreign fence: no stand-down, no write (the reads-under-another-session half was judged not a breach by the verifier) |
| E160 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_boot.test.ts › boot › a card configuration without a PDS starts no publisher: the switch works, activation answers 503, and close leaves nothing installed |
| E161 | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_boot.test.ts › boot › a card configuration without a PDS starts no publisher: the switch works, activation answers 503, and close leaves nothing installed (close uninstalls the port and the card config; a stopped publisher writing nothing is a2a_card_publisher.test.ts › activation: the fencing ceremony › a restored node with an eligible card writes nothing until the owner activates it). Booting a real publisher and seeing close stop it needs a live PDS. |
| E163 | test added with the fix | apps/home-node-lite/core-server/__tests__/lane3_publish_boot.test.ts › the fence and the card’s directory envelope are signed with the dina_signing key boot put in the DID document |
| E165 | owed | Needs Docker: publish, ingest, search, getCard end to end takes a reference PDS, Jetstream and the AppView with Postgres. |
| X-1: Card-key rotation end to end: the card key moves to a new generation; ensureA2ACardKey puts the new key in the DID document before the new card is published; gateway serves new card and jku key set together; AppView re-verifies; another Dina's Lane 1 pin changes | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_card_key.test.ts › a new card key reaches the DID document before any card it signs goes out, and the new card republishes on its own; packages/core/__tests__/a2a/lane3_publish_state.test.ts › the card under one key and under the next › a new card key gives new card bytes, and Core hands the gateway the card and the key set that verifies it in one answer; … › another Dina’s Lane 1 pin of this card: a rebuild with nothing changed keeps it, a new card key changes it; AppView part already covered: appview/tests/integration/a2a_directory.test.ts › keys: a card never outlives the key that justified it › rotation before republish: the identity event withholds the card; the republish under the new key restores it |
| X-2: A publish fails (state failed, next_retry_at set) and core-server restarts before the retry is due | new test | apps/home-node-lite/core-server/__tests__/lane3_publish_publisher.test.ts › retries › a failed publish across a restart: the new process waits out the stored backoff, then publishes once under a fresh claim |

---

## Area F: test plan (M5 step 3, the AppView directory; M5 step 4, search_a2a_agents)

Legend of test files (titles are cited exactly; "›" separates file and title):
- [CV] appview/tests/unit/a2a_card_verify.test.ts
- [DR] appview/tests/unit/a2a_did_resolver.test.ts
- [DD] appview/tests/unit/a2a_directory_decide.test.ts
- [JC] appview/tests/unit/06-jetstream-consumer.test.ts, describe 'SS6.A2A card, identity and account events reach the A2A directory' (and its nested 'liveness: a live note needs proof the socket delivers and the replay is over')
- [IC] appview/tests/unit/02-ingester-components.test.ts
- [AL] appview/tests/unit/admin_audit_log.test.ts
- [AD] appview/tests/integration/a2a_directory.test.ts
- [DB] appview/tests/integration/11-database-schema.test.ts
- [LX] packages/a2a/__tests__/lexicons.test.ts ; [EV] packages/a2a/__tests__/directory_envelope.test.ts
- [BT] packages/brain/__tests__/a2a/a2a_directory_tool.test.ts ; [BH] packages/brain/__tests__/appview_client/http.test.ts ; [BC] packages/brain/__tests__/composition/agentic_ask.test.ts
- Probes (written, run, then deleted): P-U* = appview/tests/unit/zz_wf_probe_F.test.ts, P-I* = appview/tests/integration/zz_wf_probe_F.test.ts, P-B* = packages/brain/__tests__/a2a/zz_wf_probe_F.test.ts

"GAP" means no existing test; the probe that filled it follows the arrow.

### Recording: spool before acknowledgement
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| F1 | Card event committed to a2a_event_spool before receive resolves | §8.3 persist-before-ack | receive pending while insert fails; one row after | [AD] › persist before acknowledge: receive does not resolve until the row is committed |
| F2 | Recording ignores the flag | §8.3 "gates processing, never recording" | row pending, nothing processed or served | [AD] › records while off, stamps the gap generation, processes nothing, and serves nothing |
| F3 | Spool insert keeps failing | §8.3 backpressure over loss | retried forever, event holds cursor | [AD] › persist before acknowledge…; [IC] › UT-BQ-003b: a required item (an A2A card event) is never dropped: taken past capacity, held in the safe cursor |
| F4 | Full queue takes card events | notes: required items | pushed past capacity, socket paused | [IC] › UT-BQ-003b…; [JC] › the socket stamps card events with the generation the last gap check returned, and never drops card or account events |
| F5 | Card events never hit the dead-letter or file spool | §8.3 exemption | none | partial: [JC] same test (push path); processing path GAP, code reading: receive's persist() never throws for a self/TID event |
| F6 | Account events never dropped | notes | required:true | [JC] › the socket stamps card events… |
| F7 | Stamp = gap generation at socket receipt, carried in queue context | §8.3, notes | receive(event, gen) | [JC] › a card event goes to the directory with the trust flag OFF…; [JC] › the socket stamps card events… |
| F8 | Unstamped (file spool) event never proves | notes | stamp -1 | [JC] › a card event with no receipt stamp (replayed from the file spool) is recorded as unstamped: it never proves |
| F9 | Same event twice = one row, one transition | §8.3 identity | one done row | [AD] › a delivery twice (a reconnect replay) is one row and one transition |
| F10 | Equal-rev different op/payload = separate rows | §8.3 identity incl. op + hash | conflict detected | [AD] › an equal-revision conflict (…) (4 cases) |
| F11 | rkey ≠ self refused at receipt | §8.3 rkey=self on create/update/delete | rejection row, no spool row | [AD] › an rkey other than self, or a revision that is not a TID, is refused at receipt and touches nothing |
| F12 | rev not a TID refused | §8.3 commit.rev token | rejection | same test |
| F13 | U+0000 in a record does not stall the spool | notes: payload JSON text | insert lands, card refused | GAP → P-I13 held |
| F14 | Card events bypass trust_v1_enabled and trust gates | §8.3 | trust flag never read | [JC] › a card event goes to the directory with the trust flag OFF, and nothing of the trust path runs |
| F15 | Consumer subscribes to the card collection; not a trust collection; fence not indexed | §8.3, §8.2 | lists as stated | GAP → P-U16 held |
| F16 | Crash between insert and ack | §8.3 vector | replay deduped | [AD] › a delivery twice… |
| F17 | Crash mid-drain (dead lease) | §8.3 vector | waits for lease, then processed | [AD] › a processor that died holding a lease: the row waits for the lease, then is processed |

### Ordering and the pure decision module
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| F18 | Per-repo revision order; earliest pending only | notes | blocked earlier rev holds later; other DIDs proceed | [AD] › updates and deletes while off drain in revision order; P-I12 held |
| F19 | Delayed old update | §8.3 vector | stale | [AD] › a delayed old update is stale; [DD] › stale and replayed events change nothing (a delayed update, a tombstone resurrection attempt) |
| F20 | Equal-rev identical replay | §8.3 | no-op | [DD] › equal: the same operation and hash replay; anything else conflicts |
| F21–F24 | Equal-rev conflict update→delete / delete→update, live / spooled | §8.3 both arrival orders | unavailable, both kept | [AD] › an equal-revision conflict (update then delete, live) / (delete then update, live) / (update then delete, spooled) / (delete then update, spooled): unavailable, both events kept; a newer valid record clears it; [DD] › an equal-revision conflict, whatever arrives first |
| F25 | Conflict cleared by newer valid | §8.3 | served again | same 4 tests |
| F26 | Third distinct event at the conflicting rev | §8.3 "both events retained"; notes "every spool row they rest on" | all conflicting rows kept | GAP → P-I2 VIOLATED (finding F-2) |
| F27 | CID-less delete | §8.3 vector | tombstone row kept | [AD] › a delete carries no CID; a create older than it never brings the card back; [DD] › a newer delete tombstones, with no verdict needed (a delete carries no CID) |
| F28 | Tombstone resurrection | §8.3 | stays deleted | [AD] same |
| F29 | Delete racing create | §8.3 | delete wins by rev | [AD] › delete racing create: the delete lands first, the older create after it is stale |
| F30 | Valid→invalid→valid | §8.3 newer-invalid | withheld with evidence, then served | [AD] › valid → invalid → valid: a newer invalid record withholds the older card, with evidence; [DD] › a newer valid record replaces; a newer invalid one suppresses |
| F31 | Replayed old invalid | §8.3 | never suppresses newer valid | [AD] › a replayed old invalid record never withholds a newer valid one |
| F32 | CAS on repo_rev under row lock | §8.3 | moved row re-decided | code reading (apply WHERE c.repo_rev < EXCLUDED.repo_rev; RowMoved); [AD] › a key rotated while %s is being checked… |
| F33 | TIDs compare as strings | §8.3 | time order | [DD] › revisions compare as TIDs: their string order is their time order |
| F34 | Event hash identity | notes | equal for redelivery, differs otherwise; no throw on non-canonical | [DD] › equal for two deliveries of one commit, different for another operation, CID or record; [DD] › hashes a record with no canonical form too (a __proto__ member), without throwing |
| F35 | PLC unavailable → retry (5s…30m) | notes | pending, retried | partial: [AD] › the PLC directory not answering is no verdict: the event waits and is processed later (schedule values untested) |
| F36 | Unknown DID (404) | notes | invalid record | [AD] › a DID the directory does not know, or a document that stops resolving, is an invalid record |
| F37 | Two processors on one spool (rolling deploy) | §9 "all transitions CAS" | each event once, newest rev wins | GAP → P-I11 held |

### The card check
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| F38–F42 | collection, rkey self, object, exact members, card string | §8.3 | refused | [CV] › refused, with the reason › collection / rkey_not_self / record_not_object / record_members / card_not_string |
| F43 | 128 KB cap | §8.3 | >cap refused; exactly 131072 accepted | [CV] › … › card_too_large; boundary GAP → P-U1 held |
| F44 | Strict JSON (duplicate keys) | M0 | refused | [CV] › … › card_not_json |
| F45 | Canonical JCS bytes | §8.2/notes | whitespace and member order refused | [CV] › … › card_not_canonical; member order GAP → P-U3 held |
| F46 | No U+0000 (strings, member names) | notes | refused | [CV] › … › card_nul_character; names GAP → P-U4 held |
| F47 | v1.0 shape | §8.3 | refused | [CV] › … › card_skills_required |
| F48 | #a2a_card missing | §8.3, D4 | refused | [CV] › … › card_key_missing |
| F49 | ES256 against #a2a_card only; jku never fetched | §8.3, plan §3.22 | foreign key, tampered card, EdDSA by dina_signing refused | [CV] › … › card_signature (2 cases); EdDSA GAP → P-U2 held; jku: code reading |
| F50 | Several signatures, one valid | plan §2 row 9 | verified | GAP → P-U8 held |
| F51 | Extension did = repo | §8.3 | refused | [CV] › … › extension_did |
| F52 | JSON-RPC interface required | notes | REST never stands in | [CV] › a signed card with no JSON-RPC interface: the REST one never stands in for it |
| F53 | Siblings equal the card | §8.3 per-field vectors | refused | [CV] › … › sibling_endpoint / sibling_protocol_version / sibling_skills |
| F54 | Strict qualified skills | §8.3 | malformed refused | [CV] › … › skill_malformed; rkey grammar GAP → P-U7 held |
| F55 | Alias indexed under canonical, id kept | §8.3 | canonical key + exact id | [CV] › a skill named by an alias is indexed under its canonical name, its id kept exactly |
| F56 | Unknown capability | §8.3 | refused | [CV] › … › skill_unknown |
| F57 | Public-exposure rule (no unlisted/known_only/Talk) | §8.3, §8.5, §10 | refused | [CV] › … › skill_not_public |
| F58–F61 | dina_signing missing; envelope sig; hash binding; DID binding | §8.2/§8.3 | refused | [CV] › … › signing_key_missing / envelope_signature / envelope_card_hash_mismatch / envelope_did_mismatch |
| F62 | Envelope bound to rkey and collection | §8.2 | refused | [EV] (package); AppView GAP → P-U6 held |
| F63 | Envelope exact members | §8.2 | refused | [CV] › … › envelope_members |
| F64 | M0 golden vectors feed ingest | §12 M5 | frozen envelope verifies, every frozen refusal refused, via the compiled module AppView ships | GAP → P-U15 held |
| F65 | Keys from the DID document | §8.3 | both fragment forms; other DID or form → none | [CV] › reads the keys under either fragment form a DID document uses; [CV] › nothing from a document for another DID, or keys in another form; foreign-DID fragment GAP → P-U5 held |
| F66 | Derived fields from card + envelope only; AppView hash | §8.3 | as stated | [CV] › yields what the verified card and envelope say, and the hash of the exact bytes |
| F67 | Record bytes are canonical bytes | §8.2 | byte-equal | [CV] › the canonical card bytes are what the record carries, byte for byte |
| F68 | $type value | §8.3 structural | — | observation: not checked (P-U9, P-I13), no effect on served bytes |
| F69 | Endpoint scheme | — | — | observation: http/private endpoints indexed (P-U10); Brain's client drops non-HTTPS |
| F70 | did:web publisher through the directory | plan §4.6 deviation | refused, never served | GAP → P-I8 held |

### DID resolution
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| F71 | GET {plc}/{did}, redirect:error, deadline | §8.3/§6.6 | as stated | [DR] › GET {plc}/{did}, no redirects followed, a deadline on it |
| F72 | HTTPS only (HTTP only when allowed) | §6.6 | throws | [DR] › refuses a plain-HTTP directory unless allowed (development only) |
| F73 | did:plc only | deviation | did:web/malformed never fetched | [DR] › did:plc only: a did:web, or anything else, is never fetched; malformed/traversal → P-U14 held |
| F74 | Status mapping | notes | 404/410/500/302 | [DR] › HTTP %s → %j (4) |
| F75 | Redirect, reset, timeout → unavailable | §6.6 | unavailable | [DR] › a refused redirect, a reset, a timeout: unavailable, never a verdict |
| F76 | Size cap, JSON, UTF-8 | §6.6 | unavailable | [DR] › not JSON, too large (declared or streamed), or not UTF-8: unavailable |
| F77 | Concurrency bound | §6.6 | ≤ N | [DR] › runs at most the configured number of lookups at once |
| F78 | No cache | notes | current document | code reading; rotation tests |
| F79 | Private-address denial | §8.3/§6.6 | n/a | recorded deviation (did:web refused) |
| F80 | PLC URL with a path | — | — | observation P-U13: path dropped (https://plc.example/mirror/ → https://plc.example/did:…) |

### Key changes and revalidation
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| F81 | Rotation before republish; republish restores | §8.3 vector | withheld, then served | [AD] › rotation before republish: the identity event withholds the card; the republish under the new key restores it |
| F82 | Identity event during a check (update, first create) | notes in-check re-run | check re-runs | [AD] › a key rotated while %s is being checked: the check runs again against the new document (2) |
| F83 | Identity after check, before commit | notes post-commit settle | marked after commit | [AD] › an identity event landing after the check but before a first create commits is settled after commit |
| F84 | Missed identity event → daily sweep | §8.3 vector | withheld after a day | [AD] › a missed identity event: a day later the periodic check catches the rotation |
| F85 | PLC down during revalidation | notes | card keeps standing, retry in 5 min | [AD] › the PLC directory down during a check: the card keeps its standing, and the check waits |
| F86 | Identity event for a non-holder does not wake | notes | no work | code reading only |
| F87 | Only dina_signing rotates | §8.2 trigger c | withheld (envelope_signature) | GAP → P-I14 held |
| F88 | DID deactivated (410) found by sweep | §8.3 | withheld | GAP → P-I1b held for withholding, VIOLATED for evidence (F-1) |
| F89 | Consumer passes identity/account events | §8.3 | calls directory | [JC] › identity and account events are passed on (a card holder is checked again; an inactive account withheld) |
| F90 | Revalidation CAS on repo_rev | §8.3 | conditioned | code reading |

### Gap generations and liveness
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| F91 | Cursor 0 over any data (card or spool) | notes | gap; empty → none | [AD] › no cursor over a directory that holds anything is a gap, even only a spool (the directory off); over an empty one it is not |
| F92 | Cold start over existing index | §8.3 vector | all withheld until newer valid event; deleted never returns | [AD] › a cold start over an existing index withholds every card until a newer valid event; a deleted one never returns |
| F93 | Outage > retention − 10 min | notes margin | gap at 9 min margin, none at 11 | [AD] › an outage longer than Jetstream keeps events (less a clock margin) is a gap; a shorter one is not |
| F94 | Resume = later of cursor and live note | notes | quiet day no gap | [AD] › a quiet day is no gap: the resume point is the later of the cursor and the last time the consumer was live |
| F95 | Pre-gap event processed after the gap | §8.3 | applies, never proves | [AD] › an event received before the gap and processed after applies, proves nothing; only one received after proves |
| F96 | Concurrent gap-marking vs live ingestion | §8.3 vector | receipt stamp rules | [AD] › an event received before a gap but recorded after it keeps its receipt stamp: it applies, never proves |
| F97 | Late pre-gap replay after the gap | §8.3 vector | never proves (row kept or pruned; pending row keeps old stamp) | GAP → P-I9, P-I9b, P-U11 held |
| F98 | Gap check before every (re)connect; failed check does not connect | notes | as stated | [JC] › a reconnect checks for a gap first; a failed check does not connect, and the next try does |
| F99–F102 | Live note: last ping answered; nothing waiting; replay over (catch-up); note at pong time | notes | as stated | [JC] › liveness › OPEN but the last ping unanswered…; › something still waiting in the queue: no live note; › mid-replay (the last message far behind its own time, and recent): no live note; › the replay is over once the stream has been silent for a minute with pings answered; › freshly connected with no message yet: not live until a minute has passed; › answered, caught up, nothing waiting: notes live at the pong, then pings again |
| F103 | Stall terminate (90 s) | notes | terminate, no note | [JC] › no pong and no message for 90 s: the socket is terminated (a reconnect follows), nothing noted |
| F104 | Held socket never judged stalled | notes | no ping/terminate while held | [JC] › held paused by backpressure: never a stall, no ping, no note; the stall clock restarts once released |
| F105 | Socket re-pointed while full is held on open | notes | holdIfFull | [JC] › a new socket that opens onto a full queue is held at once; [IC] › UT-BQ-003c: re-pointed at a socket while full, the queue holds it once it opens (pause() does nothing while connecting) |
| F106 | One queue for the consumer's life | notes | re-pointed | [JC] › one queue for the consumer’s life: a reconnect re-points it, so earlier events keep holding the cursor |
| F107 | Both methods gate on proved generation | §8.3 | lagging rows absent | [AD] gap tests (getCard); search GAP → P-I3 held |
| F108 | Retention default 24 h | notes | env default | GAP (code: env.ts) |

### Phases
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| F109 | First create while off | §8.3 vector | served after on + drain | [AD] › a first-ever create while off is served once the flag is on and the drain is done |
| F110 | Watermark; live event does not hold opening | notes | ready when ≤ watermark done | [AD] › no premature reopening: while drained history waits, serving refuses; a live event meanwhile does not hold it |
| F111 | Premature reopen refused | §8.3 vector | 503 while draining | [AD] same (getCard); searchAgents GAP → P-I4 held |
| F112 | Unreadable flag | §8.3 vector | disabled + reconciliation_required; good read reopens | [AD] › a flag it cannot read closes the directory and is remembered; a good read reopens it |
| F113 | Off while open | notes | closed at once; recording goes on; drains on re-enable | [AD] › turned off while open: closed at once; events keep recording; turned on, they drain |
| F114 | Phase and gap read in the same statement as cards | notes | one state per answer | code reading (SERVED_GATES joins a2a_directory_state) |
| F115 | Flag defaults off | notes | false | GAP → P-U16 held |
| F116 | Operator path to turn the flag on | notes | — | GAP: no command exists (peerlens-flag-cli only sets trust_v1_enabled); observation |

### Gates
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| F117–F119 | Presence, signature, unavailable gates | §8.3 | absent / 404 | [AD] ordering and key tests via getCard; search GAP → P-I3 held |
| F120 | Takedown: re-put never lifts; restore never resurrects; precedes any card | §8.3 vectors | as stated | [AD] › an owner re-put during a takedown changes the card but never lifts the takedown; [AD] › a restore never brings back a card the owner deleted; a takedown can come before any card |
| F121 | Redaction | §8.3 | withheld, lifted → served | [AD] › a redacted DID is withheld; lifting the redaction serves it again |
| F122 | Account inactive; active again; out-of-order event ignored | deviation (fourth gate) | as stated | [AD] › an inactive account is withheld; active again, it is back; an event out of order changes nothing |
| F123 | Status taken while off | notes time rule | withheld when processed | [AD] › an account deactivated while the directory was off is withheld once its card is processed |
| F124 | Reactivation lost in gap; unknown DID | notes | next commit answers; nothing recorded | [AD] › a reactivation lost in a gap is answered by the next commit; a DID the directory never saw records nothing |
| F125 | Per-DID lock | notes | account waits for card write | [AD] › an account event waits for a card write of the same DID to commit (one per-DID lock), then sees the row |
| F126 | DID known only by a spool row | notes | status kept; later commit answers | GAP → P-I15 held |
| F127 | All gates also on searchAgents | §8.3 | absent from search | partial (redaction only) → P-I3 held |

### searchAgents and getCard
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| F128 | 503 when not ready | notes | DirectoryUnavailable | [AD] › records while off, stamps the gap generation… |
| F129 | Keyword-stuffed zero-trust below relevant trusted; non-matching excluded | §8.3 adversarial vector | order and filter | [AD] › a keyword-stuffed zero-trust card ranks below a relevant trusted one |
| F130 | skill: exact id / capability / alias; unknown none; malformed 400 | §8.3 multi-rkey | as stated | [AD] › skill: an exact id, a capability (every rkey of it), or an alias; unknown finds none; malformed is refused |
| F131 | skill and q together | §8.3 | intersection | GAP → P-I5 held |
| F132 | Fresh before stale, inclusive 30 days, AppView clock | §8.3 | boundary | [AD] › stale cards sink below every fresh one; stale means indexed 30 days ago or more, by AppView’s clock |
| F133 | Versioned cursor; foreign cursor 400 | §8.3 | every card once | [AD] › pages with a versioned cursor: every card once, in order; a cursor from another ordering is refused |
| F134 | Garbage cursor, limit 0/51 | params | 400 | GAP → P-I5 held |
| F135 | Paging with q and ties | §8.3 | every card once | GAP → P-I6 held |
| F136 | Result shape, index facts only, trust = COALESCE(did_profiles.overall_trust_score,0) | §8.3, A2A-I13 | exact shape | [AD] › each result is index facts only: the trust band beside, the card hash, never a changed card |
| F137 | Band equals resolve's | §8.3, notes | equal incl. tombstone avoid/none | [AD] › the band is resolve’s band for the same DID: scores, flags and a moderator’s tombstone all count |
| F138 | getCard verbatim bytes hash to cardHash; 404 NotFound; 400 bad DID | A2A-I13 | as stated | [AD] › getCard serves the published bytes: their sha256 is the card hash, and nothing is added to them |
| F139 | getCard stale at boundary | §8.3 | stale at 30 d, fresh 1 ms younger | GAP → P-I7 held |
| F140 | Envelope-only cadence bump | §8.2/§12 | new commit, card_hash same, indexed_at advances, stale→fresh | GAP → P-I10 held; reference-PDS→Jetstream run GAP (Docker, owed per notes) |

### Moderation, pruning, rate tiers, migrations, lexicons
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| F141 | Audit verbs takedown_a2a_card / restore_a2a_card | notes | audited | [AD] › an owner re-put during a takedown…; [AL] (ADMIN_ACTIONS contains both) |
| F142 | CLI a2a-card takedown/restore; bad DID; missing reason; unknown subcommand | notes | as stated | GAP → P-I16 held |
| F143 | Restore with no takedown | — | error | [AD] › a restore never brings back a card the owner deleted… |
| F144 | Prune processed rows after 30 days; replay of a pruned one | notes | replay outcome | [AD] › processed events are pruned after 30 days; a replay of a pruned one changes nothing |
| F145 | Pruning spares conflict evidence while unavailable | notes | rows kept | [AD] › conflict evidence names both spool rows, and pruning keeps them while the conflict stands; after a failed revalidation → P-I1/P-I1b VIOLATED (F-1) |
| F146 | Newer-invalid evidence ids as numbers, kept | notes | kept | [AD] › newer-invalid evidence names its spool row as a number, and pruning keeps it while the card is withheld |
| F147 | Rate tiers searchAgents 60, getCard 120 | notes | 61st search refused | GAP → P-U12 held |
| F148 | 0025 tables exist; migrations clean | §9, plan §3.16 | five tables | [DB] › IT-DB-001: migrations run cleanly; [DB] › IT-DB-002: all 34 tables exist |
| F149 | 0024 in the journal; all entries applied; source_feed exists | notes | as stated | GAP → P-I17 held |
| F150 | Drizzle a2a models equal the SQL | 0025 header | columns and nullability | GAP → P-I17 held |
| F151 | State row seeded 'disabled' | §9 | singleton | code reading (0025 INSERT) |
| F152 | Card lexicon key literal:self, members, cap | §8.2 | as stated | [LX] › the card record is com.dinakernel.a2a.card, keyed literal:self; [LX] › the card record names the members the publisher writes, and the 128 KB cap |

### Brain: search_a2a_agents
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| F153 | Candidates, never grants; no agent_id; framing note | §8.4, A2A-I13 | as stated | [BT] › asks the directory and hands back candidates with the card URL to register, framed as candidates |
| F154 | card_url = origin + /.well-known/agent-card.json | notes | port kept, path/query dropped | [BT] same; port/query GAP → P-B1 held |
| F155 | Never this node | notes | dropped | [BT] › never offers this node’s own card |
| F156 | Local registry refilter | §8.4 | card dropped | [BT] › drops a card holding any skill the local registry does not know or allow in public: AppView should have |
| F157 | Offers what was asked | notes | exact id / capability / alias | [BT] › keeps only cards that offer what was asked: the exact id, or any skill of the capability or its alias; alias@rkey → P-B4 held |
| F158 | Contract order | notes | fresh, trust; ties kept | [BT] › orders as the contract says, whatever order arrived: fresh before stale, then trust; ties keep the directory’s order |
| F159 | Cap | notes | ≤ limit | [BT] › caps what reaches the model |
| F160 | Unknown skill never sent | notes | no call | [BT] › a skill Dina does not know is never sent to the directory |
| F161 | 503/unreachable said plainly; other faults surface | notes | as stated | [BT] › a closed or unreachable directory is said plainly; anything else is a fault and surfaces; HTTP 500/400 → P-B3 VIOLATED (F-3) |
| F162 | Empty directory | — | note | [BT] › an empty directory says so |
| F163 | Client query, shape filter, 503 | notes | as stated | [BH] › sends only the parameters given, to searchAgents; › drops any result not of exactly the published shape; › a closed directory (503) throws AppViewError with its status |
| F164 | Offered only where Lane 1 runs | notes | registered with a2aClient + searching client | [BC] › search_a2a_agents is offered only where Lane 1 runs and the client can search the directory |
| F165 | End to end through the real client (http dropped, hostile name stays data) | §8.4 | as stated | GAP → P-B2 held |
| F166 | Directory candidate → §6.1 ceremony with live card | §8.4, §12 | live card pinned | GAP (Lane 1 area; no directory→registration E2E) |

### Threat-model rows and invariants touching F
| # | Scenario | Rule | Expected | Test |
|---|---|---|---|---|
| F167 | Spoofed card in the directory | §10 | refused | F49, F51 tests |
| F168 | Directory as authority | §10, A2A-I13 | bytes hash-equal; candidates only | F138, F153, F164 |
| F169 | Trust-score gaming | §10 | stuffing loses | F129 |
| F170 | Contact-service reach (Talk never indexed) | §10 | refused | F57 |
| F171 | SSRF (AppView outbound) | §10 | HTTPS, no redirect, caps | F71–F77 |
| F172 | publish → ingest → search → getCard E2E | §12 M5 | end to end | GAP (owed; needs Docker) |

### Observations (not findings)
- The record's `$type` is never compared with the collection (P-U9; P-I13 served a card whose `$type` held U+0000). Served bytes are the signed card, so nothing leaks.
- A card whose JSON-RPC interface is `http://10.0.0.1/...` is indexed (P-U10); Brain's client drops it, external consumers must judge it.
- `createPlcDidResolver` drops any path in `A2A_PLC_URL` (P-U13).
- There is no operator command for `a2a_directory_enabled`; only direct SQL turns the directory on.
- During `draining`, one DID whose PLC lookup keeps answering "unavailable" holds the whole directory closed (by design: the drain must finish).
- A PLC outage during an identity-triggered revalidation leaves the card served on its old verdict (recorded in the notes; defensible, since AppView cannot know the key changed).
- `packages/a2a/src` files changed after `dist/` was built at 19:45 (other work in flight); AppView's vitest resolves the compiled `dist`. Not a defect of this area, but a stale `dist` would test old code.
- During the run `appview/src/shared/a2a/card-verify.ts` changed on disk (`A2A_CARD_MAX_BYTES = A2A_LIMITS.maxCardBytes`, same 128 KB value); probes ran against the new file.

### Gap closure, area F

Every GAP row above, and the completeness critic's scenarios (X-n), with what now holds it.

| Row | Closed by | Test or reason |
|---|---|---|
| F5 | new test | appview/tests/integration/lane3_directory_ingest.test.ts › recording: backpressure over loss › a card event the spool cannot take yet holds the queue’s cursor and is retried until it lands, never dead-lettered |
| F13 | new test | appview/tests/integration/lane3_directory_ingest.test.ts › recording: backpressure over loss › U+0000 in a record never stalls the spool: the row lands, the card is refused, and the next events go on |
| F15 | new test | appview/tests/unit/lane3_directory_config.test.ts › the Jetstream subscription › asks for the card collection, outside the trust collections, with no trust handler; › never asks for the fence: AppView does not index fence records |
| F26 | existing test | appview/tests/integration/a2a_directory.test.ts › every further event at a conflicting revision joins the evidence, and pruning keeps all of them; › the evidence of one conflict is bounded: past the cap a further event adds nothing, and its row is pruned |
| F35 | new test | appview/tests/integration/lane3_directory_ingest.test.ts › processing › a PLC directory that does not answer: retried at 5 s, 30 s, 2 min, 10 min, then every 30 min, and nothing applied meanwhile |
| F37 | new test | appview/tests/integration/lane3_directory_ingest.test.ts › processing › two processors on one spool (a rolling deploy): each event is processed once, in revision order, and the newest revision wins |
| F43 | new test | appview/tests/unit/lane3_directory_card_check.test.ts › the 128 KB cap, at its edge › a card of exactly 128 KB is indexed; one byte more is refused |
| F45 | new test | appview/tests/unit/lane3_directory_card_check.test.ts › the card string is its own canonical form › a card whose members are in another order is refused, even with no whitespace |
| F46 | new test | appview/tests/unit/lane3_directory_card_check.test.ts › the card string is its own canonical form › U+0000 in %s is refused, as it is in a string (a top-level member name; a nested member name) |
| F49 | new test | appview/tests/unit/lane3_directory_card_check.test.ts › the card signature: ES256 against #a2a_card, nothing else › an EdDSA signature by the publisher’s own dina_signing key does not count for the card key; › a URL the card names for its key set is never fetched: a foreign key named by a jku URL is refused |
| F50 | new test | appview/tests/unit/lane3_directory_card_check.test.ts › the card signature: ES256 against #a2a_card, nothing else › several signatures with one valid (%s) verify the card (first; last); › several signatures with none valid are refused |
| F54 | new test | appview/tests/unit/lane3_directory_card_check.test.ts › skills: capability@rkey with the listing-rkey grammar › %s is malformed and refused (7 cases); › the rkey grammar’s full charset is a well-formed skill |
| F62 | new test | appview/tests/unit/lane3_directory_card_check.test.ts › the envelope is bound to this record › an envelope signed by the right key for %s is refused (another collection; another rkey) |
| F64 | new test | appview/tests/unit/lane3_directory_vectors.test.ts › the frozen directory-envelope vectors, through AppView › the frozen envelope verifies against the key AppView reads from the DID document, and binds the card hash AppView computes; › every frozen refusal is refused, with the frozen reason |
| F65 | new test | appview/tests/unit/lane3_directory_card_check.test.ts › keys come from the publisher’s own DID document › a verification method named under another DID’s fragment gives no key |
| F70 | new test | appview/tests/integration/lane3_directory_ingest.test.ts › publishers the directory refuses › a did:web publisher is refused through the real resolver and never served; a did:plc one is |
| F73 | new test | appview/tests/unit/lane3_directory_resolver.test.ts › a DID that is not exactly did:plc plus 24 base32 characters is never fetched, whatever it smuggles |
| F87 | new test | appview/tests/integration/lane3_directory_ingest.test.ts › keys › a rotation of dina_signing alone withholds the card (the envelope no longer verifies); a republish under the new key restores it |
| F88 | new test | appview/tests/integration/lane3_directory_ingest.test.ts › keys › a DID the PLC directory has since deactivated (410) is caught by the daily check and withheld, with the reason as evidence |
| F97 | new test | appview/tests/integration/lane3_directory_ingest.test.ts › gap generations: a late replay never proves › a replay of an event processed before the gap, delivered after it, changes nothing and proves nothing; › the same, when the replayed event’s spool row was already pruned; › an event still pending from before the gap keeps its old stamp when redelivered after it: it applies, never proves; appview/tests/unit/lane3_directory_decide.test.ts › a late pre-gap replay never proves a card › (3 tests) |
| F107 | new test | appview/tests/integration/lane3_directory_serving.test.ts › every gate holds on searchAgents as on getCard › a deleted, re-keyed, superseded, conflicting, inactive, taken-down, redacted or unproved card is absent from search and not found |
| F108 | new test | appview/tests/unit/lane3_directory_config.test.ts › settings › the gap rule assumes Jetstream keeps 24 hours unless told otherwise, and never zero or less; › publishers’ DID documents come from plc.directory over HTTPS unless told otherwise |
| F111 | new test | appview/tests/integration/lane3_directory_serving.test.ts › serving waits for the drain › searchAgents refuses while the directory drains, as getCard does, and answers once it is ready |
| F115 | new test | appview/tests/unit/lane3_directory_config.test.ts › settings › the directory flag is off by default, and the trust flag stays on; appview/tests/integration/lane3_directory_ingest.test.ts › the phases › a fresh deployment with no flag row stays off: events record, nothing is processed or served |
| F116 | existing test | appview/tests/integration/a2a_directory.test.ts › a first-ever create while off is served once the flag is on and the drain is done (The only operator path is the appview_config row written by setBoolFlag (the write path the trust CLI uses); every directory test turns the flag on that way. No command exists for this flag, and no stated rule asks for one (the notes keep the default as an open question). Recorded as an observation.) |
| F117 | new test | appview/tests/integration/lane3_directory_serving.test.ts › every gate holds on searchAgents as on getCard › a deleted, re-keyed, superseded, conflicting, inactive, taken-down, redacted or unproved card is absent from search and not found |
| F118 | new test | appview/tests/integration/lane3_directory_serving.test.ts › every gate holds on searchAgents as on getCard › a deleted, re-keyed, superseded, conflicting, inactive, taken-down, redacted or unproved card is absent from search and not found |
| F119 | new test | appview/tests/integration/lane3_directory_serving.test.ts › every gate holds on searchAgents as on getCard › a deleted, re-keyed, superseded, conflicting, inactive, taken-down, redacted or unproved card is absent from search and not found |
| F126 | new test | appview/tests/integration/lane3_directory_ingest.test.ts › the account gate › a DID known only by a spool row keeps its account status; the card is withheld once processed, and a later commit answers |
| F127 | new test | appview/tests/integration/lane3_directory_serving.test.ts › every gate holds on searchAgents as on getCard › a deleted, re-keyed, superseded, conflicting, inactive, taken-down, redacted or unproved card is absent from search and not found |
| F131 | new test | appview/tests/integration/lane3_directory_serving.test.ts › searchAgents: the parameters › skill and text together give the cards that match both |
| F134 | new test | appview/tests/integration/lane3_directory_serving.test.ts › searchAgents: the parameters › %s is refused with 400 (10 cases: three bad cursors, limit 0, 51, -1, 1.5, 'ten', empty skill, empty q) |
| F135 | new test | appview/tests/integration/lane3_directory_serving.test.ts › searchAgents: the parameters › pages with text and ties: every matching card once, in the order one page would give |
| F138 | new test | appview/tests/integration/lane3_directory_serving.test.ts › a DID with no card at all is not found, and a malformed one is refused |
| F139 | new test | appview/tests/integration/lane3_directory_serving.test.ts › getCard: staleness at its boundary › a card indexed exactly 30 days ago is stale; one millisecond younger is fresh |
| F140 | new test | appview/tests/integration/lane3_directory_ingest.test.ts › the cadence bump: only the envelope changes › a new commit with a bumped freshness epoch keeps the card hash, moves indexed_at, and turns a stale card fresh |
| F140 (reference-PDS to Jetstream run) | owed | Needs Docker (a reference PDS and Jetstream); the notes already list it as owed. |
| F142 | new test | appview/tests/integration/lane3_directory_admin.test.ts › dina-admin peerlens-moderation a2a-card › takedown and restore, typed as an operator types them, write the gate and the audit trail; › %s is refused, and nothing is written (7 cases); › a missing subcommand is refused before anything runs |
| F145 | existing test | appview/tests/integration/a2a_directory.test.ts › a recheck adds its verdict to a standing conflict’s evidence, never replaces it, and takes it off when the card verifies again; › conflict evidence names both spool rows, and pruning keeps them while the conflict stands |
| F147 | new test | appview/tests/unit/lane3_directory_config.test.ts › rate tiers › searchAgents takes 60 a minute from one address; the 61st is refused; › getCard takes 120 a minute; the 121st is refused, and a search budget is apart from it |
| F149 | new test | appview/tests/integration/lane3_directory_admin.test.ts › migrations › every forward migration file is in the journal, and every journal entry was applied |
| F150 | new test | appview/tests/integration/lane3_directory_admin.test.ts › migrations › the Drizzle model of %s equals the table the SQL built: columns, types, nullability (5 tables) |
| F154 | new test | packages/brain/__tests__/a2a/lane3_directory_search_tool.test.ts › the card URL is the endpoint’s origin plus the well-known path: the port kept, the path and query dropped |
| F157 | new test | packages/brain/__tests__/a2a/lane3_directory_search_tool.test.ts › an exact id with an alias (alias@rkey) is matched exactly: the same capability under its canonical name is another id |
| F161 | existing test | packages/brain/__tests__/a2a/a2a_directory_tool.test.ts › a closed or unreachable directory is said plainly; anything else is a fault and surfaces; packages/brain/__tests__/appview_client/http.test.ts › drops any result not of exactly the published shape |
| F165 | new test | packages/brain/__tests__/a2a/lane3_directory_search_tool.test.ts › end to end through the real AppView client (only the network scripted) › a plain-HTTP endpoint never reaches the model; a hostile name stays data, cleaned, under the candidates framing |
| F166 | owed | The §6.1 registration ceremony runs in Core (Lane 1's area); this lane may add files only under appview and packages/brain test folders. The Brain half (a card_url from the endpoint's origin, no agent_id) is held by F153 and F154's tests. |
| F172 | owed | Needs Docker: publish through a reference PDS, ingest from Jetstream, then search and getCard. |
| X-1: Listing change while a card is published: the update drops a skill. searchAgents by that skill's exact id, its capability and its alias. | new test | appview/tests/integration/lane3_directory_ingest.test.ts › a listing change that drops a skill › the dropped skill no longer finds the DID by its exact id, its capability or an alias: an update replaces the skill keys |
| X-2: After a gap, a row whose card was deleted inside the gap never re-proves. | new test | appview/tests/integration/lane3_directory_ingest.test.ts › gap generations: a late replay never proves › a card deleted inside a gap never proves again: withheld throughout, also past the staleness window, whatever replays or checks follow |
| X-3: First publish raced by PLC propagation: AppView checks the card before its PLC view names #a2a_card (card_key_missing). The identity event for the PLC update then arrives. | test added with the fix | appview/tests/integration/lane3_directory_ingest.test.ts › a first publish raced by PLC propagation is withheld, checked again on an identity event, and served once the document names the key (finding F-X3) |
| X-4: search_a2a_agents called with q over 200 characters | existing test | packages/brain/__tests__/a2a/a2a_directory_tool.test.ts › holds the directory’s own limits: the model hears what to change, and nothing is asked |
| X-4: search_a2a_agents called with a skill id over 256 | test added with the fix | packages/brain/__tests__/a2a/a2a_directory_tool.test.ts › holds the directory’s own limits: the model hears what to change, and nothing is asked (finding F-X4) |
| X-4: search_a2a_agents called with a limit over 50 | new test | packages/brain/__tests__/a2a/lane3_directory_search_tool.test.ts › never asks the directory for more than its page maximum, whatever the tool is set to or the model passes |
