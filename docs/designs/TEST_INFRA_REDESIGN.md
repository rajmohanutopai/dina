# Test Infrastructure Redesign

**Created:** 2026-03-21
**Status:** Implementation Phase 1 Complete
**Version:** 3 (Phase 1: core infrastructure + conftest migration)

## Problem

The current test infrastructure is fragile:
- 5 different Docker stacks (main, integration, E2E, system, release) with independent lifecycle
- Each suite calls `docker compose up/down/build` — port conflicts, stale containers, disk exhaustion
- Dynamic port allocation adds complexity and race conditions
- `test_status.py` is 2000+ lines orchestrating build/start/health-check/run/cleanup
- Integration tests run against local Go binary + uvicorn (different environment than Docker)
- Failures from Docker infrastructure are indistinguishable from test failures

## Design

### Four Components

```
run_all_tests.sh
  ├── run_unit_tests.sh              # Go + Brain + CLI + AppView, no Docker, <60s
  ├── prepare_non_unit_env.sh        # One compose up, health checks, write manifest
  └── run_non_unit_tests.sh          # Pure pytest/jest, no Docker lifecycle

TestStackServices (Python)           # Shared runtime accessor, reads manifest
```

### Rule

**Once `prepare_non_unit_env.sh` succeeds, no test suite is allowed to call `docker compose up`, `docker compose down`, `--build`, or allocate ports.**

Exception: explicit infra/bootstrap tests (install, crash/restart, profile switching) that test Docker lifecycle itself. These live in a separate `tests/bootstrap/` suite and are NOT part of the normal `run_non_unit_tests.sh` path.

---

## 1. run_unit_tests.sh

No Docker. No network. No services.

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== Go Core ==="
cd core && go test -tags fts5 ./...

echo "=== Python Brain ==="
cd ../brain && PYTHONPATH=. pytest tests/ -q

echo "=== Python CLI ==="
cd .. && pytest cli/tests/ -q

echo "=== Admin CLI ==="
pytest admin-cli/tests/ -q

echo "=== AppView (TypeScript) ==="
cd appview && npm test
```

Target: <60s. All tests run against mocks/in-memory.

---

## 2. prepare_non_unit_env.sh

The ONLY script that touches Docker lifecycle. Produces a machine-readable manifest.

```bash
#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker-compose-test-stack.yml"
PROJECT="dina-test"
MANIFEST=".test-stack.json"

echo "=== Tearing down any existing test stack ==="
docker compose -p $PROJECT -f $COMPOSE_FILE down -v --remove-orphans 2>/dev/null || true

echo "=== Building all images ==="
docker compose -p $PROJECT -f $COMPOSE_FILE build

echo "=== Starting all services ==="
docker compose -p $PROJECT -f $COMPOSE_FILE up -d --wait

echo "=== Health checks ==="
FAILED=0

# Helper: wait for HTTP health endpoint, exit non-zero if timeout
wait_healthy() {
  local name="$1" url="$2" retries="${3:-60}"
  echo -n "  $name: "
  for i in $(seq 1 "$retries"); do
    if curl -sf "$url" > /dev/null 2>&1; then
      echo "healthy"
      return 0
    fi
    sleep 1
  done
  echo "FAILED (timeout after ${retries}s)"
  FAILED=1
  return 1
}

# Core nodes
wait_healthy "alonso-core (19100)"     "http://localhost:19100/healthz" || true
wait_healthy "sancho-core (19300)"     "http://localhost:19300/healthz" || true
wait_healthy "chairmaker-core (19500)" "http://localhost:19500/healthz" || true
wait_healthy "albert-core (19700)"     "http://localhost:19700/healthz" || true

# Brain nodes
wait_healthy "alonso-brain (19200)"     "http://localhost:19200/healthz" || true
wait_healthy "sancho-brain (19400)"     "http://localhost:19400/healthz" || true
wait_healthy "chairmaker-brain (19600)" "http://localhost:19600/healthz" || true
wait_healthy "albert-brain (19800)"     "http://localhost:19800/healthz" || true

# Infrastructure services
wait_healthy "plc (2582)"      "http://localhost:2582/healthz" || true
wait_healthy "pds (2583)"      "http://localhost:2583/xrpc/_health" || true
wait_healthy "appview (3001)"  "http://localhost:3001/health" || true

# Postgres (different check)
echo -n "  postgres (5433): "
if pg_isready -h localhost -p 5433 > /dev/null 2>&1; then
  echo "healthy"
else
  echo "FAILED"
  FAILED=1
fi

