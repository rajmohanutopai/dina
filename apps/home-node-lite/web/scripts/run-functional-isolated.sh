#!/usr/bin/env bash
#
# Run each functional MRS spec in its OWN fresh stack.
#
# Why: the functional stack shares one Core + Brain across a run, and the
# Brain's agentic STAGING-DRAIN queue accumulates across specs (resetVault
# clears vault items, not the pre-drain staging queue). Each `/remember`
# kicks off a slow multi-Gemini agentic drain, and the browser's `isTyping`
# tracks the whole loop — so under the combined load of several LLM specs
# the queue backs up and a later spec's send stalls (implementation-notes
# F3). A fresh stack per spec = a fresh Brain with an empty drain, so there
# is no cross-spec accumulation. It's slower (one Core+Brain boot + one
# did:plc provision per spec) but deterministic.
#
# Each `playwright test` invocation boots its own webServer (buildStack),
# runs its own globalSetup/globalTeardown (incl. the MRS-14 log sweep), and
# tears down. A non-zero exit from any spec fails the whole run.
#
# Usage: run-functional-isolated.sh [extra playwright args...]
set -uo pipefail

cd "$(dirname "$0")/.."

CONFIG="playwright.functional.config.ts"
SPEC_DIR="__e2e__/functional"

# Deterministic order: the state-perturbing durability reload spec (zz_)
# sorts last anyway, but each runs isolated so order no longer matters for
# correctness — only for readable output. Spec basenames never contain
# spaces, so simple word-splitting is safe (and portable to bash 3.2, which
# lacks `mapfile`).
SPECS=$(cd "$SPEC_DIR" && ls -- *.spec.ts | sort)

if [ -z "$SPECS" ]; then
  echo "run-functional-isolated: no specs found in $SPEC_DIR" >&2
  exit 1
fi

fail=0
count=0
FAILED=""
for spec in $SPECS; do
  count=$((count + 1))
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "  functional (isolated stack): $spec"
  echo "════════════════════════════════════════════════════════════════"
  if ! npx playwright test --config="$CONFIG" "$@" "$SPEC_DIR/$spec"; then
    fail=1
    FAILED="$FAILED $spec"
  fi
done

echo ""
if [ "$fail" -ne 0 ]; then
  echo "✘ functional (isolated): FAILED —$FAILED"
else
  echo "✓ functional (isolated): all $count specs passed"
fi
exit "$fail"
