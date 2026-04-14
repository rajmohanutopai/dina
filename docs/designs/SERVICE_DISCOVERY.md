# Public Service Discovery — Design Document

## Overview

Dina supports public service discovery. Service providers publish capabilities via AT Protocol records (`com.dina.service.profile`). Other Dinas discover them via AppView search and send D2D `service.query` messages. The provider's agent (OpenClaw via MCP) auto-responds with structured results.

## Example: Bus ETA

1. User asks "when does bus 42 arrive?"
2. Brain searches AppView: `com.dina.service.search?capability=eta_query&lat=12.93&lng=77.68`
3. Gets: `[{operatorDid: "did:plc:bus42", name: "Route 42 Hosur AC", trustScore: 92}]`
4. Sends D2D `service.query` to `did:plc:bus42`
5. Bus Driver's Brain validates, calls OpenClaw via MCP
6. OpenClaw returns: `{eta_minutes: 45, vehicle_type: "AC Bus"}`
7. Bus Driver's Dina sends `service.response` back
8. User sees: "Route 42 AC Bus — 45 minutes away"

## Key Design Decisions

- **Query window** bypasses contact gate for service traffic (60s TTL, one-shot)
- **Single local authority**: service_config table in identity.sqlite
- **Capability allowlist**: Brain validates params/results with Pydantic models
- **DID binding**: author DID = operator DID (no delegation in Phase 1)
- **Auto-only**: Phase 1 supports only `responsePolicy: "auto"`
- **Async notification**: user gets notified when response arrives
- **IngressDrop always wins**: trust blocklist checked before any service bypass

## Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `service.query` | Requester → Provider | Query a capability with params |
| `service.response` | Provider → Requester | Structured result or error |

## Phase 2 (Not Built)

- Review path (human approves per query)
- PostGIS geospatial search
- Rich responses (maps, polylines)
- Preference-aware search
- Delegation proof
- Synchronous query option
