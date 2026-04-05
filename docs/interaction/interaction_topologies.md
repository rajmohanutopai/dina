# Dina Interaction Topologies

## Purpose

This document defines the missing layer between:

- [domains.md](/Users/rajmohan/OpenSource/dina/docs/interaction/domains.md), which models what the user wants
- [d2d_domains.md](/Users/rajmohan/OpenSource/dina/docs/interaction/d2d_domains.md), which models Dina-to-Dina capability systems

The missing layer is:

- who Dina is interacting with
- how the request is fulfilled
- whether the flow is inline, delegated, D2D, or hybrid
- whether the remote side may run its own internal work before answering

Without this layer, scenarios like:

- "Is this bus on time?"
- "Can the restaurant move my booking to 8:30?"
- "Where is my package right now?"
- "Check if the clinic is delayed, then inform Sancho"

are only partially modeled.

These scenarios are not new user domains. They are different fulfillment topologies for existing domains.

They also include an important case that is easy to miss:

- Dina asks another Dina for an outcome
- the receiving Dina may satisfy that request by calling its own tools, agents, or delegated tasks
- the caller sees a D2D lifecycle, not the remote side's internal implementation

This document refers to that pattern as `federated_execution`.

## Core Model

Every Dina interaction should be described by:

1. `domain`
2. `mode`
3. `sensitivity`
4. `timing`
5. `counterparty_type`
6. `execution_path`
7. `response_contract`

### Domain

From [domains.md](/Users/rajmohan/OpenSource/dina/docs/interaction/domains.md):

- Memory and Knowledge
- Tasks and Execution
- Scheduling and Time
- Communication
- Decisions, Search, and Recommendations
- Finance and Assets
- Health and Wellbeing
- Home, Family, and Daily Life
- Travel and Mobility
- Relationships and External Coordination
- Safety, Permissions, and Governance
- Admin, Recovery, and System Operations

### Mode

- `remember`
- `ask`
- `plan`
- `act`
- `monitor`

### Sensitivity

- `normal`
- `sensitive`
- `restricted`

### Timing

- `inline`
- `delegated`

Meaning:

- `inline`: user waits for a response now
- `delegated`: durable work continues and completes later

### Counterparty Type

The target or system Dina is interacting with.

### Execution Path

The concrete way the request is fulfilled.

### Response Contract

The observable lifecycle expected by the caller.

Examples:

- `immediate_answer`
- `accepted_then_async`
- `subscription_updates`
- `best_effort_notification`

## Counterparty Types

These are the major counterparties Dina may interact with.

### 1. Local Knowledge

Meaning:

- Dina answers from its own memory, vaults, and local context

Examples:

- "What did I say about ergonomic chairs?"
- "When is my next meeting?"

### 2. Deterministic External API

Meaning:

- Dina calls a direct provider API or structured service

Examples:

- transit feed
- weather API
- package tracking API
- stock or price feed

Examples:

- "Is this bus on time?"
- "Where is my package?"

### 3. Specialist External Agent

Meaning:

- Dina routes to a domain-specific agent or bot

Examples:

- transit-specialist agent
- commerce assistant
- logistics bot
- travel planner

Examples:

- "Find the cheapest train option for tomorrow."
- "Compare delivery choices."

### 4. General External Agent

Meaning:

- Dina routes to a flexible general-purpose agent runtime

Examples:

- OpenClaw general agent
- another broad research/execution agent

Examples:

- "Research the best webcams and summarize."
- "Draft and refine a response based on current web context."

### 5. Human's Dina

Meaning:

- Dina interacts with another personal Dina on behalf of a human contact

Examples:

- friend
- family member
- colleague
- another parent

Examples:

- "Tell Sancho I will be 15 minutes late."
- "Ask Priya's Dina whether Friday works."

### 6. Organization Dina

Meaning:

- Dina interacts with an organization's Dina rather than a human's Dina

Examples:

- employer Dina
- school Dina
- clinic Dina
- building management Dina

Examples:

- "Has HR approved my access request?"
- "Has the school published tomorrow's schedule?"

### 7. Service / Provider Dina

Meaning:

- Dina interacts with a service-side Dina representing a vendor, merchant, or provider

Examples:

- restaurant Dina
- courier Dina
- hotel Dina
- utility provider Dina

Examples:

- "Can the restaurant shift my booking to 8:30?"
- "Has the utility company acknowledged the outage ticket?"

### 8. Public Infrastructure Dina

Meaning:

- Dina interacts with public or civic infrastructure systems, possibly via Dina interfaces

Examples:

