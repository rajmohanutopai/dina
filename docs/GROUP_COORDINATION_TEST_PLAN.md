# Group Coordination — Test Plan

**Scope:** `docs/GROUP_COORDINATION_ARCHITECTURE.md`, as built in P0–P4 (the fold, the spokes, the disclosures, the surfaces, the hand-off).
**Method:** contract tests by rule (§16), then adversarial review by workflow. Every scenario below names the rule it pins, the layer it runs at, and the test that holds it. A scenario with no test is listed as such.

Layers: **fold** (`group_fold.ts`), **plan** (`group_plan.ts` + repository), **service** (`group_coordination_service.ts`), **egress** (`disclosure_egress.ts`), **routes** (`routes/group_coordination.ts`), **clients** (`CoreClient` verbs, owner client), **brain** (`group_tools.ts`, lifecycle, lift), **phone** (`InlineGroupPlanCard`, inbox), **schema** (Brain validator + protocol catalog).

---

## 1. The fold (§4, rules 1–3)

| # | Scenario | Expected | Test |
|---|---|---|---|
| F1 | Three required guests accept overlapping sets | `agreed` = intersection, in the organizer's candidate order | `group_fold.test.ts` "converges…" |
| F2 | Same replies, any order; candidates scrambled | Same `agreed`; candidate order is the organizer's | "order-independent (rule 1)" |
| F3 | A required guest silent | `waiting`, `missingRequired` names them; provisional `agreed` over the answered | "non-answer blocks (rule 2)" |
| F4 | An optional guest silent | `converged`; blocks nothing | same |
| F5 | Silence never a no | `emptiedBy` never names a silent guest | "(rule 3)" |
| F6 | Nobody required answered | `agreed` = [] — never "everything" | "empty intersection is not everything" |
| F7 | One required guest's acceptance shares nothing | `empty`, `emptiedBy` = that guest | "names the required guest…" |
| F8 | Pairwise-disjoint acceptances | `empty`, `emptiedBy` = [] | "names nobody…" |
| F9 | Lone required guest accepts nothing | `emptiedBy` = [them] | "lone required guest…" |
| F10 | Case/spacing differences in `start` | Same key; wording of the candidate kept | "canonical key" |
| F11 | Guest names a slot the organizer never proposed | Counter, not acceptance | "a slot the organizer never proposed…" |
| F12 | `counter` reply echoing a candidate | Accepts nothing | "counter reply accepts nothing" |
| F13 | `needs_more_info` | Accepts nothing; listed; never in `emptiedBy` | "needs_more_info…" |
| F14 | `accepted` with no slots | Honest "accepts nothing" → `emptiedBy` | "accepted with no slots" |
| F15 | Duplicate candidates / acceptances | Collapse by key, first wording kept | "duplicate candidates…" |
| F16 | Optional guests | `optionalFit` reports fit; never narrows `agreed` | "optional guests" ×2 |

## 2. The plan aggregate (§7, §12, rule 8)

