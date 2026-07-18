# Push Services: Solicited Signal Without Surrender of Silence

## Architecture grounded in Dina's current system

**Status:** Design specification. Implementation is phase-gated. Grounded against the shipping TypeScript stack (`packages/core`, `packages/brain`, `packages/protocol`, `apps/mobile`, `apps/home-node-lite`) and the design-only control-plane blueprint (`docs/mobile/DINA_WORKFLOW_CONTROL_PLANE.md`). Every "exists today" claim carries a file reference; everything else is net-new.

**Purpose:** Let a person authorize a trusted service to notify them when a condition they declared becomes true — "tell me when the BTC price crosses 100k," "alert me if flight BA117 is delayed," "warn me if a charge over $500 hits my card" — without letting any provider push content at the user, escalate its own urgency, or farm the user's attention. Push in Dina is the provider-driven fulfillment of a request the user already made, mediated end to end by the same silence, persona, and trust machinery that governs everything else.

This document is the fourth service specification in the family, after `docs/SERVICES_LAUNCH_ARCHITECTURE.md` (pull/query discovery), `docs/CONTACT_SERVICES_ARCHITECTURE.md` (peer pre-authorization), and `docs/CURATION_SERVICES_ARCHITECTURE.md` (earned-trust recommendation). It reuses their primitives rather than inventing a parallel network.

---

## 1. The idea in plain language

Dina's first law is **Silence First**: she never pushes content; she speaks only when asked, or when silence would cause harm. A "push service" sounds like a direct violation of that law. It is not, once you see what a push actually is.

**A push is a deferred pull.** In the pull model the subscriber asks now — "what time is the next bus?" A push is the same request, pre-authorized to be *completed by the provider at the moment a condition the subscriber declared becomes true*. The subscriber still initiates; the provider merely fulfils a standing request when the world changes. Nothing is ever delivered that the subscriber did not first ask for. Silence First is preserved exactly, because the user broke their own silence in advance, on purpose, with a specific trigger.

Two rules follow, and they are the spine of this document:

> **The subscriber pulls; the provider only completes the pull.** No push exists without a matching, active, subscriber-authored authorization. Unsolicited push is dropped and quarantined, the same way an unknown stranger's message is.

> **The provider proposes; Dina disposes.** A push carries the provider's *claimed* urgency, but that claim is untrusted input — exactly like a curator's rationale or a service result card. Dina's own silence classifier re-derives the delivery tier from the subscriber's authorization and Dina's harm assessment. A provider can never escalate itself to an interrupt.

Everything else — rate budgets, persona binding, cry-wolf accountability, privacy minimisation — exists to make those two rules hold under an adversary whose entire incentive is to capture attention Dina is built to protect.

The intended division of labour:

> Providers watch the world. The subscriber declares what matters. Dina decides whether this moment justifies breaking silence, and at what volume.

---

## 2. Scope and non-goals

### 2.1 In scope

- Authorizing a trusted service to notify on a subscriber-declared condition.
- A standing, revocable, persona-scoped, rate-budgeted push authorization.
- A provider-initiated push message that Dina authenticates, authorizes, re-classifies and delivers or suppresses.
- Reusing the silence classifier so provider-claimed urgency is never trusted.
- Keeping personal vault context local by default; the condition itself is the only thing the provider learns.
- Delivering through the existing notification, briefing and Activity surfaces — no new feed.
- Measuring push signal quality (did the notification matter?) and degrading providers that cry wolf.
- Reusing Dina services, grants, D2D and PeerLens instead of a parallel push network.

### 2.2 Non-goals

- Guaranteeing delivery, ordering or timing. Push is best-effort over D2D/MsgBox and may be delayed while a persona is locked or a device is offline.
- Proving that a provider's declared condition actually occurred. Evidence and outcomes reduce lying; they do not eliminate it.
- Letting a provider set its own priority, bypass quiet hours, or reach the user faster by claiming urgency.
- Creating a feed, an engagement loop, unread-count pressure, or any habit-forming surface. Push fulfils the user's standing requests; it does not manufacture reasons to open the app.
- Reporting to the provider whether or when the user saw a push. Delivery is never an attention signal a provider can observe.
- Replacing reminders (user-scheduled, self-authored) or ordinary query services (pull-now).
- Server-to-agent command push, remote code execution, or provider-driven task creation. A push is a notification, not an instruction.

---

## 3. Architectural position

A push service is an ordinary Dina service that additionally declares a **push capability**. It is not a new privileged actor and receives no protocol badge. The delivered push is the provider-driven fulfilment of a **watch** — the long-lived, subscriber-owned work item that the control plane already types but has never used.

The system composes four existing layers plus one dormant primitive:

| Layer | Existing Dina mechanism | Push use |
|---|---|---|
| Identity | DIDs, service URIs, runtime issuers | Identify the provider operator and the push signer |
| Authorization | Service grants, service windows | The standing push authorization that admits an inbound push |
| Execution/transport | Services + D2D families + receive pipeline | Carry `push.subscribe`/`push.event` and gate them |
| Decision/delivery | Silence classifier + notification inbox + briefing | Re-classify and deliver, suppress, or defer a push |
| Durable anchor | `WorkflowTaskKind.Watch` (declared, unused) | The subscriber-side record of a standing subscription |

The new work is additive: a push capability class and schema; a `push.*` D2D family; a push-authorization grant; a receive-pipeline branch; a cry-wolf accountability dimension; and subscription-management UI. There is no second service registry, no second trust graph, and no new delivery transport.

