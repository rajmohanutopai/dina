# Group Coordination — Architecture

*Multi-party availability coordination. Second instance of Contact Services: "plan Emma's birthday with the Millers, the Garcias and the Johnsons."*

Status: design. Grounded against the shipping TypeScript stack (`packages/core`, `packages/brain`, `packages/protocol`, `apps/mobile`) as of 2026-09-15. Every "exists today" claim carries a file reference. Extends `docs/CONTACT_SERVICES_ARCHITECTURE.md`, which listed group coordination under "later" (§3); the 1:1 service it deferred to has since been built, so this is the next step, and it is a composition rather than a new mechanism.

---

## 1. The one-sentence idea

A group plan is **one organizer's Dina running the built 1:1 coordination service against each guest's Dina in parallel, folding the answers on the organizer's node, and never letting a guest's answer reach another guest.** There is no group message on the wire, no shared state between nodes, and no coordinator anyone but the organizer runs.

Three facts decide the shape:

1. The 1:1 service already exists — `availability_coordination` (`packages/brain/src/service/capabilities/availability_coordination.ts`; catalogued in `packages/protocol/src/services/capability-catalog.ts:363`, `known_only`, `intent_routable: false`, introduced 2026-06-29) — with the grant, the preflight and the Talk cards it rides on. A group of four is four of those.
2. Every grant is **per pair** (`service_grants`, `packages/core/src/service/service_grant_repository.ts`). The Garcias granted Mike, and only Mike. A protocol in which the Garcias' answer travelled to the Millers would be spending a grant the Garcias never gave.
3. The fan-out-and-fold pattern is already in the kernel for quotes (`packages/core/src/commerce/quote_fanout.ts`: `planQuoteFanout`, `FanoutPlan`, `MAX_QUOTE_FANOUT = 8`). Asking N peers the same bounded question and folding the replies is the same shape whether the peers are suppliers or families.

So: a **star**. Organizer at the centre; N spokes; each spoke a 1:1 exchange the guest already consented to.

---

## 2. The scenario, as the acceptance test

> Mike tells his Dina: "Plan Emma's 8th birthday with the Millers, the Garcias and the Johnsons — a Saturday this month, around $300." The four families' Dinas coordinate: the Garcias are free the 26th, Lily Miller is gluten-free, the Johnsons can drive. Date settled.

What this document must make true, on the simulator, before anything else is claimed:

- Mike's Dina asks three guest Dinas one question each, in parallel, and settles on a Saturday **without any guest learning another guest's availability**.
- "Lily is gluten-free" reaches Mike **only because the Millers' Dina chose to say it**, under the Millers' own sharing policy for a child's health fact, and it reaches the bakery later as "one gluten-free portion" with no name attached.
- "The Johnsons can drive" is an offer the Johnsons volunteered, not a fact Mike's Dina extracted.
- Each family's reminder lands on that family's node only after that family's owner said yes.
- A family whose Dina cannot be reached, has not granted, or declined, produces the **same** collapsed outcome on Mike's side ("couldn't complete this with the Millers' Dina"), and Mike texts them. Nobody's ranking in Mike's life leaks.

Everything past "date settled" — the cake, the venue, the deposit — is the provider-services and commerce lane, already built and outside this document (§10).

---

## 3. Why a star and not a group protocol

The tempting design is a shared plan object every node holds — a group chat with a schedule attached. It fails three tests the kernel already answers:

**Consent.** A grant is per pair. A shared object means the Garcias' availability is readable by the Millers' node, which the Garcias never authorized. The star keeps each answer on the one node it was addressed to.

**Least disclosure.** In the 1:1 design, negotiation "exchanges only candidate slots, never a full calendar" (`CONTACT_SERVICES_ARCHITECTURE.md` §10). In a star, a guest sees only the organizer's candidates and says which work. What the guest never sees: who else was asked, what they answered, or how many said no. Only the organizer's Dina, folding on the organizer's node, holds the picture.