| # | Scenario | Expected | Test |
|---|---|---|---|
| P1 | 9 guests / 13 candidates / round 4 | `too_many_guests` / `too_many_candidates` / `rounds_exhausted`, nothing sent | `group_plan.test.ts` rule 8 block |
| P2 | Empty intent, over-long intent, duplicate guest, malformed guest, no required guest, no candidates, malformed/duplicate/over-long slot, bad window | Typed refusal by name | same block |
| P3 | Rounds reset replies and advance; ceiling 3 | as stated | "the rounds" |
| P4 | Preflight + query for the same guest in one round | One spoke (query replaces preflight); later rounds append | "a preflight and the query it unlocked are one spoke" |
| P5 | Window is the plan's | `windowClosesAt` = opened + windowSeconds | "the window is the plan's" |
| P6 | Reply / unreachable / answered-then-window | `answered` sticks; unreachable only for waiting | "a reply marks the guest answered…" |
| P7 | Fold moves only when every required accounted | `folded` only then; `needs_more_info` is an answer | "the fold moves the plan only when…" |
| P8 | Re-fold a folded plan | Optional late answer updates `optionalFit`, state stays folded | "a folded plan folds again" |
| P9 | Choose agreed / non-agreed / wrong state | confirm round with one candidate / `slot_not_agreed` / `wrong_state` | "choosing, confirming, settling" |
| P9a | Choose on a fold that closed on an unreachable required guest | `required_unanswered` naming them; `makeOptional` then choose ok | "choose refuses a fold that closed on a required guest…" |
| P9b | Widen / abandon from `settled` | reopens as proposing within the ceiling / abandoned | "refuses to fold a settled or abandoned plan" (tail) |
| P10 | All accept at confirm | `settled` | same |
| P11 | Widen from folded/confirming; malformed candidates; from proposing | new proposing round / `malformed_slot` / `wrong_state` | "widening…" |
| P12 | Drop the last required guest | `no_required_guest` | "makeOptional…" |
| P13 | Disclosures normalised, bounded, `about` enforced, deduped across rounds | as stated | "disclosures and requirements (rules 6–7)" |
| P14 | `deriveRequirements` | kinds + counts only; no DID/text | same |
| P15 | Repository round-trip (SQLite v45 + in-memory), listOpen order, remove, strict rehydration, bounds re-checked | as stated | `group_plan_repository.test.ts` |

## 3. The spokes (§4, §5, §11; rules 4, 8, 9)

