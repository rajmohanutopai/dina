#!/usr/bin/env bash
# System-level end-to-end tests — all services real, zero mocks.
#
# Runs BOTH infrastructure sanity checks and user story journeys.
# For just the user story demo (requires GOOGLE_API_KEY), use:
#   ./run_user_story_tests.sh
#
# Layout:
#   check_sanity/   — infrastructure & API sanity checks (45 tests)
#   user_stories/   — full user journeys with real LLM (11+ tests)
#
# Usage:
#   ./run_e2e_all.sh                                  # all tests
#   ./run_e2e_all.sh -k "TestPurchaseJourney"         # single story
#   ./run_e2e_all.sh -k "TestHealth"                  # single sanity section
#   ./run_e2e_all.sh tests/system/check_sanity/       # sanity only
#   ./run_e2e_all.sh tests/system/user_stories/       # stories only
#   SYSTEM_RESTART=0 ./run_e2e_all.sh                 # reuse containers
set -euo pipefail
cd "$(dirname "$0")"
exec ./tests/system/run.sh "$@"