### 3.1 Mapping to shipping code

This specification is additive. `Shipping foundation` names existing code; everything in `Push work` is unimplemented unless a later status update says otherwise.

| Concern | Shipping foundation | Push work |
|---|---|---|
| Priority tiers | `packages/brain/src/guardian/silence.ts` — `PriorityTier = 1\|2\|3` (`:20`), `classifyPriority` (`:378`), `classifyDeterministic` (`:476`); wire enum `'fiduciary'\|'solicited'\|'engagement'` in `packages/brain/src/notify/notification_frame.ts:46` | Reuse unchanged. Push events enter the classifier as untrusted events with a declared source and a per-authorization priority ceiling. |
| Provider-claimed urgency is untrusted | Marketing-source guard `silence.ts:496` and `:353` (a marketing source can never be LLM-elevated to Tier 1) | Generalize: a push source is capped at its authorization ceiling; only Dina's harm logic may exceed it (§9). |
| Repeat handling | Engagement escalation `silence.ts:400`, `ESCALATION_THRESHOLD = 3` (`packages/brain/src/constants.ts:116`) | **Invert for push.** Repeated firing is cry-wolf evidence and must downgrade, never escalate (§9, §12). Push-sourced events bypass generic escalation. |
| Quiet hours / DND | `silence.ts:416/426`; `packages/brain/src/notifications/dnd.ts` `shouldDeliverNotification` (`:102`) | Reuse unchanged. Push inherits the user's global quiet configuration; Tier 1 is never suppressed. |
| Tier-3 sink | `packages/brain/src/briefing/assembly.ts` `assembleBriefing` (`:82`, returns null when empty) | Engagement-tier pushes accumulate here; register a push engagement provider. |
| Unified surface | `packages/brain/src/notifications/inbox.ts` (`appendNotification:88`) + `apps/mobile/app/notifications.tsx` Activity tab | Add a `push` notification kind; render in the existing chronological inbox. |
| Local OS delivery | `apps/mobile/src/notifications/local.ts` — `ensureChannels` (`:106`, three channels fiduciary/solicited/engagement), `scheduleNotification` (`:200`) | Reuse the three channels; a delivered push maps to a channel by re-classified tier. |
| Server→device delivery | `apps/home-node-lite/core-server/src/ws/notify_hub.ts` `NotifyHub`, `notify_route.ts` `/v1/ws/notify`, `push_envelope.ts` sealed envelope — **built, not wired at boot** | Wire the notify route to a live producer as part of push delivery on server Home Nodes. |
| Remote wake (app closed) | none — no FCM/APNs/Expo remote push in source | Net-new and out of scope for v1; see §8 delivery-liveness honesty. |
| Service profile + capability | `packages/brain/src/service/service_publisher.ts` (`SERVICE_PROFILE_COLLECTION:31`); catalog/registry `packages/protocol/src/services/*`; `ServiceResponsePolicy = 'auto'\|'review'` (`capability.ts:19`) | Add an official `push_notify` capability with frozen subscribe/condition/event schemas and privacy class. |
| Provider-initiated precedent | `safety.alert` — the only always-pass provider-initiated family (`packages/protocol/src/constants.ts:87`, `packages/core/src/d2d/families.ts:147`) | Push is the general, *authorization-gated* form; `safety.alert` remains the narrow un-gated harm channel. |
| Provider pushes authorization | `service.offer` + `packages/core/src/service/issue_offer.ts` `issueServiceOffer:60` | Push inverts it: the *subscriber* authorizes the provider. Reuse the mint-then-deliver, roll-back-on-failure pattern. |
| Standing authorization | `packages/core/src/service/service_grant_repository.ts` — `ServiceGrant` (`:20`), `isAuthorized` (`:139`), `grantType='standing'` | Add a `push` grant type keyed to `(providerDid, serviceRkey, pushCapability, subscriptionId)`; it is the gate an inbound push must pass. |
| Inbound gating | `packages/core/src/d2d/receive_pipeline.ts` `receiveD2D` (`:134`); type gate (`:219`); service-ingress bypass (`:275`) | Register the `push.*` family and add an authorization-gated branch beside the service-ingress lane. |
| Durable subscription anchor | `packages/core/src/workflow/domain.ts` `WorkflowTaskKind.Watch`/`.Timer` (`:60`, **declared, unused**), state `scheduled` (`:28`) | Materialize each subscription as a `watch` task; it survives restarts and drives poll-mode fallback. |
| Time-triggered fire loop | `packages/core/src/reminders/scheduler.ts` `tick` (`:50`, 30s); workflow sweepers | Reuse for poll-mode watches and for authorization/lease expiry. |
| Async result → user | `packages/brain/src/service/workflow_event_consumer.ts` (`:200`) | Fan delivered pushes to the user surface through the existing consumer. |
| Card payload | `docs/CARD_SPEC_DESIGN.md`; `packages/protocol/src/services/card-spec.ts` + `validateCardSpec` | A push payload is a bounded, validated CardSpec (data, not code); trust UI stays Dina-owned. |
| Standing subscription blueprint | `docs/mobile/DINA_WORKFLOW_CONTROL_PLANE.md` §6 Watches (`:354`), §7 Obligations (`:391`), wake reasons `watch_event`/`obligation_due` (`:234`) — **design-only** | This document specifies the *provider-driven* fulfilment of that watch. Poll-mode fulfilment is the §6 blueprint; push-mode is the net-new inbound path. |
| Vault-context egress | `docs/CONTEXT_FIREWALL_DESIGN.md` — **design-only** | Push v1 sends **no** vault-derived context to the provider; only the declared condition. Remote context awaits the firewall (§10). |

