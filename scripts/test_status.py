#!/usr/bin/env python3
"""Unified test status reporting: per-section pass/skip/fail breakdown.

Runs each test suite (Core Go, Brain Python, Integration Python) and reports
per-section status showing which areas are implemented vs pending.

By default, builds & runs Go Core + Python Brain as local subprocesses,
runs all tests against real APIs, and tears down on exit.

Usage:
    python scripts/test_status.py                    # All 3 suites (local services)
    python scripts/test_status.py --suite integration # Integration only (local services)
    python scripts/test_status.py --docker           # Use Docker containers instead of local
    python scripts/test_status.py --mock             # Fast mock-only (no real services)
    python scripts/test_status.py --json             # Machine-readable JSON
    python scripts/test_status.py --no-color         # Disable ANSI colors
"""

import atexit
import json
import os
import re
import secrets as _secrets
import signal
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Global reference for signal-handler teardown
_cleanup_fn: object | None = None


# ---------------------------------------------------------------------------
# Service lifecycle helpers (Docker and Local modes)
# ---------------------------------------------------------------------------

LOCAL_CORE_PORT = 18100
LOCAL_BRAIN_PORT = 18200


def _ensure_brain_token() -> str:
    """Create secrets/brain_token if it doesn't exist yet. Return the token."""
    secrets_dir = PROJECT_ROOT / "secrets"
    token_file = secrets_dir / "brain_token"
    if not token_file.exists():
        secrets_dir.mkdir(parents=True, exist_ok=True)
        token_file.write_text(_secrets.token_urlsafe(32))
        token_file.chmod(0o600)
        print("  Generated secrets/brain_token", file=sys.stderr)
    return token_file.read_text().strip()


def _run_cleanup() -> None:
    """Run the registered cleanup function. Safe to call multiple times."""
    global _cleanup_fn
    if _cleanup_fn is None:
        return
    fn = _cleanup_fn
    _cleanup_fn = None  # prevent double teardown
    fn()  # type: ignore[operator]


def _sigint_handler(signum: int, frame: object) -> None:
    """Handle Ctrl+C: tear down services, then exit."""
    _run_cleanup()
    sys.exit(130)  # 128 + SIGINT(2) — standard convention


def _register_cleanup(fn: object) -> None:
    """Register a cleanup function for SIGINT/SIGTERM/atexit."""
    global _cleanup_fn
    _cleanup_fn = fn
    signal.signal(signal.SIGINT, _sigint_handler)
    signal.signal(signal.SIGTERM, _sigint_handler)
    atexit.register(_run_cleanup)


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
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout):
            pass
        _time.sleep(2)
    raise TimeoutError(f"{label} not healthy after {timeout}s: {url}")


def _start_docker() -> float:
    """Start Docker test containers. Returns startup time in seconds."""
    import time as _time

    _ensure_brain_token()
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
    token = _ensure_brain_token()
    vault_dir = tempfile.mkdtemp(prefix="dina-test-vault-")

    core_url = f"http://localhost:{LOCAL_CORE_PORT}"
    brain_url = f"http://localhost:{LOCAL_BRAIN_PORT}"

    core_env = {
        **os.environ,
        "DINA_LISTEN_ADDR": f":{LOCAL_CORE_PORT}",
        "DINA_VAULT_PATH": vault_dir,
        "DINA_BRAIN_URL": brain_url,
        "DINA_BRAIN_TOKEN": token,
        "DINA_TEST_MODE": "true",
        "DINA_RATE_LIMIT": "100000",
        "DINA_LOG_LEVEL": "debug",
    }

    brain_env = {
        **os.environ,
        "DINA_CORE_URL": core_url,
        "DINA_BRAIN_TOKEN": token,
        "DINA_BRAIN_PORT": str(LOCAL_BRAIN_PORT),
        "DINA_LLM_URL": "http://localhost:9999",  # no LLM in test
        "DINA_LOG_LEVEL": "DEBUG",
        "DINA_CLOUD_LLM": "",
        "GOOGLE_API_KEY": "",
        "ANTHROPIC_API_KEY": "",
    }

    print("  Building Go Core...", file=sys.stderr, flush=True)
    build_t0 = _time.monotonic()
    subprocess.run(
        ["go", "build", "-o", "dina-core", "./cmd/dina-core"],
        cwd=str(PROJECT_ROOT / "core"),
        capture_output=True,
        timeout=120,
        check=True,
    )
    build_time = _time.monotonic() - build_t0
    print(f"  Go Core built ({build_time:.1f}s)", file=sys.stderr, flush=True)

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
        # Clean up compiled binary
        binary = PROJECT_ROOT / "core" / "dina-core"
        if binary.exists():
            binary.unlink()
        print("  Local services stopped.", file=sys.stderr)

    _register_cleanup(_stop)

    # Wait for health
    try:
        print("  Waiting for Core health...", file=sys.stderr, flush=True)
        _wait_for_health(f"{core_url}/healthz", "Core", timeout=30)
        print("  Waiting for Brain health...", file=sys.stderr, flush=True)
        _wait_for_health(f"{brain_url}/healthz", "Brain", timeout=60)
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
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class TestResult:
    name: str
    status: str  # PASS, SKIP, FAIL
    section: int  # major section number; 0 = unmapped
    duration: float = 0.0  # seconds


