# Contact Services — Architecture

*Relationship-scoped services, surfaced through Talk. First instance: "let's find a time to meet."*

Status: design. Grounded against the shipping TypeScript stack (`packages/core`, `packages/brain`, `apps/mobile`) as of 2026-06.

---

## 1. The one-sentence idea

A **contact service** is a capability one Dina provides to a *specific* contact — "find a time with me," "what's your view on X," "book this" — authorized per-contact *before* the request is ever made, and surfaced entirely inside the **Talk** thread with that contact. The user never visits a services screen to use one.

The important structural claim: a contact service is not a new concept. It is an existing **`known_only` service grant** (the mechanism) bound to the existing **Talk thread + inline-card chat** machinery (the surface), through a thin **intent-recognition seam**. We are wiring two built systems together, not building a third.

---

## 2. Why pre-authorization, not approval

The requirement that shapes everything: *you do not want any contact to get anything done through you, and you do not want to rely on declining requests to enforce that.*

An approval gate is **post-hoc**: the acquaintance got to ask, and you had to say no. That is socially costly, and a refusal leaks that you *could* have said yes. A grant is **pre-authorization**: the capability was never on offer to that contact, so there is nothing to decline. For relationships, "that was never offered" and "no, I won't" are different things, and the first is the kind one.

So the model is: **closeness decides reach; the action gate still decides the deed** (see §4).

A caution this exposes, because it is easy to get wrong: the **lazy one-time allow** (§5.2) is *not* pre-authorization. A prompt — "Allow Alonso to use your scheduling service?" — is itself a social interruption, and if a distant contact could trigger it, the leak we wanted to avoid is back. So lazy-allow is a closeness-gated *grant-request*, available only for close/trusted (or explicit "ask to enable") contacts. For distant or unknown contacts an un-granted request is **softly rejected with no prompt to you at all** — they simply never had it on offer.

**Asymmetric visibility is a product invariant.** The grantor sees the real decision; the requester never sees the reason. From Alonso's side, these must be indistinguishable:
- Sancho never created that contact service.
- Sancho is offline or the request timed out.
- Sancho's policy softly refused the request.
- Sancho ignored or dismissed an ask-to-enable prompt.

The requester surface has only two observable states: **it worked** or **it couldn't be completed**. It must never show "denied", "not trusted enough", "waiting for Sancho's approval", or any state that lets the requester infer where they rank. The grantor may see the full truth in a private log (§10); the requester gets one collapsed failure outcome.

---

## 3. The three layers

| Layer | Responsibility | Where it lives |
|---|---|---|
| **Surface** | Where the user acts. Conversation-first. | Talk thread (`apps/mobile/app/chat/[did].tsx`) |
| **Mechanism** | Who may invoke what, and how it runs. | Service layer: `service_grants`, capabilities, D2D service lane |
| **Seam** | Recognize a contact-service intent in a thread, route it to the mechanism scoped to *this* contact, render the result as an inline card *in the thread*. | Brain command-parser/orchestrator + the chat lifecycle-card path |

Public/network services (what you publish to the world, provider tiers, AppView) keep the **services tab** as their surface. Relationship services keep **Talk and the contact** as theirs. They share the mechanism; they differ in surface. This is what keeps relationship services out of the services-tab mental model and their controls *with the contact*, not in a settings maze.

### What is — and isn't — a Contact Service

The grant mechanism is shared, but the *product category* is deliberately narrow. A Contact Service is **relationship-native**: a specific person may ask your Dina for something about *your own* life, judgment, relationships, or identity, and it lives in Talk (`surface: talk`). The test: **whose thing is being asked about, and who is asking?** A customer asking about a provider's inventory or status is a *provider* service; a peer asking about *you* is a Contact Service. ("School privately grants parents `homework_status`" = provider service. "My daughter asks my Dina where I'm picking her up" = Contact Service.) Both can be `known_only`; the line is the `surface` field (§5.3), not the grant.

**V1 — four relationship-native families,** each showcasing a different Dina strength:
1. **Availability coordination** — find a time / are you free. The first demo (deepest design here).
2. **Ask my opinion / recommendation** — "what did you think of X?" **Review/approval-first, never auto-answer** (it can leak preferences/history). This is the deferred recommendation lane.
3. **Introductions** — "connect me with someone who does Y." Rides the people graph + approval.
4. **Vouch / endorsement** — "vouch for me." PeerLens trust network; the `peerlens.vouch` message family already exists.

