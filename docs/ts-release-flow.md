# TypeScript workspace release flow

Operational guide for the TS monorepo at repo root (`packages/*`, `apps/home-node-lite/*`, `apps/mobile` when it arrives). This doc answers: how do I add a version bump, how do I cut a release, and what's actually published vs kept private.

For the big-picture task plan see [`HOME_NODE_LITE_TASKS.md`](./HOME_NODE_LITE_TASKS.md). For package layering rules see [`../packages/README.md`](../packages/README.md).

## TL;DR

```bash
# After a change that affects a published package:
npx changeset                 # pick packages, bump level, write summary

# Periodically, to cut a release:
npx changeset version         # applies pending changesets, bumps versions + writes CHANGELOG.md per package
git commit -am "release"      # changeset-bumped files
npx changeset publish         # pushes to npm (only packages not `private: true`)
git push --follow-tags
```

Pre-M1 state: **no packages are published yet.** Every package is either `private: true` or not yet created. `npx changeset publish` is a no-op until the first package drops its `private` flag — today that's scheduled to be `@dina/protocol` at M1 per [`HOME_NODE_LITE_TASKS.md`](./HOME_NODE_LITE_TASKS.md) Phase 10.

## Workspace layout (for orientation)

```
dina/
├── packages/                       shared TS packages (workspace)
│   ├── protocol/                   @dina/protocol    — publishable from M1
│   ├── core/                       @dina/core        — internal (private)
│   ├── brain/                      @dina/brain       — internal (private)
│   ├── fixtures/                   @dina/fixtures    — internal
│   ├── test-harness/               @dina/test-harness — internal
│   ├── storage-node/ …             @dina/storage-node etc. — publish decision per package
│   └── adapters-node/              @dina/adapters-node (meta) — same as above
├── apps/
│   ├── home-node-lite/
│   │   ├── core-server/            — never published (app)
│   │   └── brain-server/           — never published (app)
│   └── mobile/                     — never published (app)
├── package.json                    dina-workspace (private:true)
└── .changeset/                     changesets config + pending changesets
```