# Fail hard if any service is unhealthy
if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "ERROR: One or more services failed health checks."
  echo "Fix the Docker stack before running tests."
  exit 1
fi

echo "=== Writing manifest ==="
cat > "$MANIFEST" <<MANIFEST
{
  "project": "$PROJECT",
  "compose_file": "$COMPOSE_FILE",
  "mode": "fixed",
  "actors": {
    "alonso":     {"core": "http://localhost:19100", "brain": "http://localhost:19200"},
    "sancho":     {"core": "http://localhost:19300", "brain": "http://localhost:19400"},
    "chairmaker": {"core": "http://localhost:19500", "brain": "http://localhost:19600"},
    "albert":     {"core": "http://localhost:19700", "brain": "http://localhost:19800"}
  },
  "services": {
    "plc":      "http://localhost:2582",
    "pds":      "http://localhost:2583",
    "postgres": "postgresql://dina:dina@localhost:5433/dina_appview",
    "appview":  "http://localhost:3001"
  },
  "secrets": {
    "client_token": "secrets/client_token",
    "alonso_keys":  "secrets/service_keys/alonso",
    "sancho_keys":  "secrets/service_keys/sancho",
    "chairmaker_keys": "secrets/service_keys/chairmaker",
    "albert_keys":  "secrets/service_keys/albert"
  }
}
MANIFEST

echo "=== Test stack ready ==="
```

---

## 3. TestStackServices (Python)

Shared runtime accessor. Reads the manifest. No lifecycle decisions.

```
tests/shared/test_stack.py
```

```python
"""Shared service locator for the prepared test stack.

Reads .test-stack.json written by prepare_non_unit_env.sh.
Provides URLs, tokens, key extraction, agent exec, and assert_ready().

Does NOT:
  - run docker compose
  - allocate ports
  - rebuild images
  - silently start missing services
"""

class TestStackServices:
    """Runtime accessor for the prepared test stack."""

    def __init__(self, manifest_path=".test-stack.json"):
        self._manifest = json.load(open(manifest_path))

    # --- Actor URLs ---
    def core_url(self, actor: str) -> str:
        return self._manifest["actors"][actor]["core"]

    def brain_url(self, actor: str) -> str:
        return self._manifest["actors"][actor]["brain"]

    # --- Service URLs ---
    @property
    def plc_url(self) -> str: ...
    @property
    def pds_url(self) -> str: ...
    @property
    def postgres_dsn(self) -> str: ...
    @property
    def appview_url(self) -> str: ...

    # --- Tokens ---
    @property
    def client_token(self) -> str:
        path = self._manifest["secrets"]["client_token"]
        return Path(path).read_text().strip()

    # --- Key extraction (for Brain service-key signing in tests) ---
    def core_private_key(self, actor: str) -> bytes:
        """Read Core's Ed25519 private key from the actor's secrets directory.

        Layout: secrets/service_keys/{actor}/core_ed25519_private.pem
        Matches install.sh key provisioning and Docker volume mounts.
        """
        key_dir = self._manifest["secrets"][f"{actor}_keys"]
        pem_path = Path(key_dir) / "core_ed25519_private.pem"
        if not pem_path.exists():
            # Fallback: extract from running container (current E2E pattern).
            project = self._manifest["project"]
            compose_file = self._manifest["compose_file"]
            result = subprocess.run(
                ["docker", "compose", "-p", project, "-f", compose_file,
                 "exec", f"{actor}-core",
                 "cat", "/run/secrets/service_keys/private/core_ed25519_private.pem"],
                capture_output=True, timeout=10,
            )
            if result.returncode == 0:
                return result.stdout
            raise FileNotFoundError(f"Cannot find Core private key for {actor}: {pem_path}")
        return pem_path.read_bytes()

    # --- Agent exec (for release tests) ---
    def agent_exec(self, cmd: list[str]) -> subprocess.CompletedProcess:
        """Run a command inside the dummy-agent container.

        Note: this is the ONLY Docker exec allowed from test code.
        It does not manage lifecycle — just runs a command in the
        already-prepared container.
        """
        project = self._manifest["project"]
        compose_file = self._manifest["compose_file"]
        return subprocess.run(
            ["docker", "compose", "-p", project, "-f", compose_file,
             "exec", "dummy-agent"] + cmd,
            capture_output=True, text=True, timeout=30,
        )

    # --- Health ---
    def assert_ready(self) -> None:
        """Verify ALL declared services are responding. Raises if not.

        Checks every actor (Core + Brain) and every infrastructure
        service (PLC, PDS, Postgres, AppView). Matches the same set
        that prepare_non_unit_env.sh health-checks.
        """
        # Actor nodes
        for actor, urls in self._manifest["actors"].items():
            r = httpx.get(f"{urls['core']}/healthz", timeout=5)
            assert r.status_code == 200, f"{actor} Core not healthy: {r.status_code}"
            r = httpx.get(f"{urls['brain']}/healthz", timeout=5)
            assert r.status_code == 200, f"{actor} Brain not healthy: {r.status_code}"

        # Infrastructure (HTTP services)
        for name, url in self._manifest["services"].items():
            if name == "postgres":
                continue  # checked below
            health_paths = {"pds": "/xrpc/_health", "plc": "/healthz", "appview": "/health"}
            health = health_paths.get(name, "/healthz")
            r = httpx.get(f"{url}{health}", timeout=5)
            assert r.status_code == 200, f"{name} not healthy: {r.status_code}"

        # Postgres (TCP connect check)
        import socket
        dsn = self._manifest["services"].get("postgres", "")
        if dsn:
            # Extract host:port from postgresql://user:pass@host:port/db
            from urllib.parse import urlparse
            parsed = urlparse(dsn)
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            try:
                sock.connect((parsed.hostname or "localhost", parsed.port or 5432))
                sock.close()
            except (ConnectionRefusedError, OSError) as exc:
                raise AssertionError(f"Postgres not reachable: {exc}") from exc
