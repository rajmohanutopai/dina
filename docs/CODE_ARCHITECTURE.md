# Dina TypeScript Code Architecture

Date: 2026-05-04

This document describes the greenfield TypeScript Home Node architecture.
Android, iPhone, and server Home Node Lite are the same product shape: a full
Home Node built from shared TypeScript Core, Brain, protocol, and runtime
modules, with only platform adapters changing per form factor.

Go and Python are behavior references while the TypeScript runtime is being
completed. They are not target runtime surfaces for the mobile or server apps.
This is greenfield: no old-runtime compatibility layer and no migration plan are
required for the TS target.

Related docs:

- `docs/SIMPLIFIED_ARCHITECTURE.md`
- `docs/ARCHITECTURE_CLEANUP_REVIEW.md`
- `docs/ARCHITECTURE_CLEANUP_TASKS.md`
- `docs/ARCHITECTURE_CLEANUP_CODE_ARCHITECTURE.md`

## Target Shape

The target is one logical Home Node runtime:

```text
                         hosted Dina services
              MsgBox          PDS             AppView
                |              |                 |
                v              v                 v
        +------------------------------------------------+
        |              Shared TS Home Node               |
        |                                                |
        |  runtime lifecycle                             |
        |  install / identity                            |
        |  CoreRouter + CoreClient boundary              |
        |  Brain ask / remember / staging drain          |
        |  D2D / service query / trust publish           |
        |  vault, workflow, approval, scratchpad stores  |
        +------------------------------------------------+
             ^                                      ^
             |                                      |
      mobile adapters                         server adapters
      Expo, op-sqlite,                        Node, Fastify,
      secure storage,                         SQLCipher/SQLite,
      notifications                           process lifecycle
```

The mobile app is a full Home Node, not a wrapper. The server app is the same
Home Node behavior with Node/Fastify adapters.

## Governing Rules

1. Shared behavior lives in shared packages.
2. App folders contain UI, boot, and platform adapters only.
3. Brain reaches Core through `CoreClient`, using `InProcessTransport` on
   mobile and `HttpCoreTransport` on server.
4. Private memory and persona state stay local to the Home Node.
5. Public trust and service records are signed and published through PDS, then
   discovered through AppView.
6. Node-to-node traffic goes through MsgBox; Home Nodes do not require public
   inbound ports.
7. Test and release hosted endpoints are selected as one mode, not as split
   per-feature defaults.
8. Access to sensitive personas is explicit. Core must not infer open access.
9. Runtime state should move toward explicit context ownership. Module-level
   registries are temporary bootstrap/test adapters until a shared runtime
   context owns them.
10. Production app code should import public package surfaces, not deep
    package internals.
11. Greenfield cleanup should delete superseded runtime paths instead of
    preserving compatibility shims.

## Package Roles

| Package | Role |
| --- | --- |
| `@dina/protocol` | Wire contracts, canonical payloads, envelope types, protocol helpers. |
| `@dina/core` | Core domain services, CoreRouter, auth, vault, staging, workflow, DID, D2D, service config, CoreClient transports. |
| `@dina/brain` | Chat/ask orchestration, staging drain, enrichment, persona routing, LLM/tool orchestration, service reasoning. |
| `@dina/adapters-expo` | Expo-facing storage, filesystem, network, keystore, and runtime adapter aggregation. |
| `@dina/adapters-node` | Node-facing storage, filesystem, network, keystore, and runtime adapter aggregation. |
| `@dina/test-harness` | Shared fixtures, mocks, and test contracts. |
| `@dina/home-node` | Shared runtime package. It currently owns lifecycle/status contracts, hosted endpoint resolution, feature handler types, a delegating runtime factory, and shared ask/service runtime composition; full node composition extraction is still pending. |

## App Roles

### `apps/mobile`

Mobile owns:

- React Native / Expo UI.
- Unlock/onboarding screens.
- Expo secure storage and native capability adapters.
- Notification and background scheduling adapters.
- Mobile-specific lifecycle hooks.

Mobile should not own:

- Home Node business semantics.
- Alternate remember or ask implementations.
- Separate AppView/PDS/trust logic that bypasses the shared runtime.

The current mobile app still contains much of the runtime composition in
`apps/mobile/src/services/*`. That code should be extracted into the shared
runtime package in small, tested slices.

### `apps/home-node-lite`

Home-node-lite owns:

- Fastify/HTTP serving.
- Node process lifecycle.
- Node storage/key/network adapters.
- Server deployment config.
- Server readiness and health surfaces.

Home-node-lite should not own:

- A second Brain implementation.
- A second remember/ask/trust/service implementation.
- A server-specific behavior fork from mobile.

The server may keep separate Core and Brain processes when useful, but those
processes are adapters around the same TypeScript behavior.

## Runtime Contract

The planned `HomeNodeRuntime` should expose a small operational facade:

```ts
export interface HomeNodeRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<HomeNodeStatus>;

  remember(input: RememberInput): Promise<RememberResult>;
  ask(input: AskInput): Promise<AskResult>;
  publishTrust(input: TrustPublishInput): Promise<TrustPublishResult>;
  queryService(input: ServiceQueryInput): Promise<ServiceQueryResult>;
}
```

The runtime owns:

- `CoreRouter`
- `CoreClient`
- Brain coordinators
- staging drain scheduler
- workflow and approval services
- PDS publisher
- AppView client
- MsgBox client
- D2D sender/receiver
- vault and identity storage repositories
- notification/event adapters

Apps construct platform adapters and pass them into the runtime. Apps should
not assemble internal Core/Brain globals directly once the shared runtime
exists.

## Core Boundary

Core is transport-agnostic:

- `CoreRouter` is the route/auth dispatch kernel.
- `InProcessTransport` calls `CoreRouter.handle` directly for mobile.
- `HttpCoreTransport` signs requests and speaks the same route contract for
  server Brain -> Core.
- Fastify in home-node-lite is an HTTP adapter around `CoreRouter.handle`.

Every Core route that is not explicitly public should pass through the same
authorization pipeline.

Important Core invariants:

- Staging ingest, claim, resolve, fail, and lease operations are authoritative
  in the staging repository when one is wired.
- Staging resolve requires explicit persona access decisions.
- Locked staging targets create durable approval tasks.
- Vault writes validate enum and policy fields before storage.
- Embeddings crossing HTTP use JSON number arrays; Core normalizes them to the
  vault embedding blob representation.

## Brain Boundary

Brain is a shared package, not a mobile-only or server-only implementation.

Brain owns:

- `/remember` chat command orchestration through `CoreClient.stagingIngest`.
- staging drain claim -> classify -> enrich -> resolve.
- L0/L1/embedding enrichment and explicit fallback metadata.
- agentic ask and tool orchestration.
- service query reasoning.
- D2D post-publish hooks and notifications through injected adapters.

Brain must not:

- Import HTTP libraries in portable source.
- Bypass `CoreClient` for production remember/ask paths.
- Store final-looking rows when enrichment providers are absent. Rows should
  carry a status and stage metadata that reflect what actually happened.

## Hosted Endpoint Policy

Endpoint mode is shared across MsgBox, PDS, AppView, and PLC config.

| Mode | MsgBox | PDS | AppView | PLC |
| --- | --- | --- | --- | --- |
| Test/install | `test-mailbox.dinakernel.com` | `test-pds.dinakernel.com` | `test-appview.dinakernel.com` | `plc.directory` |
| Release | `mailbox.dinakernel.com` | `pds.dinakernel.com` | `appview.dinakernel.com` | `plc.directory` |

No production path should choose AppView from one config source and MsgBox/PDS
from another. `@dina/home-node` owns the shared resolver:

- Mobile env keys: `EXPO_PUBLIC_DINA_ENDPOINT_MODE`, `EXPO_PUBLIC_DINA_MSGBOX_URL`, `EXPO_PUBLIC_DINA_PDS_URL`, `EXPO_PUBLIC_DINA_APPVIEW_URL`, `EXPO_PUBLIC_DINA_PLC_URL`.
- Server env keys: `DINA_ENDPOINT_MODE`, `DINA_MSGBOX_URL`, `DINA_PDS_URL`, `DINA_APPVIEW_URL`, `DINA_PLC_URL`.
- Default mode is `test`; release mode is explicit.