`push_notify` is an official, flat snake-case capability so every client agrees on its privacy class, subscribe binding, event schema and delivery semantics. Dotted `com.dinakernel.push.*` identifiers are reserved for public ATProto records (accountability, §12), not the service capability ID.

### 3.2 Watch, poll and push — one anchor, two fulfilment modes

A subscription is one durable `watch` task with two ways it can be fulfilled:

- **Poll mode (Dina-driven).** The watch's `next_run_at` fires on the existing scheduler; Dina sends an ordinary `service.query`; the provider answers with `service.response`. This is pure scheduled pull — no new inbound trust surface — and is exactly the `DINA_WORKFLOW_CONTROL_PLANE` §6 design. Best for reference data and providers you do not trust to hold a condition.
- **Push mode (provider-driven).** The provider holds the condition and sends `push.event` the instant it becomes true. Dina authorizes it against the watch's standing grant and re-classifies it. Best for low-latency, low-battery, fire-while-asleep signals.

The same watch can declare a **poll fallback**: if a push-mode provider goes silent past a declared interval, Dina degrades to polling so a broken webhook does not silently drop a signal the user cares about. Push mode is an optimisation of poll mode, never a replacement for the user's control over it.

---

## 4. Roles

### 4.1 Subscriber
The person whose Dina authorizes a push and receives it. The subscriber declares the condition, the priority ceiling, the rate budget, the persona and the expiry. Local preferences always override provider defaults.

### 4.2 Push provider operator
The person or organization accountable for a push service, identified by `operator_did`. Responsible for firing only on the authorized condition, honestly, within budget.

### 4.3 Push service
The specific published service that accepts subscriptions and fires pushes, identified by `service_uri`. One operator may run several; push standing does not transfer between them.

### 4.4 Runtime issuer
The key authorized to sign live push events, following the runtime-issuer model from the plugin and curation architectures. May differ from the PDS repository identity.

### 4.5 Delivery classifier
**Dina herself.** Not a role a third party can occupy. Dina alone maps a received push to a delivery tier, bounded by the authorization ceiling and Dina's harm logic. This role is named explicitly so it is never delegated.

### 4.6 Signal-quality scorekeeper
An optional AppView-like service (Phase 2+) that computes a push provider's cry-wolf and precision standing from opt-in, privacy-preserving public evidence, under a published, pinned policy. Reuses the curation scorekeeper model; a user may choose one or more or none.

---

## 5. The three delivery tiers

Every delivered push resolves to exactly one of the silence classifier's existing tiers. The tier is Dina's decision, not the provider's claim.

| Tier | Silence tier | What Dina does | Authorization needed | Example |
|---|---|---|---|---|
| **Fiduciary** | 1 (`interrupt`) | Interrupts now, even in quiet hours | Subscriber marks the topic a harm topic **and** Dina's harm logic concurs | "A $4,200 charge you didn't make just posted." |
| **Solicited** | 2 (`notify`) | A notification; suppressed only by quiet hours | Subscriber raises the ceiling to solicited for this topic | "BA117 is delayed 90 minutes." |
| **Engagement** | 3 (`briefing`) | Held for the daily briefing; never interrupts | Default for any push | "New episode from the podcast you follow." |

Three rules make this safe:

1. **Every push starts at Engagement.** A new authorization's ceiling defaults to Tier 3 (briefing-only). The user must deliberately raise it. Most provider push wants to live at Tier 2; Dina makes them earn the ceiling from the user, not from a flag in the payload.
2. **Only the subscriber and Dina can reach Fiduciary.** The provider's `claimed_priority` can request at most the authorization ceiling. Tier 1 additionally requires the subscriber to have declared the topic fiduciary *and* Dina's own harm assessment to agree — the same asymmetry as the existing marketing-source guard (`silence.ts:353`), generalized: an untrusted push source cannot self-elevate to an interrupt.
3. **Engagement never interrupts, ever.** A Tier-3 push cannot become an interrupt through repetition, provider claim, or LLM refinement. It waits for the briefing or it waits forever.

---

## 6. The push authorization (subscription)

A subscription is a subscriber-authored, standing, revocable grant. It is the only thing that admits an inbound push. It is a `service_grants`-style record (`grantType='push'`) anchored to a local `watch` task, held in the persona the topic belongs to.

Conceptual fields:

```text
subscription_id            local, opaque, the key everything hangs off
provider_did               operator accountable for the service
service_uri                the specific push service
push_capability            e.g. push_notify
persona                    which persona owns this topic and its DEK
topic_id                   canonical topic under the push scope taxonomy
condition                  the declared trigger (bounded, schema-validated)
priority_ceiling           engagement (default) | solicited | fiduciary
rate_budget                tokens per window (e.g. 3 / 24h), refill rule
quiet_hours_policy         inherit_global (default) | topic_override
fulfilment                 push | poll | push_with_poll_fallback
poll_interval?             for poll or fallback modes
delivery_evidence          none (default) | trigger_evidence_required
expires_at                 standing but bounded; auto-expires
created_at
```

Design rules:

