# Dina Interaction Architecture

## Purpose

This document defines the user-facing interaction contract for Dina.

It answers:

- what commands the user should use
- what each command means
- how those commands relate to domains, D2D, provider systems, agents, and delegated tasks
- how Dina should interpret a request when the command and the required execution are not identical
- what belongs in the external product surface versus internal routing and policy

This is not an implementation document. It is the product and systems architecture for interaction semantics.

## Relationship to Other Documents

This document integrates the rest of the interaction architecture:

- [full_interaction_areas.md](/Users/rajmohan/OpenSource/dina/docs/interaction/full_interaction_areas.md)
  - full problem-space inventory
- [domains.md](/Users/rajmohan/OpenSource/dina/docs/interaction/domains.md)
  - consolidated user domains and conceptual modes
- [d2d_domains.md](/Users/rajmohan/OpenSource/dina/docs/interaction/d2d_domains.md)
  - Dina-to-Dina systems and capabilities
- [interaction_topologies.md](/Users/rajmohan/OpenSource/dina/docs/interaction/interaction_topologies.md)
  - counterparties, execution paths, and federated execution
- [context_resolution.md](/Users/rajmohan/OpenSource/dina/docs/interaction/context_resolution.md)
  - grounding ambiguous requests into structured context
- [formatting.md](/Users/rajmohan/OpenSource/dina/docs/interaction/formatting.md)
  - response formatting contract across channels

Those documents define the space. This document defines the external interaction model over that space.

## Core Thesis

The top-level user command is not a literal backend function.

It is a preferred interaction contract.

That means:

- it tells Dina what the user expects back
- it does not rigidly dictate the internal execution steps
- Dina may perform multiple internal sub-actions to satisfy one command
- Dina may decompose one external command into multiple internal interaction types
- the user should experience a stable contract even when the implementation varies

Example:

- `/ask What time will the bus reach here?`

The external contract is:

- answer me now if reasonably possible

The internal execution may include:

- context resolution
- transit/provider routing
- D2D request to a transit Dina
- remote federated execution on the other side
- response formatting

The command is therefore the outer promise, not the execution recipe.

An external command may therefore be composite internally.

Examples:

- `/ask` may internally become `ask + request + context_resolution + short planning`
- `/plan` may internally become `ask + request + compare + synthesize`
- `/task` may internally become `plan + ask + request + watch`
- `/watch` may internally become `request + subscribe + status tracking`

## Design Principles

### 1. Commands model user intent, not internal plumbing

Users should not need to know whether Dina uses:

- local memory
- a deterministic API
- OpenClaw
- another specialist agent
- another Dina
- a provider integration

### 2. Distinct interaction types must remain distinct

These are not the same thing:

- asking for an answer
- asking for a plan
- sending a message to a person
- making a request to a provider or institution
- starting durable async work
- setting up monitoring

They should not be flattened into one generic outbound verb.

### 3. D2D is not just another transport

Dina-to-Dina is a first-class interaction type with:

- strong peer identity
- trust
- structured semantics
- approvals and policy
- optional remote execution before reply

This is qualitatively different from email or chat.

### 4. External commands and internal classifications are different layers

External commands should stay small and clear.

Internally, Dina may still classify a request into:

- question
- plan
- communication
- provider request
- disclosure
- delegated work
- monitoring
- governance
- admin operation

One external command may map to several of these internal classifications in sequence or in parallel.

### 5. Strong commands should not be silently transformed

Some commands are soft and compositional:

- `/ask`
- `/plan`
- `/send`
- `/request`

Some commands are strong and should preserve their contract:

- `/remember`
- `/task`
- `/watch`
- `/approve`
- `/status`
- `/recover`
- resource commands like `/contact` and `/session`

### 6. Dina owns authority

Dina owns:

- identity
- trust
- vaults
- approvals
- policy
- D2D
- audit
- context resolution
- routing