Later (each more sensitive or more failure-prone, so not V1): **personal status / ETA** (the strongest V1.1 candidate, but location-sensitive — must not default broadly), **shared preferences/facts** (close contacts only), **group coordination**, **family/care check-ins**.

**Two things stay OUT of this model:**
- **Provider services** — salon slots, bus ETA, store stock, clinic availability, order/package status. Provider↔customer, even when `known_only`. They live in the services tab.
- **Emergency / safety reach** — a *separate* high-priority channel (`safety.alert`, Fiduciary priority) with explicit setup. Do **not** fold "are you in trouble?" into the same casual closeness-default / lazy-allow model as "find a time."

---

## 4. Four-layer authorization

The security spine. Four independent questions, never collapsed into each other. The load-bearing invariant: **a service grant does not grant data access.** Letting Alonso *ask* Sancho's Dina for availability is not the same as letting it *read* Sancho's calendar to answer.

**Layer 1 — Contact trust.** *Who is this?* The contact record (`trust_level`, `relationship`). A blocked contact never reaches the lane; trust feeds the closeness that decides reach (§5).

**Layer 2 — Service grant (reach).** *What may this contact ask?* Deterministic, per-contact, per-listing, per-capability, evaluated at D2D ingress. Already built:
- Table `service_grants` (migration v10) — `packages/core/src/storage/schemas.ts:597-615`. Columns: `grant_id, grantee_did, service_rkey, capability, grant_type, constraints_json, expires_at, revoked_at, created_at`.
- Primitive `ServiceGrantRepository.isAuthorized({ granteeDid, serviceRkey, capability, grantId?, nowSec })` — `packages/core/src/service/service_grant_repository.ts:139-163`.
- Enforced at D2D ingress for `known_only` listings — `packages/core/src/d2d/receive_pipeline.ts:325-329`.
- Issued via `POST /v1/service/offer` — `packages/core/src/server/routes/service_query.ts:397-497` — requires the grantee to be an established **contact**, delivers the `grant_id` over D2D `service.offer`.

**Layer 3 — Data / agent grant.** *What may my capability read to answer?* A grant to *ask* is not access to *data*. When Sancho's Dina runs the capability, what it may read is governed by the persona/vault rules — the capability's `vaultPersona` and the persona access tiers — independently of the service grant. A sensitive answer is itself drafted for approval before it leaves. An ungated service grant must never become an open read into a sensitive persona.

**Layer 4 — Action gate (commit).** *Should this specific binding action happen now?* The action-risk gate already shipped (`packages/core/src/gatekeeper/intent.ts`). Granting the scheduling service does **not** auto-commit anything. Two commit paths, depending on the capability shape: a **provider-service commit** (e.g. `appointment_book`, where the provider acts in response to a query) is drafted via the capability's `responsePolicy` (`packages/core/src/service/service_config.ts:452`); a **local commit** (e.g. each side's own booking + reminder after `availability_coordination` converges — *not* a `service.query`) goes through the existing gatekeeper / agent-approval path. Either way, the deed waits for the owner's yes.

Trust says who. Grant says what they may ask. Data grant says what the answer may draw on. The gate says whether the deed lands. A close contact passes layers 1 and 2 freely and still cannot read a sensitive persona (3) or make a booking land (4) without the respective yes.

---

## 5. The grant model: what's built, what's net-new

**Built (reuse as-is):** the grant table, the authorization primitive, ingress enforcement for `known_only`, issuance + D2D delivery, contact-establishment requirement.

**Net-new, and small:**