```

### What it replaces

| Current file | Current role | Replacement |
|---|---|---|
| `tests/integration/conftest.py` DockerServices | Port discovery, token loading, health checks | `TestStackServices` |
| `tests/e2e/multi_node_services.py` | Multi-actor Docker lifecycle + discovery | `TestStackServices` |
| `tests/release/release_services.py` | Release Docker lifecycle + agent exec | `TestStackServices` |
| `tests/system/conftest.py` SystemServices | Full stack lifecycle + AppView seed | `TestStackServices` |
| `scripts/test_status.py` (1000+ lines) | Build/start/health/cleanup | `prepare_non_unit_env.sh` |

### What TestStackServices does NOT replace

- Test fixtures (`conftest.py` `@pytest.fixture` definitions) — those stay, just use `TestStackServices` instead of bespoke classes
- Actor mock logic (`actors.py`, `real_nodes.py`) — those stay, just get URLs from `TestStackServices`
- AppView test runner (`run_appview_tests.py`) — used by `run_non_unit_tests.sh` with `--suite integration`, reads `DATABASE_URL` from env (set from manifest)

---

## 4. run_non_unit_tests.sh

Pure execution. No Docker lifecycle.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Verify stack is ready.
python -c "
from tests.shared.test_stack import TestStackServices
TestStackServices().assert_ready()
print('Test stack verified.')
"

echo "=== Integration ==="
DINA_INTEGRATION=docker pytest tests/integration/ -q

echo "=== E2E ==="
DINA_E2E=docker pytest tests/e2e/ -q

echo "=== Release ==="
DINA_RELEASE=docker pytest tests/release/ -q

echo "=== User Stories ==="
pytest tests/system/user_stories/ -q

echo "=== AppView Integration ==="
DATABASE_URL=$(python -c "from tests.shared.test_stack import TestStackServices; print(TestStackServices().postgres_dsn)") \
  python scripts/run_appview_tests.py --suite integration
```

---

## 5. run_all_tests.sh

```bash
#!/usr/bin/env bash
set -euo pipefail

./run_unit_tests.sh
./prepare_non_unit_env.sh
./run_non_unit_tests.sh

echo "=== All tests passed ==="
```

---

## The Union Stack

### docker-compose-test-stack.yml

Single Compose file. Fixed ports. All actors.

| Service | Role | External Port | Internal Port |
|---------|------|--------------|---------------|
| `plc` | Fake PLC directory | 2582 | 2582 |
| `pds` | AT Protocol PDS | 2583 | 3000 |
| `postgres` | AppView PostgreSQL | 5433 | 5432 |
| `appview` | Trust Network API | 3001 | 3000 |
| `alonso-core` | Don Alonso Core | 19100 | 8100 |
| `alonso-brain` | Don Alonso Brain | 19200 | 8200 |
| `sancho-core` | Sancho Core | 19300 | 8100 |
| `sancho-brain` | Sancho Brain | 19400 | 8200 |
| `chairmaker-core` | ChairMaker Core | 19500 | 8100 |
| `chairmaker-brain` | ChairMaker Brain | 19600 | 8200 |
| `albert-core` | Albert Core | 19700 | 8100 |
| `albert-brain` | Albert Brain | 19800 | 8200 |
| `dummy-agent` | CLI/OpenClaw agent | — | — |