| # | Scenario | Expected | Test |
|---|---|---|---|
| S1 | Open with 3 guests holding offers | 3 `service.query` bodies = organizer's intent + candidates; uniform TTL; distinct query ids; tasks running; nothing on the wire names the plan or another guest | `group_coordination_service.test.ts` "every spoke carries…" |
| S2 | Guest without a stored offer | `service.grant_request` preflight, spoke `grant_requested` | "asked for reach through the 1:1 preflight" |
| S3 | Non-contact or blocked guest | `guest_not_a_contact`, nothing sent, no plan stored | "refuses a guest who is not a contact" |
| S4 | Bounds at the service | refused by name, nothing sent | "the bounds refuse the whole plan" |
| S5 | Send fails for one guest | task named + failed; guest stays `waiting`; audit carries no DID | "a spoke whose send fails…" |
| S6 | Nothing wired | `not_wired` value | "nothing wired" |
| S7 | Read before any reply | provisional fold, proposing | "before any reply…" |
| S8 | Yes lands; all required in | recorded at once; folded when every required accounted; optional still waiting | "a yes is recorded the moment it lands" |
| S9 | Disclosures on a reply | normalised, deduped, malformed dropped and counted, text never audited | "disclosures ride the reply" |
| S10 | Unreadable reply (bad slots / unknown status) | no reply → unreachable at window, never "accepted nothing" | "a reply this node cannot read is no reply" |
| S11 | Guest-authored over-long text | clipped, not refused | "guest-authored text is clipped" |
| S12 | Silence, soft refusal, failed send, ungranted | all `unreachable` at the same instant; identical records | "silence, a soft refusal…" (rule 9) |
| S13 | Late yes after close | not read back | "a yes that lands after the window closed" |
| S14 | Reply completed after the window but read later | ignored (`updated_at ≤ closesAt`) | "what counts is WHEN the reply landed" |
| S15 | Window closes mid-pass | one clock reading per fold | "one clock reading per fold" |
| S16 | Offer lands inside the window (event) | query sent with the remaining window; spoke becomes `queried`; second event sends nothing | "when the guest's offer lands…" |
| S17 | Offer lands after the window | nothing sent; unreachable | "an offer that lands after the window" |
| S18 | Event missed; read path | fallback sends | "the read path is the fallback" |
| S19 | Wired listener filters by capability | only this capability's offers replay | "the wired listener reacts only…" |
| S20 | Choose → confirm round → settle | intent "Confirming …", one candidate, TTL uniform, settled on all-yes, plan leaves `listOpen` | "choose sends the confirm round…" |
| S21 | Choose a slot nobody agreed | `slot_not_agreed`, round unchanged | same block |
| S22 | Reneging guest at confirm; widen recovers | confirming + empty fold naming them; widen → round 3, replies cleared, disclosures kept | "a guest who reneges at confirm" |
| S23 | New round supersedes | old live task cancelled; its late reply never this round's answer | "a new round supersedes the last" |
| S24 | Fourth round | `rounds_exhausted` before anything sent | "three rounds is the ceiling" |
| S25 | Drop from required / abandon | re-fold without sending; abandon cancels live spokes; second abandon `wrong_state` | "dropping a guest from required…" |
| S26 | Delete | plan + disclosures gone, live spokes cancelled, second delete false | "deleting a plan…" |
| S27 | List | open plans folded, newest first | "lists every open plan" |
| S28 | Audit PII | no intent, no disclosure text | "the audit trail carries counts and ids" |
| S29 | Two plans, same guest, same question | never share a task (dedupe scope) | "two plans asking the same guest…" |
| S30 | Organizer's own tier refuses a disclosure's category | dropped on receipt, counted (`group_plan_disclosure_refused`), never quoted; slots kept (§13) | "the organizer holds what its own tier admits" |
| S31 | Choose on a provisional fold through the service | `required_unanswered`, nothing sent; after `makeGuestOptional` the confirm round goes out | "a provisional fold is not a decision" |
| S32 | Settled plan reopened / stopped | widen → proposing round 3, back in `listOpen`; abandon → abandoned | "a settled plan can be reopened or stopped" |
| S33 | Spoke submit faults mid-fan-out | audited (`group_plan_spoke_fault`), never thrown; the next read inside the window resumes the guest; a later read sends nothing more | "a spoke whose submit is faulty is audited, not thrown" |
| S34 | Fault persists past the window | guest closes as unreachable; nothing resumed after the window | "a guest the fan-out never reached is not resumed after the window" |
| S35 | Delete scrubs spoke replies | every queried spoke's task `result` is '' (every round) | "every spoke's stored reply is scrubbed" |
| S36 | Spoke's chat surface | `origin_channel` is `group_plan:<id>`; the chat deliverer posts NOTHING for it (no card, no reason, no timing) | `service_query_deliverer.test.ts` "group-plan spokes" |
| S37 | Crash between send and plan write; guest already answered | resume re-links to the task on the wire (scoped dedupe includes terminal tasks); one query per guest per round; the reply is folded; the 1:1 path still treats a completed key as a new query | "a crash between the send and the plan write re-links…" |
| S38 | Organizer's tier refuses a disclosure whose text is also in the prose | reply stored as availability only (no message, no slot note) | "the organizer holds what its own tier admits" (second plan) |

## 4. Disclosures (§6; rules 5–7)