1. **Relationship-default grant policy — materialized as explicit rows, never computed at ingress.** Today every grant is issued by hand through `/v1/service/offer`. Add a default policy keyed off the contact record (`packages/core/src/contacts/directory.ts:49-112`): `relationship` (spouse/child/…/acquaintance), `trust_level`, `sharing_tier`, `preferred_for`. Add a pure helper `closeness(contact) -> 'close' | 'medium' | 'distant' | 'unknown'` (close = spouse/child/parent/sibling; medium = friend; distant = colleague/acquaintance).

   **The default policy is opt-in per service.** It applies *only* to relationship services the owner has marked **default-offerable** (per closeness tier). Closeness alone never creates access to an arbitrary `talk`-surface service: being a close contact does not auto-grant *every* relationship service, only the ones the owner enabled as default. So auto-grant requires both conditions — the service is default-offerable **and** the contact clears the tier.

   **The ingress gate stays single-source.** D2D authorization checks *only* the `service_grants` table — never "a grant row OR the default policy says yes." The default policy is a **materialization rule that writes explicit grant rows**, not an ingress-time fallback. Materialize either eagerly (marking a contact close → the contact editor offers to enable their default services) or lazily (auto-create the row when a close contact's Dina sends the grant-request preflight, §5.2, logged), but always as a real, revocable row. This keeps `service_grants` the sole audit/revoke source of truth, and keeps the ingress check a single boolean.

2. **Lazy allow is a closeness-gated grant-request, not pre-authorization** (see §2). Behavior on an un-granted approach is tiered by `closeness` so a distant contact can never manufacture an interruption just by asking:
   - **distant / unknown** → soft-reject, **no prompt to the owner**, no row created, no negative reply to the requester.
   - **medium (friend)** → a one-time "ask to enable" Talk prompt; a yes writes an explicit grant. A no, dismiss, or timeout sends no denial.
   - **close / trusted** → auto-grant (explicit row, logged) or a one-time confirm — never a per-request nag — but **only for services the owner marked default-offerable** (§5.1).

   The requester never receives the policy result. If the preflight does not produce an offer in time, the requester's Dina collapses every negative path into the same local outcome: "I couldn't complete that with this contact's Dina." That local outcome covers absent service, soft refusal, ignored prompt, timeout, and offline provider.

   **Bootstrap is a preflight grant-request, not an ungranted query.** `known_only` ingress *requires* a `grant_id` (a `service.query` without one is hard-rejected — single-source preserved), so a first contact cannot self-authorize by smuggling the work into an ungranted query. The lazy path is a separate preflight exchange:
   1. Alonso's Dina has no grant → it sends a **grant-request** naming **Sancho's DID + the capability** (e.g. scheduling) + an optional intent — *not* a listing rkey (Alonso does not know Sancho's private listing; that is what the offer returns) and *not* a `service.query`.
   2. Sancho's Dina applies the closeness/default policy above **and resolves the capability to its matching `talk`-surface listing** (if several match, it picks one or asks Sancho).
   3. If allowed → Sancho's Dina writes a real `service_grants` row and replies `service.offer { service_uri, grant_id }` (the existing offer mechanism, which already carries the `service_uri`).
   4. Alonso's Dina retries the actual `service.query` with **that `service_uri` + `grant_id`**.

   Today offers are provider-push only (`/v1/service/offer`); the **requester-initiated grant-request** that triggers steps 1–3 is the one net-new message on this path (small). Its body — the requester names a *capability*, never an rkey:

   ```
   service.grant_request {
     request_id: string;
     capability: string;        // e.g. "availability_coordination"
     intent?: string;           // optional free-text ("find a time next week")
     requested_surface: 'talk';
   }
   ```

   The provider derives everything trusted from inputs the requester cannot forge: `from_did` from the transport envelope (the relay-authenticated sender), the provider DID from the receiver, and the matching listing from its own `ServiceConfig.surface === 'talk'` configs. **The requester never chooses the rkey.**

   The `request_id` is for local correlation only. It must not become a visible denial channel. If a future `service.offer` echoes it, that echo is used only to resume the waiting request after success; failure still collapses locally on the requester side.

3. **A typed `surface` field on the listing — not free-form JSON, and not the capability.** Add `ServiceConfig.surface: 'services' | 'talk'` to the `ServiceConfig` listing type in `@dina/protocol` (re-exported via `packages/core/src/service/service_config.ts`) with validation, **alongside `discoverability`**. It is a **listing-level** field, not capability-level: `surface` describes where *this listing* is shown and managed, and the same capability (e.g. `availability_coordination`) can appear in different listings with different surfaces — the listing decides. It declares the services tab (`services`) or a Talk thread with a contact (`talk`), and is **orthogonal to `discoverability`**: a `known_only` listing can be surfaced either way (a private provider service in the services tab, or a relationship service in Talk). Do **not** reuse the `public`/`unlisted`/`known_only` words here — that axis is discoverability, this one is surface. Putting it only in `config_json` invites core/brain/mobile drift; the protocol is the contract.

No new authorization concept. A relationship service *is* a `known_only` ServiceConfig whose grants are issued by the relationship-default policy (or lazy allow) instead of by hand, and whose surface is Talk.

**This completes an orphaned tier.** "Private / Approved Only" in `apps/mobile/app/service-settings.tsx` is the user-facing name for `known_only`, and today it is **server-complete but UX-orphaned**. The enforcement (`service_grants` + `isAuthorized`), the issue endpoint (`/v1/service/offer`), the offers list (`/v1/service/offers`), and `contact_service_offers` storage all exist and are tested — but the app has *no* UI to designate approvers, *no* client call to issue a grant (CLI/tests only), *no* request-access flow, and **no explicit mobile UI to view or manage received offers** (Brain can already use them in its service reasoning; the *UI* is what is missing). The picker saves the tier and stops; a code comment defers the rest: "Discoverability is not authorization. The provider still controls who may actually use the service." So the work here is almost entirely grant *UX* on top of a complete server-side grant lifecycle, plus the one requester-initiated message (§5.2) — and contact-services finishes the tier **through Talk** (closeness-defaults + lazy-allow) rather than a "manage approvers" settings screen.

---

## 6. The scheduling service (first instance)

### 6.1 Capabilities — shared lane, purpose-fit schema

The salon capabilities exist and are reusable, but a mutual meeting is **not** a provider booking, so it gets its own capability rather than overloading `appointment_book`:

- **Provider booking (reuse):** `appointment_availability` / `appointment_book` (`packages/brain/src/service/capabilities/appointment.ts`, lines 34-80 / 94-128). *Asymmetric* — one provider owns the inventory, one requester books a slot, one side confirms.
- **Mutual coordination (new):** `availability_coordination` (working name) — *symmetric*. Both peers have calendars; the exchange converges on a shared slot; *both* sides confirm. Forcing this into `appointment_book` breaks on a basic question — who confirms? In a booking, the provider does; in a coordination, both do.

Both ride the **same** service lane and the **same** grant mechanism; only the capability schema differs. `appointment_availability`'s "return my free slots" shape is still a fine building block for the "here are candidate times" half. Availability is assumed-provided (memory or a feeder agent); calendar sync is out of scope (§11).

### 6.2 Negotiation = repeated one-shot service calls (no protocol state machine)

The D2D service lane is one-shot: a `service.query` opens a window, a `service.response` consumes it (`packages/core/src/d2d/receive_pipeline.ts:260-332`). We do **not** add a stateful multi-round protocol. A negotiation is a *sequence* of one-shot calls, and the state lives in the agents and the Talk thread, not in a coordinator:

```
Alonso → Sancho   service.query   availability_coordination { intent, candidate_slots: [X,Y,Z], constraints }
Sancho → Alonso   service.response { status: accepted, accepted_slots: [Y] }
        (or)      service.response { status: counter,  counter_slots:  [W] }
        (or)      service.response { status: needs_more_info }
   ... repeat one-shot calls (counter → re-query) until status: accepted ...
Then EACH side commits LOCALLY (book + reminder), separately approval-gated — NOT a service.query.
```

Recognizing the intent, choosing to counter, knowing when to stop — that is **agent behavior**, not hand-coded rules. A `NegotiationState` enum or a "wait-for-peer-approval" coordinator would be exactly the per-scenario bandage to avoid.

**Convergence** (finding the overlapping slot) may be agent reasoning *or* a deterministic set-intersection in code. Code is more reliable for two-models-negotiating but is an optimization, not a requirement; reach for it only if the sim shows the agents fumbling overlap. If you do, structured `{start, end}` slots (not free-form prose) are the precondition.

### 6.3 Bilateral approval is emergent, not orchestrated

"Both approve before commit" needs no choreography code. After the coordination converges (`status: accepted`), it is two ordinary **local** commits, each gated by the existing gate, one per node — not a `service.query`:
- Sancho's local commit (book + reminder) is review-gated → Sancho approves on his side.
- Alonso's local commit (book + reminder) is gated → Alonso approves on his side.

The meeting is real on each side when that side's owner approves. "Bilateral" is the emergent property of two independent gates, not a coordinator.

**Consistency caveat (honest):** with no commit protocol there is a window where one side booked and the other declined. For a meeting, **agent reconciliation** closes it — the declining side's Dina sends "he can't make it after all," and the other drafts a cancel. That is fine at these stakes. Real two-phase commit is code, but it is a deliberate choice for high-stakes actions, generic, and not required for v1.

---

## 7. The Talk seam (the actual build)

The chat lifecycle-card machinery already works — in the **main chat tab**, not in Talk threads. The seam is six wiring changes, four of them small.

### Surface anchors that already exist
- Inline-card dispatch pattern: `apps/mobile/app/index.tsx:82-149` (`toDisplayType`) → `renderMessage()` → `InlineServiceQueryCard` (`apps/mobile/src/components/InlineServiceQueryCard.tsx:36-129`), keyed on `metadata.lifecycle.kind === 'service_query'`.
- Lifecycle metadata model: `ServiceQueryLifecycle` — `packages/brain/src/chat/thread.ts:53-85` — carries `status, taskId, queryId, capability, serviceName, providerDid, params, result, cardSpec`. Keyed by `taskId` so workflow events patch the same message in place.
- Talk thread screen: `apps/mobile/app/chat/[did].tsx` (the `Bubble`, lines 213-246, renders **plain text only**).
- D2D inbound hook: drain `onD2DMessage` — `packages/brain/src/staging/drain.ts:858-893`; mobile wires it in `boot_service.ts:568-572`, currently posting to the `'main'` thread.

### The six seams

| # | Seam | Plug point | Size |
|---|---|---|---|
| 1 | **Render lifecycle cards in Talk threads** | `Bubble` in `chat/[did].tsx:213` dispatches on `metadata.lifecycle.kind` the same way `index.tsx:renderMessage` does. The card components are reusable as-is. | Small |
| 2 | **Contact-scoped intent routing** | Thread the peer DID through `parseCommand` → `handleChat` → handler (`command_parser.ts`, `orchestrator.ts:117-209`). A scheduling intent in a Talk thread routes to *that peer*, not public discovery. | Medium |
| 3 | **Route inbound D2D to the peer thread** | `onD2DMessage` (boot wiring) posts to `peerDID` thread, not `'main'`. | Small |
| 4 | **Patch inbound `service.response` into the Talk card** | `service_query_deliverer.ts` (WorkflowEventConsumer) locates the matching `service_query` lifecycle message in the **peer** thread and patches it `resolved`. Today it patches `'main'` only. | Medium |
| 5 | **Talk-initiated peer service invoke** | A path that sends a `service.query` to the thread's contact (carrying its `grant_id`), distinct from the public-provider discovery the `query_service` tool does today. | Medium |
| 6 | **Suggestion chip (suggest, do not auto-fire)** | Composer surfaces a contextual "Find a time with X?" chip when a message reads as scheduling intent. Builds on the existing fixed-chip mechanism (`composer_modes.ts:18-84`). | Small |

**Seam #6 is the one control point to get right.** The classifier must *suggest*, never auto-invoke — misreading "we should hang out sometime" as a service call is the failure mode. The user confirms the chip; only then does it route. This keeps the human in control and keeps the mechanism generic ("Talk surfaces service actions"), not meeting-specific. Classifier quality is a verify-on-the-sim concern, not a place for hand-coded rules.

---

## 8. End-to-end flow (Alonso ↔ Sancho), mapped to components

```
1. Alonso, in his Talk thread with Sancho, types "let's find a time next week."
   → Brain intent classifier (command_parser, seam #2) tags it scheduling-toward-Sancho.
   → Composer surfaces a "Find a time with Sancho?" chip (seam #6). Alonso taps yes.

2. Alonso's Dina posts a service_query lifecycle message into the thread
   (InlineServiceQueryCard renders "pending", seam #1) and sends a D2D
   service.query(availability_coordination, { candidate_slots }) to Sancho,
   carrying its service_uri + grant_id (seam #5).

3. Sancho's Core receives it (receive_pipeline:325-329):
   - Grant check (grant_id present + live?): granted → proceed. ungranted query →
       hard-rejected; Alonso's Dina may run the preflight grant-request (§5.2)
       and retry with a grant_id if an offer arrives. If no offer arrives,
       Alonso sees only the generic "couldn't complete" outcome — not denied,
       not untrusted, not "waiting for Sancho."
   - Granted → run availability_coordination over Sancho's (assumed-provided) slots.
   - Reply service.response { status: accepted, accepted_slots: [Tue 3pm] }
       (or counter / needs_more_info → another one-shot round).

4. Back in Alonso's thread, the card patches to "resolved" with Tue 3pm (seam #4).
   On acceptance, EACH side commits LOCALLY (book + reminder) — separately
   approval-gated (the gate, §4 layer 4). Both approve → "Meeting with Sancho,
   Tue 3pm" lands in each thread.

Neither user ever opened a services tab.
```

---

## 9. Data-model and schema deltas

Minimal, additive:
- **`closeness(contact)` helper** + a per-capability **relationship-default policy** that *materializes explicit `service_grants` rows* (§5.1); the ingress check stays grant-table-only.
- **`ServiceConfig.surface: 'services' | 'talk'`** (listing-level, orthogonal to `discoverability`) as a *typed* field on the `ServiceConfig` listing type in `@dina/protocol` + validation — not free-form JSON, not capability-level (§5.3).
- **`availability_coordination` capability schema** (new, symmetric) registered like the salon ones; `appointment_availability` reused for the candidate-slots half (§6.1).
- **(Optional, only if §6.2 goes deterministic)** a structured `{start, end}` slot type for code-side intersection.
- No change to `service_grants`, `contacts`, or the gate — reused as-is. **One new D2D message**: a typed `service.grant_request` family for the requester-initiated preflight (§5.2). (You could overload an existing coordination message, but a typed family is cleaner and self-documenting.)

---

## 10. Security and privacy

- **Authorization binds to the transport-authenticated caller.** The grant check uses the MsgBox-envelope `from_did` (relay-authenticated), never a self-asserted field in the message body. This is the confused-deputy rule, and `receive_pipeline` already does it.
- **Pre-authorization avoids the denial leak** (§2). Grants are revocable and can expire (`service_grants.revoked_at`, `expires_at`).
- **Requester-visible failures are collapsed.** Refused, not-offered, timed-out, ignored, and unavailable all render as the same requester-side failure. No D2D denial message is sent for soft refusal. The requester must never learn whether the service was absent, the grantor refused, or the grantor did not answer.
- **Grantor-visible truth is private.** The owner should have a quiet, reviewable log: "Alonso's Dina asked for availability_coordination — auto-declined by policy" or "prompt timed out." It is a log, not a push notification. It exists so the owner can spot mis-tiered contacts without creating social leakage.
- **The log is sensitive relationship metadata.** It records who asked for what and how Dina responded. It must live in the grantor's encrypted, owner-private storage and must never be sent to, synced to, or derivable by the requester. Infrastructure audit can exist for debugging, but the product-visible decision log is owner-private.
- **Timing is a side channel.** V1 may accept some timing leakage, but the desired shape is: negative paths converge to the same local timeout/failure window, so "instant soft-refusal" is not distinguishable from "no service/offline/ignored." This is a conscious edge, not an accidental leak.
- **Least disclosure.** Negotiation exchanges only *candidate slots*, never a full calendar. Alonso offers three times he is free; Sancho says which work.
- **The action gate still applies** on every binding commit, independent of the grant (§4).
- **Child-scoped and sensitive data** stay out of generic discovery (existing service-visibility rules); relationship services are `known_only` by construction, so they are never AppView-discoverable.

---

## 11. Non-goals (v1)

- **Real calendar sync / write-back.** No connector exists in the TS stack and none is in scope. Availability is assumed-provided (memory or a feeder agent). The agreed meeting writes a reminder, not a calendar event.
- **Two-phase commit.** Agent reconciliation handles the inconsistency window (§6.3).
- **A negotiation protocol / state machine.** Negotiation is agent behavior over repeated one-shot calls (§6.2).
- **A services-tab UI for relationship services.** Their surface is Talk.

---

## 12. Reuse vs net-new (summary)

| Concern | Status |
|---|---|
| Per-contact grant table + authorization primitive + ingress enforcement | ✅ built (`service_grants`, `isAuthorized`, `receive_pipeline:325-329`) |
| Grant issuance + delivery + offers-list (server) | ✅ built (`/v1/service/offer`, `/v1/service/offers`, `service.offer`) — server-only, **no mobile UX** |
| Requester-initiated grant-request (preflight bootstrap) | ❌ net-new (small) |
| Grant UX in-app (issue / approve / request / see received offers) | ❌ net-new — server done, UI 0% (orphaned Approved-Only tier) |
| Owner-private grant-request decision log | ❌ net-new (small) — visible only to the grantor, never to the requester |
| Closeness inputs on the contact record | ✅ built (`relationship`, `trust_level`) |
| Provider booking capabilities (salon reuse) | ✅ built (`appointment_availability`, `appointment_book`) |
| `availability_coordination` capability (symmetric, mutual) | ❌ net-new (small) |
| Inline lifecycle-card chat machinery | ✅ built — main chat tab only |
| D2D service request/response lane | ✅ built — one-shot |
| Relationship-default grant policy + `closeness()` helper | ❌ net-new (small) |
| Lazy one-time allow prompt | ❌ net-new (small) |
| `surface` typed field in `@dina/protocol` + validation | ❌ net-new (small) |
| Talk-thread card rendering (seam #1) | ❌ net-new (small) |
| Contact-scoped intent routing (seam #2) | ❌ net-new (medium) |
| Inbound D2D → peer thread + response patching (seams #3, #4) | ❌ net-new (medium) |
| Talk-initiated peer invoke (seam #5) | ❌ net-new (medium) |
| Suggestion chip (seam #6) | ❌ net-new (small) |

---

## 13. Phased build plan

- **P0 — Scaffolding.** `closeness()` helper, `surface` field, register the scheduling capability config. Wire seam #1 (Talk renders the existing service_query card). No behavior change yet; cards just appear in Talk.
- **P1 — Outbound, single round (the days-version demo).** Seams #2, #5, #6: user triggers "find a time" in a Talk thread, a `service.query` goes to the peer, the card resolves. Drive the peer with the headless harness. **P1 assumes the grant/offer already exists** — pre-seeded by the harness or a manual provider action — because `known_only` ingress requires a `grant_id`; the in-app grant bootstrap (request → offer) lands in P3. This is the first thing to show on the sim.
- **P2 — Inbound + bilateral commit.** Seams #3, #4: peer-initiated requests land in the right Talk thread; the booking is review-gated on each side; agent reconciliation on decline.
- **P3 — Relationship-default grants + lazy allow.** The default policy, the one-time allow card, the collapsed requester failure outcome, and the owner-private decision log, so it works without hand-issuing grants and without leaking social rank.
- **P4 — Generalize.** Prove a second relationship service (e.g. "what's your view on X") reuses the whole seam unchanged. If it does, the abstraction is right.

Each phase is sim-verifiable before the next. Verify on the simulator, not from the diff.

---

## 14. Open decisions

1. **Intent classifier tuning** — suggest-not-auto-fire is settled; the threshold for *when* to show the chip is a sim-tuning question.
2. **Convergence in code vs agent** (§6.2) — default to agent reasoning; escalate to set-intersection only if the sim shows fumbling.
3. **Default policy per capability** — which relationship tiers get which contact services by default. Product decision, not architecture.
4. **Commit-consistency stakes** — meetings tolerate agent reconciliation; if a future contact service is high-stakes, revisit two-phase commit for that capability only.
5. **Grant materialization trigger** — eager (offered in the contact editor when you mark someone close) vs lazy (auto-grant on a close contact's first request). Both write explicit rows; the ingress gate is single-source either way. Pick per UX.
6. **Coordination capability name** — `availability_coordination` vs `meeting_coordination` vs `find_time`. Naming, not architecture.
7. **Failure timing normalization** — how long the requester waits before showing the generic failure. The invariant is settled (no visible denial); the exact timeout/jitter policy is implementation tuning.
8. **Owner log surface** — Talk thread, contact detail, Activity, or all three. It should be reviewable, not interruptive.
