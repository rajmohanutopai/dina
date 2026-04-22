# Lite-suite error-string adjustments (task 8.57)

Tests under `tests/integration/` that string-match against Go Core's
exact error prose need per-test adjustment to accept Lite's equivalent
prose, because different language stacks produce slightly different
error messages for the same underlying failure mode.

This file records every such adjustment so a future reader can grep
for a specific Go error string and find the Lite counterpart + the
test that ratchets on both.

## Why this file exists (not just a code comment)

Go and Lite return different literal error strings for equivalent
conditions — e.g. `"invalid persona: unknown"` (Go `fmt.Errorf`) vs
`"Unknown persona: unknown"` (Lite `Error` with capitalised prefix per
Fastify convention). A test written to `assert "invalid persona" in
err.message` passes against Go but fails against Lite. The fix is
**oracle-neutral rewriting** — replace the string match with a check
against an error *code* or *category* both stacks emit, and record
the substitution here so the intent is traceable.

The alternative (parametrising every assertion with both strings) is
a bad pattern: it embeds stack-specific prose in the test's source,
which re-breaks the moment either stack polishes its error messages.

## Adjustment patterns (the 4 canonical fixes)

### Pattern 1 — substitute string-match with code-match

```python
# before (Go-only):
assert "invalid persona" in exc.value.message

# after (oracle-neutral):
assert exc.value.code == "persona_unknown"
```

Requires both stacks to emit a stable `code` field; Dina's error
contract (`packages/protocol/src/validators.ts` + Go's
`core/internal/service/errors.go`) does. Preferred over pattern 2.

### Pattern 2 — assert against an Enum of allowed strings

```python
LITE_OR_GO_UNKNOWN_PERSONA = ("invalid persona: unknown", "Unknown persona: unknown")
assert exc.value.message in LITE_OR_GO_UNKNOWN_PERSONA
```

Use when the test ABSOLUTELY needs prose-level fidelity (rare — only
for logging-format tests that assert on the user-visible message).

### Pattern 3 — regex with shared substring

```python
import re
# both stacks include "persona" + "unknown" somewhere in the message
assert re.search(r"(?i)persona.*unknown|unknown.*persona", exc.value.message)
```

Use when pattern 1 isn't feasible (no stable code) and pattern 2 is
too brittle (messages include formatted values).

### Pattern 4 — drop the assertion

Rarely correct: only when the test is asserting something that a
well-written implementation doesn't need to guarantee. Document the
drop in this file AND in an inline test comment.

## Current registry

> **Status: M0 (Phase 7c complete, Phase 8 migration not yet started).**
> No adjustments recorded yet; first entries land when task 8.1
> (conftest DINA_LITE=docker branch) completes and migrated tests
> start surfacing mismatches.

| Test file / case | Go string (was) | Lite string (now) | Fix pattern | Rationale |
|------------------|-----------------|-------------------|-------------|-----------|
| *(none yet)* | | | | |

## Adjustment-discovery workflow

When a test fails under Lite with a string-match mismatch:

1. Confirm Lite's error is semantically correct (not a bug — if it is,
   file in `LITE_SKIPS.md` with category `lite-bug` instead)
2. Grep for a stable error code on both sides:
   - Python side: `code` / `.details` / custom exception type
   - Go side: `core/internal/service/errors.go` + error wrappers
3. If both emit a code, apply **pattern 1** (code-match)
4. If only one emits a code, either add a code on the silent side
   (preferred — improves the error contract for both) or fall through
   to **pattern 2** (enum) / **pattern 3** (regex)
5. Add the entry here

## Bulk-fix tooling (when ≥ 5 tests share the same string)

If the same Go string appears in 5+ tests, write a single codemod
script in `scripts/lite_error_string_codemod.py` that does the
substitution across all sites; commit the codemod + its output
together. Link the codemod under the "Fix pattern" column of each
entry it covered.

## Related

- Task 8.53 — failing-test classification
- Task 8.54 — go-specific-assertion rewrite (this file is its registry)
- Task 8.58 — skip registry (`LITE_SKIPS.md`) for tests that can't be
  rewritten and need to be skipped instead
- `@dina/protocol` validators' error-string contract — changes to
  those error strings need a protocol-minor bump and a release note
  (see `packages/protocol/docs/conformance.md` §10)
