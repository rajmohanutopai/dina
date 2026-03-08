#!/usr/bin/env python3
"""Release test runner with per-scenario traceability.

Runs the release test suite (tests/release/) and reports per-scenario
pass/fail/skip status mapped to RELEASE_TEST_PLAN.md scenarios REL-001
through REL-023.

Usage:
    python scripts/test_release.py              # Rebuild containers, run tests, tear down
    python scripts/test_release.py --no-docker  # Skip Docker lifecycle (use pre-started stack)
    python scripts/test_release.py --all        # Include slow pre-release tests
    python scripts/test_release.py --json       # Machine-readable output
    python scripts/test_release.py -v           # Verbose per-test output
    python scripts/test_release.py --no-color   # Disable ANSI colors
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time as _time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime as _datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# RELEASE_TEST_PLAN.md parser
# ---------------------------------------------------------------------------

_REL_HEADER_RE = re.compile(r"^##\s+REL-(\d{3})\s+(.+)")

# Execution class extraction: look for "Hybrid.", "Manual.", "Harness.", etc.
_EXEC_CLASS_RE = re.compile(r"^(Hybrid|Manual|Harness|Pre-release Harness)\.")


def parse_release_scenarios(plan_path: Path) -> dict[int, dict]:
    """Parse RELEASE_TEST_PLAN.md into {scenario_number: {name, exec_class}}.

    Extracts ## REL-NNN headers and the execution class from the subsection.
    """
    scenarios: dict[int, dict] = {}
    current_num: int | None = None

    for line in plan_path.read_text().splitlines():
        m = _REL_HEADER_RE.match(line)
        if m:
            current_num = int(m.group(1))
            scenarios[current_num] = {
                "name": m.group(2).strip(),
                "exec_class": "Unknown",
            }
            continue

        if current_num is not None:
            ec = _EXEC_CLASS_RE.match(line.strip())
            if ec:
                scenarios[current_num]["exec_class"] = ec.group(1)

    return scenarios


# ---------------------------------------------------------------------------
# Test function → REL-NNN mapping
# ---------------------------------------------------------------------------

_REL_SECTION_RE = re.compile(r"^test_rel_(\d{3})_")
_FUNC_DEF_RE = re.compile(r"^\s*def (test_\w+)")


def _extract_rel_section(func_name: str) -> int:
    """Extract REL scenario number from test function name.

    test_rel_003_data_persists → 3
    test_rel_022_brain_not_public → 22
    """
    m = _REL_SECTION_RE.match(func_name)
    return int(m.group(1)) if m else 0


def prescan_release_sections(test_dir: Path) -> dict[str, int]:
    """Map test function names to REL scenario numbers.

    Uses both filename pattern (test_rel_NNN_*.py) and function name
    pattern (def test_rel_NNN_*) for mapping.
    """
    mapping: dict[str, int] = {}
    for filepath in sorted(test_dir.glob("test_rel_*.py")):
        for line in filepath.read_text().splitlines():
            fm = _FUNC_DEF_RE.match(line)
            if fm:
                func_name = fm.group(1)
                section = _extract_rel_section(func_name)
                if section > 0:
                    mapping[func_name] = section
    return mapping


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class TestResult:
    name: str
    status: str  # PASS, SKIP, FAIL
    section: int  # REL scenario number; 0 = unmapped
    duration: float = 0.0
    output: str = ""


@dataclass
class ScenarioStats:
    number: int
    name: str
    exec_class: str = "Unknown"
    total: int = 0
    passed: int = 0
    skipped: int = 0
    failed: int = 0
    duration: float = 0.0

    @property
    def status_label(self) -> str:
        if self.failed > 0:
            return "FAILED"
        if self.total == 0:
            if self.exec_class == "Manual":
                return "Manual"
            return "No Tests"
        if self.skipped == self.total:
            if self.exec_class == "Manual":
                return "Manual"
            return "Skip"
        if self.passed == self.total:
            return "Complete"
        if self.passed > 0:
            return "Partial"
        return "Skip"


# ---------------------------------------------------------------------------
# Output parsing (pytest -v)
# ---------------------------------------------------------------------------

_PY_LINE_RE = re.compile(
    r"^([^\s:]+)::((?:\w+::)*test_\w+(?:\[.*?\])?)\s+(PASSED|SKIPPED|FAILED|ERROR)"
)
_PY_DURATION_RE = re.compile(
    r"^\s*([\d.]+)s\s+call\s+\S+::((?:\w+::)*test_\w+(?:\[.*?\])?)"
)
_STATUS_MAP = {"PASSED": "PASS", "SKIPPED": "SKIP", "FAILED": "FAIL", "ERROR": "FAIL"}


def parse_pytest_output(
    output: str,
    section_override: dict[str, int] | None = None,
) -> list[TestResult]:
    """Parse pytest -v output into TestResult list."""
    results: list[TestResult] = []

    # Collect durations
    durations: dict[str, float] = {}
    for line in output.splitlines():
        dm = _PY_DURATION_RE.match(line)
        if dm:
            func_name = dm.group(2).split("::")[-1]
            durations[func_name] = float(dm.group(1))

    # Collect results
    for line in output.splitlines():
        m = _PY_LINE_RE.match(line)
        if not m:
            continue
        qualified = m.group(2)
        py_status = m.group(3)
        func_name = qualified.split("::")[-1]
        base_name = func_name.split("[")[0]

        section = 0
        if section_override and base_name in section_override:
            section = section_override[base_name]
        else:
            section = _extract_rel_section(base_name)

        results.append(
            TestResult(
                name=func_name,
                status=_STATUS_MAP.get(py_status, "FAIL"),
                section=section,
                duration=durations.get(func_name, 0.0),
            )
        )

    # Capture failure output
    _FAILURE_HDR = re.compile(r"^_{3,}\s+(.+?)\s+_{3,}$")
    _SECTION_END = re.compile(
        r"^=+\s*(short test summary|warnings summary|PASSES|slowest|\d+ (failed|passed))"
    )
    result_by_name: dict[str, TestResult] = {r.name: r for r in results}
    lines = output.splitlines()
    in_failures = False
    current_test: str | None = None
    capture_lines: list[str] = []

    for line in lines:
        if re.match(r"^=+\s+FAILURES\s+=+$", line):
            in_failures = True
            continue
        if not in_failures:
            continue
        if _SECTION_END.match(line):
            if current_test and current_test in result_by_name:
                result_by_name[current_test].output = "\n".join(capture_lines).rstrip()
            break
        hdr = _FAILURE_HDR.match(line)
        if hdr:
            if current_test and current_test in result_by_name:
                result_by_name[current_test].output = "\n".join(capture_lines).rstrip()
            raw_name = hdr.group(1).strip()
            func_name = raw_name.split("::")[-1].split(".")[-1]
            current_test = func_name
            capture_lines = []
            continue
        if current_test:
            capture_lines.append(line)

    if current_test and current_test in result_by_name:
        result_by_name[current_test].output = "\n".join(capture_lines).rstrip()

    return results


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def aggregate(
    tests: list[TestResult],
    scenarios: dict[int, dict],
) -> list[ScenarioStats]:
    """Group results by REL scenario, return sorted stats list."""
    stats: dict[int, ScenarioStats] = {}
    for num, info in scenarios.items():
        stats[num] = ScenarioStats(
            number=num,
            name=info["name"],
            exec_class=info.get("exec_class", "Unknown"),
        )

    for t in tests:
        if t.section == 0:
            continue
        if t.section not in stats:
            stats[t.section] = ScenarioStats(
                number=t.section, name=f"REL-{t.section:03d}",
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

    def cyan(self, t: str) -> str:
        return self._w("36", t)

    def status(self, label: str) -> str:
        fn = {
            "Complete": self.green,
            "Partial": self.yellow,
            "Skip": self.dim,
            "Manual": self.cyan,
            "No Tests": self.dim,
            "FAILED": self.red,
        }.get(label)
        return fn(label) if fn else label


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

_SEP = "\u2500"  # ─


def _fmt_duration(seconds: float) -> str:
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
    groups: dict[int, list[TestResult]] = {}
    for t in tests:
        groups.setdefault(t.section, []).append(t)
    return groups


def render_table(
    scenarios: list[ScenarioStats],
    c: Colors,
    wall_time: float = 0.0,
    tests: list[TestResult] | None = None,
    verbose: bool = False,
) -> None:
    """Print the per-scenario release test table."""
    header = "=== Release Tests ==="
    if wall_time > 0:
        header += f"  ({_fmt_duration(wall_time).strip()})"
    print(f"\n{c.bold(header)}")
    print(
        f" {'REL':>5} | {'Scenario':<42} | {'Class':<9}"
        f" | {'Total':>5} | {'Pass':>4} | {'Skip':>4} | {'Fail':>4}"
        f" | Status"
    )
    rule = (
        f"{_SEP * 7}\u253c{_SEP * 44}\u253c{_SEP * 11}"
        f"\u253c{_SEP * 7}\u253c{_SEP * 6}\u253c{_SEP * 6}\u253c{_SEP * 6}"
        f"\u253c{_SEP * 10}"
    )
    print(rule)

    by_section = _group_tests_by_section(tests) if verbose and tests else {}

    tot = pas = ski = fai = 0
    for s in scenarios:
        tot += s.total
        pas += s.passed
        ski += s.skipped
        fai += s.failed

        class_tag = s.exec_class[:9]
        print(
            f" {s.number:>5} | {s.name[:42]:<42} | {class_tag:<9}"
            f" | {s.total:>5} | {s.passed:>4} | {s.skipped:>4} | {s.failed:>4}"
            f" | {c.status(s.status_label)}"
        )

        if verbose and s.number in by_section:
            for t in sorted(by_section[s.number], key=lambda x: x.name):
                status_str = {
                    "PASS": c.green("PASS"),
                    "SKIP": c.dim("SKIP"),
                    "FAIL": c.red("FAIL"),
                }.get(t.status, t.status)
                print(f"       |   {status_str} {t.name[:60]}")

    print(rule)
    print(
        f" {'':>5} | {'TOTAL':<42} | {'':9}"
        f" | {tot:>5} | {pas:>4} | {ski:>4} | {fai:>4} |"
    )


def render_summary(scenarios: list[ScenarioStats], c: Colors) -> None:
    """Print a concise summary of release readiness."""
    total_scenarios = len(scenarios)
    complete = sum(1 for s in scenarios if s.status_label == "Complete")
    failed = sum(1 for s in scenarios if s.status_label == "FAILED")
    manual = sum(1 for s in scenarios if s.status_label == "Manual")
    partial = sum(1 for s in scenarios if s.status_label == "Partial")
    no_tests = sum(1 for s in scenarios if s.status_label in ("No Tests", "Skip"))

    print(f"\n{c.bold('=== Release Readiness ===')}")
    print(f"  Scenarios:  {total_scenarios}")
    print(f"  Complete:   {c.green(str(complete))}")
    if failed > 0:
        print(f"  FAILED:     {c.red(str(failed))}")
    if partial > 0:
        print(f"  Partial:    {c.yellow(str(partial))}")
    if manual > 0:
        print(f"  Manual:     {c.cyan(str(manual))}")
    if no_tests > 0:
        print(f"  No Tests:   {c.dim(str(no_tests))}")

    if failed > 0:
        print(f"\n  {c.red('RELEASE BLOCKED')} — {failed} scenario(s) failed.")
        for s in scenarios:
            if s.status_label == "FAILED":
                print(f"    REL-{s.number:03d} {s.name}")
    elif complete == total_scenarios:
        print(f"\n  {c.green('All harness tests PASS.')}")
    else:
        pending = total_scenarios - complete - manual
        if pending > 0:
            print(f"\n  {c.yellow(f'{pending} scenario(s) need attention.')}")

    # Manual checklist — always print as a reminder
    print(f"\n{c.bold('=== Manual Checks Before Release ===')}")
    print("  The following require human judgment and cannot be automated:")
    print()
    _manual_checks = [
        ("REL-001", "Fresh machine install on a clean VM (no Docker, no artifacts)"),
        ("REL-002", "First real conversation with working LLM — verify quality and UX"),
        ("REL-006", "Cross-machine D2D: laptop + VPS or VPS + VPS (not just Docker)"),
        ("REL-007", "Full trust attestation E2E: publish real attestation via PDS, verify scoring"),
        ("REL-008", "Agent gateway with real rogue client script, admin revocation path"),
        ("REL-010", "Hostile network with iptables/tc fault injection between real hosts"),
        ("REL-013", "Show-someone test: external developer installs from scratch"),
        ("REL-014", "Human review of recovery/security wording for clarity"),
        ("REL-016", "Upgrade verification: image digests, artifact checksums"),
        ("REL-018", "Connector outage: simulate real outage, verify re-auth UX"),
        ("REL-023", "CLI agent onboarding UX: pairing prompts, error message quality"),
    ]
    for ref, desc in _manual_checks:
        print(f"  [ ] {c.cyan(ref):>12}  {desc}")
    print()
    print(f"  Evidence: save transcripts in {c.dim('evidence/REL-NNN/')}")


# ---------------------------------------------------------------------------
# Structured log
# ---------------------------------------------------------------------------


def write_structured_log(
    log_path: Path,
    tests: list[TestResult],
    scenarios: list[ScenarioStats],
) -> None:
    """Write a structured log file with tests grouped by scenario."""
    lines: list[str] = []
    lines.append(f"{'=' * 80}")
    lines.append(f"  Release Tests — Structured Log")
    lines.append(f"  Generated: {_datetime.now().isoformat()}")
    lines.append(f"{'=' * 80}")
    lines.append("")

    by_section = _group_tests_by_section(tests)

    total = sum(s.total for s in scenarios)
    passed = sum(s.passed for s in scenarios)
    failed = sum(s.failed for s in scenarios)
    skipped = sum(s.skipped for s in scenarios)
    lines.append(f"  Total: {total}  |  Passed: {passed}  |  Failed: {failed}  |  Skipped: {skipped}")
    lines.append("")

    failed_tests = [t for t in tests if t.status == "FAIL"]
    if failed_tests:
        lines.append(f"  FAILURES ({len(failed_tests)}):")
        for t in sorted(failed_tests, key=lambda x: (x.section, x.name)):
            lines.append(f"    - [REL-{t.section:03d}] {t.name}")
        lines.append("")

    for s in sorted(scenarios, key=lambda x: x.number):
        sec_tests = by_section.get(s.number, [])
        lines.append(f"{'─' * 80}")
        lines.append(f"  REL-{s.number:03d}  {s.name}  [{s.exec_class}]")
        if sec_tests:
            lines.append(f"  Tests: {s.total}  |  Pass: {s.passed}  |  Fail: {s.failed}  |  Skip: {s.skipped}")
        else:
            lines.append(f"  Status: {s.status_label}")
        lines.append(f"{'─' * 80}")

        for t in sorted(sec_tests, key=lambda x: x.name):
            status_tag = f"[{t.status}]"
            dur = f"  ({t.duration:.3f}s)" if t.duration > 0 else ""
            lines.append(f"  {status_tag:<6} {t.name}{dur}")
            if t.output:
                for out_line in t.output.splitlines():
                    lines.append(f"         {out_line}")
                lines.append("")

        lines.append("")

    lines.append(f"{'=' * 80}")
    log_path.write_text("\n".join(lines))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str]) -> dict:
    opts: dict = {
        "json": False,
        "no_color": False,
        "all_mode": False,
        "verbose": False,
        "docker": True,
    }
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--json":
            opts["json"] = True
        elif a == "--no-color":
            opts["no_color"] = True
        elif a == "--all":
            opts["all_mode"] = True
        elif a in ("-v", "--verbose"):
            opts["verbose"] = True
        elif a == "--no-docker":
            opts["docker"] = False
        elif a in ("--help", "-h"):
            print(__doc__)
            sys.exit(0)
        i += 1
    return opts


# ---------------------------------------------------------------------------
# Docker lifecycle for release stack
# ---------------------------------------------------------------------------

COMPOSE_FILE = PROJECT_ROOT / "docker-compose-release.yml"


def _docker_compose_cmd(*args: str) -> list[str]:
    return ["docker", "compose", "-f", str(COMPOSE_FILE), *args]


def start_release_stack(c: Colors | None = None) -> bool:
    """Build and start the release Docker stack. Returns True on success."""
    if not COMPOSE_FILE.exists():
        msg = f"ERROR: {COMPOSE_FILE} not found"
        print(msg, file=sys.stderr)
        return False

    log = c.dim if c else lambda x: x

    # Always tear down first to avoid stale code/containers
    print(log("Tearing down existing release stack..."), file=sys.stderr, flush=True)
    try:
        subprocess.run(
            _docker_compose_cmd("down", "-v", "--remove-orphans"),
            capture_output=True, text=True,
            cwd=str(PROJECT_ROOT), timeout=120,
        )
    except subprocess.TimeoutExpired:
        print("WARNING: Teardown timed out, continuing...", file=sys.stderr)

    print(log("Building release stack..."), file=sys.stderr, flush=True)
    result = subprocess.run(
        _docker_compose_cmd("build", "--no-cache"),
        capture_output=True, text=True,
        cwd=str(PROJECT_ROOT), timeout=600,
    )
    if result.returncode != 0:
        print(f"ERROR: Docker build failed:\n{result.stderr[-500:]}", file=sys.stderr)
        return False

    print(log("Starting release stack..."), file=sys.stderr, flush=True)
    result = subprocess.run(
        _docker_compose_cmd("up", "-d", "--wait"),
        capture_output=True, text=True,
        cwd=str(PROJECT_ROOT), timeout=300,
    )
    if result.returncode != 0:
        print(f"WARNING: Docker up returned {result.returncode}", file=sys.stderr)

    # Wait for Core health
    import urllib.request
    import urllib.error

    core_port = os.environ.get("PORT_RELEASE_CORE", "19500")
    health_url = f"http://127.0.0.1:{core_port}/healthz"
    deadline = _time.monotonic() + 120
    while _time.monotonic() < deadline:
        try:
            req = urllib.request.urlopen(health_url, timeout=3)
            if req.status == 200:
                print(log(f"Core healthy at :{core_port}"), file=sys.stderr, flush=True)
                return True
        except Exception:
            pass
        _time.sleep(2)

    print("ERROR: Core did not become healthy within 120s", file=sys.stderr)
    return False


def stop_release_stack() -> None:
    """Stop and remove the release Docker stack."""
    try:
        subprocess.run(
            _docker_compose_cmd("down", "-v", "--remove-orphans"),
            capture_output=True, text=True,
            cwd=str(PROJECT_ROOT), timeout=120,
        )
    except subprocess.TimeoutExpired:
        pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    script_t0 = _time.monotonic()
    log_dir = Path(tempfile.gettempdir()) / f"dina-release-{_datetime.now().strftime('%Y%m%d-%H%M%S')}"
    log_dir.mkdir(parents=True, exist_ok=True)

    opts = parse_args(sys.argv)
    json_mode = opts["json"]
    no_color = opts["no_color"]
    all_mode = opts["all_mode"]
    verbose = opts["verbose"]
    docker_mode = opts["docker"]
    quick = not all_mode

    c = Colors(enabled=_use_color(no_color))

    # Start Docker stack if requested
    docker_started = False
    if docker_mode:
        os.environ["DINA_RELEASE"] = "docker"
        if not start_release_stack(c):
            print(c.red("Failed to start release Docker stack"), file=sys.stderr)
            sys.exit(2)
        docker_started = True

    # Parse scenario definitions from RELEASE_TEST_PLAN.md
    plan_path = PROJECT_ROOT / "RELEASE_TEST_PLAN.md"
    if not plan_path.exists():
        print(f"ERROR: {plan_path} not found", file=sys.stderr)
        sys.exit(2)

    scenarios_raw = parse_release_scenarios(plan_path)
    if not scenarios_raw:
        print("ERROR: No REL-NNN scenarios found in plan", file=sys.stderr)
        sys.exit(2)

    # Pre-scan test files for function → scenario mapping
    test_dir = PROJECT_ROOT / "tests" / "release"
    section_override = prescan_release_sections(test_dir)

    if not json_mode:
        mode_tag = "quick" if quick else "all (including slow tests)"
        print(f"Release test mode: {mode_tag}", file=sys.stderr, flush=True)
        print(f"Scenarios: {len(scenarios_raw)} (from RELEASE_TEST_PLAN.md)",
              file=sys.stderr, flush=True)
        print(f"Test dir:  {test_dir}", file=sys.stderr, flush=True)

    # Run pytest
    cmd = [
        sys.executable, "-m", "pytest",
        "-v", "--tb=short", "--durations=0", "-vv",
        str(test_dir),
    ]
    if quick:
        cmd.extend(["-m", "not slow"])

    if not json_mode:
        print("Running release tests...", file=sys.stderr, flush=True)

    t0 = _time.monotonic()
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            timeout=300,
        )
        output = result.stdout + "\n" + result.stderr
    except subprocess.TimeoutExpired:
        print("WARNING: Release tests timed out after 300s", file=sys.stderr)
        output = ""
    except FileNotFoundError as exc:
        print(f"WARNING: {exc}", file=sys.stderr)
        output = ""
    wall_time = _time.monotonic() - t0

    # Save raw output
    if output:
        (log_dir / "release.log").write_text(output)

    # Parse results
    tests = parse_pytest_output(output, section_override)

    # Aggregate into scenarios
    scenario_stats = aggregate(tests, scenarios_raw)

    # Write structured log
    if tests:
        write_structured_log(log_dir / "release_details.log", tests, scenario_stats)

    if json_mode:
        json_data = {
            "scenarios": [
                {
                    "id": f"REL-{s.number:03d}",
                    "name": s.name,
                    "exec_class": s.exec_class,
                    "total": s.total,
                    "passed": s.passed,
                    "skipped": s.skipped,
                    "failed": s.failed,
                    "status": s.status_label,
                    "duration_s": round(s.duration, 3),
                }
                for s in scenario_stats
            ],
            "tests": [
                {
                    "name": t.name,
                    "status": t.status,
                    "scenario": f"REL-{t.section:03d}" if t.section > 0 else "unmapped",
                    "duration_s": round(t.duration, 3),
                    **({"output": t.output} if t.output else {}),
                }
                for t in tests
            ],
            "summary": {
                "total_scenarios": len(scenario_stats),
                "total_tests": sum(s.total for s in scenario_stats),
                "passed": sum(s.passed for s in scenario_stats),
                "skipped": sum(s.skipped for s in scenario_stats),
                "failed": sum(s.failed for s in scenario_stats),
                "wall_time_s": round(wall_time, 3),
            },
            "log_dir": str(log_dir),
        }
        json.dump(json_data, sys.stdout, indent=2)
        print()
    else:
        render_table(scenario_stats, c, wall_time, tests, verbose)
        render_summary(scenario_stats, c)
        total_time = _time.monotonic() - script_t0
        print(f"\n  Logs: {log_dir}")
        print(f"  Total time: {_fmt_duration(total_time).strip()}")

    # Tear down Docker stack if we started it
    if docker_started:
        if not json_mode:
            print(c.dim("Stopping release stack..."), file=sys.stderr, flush=True)
        stop_release_stack()

    # Exit code: non-zero if any scenario failed
    any_failed = any(s.status_label == "FAILED" for s in scenario_stats)
    sys.exit(1 if any_failed else 0)


if __name__ == "__main__":
    main()
