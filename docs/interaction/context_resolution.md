# Dina Context Resolution

## Purpose

This document defines the grounding layer Dina needs before it can correctly execute:

- external queries
- inline agent calls
- delegated tasks
- Dina-to-Dina requests
- hybrid workflows

The interaction model is incomplete without context resolution.

Natural language requests often contain unresolved references such as:

- `this`
- `that`
- `here`
- `there`
- `now`
- `tomorrow`
- `them`
- `my usual route`
- `the bus`
- `the meeting`

These cannot be sent directly to an external API, agent, or remote Dina.

They must first be resolved into structured context.

## Why This Layer Exists

Consider:

- "What time will this bus reach here?"

To answer correctly, Dina must resolve:

1. which bus
2. what `here` means
3. what time reference applies
4. which counterparty should answer
5. how confident the system is in its interpretation

Without this layer, Dina may:

- call the wrong agent
- ask the wrong counterparty
- send an ambiguous D2D request
- expose too much information
- answer with false confidence

## Position In The Architecture

The interaction stack is:

1. [full_interaction_areas.md](/Users/rajmohan/OpenSource/dina/docs/interaction/full_interaction_areas.md)  
   Full conceptual problem space

2. [domains.md](/Users/rajmohan/OpenSource/dina/docs/interaction/domains.md)  
   User intent domains and interaction modes

3. [d2d_domains.md](/Users/rajmohan/OpenSource/dina/docs/interaction/d2d_domains.md)  
   Dina-to-Dina capability systems

4. [interaction_topologies.md](/Users/rajmohan/OpenSource/dina/docs/interaction/interaction_topologies.md)  
   Counterparty and fulfillment model

5. `context_resolution.md`  
   How ambiguous natural-language inputs are grounded into structured request context

## Core Resolution Categories

Dina should resolve at least the following context categories.

### 1. Entity Context

Resolve what person, object, service, event, or task the user is referring to.

Examples:

- `this bus`
- `that order`
- `the booking`
- `Sancho`
- `my next meeting`

Typical outputs:

- contact ID
- task ID
- booking ID
- route ID
- trip ID
- event ID

### 2. Spatial Context

Resolve location-dependent references.

Examples:

- `here`
- `there`
- `home`
- `office`
- `usual cafe`
- `that station`

Typical outputs:

- GPS coordinates
- named place
- stop ID
- venue ID
- saved location ID
- confidence score

### 3. Temporal Context

Resolve time-dependent references.

Examples:

- `now`
- `today`
- `tomorrow`
- `before the meeting`
- `after lunch`
- `this evening`

Typical outputs:

- ISO timestamp
- date range
- time window
- timezone
- scheduling anchor event

### 4. Conversational Context

Resolve references from recent conversation state.

Examples:

- `this one`
- `that plan`
- `same as before`
- `the second option`

Typical outputs:

- prior message reference
- selected option reference
- previous comparison item
- current interaction state

### 5. Relationship Context

Resolve social references.

Examples:

- `them`
- `his mom`
- `my accountant`
- `the landlord`

Typical outputs:

- contact ID
- relationship type
- preferred communication route
- trust and sharing policy

### 6. Policy Context

Resolve what may be shared or requested in this situation.

Examples:

- whether this counterparty may know the user's location
- whether this service can receive health information
- whether another Dina may receive a schedule update

Typical outputs:

- allowed fields
- required approval
- redaction requirements
- persona restrictions

## Structured Context Package

Before execution, Dina should build a structured context package.

Example:

```json
{
  "subject": {
    "kind": "transit_vehicle",
    "route_id": "42",
    "trip_id": "42-2026-04-04-0815",
    "vehicle_id": "bus-1203",
    "direction": "downtown"
  },
  "location": {
    "kind": "stop",
    "label": "Central Station Stop B",
    "stop_id": "CEN_B",
    "lat": 12.9716,
    "lon": 77.5946,
    "confidence": 0.92
  },
  "time": {
    "request_time": "2026-04-04T08:10:00+05:30",
    "timezone": "Asia/Kolkata"
  },
  "conversation": {
    "deictic_reference": "here",
    "resolved_from": "current_location"
  },
  "policy": {
    "share_location": false,
    "approval_required": false,
    "redact_precise_coordinates": true
  }
}
```