Agents and tools help produce outcomes. They do not define the user contract.

## Architectural Layers

Every interaction should be understood through these layers:

1. interaction area
2. domain
3. persona and sensitivity scope
4. context resolution
5. counterparty / topology
6. external command
7. internal execution graph
8. governance and policy
9. delivery and notification contract
10. response contract
11. formatting and rendering

### Interaction Area

The concrete life area from [full_interaction_areas.md](/Users/rajmohan/OpenSource/dina/docs/interaction/full_interaction_areas.md).

Examples:

- health
- travel
- work
- finance
- family

### Domain

The consolidated domain from [domains.md](/Users/rajmohan/OpenSource/dina/docs/interaction/domains.md).

Examples:

- Memory and Knowledge
- Communication
- Travel and Mobility
- Safety, Permissions, and Governance

### Persona and Sensitivity Scope

Every interaction should also be routed through persona scope and sensitivity.

This answers:

- which persona or vault context is involved
- whether the interaction is ordinary, guarded, or highly restricted
- whether approval, grant, or explicit unlock is required
- whether the request crosses persona boundaries

At minimum, Dina should evaluate:

- target persona or personas
- persona tier such as `default`, `standard`, `sensitive`, `locked`
- interaction sensitivity or disclosure level
- whether the request may proceed inline or must pause for governance or clarification

Persona scope is not only a storage concern. It affects command routing itself.

Examples:

- `/remember` into health is not routed like `/remember` into general
- `/request` touching finance is not governed like `/request` for a restaurant booking
- `/plan` over mixed work and personal context may require explicit cross-persona permission

### Context Resolution

The grounding layer from [context_resolution.md](/Users/rajmohan/OpenSource/dina/docs/interaction/context_resolution.md).

This resolves:

- who or what is being referred to
- where "here" is
- what "tomorrow" means
- who "them" refers to
- what may be shared

### Counterparty / Topology

The fulfillment layer from [interaction_topologies.md](/Users/rajmohan/OpenSource/dina/docs/interaction/interaction_topologies.md).

Examples:

- local knowledge
- deterministic API
- specialist agent
- general agent
- human's Dina
- provider Dina
- organization Dina
- public infrastructure Dina
- device Dina
- hybrid workflow

### External Command

The user-facing contract.

### Internal Execution Graph

The actual work Dina chooses to perform under the hood.

### Governance and Policy

Approvals, redaction, permissions, risk, audit.

### Delivery and Notification Contract

This is the Dina -> human layer.

Not every important interaction starts with a human command. Some start when Dina must speak.

This layer covers:

- proactive briefing
- alerts
- completion notices
- failure notices
- clarification requests
- escalation when silence would cause harm

### Response Contract

What the user should expect back:

- immediate answer
- proposal
- accepted and running
- later notification
- delivery acknowledgment
- current status
- recovery result

### Formatting

How the result is rendered through [formatting.md](/Users/rajmohan/OpenSource/dina/docs/interaction/formatting.md).

## Internal Conceptual Modes

The conceptual modes from [domains.md](/Users/rajmohan/OpenSource/dina/docs/interaction/domains.md) remain useful internally:

- `remember`
- `ask`
- `plan`
- `act`
- `monitor`

They help with:

- intent classification
- policy
- routing
- tool selection

But they are not enough as the final user-facing product surface.

## Proactive Delivery Model

The command surface covers human -> Dina interaction.

Dina also needs a first-class Dina -> human delivery model.

This is required by Silence First and by the three outbound priority levels.

Proactive delivery is not necessarily a command.

An implementation may expose it as:

- pushed notifications
- a scheduled digest
- a notification center
- `/status briefing`
- `/ask briefing`
- `/brief`

The architecture does not require one exact command spelling.

It does require a delivery contract.

### Delivery Classes

At minimum, Dina should support:

- `briefing`
- `alert`
- `update`
- `completion`
- `failure`
- `clarification`
- `escalation`