- **Persona-bound.** The subscription lives in one persona and inherits its tier. A `/financial` fraud-alert subscription is closed with the vault; while the persona is locked, a matching push is held (dead-drop style) or reduced to a tier-safe summary, never decrypted eagerly. A `/health` topic is sensitive by default and refuses a public priority ceiling above Solicited without an explicit sensitive-scope confirmation (§10).
- **Ceiling, not floor.** `priority_ceiling` caps how loud a provider may ever be. Dina may deliver *quieter* (quiet hours, low confidence, cry-wolf downgrade) but never louder.
- **Budgeted.** `rate_budget` is a token bucket. Over-budget pushes are demoted to briefing or dropped, and the overage counts against the provider's standing (§12). There is no way to buy a bigger budget from the provider side; it is the subscriber's dial.
- **Bounded and decaying.** `expires_at` is required. A standing subscription is not permanent; the user re-affirms interest by renewal, which is a natural moment to re-consent to the ceiling and budget.
- **Instantly exitable.** Mute, snooze, lower-ceiling, and revoke are local and immediate (§12). Revocation flips the grant's `revokedAt`; the very next push fails `isAuthorized` and is dropped. No provider permission is sought or awaited.

The provider learns of the subscription through a `push.subscribe` handshake (§7) so it knows what to watch, but the *authority* to deliver lives entirely in the subscriber's local grant. A provider that ignores an unsubscribe simply finds its pushes dropped.

---

## 7. Protocol surface

### 7.1 Capability

A push service publishes a normal `com.dinakernel.service.profile` declaring the official capability `push_notify` with frozen schemas for the subscribe request, the condition grammar, and the event. Curation-style linked records carry scope and disclosure metadata. Additive public NSIDs (accountability only, §12), conceptually:

```text
com.dinakernel.push.declaration     # scope, condition grammar, disclosures
com.dinakernel.push.outcome         # opt-in signal-quality evidence
com.dinakernel.push.scoreSnapshot   # scorekeeper standing (Phase 2+)
```

### 7.2 D2D families

Four new V1 families, registered in `packages/core/src/d2d/families.ts` (so they survive the receive-pipeline type gate at `receive_pipeline.ts:219`), each mapped to a new `push` scenario:

```text
push.subscribe     subscriber -> provider : start watching this condition
push.ack           provider -> subscriber : accepted | rejected + terms
push.event         provider -> subscriber : the condition fired (the push)
push.unsubscribe   subscriber -> provider : stop (courtesy; authority is local)
```

`push.subscribe`/`push.ack` reuse the request/response shape of `service.query`/`service.response`. `push.event` is the only genuinely new inbound trust surface and is `EPHEMERAL` (never vaulted as a raw message; its *payload* may be staged after classification), TTL-bounded like other service families (`MAX_SERVICE_TTL`).

### 7.3 The push event

A `push.event` body, signed by the provider runtime:

```text
event_id
subscription_ref           the subscription_id this claims to fulfil
provider_did
runtime_issuer_did
runtime_key_id
service_uri
topic_id
condition_ref              which authorized condition fired
trigger_evidence?          bounded proof/description of what became true
claimed_priority           engagement | solicited | fiduciary  (a request, not a grant)
card                       a bounded, validated CardSpec payload
dedup_key                  collapse duplicates for one logical event
sequence                   per-subscription monotonic counter
issued_at
expires_at                 staleness bound; a stale push is dropped
signature
```

`card` is validated by `validateCardSpec` and treated as untrusted data: text and item counts bounded, unsupported presentation stripped, links opened only through first-party confirmation, no embedded instructions or tool calls honoured. `trigger_evidence` is likewise untrusted; it raises the provider's accountability if later shown false but never elevates delivery on its own. `claimed_priority` is a hint the classifier caps at the authorization ceiling.

### 7.4 The subscribe handshake