| # | Scenario | Expected | Test |
|---|---|---|---|
| D1 | Schema: every kind, `about: household` | valid | `availability_coordination.test.ts` |
| D2 | Schema: `about` ≠ household; kind outside the four; no text | refused | same (rule 6) |
| D3 | Brain schema = protocol catalog copy | byte-identical; `about` enum has one member | `registry.test.ts` |
| D4 | Tier `none` for health | fact never leaves; availability answers at once | `disclosure_egress.test.ts` (rule 5a) |
| D5 | No tier at all | nothing leaves; field absent; audit counts only | same |
| D6 | General kind under admitting tier; `about: 'Lily'` | leaves unreviewed; the named one dropped and counted, never quoted | same |
| D7 | `tierAdmitsDisclosure` | summary/full yes; all else no | same |
| D8 | Health kind under admitting tier | HELD: nothing sent, review card pending, expires with the query, payload carries both variants | "the reply is HELD" (rule 5b) |
| D9 | Card expiry | the execution task's deadline, not the model's finish time | "the card expires when the query does" |
| D10 | Yes after the card lapsed | nothing released | "a yes that comes after the card lapsed" |
| D11 | Approve | sent WITH, once; card completes; stash cleared | "yes → the reply leaves WITH…" |
| D12 | Deny | sent WITHOUT; card cancelled | "no → the reply leaves WITHOUT…" |
| D13 | Other approvals / second decision | nothing released | "a decision on any other approval…" |
| D14 | No workflow store to hold the card | answers without the fact — never silence, never the fact | "with no workflow store…" |
| D15 | Wrapper form `{status:'success', result}` | gated the same | "the wrapper form…" |
| D16 | Per-category policy before contact tier; neither → nothing | as stated | "which tier answers for a contact" |
| D17 | Other capability / no disclosures / error result | byte-identical passthrough; no audit | "the gate touches nothing else" |
| D18 | Audit PII | never a disclosure | "the audit trail names counts…" |
| D19 | Requirements to vendors | kinds + counts only (rule 7) | P14 + `group_tools.test.ts` hand-off |
| D20 | The card is a decision, not a payload | payload carries the task id, the response identity and the lines; no `resultJSON`; the release rebuilds from the task's stored result | "the reply is HELD" (payload assertions) |
| D21 | Decision through the workflow routes | device approve → sent WITH; device cancel → sent WITHOUT; Brain approve/cancel → 403, nothing sent | "the owner decides the card through the workflow routes; Brain cannot" |
| D22 | Forged card | create route refuses `disclosure_review` (`reserved_payload_type`); a hand-planted card naming another requester releases nothing and fails; the genuine card still releases to the task's own requester | same block |
| D23 | Reasoning lane (`stageServiceQueryResponse`) | health kind → held (no stash, card pending); general kind → staged gated | "every door…" reasoning test |
| D24 | Manual `/v1/service/respond` | health kind → `{status:'held'}`, task completed with the answer stored, released on approve; general kind → sent gated, malformed `about` dropped | "every door…" respond test |
| D26 | Withheld disclosure and the model's prose | owner denies → availability only (no message, no note); approve → prose stays; tier refuses a health kind → prose stripped though a general kind is kept; a malformed `about` strips too; nothing attached → prose untouched | "a withheld disclosure takes the model's prose with it" |
| D25 | Production tier source | per-category policy first, else the contact's own tier, else nothing | "which tier answers for a contact" (policy) — **contact-tier fallback via the directory is exercised in the route test's SQLite setup only indirectly; add a directory-backed case if the fallback ever changes** |

## 5. Routes and clients (§7, §9, §11)

| # | Scenario | Expected | Test |
|---|---|---|---|
| R1 | Every non-owner caller on every decision route; every caller but Brain on open/read | 403; nothing sent | `group_coordination.test.ts` "rejects every non-owner…" |
| R2 | Brain and the unstamped in-process caller | may open and read; 403 on every decision | "Brain … may open a plan and read it — and nothing else" |
| R3 | Router without a capability | refuses the owner too | "fail closed" |
| R4 | POST projection | snake_case, spoke task ids, `required` defaults true, no camelCase | "POST opens a plan…" |
| R5 | GET folds on read; requirements de-identified; list | as stated | "GET folds on read" |
| R6 | Refusal statuses | 400 / 404 / 409 / 503 by kind, error = refusal name | "refusals are named on the wire" |
| R7 | choose/widen/optional/abandon/delete | projection or named refusal | "choose, widen, optional, abandon and delete…" |
| R8 | Store not wired | 503 `not_wired` | "answers 503 by name" |
| C1 | `CoreClient.openGroupPlan` / `getGroupPlan` on the in-process transport | open, read, 404 → null, refusal as value | `owner_coordination_client.test.ts` |
| C2 | Owner client every verb over the real routes | list/get/choose/widen/makeOptional/abandon/remove; typed refusal with status + key | same |
| C3 | Owner client with the wrong capability | 403 on every decision | same |
| C4 | HTTP transport parity | `openGroupPlan` sends the snake_case body and reads the plan; refusal as value; `getGroupPlan` reads or nulls on 404 | `http_transport.test.ts` "openGroupPlan sends…" |