### Priority Model

Silence First requires at least these outbound priority classes:

- `fiduciary`
- `solicited`
- `engagement`

Meaning:

- `fiduciary`: Dina should speak even if the user did not ask, because silence would cause harm, missed obligation, or safety risk
- `solicited`: Dina should speak because the user asked it to watch, track, remind, or do something
- `engagement`: Dina may speak as a convenience, digest, or low-risk suggestion

### Briefing

Briefing is not just another `/ask`.

It is an aggregated, priority-ranked delivery contract.

A briefing may be:

- user-pulled
- scheduled
- context-triggered, such as morning, commute start, or end of day

Briefing content may include:

- fiduciary items first
- solicited updates second
- optional low-priority suggestions last

### Failure and Harm Notifications

Failure notification is part of the architecture, not an afterthought.

Examples:

- task failed
- watch lost its subscription
- request timed out
- send could not be delivered
- approval expired

If silence would cause harm, the failure should be delivered proactively.

If silence would not cause harm, it may wait for briefing or explicit status inspection.

## Recommended External Command Surface

### Core User Commands

- `/remember`
- `/ask`
- `/plan`
- `/send`
- `/request`
- `/task`
- `/watch`

### Control Commands

- `/approve`
- `/status`
- `/edit`
- `/cancel`
- `/recover`

### Resource and Admin Commands

- `/contact`
- `/config`
- `/device`
- `/session`
- `/audit`

### Trust Commands

- `/trust`
- `/review`
- `/vouch`
- `/flag`

### Operator-Only

- `/debug`

## Operator Surface

`/debug` should be treated as an umbrella, not a lonely one-off command.

Typical operator sub-actions may include:

- trace
- explain decision
- inspect queue
- list all active tasks
- inspect stuck watches
- reconcile
- show policy evaluation

This keeps the public product surface small while still acknowledging that operators need a richer control plane.

## Command Contracts

## `/remember`

### Meaning

Store durable context.

### User expectation

- "keep this"
- "make this part of my world model"
- "I may ask about this later"

### Typical results

- stored
- pending approval
- denied
- failed

### Allowed internal sub-actions

- staging ingest
- classification
- vault routing
- sensitivity detection
- approval trigger

### Not allowed by default

- outbound communication
- provider requests
- delegated task execution

### Strength

Strong command.

## `/ask`

### Meaning

Get me an answer now.

### User expectation

- inline-preferred answer
- factual, explanatory, lookup, or short reasoning result
- user is waiting

### Typical results

- immediate answer
- maybe accepted short follow-up if truly needed

### Allowed internal sub-actions

- context resolution
- local retrieval
- deterministic API lookup
- specialist agent query
- general agent query
- D2D request
- federated execution on the remote side
- lightweight planning

### Not allowed by default

- durable async work without clear user consent
- unrelated side effects

### Strength

Soft command.

### Important rule

`/ask` defines the result contract, not the backend.

Example:

- `/ask What time will the bus reach here?`

This may still route internally as a provider request to a transit Dina. It remains `/ask` because the user wants an answer now.

## `/plan`

### Meaning

Give me a proposed course of action.

### User expectation

- recommendation
- shortlist
- itinerary
- strategy
- next steps
- no side effects by default

### Typical results

- summary
- list
- comparison
- table

### Allowed internal sub-actions

- ask
- retrieve
- compare
- request information
- synthesize options

### Not allowed by default

- sending messages
- provider actions
- sharing sensitive data
- creating durable tasks without confirmation

### Strength

Soft command with a strong no-side-effects expectation.

### Important role

`/plan` is the missing category between `/ask` and `/task`.

## Plan Acceptance and Execution

A common Dina pattern is:

- ask for a plan
- review options
- choose one
- execute it

This handoff should be explicit.

### Rule

Accepting a plan option starts a new outer contract.