@dataclass
class SectionStats:
    number: int
    name: str
    total: int = 0
    passed: int = 0
    skipped: int = 0
    failed: int = 0
    duration: float = 0.0  # sum of test durations in seconds

    @property
    def status_label(self) -> str:
        if self.failed > 0:
            return "FAILED"
        if self.total == 0:
            return "Empty"
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
_PY_LINE_RE = re.compile(
    r"^([^\s:]+)::((?:\w+::)*test_\w+(?:\[.*?\])?)\s+(PASSED|SKIPPED|FAILED)"
)
# First number group after subject: test_auth_1_... → 1
_PY_SECTION_RE = re.compile(r"^test_\w+?_(\d+)_")

_STATUS_MAP = {"PASSED": "PASS", "SKIPPED": "SKIP", "FAILED": "FAIL"}
_GO_JSON_ACTION_MAP = {"pass": "PASS", "skip": "SKIP", "fail": "FAIL"}


def _extract_go_section(name: str) -> int:
    m = _GO_SECTION_RE.match(name)
    return int(m.group(1)) if m else 0


def _extract_py_section(
    func_name: str,
    override: dict[str, int] | None,
) -> int:
    if override and func_name in override:
        return override[func_name]
    m = _PY_SECTION_RE.match(func_name)
    return int(m.group(1)) if m else 0