## 6. Brain (§9, §10, §11; rule 10)

| # | Scenario | Expected | Test |
|---|---|---|---|
| B1 | Name matching | case/article-insensitive; exact display/alias first; contained-name match; two matches = question; DID passthrough | `group_tools.test.ts` |
| B2 | `coordinate_group` | terminal; one Core call with the whole list; logs counts only | same (rule 10) |
| B3 | Second call in a request | refused | same |
| B4 | Unknown / ambiguous name | question back; nothing sent | same |
| B5 | Core refusal relayed by name; duplicate guest asked once | as stated | same |
| B6 | Malformed args | refused before Core | same |
| B7 | Unreadable 2xx | ends the turn, no second ask | same |
| B8 | `group_plan_handoff` | slot + requirements only; no DID/name/text; ready only with a chosen slot; stopped/unknown handled | same (rule 7) |
| B9 | Registry | 20 tools incl. both | `agentic_ask.test.ts` |
| B10 | Lift onto the answer | `answer.groupPlan` from a successful call; nothing on failure/empty | `group_plan_lift.test.ts` |
| B11 | Lifecycle | keyed by plan id; strict read-back | `group_plan_lifecycle.test.ts` |
| B12 | `query_service` still one provider per capability per turn | unchanged | `service_tools.test.ts` |
| B13 | `group_plan_handoff` without a plan id | one plan → it; several with one bookable → the bookable; several open → `choose_plan` with handles (no DID); none → refusal pointing at `coordinate_group` | `group_tools.test.ts` "with no plan id…" |
| B14 | Requirements carry needs | `{kind,count,needs}`; needs sorted; no DID, no `about`, no household | `group_plan.test.ts` rule 7; `group_tools.test.ts` hand-off |
| R9 / C5 | Handles door | brain/device/admin/owner GET `/v1/coordination/handles`; a handle has exactly `plan_id,intent,state,round,chosen,updated_at`; HTTP transport reads it | route test; `authz_matrix.test.ts`; `http_transport.test.ts`; `owner_coordination_client.test.ts` |
| P16 | `listRecent` | keeps settled, drops abandoned, newest first, bounded | `group_plan_repository.test.ts` |

## 7. Phone (§9)

| # | Scenario | Expected | Test |
|---|---|---|---|
| M1 | Card reads the plan; rows per household; "couldn't reach" with no reason; no decisions while asking | as stated | `inline_group_plan_card.test.tsx` |
| M1a | While asking, a provisional slot | "Works so far:", the slot is not a choice and a press does nothing | same |
| M2 | Folded and converged: agreed slots as choices; choose → owner client | as stated | same |
| M2a | Folded on an unreachable required household | "Works so far:", no choice, "Go ahead without X", outcome names the household (no reason) | same |
| M3 | Emptied-by named only when answered; "go ahead without" for the household that emptied it | as stated | same |
| M3a | Reneged at confirm | outcome line, "go ahead without", ask again, stop | same |
| M4 | Widen with typed dates; stop | as stated | same |
| M5 | Refusal → one plain line by key | as stated | same |
| M6 | Settled: shows the slot, offers ask-again and cancel; deleted says so | as stated | same |
| M6a | Read failure | "Couldn't read this plan right now." instead of spinning | same |
| M7 | Display mapping | `group_plan` → `group-plan` | `message_display.test.ts` |
| M8 | Inbox `disclosure_review` | listed with kind, requester and lines from `context`; deny = plain cancel | `useServiceInbox.test.ts` |
| M9 | Boot wiring | owner coordination client set beside the commerce client; hooks wired | `boot_capabilities.test.ts` green; **no direct pin** |

## 8. Cross-cutting

