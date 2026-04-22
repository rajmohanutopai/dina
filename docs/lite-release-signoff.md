# Home Node Lite — release sign-off checklist (task 9.20)

Per-milestone acceptance criteria for cutting a `home-node-lite-vX.Y.Z`
tag. Pairs with the skip registry (`tests/integration/LITE_SKIPS.md`)
+ milestone map (`docs/HOME_NODE_LITE_TASKS.md` § *Milestone map*) +
changelog (`CHANGELOG.md`).

Release-day playbook at the bottom.

## M1 — v0.1.0 (Minimum Viable Lite)

**Scope.** Pair + ask + remember + D2D delivery, basic PII, default
persona (one persona, `personal`).

**Gates** (all must be green):

- [ ] Phase 1c–1d: `@dina/core` ↔ `@dina/brain` transport abstraction
      (`CoreClient` interface + `HttpCoreTransport` + `InProcessTransport`)
      stable + 1.32 brain refactor landed + 1.33 lint gate at `error`
- [ ] Phase 5a–5c: brain-server boots, healthz responds, `/api/v1/ask`
      returns a grounded reply
- [ ] Phase 7c: `./install-lite.sh` on a clean host produces a healthy
      stack within 120 s + surfaces the 24-word mnemonic + `did:plc`
      (tasks 7.24, 7.25)
- [ ] Phase 7d: GHA workflow `home-node-lite-release.yml` can publish
      multi-arch (amd64 + arm64) images to `ghcr.io` with Trivy scan
      producing 0 HIGH/CRITICAL on the image (tasks 7.28–7.31)
- [ ] Phase 8a: tasks 8.1–8.11 green + task 8.12 M1 gate ≥ 95% pass
      rate on the Phase 8a test files (`test_home_node.py`,
      `test_ingestion.py`, `test_memory_flows.py`, `test_didcomm.py`,
      `test_dina_to_dina.py`, `test_docker_infra.py`,
      `test_pii_scrubber.py` basic)
- [ ] Phase 9b: Story 07 (Daily briefing) M1 smoke-path passes
- [ ] Phase 11a: `benchmark.sh` reports Core+Brain idle RSS < 250 MB +
      per-service cold-start < 3 s on x86_64 (tasks 11.1, 11.2)
- [ ] Phase 11a: FTS5 p95 < 50 ms (task 11.4) + HNSW p95 < 100 ms
      (task 11.5) at 10k items
- [ ] Phase 11b: Brain cannot read Core's key file at FS / PID-ns /
      cap-inventory level (tasks 11.11 + 11.12 — all 4 + 6 script
      sections PASS)
- [ ] Phase 11b: cap_drop=ALL, read-only root FS, default seccomp
      profile all verified at runtime (tasks 11.14 + 11.15 + 11.16)
- [ ] Phase 11b: `npm audit --omit=dev --audit-level=high` produces
      0 findings (task 11.13)
- [ ] `LITE_SKIPS.md` skip percentage ≤ 10% of migrated suite
      (per task 8.59)
- [ ] `CHANGELOG.md` `[Unreleased]` section fully captures what M1
      ships; entries moved under a new `## [home-node-lite-v0.1.0]`
      heading

## M2 — v0.2.0 (Persona model)

**Scope.** 4-tier gating, passphrase, audit, isolation, storage tiers.

**Gates** (in addition to M1):

- [ ] Phase 8b: tasks 8.13–8.18 green + task 8.19 M2 gate
- [ ] Phase 9b: Stories 02, 04, 05, 07 M2 paths pass
- [ ] Persona tier transitions tested: default ↔ standard ↔ sensitive
      ↔ locked + passphrase unlock flows
- [ ] Sensitive-persona auto-lock on session end verified
- [ ] Audit log entries written for every tier-crossing event + every
      agent session
- [ ] `LITE_SKIPS.md` skip percentage ≤ 7%

## M3 — v0.3.0 (Trust & service network)

**Scope.** AppView, trust rings, service query/response, capability
schemas, cart handover, deep links.

**Gates** (in addition to M2):

- [ ] Phase 8c: tasks 8.20–8.26 green + task 8.27 M3 gate
- [ ] Phase 9b: Stories 01, 03, 06, 09 (partial — M3 scope of 09)
- [ ] Trust Network query from Lite → AppView → response visible
- [ ] Service discovery + query/response round-trip via D2D
- [ ] BusDriver scenario runs (the README demo)
- [ ] Phase 8g: cross-stack compat — **8.60** (Lite Core + Python
      Brain) and **8.61** (Go Core + Lite Brain) both pass smoke
      tests; impedance mismatches documented in
      `docs/lite-impedance-mismatches.md`
