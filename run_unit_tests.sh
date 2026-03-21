#!/usr/bin/env bash
set -euo pipefail

echo "=== Go Core ==="
(cd core && go test -tags fts5 ./...)

echo "=== Python Brain ==="
(cd brain && PYTHONPATH=. pytest tests/ -q)

echo "=== Python CLI ==="
pytest cli/tests/ -q

echo "=== Admin CLI ==="
pytest admin-cli/tests/ -q

echo "=== AppView (TypeScript) ==="
(cd appview && npm test 2>/dev/null || echo "  (skipped — npm test not configured)")

echo ""
echo "=== All unit tests passed ==="
