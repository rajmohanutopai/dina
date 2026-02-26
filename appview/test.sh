#!/usr/bin/env bash
# AppView test runner — thin wrapper around test_appview.ts
# Usage: ./appview/test.sh [options]
cd "$(dirname "$0")" && exec npx tsx test_appview.ts "$@"
