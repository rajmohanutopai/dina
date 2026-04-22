# PDS client namespace — `@dina/core/src/pds/`

Canonical location for everything related to talking to an AT
Protocol Personal Data Server. Task 6.1 of
`docs/HOME_NODE_LITE_TASKS.md` scaffolded this directory.

**Status: scaffold.** The PDS client functions live at their
*pre-consolidation* locations (see table below). This directory
exists so new code has an obvious place to land and so the
`@dina/core/pds/*` import paths are reserved. A follow-on task
will migrate the existing code here without changing external
consumers.

## What this namespace covers

| Feature                | Task    | Where the code lives **today**                       |
|------------------------|---------|------------------------------------------------------|
| Account provisioning   | 6.2     | `packages/core/src/identity/*`                       |
| Session lifecycle      | 6.2–6.3 | `packages/core/src/identity/*`                       |
| Record CRUD            | 6.4     | (will consolidate here; currently scattered)         |
| Lexicon validation     | 6.5     | `packages/core/src/trust/pds_publish.ts`             |
| Attestation publishing | pre-6   | `packages/core/src/trust/pds_publish.ts` (re-exported here) |

The re-exports in [`index.ts`](./index.ts) give external consumers
the `@dina/core/pds` import path today even though the implementation
is elsewhere. When the consolidation migration lands, external
imports don't move.

## What this namespace does **not** cover

- **PDS hosting / operator tooling** — that's upstream at the AT
  Protocol PDS itself; Dina is always a *client* of a PDS (community
  PDS at `bsky.social`-compatible endpoints, or operator-run PDS for
  sovereignty). See `ARCHITECTURE.md` Layer 3.
- **PLC resolver** — DIDs are resolved through
  `packages/core/src/identity/directory.ts`. Separate namespace from
  PDS record CRUD; don't entangle.
- **AppView queries** — the Trust Network's reader side
  (`com.dina.trust.resolve`, `com.dina.service.search`, …) lives in
  `packages/core/src/trust/`. PDS is the writer side; AppView is the
  cross-indexed reader side.

## Types

[`types.ts`](./types.ts) declares the interface contracts a future
PDS-client class will satisfy. They are consumed by tests today and
will be consumed by the migrated client when it lands.

## Tests

PDS functionality has existing tests at their current locations —
the scaffold doesn't duplicate those. A smoke test
(`__tests__/pds_scaffold.test.ts` in `@dina/core`) verifies the
re-export surface compiles + the namespace is reachable.

## Roadmap

The per-feature task list in `docs/HOME_NODE_LITE_TASKS.md` Phase 6a:

- [x] 6.1  Scaffold this directory ← **this task**
- [x] 6.2  `createAccount`, `createSession`, `refreshSession`, `deleteSession`
- [x] 6.3  Session tokens persisted in keystore
- [x] 6.4  `createRecord`, `putRecord`, `getRecord`, `deleteRecord`, `listRecords`
- [x] 6.5  Lexicon validation per Dina collection

The 6.2–6.5 entries were marked done against the code at its pre-
consolidation locations. Migrating them into this directory is a
follow-on task (consistency cleanup, not new functionality).