| # | Scenario | Expected | Test |
|---|---|---|---|
| X1 | Migration v45 applies on a fresh and an existing identity store | table present; boot readers unaffected | `group_plan_repository.test.ts` (fresh); existing-vault boot: **verify on a dev node** |
| X2 | Authz matrix: prefix owner-only; two doors exact/method; brain/device/admin on the doors only; agent/plugin/connector/service nowhere; wrong verb/sub-path inherits nothing | as stated | `authz_matrix.test.ts` "Group coordination rows" |
| X3 | Server binder owner-surface list includes `/v1/coordination/` | owner header stamps the caller | `owner_channel.test.ts` green (generic); **no direct pin** |
| X4 | Lint/typecheck | clean on touched files (pre-existing errors elsewhere unchanged) | CI |

## 9. Live verification — DONE 2026-09-16 (two nodes; the three-guest variant is §12, a headless vendor remains)

Run on `dina-nodes/` (alonso = organizer, sancho = guest) over the cloud relay, the guest's Brain on a real model, driven through `/v1/debug/dispatch`, the HTTP owner surface (capability header) and the Brain's `/api/v1/chat`.

| Live scenario | Observed |
|---|---|
| L1 guest with no talk listing | preflight received; soft-refused silently (`no_talk_listing`); plan `folded`, guest `unreachable`, no reason anywhere |
| L2 guest with a default-offerable talk listing, sibling relationship | preflight → auto-grant `service.offer` → offer replay → `service.query` → guest's model answers (accepted Sat 26, refused Sat 19 per instruction) |
| L3 health disclosure on the reply | egress gate HELD it; `disclosure_review` card pending on the guest; nothing sent; organizer's spoke still `waiting` |
| L4 owner approves | reply released WITH the disclosure; organizer folds `converged` on Sat 26; requirements `dietary ×1` |
| L5 owner chooses over HTTP with the capability header | confirm round out; the same route without / with a wrong header → 401 |
| L6 confirm reply carries the disclosure again; owner DENIES | reply released WITHOUT it; plan `settled`; disclosures deduplicated at one |
| L7 real-model `/ask` "plan a cake tasting for Emma with Sancho…" | `coordinate_group` on iteration 0; plan card posted in the thread; the guest's model answers `needs_more_info` (October outside its notes) → fold `empty`, `needs_more_info` names it, `emptied_by` empty |
| L8 real-model `/ask` "did we settle a time… what should I tell the bakery" on a fresh thread | first attempt: no tool, answered from the organizer's own vault (no plan id in reach) → fixed with the handles door; second attempt: `group_plan_handoff` → the settled plan → "settled for Sat 26 Sep 3pm… 1 dietary requirement" |
| Found live | denied disclosure repeated in `message` (fixed: prose leaves only when nothing withheld); hand-off unreachable across turns (fixed: handles); requirements without needs (fixed) |

Still owed: the three-guest variant (one offline, one ungranted, one disclosing), and a headless bakery/venue answering the hand-off's `query_service`.

## 10. Adversarial review round (workflow)

Dimensions, each an independent reviewer over the diff plus the doc: **correctness** (fold and plan transitions vs §4/§7), **privacy** (rules 3–7, 9; audit; wire), **authz** (owner doors, Brain doors, in-process marker), **concurrency** (per-plan lock, bridge race, late replies), **failure modes** (§13 table row by row), **test adequacy** (this plan vs the suites; tests that encode implementation not requirement). Every finding is re-verified by a second reviewer before it is fixed.

## 11. Review round — outcome (2026-09-16)

Six lenses, two refuters per finding. 32 findings raised; 9 stood after two refuters, 9 were refuted twice, and 14 lost their refuters to a spend limit and were judged by the implementer instead. What changed:

**Fixed (confirmed):** choose on a provisional fold (P9a, S31, M2a); the card's dead ends at confirm and after settle (M3a, M6, P9b, S32); drop-from-required for the household that emptied the fold (M3); authz rows pinned (X2); route-driven approve/deny (D21); the organizer's own tier on receipt (S30).