This package is what should be passed to:

- external APIs
- external agents
- remote Dinas
- task executors

The raw phrase should not be forwarded when structured resolution is possible.

## Resolution Pipeline

The correct execution pipeline is:

1. Parse the user request
2. Detect ambiguous references
3. Resolve known references from memory, recent interaction state, location, calendar, and contacts
4. Build a structured context package
5. Estimate confidence for each resolved field
6. Ask for clarification if confidence is too low
7. Apply policy and redaction rules
8. Route to the chosen execution topology
9. Render the result back to the user

## Clarification Policy

Dina should not guess silently when ambiguity is material.

Clarification is required when:

- multiple candidate entities exist
- location resolution is low confidence
- the wrong interpretation could cause a wrong external action
- sensitive information may be shared
- the counterparty needs more exact context than Dina currently has

Examples:

- "Do you mean the bus 42 toward downtown, or the 42 toward the airport?"
- "By 'here', do you mean your current location or your office?"
- "Do you want me to message Sancho's Dina or just tell you the ETA?"

## Confidence Model

Each resolved slot should carry a confidence score or equivalent status.

Recommended states:

- `exact`
- `high`
- `medium`
- `low`
- `unknown`

Behavior:

- `exact` / `high`: proceed automatically
- `medium`: proceed only if low-risk, otherwise clarify
- `low` / `unknown`: clarify

## Examples

### Example 1: Transit

User:

- "What time will this bus reach here?"

Dina resolves:

- bus from recent conversation or visible route
- `here` from current location or nearest stop
- current time and timezone
- correct counterparty: transit API, transit agent, or transit Dina

Then Dina sends a structured request.

### Example 2: Delivery

User:

- "Will it arrive before I leave?"

Dina resolves:

- package ID
- planned departure time from calendar or reminder
- delivery ETA

### Example 3: Social Coordination

User:

- "Tell Sancho I'm almost there."

Dina resolves:

- Sancho contact and D2D route
- current or predicted ETA
- what "almost there" should mean in concrete terms
- whether location details can be shared

### Example 4: Healthcare

User:

- "Is the doctor running late?"

Dina resolves:

- appointment ID
- clinic/provider
- scheduled time
- today's timezone and location

## Policy and Redaction

Context resolution must happen before sharing.

That allows Dina to decide:

- whether exact location may be sent
- whether a summary should replace raw details
- whether an approval is needed
- whether only a relative statement should be sent

Example:

Instead of sharing:

- exact live location coordinates

Dina may send:

- "User is approximately 15 minutes away"

## Relation To D2D

For D2D specifically, this layer is critical.

A remote Dina should receive:

- resolved structured identifiers
- minimal required context
- redacted or tiered detail

It should not be asked vague questions like:

- "What time will you reach here?"

Instead, Dina should send something equivalent to:

- target stop or venue ID
- trip or vehicle ID if available
- intended time reference
- permitted data scope

## Relation To `/query` and `/task`

This layer applies to both.

### `/query`

Used for:

- quick inline lookups
- direct status checks
- short agent calls

But still requires grounding first.

### `/task`

Used for:

- delegated durable work
- longer-running execution

Also requires grounding before the task is submitted.

The task prompt or payload should include resolved context, not unresolved user phrasing alone.

## Recommended Internal Model

Each request should eventually be represented as:

```text
domain + mode + sensitivity + timing + counterparty_type + execution_path + resolved_context
```

That is the complete interaction model.

## Key Design Rule

Routing and topology are not enough.

Dina must also know what the user actually meant by:

- the entity
- the place
- the time
- the relationship
- the safe sharing boundary

That is the job of context resolution.
