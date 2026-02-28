#!/usr/bin/env bash
# System tests — all services real, zero mocks.
# Usage:
#   ./tests/system/run.sh                    # full run
#   ./tests/system/run.sh -k "TestHealth"    # single section
#   SYSTEM_RESTART=1 ./tests/system/run.sh   # force restart stack
set -euo pipefail
cd "$(dirname "$0")/../.."
python -m pytest tests/system/ -v --tb=short "$@"
