#!/usr/bin/env bash
# System-level end-to-end tests — all services real, zero mocks.
set -euo pipefail
cd "$(dirname "$0")"
exec ./tests/system/run.sh "$@"