It does not silently mutate the original `/plan` into execution.

The selected option may become:

- `/send`
- `/request`
- `/task`
- `/watch`

depending on what the option actually requires.

### Expected Plan Shape

Plans should ideally return structured options with:

- option ID
- description
- likely action type
- likely side effects
- likely approval needs

Then a user can say:

- "do option 2"
- "send option 1"
- "turn option 3 into a task"

and Dina can convert that into a new execution contract with the plan retained as provenance.

### Why this matters

Without this rule, plan-to-action becomes ambiguous and brittle.

## `/send`

### Meaning

Communicate outward to a person or group.

### User expectation

- person-oriented communication
- social or professional message
- delivery to another person's Dina if possible

### Typical results

- sent
- queued
- delivered
- failed

### Allowed internal sub-actions

- contact resolution
- drafting
- D2D communication
- chat fallback
- email fallback if allowed and appropriate
- policy checks

### Not allowed by default

- service/infrastructure requests disguised as person communication
- broad disclosure beyond the message intent

### Strength

Soft-to-medium command.

### Important distinction

`/send` is for person-oriented outbound communication.

It is not:

- `/request`
- `/task`
- a literal transport primitive

Email may still be used internally as a channel when appropriate. That does not make `/mail` necessary as a top-level product verb.

The command spelling is intentionally `/send`, not `/talk`, because it reads more naturally as a user command:

- `/send Sancho I'll be 20 minutes late`

This does not change the semantic contract. `/send` still means interpersonal or group communication, not transport-level byte delivery.

## `/request`

### Meaning

Ask a provider, organization, institution, infrastructure system, or device-side Dina to answer or do something.

### User expectation

- service-oriented interaction
- not personal conversation
- may involve remote execution on the other side

### Typical results

- completed
- accepted
- running
- failed

### Allowed internal sub-actions

- context resolution
- provider adapter calls
- D2D request
- federated execution
- service negotiation
- request tracking

### Not allowed by default

- social messaging
- over-sharing unrelated data

### Strength

Soft-to-medium command.

### This is where federated execution belongs

The remote Dina may:

- do a direct lookup
- use its own tools
- run its own agent
- start its own internal task

The caller still experiences `/request`.

## `/task`

### Meaning

Do this as durable async work.

### User expectation

- user does not wait
- task is tracked
- result comes later
- status inspection is meaningful

### Typical results

- accepted
- queued
- running
- completed
- failed

### Allowed internal sub-actions

Anything required by the task:

- ask
- plan
- request
- compare
- retrieve
- watch
- D2D
- agent execution

### Not allowed by default

- pretending the work is still inline

### Strength

Very strong command.

## `/watch`

### Meaning

Monitor something and notify me later.

### User expectation

- future observation
- reminder
- alert
- threshold or event monitoring

### Typical results

- watch created
- watch status
- later notification
- watch failed/cancelled

### Allowed internal sub-actions

- reminder creation
- polling
- provider subscription
- remote monitoring request
- threshold evaluation

### Not allowed by default

- one-shot lookup pretending to be monitoring

### Strength

Very strong command.

### Important distinction

- `/task` = do work and finish
- `/watch` = keep observing and notify on change or schedule

## `/approve`

### Meaning

Approve or deny pending actions.

### User expectation

- governance decision
- clear risk context
- explicit choice

### Strength

Very strong command.

## `/status`

### Meaning

Inspect the current state of something.

### User expectation

- no new side effects
- lifecycle or diagnostic information

### Typical uses

- system status
- task status
- request status
- watch status
- approval status

### Strength

Strong control command.

## `/edit`

### Meaning

Modify an existing object while preserving its identity.

### User expectation

- change an existing reminder, watch, draft, or pending item
- keep the same underlying object
- do not create a new flow unless needed internally

### Typical uses

- edit reminder
- edit watch threshold or schedule
- edit draft text
- edit a queued item before execution starts

