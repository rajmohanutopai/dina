#!/usr/bin/env python3
"""Unified test status reporting: per-section pass/skip/fail breakdown.

Runs each test suite (Core Go, Brain Python, Integration Python, E2E Docker)
and reports per-section status showing which areas are implemented vs pending.

By default runs in **quick mode** — skips slow tests (100K scale, real LLM
agentic calls) for a fast feedback loop.  Use ``--all`` to run everything.

Usage:
    python scripts/test_status.py                    # Quick mode (default) — skip slow tests
    python scripts/test_status.py --all              # Full run — include 100K scale + real LLM
    python scripts/test_status.py --suite e2e        # E2E only (starts 4-actor Docker stack)
    python scripts/test_status.py --suite integration # Integration only
    python scripts/test_status.py --restart          # Force Docker rebuild (tear down + rebuild)
    python scripts/test_status.py --docker           # Use Docker containers instead of local
    python scripts/test_status.py --mock             # Fast mock-only (no real services)
    python scripts/test_status.py --json             # Machine-readable JSON
    python scripts/test_status.py -v                  # Verbose — show individual tests per section
    python scripts/test_status.py --no-color         # Disable ANSI colors
"""

import atexit
import json
import os
import re
import secrets as _secrets
import signal
import shutil
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Global references for signal-handler teardown (supports multiple cleanups)
_cleanup_fns: list = []


# ---------------------------------------------------------------------------
# Service lifecycle helpers (Docker and Local modes)
# ---------------------------------------------------------------------------

LOCAL_CORE_PORT = 18100
LOCAL_BRAIN_PORT = 18200


def _ensure_client_token() -> str:
    """Create secrets/client_token if it doesn't exist yet. Return the token."""
    secrets_dir = PROJECT_ROOT / "secrets"
    token_file = secrets_dir / "client_token"
    if not token_file.exists():
        secrets_dir.mkdir(parents=True, exist_ok=True)
        token_file.write_text(_secrets.token_urlsafe(32))
        token_file.chmod(0o600)
        print("  Generated secrets/client_token", file=sys.stderr)
    return token_file.read_text().strip()


def _ensure_service_key_dirs() -> None:
    """Ensure service key bind-mount directories exist for docker-compose."""
    key_root = PROJECT_ROOT / "secrets" / "service_keys"
    (key_root / "core").mkdir(parents=True, exist_ok=True)
    (key_root / "brain").mkdir(parents=True, exist_ok=True)
    (key_root / "public").mkdir(parents=True, exist_ok=True)
    try:
        (key_root).chmod(0o700)
        (key_root / "core").chmod(0o700)
        (key_root / "brain").chmod(0o700)
        (key_root / "public").chmod(0o755)
    except Exception:
        # Best-effort on platforms that may not honor chmod.
        pass


def _python_runtimes() -> list[str]:
    """Return candidate Python executables for helper scripts."""
    candidates: list[str] = []
    install_python = PROJECT_ROOT / ".install-venv" / "bin" / "python3"
    if install_python.exists():
        candidates.append(str(install_python))
    if sys.executable:
        candidates.append(sys.executable)
    system_python = shutil.which("python3")
    if system_python:
        candidates.append(system_python)
    return candidates


def _run_python_helper(
    script: Path,
    args: list[str],
    *,
    extra_env: dict[str, str] | None = None,
) -> None:
    """Run a repo helper script with the first working Python runtime.

    Secrets should be passed via extra_env (not args) to avoid process-list exposure.
    """
    attempted: list[str] = []
    last_err = ""
    env = {**os.environ, **(extra_env or {})}
    for py in _python_runtimes():
        if py in attempted:
            continue
        attempted.append(py)
        result = subprocess.run([py, str(script), *args], capture_output=True, text=True, env=env)
        if result.returncode == 0:
            return
        last_err = (result.stderr or result.stdout or "").strip()
    detail = f": {last_err}" if last_err else ""
    raise RuntimeError(f"Failed to run helper {script.name}{detail}")


def _provision_service_keys(
    key_root: Path | None = None,
    *,
    runtime_layout: bool = False,
    seed_hex: str | None = None,
) -> None:
    """Provision Core/Brain Ed25519 service keys.

    When seed_hex is provided, derives deterministic keys via SLIP-0010 at
    m/9999'/3'/<index>'. Otherwise falls back to random key generation.
    """
    root = key_root or (PROJECT_ROOT / "secrets" / "service_keys")
    root.mkdir(parents=True, exist_ok=True)

    if key_root is None:
        _ensure_service_key_dirs()

    if seed_hex:
        script = PROJECT_ROOT / "scripts" / "provision_derived_service_keys.py"
        if not script.exists():
            raise RuntimeError(f"Missing derived key provision script: {script}")
        _run_python_helper(script, [str(root)], extra_env={"DINA_SEED_HEX": seed_hex})
    else:
        script = PROJECT_ROOT / "scripts" / "provision_service_keys.py"
        if not script.exists():
            raise RuntimeError(f"Missing key provision script: {script}")
        _run_python_helper(script, [str(root)])

    if runtime_layout:
        # Runtime services (core/brain) load private keys from:
        #   <root>/private/<service>_ed25519_private.pem
        # The provision helper writes install-time files under:
        #   <root>/<service>/<service>_ed25519_private.pem
        priv_dir = root / "private"
        priv_dir.mkdir(parents=True, exist_ok=True)
        for svc in ("core", "brain"):
            src = root / svc / f"{svc}_ed25519_private.pem"
            dst = priv_dir / f"{svc}_ed25519_private.pem"
            if not src.exists():
                raise RuntimeError(f"Missing provisioned private key: {src}")
            shutil.copy2(src, dst)
            dst.chmod(0o600)


def _provision_wrapped_seed(output_dir: Path, passphrase: str) -> None:
    """Create wrapped_seed.bin + master_seed.salt compatible with Core unwrap."""
    script = PROJECT_ROOT / "scripts" / "wrap_seed.py"
    if not script.exists():
        raise RuntimeError(f"Missing seed wrapper script: {script}")
    seed_hex = _secrets.token_hex(32)
    _run_python_helper(
        script, [str(output_dir)],
        extra_env={"DINA_SEED_HEX": seed_hex, "DINA_SEED_PASSPHRASE": passphrase},
    )

    wrapped = output_dir / "wrapped_seed.bin"
    salt = output_dir / "master_seed.salt"
    if not wrapped.exists() or not salt.exists():
        raise RuntimeError("wrap_seed.py did not create wrapped seed artifacts")


def _run_cleanup() -> None:
    """Run all registered cleanup functions (LIFO). Safe to call multiple times."""
    global _cleanup_fns
    fns = _cleanup_fns
    _cleanup_fns = []  # prevent double teardown
    for fn in reversed(fns):
        try:
            fn()  # type: ignore[operator]
        except Exception as exc:
            print(f"  Warning: cleanup error: {exc}", file=sys.stderr)


def _sigint_handler(signum: int, frame: object) -> None:
    """Handle Ctrl+C: tear down services, then exit."""
    _run_cleanup()
    sys.exit(130)  # 128 + SIGINT(2) — standard convention


def _register_cleanup(fn: object) -> None:
    """Register a cleanup function for SIGINT/SIGTERM/atexit.

    Multiple cleanups are supported — they run in LIFO order.
    """
    if not _cleanup_fns:
        # First registration: wire up signal handlers + atexit
        signal.signal(signal.SIGINT, _sigint_handler)
        signal.signal(signal.SIGTERM, _sigint_handler)
        atexit.register(_run_cleanup)
    _cleanup_fns.append(fn)


def _wait_for_health(url: str, label: str, timeout: int = 120) -> None:
    """Poll a /healthz URL until it responds 200."""
    import time as _time
    import httpx

    deadline = _time.monotonic() + timeout
    while _time.monotonic() < deadline:
        try:
            resp = httpx.get(url, timeout=3)
            if resp.is_success:
                return
        except Exception:
            pass  # Retry on any connection/transport error
        _time.sleep(0.3)
    raise TimeoutError(f"{label} not healthy after {timeout}s: {url}")


LOCAL_PLC_PORT = 2582
MAIN_PDS_PORT = 2583
MAIN_CORE_PORT = 8100