**Fixed (judged from the unverified set):** every door a provider answer leaves by is gated — reasoning lane and manual respond (D23, D24); Brain cannot decide a review card (D21); a card is a decision, not a payload, and the create route refuses the type (D20, D22); a spoke's outcome never posts to a Talk thread (S36); deleting a plan scrubs the spoke replies (S35); a faulted fan-out resumes on read inside the window and never throws a plan half-sent (S33, S34); the card says when it cannot read (M6a).

**Refuted and left as is:** the confirm round counting against the ceiling (the doc's "two by default, a third on the organizer's say"); `ready` at `confirming` on the hand-off (the note says the booking is on the organizer's say); the health gate keying off the model's `kind` (the schema's kind IS the category claim; a mislabelled fact is a model fault the owner's review of health kinds cannot catch by construction — recorded as an open question); `/v1/service/respond` ungated (now gated regardless).

**Recorded, not built:** a plan Core persisted but never carded has no phone surface beyond the owner list route; the §13 cancel notice to answered guests; the "a family changes its mind" reconciliation on the guest's side.

## 12. Web validation round — DONE 2026-09-17 (four nodes, the home-node-lite web page)

Driven the way `dina_details.md` says to test: alonso's web chat at `:8401/web/` in Chrome, sancho's at `:8402/web/`, the bundle rebuilt (`expo export --platform web`) before every pass; guests set up as in §9 plus chairmaker (sibling, auto listing, "no dietary or access needs") and albert (no listing). Decisions the web page cannot carry went over the HTTP owner surface with the capability header.

| Scenario | Observed |
|---|---|
| W1 §13.1 remember ×2, §13.2 ask | "Stored in General vault." twice; the ask joined both facts and flagged an older "niece Emma" note as a possible other Emma |
| W2 §13.3 reminders | "Emma's birthday is on Nov 7th" → two auto reminders (Nov 3 heads-up, Nov 7) |
| W3 §13.4 security | bank note → Finance vault (+ a Dec 1 reminder in `/finance`); HbA1c → Health vault; no approval prompt either time |
| W4 §13.5 talk | NOT WORKING on the web, parked work per the spec: the 1:1 screen sends from the browser-local node ("denied at contact"), the People "YOU" card shows a stale browser-local identity, the chat header says a listed contact is "not in your contacts", and the guide's plain "Tell Sancho…" needs a mode chip and has no Brain route |
| W5 reviews, services | Reviews: "no network reviews for that yet" (test appview has none); Services: discovery found the transit provider, sent the query, timed out honestly (no provider daemon running) |
| W6 three-guest plan from `/ask` on the web | `coordinate_group` on the first turn; the card rendered through Brain's new read proxy; Albert (no listing) `unreachable`; Chairmaker answered at once; Sancho's reply held for review |
| W7 FOUND: a "no needs" disclosure | chairmaker's model turned "we have no dietary or access needs" into two disclosures ("No dietary needs.", "No access needs."); the gate held them as health, nobody answered, the accepted availability was lost and the required guest folded `unreachable` |
| W8 FOUND: a lapse answered nothing | the review card expired with the query, so a required guest who accepted every slot counted as silent because their owner did not tap in time |
| W9 FOUND: the web review card | Approve opened a `window.confirm`, Core refused the Brain caller (403), and the error vanished in RN-Web's no-op `Alert` — a dead button |
| W10 FOUND: no owner door on the server | `/v1/workflow/tasks/:id/approve` demanded a signed request; a lite node's owner had no capability-header way to settle a card Core refuses Brain, so the card's "owner console" line was untrue there |
| W11 after the fixes, round 1 | chairmaker's model produced no `disclosures` field; sancho's card lapsed through the sweeper 43 s before the window and the honest `needs_more_info` (October outside its notes then) landed 32 s before close; names rendered on the web; ISO slots read as "Sat 3 Oct 2026, 15:00 to 16:00" |
| W12 fresh plan, both required | approve over the owner surface (`x-dina-owner-capability`) → converged on both slots with `dietary ×1 gluten-free`; choose over the owner surface → confirm round; DENY over the owner surface → settled without the fact and without the slot note; the round-1 disclosure stands once |
| W13 hand-off `/ask` on the web | "settled for Saturday, 3 October, 3:00–4:00pm… include one gluten-free tasting portion" — nothing about whose need |
| W14 web review card after the fix | shows the lines that would leave and "Approve or deny from your phone or Core's owner console.", no buttons; a refused decision on any other kind now reads Core's reason on the card |

| W15 the vendor lane over the test AppView | albert published "Albert's Bakery" (public, `appointment_availability` auto + `appointment_book` review, Castro service area); `com.dinakernel.service.search` indexed it within seconds with the matched capability and the published schema hash |
| W16 hand-off `/ask` "find a bakery near the Castro… check they can host us then" | `group_plan_handoff` → `search_capabilities` → `search_provider_services` (found the bakery) → `query_service` with date 2026-10-03, 15:00–16:00 and "one gluten-free option"; the bakery's Dina answered on the Tier 1 lane |
| W17 FOUND: the bakery said "unknown" | its instruction carried no `instructionUpdatedAt` (the phone editor stamps it; a raw PUT does not), so its model read the notes as "written at an unknown time" and fell back honestly; stamped → "3:00 PM is available" |
| W18 FOUND: the answer's WHEN was not on the card | `slots` is an array; the generic result mapper kept scalars only, so the card read "Status Ok · Date" and nothing about 15:00 |
| W19 FOUND: "provider not found" when the ask named no place | `DINA_AGENTIC_DEBUG=1` showed the model sent `lat: 0, lng: 0, radius_km: 0`; the AppView refused radius 0, the retry with 50 km searched around null island and found nothing |
| W20 booking | `appointment_book` arrived as a review card on the bakery with "Party of 6; one gluten-free portion."; approved over the owner surface; the lite node ran it on its Tier 1 lane. First answer "unknown" (the facts lived only in the availability instruction, not the vault — Tier 1 keeps facts by remembering); after two `/remember` turns on albert: "Confirmed · 15:00 · 2026-10-03 · Cake tasting — party of 6, including one gluten-free portion" on the organizer's web card |
| W21 after the fixes | the same no-place ask found the bakery on the first search call and its card listed "15:00 · 2026-10-03 — Cake tasting; gluten-free tasting portions are kept on hand." |

**Fixed this round:** silence is a no — the card lapses a margin before the window and the sweeper's expiry runs through the service so the decision handler releases the availability without the fact (`WorkflowService.expireTasks`, `TaskExpirer`, three hosts pinned); no room to ask → answer without the fact at once; the deadline is arrival plus TTL, not a claim lease; the hooks share the service clock; `disclosures` and `text` carry a field description in both schema copies; the web plan card names households through the platform contact source, reads ISO slots, labels a slot "Choose" only where a choice can be carried, and its console note follows the state; the inbox surfaces refused decisions inline and the web review card says where to decide; the lite server's owner surface admits the approve/cancel verbs with in-handler re-validation; both discovery tools treat (0, 0) and a non-positive radius as no location (`viewerLocationFromArgs`); the generic result card renders list-valued fields (`slots`, `lines`, `options`) as rows under a section, capped at six with a count.

**AppView:** nothing to deploy for this feature. The group lane never touches the AppView (known-only listings ride the D2D offer; spokes pin the offer's hash); the vendor lane reads listings the AppView already indexes. Noted: the test AppView's catalog snapshot is EMPTY (`com.dinakernel.catalog.capabilities` returns no capabilities) and its version stamp is an old dirty build — the phone's picker runs on its bundled catalog until `seed:catalog` is run at the next deploy.

**Still owed:** Talk on the web (Phase 9 of the web plan); the web "YOU" card and chat-header identity (browser-local node vs the server's); a Brain restart on a lite node empties the web chat history (the SSE store is not rehydrated); a listing saved before a catalog schema change keeps its stored schema until the capability is removed and re-added in the editor.