### Strength

Strong control command.

### Important distinction

`/edit` is not `/cancel` and not `/recover`.

- `/edit` = modify existing state
- `/cancel` = stop existing state
- `/recover` = repair broken or stuck state

### Resource-local edits are often clearer

For many administrative objects, resource-specific edit forms are better than a global edit verb.

Examples:

- `/contact edit ...`
- `/config set ...`
- `/device rename ...`
- `/session revoke ...`

Generic `/edit` is most useful for active user-facing objects like reminders, watches, drafts, and other mutable pending items.

## `/cancel`

### Meaning

Deliberately stop, withdraw, or end an active or pending flow.

### User expectation

- explicit cancellation by user choice
- not repair
- not diagnosis

### Typical uses

- cancel task
- stop watch
- withdraw pending request
- cancel scheduled outbound action

### Strength

Strong control command.

### Important distinction

`/cancel` is not `/recover`.

- `/cancel` = user intentionally wants the flow to stop
- `/recover` = something is broken or stuck and needs repair

## `/recover`

### Meaning

Repair, retry, or reconcile a broken or stuck flow.

### User expectation

- operational repair
- explicit recovery action

### Typical uses

- recover task
- reconcile missing callback
- retry stuck request
- repair stale session

### Strength

Strong control command.

## Reversal and Undo Model

There is no single universal undo.

Different actions have different reversibility.

The architecture should say this explicitly.

### Reversibility Classes

At minimum, actions should fall into one of these classes:

- `editable`
- `cancelable`
- `retractable`
- `compensatable`
- `irreversible`

Meaning:

- `editable`: can be changed while preserving identity
- `cancelable`: can be stopped before completion or before effect takes place
- `retractable`: can be withdrawn or tombstoned after completion
- `compensatable`: cannot be undone directly, but a follow-up action can offset it
- `irreversible`: cannot be undone in protocol terms

### Command Relationship

- `/edit` handles editable state
- `/cancel` handles cancelable future work
- `/recover` handles broken flows
- "undo" should map to retract or compensate when supported

Examples:

- a queued task is cancelable
- a published trust review may be retractable through revocation or tombstone
- a sent D2D message may be irreversible at transport level but compensatable by sending a correction
- a provider action may be compensatable or irreversible depending on provider contract

## Resource and Admin Commands

These should remain concrete nouns externally.

Where possible, resource-local mutation is preferred over a generic `/edit`.

Examples:

- `/contact edit Sancho preferred_channel whatsapp`
- `/config set timezone Asia/Kolkata`
- `/device rename laptop work-mac`
- `/session revoke abc123`

### `/contact`

Purpose:

- manage contacts and D2D identities

Typical sub-actions:

- add
- edit
- list
- remove
- cleanup

### `/config`

Purpose:

- manage settings and preferences

Typical sub-actions:

- timezone
- language
- defaults
- policy preferences

### `/device`

Purpose:

- manage paired devices and identities

Typical sub-actions:

- pair
- unpair
- list
- revoke

### `/session`

Purpose:

- inspect and control session state

Typical sub-actions:

- list
- revoke
- end

### `/audit`

Purpose:

- inspect logs and historical actions

Typical sub-actions:

- recent
- filter
- trace

These are clearer externally than collapsing them into one generic `/manage`.

## Trust Commands

The trust network is a first-class product capability, so these stay separate:

### `/trust`

Read trust information.

### `/review`

Publish or manage a review.

### `/vouch`

Publish a trust endorsement.

### `/flag`

Flag a bad actor, scam, or unsafe item.

## Soft vs Strong Commands

### Soft Commands

These allow more internal composition:

- `/ask`
- `/plan`
- `/send`
- `/request`

They define the expected result, not the exact execution graph.

### Strong Commands

These should preserve their contract:

- `/remember`
- `/task`
- `/watch`
- `/approve`
- `/status`
- `/edit`
- `/cancel`
- `/recover`
- `/contact`
- `/config`
- `/device`
- `/session`
- `/audit`

## Command Interpretation Model

## Explicit Command

If the user chooses a command explicitly, that sets the outer contract.

## Inferred Command

If the user writes plain natural language, Dina infers the outer contract.

Examples:

- "Tell Sancho I'll be late" -> inferred `/send`
- "What time will the bus reach here?" -> inferred `/ask`
- "Track this bus and notify me when it is near" -> inferred `/watch`
- "What is the best commute strategy this week?" -> inferred `/plan`

## Multi-Turn Conversation Frame

Real interactions are often multi-turn.

Examples:

- clarification
- disambiguation
- correction
- refinement
- plan option selection

The architecture should model this explicitly.

### Active Interaction Frame

Dina should maintain an active interaction frame for the current thread or conversation.

That frame carries:

- current outer contract
- resolved entities and context
- pending clarification questions
- plan options or candidate actions
- approval or execution state if applicable

### Rule

Follow-up turns stay within the existing outer contract unless the user clearly pivots.

Examples:

- "which Sancho?" stays inside the original `/send`
- "no, the earlier bus" stays inside the original `/ask` or `/watch`
- "do option 2" follows from the prior `/plan` but starts a new execution contract

### Pivot Rule

A new outer contract begins when the user:

- explicitly changes intent
- accepts a plan for execution
- asks for a new unrelated outcome
- changes from observation to action or vice versa

## Derived Execution Graph

After setting the outer contract, Dina chooses the internal graph.

This may include:

- context resolution
- local retrieval
- external API lookup
- specialist agent call
- general agent call
- D2D request
- federated execution
- delegated task creation
- monitoring setup

The execution graph is explicitly allowed to be multi-stage and mixed-mode.

Examples:

- `/ask` may decompose into:
  - context resolution
  - local ask
  - remote request
  - remote task on the other Dina
  - final answer synthesis

- `/plan` may decompose into:
  - multiple asks
  - one or more provider requests
  - comparison
  - option ranking

- `/task` may decompose into:
  - planning
  - several asks
  - provider requests
  - monitoring subtasks
  - final report generation

The user does not need to see the whole graph unless:

- approval is required
- the graph changes the expected response contract
- Dina needs confirmation before escalating from inline work to durable async work

## Bulk and Batch Operations

The architecture should not assume every command targets only one object.

Bulk and batch targeting are real usage patterns.

Examples:

- cancel all watches
- show all pending tasks
- send greetings to a selected group
- approve all low-risk queued items from the same source

### Target Cardinality

Commands may target:

- a single object
- an explicit set of objects
- a filtered collection
- a saved cohort or contact group

### Rules

- bulk operations preserve the same outer contract as the single-object form
- risky bulk operations should require preview and approval
- per-target results should be visible when outcomes diverge
- some commands may explicitly forbid bulk mode

## Composite Interaction Decomposition

This is a first-class rule in Dina's architecture:

- one external command may expand into multiple internal interaction types
- the outer command still defines the user contract

Examples:

### `/ask`

Possible internal decomposition:

- `ask`
- `request`
- `plan`
- `task`

Example:

- `/ask What time will the bus reach here?`

Possible actual flow:

- resolve context
- request transit Dina
- transit Dina starts an internal task to compute ETA
- Dina waits briefly
- if answer returns in time, reply inline
- if not, Dina offers short follow-up or conversion to `/task`

### `/plan`

Possible internal decomposition:

- `ask`
- `request`
- `compare`
- `task` if the scope is too large

Example:

- `/plan What is the best commute strategy for this week?`

Possible actual flow:

- ask transit conditions
- ask calendar constraints
- request live disruption information
- compare options
- produce a recommendation

### `/task`

Possible internal decomposition:

- `plan`
- `ask`
- `request`
- `watch`

Example:

- `/task Research the best commute options for the next month and report back`

