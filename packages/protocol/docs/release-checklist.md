# `@dina/protocol` — release checklist

The actual `npm publish` is a maintainer action (task 10.18). This
checklist is the reproducible sequence the maintainer runs to take
`@dina/protocol` from the current in-repo state to a published npm
package, and what to verify once it's live. Each step is cross-linked
to the regression gate that enforces it, so a failure here is never
silent.

## Pre-flight: the package is already prep-ready

Landed in task 10.18 prep (2026-04-22) — do NOT re-do, just verify:

- [ ] `packages/protocol/tsconfig.build.json` exists with CJS output +
      declaration-emit + `composite: false` + excludes tests / conformance.
      Gate: `publish_ready.test.ts::tsconfig.build.json exists…`.
- [ ] `packages/protocol/package.json` has `build`, `prepublishOnly`,
      `files`, and `publishConfig` fields. Gate: `publish_ready.test.ts`
      (9 assertions covering each field).
- [ ] The package is `"private": true` in the in-repo `package.json`.
      This is the accidental-publish guard. Gate:
      `publish_ready.test.ts::stays private until the maintainer flips…`.
- [ ] README carries the npm badges (task 10.19 — render as "invalid"
      until first publish, then auto-activate). Gate: none — visible in
      the rendered README.

## Step 1 — Clean-room build verification

```bash
cd packages/protocol
npm run build         # emits dist/ fresh
npm test              # includes publish_ready.test.ts — 10 tests
```

Expected:
- `dist/index.js` + `dist/index.d.ts` + per-module artefacts under `dist/types/`.
- `npm test` shows 175+ tests passing (165 protocol tests + 10 publish-readiness).
- `npm run conformance` (optional) runs the 9 conformance vectors.

Failure modes:
- TSC errors → source drifted from `tsconfig.build.json` constraints
  (e.g. `composite: false` vs importing a composite-mode type).
  Fix source; re-run.
- `publish_ready.test.ts` red → one of the 4 invariants (files /
  publishConfig / scripts / tsconfig.build) got mutated. Revert or
  update the gate's expectations deliberately.

## Step 2 — Pick the version

npm is append-only — a version string can never be re-used once
published. Decide between:

| Track | When | Version |
|-------|------|---------|
| Beta  | First publish; want feedback before semver commitments | `0.1.0-beta.1` with `--tag beta` |
| Public v0.1.0 | Stable enough for third-party implementers | `0.1.0` as `--tag latest` |

```bash
# Beta (reversible if the next beta rev fixes a mistake)
npm version 0.1.0-beta.1 --no-git-tag-version

# OR Public
npm version 0.1.0 --no-git-tag-version
```

`--no-git-tag-version` defers git tagging to Phase 12's milestone
tag-per-M-gate flow (task 12.9). Don't auto-tag from npm.

## Step 3 — Unlock + publish

```bash
# Flip the private-flag to allow publish. DO NOT commit this flip.
# If the publish fails, just leave the working-tree flip and retry.
# If you need to abort, `git checkout -- package.json`.
npm pkg set private=false

# Beta:
npm publish --tag beta --access public

# OR Public:
npm publish --access public

# Restore private flag in the working tree (pre-commit).
npm pkg set private=true
```

The `prepublishOnly` hook runs `npm run build && npm test` before npm
actually uploads — no need to remember to build first.

## Step 4 — Post-publish verification

```bash
# 1. The package is resolvable on the registry.
npm view @dina/protocol version
npm view @dina/protocol dist-tags

# 2. A fresh consumer sees the published artefacts, not src/.
cd $(mktemp -d)
npm init -y >/dev/null
npm install @dina/protocol
node -e "const p = require('@dina/protocol'); console.log(Object.keys(p).length, 'exports')"
# expected: ~37
node -e "const p = require('@dina/protocol'); console.log(p.SERVICE_TYPE_MSGBOX)"
# expected: DinaMsgBox
ls node_modules/@dina/protocol  # expected: dist/ + README.md + docs/ + package.json
# NO src/, __tests__/, conformance/, node_modules/ inside.
```

The last `ls` is load-bearing — the `files` whitelist in
`package.json` is the only guard between the published tarball and
the full source tree. If `src/` or `__tests__/` shows up, the
whitelist drifted and a re-publish with a patched version is needed
(npm doesn't let you amend).

## Step 5 — README badges activate

The npm badges in `packages/protocol/README.md` (task 10.19) start
showing the live version within ~1 hour of publish as shields.io
caches refresh. Visual check:

- [ ] `https://img.shields.io/npm/v/@dina/protocol.svg` renders with
      the version you just published.
- [ ] `https://img.shields.io/npm/dm/@dina/protocol.svg` eventually
      shows download counts (starts at 0).

No code change needed — the URLs were pre-baked in task 10.19's
badge markup.

## Step 6 — Flip the checkbox

Once steps 1–5 are green, in `docs/HOME_NODE_LITE_TASKS.md` flip the
checkbox for task 10.18 with a done-note that captures: published
version, dist-tag, npm registry URL, and date. That's the canonical
signal the publish is complete.

## Rollback strategy

npm publishes are effectively irreversible — you can `npm unpublish`
only within 72 hours of initial publish for non-deprecated versions.
If a broken version ships:

1. **Within 72h**: `npm unpublish @dina/protocol@VERSION`. Costs a
   version number but removes the artefact.
2. **After 72h** or if already consumed: bump patch version
   (`0.1.0` → `0.1.1`), fix, re-publish. Mark the broken version as
   deprecated: `npm deprecate @dina/protocol@0.1.0 "use 0.1.1 for
   the <reason> fix"`.
3. **If the bug is in the wire format itself**: that's a protocol
   break. Document in `packages/protocol/docs/conformance.md` §14
   (changelog), bump the major (`0.x.x` → `1.0.0` or `1.x.x` → `2.0.0`),
   re-publish. Third-party implementers following the conformance
   spec will see the change in their next conformance run.

## Why this checklist exists

npm publishes have a surprising number of moving parts (publishConfig
override, files whitelist, prepublishOnly hook, dist-tag choice,
private-flag flip) and a surprising number of irreversible consequences
(version burn, global namespace claim, downstream consumer cache
confusion). The gates in `publish_ready.test.ts` catch the subset that
can be statically verified; this checklist covers the rest.

Source: docs/HOME_NODE_LITE_TASKS.md tasks 10.18, 10.19.
