# Dina-to-Dina Domains

## Purpose

This document defines the major functional systems involved in Dina-to-Dina interaction.

Dina-to-Dina is not just messaging. It is a broad coordination capability that includes:

- identity resolution
- trust
- secure transport
- structured requests and responses
- policy enforcement
- approvals
- shared context exchange
- delegation and coordination
- audit and recovery

This document captures the large functional surface and consolidates it into a smaller number of operational pillars.

## 50 Dina-to-Dina Systems

1. Identity Resolution  
   Map a human or contact to the correct remote Dina DID.

2. Contact Directory  
   Store known Dinas, aliases, labels, and relationship metadata.

3. Trust Registry  
   Track trust level for each remote Dina.

4. Pairing / Handshake  
   Establish initial trust between two Dinas.

5. Key Exchange  
   Exchange and rotate cryptographic material.

6. Capability Discovery  
   Learn what the remote Dina can do.

7. Protocol Version Negotiation  
   Ensure both sides speak compatible protocols.

8. Secure Transport  
   Provide encrypted and authenticated delivery.

9. Message Signing  
   Prove sender identity for each D2D message.

10. Replay Protection  
    Prevent old messages from being replayed.

11. Delivery Acknowledgement  
    Track whether a message was received.

12. Acceptance / Rejection Semantics  
    Let the remote side accept or deny a request.

13. Retry Queue  
    Retry transiently failed D2D messages.

14. Dead Letter Queue  
    Store permanently failed D2D messages for review.

15. Idempotency Control  
    Prevent duplicate side effects during retries.

16. Conversation Threading  
    Keep multi-message conversations linked.

17. Request / Response Correlation  
    Match responses to original requests.

18. Structured Message Types  
    Define canonical payload types.

19. Human Message Relay  
    Send human-originated messages via Dina.

20. Agent-to-Agent Coordination  
    Allow one Dina to ask another Dina to do work.

21. Approval-Carrying Messages  
    Attach approval semantics to outbound requests.

22. Cross-Dina Approval Requests  
    Ask the remote side for permission before acting.

23. Cross-Dina Denials  
    Allow explicit remote denial with a reason.

24. Policy Enforcement  
    Enforce what may or may not be shared or requested.

25. Tiered Disclosure  
    Share summaries without exposing sensitive raw details.

26. Persona-Aware Sharing  
    Decide which local persona or vault data can be shared.

27. Selective Attribute Sharing  
    Share only specific fields rather than full records.

28. Consent Ledger  
    Track what was shared, to whom, and why.

29. Audit Trail  
    Keep durable records of D2D actions and decisions.

30. Provenance Tracking  
    Track whether a fact came from a remote Dina or the human.

31. Context Packaging  
    Bundle only the context necessary for the remote side.

32. Context Redaction  
    Remove or mask private details before sending.

33. Shared Task Handoff  
    Delegate a task from one Dina to another.

34. Shared Reminder Relay  
    Ask another Dina to remind its user.

35. Scheduling Negotiation  
    Coordinate calendars or availability across Dinas.

36. Presence / Availability Signals  
    Check whether the remote side is reachable or active.

37. Status Updates  
    Receive progress on delegated requests.

38. Terminal Completion Notifications  
    Receive done, failed, or cancelled signals.

39. Escalation Path  
    Move from autonomous coordination to human approval.

40. Conflict Resolution  
    Resolve contradictory instructions or duplicated requests.

41. Relationship Semantics  
    Encode friend, colleague, family, client, vendor, and related meaning.

42. Shared Event Coordination  
    Coordinate meetings, visits, deliveries, or other events.

43. Shared Resource Coordination  
    Coordinate access to shared documents, locations, or bookings.

44. Reputation / Reliability Signals  
    Track whether a remote Dina is dependable.

45. Abuse / Spam Controls  
    Rate limiting, blocking, and quarantine for malicious or noisy peers.

46. Revocation System  
    Revoke trust, permissions, or prior access grants.

47. Discovery / Bootstrap UX  
    Support finding and adding another Dina.

48. Admin / Debug Tooling  
    Inspect queues, traces, message state, and failures.

49. Recovery / Reconciliation  
    Repair stuck flows or missing callbacks.

50. Interoperability Layer  
    Support future runtimes, vendors, or protocol variants.

## Consolidated D2D Pillars

The 50 systems above collapse into 8 primary Dina-to-Dina pillars.

### 1. Identity and Trust

Purpose:

- determine who the remote Dina is
- establish whether it is trusted

Includes:

- identity resolution
- contact directory
- trust registry
- pairing
- key exchange
- relationship semantics
- reputation and reliability
- revocation
- discovery and bootstrap

### 2. Secure Transport

Purpose:

- move messages safely and reliably

Includes:

- secure transport
- message signing
- replay protection
- acknowledgements
- retry queue
- dead letter queue
- idempotency control

### 3. Messaging Semantics

Purpose:

- define how Dinas talk to each other

Includes:

- structured message types
- request/response correlation
- conversation threading
- human message relay
- agent-to-agent coordination
- acceptance and rejection semantics

### 4. Permissions and Policy

Purpose:

- control what may be requested, shared, or acted upon

Includes:

- approval-carrying messages
- cross-Dina approval requests
- denials
- policy enforcement
- escalation path
- abuse and spam controls

### 5. Shared Context and Data Exchange

Purpose:

- exchange useful information safely and minimally

Includes:

- tiered disclosure
- persona-aware sharing
- selective attribute sharing
- consent ledger
- provenance tracking
- context packaging
- context redaction

### 6. Coordination and Tasking

Purpose:

- coordinate actions across two Dina systems

Includes:

- shared task handoff
- reminder relay
- scheduling negotiation
- presence and availability
- status updates
- terminal completion notifications
- shared event coordination
- shared resource coordination
- conflict resolution

### 7. Audit and Recovery

Purpose:

- explain what happened and recover when things go wrong

Includes:

- audit trail
- admin and debug tooling
- recovery and reconciliation

### 8. Interoperability and Evolution

Purpose:

- keep D2D viable across future protocol, runtime, or vendor changes

Includes:

- capability discovery
- protocol version negotiation
- interoperability layer

## Examples of D2D Use Cases

### Human-to-Human via Dina

- "Tell Sancho I will be late."
- "Let Priya know the meeting is moved to 4 PM."

### Dina-to-Dina Coordination

- "Ask the other Dina when their user is available."
- "Coordinate a repair slot between two households."

### Data Sharing

- "Share only the meeting location."
- "Send dietary preferences, not full health records."

### Delegation

- "Ask their Dina to remind them tomorrow."
- "Hand off a scheduling task to the other Dina."

### Governance

- "Record exactly what was shared and why."
- "Require remote approval before sending a sensitive detail."

## Why D2D Is Its Own Capability Surface

Dina-to-Dina cuts across many user-facing domains, but it is not just another domain.

It is better treated as a major cross-cutting capability because it combines:

- communication
- security
- policy
- coordination
- transport
- audit

For product and architecture purposes, D2D should be treated as a first-class subsystem.