Possible actual flow:

- plan the research approach
- ask several sources
- request provider-side information
- watch for route or fare changes if needed
- return a final report later

### `/watch`

Possible internal decomposition:

- `request`
- `ask`
- `status`

Example:

- `/watch Track this bus and tell me when it is 5 minutes away`

Possible actual flow:

- request provider subscription if available
- otherwise poll live data
- keep status state
- notify when threshold is met

This decomposition is not a corner case. It is the normal model for a capable sovereign system.

## Upgrade and Downgrade Rules

## `/ask`

May internally require:

- request
- context resolution
- lightweight planning

If it cannot complete inline:

- return partial answer if possible
- or offer conversion to `/task`
- or return a short follow-up contract

It should not silently create durable async work unless that behavior is an explicit product rule.

## `/plan`

May internally require:

- ask
- request
- compare

If it cannot complete inline:

- return partial plan
- or offer conversion to `/task`

It must not create side effects by default.

## `/send`

May use:

- D2D
- chat bridge
- email channel

But it should remain person-oriented in contract.

## `/request`

May use:

- provider Dina
- organization Dina
- public infrastructure Dina
- device Dina
- API
- federated execution

If async, the user should see request lifecycle state, not hidden blocking.

## `/task`

Should remain durable async even if the work turns out small.

## `/watch`

Should create monitoring state, not collapse to a one-shot query.

## D2D in This Architecture

D2D is not a top-level command.

It is a fulfillment topology and interaction fabric.

That means:

- `/send` may use D2D
- `/request` may use D2D
- `/watch` may use D2D
- `/ask` may use D2D under the hood

D2D remains first-class architecturally without forcing users to think in transport terms.

## Federated Execution

Federated execution is the case where Dina asks another Dina for an outcome, and that remote Dina may perform its own internal work before replying.

This belongs primarily under `/request`.

Example:

- `/request Ask the transit operator when the bus will reach my location`

The transit Dina may:

- query internal systems
- check traffic
- run an agent
- start an internal task

The caller experiences `/request`, not the remote implementation details.

## Context Resolution

Many commands require grounding before execution.

This is especially important for:

- `/ask`
- `/plan`
- `/request`
- `/watch`

Examples:

- "this bus"
- "here"
- "them"
- "my usual route"
- "that booking"

Context should be resolved before routing, using [context_resolution.md](/Users/rajmohan/OpenSource/dina/docs/interaction/context_resolution.md).

## Governance and Approval

Approval is applied after command interpretation, not before.

Whether approval is needed depends on:

- persona scope
- persona tier
- sensitivity
- counterparty
- requested action
- disclosure level
- policy

Examples:

- `/plan` usually does not need approval
- `/remember` into a sensitive persona may need approval or explicit unlock
- `/request` may need approval if sensitive or irreversible
- `/send` may need approval if high-risk or unusual
- `/task` may need approval depending on action and domain

## Response Contracts

Commands imply different default response contracts:

These are command-initiated contracts.

They do not replace the proactive delivery model for outbound briefings, alerts, failures, and escalations.

### `/remember`

- stored
- pending approval
- failed

### `/ask`

- immediate answer
- or accepted short follow-up

### `/plan`

- proposed plan

### `/send`

- sent
- queued
- failed

### `/request`

- completed
- accepted
- running
- failed

### `/task`

- accepted then async

### `/watch`

- watch created
- later notifications
- watch failure notification if the watch breaks and silence would cause harm

### `/edit`

- updated
- update pending
- cannot edit

### `/cancel`

- cancelled
- cancellation pending
- cannot cancel

### `/status`

- current state report

### `/recover`

- recovery result

## Proactive Delivery Contracts

These are Dina-initiated rather than human-initiated.

### `briefing`

- aggregated summary
- priority-ranked
- may be scheduled or user-pulled

### `alert`

