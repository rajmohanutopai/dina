# Home Node Lite — adoption gate (Phase 13)

Post-M5 playbook for the decision *"do we keep both stacks, or
schedule Go/Python retirement?"* Structured around tasks 13.1–13.5:

1. Deploy alongside test-infra (task 13.1)
2. 30-day personal-use soak (task 13.2)
3. **Post-soak report** (task 13.4) — the template below
4. **Decision gate** (task 13.5) — the framework below
5. Stack-selection feature flag (task 13.3, already landed iter 58 —
   `./install.sh --stack lite`)

## Why this gate exists

The two-stack decision in `ARCHITECTURE.md` is explicit about being
provisional: "Long-term, one of the two may retire. Phase 13.5 of the
Lite task plan is an explicit decision gate: 'keep both stacks or
schedule Go/Python retirement.' That decision comes after M5 parity
is measured, not before."

Phase 13 is the measurement step. Until this gate completes, both
stacks ship; after this gate, the decision (maintain-both or
retire-one) is recorded in `ARCHITECTURE.md` with a dated rationale.

## 30-day personal-use soak (task 13.2)

**Scope.** One operator running **only** Home Node Lite as their
daily-driver Dina for 30 consecutive days. No fallback to Go/Python;
no dual-stack shadowing — the point is to surface latent defects
that only manifest under sustained single-stack use.

**Setup.**
- Clean host (VPS or home mini-PC), ≥ 4 GB RAM, x86_64 or arm64
- `./install.sh --stack lite` with production infra (not
  `test-*.dinakernel.com`)
- Operator records their mnemonic + DID, then **uses the Dina daily**
  for 30 days: ingestion, recall, D2D, persona switching, any M5
  feature the operator would normally exercise

**What's recorded each day** (append-only log; one line minimum):
- Date
- Unexpected behaviour (if any) — what surprised the operator that
  Go/Python wouldn't have surprised them
- Container restarts (`docker ps` uptime check — ideally 30d
  continuous)
- Anything the operator had to work around (manual restart, config
  tweak, PR filed, etc.)

**Passive metrics run throughout the 30d** (same pipe as Phase 11c
soak; no new scripting):
- `./apps/home-node-lite/docker/security-checks/soak-runner.sh` at
  low RPS in a background session — memory + unhandled rejections +
  WAL reclamation
- Output accumulates under `/tmp/dina-soak-*/`; copy to a persistent
  location at end

---

## Post-soak report template (task 13.4)

Operator fills this out at day-30. Commits to the repo as
`docs/lite-adoption-<YYYY-MM>.md`. The structure below is the
required schema so consecutive adoption runs stay comparable.

```markdown
# Home Node Lite adoption report — <YYYY-MM>

**Operator:** <name or handle>
**Start date:** <YYYY-MM-DD>
**End date:** <YYYY-MM-DD+30>
**Host:** <arch / RAM / storage / OS>
**Lite version:** <home-node-lite-vX.Y.Z>
**Usage profile:** <one sentence: "primary driver", "shadow alongside
Go/Python production", "limited to persona X", etc.>

## Quantitative results

| Metric                                | Value                    |
|---------------------------------------|--------------------------|
| Days elapsed                          | 30                       |
| Container restarts (core-lite)        | <N>                      |
| Container restarts (brain-lite)       | <N>                      |
| Longest continuous uptime             | <HH hours / DD days>     |
| soak-runner gate passes               | <N of N attempts>        |
| Memory growth over 30d (combined RSS) | <+X% or -X%>             |
| Unhandled rejections logged           | <N>                      |
| WAL peak size observed                | <X MB>                   |
| Final image size (core-lite)          | <MB>                     |
| Final image size (brain-lite)         | <MB>                     |

## Qualitative notes

### What worked well

<bullets>

### What surprised the operator (that Go/Python wouldn't have)

<bullets>

### Manual workarounds applied

<table: date / issue / workaround / upstream-task-if-known>

### PRs filed during the soak

<list: PR# / one-line summary>

## Feature-parity check (M5 gate re-verification)

- [ ] All M5 sub-tasks (8.34-8.51) still `[x]` in `HOME_NODE_LITE_TASKS.md`
- [ ] `docs/lite-release-signoff.md` M5 checklist items all `[x]`
- [ ] `./run_all_tests.sh --unit-only` green
- [ ] `npm run conformance` green (9/9 vectors)

## Recommendation

One of:
- **keep-both** — Lite is production-ready; maintain both stacks.
  Rationale: <one paragraph>
- **retire-go-python** — Lite subsumes Go/Python; schedule retirement
  for <target date / milestone>. Rationale: <one paragraph>
- **defer** — data is inconclusive; re-run adoption cycle (30d) with
  <adjustments>. Rationale: <one paragraph>

Signed: <operator>, <YYYY-MM-DD>
```

