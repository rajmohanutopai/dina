#!/usr/bin/env python3
"""Unified test status reporting: per-section pass/skip/fail breakdown.

Runs each test suite (Core Go, Brain Python, Integration Python) and reports
per-section status showing which areas are implemented vs pending.

Usage:
    python scripts/test_status.py                    # All 3 suites
    python scripts/test_status.py --suite core       # Core only
    python scripts/test_status.py --suite brain      # Brain only
    python scripts/test_status.py --suite integration # Integration only
    python scripts/test_status.py --json             # Machine-readable JSON
    python scripts/test_status.py --no-color         # Disable ANSI colors
"""

import json
import os
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

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


@dataclass
class SectionStats:
    number: int
    name: str
    total: int = 0
    passed: int = 0
    skipped: int = 0
    failed: int = 0

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
            )
        )
    return results


def parse_pytest_output(
    output: str,
    section_override: dict[str, int] | None = None,
) -> list[TestResult]:
    """Parse ``pytest -v`` output."""
    results: list[TestResult] = []
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
        "cmd": ["python", "-m", "pytest", "-v", "--tb=no", "brain/tests/"],
        "cwd": None,
        "plan": "brain/tests/TEST_PLAN.md",
        "parser": "pytest",
    },
    "integration": {
        "name": "Integration",
        "cmd": ["python", "-m", "pytest", "-v", "--tb=no", "tests/integration/"],
        "cwd": None,
        "plan": "tests/INTEGRATION_TEST_PLAN.md",
        "parser": "pytest",
        "test_dir": "tests/integration",
        "manifest": "tests/integration_manifest.json",
        # All integration tests currently use mocks (tests/integration/mocks.py),
        # not real implementations.  Treat PASS as SKIP until real services exist.
        "mock_pass_is_skip": True,
    },
}


def run_suite(key: str) -> tuple[list[TestResult], dict[int, str]]:
    """Run a test suite via subprocess and return parsed results + section map."""
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
        return [], section_map
    except FileNotFoundError as exc:
        print(f"WARNING: {cfg['name']}: {exc}", file=sys.stderr)
        return [], section_map

    if cfg["parser"] == "go":
        tests = parse_go_json(output)
    else:
        tests = parse_pytest_output(output, section_override)

    # Mock-based suites: PASS doesn't mean implemented — remap to SKIP
    if cfg.get("mock_pass_is_skip"):
        for t in tests:
            if t.status == "PASS":
                t.status = "SKIP"

    return tests, section_map


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


def render_suite(name: str, sections: list[SectionStats], c: Colors) -> None:
    """Print one suite's per-section table."""
    print(f"\n{c.bold('=== ' + name + ' ===')}")
    print(
        f" {'§':>3} | {'Section':<40} | {'Total':>5}"
        f" | {'Pass':>4} | {'Skip':>4} | {'Fail':>4} | Status"
    )
    rule = (
        f"{_SEP * 5}\u253c{_SEP * 42}\u253c{_SEP * 7}"
        f"\u253c{_SEP * 6}\u253c{_SEP * 6}\u253c{_SEP * 6}\u253c{_SEP * 10}"
    )
    print(rule)

    tot = pas = ski = fai = 0
    for s in sections:
        if s.total == 0:
            continue
        tot += s.total
        pas += s.passed
        ski += s.skipped
        fai += s.failed
        print(
            f" {s.number:>3} | {s.name[:40]:<40} | {s.total:>5}"
            f" | {s.passed:>4} | {s.skipped:>4} | {s.failed:>4}"
            f" | {c.status(s.status_label)}"
        )

    print(rule)
    print(
        f" {'':>3} | {'TOTAL':<40} | {tot:>5}"
        f" | {pas:>4} | {ski:>4} | {fai:>4} |"
    )


def render_grand_summary(
    rows: list[tuple[str, int, int, int, int]],
    c: Colors,
) -> None:
    """Print the grand summary across all suites."""
    print(f"\n{c.bold('=== Grand Summary ===')}")
    print(
        f" {'Suite':<14} | {'Total':>5}"
        f" | {'Pass':>4} | {'Skip':>4} | {'Fail':>4} | Progress"
    )
    rule = (
        f"{_SEP * 16}\u253c{_SEP * 7}"
        f"\u253c{_SEP * 6}\u253c{_SEP * 6}\u253c{_SEP * 6}\u253c{_SEP * 10}"
    )
    print(rule)

    gt = gp = gs = gf = 0
    for name, t, p, s, f in rows:
        gt += t
        gp += p
        gs += s
        gf += f
        pct = (p / t * 100) if t else 0
        print(
            f" {name:<14} | {t:>5}"
            f" | {p:>4} | {s:>4} | {f:>4} | {pct:>5.1f}%"
        )

    print(rule)
    gpct = (gp / gt * 100) if gt else 0
    print(
        f" {'TOTAL':<14} | {gt:>5}"
        f" | {gp:>4} | {gs:>4} | {gf:>4} | {gpct:>5.1f}%"
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


def parse_args(argv: list[str]) -> tuple[str | None, bool, bool]:
    """Return (suite_filter, json_mode, no_color)."""
    suite: str | None = None
    json_mode = no_color = False
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--json":
            json_mode = True
        elif a == "--no-color":
            no_color = True
        elif a == "--suite" and i + 1 < len(argv):
            i += 1
            suite = argv[i].lower()
        elif a in ("--help", "-h"):
            print(__doc__)
            sys.exit(0)
        i += 1
    return suite, json_mode, no_color


def main() -> None:
    suite_filter, json_mode, no_color = parse_args(sys.argv)
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

    all_json: dict = {}
    summary_rows: list[tuple[str, int, int, int, int]] = []

    for key in keys:
        cfg = SUITES[key]
        name = cfg["name"]
        if not json_mode:
            print(f"Running {name}...", file=sys.stderr, flush=True)

        tests, section_map = run_suite(key)
        sections = aggregate(tests, section_map)

        tot = sum(s.total for s in sections)
        pas = sum(s.passed for s in sections)
        ski = sum(s.skipped for s in sections)
        fai = sum(s.failed for s in sections)

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
                    }
                    for s in sections
                    if s.total > 0
                ],
                "summary": {
                    "total": tot,
                    "passed": pas,
                    "skipped": ski,
                    "failed": fai,
                },
            }
        else:
            render_suite(name, sections, c)

        summary_rows.append((name, tot, pas, ski, fai))

    if json_mode:
        output_json(all_json)
    elif len(summary_rows) > 1:
        render_grand_summary(summary_rows, c)

    print()


if __name__ == "__main__":
    main()