- immediate proactive notice
- fiduciary or harm-preventing

### `completion`

- solicited notification that a task, request, or watch reached a useful terminal point

### `failure`

- proactive notice that a task, request, watch, or delivery failed
- may escalate depending on harm if ignored

### `clarification`

- Dina needs more input before safely continuing

### `escalation`

- a higher-priority follow-up because silence or delay now matters materially

These should map cleanly into [formatting.md](/Users/rajmohan/OpenSource/dina/docs/interaction/formatting.md).

## Example Scenarios

## 1. Bus ETA

User:

- `/ask What time will the bus reach here?`

Interpretation:

- outer contract: answer now
- internal graph:
  - resolve bus
  - resolve here
  - likely route as provider/infrastructure request
  - maybe D2D to transit Dina
  - maybe federated execution on remote side

## 2. Weekly commute strategy

User:

- `/plan What is the best commute strategy for this week?`

Interpretation:

- outer contract: recommendation
- internal graph:
  - ask transit patterns
  - ask calendar
  - compare options
  - synthesize plan

## 3. Month-long commute research

User:

- `/task Research the best commute options for the next month and report back`

Interpretation:

- outer contract: durable async work
- internal graph:
  - plan
  - ask
  - compare
  - maybe watch changes

## 4. Tell Sancho you are late

User:

- `/send Sancho I'm 20 minutes late`

Interpretation:

- outer contract: person-oriented communication
- internal graph:
  - resolve contact
  - draft or normalize message
  - D2D preferred
  - fallback delivery if allowed

## 5. Ask clinic about delay

User:

- `/request Ask the clinic whether the doctor is running late`

Interpretation:

- outer contract: service request
- internal graph:
  - resolve appointment
  - provider Dina or provider system
  - maybe remote execution before answer

## 6. Track the bus

User:

- `/watch Track this bus and tell me when it is 5 minutes away`

Interpretation:

- outer contract: monitoring
- internal graph:
  - resolve bus
  - create watch
  - maybe provider subscription or polling

## 7. Morning briefing

System:

- proactive `briefing`

Interpretation:

- outbound aggregated delivery
- priority-ranked
- fiduciary items first, then solicited updates, then optional engagement items

## 8. Failed task with harm if ignored

System:

- proactive `failure`

Interpretation:

- task failed
- the user had solicited the work
- silence would likely cause missed expectation or obligation
- Dina should notify rather than waiting for `/status`

## Current vs Desired Mapping

This section maps the currently implemented surface to the desired one.

### Keep

- `/remember` -> `/remember`
- `/ask` -> `/ask`
- `/task` -> `/task`
- `/status` -> `/status`
- `/trust` -> `/trust`
- `/review` -> `/review`
- `/vouch` -> `/vouch`
- `/flag` -> `/flag`

### Split or Fold

- `/send` -> keep as the person-oriented outbound command
- provider/service requests currently mixed into ask/send -> move under `/request`
- `/taskstatus` -> fold into `/status`
- reminder-edit semantics -> support with `/edit` plus `/watch` and `/status`

### Keep Concrete Resource Commands

- `/contact`
- `/config`
- `/device`
- `/session`
- `/audit`

### Replace Internal Plumbing Concepts

- `validate*` -> `/approve` plus policy-driven internal behavior

## Final Command Set

### Core

- `/remember`
- `/ask`
- `/plan`
- `/send`
- `/request`
- `/task`
- `/watch`

### Control

- `/approve`
- `/status`
- `/edit`
- `/cancel`
- `/recover`

### Resources

- `/contact`
- `/config`
- `/device`
- `/session`
- `/audit`

### Trust

- `/trust`
- `/review`
- `/vouch`
- `/flag`

### Operator

- `/debug`

## One-Line Rule

The external command defines the outer contract; Dina is free to build whatever internal execution graph is necessary to satisfy that contract, as long as it preserves the expected interaction type, governance, and result shape.