Apps (`apps/**`) are `private: true` and never published. Packages (`packages/**`) are publishable-by-default but gated per-package via `publishConfig.access` (see [Access policy](#access-policy) below).

## Changesets — day-to-day

### Adding a changeset

When you make a change that should version-bump a package (new feature, breaking change, bug fix), run:

```bash
npx changeset
```

The prompt asks:

1. **Which packages should this changeset bump?** Select from the multi-select list. Pick only the packages whose public surface changed.
2. **What semver level?** `patch` / `minor` / `major`. Defaults:
   - **patch** — bug fix, doc change, internal refactor that preserves the published API
   - **minor** — new API added, no breaking changes
   - **major** — breaking change to any exported symbol, signature, or wire format

   For `@dina/protocol` specifically, treat wire-format changes as **major** — external implementers depend on stability.

3. **Summary.** One line per bump that ends up in the package's `CHANGELOG.md`. Write the _user-facing_ effect, not the commit-level change. Bad: "refactor storage adapter." Good: "storage adapter now exports `SqliteStoragePort` as the canonical name (was `Storage`)."

The tool writes a markdown file under `.changeset/<random-name>.md`. Commit it with your code change.

### Cutting a release

When ready to publish accumulated changesets:

```bash
# Apply all pending changesets — bumps versions + writes CHANGELOG.md per package
npx changeset version

# Review the diff
git diff

# Commit the version bumps
git commit -am "release: $(date -u +%Y-%m-%d)"

# Publish non-private packages to npm
npx changeset publish

# Push commits + the v-tags that publish created
git push --follow-tags
```

`changeset publish` skips any package marked `private: true` and any package whose version hasn't changed. It runs `npm publish` per eligible package.

### Previewing

```bash
npx changeset status
```

Reports which packages would be bumped and at what level if you ran `version` now. Also prints "NO packages to be bumped" when clean — useful as a CI check.

## Access policy

Every package's `package.json` should explicitly state its publish intent:

- **Public** (consumable by third parties):

  ```json
  {
    "publishConfig": { "access": "public" }
  }
  ```

  Target list: `@dina/protocol`. Possibly individual adapter packages (`@dina/storage-node` etc.) once stabilised — decided per-adapter at M3+.

- **Restricted / private** (internal workspace-only; also the default when `publishConfig.access` is unset):

  ```json
  {
    "private": true
  }
  ```

  Target list: `@dina/core`, `@dina/brain`, `@dina/fixtures`, `@dina/test-harness`, all apps, the workspace root. These never hit npm — they're consumed via `workspace:*` inside the repo only.

- **Meta package** (`@dina/adapters-node`, `@dina/adapters-expo`):
  Public once the granular capability packages are public. Until then, `private: true`.

Pre-M1: everything is `private: true` or not yet created. The first publishable package ships at M1 per the task plan.

## Decision log

Append-only record of release-flow decisions that affect cadence, versioning, or publish targets.

### 2026-04-21 — Phase 0.5: move `dina-mobile` first (option c)

**Context.** `HOME_NODE_LITE_TASKS.md` section "Phase 0.5 — Divergence strategy" surfaced a real risk: during the 10-12 week home-node-lite build, two TS codebases (external `dina-mobile` repo + in-progress `dina/packages/`) would drift. Three options existed:

1. **(a) Freeze `dina-mobile`.** Stop feature development on the mobile app during migration; hand-replay bug fixes into `dina/packages/`. Blocks mobile for 10-12 weeks.
2. **(b) Weekly sync diff.** Automated script diffs the two trees, surfaces unmerged changes. Keeps mobile moving; humans bear the reconciliation burden.
3. **(c) Move `dina-mobile` first.** Inverts the plan: merge dina-mobile into `apps/mobile/` (including the RN app + Expo adapters) before starting Lite server work. Divergence collapses to zero from day one.

**Decision.** Option (c).

**Rationale.** Options (a) and (b) both require active process discipline to avoid drift, and both create a reconciliation event at some later date. Option (c) pays ~1 week upfront to eliminate the failure mode entirely. For a solo-maintained project the process-discipline options are especially fragile.

**Execution impact.**

- Phase 1 grew from ~3-4 days → ~5-7 days. Additional sub-phase 1a' (tasks 1.14.1–1.14.13) covers the app move + 5 Expo adapter packages + `adapters-expo` meta + Metro config + iOS/Android build smokes.
- `apps/mobile/` and `packages/{storage,crypto,fs,net,keystore}-expo/` land at the start of Phase 1, not as a deferred "cross-cutting" effort.
- `dina-mobile` repo gets an archive notice (task 0.22) — but that step modifies files outside this repo, so it happens on the migration day, not during this planning session.

**Release cadence implication.** With `apps/mobile/` living in this repo from Phase 1, mobile releases and TS-package releases share one version cadence. Changesets will multi-bump cleanly: a change that touches `@dina/core` also bumps `apps/mobile` consumption of that version — handled automatically by `workspace:*` + `updateInternalDependencies: patch`.

**Rejected.** Options (a) and (b) — see Context above.

## CI integration (Phase 0c)

Phase 0c wires GitHub Actions to:

- Run `npx changeset status` on every PR — fails if a non-docs change lacks a changeset (enforceable via [`changesets/action`](https://github.com/changesets/action))
- On merge to `main`, open a "version PR" that accumulates pending bumps; merging it triggers `changeset publish`
- Publish requires an `NPM_TOKEN` secret scoped to the `@dina` npm org

Until those workflows land, publish happens manually using the commands in [Cutting a release](#cutting-a-release).

## Pre-requisites for first publish

When the first publishable package ships (at M1, per plan):

1. Own the `@dina` npm scope — `npm org add dina <owner-username>`
2. Add `NPM_TOKEN` GitHub secret for CI, or log in locally with `npm login`
3. Confirm `publishConfig.access: "public"` is set on the package
4. Confirm `package.json` has `files: [...]` or `main` pointing at the built output
5. Run a dry-run first: `npm publish --dry-run` inside the package dir

## Troubleshooting

- **`changeset publish` exits 0 but publishes nothing.** Check that at least one package has changed version AND is not `private: true`. Pre-M1 this is the expected state.
- **`No packages to be bumped` from `changeset status`.** Means no pending changesets. Either expected (clean state) or you forgot to run `npx changeset` before `version`.
- **Publish fails with 403.** npm scope permissions. Confirm `npm whoami` and the `@dina` org membership.
- **`changeset version` produced unexpected cross-package bumps.** Check `.changeset/config.json`'s `linked` and `fixed` arrays. Currently both empty — each package versions independently.

## See also

- [HOME_NODE_LITE_TASKS.md](./HOME_NODE_LITE_TASKS.md) — overall plan
- [../packages/README.md](../packages/README.md) — layering + dependency-graph rules
- [changesets/changesets](https://github.com/changesets/changesets) — upstream docs
