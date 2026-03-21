#!/usr/bin/env bash
set -euo pipefail

# Verify stack is ready (no Docker lifecycle — must be prepared first).
python3 -c "
import sys; sys.path.insert(0, '.')
from tests.shared.test_stack import TestStackServices
try:
    TestStackServices().assert_ready()
    print('Test stack verified.')
except Exception as e:
    print(f'ERROR: Test stack not ready: {e}')
    print('Run: ./prepare_non_unit_env.sh up')
    sys.exit(1)
"

# Run all non-unit suites via test_status.py for structured table output.
# --mock tells test_status.py NOT to manage Docker (stack is pre-started).
# Env vars tell conftest files to use real clients against the union stack.
DINA_INTEGRATION=docker \
DINA_E2E=docker \
DINA_RELEASE=docker \
DINA_RATE_LIMIT=100000 \
  python scripts/test_status.py --suite integration,e2e,release,user_stories,install