---

## Decision-gate framework (task 13.5)

The recommendation from the post-soak report feeds into a decision
meeting (or async PR review) that outputs exactly one of three
outcomes below, each with concrete downstream actions.

### Option A — keep-both (maintain both stacks)

**When this is right:**
- Lite handles its target use cases well but the Go/Python stack has
  meaningfully better ergonomics / perf / ecosystem reach for some
  operator class (e.g. VPS ops who already have Python expertise)
- Maintenance cost of both stacks stays bounded (~30% overhead per
  ARCHITECTURE.md § *Two-Stack Implementation* — don't let it climb
  silently)
- Cross-stack compat (tasks 8.60 / 8.61) continues to work, so an
  operator can pair a Lite Core with a Python Brain or vice versa
  without ops pain

**Downstream actions:**
- `ARCHITECTURE.md` § *Two-Stack Implementation* → add a dated
  "confirmed 20XX-XX after 30d adoption soak; next re-gate in 12 months"
  sentence at the end of the "Why this is not a fork" subsection
- Keep the `--stack` flag in `install.sh` (task 13.3); remains the
  canonical selector
- Release cadence: each stack gets its own release tag prefix
  (`home-node-lite-vX.Y.Z` already in place; Go stack continues with
  whatever it uses today)
- Re-run this gate in 12 months to re-evaluate — prevents
  "maintaining both indefinitely by inertia"

### Option B — retire Go/Python

**When this is right:**
- Lite matches Go/Python on every M5 parity gate AND meets the
  adoption soak acceptance criteria
- Cross-stack compat works, so existing Go/Python operators can
  migrate incrementally (Lite Core talking to Python Brain as an
  intermediate state)
- The 30% maintenance overhead is real + unjustifiable vs unified
  effort on one stack
- **The author of the decision is willing to commit to a retirement
  schedule** (this is the bar — unscheduled "retirement" is just
  abandonment)

**Downstream actions (in order):**
1. **Freeze new features** in Go/Python — only security fixes land
   from this date. Documented in `ARCHITECTURE.md` + release notes.
2. **No data-migration path offered.** Dina is greenfield — Lite
   operators start with a fresh mnemonic + DID via `install-lite.sh`,
   not by importing an existing Go/Python vault. Go/Python operators
   who run out the sunset window either (a) keep running the frozen
   Go/Python stack offline for as long as their host permits, or
   (b) start clean on Lite. Supporting a Go→Lite vault-import path
   would couple the two stacks' SQLCipher formats + key-derivation
   schedules together forever, defeating the point of retirement.
   Announce this explicitly in the sunset notice so operators plan
   accordingly. **The retirement path is exit, not migration.**
3. **Sunset date** — 6 months after freeze, minimum. Announced in
   `CHANGELOG.md` + `README.md` banner.
4. **Final Go/Python release** — a `vX.Y.Z-final` tag with the
   sunset notice baked in
5. **Archive tag** — on sunset date, move Go/Python directories
   (`core/`, `brain/`, `appview/` server side) to a dedicated
   `archive/` subtree and update CLAUDE.md so AI contributors don't
   accidentally target the frozen code
6. Update root `README.md` to lead with Lite; `./install.sh` with no
   flag defaults to `--stack lite`

### Option C — defer (another adoption cycle)

**When this is right:**
- Adoption soak surfaced regressions that need upstream fixes
- Metrics are inconclusive (e.g. memory stable but operator UX bumpy)
- Operator's usage profile didn't exercise enough surface to support
  either "keep-both" or "retire"

**Downstream actions:**
- File upstream issues for each regression surfaced
- Gate them against a patch release (`home-node-lite-vX.Y.Z+1`)
- Re-run 30-day adoption soak after the patch release lands
- Update this doc with a `### Adoption run 2` section; preserve
  `Adoption run 1`'s report so the trend is visible

## How to invoke this gate

After M5 ships (all of Phase 8e + Phase 9 stories green per
`docs/lite-release-signoff.md`):

1. Operator(s) commit to the 30d soak (sign up in an issue, or
   schedule between maintainers)
2. At day 30, fill in the report template above as a PR
3. PR review IS the decision gate meeting — comments drive the
   option A/B/C outcome
4. Merge the report PR; apply the option's downstream actions as
   follow-on PRs

## See also

- `docs/HOME_NODE_LITE_TASKS.md` Phase 13 — the task-plan pointer
- `docs/lite-release-signoff.md` — M1-M5 ship gates; this doc picks
  up after M5
- `ARCHITECTURE.md` § *Architectural Decision: Two-Stack
  Implementation* — the provisionality context
- `./apps/home-node-lite/docker/security-checks/soak-runner.sh` —
  the runtime harness used during the 30-day soak