- [ ] `LITE_SKIPS.md` skip percentage ≤ 5%

## M4 — v0.4.0 (Robustness)

**Scope.** Chaos, crash recovery, migration, perf targets, client sync.

**Gates** (in addition to M3):

- [ ] Phase 8d: tasks 8.28–8.32 green + task 8.33 M4 gate
- [ ] Phase 9b: Stories 08, 09 (full) pass
- [ ] Phase 11a: Throughput 50 req/s sustained 5 min (task 11.3)
- [ ] Phase 11a: End-to-end `/ask` latency within 2× Go baseline
      (task 11.6)
- [ ] Phase 11c: 24h soak at 1 req/s — memory growth < 20% (task 11.7)
- [ ] Phase 11c: WS reconnect stability under `tc netem` packet loss
      (task 11.10)
- [ ] Phase 11c: DB WAL reclamation observed + documented (task 11.9)
- [ ] Phase 11c: no unhandled promise rejections during soak
      (task 11.8 — guard already enforced per-test run; soak
      extension required)
- [ ] `LITE_SKIPS.md` skip percentage ≤ 5%, category `environmental` only

## M5 — v1.0.0 (Operational edges — full parity)

**Scope.** Compliance, silence tiers, staging, whisper, full contract
wire format, remaining arch validation.

**Gates** (in addition to M4):

- [ ] Phase 8e: tasks 8.34–8.51 green + task 8.52 M5 gate
- [ ] Phase 9b: Story 10 (Operator journey) passes
- [ ] Phase 9c: `tests/release/` REL-001..REL-023 all pass against
      Lite (task 9.17) + dummy-agent container compat verified
      (task 9.18) + CLI pairing scenarios pass (task 9.19)
- [ ] Phase 11d: Pi 5 8GB first-boot wall-clock + idle memory +
      FTS/HNSW latency all within x86_64 baseline × 3 (task 11.17–11.20)
- [ ] `LITE_SKIPS.md` skip percentage **0 ideally, ≤ 5% absolute ceiling**
      (task 8.59)
- [ ] Protocol conformance: `npm run conformance` reports 9/9 PASS
      (task 10.15 — already green + CI-gated)

## Release-day playbook

Applies to every milestone tag.

1. **Confirm gates** — walk this doc's corresponding M-section;
   every item `[x]`.
2. **Update CHANGELOG.md** — move entries under `[Unreleased]` to a
   new `## [home-node-lite-vX.Y.Z]` heading with today's date in
   ISO-8601 UTC.
3. **Update HOME_NODE_LITE_TASKS.md** — verify the milestone's
   sub-tasks are all `[x]`.
4. **Cut the tag**
   ```bash
   git tag -a home-node-lite-vX.Y.Z -m "Home Node Lite vX.Y.Z — <milestone name>"
   git push origin home-node-lite-vX.Y.Z
   ```
   Tag push triggers `home-node-lite-release.yml` which builds +
   pushes `ghcr.io/rajmohan/dina-home-node-lite-{core,brain}` images
   with all applicable tags (`latest` + `vX.Y.Z` + `X.Y` + `X` +
   `sha-<short>`).
5. **Verify image publish** — `docker pull
   ghcr.io/rajmohan/dina-home-node-lite-core:vX.Y.Z` works; Trivy
   scan passed (SARIF in GitHub code-scanning tab).
6. **Post-release smoke** — `./apps/home-node-lite/install-lite.sh`
   on a clean VM pulls the just-published images + comes up healthy.
7. **Announce** — release note references the milestone scope +
   CHANGELOG anchor; `CLAUDE.md` + `README.md` already list the
   current recommended stack so they need no edit unless the
   recommendation itself changes.
8. **Bump `[Unreleased]`** — fresh empty section at top of
   CHANGELOG ready for the next milestone's accumulated entries.

## Rollback plan

If a post-release smoke fails (step 6):

1. Mark the release as pre-release in the GitHub release UI so
   `latest` pointers don't drift to it
2. File a blocker issue linking the failure
3. For the next fix cut, bump patch (`vX.Y.Z+1`) rather than
   re-cutting the same tag — tag rewrites break image caches

The pre-release mark is reversible; an incorrect tag rewrite isn't.

## See also

- `docs/HOME_NODE_LITE_TASKS.md` § *Milestone map*
- `tests/integration/LITE_SKIPS.md` — skip acceptance per milestone
- `CHANGELOG.md` — release notes
- `.github/workflows/home-node-lite-release.yml` — image-publish pipeline