**No new wire primitive.** The lane is one-shot (`service.query` → `service.response`, `packages/protocol/src/constants.ts:92-93`) with no protocol state machine, by design (§6.2 of the 1:1 doc). A group protocol would need one. A star is N one-shots plus a fold, and the fold is pure code on one node.

The cost is honest: the organizer's Dina becomes a hub that knows every guest's answer. That is the right node to know it — it is the person who asked — and it is bounded by the same rule that governs every other thing Mike's Dina knows about his contacts: it stays in his vault, under his sharing policy, and it is never re-shared (§7).

---

## 4. The exchange

Two rounds, each a fan-out of the **existing** 1:1 capability. No new message types.

```
ROUND 1 — propose
  organizer → each guest   service.query  availability_coordination
                             { intent: "Emma's 8th birthday, a Saturday this month",
                               candidate_slots: [Sat 12, Sat 19, Sat 26] }
  each guest → organizer   service.response
                             { status: accepted, accepted_slots: [Sat 19, Sat 26],
                               disclosures?: [...] }                       ← §6
                       or  { status: counter, counter_slots: [Sun 27] }
                       or  { status: needs_more_info, message: "which weekend?" }
                       or  (nothing — collapsed failure for that guest)

  FOLD (organizer's node, pure code): the slots every REQUIRED guest accepted.
    non-empty → pick (organizer's preference order) → ROUND 2
    empty     → the organizer decides: widen the window, drop a guest from
                required, or stop. Never an automatic second fan-out.

ROUND 2 — confirm
  organizer → each guest   service.query  availability_coordination
                             { intent: "confirming Sat 26, 3pm", candidate_slots: [Sat 26 3pm] }
  each guest → organizer   { status: accepted, accepted_slots: [Sat 26 3pm] }

  Then EACH node commits LOCALLY — a reminder on the guest's node, the
  bookings on the organizer's — each behind its own owner's gate. Not a
  service.query (1:1 doc §6.3).
```

**Convergence is code, and this is where the 1:1 design's open decision closes.** The 1:1 doc left convergence to agent reasoning, escalating to set-intersection only "if the sim shows fumbling" (§6.2, §14.2). With three or more parties the escalation trigger is met before the sim runs: four agents each countering in prose is combinatorial, and a fold that depends on which reply arrived first is a fold that gives different answers on different days. So the fold is a deterministic intersection over **structured slots** — `{start, end?}` as `MeetingSlotSchema` already defines them — computed on the organizer's node, order-independent, and unit-testable with no LLM in the loop. The agents still do what agents are for: turning "a Saturday this month" into candidates, turning a guest's calendar into an answer, and turning an empty intersection into a sentence the organizer can act on.

**Rounds are bounded.** Two by default; a third only on the organizer's explicit say. A plan that has not converged in three rounds is a conversation for humans, and the organizer's Dina says so.

---

## 5. Authorization — four layers, applied per spoke

Nothing new. Each spoke passes the four layers of the 1:1 design (`CONTACT_SERVICES_ARCHITECTURE.md` §4) on its own:

| Layer | Per spoke |
|---|---|
| **1 — Contact trust** | The guest's contact record on the organizer's node, and the organizer's on the guest's. A blocked contact is never asked. |
| **2 — Service grant (reach)** | The guest's `service_grants` row for the organizer. Missing → the preflight `service.grant_request` (`packages/protocol/src/constants.ts:112`, `packages/core/src/d2d/grant_request_handler.ts`) runs under the guest's closeness policy (`packages/core/src/contacts/closeness.ts:49`). A friend gets a one-time "Allow Mike to find a time with you?" card; an acquaintance gets a silent soft-refusal. |
| **3 — Data grant** | What the guest's Dina may **read** to answer, and what it may **say** (§6). The grant to ask is never a grant to disclose. |
| **4 — Action gate** | The guest's reminder and the organizer's bookings each wait for their own owner's yes (`packages/core/src/gatekeeper/intent.ts`). |