def parse_go_json(output: str) -> list[TestResult]:
    """Parse ``go test -json`` output — one JSON object per line."""
    results: list[TestResult] = []
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
        if not name or action not in _GO_JSON_ACTION_MAP:
            continue
        results.append(
            TestResult(
                name=name,
                status=_GO_JSON_ACTION_MAP[action],
                section=_extract_go_section(name),
                duration=float(event.get("Elapsed", 0)),
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
    """Parse ``pytest -v`` output, including --durations timing."""
    results: list[TestResult] = []
    # First pass: collect durations from --durations=0 section
    durations: dict[str, float] = {}
    for line in output.splitlines():
        dm = _PY_DURATION_RE.match(line)
        if dm:
            func_name = dm.group(2).split("::")[-1]
            durations[func_name] = float(dm.group(1))

    # Second pass: collect test results
    for line in output.splitlines():
        m = _PY_LINE_RE.match(line)
        if not m:
            continue
        qualified = m.group(2)
        py_status = m.group(3)
        func_name = qualified.split("::")[-1]
        # Strip parametrize suffix for section lookup: test_foo[param] → test_foo
        base_name = func_name.split("[")[0]
        results.append(
            TestResult(
                name=func_name,
                status=_STATUS_MAP.get(py_status, "FAIL"),
                section=_extract_py_section(base_name, section_override),
                duration=durations.get(func_name, 0.0),
            )
        )
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
        "cmd": ["python", "-m", "pytest", "-v", "--tb=no", "--durations=0", "-vv",
                "brain/tests/"],
        "cwd": None,
        "plan": "brain/tests/TEST_PLAN.md",
        "parser": "pytest",
    },
    "integration": {
        "name": "Integration",
        "cmd": ["python", "-m", "pytest", "-v", "--tb=no", "--durations=0", "-vv",
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
}


def run_suite(key: str) -> tuple[list[TestResult], dict[int, str], float]:
    """Run a test suite via subprocess and return parsed results, section map,
    and wall-clock elapsed time in seconds."""
    import time as _time

    cfg = SUITES[key]
    plan_path = PROJECT_ROOT / cfg["plan"]
    section_map = parse_section_headers(plan_path)

    section_override: dict[str, int] | None = None
    if "test_dir" in cfg:
        manifest_path = (
            PROJECT_ROOT / cfg["manifest"] if "manifest" in cfg else None
        )
        section_override = prescan_integration_sections(
            PROJECT_ROOT / cfg["test_dir"],
            plan_path,
            manifest_path,
        )

    cwd = (PROJECT_ROOT / cfg["cwd"]) if cfg["cwd"] else PROJECT_ROOT

    t0 = _time.monotonic()
    try:
        result = subprocess.run(
            cfg["cmd"],
            capture_output=True,
            text=True,
            cwd=str(cwd),
            timeout=300,
        )
        output = result.stdout + "\n" + result.stderr
    except subprocess.TimeoutExpired:
        print(f"WARNING: {cfg['name']} timed out after 300s", file=sys.stderr)
        return [], section_map, _time.monotonic() - t0
    except FileNotFoundError as exc:
        print(f"WARNING: {cfg['name']}: {exc}", file=sys.stderr)
        return [], section_map, _time.monotonic() - t0
    elapsed = _time.monotonic() - t0

    if cfg["parser"] == "go":
        tests = parse_go_json(output)
    else:
        tests = parse_pytest_output(output, section_override)

    # Mock-based suites: PASS doesn't mean implemented — remap to SKIP
    if cfg.get("mock_pass_is_skip"):
        for t in tests:
            if t.status == "PASS":
                t.status = "SKIP"

    return tests, section_map, elapsed


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
        else:
            s.failed += 1

    if unmapped:
        print(f"  ({unmapped} tests could not be mapped to a section)",
              file=sys.stderr)

    return sorted(stats.values(), key=lambda x: x.number)


# ---------------------------------------------------------------------------
# ANSI colors
# ---------------------------------------------------------------------------


def _use_color(no_color_flag: bool) -> bool:
    if no_color_flag or os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty()


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


def render_suite(
    name: str,
    sections: list[SectionStats],
    c: Colors,
    wall_time: float = 0.0,
) -> None:
    """Print one suite's per-section table."""
    header = f"=== {name} ==="
    if wall_time > 0:
        header += f"  ({_fmt_duration(wall_time).strip()})"
    print(f"\n{c.bold(header)}")
    print(
        f" {'§':>3} | {'Section':<40} | {'Total':>5}"
        f" | {'Pass':>4} | {'Skip':>4} | {'Fail':>4}"
        f" | {'Time':>7} | Status"
    )
    rule = (
        f"{_SEP * 5}\u253c{_SEP * 42}\u253c{_SEP * 7}"
        f"\u253c{_SEP * 6}\u253c{_SEP * 6}\u253c{_SEP * 6}"
        f"\u253c{_SEP * 9}\u253c{_SEP * 10}"
    )
    print(rule)

    tot = pas = ski = fai = 0
    tot_dur = 0.0
    for s in sections:
        if s.total == 0:
            continue
        tot += s.total
        pas += s.passed
        ski += s.skipped
        fai += s.failed
        tot_dur += s.duration
        print(
            f" {s.number:>3} | {s.name[:40]:<40} | {s.total:>5}"
            f" | {s.passed:>4} | {s.skipped:>4} | {s.failed:>4}"
            f" | {_fmt_duration(s.duration)} | {c.status(s.status_label)}"
        )

    print(rule)
    print(
        f" {'':>3} | {'TOTAL':<40} | {tot:>5}"
        f" | {pas:>4} | {ski:>4} | {fai:>4}"
        f" | {_fmt_duration(tot_dur)} |"
    )


def render_grand_summary(
    rows: list[tuple[str, int, int, int, int, float]],
    c: Colors,
) -> None:
    """Print the grand summary across all suites."""
    print(f"\n{c.bold('=== Grand Summary ===')}")
    print(
        f" {'Suite':<14} | {'Total':>5}"
        f" | {'Pass':>4} | {'Skip':>4} | {'Fail':>4}"
        f" | {'Time':>7} | Progress"
    )
    rule = (
        f"{_SEP * 16}\u253c{_SEP * 7}"
        f"\u253c{_SEP * 6}\u253c{_SEP * 6}\u253c{_SEP * 6}"
        f"\u253c{_SEP * 9}\u253c{_SEP * 10}"
    )
    print(rule)

    gt = gp = gs = gf = 0
    g_time = 0.0
    for name, t, p, s, f, dur in rows:
        gt += t
        gp += p
        gs += s
        gf += f
        g_time += dur
        pct = (p / t * 100) if t else 0
        print(
            f" {name:<14} | {t:>5}"
            f" | {p:>4} | {s:>4} | {f:>4}"
            f" | {_fmt_duration(dur)} | {pct:>5.1f}%"
        )

    print(rule)
    gpct = (gp / gt * 100) if gt else 0
    print(
        f" {'TOTAL':<14} | {gt:>5}"
        f" | {gp:>4} | {gs:>4} | {gf:>4}"
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


def parse_args(argv: list[str]) -> tuple[str | None, bool, bool, str]:
    """Return (suite_filter, json_mode, no_color, service_mode).

    service_mode is "local" (default), "docker", or "mock".
    """
    suite: str | None = None
    json_mode = no_color = False
    service_mode: str = "local"  # default: build & run locally
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--json":
            json_mode = True
        elif a == "--no-color":
            no_color = True
        elif a == "--docker":
            service_mode = "docker"
        elif a == "--local":
            service_mode = "local"
        elif a == "--mock":
            service_mode = "mock"
        elif a == "--suite" and i + 1 < len(argv):
            i += 1
            suite = argv[i].lower()
        elif a in ("--help", "-h"):
            print(__doc__)
            sys.exit(0)
        i += 1
    return suite, json_mode, no_color, service_mode


def main() -> None:
    import time as _time

    script_t0 = _time.monotonic()
    suite_filter, json_mode, no_color, service_mode = parse_args(sys.argv)
    c = Colors(enabled=_use_color(no_color))

    keys = list(SUITES)
    if suite_filter:
        if suite_filter not in SUITES:
            print(
                f"ERROR: Unknown suite '{suite_filter}'. "
                f"Valid: {', '.join(SUITES)}",
                file=sys.stderr,
            )
            sys.exit(2)
        keys = [suite_filter]

    # -- Service lifecycle management ----------------------------------------
    startup_time = 0.0
    if service_mode == "mock":
        if not json_mode:
            print("Mock mode (no real services).", file=sys.stderr, flush=True)
    else:
        mode_label = "Docker" if service_mode == "docker" else "Local"
        if not json_mode:
            print(f"{mode_label} mode.", file=sys.stderr, flush=True)
        os.environ["DINA_INTEGRATION"] = "docker"  # Real* clients for both modes
        # Refresh mock_pass_is_skip now that env var is set
        SUITES["integration"]["mock_pass_is_skip"] = False
        try:
            if service_mode == "docker":
                startup_time = _start_docker()
            else:
                startup_time = _start_local()
        except Exception as exc:
            print(
                f"ERROR: Failed to start {mode_label}: {exc}",
                file=sys.stderr,
            )
            sys.exit(3)

    try:
        all_json: dict = {}
        summary_rows: list[tuple[str, int, int, int, int, float]] = []

        for key in keys:
            cfg = SUITES[key]
            name = cfg["name"]
            if not json_mode:
                print(f"Running {name}...", file=sys.stderr, flush=True)

            tests, section_map, wall_time = run_suite(key)
            sections = aggregate(tests, section_map)

            tot = sum(s.total for s in sections)
            pas = sum(s.passed for s in sections)
            ski = sum(s.skipped for s in sections)
            fai = sum(s.failed for s in sections)
            sec_dur = sum(s.duration for s in sections)

            if json_mode:
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
                    "summary": {
                        "total": tot,
                        "passed": pas,
                        "skipped": ski,
                        "failed": fai,
                        "duration_s": round(sec_dur, 3),
                        "wall_time_s": round(wall_time, 3),
                    },
                }
            else:
                render_suite(name, sections, c, wall_time)

            summary_rows.append((name, tot, pas, ski, fai, wall_time))

        total_time = _time.monotonic() - script_t0

        if json_mode:
            all_json["_timing"] = {
                "startup_s": round(startup_time, 3),
                "total_s": round(total_time, 3),
            }
            output_json(all_json)
        else:
            if len(summary_rows) > 1:
                render_grand_summary(summary_rows, c)
            # Always show timing footer
            parts = []
            if startup_time > 0:
                parts.append(f"startup: {_fmt_startup_time(startup_time)}")
            parts.append(f"total: {_fmt_startup_time(total_time)}")
            print(f"\n  [{' | '.join(parts)}]")

    finally:
        _run_cleanup()


if __name__ == "__main__":
    main()
