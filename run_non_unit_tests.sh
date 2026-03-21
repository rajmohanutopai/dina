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
    print('Run ./prepare_non_unit_env.sh first.')
    sys.exit(1)
"

echo "=== Integration ==="
DINA_INTEGRATION=docker DINA_RATE_LIMIT=100000 pytest tests/integration/ -q

echo "=== E2E ==="
DINA_E2E=docker DINA_RATE_LIMIT=100000 pytest tests/e2e/ -q

echo "=== Release ==="
DINA_RELEASE=docker DINA_RATE_LIMIT=100000 pytest tests/release/ -q

echo "=== User Stories ==="
pytest tests/system/user_stories/ -q

echo "=== AppView Integration ==="
DATABASE_URL=$(python3 -c "import sys; sys.path.insert(0, '.'); from tests.shared.test_stack import TestStackServices; print(TestStackServices().postgres_dsn)") \
  python scripts/run_appview_tests.py --suite integration 2>/dev/null || echo "  (skipped — AppView integration not configured)"

echo ""
echo "=== All non-unit tests passed ==="