def _start_main_stack(*, restart: bool = False) -> float:
    """Start the main docker-compose stack with fake PLC for testing.

    Brings up plc (fake PLC directory), pds, core, and brain from the
    main ``docker-compose.yml`` with ``DINA_PLC_URL`` pointed at the local
    fake PLC.  This allows E2E Suite 16 (AT Protocol PDS Integration)
    tests to run against real PDS + PLC containers.

    Pass ``restart=True`` to force teardown and rebuild even if the stack
    is already healthy.

    Returns startup time in seconds.
    """
    import shutil
    import tempfile
    import time as _time

    import httpx

    t0 = _time.monotonic()
    _provision_service_keys()
    client_token = _ensure_client_token()

    plc_url = f"http://localhost:{LOCAL_PLC_PORT}"
    pds_url = f"http://localhost:{MAIN_PDS_PORT}"
    core_url = f"http://localhost:{MAIN_CORE_PORT}"

    # Check if the main stack is already healthy (skip when restarting).
    all_healthy = not restart
    if all_healthy:
        for url, label in [
            (f"{plc_url}/healthz", "PLC"),
            (f"{pds_url}/xrpc/_health", "PDS"),
            (f"{core_url}/healthz", "Core"),
        ]:
            try:
                resp = httpx.get(url, timeout=2)
                if not resp.is_success:
                    all_healthy = False
                    break
            except Exception:
                all_healthy = False
                break

    if all_healthy:
        elapsed = _time.monotonic() - t0
        print(f"  Main stack already healthy (PLC+PDS+Core+Brain)",
              file=sys.stderr, flush=True)
        return elapsed

    if restart:
        print("  Tearing down existing main stack (--restart)...",
              file=sys.stderr, flush=True)

    print("  Starting main stack (fake PLC + PDS + Core + Brain)...",
          file=sys.stderr, flush=True)

    # Pre-flight: check required ports are free.  If another project
    # left a stale container bound to one of our ports, fail early
    # with a helpful message instead of a cryptic Docker error.
    import socket as _socket
    for _port, _label in [
        (LOCAL_PLC_PORT, "PLC"),
        (MAIN_PDS_PORT, "PDS"),
        (MAIN_CORE_PORT, "Core"),
    ]:
        with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as _s:
            if _s.connect_ex(("127.0.0.1", _port)) == 0:
                raise RuntimeError(
                    f"Port {_port} ({_label}) already in use. "
                    f"Run: docker ps | grep {_port}   to find the container, "
                    f"then stop it before retrying."
                )

    # Compose secrets need host files. Use an ephemeral temp dir so this script
    # does not mutate install-time identity seed artifacts under ./secrets.
    secret_tmp_dir = Path(tempfile.mkdtemp(prefix="dina-main-secrets-"))
    wrapped_seed_file = secret_tmp_dir / "wrapped_seed.bin"
    identity_salt_file = secret_tmp_dir / "master_seed.salt"
    seed_password_file = secret_tmp_dir / "seed_password"
    seed_password = _secrets.token_urlsafe(24)
    _provision_wrapped_seed(secret_tmp_dir, seed_password)
    seed_password_file.write_text(seed_password)
    for p in (wrapped_seed_file, identity_salt_file, seed_password_file):
        p.chmod(0o600)

    compose_env = {
        **os.environ,
        "DINA_PLC_URL": "http://plc:2582",
        "DINA_ENV": "test",
        "DINA_CLIENT_TOKEN": client_token,
        "DINA_SEED_PASSWORD": seed_password,
        # Ephemeral compose secret file paths.
        "DINA_WRAPPED_SEED_FILE": str(wrapped_seed_file),
        "DINA_IDENTITY_SALT_FILE": str(identity_salt_file),
        "DINA_SEED_PASSWORD_SECRET_FILE": str(seed_password_file),
    }
    compose_cmd = ["docker", "compose", "-p", "dina-main", "--profile", "test-plc"]

    # Register cleanup BEFORE starting so partially-created stacks are
    # always torn down — even if 'up --build' fails (e.g. port conflict).
    def _stop() -> None:
        print("\n  Stopping main stack...", file=sys.stderr, flush=True)
        subprocess.run(
            [*compose_cmd, "down", "-v"],
            capture_output=True,
            timeout=60,
            cwd=str(PROJECT_ROOT),
            env=compose_env,
        )
        shutil.rmtree(secret_tmp_dir, ignore_errors=True)
        print("  Main stack stopped.", file=sys.stderr)

    _register_cleanup(_stop)

    # Clean up stale containers, networks, AND volumes.
    # The fake PLC is in-memory so old PDS volumes would contain stale
    # accounts referencing DIDs the fresh PLC doesn't know about.
    subprocess.run(
        [*compose_cmd, "down", "-v"],
        capture_output=True, timeout=60, cwd=str(PROJECT_ROOT),
        env=compose_env,
    )
    # Also clean up the old default "dina" project — its containers
    # use fixed container_name directives that collide with any project.
    subprocess.run(
        ["docker", "compose", "down", "-v", "--remove-orphans"],
        capture_output=True, timeout=60, cwd=str(PROJECT_ROOT),
        env=compose_env,
    )

    up_cmd = [*compose_cmd, "up", "-d"]
    if os.environ.get("DINA_SKIP_DOCKER_BUILD") != "1":
        up_cmd = [*compose_cmd, "up", "--build", "-d"]
    result = subprocess.run(
        up_cmd,
        capture_output=True,
        timeout=300,
        text=True,
        cwd=str(PROJECT_ROOT),
        env=compose_env,
    )
    if result.returncode != 0:
        stderr_tail = (result.stderr or "").strip().split("\n")[-20:]
        raise RuntimeError(
            f"Main stack 'up' failed (exit {result.returncode}):\n"
            + "\n".join(stderr_tail)
        )

    # Wait for all services to become healthy (in parallel)
    from concurrent.futures import ThreadPoolExecutor, as_completed
    health_checks = [
        (f"{plc_url}/healthz", "Fake PLC", 30),
        (f"{pds_url}/xrpc/_health", "PDS", 60),
        (f"{core_url}/healthz", "Core", 60),
    ]
    with ThreadPoolExecutor(max_workers=len(health_checks)) as pool:
        futs = {
            pool.submit(_wait_for_health, url, label, t): label
            for url, label, t in health_checks
        }
        for fut in as_completed(futs):
            fut.result()  # raises TimeoutError on failure

    elapsed = _time.monotonic() - t0
    print(
        f"  Main stack ready: PLC:{LOCAL_PLC_PORT} PDS:{MAIN_PDS_PORT}"
        f" Core:{MAIN_CORE_PORT} ({_fmt_startup_time(elapsed)})",
        file=sys.stderr,
    )

    return elapsed


def _start_docker() -> float:
    """Start Docker test containers. Returns startup time in seconds."""
    import time as _time

    _ensure_client_token()
    _provision_service_keys()
    t0 = _time.monotonic()

    sys.path.insert(0, str(PROJECT_ROOT))
    from tests.integration.docker_services import DockerServices

    svc = DockerServices()
    print("  Starting Docker containers...", file=sys.stderr, flush=True)
    svc.start()
    elapsed = _time.monotonic() - t0
    print(
        f"  Core: {svc.core_url}  Brain: {svc.brain_url}"
        f"  ({_fmt_startup_time(elapsed)})",
        file=sys.stderr,
    )

    def _stop() -> None:
        print("\n  Stopping Docker containers...", file=sys.stderr, flush=True)
        svc.stop()
        print("  Docker containers stopped.", file=sys.stderr)

    _register_cleanup(_stop)
    return elapsed