**Asymmetric visibility survives fan-out.** The organizer sees per guest one of two states: *answered* or *couldn't complete*. Not granted, soft-refused, offline, ignored, and timed out are the same state, with the same timing window, because the 1:1 design already collapses them (§2, §10). What fan-out adds is the temptation to infer from the pattern — "everyone but the Millers answered within a minute" — and the design answers it the same way: negative paths share one timeout window, and the fold waits for that window to close before it reports.

**Required versus optional guests** is the organizer's call, made once at the start ("the Garcias have to be there; the Johnsons would be nice"). It changes the fold, never the asks — every named family is asked the same question.

---

## 6. Disclosures — how "Lily is gluten-free" travels

The reply schema gains one **optional** field:

```
disclosures?: [{ kind: 'dietary' | 'accessibility' | 'transport' | 'note';
                 text: string;          // one bounded line
                 about: 'household' }]  // never a named individual on the wire
```

Additive to `AvailabilityCoordinationResultSchema`; a 1:1 reply without it stays valid. Everything that matters is in **who decides to attach one**, and that is the guest's node:

1. **The category decides the gate.** A dietary or accessibility fact is `health`-category data (`DATA_CATEGORIES`, `packages/core/src/persona/names.ts`), so the guest's Dina attaches it only if the guest's sharing policy for **this** contact admits that category (`getSharingTier(contactDID, 'health')`, `packages/core/src/gatekeeper/sharing.ts:154`). Transport is `general`. The tier is the guest's, per contact, set before any plan exists — pre-authorization, exactly as the 1:1 design argues for grants (§2).
2. **Health facts about a household are review-gated by default.** Even with the tier admitting it, a reply that would carry a `dietary` or `accessibility` disclosure is **drafted for approval** on the guest's node (`responsePolicy: 'review'`, `packages/core/src/service/service_config.ts:610`) rather than sent silently. The Millers see "Tell Mike's Dina that someone in the household is gluten-free?" once, in their Talk thread with Mike. A yes sends it; a no sends the availability without it. This is Layer 3 doing its job: the grant let Mike ask; only the Millers can let a health fact leave.
3. **`about: 'household'`, never a name.** The wire carries "someone in this household is gluten-free". Mike's Dina knows which household replied, which is all it needs and all it should hold. That Lily specifically is the one is a fact that lives on the Millers' node and stays there.
4. **On the organizer's node a disclosure is plan-scoped contact metadata**, stored under the organizer's own `health` handling for that contact, and it has exactly one onward use: it becomes a **requirement**. When Mike's Dina asks the bakery, the query says "one gluten-free portion". No household, no name, no source. The bakery learns a count; the Garcias learn nothing.

The `transport` kind is the same mechanism with a lighter gate: "we can drive" is `general`, sent under the general tier, no review. The organizer's Dina folds it into the plan as an offer ("the Johnsons offered to drive") and does nothing with it until the organizer does.

**Disclosures flow up to the organizer; only de-identified requirements flow out.** That one sentence is the privacy contract of this document.

---

## 7. What the organizer's node holds

A **plan** is an owner-private record on the organizer's node — Core, encrypted, under the organizer's persona rules. It is the only place the whole picture exists.

```
GroupPlan {
  plan_id, intent, window, created_at,
  guests: [{ contact_did, required: bool,
             spokes: [{ round, task_id, query_id, outcome: answered | unreachable }],
             accepted_slots: Slot[] | null,      // null until answered
             disclosures: Disclosure[] }],
  candidates: Slot[],
  fold: { agreed: Slot[], missing_required: contact_did[] } | null,
  chosen: Slot | null,
  requirements: [{ kind, count }],               // de-identified, for vendors
  state: proposing | folded | confirming | settled | abandoned
}
```

Three rules:

