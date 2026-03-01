#!/usr/bin/env bash
# ============================================================================
# User Story Tests — the Dina value proposition demo.
# ============================================================================
#
# These tests prove what makes Dina unique:
#
#   User says five words: "I need a new office chair."
#
#   Dina autonomously:
#     1. Queries the vault — discovers back pain, WFH schedule, budget, family
#     2. Queries AppView — gets trust-weighted reviews from verified users
#     3. Produces personalized advice no other system can give
#
#   Amazon knows purchase history but not the back pain.
#   ChatGPT knows nothing about the user.
#   Perplexity can search but can't verify reviews are real.
#   Only Dina has the vault AND the Trust Network AND persona context.
#
# Requires:
#   GOOGLE_API_KEY  — for real LLM (Gemini Flash) reasoning
#   Docker          — full system stack (2 Core+Brain, PDS, AppView, Postgres)
#
# Usage:
#   GOOGLE_API_KEY=<key> ./run_user_story_tests.sh               # all stories
#   GOOGLE_API_KEY=<key> ./run_user_story_tests.sh -k test_12    # just the E2E demo
#   SYSTEM_RESTART=0 ./run_user_story_tests.sh                   # reuse containers
#
# For infrastructure sanity checks (no LLM required), use:
#   ./run_e2e_all.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# -- Check for GOOGLE_API_KEY --
if [ -z "${GOOGLE_API_KEY:-}" ]; then
    echo ""
    echo "  WARNING: GOOGLE_API_KEY is not set."
    echo "  LLM-powered tests (test_11, test_12) will be SKIPPED."
    echo "  Set GOOGLE_API_KEY to run the full demo."
    echo ""
fi

echo ""
echo "  ┌──────────────────────────────────────────────────────────┐"
echo "  │          Dina User Story Tests — Value Proposition       │"
echo "  │                                                          │"
echo "  │  Five words in → personalized advice out.                │"
echo "  │  Vault + Trust Network + Brain = something nobody        │"
echo "  │  else can do.                                            │"
echo "  └──────────────────────────────────────────────────────────┘"
echo ""

python -m pytest tests/system/user_stories/ -v --tb=long -s "$@"