Init containers:
- `keygen-alonso`, `keygen-sancho`, `keygen-chairmaker`, `keygen-albert`
- Provision keys, seed, client_token into named volumes

Networks:
- `test-net`: all services on one flat network

Volumes per actor:
- `{actor}-secrets` (keys, tokens)
- `{actor}-data` (vault files)

Environment (all services):
- `DINA_TEST_MODE=1`
- `DINA_RATE_LIMIT=100000`
- Per-actor `DINA_CLIENT_TOKEN` from secrets volume

---

## Manifest (.test-stack.json)

Written by `prepare_non_unit_env.sh`. Read by `TestStackServices`.

```json
{
  "project": "dina-test",
  "compose_file": "docker-compose-test-stack.yml",
  "mode": "fixed",
  "actors": {
    "alonso":     {"core": "http://localhost:19100", "brain": "http://localhost:19200"},
    "sancho":     {"core": "http://localhost:19300", "brain": "http://localhost:19400"},
    "chairmaker": {"core": "http://localhost:19500", "brain": "http://localhost:19600"},
    "albert":     {"core": "http://localhost:19700", "brain": "http://localhost:19800"}
  },
  "services": {
    "plc":      "http://localhost:2582",
    "pds":      "http://localhost:2583",
    "postgres": "postgresql://dina:dina@localhost:5433/dina_appview",
    "appview":  "http://localhost:3001"
  },
  "secrets": {
    "client_token": "secrets/client_token",
    "alonso_keys":  "secrets/service_keys/alonso",
    "sancho_keys":  "secrets/service_keys/sancho",
    "chairmaker_keys": "secrets/service_keys/chairmaker",
    "albert_keys":  "secrets/service_keys/albert"
  }
}
```

---

## test_status.py → Thin Reporter

Strip to reporting only:
- Read pytest/jest output
- Map test names to TST-* sections
- Render summary table with pass/fail/skip counts
- No service lifecycle, no Docker calls, no Go build

---

## Bootstrap/Lifecycle Tests

Tests that test Docker lifecycle itself (install, crash, restart, profile switching) are exempt from the "no Docker" rule. They live in `tests/bootstrap/` and are NOT part of `run_non_unit_tests.sh`. Run separately:

```bash
./run_bootstrap_tests.sh  # optional, not in run_all_tests.sh
```

---

## Dynamic Port Mode (Developer Escape Hatch)

Default: fixed ports. Always.

Optional: `DINA_TEST_STACK_MODE=dynamic` — only for local developers with port conflicts. This mode:
- Uses `docker compose port` to discover allocated ports
- Writes dynamic ports into `.test-stack.json`
- `TestStackServices` reads from manifest regardless of mode

This is NOT the default. CI always uses fixed ports.

---

## Migration Steps

### Step 1: Create `docker-compose-test-stack.yml`
Merge all actors from E2E + system + release compose files into one file. Fixed ports. All init containers.

### Step 2: Create `tests/shared/test_stack.py`
Implement `TestStackServices` — manifest reader, URL provider, token loader, key extractor, agent exec.

### Step 3: Create the 4 scripts
`run_unit_tests.sh`, `prepare_non_unit_env.sh`, `run_non_unit_tests.sh`, `run_all_tests.sh`

### Step 4: Update `conftest.py` files
Replace `docker_services` / `DockerServices` / `MultiNodeDockerServices` / `SystemServices` / `ReleaseDockerServices` with `TestStackServices`.

### Step 5: Simplify `test_status.py`
Strip service management (~1000 lines). Keep reporting (~500 lines).

### Step 6: Delete old compose files
Remove `docker-compose-e2e.yml`, `docker-compose-system.yml`, `docker-compose-release.yml`, and per-suite Docker lifecycle code.

### Step 7: Update CLAUDE.md and README
Document new test commands.

---

## Risks

| Risk | Mitigation |
|------|------------|
| Union stack uses more resources | 4 actors × (Core+Brain) + infra ≈ 13 containers. Modern dev machines handle this. |
| Port conflicts with dev services | Dev uses 8100/8200. Tests use 19100+. No overlap. |
| Test isolation | Per-test fixture cleanup (reset personas, clear vault). Same pattern as current E2E. |
| Longer initial prepare | Build once, test many. Net faster than rebuild-per-suite. |
| AppView tests need Postgres | Postgres in union stack. DSN in manifest. |
| Dynamic mode complexity | Off by default. Only behind explicit flag. |
