# Changelog

All notable changes to Dina — both the Go/Python production stack
and the TypeScript Home Node Lite stack — are recorded here. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Scope.** This changelog covers the repo at root. Per-package
> changes (e.g. to `@dina/protocol`, `@dina/core`) land here as
> aggregated entries — the per-package detail is in commit
> messages and the per-task annotations in
> [`docs/HOME_NODE_LITE_TASKS.md`](./docs/HOME_NODE_LITE_TASKS.md).

Sections used:

- **Added** — new features or capabilities
- **Changed** — changes to existing behaviour
- **Deprecated** — features slated for removal
- **Removed** — features that are now gone
- **Fixed** — bugs fixed
- **Security** — anything security-sensitive

Milestones on the Home Node Lite buildout map to release tags; the
milestone definitions live in
[`docs/HOME_NODE_LITE_TASKS.md`](./docs/HOME_NODE_LITE_TASKS.md)
under *Milestone map*.

---

## [Unreleased]

Changes pending the next milestone. Move entries below the matching
milestone heading when it ships.

### Added

- _(entries accumulate here until M1 ships)_

### Changed

### Fixed

### Security

---

## Home Node Lite milestone slots

Each Lite milestone lands as a tag on the repo
(`home-node-lite-v0.1.0` at M1 … `home-node-lite-v1.0.0` at M5).
When a milestone ships, promote its block out of *Unreleased* into
its slot below with the release date.

### [home-node-lite-v1.0.0] — M5 (Full integration-test parity with Go/Python)

_Unreleased — pending milestone gate at `docs/HOME_NODE_LITE_TASKS.md`
Phase 8e. Expected scope: compliance, silence tiers, staging drain,
whisper channel, full contract wire format, agency-story tests,
anti-Her, async approval, delegation, digital estate, draft-don't-send,
phase 2, safety layer, PII full._

### [home-node-lite-v0.4.0] — M4 (Robustness)

_Unreleased — pending milestone gate at Phase 8d. Expected scope:
chaos, crash recovery, migration, perf targets, client sync._

### [home-node-lite-v0.3.0] — M3 (Trust + service network)

_Unreleased — pending milestone gate at Phase 8c. Expected scope:
AppView queries + indexing, trust rings, service query/response,
cart handover, deep links._

### [home-node-lite-v0.2.0] — M2 (Persona model)

_Unreleased — pending milestone gate at Phase 8b. Expected scope:
4-tier persona gating, passphrase flows, audit log, persona
isolation storage tiers._

### [home-node-lite-v0.1.0] — M1 (Minimum Viable Lite)

_Unreleased — pending milestone gate at Phase 8a. Expected scope:
pair + ask + remember + D2D delivery, basic PII scrubbing, default
persona only._

---

## Protocol package

`@dina/protocol` is versioned independently — it follows SemVer
strictly so third-party implementations can pin a protocol major
and trust it. See
[`packages/protocol/docs/conformance.md`](./packages/protocol/docs/conformance.md)
§12 for the compat rules.

### [@dina/protocol — Unreleased]

_Changes pending the next protocol release._

---

## Go/Python production stack

The Go/Python stack predates this changelog and the Home Node Lite
build. Historical entries live in `git log` + the commit-message
convention; going forward, notable changes land here under *Unreleased*
and graduate on tag pushes.

---

## Historical

Pre-changelog entries — trace via `git log`. Significant landmarks:

- **Phase 1 (2026-04-21)** — `packages/` + `apps/home-node-lite/`
  workspace scaffolded. Shared TS packages (`@dina/protocol`,
  `@dina/core`, `@dina/brain`, `@dina/storage-node`,
  `@dina/crypto-node`) populated. Transport-agnostic `CoreClient`
  interface + `InProcessTransport` + `HttpCoreTransport`.
- **Phase 3a (2026-04-22)** — `@dina/storage-node` feature-complete:
  SQLCipher adapter, provider, migration runner, 128 tests
  covering CRUD, FTS5, blobs, concurrency, perf smoke, and
  cross-package integration against `@dina/core`'s real schemas.
- **Phase 10 (2026-04-22)** — Conformance kit complete: 9 frozen
  test vectors, runnable suite, HTTP harness, per-feature docs,
  spec published at `packages/protocol/docs/conformance.md`.