- **It never leaves the node.** Not to a guest, not to a vendor, not to a sync target. A guest's Talk thread carries that guest's own spoke card, nothing about the plan.
- **It is the organizer's to inspect and delete**, like any contact metadata. Deleting the plan deletes the disclosures.
- **It is not a coordinator.** No node waits on it; no message references it. It is the organizer's memory of a conversation that happened over N ordinary one-shot calls. A crash mid-plan leaves N cards in N Talk threads exactly as a crash mid-1:1 does, and the organizer picks up from the cards.

---

## 8. Where the reasoning runs

On each guest's node, with each guest's providers. This is the invariant the Capabilities work stands on and it holds without change here: the organizer's Dina sends a bounded question; the guest's `capability_runtime` (`packages/brain/src/service/capability_runtime.ts`) answers it against the guest's own availability, under the catalogue's `default_instruction` ("never commit to a slot my vault shows as taken; the final booking waits for my approval"), on the guest's own reasoning backend. The organizer's model sees three replies. It never sees three calendars, and it never runs against one.

The fold (§4) runs on the organizer's node in **code**, so the one piece of logic that touches every guest's answer at once is deterministic, testable, and has no model to talk out of it.

---

## 9. The surfaces

**Organizer.** One **plan card** in the main chat, aggregating N spoke cards the way `InlineComparisonCard` (`apps/mobile/src/components/InlineComparisonCard.tsx`) aggregates N offers: a row per family — answered / waiting / couldn't reach — the folded slots, and the organizer's decision controls (choose a slot; widen; drop from required; stop). Each spoke is an ordinary `service_query` lifecycle message keyed by its `taskId` (`ServiceQueryLifecycle`, `packages/brain/src/chat/thread.ts:53-85`), so the existing event consumer patches each row in place as replies land.

**Guest.** One card in the Talk thread with the organizer — the same `service_query` card the 1:1 service already renders there (`apps/mobile/app/chat/[did].tsx:311-328`) — plus, when a disclosure needs a yes, the review card. A guest is never shown a "group"; from the Millers' side this is Mike asking to find a time, which is what it is.

**Silence First.** A guest is never interrupted. The ask lands as a card in a thread the guest already has with the organizer — Solicited by the relationship, not pushed. An unknown or distant contact's ask never renders at all (§5).

---

## 10. Hand-off to vendors (out of scope here, interface stated)

Once `chosen` is set, the plan yields two things the provider-services and commerce lanes already consume:

- **a slot** — `chosen`, for `appointment_book` / a venue query;
- **requirements** — `[{ kind: 'dietary', count: 1 }]`, de-identified (§6), for a bakery query's params.

From there it is `search_provider_services` → `query_service` → quote → order, gated as today. `query_service` asks **one provider per capability per turn** (`packages/brain/src/reasoning/service_tools.ts:448`), and that rule is right for vendors and untouched by this document — which is why the guest fan-out in §4 is **not** N `query_service` calls from the model (§11).

---

## 11. Reuse versus net-new