## Required End-to-End Flows

### Install

Install should:

1. Create or import identity seed material.
2. Create DID material.
3. Create or restore a PDS account/session.
4. Publish the MsgBox service endpoint into the DID document.
5. Initialize local identity and persona storage.
6. Connect MsgBox.
7. Verify AppView visibility for public profile/service data.

### Remember

`/remember` always enters Core staging first:

```text
UI/CLI -> Brain chat orchestrator -> CoreClient.stagingIngest
      -> Core staging inbox -> Brain staging drain
      -> classify -> enrich -> explicit persona access map
      -> Core staging resolve -> vault or approval-backed pending row
```

The remember path must support:

- single persona store
- multi-persona fanout
- locked persona approval
- approval deny without later store
- restart-safe staging repository state
- L0/L1/embedding enrichment before store when providers are available
- explicit fallback metadata when providers are absent or fail

### Ask

`/ask` should use the same coordinator on mobile and server:

```text
UI/CLI -> AskCoordinator -> persona guard -> vault/tools/AppView/services
      -> LLM provider when configured -> response or approval/pending status
```

Ask should degrade explicitly when model, AppView, or service prerequisites are
missing.

### Trust Publish

Trust publish should use:

```text
UI -> trust draft/review -> durable outbox -> signed PDS createRecord
   -> AppView indexing/reconciliation -> local status update
```

Test-only AppView injection must stay explicit and separate from the normal
test/release publish path.

### D2D And Services

D2D and service query traffic should use signed/sealed envelopes and MsgBox
delivery. The relay contract must be documented and tested as either HTTP
forward or WebSocket frames before release.

## Import Policy

Target public imports:

```ts
import { createHomeNodeRuntime } from '@dina/home-node';
import { InProcessTransport, HttpCoreTransport } from '@dina/core';
import { StagingDrainScheduler } from '@dina/brain';
```

Production app code should avoid:

```ts
import { ... } from '@dina/core/src/...';
import { ... } from '@dina/brain/src/...';
```

Until public exports are complete, deep imports may remain in bootstrap and
tests, but the cleanup target is to add exports maps and guard app production
code from new internal imports.

## Runtime State Policy

Current TypeScript modules still use process-wide registries for repositories,
workflow services, LLM providers, and staging state. This was useful for the
port, but it is not the final ownership model.

Target ownership:

```text
HomeNodeContext
  identity repositories
  persona repositories
  staging repository
  workflow service
  approval service
  core router/client
  brain coordinators
  external service clients
  schedulers
```

Tests should be able to run two Home Node contexts in the same process without
cross-contamination.

## Validation Gates

Every shared behavior needs a parity test that can run against both mobile and
server transports.

Required gates:

- CoreRouter auth and route binding.
- CoreClient HTTP and in-process transport parity.
- `/remember` staging, enrichment, persona gates, approvals, and restart
  behavior.
- `/ask` fast path, pending approval, approve, deny, and degraded mode.
- PDS/AppView trust publish without test injection.
- MsgBox D2D send/receive, replay rejection, unknown sender handling, and retry.
- Install endpoint defaults for test and release modes.

Passing a unit test for one form factor is not enough when the behavior is part
of the shared Home Node contract.

## Current Gap Summary

The active cleanup docs track the detailed task list. The highest-level gaps
are:

- Extract mobile-owned platform-neutral composition into `@dina/home-node`.
- Wire home-node-lite Brain and Core boot around the same runtime behavior.
- Finish runtime use of shared endpoint clients: server MsgBox, threading the
  configured server AppView into Brain routes, and PDS publisher/session boot.
- Build real PDS publisher/session boot and durable trust outbox.
- Reduce app deep imports by adding public package exports.
- Move or remove the parallel Brain implementation under home-node-lite
  core-server.

The direction is fixed: one TypeScript Home Node, two adapter surfaces.