- bus system Dina
- train operator Dina
- city traffic Dina
- government office Dina

Examples:

- "Is the bus delayed?"
- "Has the platform changed?"

### 9. Device Dina

Meaning:

- Dina interacts with a device, appliance, vehicle, or sensor-side agent

Examples:

- EV charger Dina
- washing machine Dina
- smart lock Dina
- home energy controller Dina

Examples:

- "Is the washing machine cycle done?"
- "Did the door lock engage?"

### 10. Hybrid Workflow

Meaning:

- multiple counterparties and execution paths are composed

Examples:

- external status lookup + message another Dina
- provider lookup + general agent reasoning
- task delegation + D2D coordination

Examples:

- "If the bus is delayed by more than 10 minutes, tell Sancho."
- "Check if the clinic is delayed, then move the meeting."

## Remote Dina as Executor

Another Dina is not just a mailbox. It may be a full execution environment.

That means a D2D request can trigger work on the remote side such as:

- direct database or API lookup
- inline specialist-agent query
- delegated task execution
- long-running monitoring

From the caller's perspective, the important contract is not whether the remote Dina used OpenClaw, another agent, or a direct adapter. The important contract is:

- request accepted or rejected
- whether the response is inline or async
- whether progress or completion updates will arrive
- what result or error shape comes back

The caller should not depend on the remote side's internal execution details.

## Federated Execution

`federated_execution` is the pattern where:

1. Dina A sends a D2D request to Dina B
2. Dina B decides how to satisfy it internally
3. Dina B may run local retrieval, inline agent work, delegated task execution, or monitoring
4. Dina B returns the result to Dina A through a D2D response lifecycle

This is the missing bridge between:

- local `/query`
- local `/task`
- D2D request / response

The remote side may internally use any of those, but the caller only sees the D2D contract.

### Why It Matters

Without `federated_execution`, D2D looks like a thin messaging layer.

In reality, many useful flows are:

- request another Dina for an answer
- let that Dina use its own systems and agents
- receive only the final answer, status, or failure

Examples:

- your Dina asks a transit operator Dina for ETA at your location
- the transit Dina checks its own fleet systems and traffic sources
- your Dina receives "expected arrival: 45 minutes"

- your Dina asks a restaurant Dina to shift a booking
- the restaurant Dina checks table availability and policy
- your Dina receives "booking moved to 8:15 PM"

- your Dina asks a clinic Dina whether the doctor is running late
- the clinic Dina queries scheduling systems
- your Dina receives "doctor delayed by 20 minutes"

### Federated Execution Patterns

There are four common patterns:

#### 1. Direct Response

The remote Dina already knows the answer or can answer from local state immediately.

Examples:

- business hours
- known booking status
- static policy answer

#### 2. Remote Query

The remote Dina performs a short-lived internal lookup or inline agent call, then responds inline.

Examples:

- transit ETA
- package current status
- current appointment delay

#### 3. Remote Delegated Execution

The remote Dina accepts the request, starts internal delegated work, and responds later.

Examples:

- collect quotes from multiple internal/vendor systems
- investigate a service issue
- perform multi-step availability negotiation

#### 4. Remote Monitoring

The remote Dina keeps watching a condition and sends updates or a later terminal response.

Examples:

- alert when a bus is 5 minutes away
- notify when a parcel reaches the local hub
- inform when a waitlisted slot opens

## Execution Paths

These are the major ways Dina fulfills a request.

### 1. Local Retrieval

Use when:

- the answer already exists in Dina's own memory or local state

Typical shape:

- direct answer
- no external call

### 2. External Query

Use when:

- there is a direct external source
- the response should be immediate
- the result is narrow and structured

Examples:

- bus timing
- weather
- package status

Typical user surface:

- `/query`
- inline agent call
- deterministic adapter

### 3. Inline Agent Call

Use when:

- an agent is needed now
- the user is waiting
- the work is short-lived

Examples:

- "Compare these two plans quickly."
- "Check the latest transit status and explain it."

Typical user surface:

- `/query`
- inline task execution

### 4. Delegated Task

Use when:

- work may take longer
- the user does not wait
- the task should be durable and tracked

Examples:

- long research
- multi-step web work
- asynchronous coordination

Typical user surface:

- `/task`

### 5. D2D Request

Use when:

- the right counterparty is another Dina
- a peer or service-side Dina should answer or act

Examples:

- ask another Dina for availability
- notify another Dina of delay

Typical user surface:

- D2D message / request / response workflow

### 6. Federated Execution

Use when:

- the right counterparty is another Dina
- the remote Dina may need to execute its own internal work before answering
- the local caller should see a clean request lifecycle rather than the remote implementation

Examples:

- ask a transit operator Dina for ETA and let it use fleet systems or internal agents
- ask a provider Dina for a booking change and let it check capacity internally
- ask a clinic Dina for doctor delay and let it query scheduling tools

Typical user surface:

- D2D request with inline or async response contract

### 7. Hybrid Orchestration

Use when:

- multiple steps, systems, or counterparties are involved

Examples:

- external status lookup followed by a D2D notification
- delegated research followed by an approval-gated outbound message
- D2D request whose result triggers local notification or another external action

## When `/query`, `/task`, and D2D Apply

### `/query`

Best for:

- inline requests
- quick lookups
- short agent calls
- immediate deterministic API access

Examples:

- "Is this bus on time?"
- "What is the weather in Bangalore?"
- "Summarize this message thread."

### `/task`

Best for:

- durable delegated work
- long-running agent execution
- asynchronous research or synthesis

Examples:

- "Research the best ergonomic chair options."
- "Compare top 5 filing services and report back."

### D2D

Best for:

- peer or provider coordination
- cross-user or cross-system communication
- structured requests to another Dina

Examples:

- "Tell Sancho I am late."
- "Ask the courier Dina whether delivery can move to tomorrow."

### Federated Execution

Best for:

- asking another Dina for an outcome rather than only sending it a message
- cases where the remote Dina may invoke its own tools, agents, or tasks
- service-side or infrastructure-side requests where internal execution is hidden behind a D2D contract

Examples:

- "Ask the transit operator Dina when the bus will reach my location."
- "Ask the clinic Dina whether the doctor is running late."
- "Ask the restaurant Dina whether the booking can move to 8:30."

### Hybrid

Best for:

- real-world workflows that combine information and action

Examples:

- "Check whether the bus is delayed, then inform the host."
- "See if the clinic is late, then reschedule the ride."
- "Ask the transit Dina for ETA, then tell Sancho if I will be late."

## Scenarios Previously Under-Modeled

These are classes of scenarios that do not fit neatly into only `domains.md` or only `d2d_domains.md`.

### Transit and Traffic

- "Is this bus on time?"
- "Has my train platform changed?"
- "Will traffic make me late?"
- "Is the parking garage full?"

Possible fulfillment:

- deterministic API
- specialist agent
- public infrastructure Dina
- federated execution through a transit operator Dina
- hybrid

### Logistics and Delivery

- "Where is my package?"
- "Will the courier arrive today?"
- "Can delivery be rescheduled?"
- "Has the parcel reached the local hub?"

Possible fulfillment:

- deterministic API
- service-provider Dina
- specialist logistics agent
- federated execution through a courier or warehouse Dina

### Commerce and Vendor Interaction

- "Is this item in stock?"
- "Can the store hold it for me?"
- "Has my refund been processed?"
- "Can the booking be shifted?"

Possible fulfillment:

- deterministic API
- provider Dina
- specialist commerce agent
- federated execution through a merchant Dina

### Venue and Hospitality

- "Is the event still on?"
- "Has the hotel confirmed early check-in?"
- "Is the restaurant still open?"
- "Has the venue changed entry details?"

Possible fulfillment:

- provider Dina
- organization Dina
- external lookup
- federated execution through a venue or restaurant Dina

### Utilities and Service Operations

- "Is there a power outage?"
- "When will water service return?"
- "Has the technician accepted the service request?"
- "Can the visit be moved earlier?"

Possible fulfillment:

- utility API
- service-provider Dina
- federated execution through a service-provider Dina
- hybrid

### Government and Civic

- "Has my application moved to the next stage?"
- "Is the office open today?"
- "Has the appointment been confirmed?"
- "What documents are still pending?"

Possible fulfillment:

- deterministic API
- public infrastructure Dina
- organization Dina
- federated execution through a civic or office Dina

### Healthcare

- "Is the doctor running late?"
- "Has the lab report been released?"
- "Can the clinic confirm the appointment?"
- "Has the prescription been renewed?"

Possible fulfillment:

- provider Dina
- organization Dina
- deterministic API
- federated execution through a clinic or hospital Dina

### Education

- "Did the school publish tomorrow's schedule?"
- "Has the assignment deadline changed?"
- "Did the teacher confirm the meeting?"
- "Has the fee payment been recorded?"

Possible fulfillment:

- organization Dina
- provider Dina
- federated execution through a school or institution Dina

### Workplace and Enterprise

- "Has IT approved my access request?"
- "Did procurement accept the PO?"
- "Has legal reviewed the contract?"
- "Is the build pipeline green?"

