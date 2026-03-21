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

# Extract alonso Core URL and client token from test stack for install tests.
# test_post_install.py uses DINA_CORE_URL + DINA_CLIENT_TOKEN to skip the
# slow pexpect install and test against the already-running stack instead.
eval "$(python3 -c "
import sys, json; sys.path.insert(0, '.')
from tests.shared.test_stack import TestStackServices
ts = TestStackServices()
print(f'export DINA_CORE_URL={ts.core_url(\"alonso\")}')
print(f'export DINA_CLIENT_TOKEN={ts.client_token}')
")"

# Run all non-unit suites via test_status.py for structured table output.
# Env vars tell conftest files to use real clients against the union stack.
# 'install' = fast core/model/post-install tests (~6s)
# 'install-pexpect' = shell lifecycle tests (prompt flow, run.sh, rerun)
DINA_INTEGRATION=docker \
DINA_E2E=docker \
DINA_RELEASE=docker \
DINA_RATE_LIMIT=100000 \
DINA_CORE_URL="$DINA_CORE_URL" \
DINA_CLIENT_TOKEN="$DINA_CLIENT_TOKEN" \
  python scripts/test_status.py --suite integration,e2e,release,user_stories,install,install-pexpect