`push.subscribe` carries the topic, the condition (bounded grammar per the push scope's declared condition schema), a subscriber-generated `subscription_id`, the requested fulfilment mode, and a coarse `ttl`. The provider replies `push.ack` with `accepted|rejected`, any provider-side minimum interval, and the runtime issuer that will sign events. The subscriber records the local `watch` task and mints the standing push grant only on `accepted`, mirroring `issueServiceOffer`'s mint-then-confirm discipline (`issue_offer.ts:60`).

---

## 8. The delivery pipeline

An inbound `push.event` traverses the existing D2D receive gates (`receive_pipeline.ts:134`) and then a push-specific lane. Order matters; each gate fails closed.

1. **Unseal, verify signature, sender-bind, replay-cache** — unchanged (`receive_pipeline.ts:142/157/180/198`). The inner `provider_did` must equal the transport-authenticated sender (anti-trust-inheritance).
2. **Type gate** — the `push.*` family must be registered or the message is dropped as non-V1 (`:219`).
3. **Blocked-sender pre-gate** — a blocked provider is dropped even with a live subscription (`:248`). Blocking always wins.
4. **Authorization gate (the keystone).** Look up an active push grant for `(provider_did, service_uri, push_capability, subscription_ref)` via `isAuthorized` (`service_grant_repository.ts:139`). No active grant → **drop and quarantine.** Unsolicited push is the primary abuse and is default-denied, exactly like an unknown stranger's message. This gate is why a provider cannot push to anyone who did not first authorize this precise subscription.
5. **Condition-binding gate.** The event's `condition_ref` must match the subscription's authorized condition. A push for a condition the user did not declare is dropped and counts against standing.
6. **Rate/budget gate.** Consume one token from the subscription's bucket. Over budget → demote to briefing or drop (per subscription policy) and record an overage (§12). This runs before classification so a flood cannot even reach the classifier at full volume.
7. **Staleness and dedup.** Drop if past `expires_at`; collapse by `dedup_key`; reject out-of-window `sequence`.
8. **Silence re-classification (§9).** Dina derives the tier, capped by `priority_ceiling`.
9. **Persona gate.** If the topic's persona is locked, hold the push (dead-drop) or render a tier-safe summary; never eagerly derive a DEK to decrypt provider content.
10. **Quiet hours / DND.** `shouldDeliverNotification(tier)` (`dnd.ts:102`): Tier 1 always delivers; Tier 2 waits out quiet hours; Tier 3 goes to briefing regardless.
11. **Deliver.** Tier 1 → interrupt via the notify path (`NotifyHub` on server once wired; local channel `fiduciary` on mobile). Tier 2 → notification in the Activity inbox (`inbox.ts:88`, kind `push`). Tier 3 → briefing buffer (`assembly.ts`).
12. **Audit and outcome.** Log the decision (tier, delivered/suppressed, budget state) with metadata only, never provider payload text to stdout. The user's later reaction becomes the push outcome (§12).

**Delivery-liveness honesty.** With no FCM/APNs in the stack, a push cannot wake a fully-closed mobile app in v1; it lands when Dina next runs (WebSocket reconnect, foreground, or OS-scheduled local check). Fiduciary topics that genuinely require closed-app wake must say so and, until remote push exists, fall back to a scheduled local check or a server Home Node holding the `NotifyHub` socket. The product must not imply real-time closed-app interrupts it cannot deliver.

---

## 9. Silence reconciliation — how Dina disposes

The classifier (`silence.ts`) already does almost all of this; push wires into it as an event source with three adjustments.

- **Provider claim is a capped hint.** `claimed_priority` enters as the event's declared urgency, then `classifyPriority` (`:378`) resolves the tier and Dina clamps the result to `min(resolved_tier, priority_ceiling)`. A provider claiming Fiduciary on an Engagement-ceiling subscription is delivered to the briefing, full stop.
- **Repetition downgrades, it never escalates.** The generic engagement-escalation path (3 repeats → Tier 1, `silence.ts:400`) is correct for user-relevant recurring signals and *wrong* for an untrusted provider — it would reward a spammer with an interrupt. Push-sourced events bypass generic escalation; instead, repeated firing within a window is cry-wolf evidence that *lowers* the effective ceiling (§12). This inversion is the single most important behavioural difference between push and the existing classifier inputs.
- **Fiduciary requires two independent yeses.** Tier 1 is reachable only when the subscription is a subscriber-declared harm topic *and* Dina's own deterministic harm assessment concurs. The provider is never one of the two yeses. Marketing-adjacent push sources inherit the existing guard: they can never be elevated to Fiduciary by the LLM (`silence.ts:353`).

Quiet hours, DND, stale-content demotion and user overrides all apply unchanged. A user override always wins (`silence.ts:385`), including "this provider is never above briefing" or "this topic may always interrupt me."

---

## 10. Privacy

- **Interest disclosure is the cost of subscribing.** A `push.subscribe` tells the provider what you care about (this flight, this ticker, this threshold). Minimise it: category-level topic, coarse condition parameters, no vault excerpts, no relationship graph, no personalization features. This is the same posture as curation §8.
- **The condition can itself be sensitive.** Subscribing a `/health` topic ("alert me if my glucose feed crosses X") reveals a condition to a third party. Sensitive-persona subscriptions require an explicit outbound confirmation — publishing DID, provider, topic, exact condition and the network-metadata warning — before the first `push.subscribe` is sent, mirroring curation §8.3. Sensitive topics default to poll mode (Dina asks) rather than push mode (provider holds the condition) unless the user opts in.
- **No vault context to the provider, ever, in v1.** The semantic Context Firewall (`docs/CONTEXT_FIREWALL_DESIGN.md`) is unbuilt; until it exists, push conditions carry only what the user typed, never vault-derived context, and ordinary approval plus PII scrubbing is explicitly not treated as an adequate substitute.
- **Delivery is not observable to the provider.** A provider learns nothing about whether or when a push was delivered, opened, dismissed or muted. There are **no delivery or read receipts to providers.** Delivery visibility is an attention-capture signal, and withholding it is a hard invariant, not a setting. (Opt-in signal-quality outcomes in §12 are a separate, explicit, user-initiated act — never an automatic read receipt.)
- **The provider infers, but is not told.** A provider can infer you are still subscribed from the absence of an unsubscribe, and can infer engagement from a later opt-in outcome. It is never handed a delivery event. The subscription-management UI states this plainly.

---

## 11. Standing model — earned restraint

Curation measures a provider's earned *judgment*; push measures its earned *restraint*. The signal a good push provider builds is: when it fired, it mattered; when it stayed quiet, nothing was lost. Standing is a vector, never one number, and is always conditional on observable evidence.

Conceptual dimensions (Phase 2+, computed by a signal-quality scorekeeper from opt-in evidence):

```text
service_uri
topic_scope
precision_estimate           fired-and-mattered / fired         (conditional)
cry_wolf_rate                claimed-urgent-then-dismissed / claimed-urgent
false_trigger_rate           trigger_evidence later shown false
budget_overage_rate          pushes over the subscriber's budget
median_signal_latency        condition-true to push (self-reported, labelled)
disclosure_completeness
coordination_risk
effective_sample_count
computed_at
```

`precision_estimate` is conditional on published outcomes for delivered pushes; it is not an unbiased probability that a future push will matter, and a scorekeeper must never relabel it "accuracy." Like curation, unknown denominators stay unknown: Dina cannot see the pushes a provider *chose not to send* or *sent to users who never reported*, so standing is honestly partial.

---

## 12. Accountability — cry-wolf and instant exit

Two mechanisms keep an authorized provider honest, one local and immediate, one networked and slow.

**Local, immediate (every deployment, Phase 1):**

- **Instant exit.** Mute (this subscription, this window), snooze, lower the ceiling, shrink the budget, or revoke — each is a one-tap local action that takes effect on the next push with no provider involvement. Revocation flips the grant and the next `push.event` fails `isAuthorized`.
- **Cry-wolf downgrade.** A push that claims Solicited/Fiduciary and is *immediately dismissed or muted* by the user lowers the subscription's effective ceiling automatically (Solicited → Engagement) after a small, published threshold. A provider that keeps crying wolf ends up in the briefing where it can no longer interrupt, without the user having to do anything.
- **Over-fire clamp.** Budget overages and condition-mismatched pushes accumulate a local suspicion score; crossing a threshold auto-suspends the subscription and surfaces a "this provider is over-firing — keep, mute, or unsubscribe?" prompt (itself a Solicited item, so it cannot itself become spam).

**Networked, opt-in (Phase 2+):**

- **Public signal-quality outcomes.** With explicit per-payload consent, a subscriber may publish a `com.dinakernel.push.outcome` — "this push mattered" / "this was noise" / "this trigger was false" — bound to the subscription and possession-checked so a firehose observer cannot forge it (reusing the curation receipt/nullifier discipline). Scorekeepers aggregate these into the §11 standing dimensions, coordination-weighted and series-capped so one angry subscriber cannot decisively punish a provider.
- **Discovery reflects restraint.** In the services surface, a provider's push standing sits beside its query/curation standing, separately labelled. A provider that fires precisely rises; a spammer's ceiling collapses to briefing across its whole subscriber base and its discovery ranking drops.

The asymmetry is deliberate: **local defence is instant and unconditional; public accountability is slow and opt-in.** A user never has to wait for the network to stop an annoying provider — they mute or revoke now. The network exists so a provider's reputation, not just one user's patience, tracks its behaviour.

---

## 13. Security requirements

- Verify transport authentication, signature, and sender-binding on every `push.event`.
- Admit a push only against an active, matching push grant (`isAuthorized`); default-deny and quarantine unsolicited push.
- Verify the event's `condition_ref` against the authorized condition; reject mismatches.
- Consume rate budget before classification; demote or drop over-budget pushes.
- Verify runtime issuer authorization for the signing key; reject post-revocation signatures.
- Reject expired (`expires_at`), replayed (`event_id`), and out-of-window (`sequence`) pushes.
- Validate `card` with `validateCardSpec`; bound text, item counts, evidence, and encoded size before allocation or rendering; treat all provider text as untrusted data that can neither instruct Dina nor trigger fetches.
- Never let `claimed_priority` or `trigger_evidence` raise delivery above the authorization ceiling; only the subscriber-declared harm topic plus Dina's harm logic reach Fiduciary.
- Never derive a persona DEK to decrypt or render a push whose persona is locked; hold or summarise.
- Endpoint safety on any provider-supplied URL: SSRF block, timeout, size and redirect limits, first-party confirmation before opening (per CardSpec §8/§9).
- Emit no delivery or read receipt to the provider; log decisions with metadata only, never payload content to stdout.
- On device revocation, cascade-revoke that device's push grants (as agent/plugin grants already cascade).

---

## 14. End-to-end flows

### 14.1 Subscribe
1. User asks Dina to watch something ("tell me if BA117 is delayed"), or accepts a provider's `push_notify` capability from service search.
2. Dina derives the topic, a bounded condition, a default Engagement ceiling and a rate budget; for a sensitive persona it runs the outbound-condition confirmation (§10).
3. Dina sends `push.subscribe`; the provider replies `push.ack: accepted` with its runtime issuer and minimum interval.
4. Dina creates a local `watch` task and mints the standing push grant. Nothing is sent to the provider beyond the condition.
5. The user optionally raises the ceiling ("yes, notify me for this") — a deliberate, per-subscription act.

### 14.2 Fire and deliver
1. The provider's condition becomes true; it signs and sends `push.event`.
2. Dina runs the §8 pipeline: authorize → condition-bind → budget → classify (capped at ceiling) → persona → quiet hours → deliver or defer.
3. A Solicited push lands in the Activity inbox; an Engagement push waits for the briefing; a Fiduciary push (harm topic + Dina concurs) interrupts.
4. Dina records a private decision receipt; the user's reaction (opened, kept, dismissed, muted) is the local outcome.

### 14.3 Cry-wolf downgrade
1. A provider fires three Solicited pushes the user dismisses immediately.
2. Local cry-wolf logic lowers the effective ceiling to Engagement; subsequent pushes go to the briefing.
3. With opt-in, Dina offers to publish a noise outcome; scorekeepers reflect it (Phase 2+). The user was never interrupted a fourth time regardless.

### 14.4 Revoke
1. User taps Unsubscribe (or Mute).
2. Dina flips the grant locally; the next `push.event` fails authorization and is dropped. Dina sends a courtesy `push.unsubscribe`.
3. The watch task is cancelled. No provider permission is sought; cached state follows local retention.

---

## 15. Data-model and schema deltas

- **`service_grants`**: add `grantType='push'`; key includes `subscription_id`; add `priority_ceiling`, `rate_budget`, `persona`, `expires_at`, `fulfilment`. Reuse `isAuthorized`/revocation unchanged.
- **`workflow` tasks**: activate `WorkflowTaskKind.Watch` with a `push` payload (`subscription_id`, `condition`, `fulfilment`, `poll_interval?`); reuse `next_run_at`/sweepers for poll-mode and authorization/lease expiry.
- **D2D**: register `push.subscribe|ack|event|unsubscribe` in `families.ts`; add a `push` scenario; mark `push.event` ephemeral, TTL-bounded.
- **Notifications**: add kind `push` to `NotificationKind`; register a push engagement provider with the briefing; render `push` rows in the Activity tab.
- **Local subscription store**: a persona-scoped `push_subscriptions` repository (subscription config, cry-wolf/suspicion counters, local outcomes) — net-new, Core-side, encrypted.
- **Public (Phase 2+)**: `com.dinakernel.push.declaration|outcome|scoreSnapshot` lexicons.

---

## 16. Reuse vs net-new (summary)

**Reused unchanged:** silence classifier and its tiers, DND/quiet hours, briefing, notification inbox and Activity tab, local OS channels, service profile + capability registry, D2D receive pipeline and grants, service windows, CardSpec + `validateCardSpec`, workflow sweepers and the event consumer, PeerLens outcome/coordination machinery.

**Net-new:** the `push_notify` capability + schemas, the `push.*` D2D family and receive branch, the `push` grant type and local subscription store, the activation of the `watch` task kind, the cry-wolf/budget accountability logic, the push-standing dimension and `com.dinakernel.push.*` records, and the subscription-management UI.

**Wired-but-dark to light up:** the server `NotifyHub` + `/v1/ws/notify` push path for server Home Node delivery.

---

## 17. Functional requirements

### Subscriber
- Create a push subscription from a request or from service search, choosing topic, condition, ceiling (default Engagement), budget, persona and expiry.
- Preview and confirm any sensitive-scope outbound condition before it is sent.
- Receive pushes at or below the ceiling, never above; see which provider and condition produced each.
- Mute, snooze, lower-ceiling, shrink-budget, or revoke any subscription in one local action, effective immediately.
- Never have vault context sent to a provider by default; never be interrupted by an Engagement-tier push.
- Optionally, and only per-payload, publish a signal-quality outcome.

### Push provider operator
- Publish through the normal service path with a `push_notify` capability and a condition grammar.
- Accept subscriptions via `push.subscribe`/`push.ack` and fire `push.event` only on the authorized condition, within the subscriber's budget.
- Sign events with an authorized runtime issuer; carry honest `trigger_evidence` when the scope requires it.
- Expect no delivery/read receipt; expect dropped pushes if unauthorized, over-budget, condition-mismatched, or revoked.
- Accept that repeated low-value firing lowers effective ceilings and, opt-in, public standing.

### Reference client (Dina)
- Fail closed on signature, sender-binding, authorization, condition, budget, staleness, replay, schema, size, persona-lock, or ceiling mismatch.
- Classify every push locally, capped at the authorization ceiling; never let a provider reach Fiduciary alone; invert repetition to downgrade, not escalate.
- Emit no delivery or read receipt; hold rather than eagerly decrypt for locked personas.
- Keep the default state silent: absent an active subscription and a satisfied condition, deliver nothing.

---

## 18. Invariants

1. **Push is deferred pull.** No push is delivered without a matching, active, subscriber-authored authorization; unsolicited push is dropped and quarantined.
2. **The provider proposes; Dina disposes.** `claimed_priority` is untrusted input; Dina's classifier sets the tier, capped by the authorization ceiling.
3. **Default silence, default briefing.** A new authorization's ceiling is Engagement; Engagement never interrupts, through repetition, claim, or refinement.
4. **Only the subscriber and Dina reach Fiduciary.** Tier 1 requires a subscriber-declared harm topic and Dina's own harm concurrence; the provider is never one of the two yeses.
5. **Repetition downgrades.** Repeated firing is cry-wolf evidence that lowers the effective ceiling; push-sourced events never use generic silence-escalation.
6. **Budgeted.** Every authorization carries a token budget; over-budget push is demoted or dropped and counts against standing.
7. **Persona-bound.** A push topic lives in a persona; sensitive topics are closed by default and never eagerly decrypted while locked.
8. **No receipts to providers.** Delivery, open, dismiss and mute are never observable to the provider; signal-quality outcomes are separate, explicit, opt-in acts.
9. **Instant local exit.** Mute, lower-ceiling and revoke take effect on the next push without provider permission.
10. **No vault context by default.** A push condition carries only what the user declared; remote vault context awaits the Context Firewall.
11. **Content is untrusted.** A push card can inform a notification but cannot instruct Dina, trigger fetches, or set its own priority.
12. **Silence First survives.** With no satisfied condition, Dina delivers nothing; push only ever completes a request the user already made.

---

## 19. Implementation sequence

### Phase 0: local watches, no inbound push
- Activate the `watch` task kind in poll mode only (Dina-driven `service.query` on a schedule), the exact `DINA_WORKFLOW_CONTROL_PLANE` §6 design.
- Deliver results through the existing silence classifier and notification inbox.
- Measure whether users value standing watches before opening any inbound push surface. No provider-initiated message exists yet.

### Phase 1: authorized inbound push
- Add the `push_notify` capability and frozen subscribe/condition/event schemas.
- Add the `push.*` D2D family and the receive-pipeline authorization branch.
- Add the `push` grant type, the local subscription store, and subscription-management UI (mute/ceiling/budget/revoke).
- Wire the §8 pipeline: authorization → condition-bind → budget → classify (ceiling-capped) → persona → deliver.
- Add cry-wolf downgrade and the over-fire clamp (local only).
- Light up the server `NotifyHub` path for server Home Node delivery.

### Phase 2: public signal quality
- Add opt-in `com.dinakernel.push.outcome`, possession-bound and nullifier-deduplicated (reuse curation discipline).
- Add a signal-quality scorekeeper and the §11 standing vector, coordination-weighted.
- Surface push standing in service discovery, separately labelled.

### Phase 3: reach and hardening
- Remote wake (FCM/APNs/UnifiedPush) for closed-app fiduciary delivery, with honest capability labelling.
- Fiduciary-topic hardening and, where a scope needs it, verifiable `trigger_evidence`.
- Scale: batched delivery, backpressure, and multi-scorekeeper comparison.

No phase begins merely because the prior one is built; each requires demonstrated value from the preceding loop. Inbound push (Phase 1) must not open before the local watch loop (Phase 0) shows users actually want standing signals.

---

## 20. Conformance, adversarial and acceptance tests

Golden vectors and fixtures live in `packages/protocol/conformance`; Core, mobile and AppView consume the same fixtures.

**Authorization and abuse**
- An unsolicited `push.event` with no matching grant is dropped and quarantined.
- A `push.event` whose `condition_ref` does not match the authorized condition is dropped and counts against standing.
- Over-budget pushes are demoted or dropped before classification; a flood cannot reach the classifier at full volume.
- A revoked subscription drops the very next push; a blocked provider is dropped even with a live subscription.
- Stale (`expires_at`), replayed (`event_id`) and out-of-window (`sequence`) pushes are rejected across restart and concurrent ingestion.

**Silence reconciliation**
- A provider claiming Fiduciary on an Engagement-ceiling subscription is delivered to the briefing.
- Three dismissed Solicited pushes lower the effective ceiling to Engagement; a fourth does not interrupt.
- Repeated firing never triggers generic Tier-1 escalation; it only downgrades.
- Quiet hours defer a Solicited push and never a Fiduciary one; a user override always wins.
- Fiduciary is reached only with a subscriber-declared harm topic and Dina's harm concurrence; a provider cannot reach it alone.

**Persona and privacy**
- A locked-persona push is held or summarised, never eagerly decrypted.
- A sensitive-scope subscription is not sent until the outbound-condition confirmation is shown and accepted.
- No delivery or read receipt leaves the node under any delivery outcome.
- Default subscribe payloads contain no vault excerpts, relationship graph, or personalization features.

**Content safety**
- A malformed or oversized card fails `validateCardSpec` before allocation or rendering; card text cannot invoke tools, trigger fetches, or set priority.
- Provider-supplied URLs are SSRF-blocked and opened only through first-party confirmation.

**Standing (Phase 2+)**
- A firehose watcher lacking the receipt/possession proof cannot publish an accepted push outcome.
- One angry subscriber cannot decisively collapse standing; outcomes are coordination-weighted and series-capped.
- Unknown denominators (unsent pushes, unreported deliveries) never appear as a complete precision denominator.

**Phase gates**
- **Phase 0:** the local watch/poll loop delivers through shipping notification paths; no inbound push surface exists.
- **Phase 1:** every authorization, condition, budget, revoke, ceiling and persona test passes before inbound push ships.
- **Phase 2:** possession-bound outcomes and coordination weighting survive documented gaming simulations before public standing shows.
- **Phase 3:** remote-push capability claims match measured closed-app delivery, never exceed it.

---

## 21. Open decisions

- The condition grammar per scope (thresholds, entities, geofences, calendar windows) and its bounded, injection-safe encoding.
- Default rate budgets and refill rules per push scope, and the cry-wolf downgrade threshold.
- Whether `push.subscribe` should be modelled as a `service.query` variant or its own family (this document assumes its own, for schema clarity).
- The dead-drop policy for locked-persona pushes: hold-and-summarise vs hold-opaque vs drop-with-count.
- Poll-fallback intervals and the silence timeout after which a push-mode watch degrades to polling.
- Signal-quality outcome disclosure required for public scoring, and the scorekeeper formula.
- Remote-push provider choice (FCM/APNs/UnifiedPush) and the honest capability taxonomy for closed-app fiduciary delivery.
- Governance of the push scope taxonomy, shared with the curation and services taxonomies.

---

## 22. Honest product claim

The architecture can credibly claim:

> Authorize the alerts you actually want. You declare the condition; the provider fires only when it is met; Dina decides whether the moment justifies breaking silence, and you can mute or revoke any of it instantly.

It must not claim:

- that a provider can be prevented from *trying* to push (Dina drops, quarantines and penalizes it; it cannot stop a sender from sending);
- that push is real-time or wakes a closed app before remote push exists;
- that a provider's declared condition or `trigger_evidence` has been proven true;
- that provider-claimed urgency affects delivery;
- that subscribing hides your declared interest from the provider;
- that public signal-quality outcomes reveal nothing about the user;
- that cry-wolf detection proves a provider acted in bad faith rather than measuring dismissals;
- that push standing is an objective measure of a provider's value.

Push exists to complete requests the user already made, at a volume the user controls, through the same silence Dina protects for everything else. The value is not more signal. The value is *only the signal the user asked for, never louder than they allowed, revocable the instant they change their mind.*