| Concern | Status |
|---|---|
| 1:1 `availability_coordination` capability, params/result schemas, catalogue entry | ✅ built (`capabilities/availability_coordination.ts`, `capability-catalog.ts:363`) |
| Per-pair grants, ingress enforcement, preflight `service.grant_request`, closeness policy | ✅ built (`service_grant_repository.ts`, `receive_pipeline.ts`, `grant_request_handler.ts`, `closeness.ts`) |
| One-shot D2D lane (`service.query` / `service.response`) | ✅ built (`constants.ts:92-93`) |
| Talk-thread lifecycle cards, review cards | ✅ built (`chat/[did].tsx:311-328`) |
| Sharing tiers per contact per category; `health` category | ✅ built (`gatekeeper/sharing.ts:154`, `persona/names.ts`) |
| Review-gated responses (`responsePolicy: 'review'`) | ✅ built (`service_config.ts:610`) |
| Local reminder commit | ✅ built (`reminders/backend.ts:61`, `createReminderRouted`) |
| Fan-out plan shape | ✅ pattern built for quotes (`quote_fanout.ts`); ❌ a peer-coordination instance is net-new (small) |
| **Core-owned fan-out + fold primitive** for N `availability_coordination` spokes, bounded, order-independent | ❌ net-new (**medium**) — the one real piece of this document |
| `disclosures` on the result schema + the guest-side attach rule (tier check, review gate, `about: 'household'`) | ❌ net-new (small, additive) |
| `GroupPlan` owner-private store + `requirements` derivation | ❌ net-new (small) |
| Organizer plan card aggregating spoke cards | ❌ net-new (small; `InlineComparisonCard` is the precedent) |
| Intent seam: "plan X with A, B and C" → fan-out, contact-scoped per name | ❌ net-new (medium; extends seam #2 of the 1:1 doc to N contacts) |
| A group message type, a shared plan object, a coordinator | **not built, by design** |

**Why the fan-out is a Core primitive and not N model tool calls.** `query_service` is terminal and refuses a second dispatch of the same capability in a turn, for good reason: two provider cards for one question is the failure it prevents. A group plan needs the opposite — N identical asks that are one question — so the model gets **one** tool, `coordinate_group`, that hands the guest list and candidates to Core, and Core fans out, bounds (`MAX_GROUP_GUESTS`, proposed 8, the same ceiling as `MAX_QUOTE_FANOUT`), collapses failures per spoke, waits the shared timeout window, and folds. The model never sees a per-guest dispatch, so it cannot fan out selectively, retry one family five times, or narrate who answered first.

---

## 12. Security and privacy

- **No transitive disclosure, structurally.** A guest's answer is addressed to the organizer and is stored on the organizer's node only. There is no code path that places one guest's slots or disclosures in a message to another guest, because there is no message to another guest that carries anything but the organizer's own candidates.
- **Disclosures are the guest's decision, under the guest's tiers, review-gated for health.** §6. A grant to ask never becomes a licence to extract.
- **Requirements leave de-identified.** A vendor receives counts and kinds. A test pins that no `contact_did`, household name, or disclosure text appears in any vendor-bound params.
- **Children have no nodes and appear in no payload.** "Emma", "Lily" are names in the owners' prose, never fields on the wire; `about: 'household'` is the only granularity a disclosure carries.
- **Asymmetric visibility per spoke, and the fold waits for the window.** §5. The organizer cannot distinguish a refusal from an outage, per guest or by pattern.
- **Bounded.** Guests ≤ 8, candidates ≤ 12, rounds ≤ 3, disclosure text one bounded line. The fold is O(guests × candidates) and pure.
- **Authorization binds to the transport-authenticated sender** on every spoke, as every D2D handler already does. A guest's reply is accepted only from the DID it was sent to.
- **The plan is owner-private and deletable**, and deleting it deletes what guests disclosed for it.

---

## 13. Failure modes

| Case | What happens |
|---|---|
| Empty intersection | The plan card says which required family made it empty **only if that family answered** ("no Saturday works for the Garcias") and offers: widen, drop from required, stop. It never reads a non-answer as a no. |
| A family unreachable | Collapsed per-spoke outcome after the shared window. The organizer texts them; the plan proceeds on the organizer's say with that family marked optional, or waits. |
| A family changes its mind after Round 2 | Agent reconciliation, as in the 1:1 design (§6.3): the guest's Dina sends "the Garcias can't make the 26th after all"; the organizer's card reopens the fold. No two-phase commit at these stakes. |
| Organizer cancels | A Round-2-shaped confirm with `intent: "cancelled"` to each answered guest; each guest's Dina drafts a reminder removal for its owner. |
| Organizer's node crashes mid-plan | N spoke cards remain in N threads; the plan record is rebuilt from them on the next open. Nothing on any guest's node is inconsistent, because nothing on any guest's node depends on the plan. |
| A guest replies with a disclosure the organizer's tiers refuse to hold | Dropped on receipt, audited as metadata (kind and count, never text). The reply's slots are kept. |

---

## 14. Non-goals

- **A group chat, a shared calendar, or any object N nodes hold together.** §3.
- **Calendar sync.** As in the 1:1 design: availability is what the owner's vault and memory say; the commit is a reminder.
- **Payments and splits.** "Deposit through Fiserv, split four ways" is Cart Handover territory: Dina hands the cart to a payment rail and never touches money (`payment` is BLOCKED for plugins at every ring, `gatekeeper/intent.ts`). Nothing in this document moves money, and nothing should.
- **Nodes for children.** A family's Dina is a parent's Dina.
- **Recurring or standing plans.** One plan, one window.

---

## 15. Phased build

- **P0 — The fold, pure.** `coordinate_group` fan-out plan + deterministic intersection over structured slots, in Core, with no network: contract tests for order-independence, the required/optional rule, bounds, and the "a non-answer is never a no" rule. Headless.
- **P1 — Spokes on the sim.** Fan out real 1:1 `availability_coordination` queries to three headless guest nodes with pre-seeded grants; collapse per spoke; fold on the organizer. The first thing to show.
- **P2 — Disclosures.** The additive result field, the guest-side attach rule (tier check + review card), `about: 'household'`, and the de-identified `requirements` derivation. Tests pin that a health disclosure never leaves without a yes and never reaches a vendor with a name.
- **P3 — Surfaces.** The organizer's plan card; the intent seam for "plan X with A, B and C" resolving N contacts by name through the people graph.
- **P4 — The Austin demo.** Hand `chosen` + `requirements` to the existing provider lane against a headless bakery and venue. The consumer beat is then demoable on shipping code, which it is not today.

Each phase is sim-verifiable before the next. Verify on the simulator, not from the diff.

---

## 16. Test plan (contract tests, by rule)

1. **Fold is order-independent** — the same replies in any order give the same `agreed` set.
2. **A required guest's non-answer blocks; an optional guest's does not.**
3. **A non-answer is never read as a refusal** — the empty-intersection message names only guests who answered.
4. **No spoke carries another spoke's data** — every outbound `service.query` body in a plan equals the organizer's own candidates and intent; a property test over N guests.
5. **A health disclosure requires the tier AND a yes** — tier `none` → never attached; tier admits, review pending → not attached until approved.
6. **`about` is always `'household'`** — the validator refuses any other value; no field on the wire can carry a person's name.
7. **Requirements are de-identified** — vendor-bound params contain no `contact_did`, no display name, no disclosure text.
8. **Bounds refuse, never truncate silently** — guest 9, candidate 13 and round 4 are typed refusals the organizer sees.
9. **Collapsed failure timing** — unreachable, ungranted and soft-refused spokes resolve in the same window, asserted with an injected clock.
10. **The model cannot fan out selectively** — `coordinate_group` is the only tool that touches N contacts; `query_service` still refuses a second dispatch per capability per turn.

---

## 17. Open decisions

1. **Ceilings.** 8 guests, 12 candidates, 3 rounds are proposals matched to `MAX_QUOTE_FANOUT`; product may want a lower guest ceiling for a first release.
2. **Required-by-default or optional-by-default** when the organizer does not say. Proposed: required, so a plan never silently proceeds without someone the organizer named.
3. **Disclosure kinds for v1.** `dietary`, `accessibility`, `transport`, `note` proposed. `note` is free text under the `general` tier and is the one to watch for leakage; consider omitting it from v1.
4. **The review card's default for `transport`.** Proposed no review (general tier); revisit if the sim shows guests surprised by what their Dina volunteered.
5. **Where the plan card lives** — main chat only, or also a Plans view under Activity. Reviewable, never interruptive.
6. **Whether the organizer's stored disclosures expire with the plan** or persist as contact facts the organizer may keep ("the Millers have a gluten-free child") — persisting is useful and also the larger privacy claim; proposed: expire with the plan unless the organizer explicitly keeps them.
