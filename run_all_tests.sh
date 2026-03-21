#!/usr/bin/env bash
set -euo pipefail

echo "============================================"
echo "  Dina Full Test Suite"
echo "============================================"
echo ""

./run_unit_tests.sh

echo ""
echo "============================================"
echo "  Preparing Docker test environment..."
echo "============================================"
echo ""

./prepare_non_unit_env.sh

echo ""
echo "============================================"
echo "  Running non-unit tests..."
echo "============================================"
echo ""

./run_non_unit_tests.sh

echo ""
echo "============================================"
echo "  ALL TESTS PASSED"
echo "============================================"