Possible fulfillment:

- organization Dina
- internal enterprise agents
- deterministic system adapters

### Devices and IoT

- "Is the washing machine done?"
- "Did the smart lock engage?"
- "Is the EV fully charged?"
- "Has the fridge alert cleared?"

Possible fulfillment:

- device Dina
- local device integration

## D2D Request Lifecycles

When `federated_execution` is involved, the remote Dina should expose a clear lifecycle to the caller.

### Minimal Lifecycle

- `accepted`
- `running`
- `completed`
- `failed`

### Optional Lifecycle Additions

- `rejected`
- `needs_approval`
- `partial`
- `cancelled`

### Required Correlation Fields

- `request_id`
- `correlation_id`
- `requested_capability`
- `response_mode`: `inline | async`
- `status`
- `result`
- `error`
- `provenance`
- optional `eta`

The caller should rely on these fields, not on any knowledge of the remote Dina's internal task system.

## Caller-Side Human Delivery

Federated execution does not end when the remote Dina reports `completed` or `failed`.

There is a second leg:

- remote Dina -> caller Dina
- caller Dina -> human

That second leg should be explicit in the topology.

### Caller-Side Delivery Choices

After a remote Dina reports state, the caller Dina may:

- return inline immediately
- create a completion notification
- create a failure notification
- include the result in a briefing
- escalate proactively if silence would cause harm

### Why this matters

Two systems can both implement D2D lifecycles correctly and still feel very different to the user if one silently drops async failures while the other surfaces them properly.

So the topology should include:

- machine-to-machine lifecycle
- human-facing delivery decision

### Typical Mapping

- `completed` + user waiting inline -> inline answer
- `completed` + delegated task -> completion notice or status update
- `failed` + low urgency -> status + briefing inclusion
- `failed` + high urgency or fiduciary impact -> proactive failure alert

## Failure and Escalation Topology

Asynchronous failure is not just a status field.

It is a topology transition.

Example:

1. user asks Dina to watch a bus
2. Dina asks a transit Dina or provider to monitor it
3. remote provider subscription breaks
4. remote side reports failure, or caller detects polling failure
5. caller Dina decides whether to:
   - retry silently
   - notify as `failure`
   - escalate because silence now causes harm

This applies equally to:

- delegated tasks
- watches
- provider requests
- outbound sends waiting on delivery

## Recommended Routing Logic

For each user request, Dina should determine:

1. domain
2. mode
3. sensitivity
4. timing
5. counterparty type
6. execution path

Then route accordingly.

Example:

- "Is this bus on time?"
  - domain: `Travel and Mobility`
  - mode: `ask`
  - sensitivity: `normal`
  - timing: `inline`
  - counterparty_type: `public_infrastructure_dina` or `deterministic_external_api`
  - execution_path: `federated_execution` or `external_query`
  - response_contract: `immediate_answer`

- "Tell Sancho I will be late because the bus is delayed."
  - domain: `Travel and Mobility` + `Communication`
  - mode: `act`
  - sensitivity: `sensitive`
  - timing: `inline`
  - counterparty_type: `hybrid`
  - execution_path: `hybrid_orchestration`
  - response_contract: `best_effort_notification`

- "Research the best commute plan for the next month."
  - domain: `Travel and Mobility`
  - mode: `plan`
  - sensitivity: `normal`
  - timing: `delegated`
  - counterparty_type: `general_external_agent`
  - execution_path: `delegated_task`
  - response_contract: `accepted_then_async`

- "Ask the transit operator Dina when the bus will reach my location."
  - domain: `Travel and Mobility`
  - mode: `ask`
  - sensitivity: `normal`
  - timing: `inline`
  - counterparty_type: `public_infrastructure_dina`
  - execution_path: `federated_execution`
  - response_contract: `immediate_answer` or `accepted_then_async`

## Key Design Rule

Do not treat every external interaction as the same kind of task.

The same user intent may route through:

- local memory
- direct API lookup
- specialist bot
- general-purpose agent
- D2D with a human's Dina
- D2D with a provider Dina
- D2D with remote federated execution
- hybrid orchestration

That distinction should be explicit in the architecture.

## Relationship to Other Documents

- [domains.md](/Users/rajmohan/OpenSource/dina/docs/interaction/domains.md) answers: what the user wants
- [d2d_domains.md](/Users/rajmohan/OpenSource/dina/docs/interaction/d2d_domains.md) answers: how D2D works as a subsystem
- this document answers: who Dina talks to and how fulfillment happens