def _start_local() -> float:
    """Start Go Core and Python Brain as local subprocesses.

    Returns startup time in seconds.
    """
    import tempfile
    import time as _time

    t0 = _time.monotonic()
    client_token = _ensure_client_token()
    vault_dir = tempfile.mkdtemp(prefix="dina-test-vault-")
    service_key_dir = tempfile.mkdtemp(prefix="dina-test-service-keys-")
    master_seed = _secrets.token_hex(32)
    _provision_service_keys(Path(service_key_dir), runtime_layout=True, seed_hex=master_seed)
    os.environ["DINA_INTEGRATION_SERVICE_KEY_DIR"] = service_key_dir

    core_url = f"http://localhost:{LOCAL_CORE_PORT}"
    brain_url = f"http://localhost:{LOCAL_BRAIN_PORT}"

    core_env = {
        **os.environ,
        "DINA_LISTEN_ADDR": f":{LOCAL_CORE_PORT}",
        "DINA_VAULT_PATH": vault_dir,
        "DINA_BRAIN_URL": brain_url,
        "DINA_MASTER_SEED": master_seed,
        "DINA_CLIENT_TOKEN": client_token,
        "DINA_SERVICE_KEY_DIR": service_key_dir,
        "DINA_TEST_MODE": "true",
        "DINA_ENV": "test",
        "DINA_RATE_LIMIT": "100000",
        "DINA_LOG_LEVEL": "debug",
        "DINA_PLC_URL": f"http://localhost:{LOCAL_PLC_PORT}",
    }

    brain_env = {
        **os.environ,
        "DINA_CORE_URL": core_url,
        "DINA_SERVICE_KEY_DIR": service_key_dir,
        "DINA_BRAIN_PORT": str(LOCAL_BRAIN_PORT),
        "DINA_LLM_URL": "http://localhost:9999",  # no LLM in test
        "DINA_LOG_LEVEL": "DEBUG",
        "DINA_CLOUD_LLM": "",
        "GOOGLE_API_KEY": "",
        "ANTHROPIC_API_KEY": "",
    }

    # Skip Go rebuild if binary exists and source hasn't changed.
    core_binary = PROJECT_ROOT / "core" / "dina-core"
    core_src_dir = PROJECT_ROOT / "core"
    need_build = True
    if core_binary.exists():
        binary_mtime = core_binary.stat().st_mtime
        # Check if any .go or go.mod/go.sum file is newer than the binary.
        need_build = False
        for pattern in ("**/*.go", "go.mod", "go.sum"):
            for src in core_src_dir.glob(pattern):
                if src.stat().st_mtime > binary_mtime:
                    need_build = True
                    break
            if need_build:
                break

    if need_build:
        print("  Building Go Core...", file=sys.stderr, flush=True)
        build_t0 = _time.monotonic()
        subprocess.run(
            ["go", "build", "-tags", "fts5", "-o", "dina-core", "./cmd/dina-core"],
            cwd=str(PROJECT_ROOT / "core"),
            capture_output=True,
            timeout=120,
            check=True,
        )
        build_time = _time.monotonic() - build_t0
        print(f"  Go Core built ({build_time:.1f}s)", file=sys.stderr, flush=True)
    else:
        build_time = 0.0
        print("  Go Core binary up-to-date (skipping build)", file=sys.stderr, flush=True)

    print("  Starting Go Core...", file=sys.stderr, flush=True)
    core_proc = subprocess.Popen(
        [str(PROJECT_ROOT / "core" / "dina-core")],
        cwd=str(PROJECT_ROOT / "core"),
        env=core_env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    print("  Starting Python Brain...", file=sys.stderr, flush=True)
    brain_proc = subprocess.Popen(
        [
            sys.executable, "-m", "uvicorn",
            "src.main:app",
            "--host", "0.0.0.0",
            "--port", str(LOCAL_BRAIN_PORT),
        ],
        cwd=str(PROJECT_ROOT / "brain"),
        env=brain_env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    def _stop() -> None:
        import shutil
        print("\n  Stopping local services...", file=sys.stderr, flush=True)
        for proc, name in [(brain_proc, "Brain"), (core_proc, "Core")]:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                print(f"    {name} stopped (pid {proc.pid})", file=sys.stderr)
        shutil.rmtree(vault_dir, ignore_errors=True)
        shutil.rmtree(service_key_dir, ignore_errors=True)
        os.environ.pop("DINA_INTEGRATION_SERVICE_KEY_DIR", None)
        # Keep compiled binary for cache — only rebuilt when source changes.
        print("  Local services stopped.", file=sys.stderr)

    _register_cleanup(_stop)

    # Wait for health (both in parallel)
    from concurrent.futures import ThreadPoolExecutor, as_completed as _as_completed
    try:
        print("  Waiting for Core + Brain health...", file=sys.stderr, flush=True)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futs = {
                pool.submit(_wait_for_health, f"{core_url}/healthz", "Core", 30): "Core",
                pool.submit(_wait_for_health, f"{brain_url}/healthz", "Brain", 60): "Brain",
            }
            for fut in _as_completed(futs):
                fut.result()
    except (TimeoutError, Exception):
        _run_cleanup()
        raise

    elapsed = _time.monotonic() - t0
    print(
        f"  Core: {core_url}  Brain: {brain_url}"
        f"  (startup: {_fmt_startup_time(elapsed)}, build: {build_time:.1f}s)",
        file=sys.stderr,
    )
    return elapsed

# ---------------------------------------------------------------------------
# Section map: parse TEST_PLAN.md ## headers
# ---------------------------------------------------------------------------

SECTION_HEADER_RE = re.compile(r"^##\s+(\d+)[\.\s]+(.+)")


def parse_section_headers(plan_path: Path) -> dict[int, str]:
    """Extract {major_section_number: section_name} from ## headers."""
    sections: dict[int, str] = {}
    for line in plan_path.read_text().splitlines():
        m = SECTION_HEADER_RE.match(line)
        if m:
            sections[int(m.group(1))] = m.group(2).strip()
    return sections


# ---------------------------------------------------------------------------
# Integration pre-scan: map function names → section numbers
#
# Integration tests do NOT encode section numbers in their function names.
# Each test has a `# TST-INT-NNN` comment immediately above it.  We map
# TST-INT IDs to sections via the manifest (integration_manifest.json) and
# the TEST_PLAN.md headers.  For IDs not in either source, we fall back to
# the most common section in that file.
# ---------------------------------------------------------------------------

_TST_INT_RE = re.compile(r"(TST-INT-\d+)")
_FUNC_DEF_RE = re.compile(r"^\s*def (test_\w+)")


def _build_tst_int_section_map(
    plan_path: Path,
    manifest_path: Path | None,
) -> dict[str, int]:
    """Build {TST-INT-NNN: major_section_number} from plan + manifest."""
    mapping: dict[str, int] = {}

    # From plan headers: track current ## section, map TST-INT IDs
    current_section: int | None = None
    for line in plan_path.read_text().splitlines():
        hm = re.match(r"^#{2,4}\s+(\d+)", line)
        if hm:
            current_section = int(hm.group(1))
        if current_section is not None:
            for tm in _TST_INT_RE.finditer(line):
                mapping[tm.group(1)] = current_section

    # Manifest overrides (more precise path info)
    if manifest_path and manifest_path.exists():
        data = json.loads(manifest_path.read_text())
        for tid, info in data.get("scenarios", {}).items():
            mapping[tid] = int(info["path"].split(".")[0])

    return mapping


def prescan_integration_sections(
    test_dir: Path,
    plan_path: Path,
    manifest_path: Path | None,
) -> dict[str, int]:
    """Return {function_name: major_section_number}.

    Uses TST-INT → section lookups, with per-file fallback for unknown IDs.
    """
    id_map = _build_tst_int_section_map(plan_path, manifest_path)
    mapping: dict[str, int] = {}

    for filepath in sorted(test_dir.glob("test_*.py")):
        lines = filepath.read_text().splitlines()

        # First pass: collect (func_name, tst_int_id) pairs
        pairs: list[tuple[str, str | None]] = []
        pending_id: str | None = None
        for line in lines:
            tm = _TST_INT_RE.search(line)
            if tm:
                pending_id = tm.group(1)
            fm = _FUNC_DEF_RE.match(line)
            if fm:
                pairs.append((fm.group(1), pending_id))
                pending_id = None

        # Determine file-level fallback: most common section among mapped tests
        mapped_sections = [
            id_map[tid] for _, tid in pairs if tid and tid in id_map
        ]
        fallback: int | None = None
        if mapped_sections:
            fallback = Counter(mapped_sections).most_common(1)[0][0]

        # Second pass: assign sections
        for func_name, tid in pairs:
            if tid and tid in id_map:
                mapping[func_name] = id_map[tid]
            elif fallback is not None:
                mapping[func_name] = fallback

    return mapping


# ---------------------------------------------------------------------------
# Brain pre-scan: map function names → section numbers
#
# Brain tests encode their TEST_PLAN section via `# TST-BRAIN-NNN` comments.
# Tests named `test_tst_brain_NNN_*` get NNN extracted as a section number
# by _PY_SECTION_RE, but NNN is the *test-case ID* (e.g. 514), not the
# *section number* (e.g. 17).  We build a TST-BRAIN-NNN → parent section
# mapping from TEST_PLAN.md and use it to override the extracted number.
# ---------------------------------------------------------------------------

_TST_BRAIN_RE = re.compile(r"(TST-BRAIN-\d+)")


def _build_tst_brain_section_map(plan_path: Path) -> dict[str, int]:
    """Build {TST-BRAIN-NNN: major_section_number} from plan headers."""
    mapping: dict[str, int] = {}
    current_section: int | None = None
    for line in plan_path.read_text().splitlines():
        hm = re.match(r"^#{2,4}\s+(\d+)", line)
        if hm:
            current_section = int(hm.group(1))
        if current_section is not None:
            for tm in _TST_BRAIN_RE.finditer(line):
                mapping[tm.group(1)] = current_section
    return mapping


_FUNC_DEF_ASYNC_RE = re.compile(r"^\s*(?:async\s+)?def (test_\w+)")

# File-level section fallback for brain test files that don't use
# TST-BRAIN-NNN comments.  Maps filename (without path) → section number.
_BRAIN_FILE_SECTION_FALLBACK: dict[str, int] = {
    "test_telegram.py": 6,      # MCP / Agent Delegation (connectors)
    "test_vault_context.py": 2,  # Guardian Loop (agentic vault reasoning)
    "test_tier_classifier.py": 14,  # Embedding Generation (tier classification)
    "test_admin_html.py": 8,    # Admin UI
    "test_pipeline_safety.py": 2,  # Guardian Loop (pipeline safety)
}


def prescan_brain_sections(
    test_dir: Path,
    plan_path: Path,
) -> dict[str, int]:
    """Return {function_name: major_section_number} for brain tests.

    Uses TST-BRAIN → section lookups from TEST_PLAN.md, with per-file
    fallback for tests whose ID is not in the plan.
    """
    id_map = _build_tst_brain_section_map(plan_path)
    mapping: dict[str, int] = {}

    for filepath in sorted(test_dir.glob("test_*.py")):
        lines = filepath.read_text().splitlines()

        # First pass: collect (func_name, tst_brain_id) pairs.
        # Brain tests use `async def` and `# TST-BRAIN-NNN` in xfail
        # reasons or standalone comments above the function.
        pairs: list[tuple[str, str | None]] = []
        pending_id: str | None = None
        for line in lines:
            tm = _TST_BRAIN_RE.search(line)
            if tm:
                pending_id = tm.group(1)
            fm = _FUNC_DEF_ASYNC_RE.match(line)
            if fm:
                pairs.append((fm.group(1), pending_id))
                pending_id = None

        # Determine file-level fallback: most common section among mapped
        # tests, or explicit filename → section fallback for files that
        # don't use TST-BRAIN comments at all.
        mapped_sections = [
            id_map[tid] for _, tid in pairs if tid and tid in id_map
        ]
        fallback: int | None = None
        if mapped_sections:
            fallback = Counter(mapped_sections).most_common(1)[0][0]
        if fallback is None:
            fallback = _BRAIN_FILE_SECTION_FALLBACK.get(filepath.name)

        # Second pass: assign sections
        for func_name, tid in pairs:
            if tid and tid in id_map:
                mapping[func_name] = id_map[tid]
            elif fallback is not None:
                mapping[func_name] = fallback

    return mapping


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class TestResult:
    name: str
    status: str  # PASS, SKIP, FAIL
    section: int  # major section number; 0 = unmapped
    duration: float = 0.0  # seconds
    output: str = ""  # captured logs/errors for this test


@dataclass
class SectionStats:
    number: int
    name: str
    total: int = 0
    passed: int = 0
    skipped: int = 0
    failed: int = 0
    xfail: int = 0
    duration: float = 0.0  # sum of test durations in seconds

    @property
    def status_label(self) -> str:
        if self.failed > 0:
            return "FAILED"
        if self.total == 0:
            return "Empty"
        if self.passed + self.skipped + self.xfail == self.total:
            if self.xfail > 0 and self.passed > 0:
                return "Partial"  # xfail tests still need work
            if self.passed == self.total:
                return "Complete"
        if self.passed > 0:
            return "Partial"
        return "Skip"


# ---------------------------------------------------------------------------
# Output parsers
# ---------------------------------------------------------------------------

# First number group after subject: TestAuth_1_... → 1
_GO_SECTION_RE = re.compile(r"^Test\w+?_(\d+)_")

# pytest verbose: "brain/tests/test_auth.py::test_auth_1_1_1_valid PASSED [0%]"
# also handles classes: "tests/...py::TestClass::test_func PASSED"
# also handles parametrize: "...::test_func[param-A desc] PASSED"
# Standard format:  file::test PASSED  [ N%]
# xdist format:     [gwN] [ N%] PASSED file::test
_PY_LINE_RE = re.compile(
    r"^([^\s:]+)::((?:\w+::)*test_\w+(?:\[.*?\])?)\s+(PASSED|SKIPPED|FAILED|ERROR|XFAIL|XPASS)"
)
_PY_XDIST_RE = re.compile(
    r"^\[gw\d+\]\s+\[\s*\d+%\]\s+(PASSED|SKIPPED|FAILED|ERROR|XFAIL|XPASS)\s+([^\s:]+)::((?:\w+::)*test_\w+(?:\[.*?\])?)"
)
# Short test summary lines: "FAILED file::Class::test_name - error message"
# Pytest prints these at the bottom when verbose output is interrupted by hooks.
_PY_SUMMARY_FAIL_RE = re.compile(
    r"^FAILED\s+([^\s:]+)::((?:\w+::)*test_\w+(?:\[.*?\])?)\s*-"
)
# First number group after subject: test_auth_1_... → 1
_PY_SECTION_RE = re.compile(r"^test_\w+?_(\d+)_")

_STATUS_MAP = {
    "PASSED": "PASS", "SKIPPED": "SKIP", "FAILED": "FAIL", "ERROR": "FAIL",
    "XFAIL": "XFAIL", "XPASS": "XPASS",
}
_GO_JSON_ACTION_MAP = {"pass": "PASS", "skip": "SKIP", "fail": "FAIL"}


def _extract_go_section(name: str) -> int:
    m = _GO_SECTION_RE.match(name)
    return int(m.group(1)) if m else 0


_PY_FILE_SECTION_RE = re.compile(r"test_0*(\d+)_\w+\.py")


def _extract_py_section(
    func_name: str,
    override: dict[str, int] | None,
    qualified: str = "",
) -> int:
    if override and func_name in override:
        return override[func_name]
    # Try filename first (e.g. test_01_purchase_journey.py → 1)
    # — more reliable than function name for user story / release tests
    if qualified:
        fm = _PY_FILE_SECTION_RE.search(qualified)
        if fm:
            return int(fm.group(1))
    # Fallback: extract from function name (e.g. test_rel_001_fresh → 1)
    m = _PY_SECTION_RE.match(func_name)
    if m:
        return int(m.group(1))
    return 0


def parse_go_json(output: str) -> list[TestResult]:
    """Parse ``go test -json`` output — one JSON object per line.

    Accumulates per-test ``output`` events so that failure context
    (t.Log, t.Errorf, etc.) is available on each TestResult.
    """
    results: list[TestResult] = []
    test_output: dict[str, list[str]] = {}
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        action = event.get("Action")
        name = event.get("Test")
        # Accumulate output events per test
        if action == "output" and name:
            test_output.setdefault(name, []).append(event.get("Output", ""))
            continue
        if not name or action not in _GO_JSON_ACTION_MAP:
            continue
        results.append(
            TestResult(
                name=name,
                status=_GO_JSON_ACTION_MAP[action],
                section=_extract_go_section(name),
                duration=float(event.get("Elapsed", 0)),
                output="".join(test_output.get(name, [])).rstrip(),
            )
        )
    return results


# pytest --durations line: "0.07s call  tests/integration/test_foo.py::Class::test_bar"
_PY_DURATION_RE = re.compile(
    r"^\s*([\d.]+)s\s+call\s+\S+::((?:\w+::)*test_\w+(?:\[.*?\])?)"
)


def parse_pytest_output(
    output: str,
    section_override: dict[str, int] | None = None,
) -> list[TestResult]:
    """Parse ``pytest -v`` output, including --durations timing.

    With ``--tb=short``, failure tracebacks appear between the result
    line (``FAILED``) and the next test result line.  We capture these
    and attach them to the corresponding ``TestResult.output``.
    """
    # Strip ANSI escape codes so regex parsing works even when
    # FORCE_COLOR=1 leaks into pytest subprocesses (e.g. via run_all_tests.sh).
    output = re.sub(r"\x1b\[[0-9;]*m", "", output)

    results: list[TestResult] = []
    # First pass: collect durations from --durations=0 section
    durations: dict[str, float] = {}
    for line in output.splitlines():
        dm = _PY_DURATION_RE.match(line)
        if dm:
            func_name = dm.group(2).split("::")[-1]
            durations[func_name] = float(dm.group(1))

    # Second pass: collect test results (standard + xdist output formats)
    seen: set[str] = set()
    for line in output.splitlines():
        m = _PY_LINE_RE.match(line)
        if m:
            qualified = m.group(1) + "::" + m.group(2)
            py_status = m.group(3)
        else:
            mx = _PY_XDIST_RE.match(line)
            if mx:
                py_status = mx.group(1)
                qualified = mx.group(2) + "::" + mx.group(3)
            else:
                # Catch FAILED lines from short test summary section.
                # When pytest hooks inject output between the test name and
                # the FAILED marker, the standard regex misses the failure.
                mf = _PY_SUMMARY_FAIL_RE.match(line)
                if mf:
                    qualified = mf.group(1) + "::" + mf.group(2)
                    py_status = "FAILED"
                else:
                    continue
        func_name = qualified.split("::")[-1]
        # Deduplicate: a test matched from verbose output shouldn't be
        # re-added from the short test summary section.
        if func_name in seen:
            continue
        seen.add(func_name)
        # Strip parametrize suffix for section lookup: test_foo[param] → test_foo
        base_name = func_name.split("[")[0]
        results.append(
            TestResult(
                name=func_name,
                status=_STATUS_MAP.get(py_status, "FAIL"),
                section=_extract_py_section(base_name, section_override, qualified),
                duration=durations.get(func_name, 0.0),
            )
        )

    # Third pass: capture per-test failure output from the FAILURES section.
    # With --tb=short, pytest prints all result lines first, then a separate
    # "= FAILURES =" section at the bottom with tracebacks delimited by
    # "_____ test_name _____" headers.
    result_by_name: dict[str, TestResult] = {r.name: r for r in results}
    lines = output.splitlines()

    # Regex for the underscored header: _____ test_name _____
    _FAILURE_HDR = re.compile(r"^_{3,}\s+(.+?)\s+_{3,}$")
    # Section boundaries that end a failure block
    _SECTION_END = re.compile(
        r"^=+\s*(short test summary|warnings summary|PASSES|slowest|\d+ (failed|passed))"
    )

    in_failures = False
    current_test: str | None = None
    capture_lines: list[str] = []

    for line in lines:
        # Detect start of FAILURES section
        if re.match(r"^=+\s+FAILURES\s+=+$", line):
            in_failures = True
            continue

        if not in_failures:
            continue

        # End of FAILURES section
        if _SECTION_END.match(line):
            # Flush last test
            if current_test and current_test in result_by_name:
                result_by_name[current_test].output = "\n".join(capture_lines).rstrip()
            break

        # New failure header: _____ test_name _____
        hdr = _FAILURE_HDR.match(line)
        if hdr:
            # Flush previous test
            if current_test and current_test in result_by_name:
                result_by_name[current_test].output = "\n".join(capture_lines).rstrip()
            # Extract test name (may be qualified: Class.test or file::class::test)
            raw_name = hdr.group(1).strip()
            # Split on :: first (file::class::test), then on . (Class.test)
            func_name = raw_name.split("::")[-1]
            func_name = func_name.split(".")[-1]
            current_test = func_name
            capture_lines = []
            continue

        # Accumulate lines for the current failure
        if current_test:
            capture_lines.append(line)

    # Flush if we never hit a section boundary
    if current_test and current_test in result_by_name:
        result_by_name[current_test].output = "\n".join(capture_lines).rstrip()

    return results


def parse_vitest_output(output: str) -> list[TestResult]:
    """Parse vitest verbose output.

    Lines like:
      ✓ tests/unit/01-foo.test.ts > §1.1 Section > UT-FOO-001: test name 1ms
      × tests/unit/01-foo.test.ts > §1.1 Section > UT-FOO-002: test name 2ms
    """
    import re
    results: list[TestResult] = []
    # Match: ✓ or × followed by file > section > test name [duration]
    pat = re.compile(
        r"^\s*([✓×↓])\s+(.+?)\s+(\d+m?s)?\s*$"
    )
    section_pat = re.compile(r"§(\d+)")

    for line in output.splitlines():
        m = pat.match(line)
        if not m:
            continue
        symbol, name, dur_str = m.group(1), m.group(2), m.group(3)

        if symbol == "✓":
            status = "PASS"
        elif symbol == "×":
            status = "FAIL"
        elif symbol == "↓":
            status = "SKIP"
        else:
            continue

        # Extract section number: §N.M or SSN.M or from filename NN-name.test.ts
        sec = 0
        sec_m = section_pat.search(name)
        if sec_m:
            sec = int(sec_m.group(1))
        else:
            # Fallback: extract from filename like tests/unit/05-api-cache.test.ts
            file_m = re.search(r'/(\d{2})-', name)
            if file_m:
                sec = int(file_m.group(1))

        # Parse duration
        duration = 0.0
        if dur_str:
            if dur_str.endswith("ms"):
                duration = float(dur_str[:-2]) / 1000.0
            elif dur_str.endswith("s"):
                duration = float(dur_str[:-1])

        results.append(TestResult(
            name=name.strip(),
            status=status,
            section=sec,
            duration=duration,
        ))

    return results


# ---------------------------------------------------------------------------
# Suite configuration & runner
# ---------------------------------------------------------------------------

SUITES = {
    "core": {
        "name": "Core (Go)",
        "cmd": ["go", "test", "-json", "-count=1", "./test/..."],
        "cwd": "core",
        "plan": "core/test/TEST_PLAN.md",
        "parser": "go",
    },
    "brain": {
        "name": "Brain (Py)",
        "cmd": ["python", "-m", "pytest", "-v", "--tb=short", "--durations=0", "-vv",
                "brain/tests/"],
        "cwd": None,
        "plan": "brain/tests/TEST_PLAN.md",
        "parser": "pytest",
        "test_dir": "brain/tests",
    },
    "integration": {
        "name": "Integration",
        "cmd": ["python", "-m", "pytest", "-v", "--tb=short", "--durations=0", "-vv",
                "tests/integration/"],
        "cwd": None,
        "plan": "tests/INTEGRATION_TEST_PLAN.md",
        "parser": "pytest",
        "test_dir": "tests/integration",
        "manifest": "tests/integration_manifest.json",
        # When DINA_INTEGRATION=docker, tests hit real services — PASS is real.
        # Otherwise tests use mocks — treat PASS as SKIP.
        "mock_pass_is_skip": os.environ.get("DINA_INTEGRATION") != "docker",
    },
    "e2e": {
        "name": "E2E (Docker)",
        "cmd": ["python", "-m", "pytest", "-v", "--tb=short", "--durations=0", "-vv",
                "tests/e2e/"],
        "cwd": None,
        "parser": "pytest",
        "test_dir": "tests/e2e",
        # Section map embedded — no TEST_PLAN.md needed (filenames encode suite#)
        "e2e_sections": True,
    },
    "cli": {
        "name": "CLI (Py)",
        "cmd": ["python", "-m", "pytest", "-v", "--tb=short", "--durations=0", "-vv",
                "cli/tests/"],
        "cwd": None,
        "parser": "pytest",
        "flat": True,
    },
    "admin_cli": {
        "name": "Admin CLI (Py)",
        "cmd": ["python", "-m", "pytest", "-v", "--tb=short", "--durations=0", "-vv",
                "admin-cli/tests/"],
        "cwd": None,
        "parser": "pytest",
        "flat": True,  # no section breakdown — all tests in one group
    },
    "appview": {
        "name": "AppView (TS)",
        "cmd": ["npx", "vitest", "run", "tests/unit/", "--reporter=verbose"],
        "cwd": "appview",
        "parser": "vitest",
        "section_names": {
            1: "Scorer Algorithms",
            2: "Ingester Components",
            3: "Shared Utilities",
            4: "Configuration",
            5: "API Cache (SWR)",
            6: "Jetstream Consumer",
            7: "Scorer Jobs",
            8: "xRPC Params",
        },
    },
    "release": {
        "name": "Release",
        "cmd": ["python", "-m", "pytest", "-v", "--tb=short", "--durations=0", "-vv",
                "tests/release/"],
        "cwd": None,
        "parser": "pytest",
        "test_dir": "tests/release",
        "section_names": {
            1: "Fresh Machine Install",
            2: "First Conversation",
            3: "Vault Persistence Across Restart",
            4: "Locked-State and Seal Verification",
            5: "Recovery Phrase & Disaster Recovery",
            6: "Two Dinas Talk to Each Other",
            7: "PDS and Trust Network E2E",
            8: "Agent Gateway (Real/Rogue Client)",
            9: "Persona Wall and PII Leakage",
            10: "Hostile-Network D2D & Sancho Moment",
            11: "Failure Handling & Degraded Operation",
            12: "README & Public Claims Check",
            15: "Install Re-Run (Idempotent)",
            16: "Upgrade Verification",
            17: "Admin Access Lifecycle",
            18: "Connector Outage & Re-Auth",
            19: "Silence Protocol & Daily Briefing",
            20: "Draft-Don't-Send & Cart Handover",
            21: "Export / Import Portability",
            22: "External Exposure Audit",
            23: "CLI Agent Integration & Pairing",
            24: "Recommendation Integrity",
            25: "Anti-Her & Staging Pipeline",
            26: "Silence Stress",
            27: "Action Integrity",
            28: "Install Lifecycle",
        },
    },
    "user_stories": {
        "name": "User Stories",
        "cmd": ["python", "-m", "pytest", "-v", "--tb=short", "--durations=0", "-vv",
                "tests/system/user_stories/"],
        "cwd": None,
        "parser": "pytest",
        "test_dir": "tests/system/user_stories",
        "section_names": {
            1: "The Purchase Journey",
            2: "The Sancho Moment",
            3: "The Dead Internet Filter",
            4: "The Persona Wall",
            5: "The Agent Gateway",
            6: "License Renewal",
            7: "Daily Briefing",
            8: "Move to New Machine",
            9: "Connector Expiry",
            10: "Operator Journey",
            11: "Anti-Her",
            12: "Verified Truth",
            13: "Silence Stress",
            14: "Agent Sandbox",
        },
    },
    "install": {
        "name": "Install",
        "cmd": ["python", "-m", "pytest", "-v", "--tb=short", "--durations=0", "-vv",
                "tests/install/test_installer_core.py",
                "tests/install/test_installer_wizard.py",
                "tests/install/test_model_set.py",
                "tests/install/test_post_install.py"],
        "cwd": None,
        "parser": "pytest",
        "test_dir": "tests/install",
    },
    "appview_integration": {
        "name": "AppView Integration (TS)",
        "cmd": ["npx", "vitest", "run", "tests/integration/", "--reporter=verbose"],
        "cwd": "appview",
        "parser": "vitest",
        "section_names": {
            1: "Ingester Handlers",
            2: "Deletion & Tombstones",
            3: "Trust Edge Sync",
            4: "Subject Resolution",
            5: "Idempotency",
            6: "Backpressure & Watermark",
            7: "Rate Limiter",
            8: "Graph Queries",
            9: "Scorer Jobs",
            10: "API Endpoints",
            11: "Database Schema",
            12: "Dirty Flags",
            13: "Cursor Management",
            14: "Backfill Script",
            15: "Label Service",
            16: "Docker Integration",
            17: "End-to-End Flows",
            18: "Web Server",
        },
    },
    "install-pexpect": {
        "name": "Install Lifecycle (pexpect)",
        "cmd": ["python", "-m", "pytest", "-v", "--tb=short", "--durations=0", "-vv",
                "tests/install/test_install_blackbox.py",
                "tests/install/test_install_failures.py",
                "tests/install/test_install_functional.py",
                "tests/install/test_startup_modes.py"],
        "cwd": None,
        "parser": "pytest",
        "test_dir": "tests/install",
        "timeout": 900,  # install.sh does docker build + up — needs more time
        "flat": True,
    },
}


# ---------------------------------------------------------------------------
# E2E section map (from test_suite_NN_name.py filenames)
# ---------------------------------------------------------------------------

_E2E_SECTION_MAP: dict[int, str] = {
    1: "Onboarding & First Run",
    2: "Sancho Moment (Arrival Flow)",
    3: "Product Research & Purchase",
    4: "Memory & Recall",
    5: "Ingestion Pipeline",
    6: "Agent Safety & Delegation",
    7: "Privacy & PII",
    8: "Sensitive Personas",
    9: "Digital Estate",
    10: "Resilience & Recovery",
    11: "Multi-Device Sync",
    12: "Trust Network",
    13: "Security & Adversarial",
    14: "Agentic LLM Behavior",
    15: "CLI Ed25519 Request Signing",
    16: "AT Protocol PDS Integration",
    17: "The Quiet Dina (Silence Protocol)",
    18: "Move to a New Machine",
    19: "Connector Failure & Recovery",
    20: "Operator & Upgrade Journeys",
    21: "Anti-Her (Thesis Invariant)",
    22: "Verified Truth (Thesis Invariant)",
    23: "Silence Stress (Thesis Invariant)",
    24: "Agent Sandbox (Thesis Invariant)",
}

_E2E_FILE_SECTION_RE = re.compile(r"test_suite_(\d+)_")


def prescan_e2e_sections(test_dir: Path) -> dict[str, int]:
    """Map E2E test function names to section numbers from filenames.

    E2E test files encode suite number: test_suite_01_onboarding.py → section 1.
    All test functions in that file are assigned the same section number.
    """
    mapping: dict[str, int] = {}
    for filepath in sorted(test_dir.glob("test_suite_*.py")):
        fm = _E2E_FILE_SECTION_RE.search(filepath.name)
        if not fm:
            continue
        section = int(fm.group(1))
        for line in filepath.read_text().splitlines():
            func_m = _FUNC_DEF_RE.match(line)
            if func_m:
                mapping[func_m.group(1)] = section
    return mapping


# ---------------------------------------------------------------------------
# E2E Docker lifecycle (docker-compose-e2e.yml — 4 Core+Brain pairs)
# ---------------------------------------------------------------------------


def _load_dotenv() -> dict[str, str]:
    """Load .env file and return as dict. Does NOT modify os.environ."""
    env_file = PROJECT_ROOT / ".env"
    extra: dict[str, str] = {}
    if not env_file.exists():
        return extra
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, val = line.partition("=")
            extra[key.strip()] = val.strip()
    return extra


def _start_e2e_docker(*, restart: bool = False) -> float:
    """Start 4-node E2E Docker stack. Returns startup time in seconds.

    If all 4 Brain containers are already healthy, skips rebuild to avoid
    disrupting a running stack.  Pass ``restart=True`` to force teardown
    and rebuild.
    """
    import time as _time

    import httpx

    _ensure_client_token()
    t0 = _time.monotonic()

    # Load .env for API keys (GOOGLE_API_KEY, OPENROUTER_API_KEY, etc.)
    dotenv = _load_dotenv()
    for key in ("GOOGLE_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_MODEL",
                "ANTHROPIC_API_KEY", "DINA_CLOUD_LLM"):
        if key in dotenv and key not in os.environ:
            os.environ[key] = dotenv[key]

    compose_file = str(PROJECT_ROOT / "docker-compose-e2e.yml")
    e2e_project = "dina-e2e"

    actors = {
        "alonso": 19200, "sancho": 19201,
        "chairmaker": 19202, "albert": 19203,
    }

    # Tear down first if --restart requested
    if restart:
        print("  Tearing down existing E2E stack (--restart)...", file=sys.stderr,
              flush=True)
        subprocess.run(
            ["docker", "compose", "-p", e2e_project, "-f", compose_file, "down", "-v"],
            capture_output=True,
            timeout=60,
        )

    # Check if all containers are already healthy
    all_healthy = not restart  # skip check when restarting
    if all_healthy:
        for actor, port in actors.items():
            try:
                resp = httpx.get(f"http://localhost:{port}/healthz", timeout=3)
                if not resp.is_success:
                    all_healthy = False
                    break
            except Exception:
                all_healthy = False
                break

    we_started = False
    if all_healthy:
        # Never reuse stale containers — tear down and rebuild with current code.
        print("  E2E Docker stack found — tearing down for fresh rebuild...",
              file=sys.stderr, flush=True)
        subprocess.run(
            ["docker", "compose", "-p", e2e_project, "-f", compose_file, "down", "-v"],
            capture_output=True, timeout=60,
        )
        all_healthy = False

    if not all_healthy:
        we_started = True
        print("  Starting E2E Docker stack (4 actors)...", file=sys.stderr,
              flush=True)
        # Bust Docker layer cache so current source is always used.
        for src_dir in [PROJECT_ROOT / "brain" / "src", PROJECT_ROOT / "core" / "cmd"]:
            sentinel = src_dir / ".build-sentinel"
            sentinel.write_text(f"{_time.time()}\n")
        e2e_up = ["docker", "compose", "-p", e2e_project, "-f", compose_file, "up", "-d"]
        if os.environ.get("DINA_SKIP_DOCKER_BUILD") != "1":
            e2e_up = ["docker", "compose", "-p", e2e_project, "-f", compose_file, "up", "--build", "-d"]
        result = subprocess.run(
            e2e_up,
            capture_output=True,
            timeout=300,
            text=True,
        )
        if result.returncode != 0:
            # Print the actual Docker error for diagnosis
            stderr_tail = (result.stderr or "").strip().split("\n")[-20:]
            raise RuntimeError(
                f"docker compose up failed (exit {result.returncode}):\n"
                + "\n".join(stderr_tail)
            )

        # Wait for all containers to become healthy (in parallel)
        from concurrent.futures import ThreadPoolExecutor as _TPE
        from concurrent.futures import as_completed as _asc
        with _TPE(max_workers=len(actors)) as pool:
            futs = {
                pool.submit(
                    _wait_for_health,
                    f"http://localhost:{port}/healthz",
                    f"brain-{actor}",
                    180,
                ): actor
                for actor, port in actors.items()
            }
            for fut in _asc(futs):
                fut.result()

    elapsed = _time.monotonic() - t0
    print(
        f"  E2E stack healthy: 4 actors × (Core+Brain)"
        f"  ({_fmt_startup_time(elapsed)})",
        file=sys.stderr,
    )

    # Set env so E2E tests detect Docker mode
    os.environ["DINA_E2E"] = "docker"

    # Only tear down if we started the stack (don't kill pre-existing containers)
    if we_started:
        def _stop() -> None:
            print("\n  Stopping E2E Docker stack...", file=sys.stderr, flush=True)
            subprocess.run(
                ["docker", "compose", "-p", e2e_project, "-f", compose_file, "down", "-v"],
                capture_output=True,
                timeout=60,
            )
            print("  E2E Docker stack stopped.", file=sys.stderr)

        _register_cleanup(_stop)

    return elapsed


def run_suite(
    key: str, *, quick: bool = True,
) -> tuple[list[TestResult], dict[int, str], float, str]:
    """Run a test suite via subprocess and return parsed results, section map,
    wall-clock elapsed time in seconds, and raw output string.

    When *quick* is True (default), pytest suites add ``-m 'not slow'``
    to skip heavy tests (100K scale, real LLM calls), and Go suites
    add ``-short`` to skip tests guarded by ``testing.Short()``.
    """
    import time as _time

    cfg = SUITES[key]

    # E2E suites: section map from filenames, not TEST_PLAN.md
    section_override: dict[str, int] | None = None
    if cfg.get("e2e_sections"):
        section_map = dict(_E2E_SECTION_MAP)
        section_override = prescan_e2e_sections(PROJECT_ROOT / cfg["test_dir"])
    elif "plan" in cfg:
        plan_path = PROJECT_ROOT / cfg["plan"]
        section_map = parse_section_headers(plan_path)
        if "test_dir" in cfg and "manifest" in cfg:
            # Integration suite: uses TST-INT IDs + manifest
            manifest_path = PROJECT_ROOT / cfg["manifest"]
            section_override = prescan_integration_sections(
                PROJECT_ROOT / cfg["test_dir"],
                plan_path,
                manifest_path,
            )
        elif "test_dir" in cfg:
            # Brain suite (or any suite with test_dir + plan, no manifest):
            # uses TST-BRAIN IDs from plan headers
            section_override = prescan_brain_sections(
                PROJECT_ROOT / cfg["test_dir"],
                plan_path,
            )
    elif "section_names" in cfg:
        # Inline section names (e.g. AppView)
        section_map = dict(cfg["section_names"])
    else:
        # Flat suite (e.g. CLI) — no section plan, all tests grouped as one
        section_map = {1: cfg["name"]}
        section_override = None

    cwd = (PROJECT_ROOT / cfg["cwd"]) if cfg["cwd"] else PROJECT_ROOT

    # Build command — skip slow tests in quick mode
    cmd = list(cfg["cmd"])
    if quick and cfg["parser"] == "pytest":
        cmd.extend(["-m", "not slow"])
    elif quick and cfg["parser"] == "go":
        cmd.append("-short")

    # Parallel test execution with pytest-xdist for I/O-bound Docker tests.
    # Only beneficial for integration tests hitting real Docker containers.
    # Brain tests use in-process TestClient — xdist overhead always hurts.
    # Local mode sets DINA_INTEGRATION=docker too, but tests are fast there
    # because services are on localhost — xdist worker spawn cost dominates.
    # DINA_DOCKER_SERVICES=1 is set only when service_mode=="docker".
    if cfg["parser"] == "pytest":
        xdist_beneficial = (
            key == "integration"
            and os.environ.get("DINA_DOCKER_SERVICES") == "1"
        )
        if xdist_beneficial:
            try:
                import xdist  # noqa: F401
                cmd.extend(["-n", "auto", "--dist", "loadscope"])
            except ImportError:
                pass  # pytest-xdist not installed, run sequentially

    timeout = cfg.get("timeout", 600 if cfg.get("e2e_sections") else 300)

    t0 = _time.monotonic()
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(cwd),
            timeout=timeout,
        )
        output = result.stdout + "\n" + result.stderr
    except subprocess.TimeoutExpired:
        print(f"WARNING: {cfg['name']} timed out after {timeout}s", file=sys.stderr)
        return [], section_map, _time.monotonic() - t0, ""
    except FileNotFoundError as exc:
        print(f"WARNING: {cfg['name']}: {exc}", file=sys.stderr)
        return [], section_map, _time.monotonic() - t0, ""
    elapsed = _time.monotonic() - t0

    if cfg["parser"] == "go":
        tests = parse_go_json(output)
    elif cfg["parser"] == "vitest":
        tests = parse_vitest_output(output)
    else:
        tests = parse_pytest_output(output, section_override)

    # If subprocess exited non-zero, the suite is not green regardless
    # of how many individual test results were parsed.  Two cases:
    #
    # 1. No tests parsed → runner itself failed (import/collection error).
    #    Surface a synthetic failure.
    # 2. Some tests parsed → partial run (e.g. pytest crashed mid-suite,
    #    or XPASS with strict=True, or fixture teardown error).  Append
    #    a synthetic failure so aggregated counts never show 100% pass
    #    when the runner signalled failure.
    if result.returncode != 0:
        has_any_failure = any(
            t.status in ("FAIL", "ERROR", "XPASS") for t in tests
        )
        if not tests:
            tests = [TestResult(
                name="<suite_execution_failed>",
                status="FAIL",
                section=0,
                output=output[-2000:] if output else "(no output)",
            )]
            print(
                f"  WARNING: {cfg['name']} exited with code {result.returncode} "
                f"but produced no parseable test results",
                file=sys.stderr,
            )
        elif not has_any_failure:
            # Tests were parsed but none were marked as failures, yet
            # pytest returned non-zero.  Inject a sentinel so the
            # dashboard reflects the runner's actual exit status.
            tests.append(TestResult(
                name="<runner_exit_nonzero>",
                status="FAIL",
                section=0,
                output=(
                    f"pytest exited with code {result.returncode} but all "
                    f"{len(tests)} parsed tests appeared to pass. "
                    f"Possible cause: collection error, fixture teardown "
                    f"failure, or plugin error after test execution."
                ),
            ))
            print(
                f"  WARNING: {cfg['name']} exited with code {result.returncode} "
                f"despite {len(tests) - 1} parsed tests appearing to pass",
                file=sys.stderr,
            )

    # Flat suites: force ALL tests to section 1 (no per-section breakdown)
    if cfg.get("flat") or ("plan" not in cfg and not cfg.get("e2e_sections") and "section_names" not in cfg):
        for t in tests:
            t.section = 1

    # Mock-based suites: PASS doesn't mean implemented — remap to SKIP
    if cfg.get("mock_pass_is_skip"):
        for t in tests:
            if t.status == "PASS":
                t.status = "SKIP"

    return tests, section_map, elapsed, output


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def aggregate(
    tests: list[TestResult],
    section_map: dict[int, str],
) -> list[SectionStats]:
    """Group results by major section, return sorted stats list."""
    stats: dict[int, SectionStats] = {}
    for num, name in section_map.items():
        stats[num] = SectionStats(number=num, name=name)

    unmapped = 0
    for t in tests:
        if t.section == 0:
            unmapped += 1
            continue
        if t.section not in stats:
            stats[t.section] = SectionStats(
                number=t.section, name=f"Section {t.section}"
            )
        s = stats[t.section]
        s.total += 1
        s.duration += t.duration
        if t.status == "PASS":
            s.passed += 1
        elif t.status == "SKIP":
            s.skipped += 1
        elif t.status == "XFAIL":
            s.xfail += 1
        elif t.status == "XPASS":
            # Strict xfail unexpectedly passing IS a failure — it means
            # the xfail marker is stale and the suite should not be green.
            s.failed += 1
        else:
            s.failed += 1

    # Suppress unmapped noise — these are tests in packages outside the
    # TEST_PLAN.md section structure (e.g. handler/, service/ unit tests).
    # They still run and are counted in TOTAL.

    return sorted(stats.values(), key=lambda x: x.number)


# ---------------------------------------------------------------------------
# ANSI colors
# ---------------------------------------------------------------------------


def _use_color(no_color_flag: bool) -> bool:
    if no_color_flag or os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty() or os.environ.get("FORCE_COLOR") == "1"


class Colors:
    def __init__(self, enabled: bool):
        self._on = enabled

    def _w(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self._on else text

    def green(self, t: str) -> str:
        return self._w("32", t)

    def yellow(self, t: str) -> str:
        return self._w("33", t)

    def red(self, t: str) -> str:
        return self._w("1;31", t)

    def dim(self, t: str) -> str:
        return self._w("2", t)

    def bold(self, t: str) -> str:
        return self._w("1", t)

    def status(self, label: str) -> str:
        fn = {
            "Complete": self.green,
            "Partial": self.yellow,
            "Skip": self.dim,
            "FAILED": self.red,
        }.get(label)
        return fn(label) if fn else label


# ---------------------------------------------------------------------------
# ASCII table renderer
# ---------------------------------------------------------------------------

_SEP = "\u2500"  # ─


def _fmt_startup_time(seconds: float) -> str:
    """Format startup/build time as compact string."""
    if seconds < 1.0:
        return f"{seconds * 1000:.0f}ms"
    if seconds < 60.0:
        return f"{seconds:.1f}s"
    minutes = int(seconds // 60)
    secs = seconds % 60
    return f"{minutes}m{secs:.0f}s"


def _fmt_duration(seconds: float) -> str:
    """Format duration as human-readable string."""
    if seconds < 0.01:
        return "  <10ms"
    if seconds < 1.0:
        return f"{seconds * 1000:>5.0f}ms"
    if seconds < 60.0:
        return f"{seconds:>5.1f}s "
    minutes = int(seconds // 60)
    secs = seconds % 60
    return f"{minutes:>2}m{secs:04.1f}s"


def _group_tests_by_section(tests: list[TestResult]) -> dict[int, list[TestResult]]:
    """Group tests by section number for verbose display."""
    groups: dict[int, list[TestResult]] = {}
    for t in tests:
        groups.setdefault(t.section, []).append(t)
    return groups


def _write_structured_log(
    log_path: Path,
    suite_name: str,
    tests: list[TestResult],
    sections: list[SectionStats],
) -> None:
    """Write a structured log file with tests grouped by section.

    Each test shows its status, duration, and all captured output
    (logs, errors, stack traces) grouped directly underneath.
    """
    lines: list[str] = []
    lines.append(f"{'=' * 80}")
    lines.append(f"  {suite_name} — Structured Test Log")
    lines.append(f"{'=' * 80}")
    lines.append("")

    by_section = _group_tests_by_section(tests) if tests else {}

    # Summary counts
    total = sum(s.total for s in sections)
    passed = sum(s.passed for s in sections)
    failed = sum(s.failed for s in sections)
    skipped = sum(s.skipped for s in sections)
    xfailed = sum(s.xfail for s in sections)
    xf_str = f"  |  XFail: {xfailed}" if xfailed else ""
    lines.append(f"  Total: {total}  |  Passed: {passed}  |  Failed: {failed}  |  Skipped: {skipped}{xf_str}")
    lines.append("")

    # List failures upfront for quick reference
    failed_tests = [t for t in tests if t.status == "FAIL"] if tests else []
    if failed_tests:
        lines.append(f"  FAILURES ({len(failed_tests)}):")
        for t in sorted(failed_tests, key=lambda x: (x.section, x.name)):
            sec_name = ""
            for s in sections:
                if s.number == t.section:
                    sec_name = s.name
                    break
            lines.append(f"    - [{sec_name or f'§{t.section}'}] {t.name}")
        lines.append("")

    lines.append(f"{'=' * 80}")
    lines.append("")

    # Per-section, per-test details
    for s in sorted(sections, key=lambda x: x.number):
        sec_tests = by_section.get(s.number, [])
        if not sec_tests:
            continue

        lines.append(f"{'─' * 80}")
        lines.append(f"  § {s.number}  {s.name}")
        xf_str = f"  |  XFail: {s.xfail}" if s.xfail else ""
        lines.append(f"  Tests: {s.total}  |  Pass: {s.passed}  |  Fail: {s.failed}  |  Skip: {s.skipped}{xf_str}")
        lines.append(f"{'─' * 80}")

        for t in sorted(sec_tests, key=lambda x: x.name):
            status_tag = f"[{t.status}]"
            dur = f"  ({t.duration:.3f}s)" if t.duration > 0 else ""
            lines.append(f"  {status_tag:<6} {t.name}{dur}")

            if t.output:
                # Indent all captured output under the test name
                for out_line in t.output.splitlines():
                    lines.append(f"         {out_line}")
                lines.append("")  # blank line after output block

        lines.append("")

    lines.append(f"{'=' * 80}")
    lines.append(f"  End of {suite_name} structured log")
    lines.append(f"{'=' * 80}")
    lines.append("")

    log_path.write_text("\n".join(lines))


def render_suite(
    name: str,
    sections: list[SectionStats],
    c: Colors,
    wall_time: float = 0.0,
    tests: list[TestResult] | None = None,
    verbose: bool = False,
) -> None:
    """Print one suite's per-section table.

    When *verbose* is True and *tests* is provided, individual test names
    are printed under each section row.
    """
    header = f"=== {name} ==="
    if wall_time > 0:
        header += f"  ({_fmt_duration(wall_time).strip()})"
    print(f"\n{c.bold(header)}")
    any_xfail = any(s.xfail > 0 for s in sections)
    xf_hdr = " | XFail" if any_xfail else ""
    xf_sep = f"\u253c{_SEP * 6}" if any_xfail else ""
    print(
        f" {'§':>3} | {'Section':<40} | {'Total':>5}"
        f" | {'Pass':>4} | {'Skip':>4} | {'Fail':>4}"
        f"{xf_hdr}"
        f" | {'Time':>7} | Status"
    )
    rule = (
        f"{_SEP * 5}\u253c{_SEP * 42}\u253c{_SEP * 7}"
        f"\u253c{_SEP * 6}\u253c{_SEP * 6}\u253c{_SEP * 6}"
        f"{xf_sep}"
        f"\u253c{_SEP * 9}\u253c{_SEP * 10}"
    )
    print(rule)

    by_section = _group_tests_by_section(tests) if verbose and tests else {}

    tot = pas = ski = fai = xfa = 0
    tot_dur = 0.0
    for s in sections:
        if s.total == 0:
            continue
        tot += s.total
        pas += s.passed
        ski += s.skipped
        fai += s.failed
        xfa += s.xfail
        tot_dur += s.duration
        xf_col = f" | {s.xfail:>4}" if any_xfail else ""
        print(
            f" {s.number:>3} | {s.name[:40]:<40} | {s.total:>5}"
            f" | {s.passed:>4} | {s.skipped:>4} | {s.failed:>4}"
            f"{xf_col}"
            f" | {_fmt_duration(s.duration)} | {c.status(s.status_label)}"
        )

        # Verbose: print individual tests under this section
        if verbose and s.number in by_section:
            for t in sorted(by_section[s.number], key=lambda x: x.name):
                status_str = {
                    "PASS": c.green("PASS"),
                    "SKIP": c.dim("SKIP"),
                    "FAIL": c.red("FAIL"),
                    "XFAIL": c.yellow("XFAL"),
                    "XPASS": c.yellow("XPAS"),
                }.get(t.status, t.status)
                dur_str = _fmt_duration(t.duration) if t.duration > 0 else ""
                print(f"     |   {status_str} {t.name[:70]:<70} {dur_str}")

    print(rule)
    xf_tot = f" | {xfa:>4}" if any_xfail else ""
    print(
        f" {'':>3} | {'TOTAL':<40} | {tot:>5}"
        f" | {pas:>4} | {ski:>4} | {fai:>4}"
        f"{xf_tot}"
        f" | {_fmt_duration(tot_dur)} |"
    )


def render_grand_summary(
    rows: list[tuple[str, int, int, int, int, int, float]],
    c: Colors,
) -> None:
    """Print the grand summary across all suites."""
    any_xfail = any(xf > 0 for _, _, _, _, _, xf, _ in rows)
    xf_hdr = " | XFail" if any_xfail else ""
    xf_sep = f"\u253c{_SEP * 6}" if any_xfail else ""
    print(f"\n{c.bold('=== Grand Summary ===')}")
    print(
        f" {'Suite':<14} | {'Total':>5}"
        f" | {'Pass':>4} | {'Skip':>4} | {'Fail':>4}"
        f"{xf_hdr}"
        f" | {'Time':>7} | Progress"
    )
    rule = (
        f"{_SEP * 16}\u253c{_SEP * 7}"
        f"\u253c{_SEP * 6}\u253c{_SEP * 6}\u253c{_SEP * 6}"
        f"{xf_sep}"
        f"\u253c{_SEP * 9}\u253c{_SEP * 10}"
    )
    print(rule)

    gt = gp = gs = gf = gx = 0
    g_time = 0.0
    for name, t, p, s, f, xf, dur in rows:
        gt += t
        gp += p
        gs += s
        gf += f
        gx += xf
        g_time += dur
        pct = (p / t * 100) if t else 0
        xf_col = f" | {xf:>4}" if any_xfail else ""
        print(
            f" {name:<14} | {t:>5}"
            f" | {p:>4} | {s:>4} | {f:>4}"
            f"{xf_col}"
            f" | {_fmt_duration(dur)} | {pct:>5.1f}%"
        )

    print(rule)
    gpct = (gp / gt * 100) if gt else 0
    xf_tot = f" | {gx:>4}" if any_xfail else ""
    print(
        f" {'TOTAL':<14} | {gt:>5}"
        f" | {gp:>4} | {gs:>4} | {gf:>4}"
        f"{xf_tot}"
        f" | {_fmt_duration(g_time)} | {gpct:>5.1f}%"
    )


# ---------------------------------------------------------------------------
# JSON output
# ---------------------------------------------------------------------------


def output_json(data: dict) -> None:
    """Print machine-readable JSON to stdout."""
    json.dump(data, sys.stdout, indent=2)
    print()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str]) -> dict:
    """Parse CLI flags into a dict.

    Keys: suite, json, no_color, all_mode, verbose.
    """
    opts: dict = {
        "suite": None,
        "json": False,
        "json_file": None,
        "no_color": False,
        "all_mode": False,
        "verbose": False,
    }
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--json":
            opts["json"] = True
        elif a == "--json-file" and i + 1 < len(argv):
            i += 1
            opts["json_file"] = argv[i]
        elif a == "--no-color":
            opts["no_color"] = True
        elif a == "--mock":
            pass  # accepted for backward compat, no-op (Docker lifecycle removed)
        elif a == "--all":
            opts["all_mode"] = True
        elif a in ("-v", "--verbose"):
            opts["verbose"] = True
        elif a == "--unit":
            opts["suite"] = "core,brain,cli,admin_cli,appview"
        elif a == "--suite" and i + 1 < len(argv):
            i += 1
            opts["suite"] = argv[i].lower()
        elif a in ("--help", "-h"):
            print(__doc__)
            sys.exit(0)
        i += 1
    return opts


def main() -> None:
    import tempfile
    import time as _time
    from datetime import datetime as _datetime

    script_t0 = _time.monotonic()
    log_dir = Path(tempfile.gettempdir()) / f"dina-tests-{_datetime.now().strftime('%Y%m%d-%H%M%S')}"
    log_dir.mkdir(parents=True, exist_ok=True)

    opts = parse_args(sys.argv)
    suite_filter = opts["suite"]
    json_mode = opts["json"]
    json_file = opts["json_file"]
    no_color = opts["no_color"]
    all_mode = opts["all_mode"]
    verbose = opts["verbose"]
    quick = not all_mode  # default is quick; --all disables it

    c = Colors(enabled=_use_color(no_color))

    keys = list(SUITES)
    if suite_filter:
        requested = [s.strip() for s in suite_filter.split(",")]
        bad = [s for s in requested if s not in SUITES]
        if bad:
            print(
                f"ERROR: Unknown suite(s): {', '.join(bad)}. "
                f"Valid: {', '.join(SUITES)}",
                file=sys.stderr,
            )
            sys.exit(2)
        keys = requested

    if not json_mode:
        mode_tag = "quick" if quick else "all (including slow tests)"
        print(f"Mode: {mode_tag}", file=sys.stderr, flush=True)

    # -- Service lifecycle -----------------------------------------------
    # Docker lifecycle is managed by prepare_non_unit_env.sh, not here.
    # test_status.py is a pure test runner and reporter.
    startup_time = 0.0

    # If DINA_INTEGRATION is set, integration tests use real clients.
    if os.environ.get("DINA_INTEGRATION") == "docker":
        SUITES["integration"]["mock_pass_is_skip"] = False

    try:
        all_json: dict = {}
        summary_rows: list[tuple[str, int, int, int, int, int, float]] = []

        for key in keys:
            cfg = SUITES[key]
            name = cfg["name"]
            if not json_mode:
                print(f"Running {name}...", file=sys.stderr, flush=True)

            tests, section_map, wall_time, raw_output = run_suite(key, quick=quick)
            if raw_output:
                (log_dir / f"{key}.log").write_text(raw_output)
            sections = aggregate(tests, section_map)

            # Write structured per-test log with grouped output
            if tests:
                _write_structured_log(
                    log_dir / f"{key}_details.log",
                    name,
                    tests,
                    sections,
                )

            tot = sum(s.total for s in sections)
            pas = sum(s.passed for s in sections)
            ski = sum(s.skipped for s in sections)
            fai = sum(s.failed for s in sections)
            xfa = sum(s.xfail for s in sections)
            sec_dur = sum(s.duration for s in sections)

            # Collect JSON data when --json or --json-file is active.
            if json_mode or json_file:
                all_json[key] = {
                    "sections": [
                        {
                            "number": s.number,
                            "name": s.name,
                            "total": s.total,
                            "passed": s.passed,
                            "skipped": s.skipped,
                            "failed": s.failed,
                            "status": s.status_label,
                            "duration_s": round(s.duration, 3),
                        }
                        for s in sections
                        if s.total > 0
                    ],
                    "tests": [
                        {
                            "name": t.name,
                            "status": t.status,
                            "section": t.section,
                            "duration_s": round(t.duration, 3),
                            **({"output": t.output} if t.output else {}),
                        }
                        for t in tests
                    ],
                    "summary": {
                        "total": tot,
                        "passed": pas,
                        "skipped": ski,
                        "failed": fai,
                        "xfail": xfa,
                        "duration_s": round(sec_dur, 3),
                        "wall_time_s": round(wall_time, 3),
                    },
                }

            if not json_mode:
                render_suite(name, sections, c, wall_time,
                             tests=tests, verbose=verbose)

            summary_rows.append((name, tot, pas, ski, fai, xfa, wall_time))

        total_time = _time.monotonic() - script_t0

        # Finalize JSON data.
        if json_mode or json_file:
            all_json["_timing"] = {
                "startup_s": round(startup_time, 3),
                "total_s": round(total_time, 3),
            }
            all_json["_log_dir"] = str(log_dir)

        if json_file:
            Path(json_file).write_text(json.dumps(all_json, indent=2) + "\n")

        if json_mode:
            output_json(all_json)
            print(f"\nDetailed logs: {log_dir}/", file=sys.stderr)
        else:
            if len(summary_rows) > 1:
                render_grand_summary(summary_rows, c)
            # Always show timing footer
            parts = []
            if startup_time > 0:
                parts.append(f"startup: {_fmt_startup_time(startup_time)}")
            parts.append(f"total: {_fmt_startup_time(total_time)}")
            print(f"\n  [{' | '.join(parts)}]")
            print(f"  Detailed logs: {log_dir}/")

    finally:
        _run_cleanup()


if __name__ == "__main__":
    main()
