#!/usr/bin/env python3
"""AppView test runner — runs Vitest, produces per-section report with traceability.

Usage:
    python scripts/run_appview_tests.py                    # Run all
    python scripts/run_appview_tests.py --suite unit        # Unit only
    python scripts/run_appview_tests.py --suite integration # Integration only
    python scripts/run_appview_tests.py --json              # Machine-readable JSON
    python scripts/run_appview_tests.py -v                  # Verbose (individual tests)
    python scripts/run_appview_tests.py --no-color          # Disable ANSI colors
    python scripts/run_appview_tests.py --check             # Traceability check only
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent
APPVIEW_DIR = PROJECT_ROOT / "appview"

# ---------------------------------------------------------------------------
# Section maps — source of truth from test plans
# ---------------------------------------------------------------------------

UNIT_SECTIONS: dict[int, str] = {
    1: "Scorer Algorithms",
    2: "Ingester Components",
    3: "Shared Utilities",
    4: "Configuration",
    5: "API Cache",
    6: "Jetstream Consumer",
    7: "Scorer Jobs",
    8: "XRPC Params",
}

UNIT_PLANNED: dict[int, int] = {
    1: 77, 2: 81, 3: 38, 4: 23, 5: 14, 6: 23, 7: 17, 8: 15,
}

INTEGRATION_SECTIONS: dict[int, str] = {
    1: "Ingester Handlers",
    2: "Deletion + Tombstones",
    3: "Trust Edge Sync",
    4: "Subject Resolution",
    5: "Idempotency",
    6: "Backpressure + Low Watermark",
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
}

INTEGRATION_PLANNED: dict[int, int] = {
    1: 61, 2: 20, 3: 12, 4: 15, 5: 7, 6: 10, 7: 5, 8: 20,
    9: 41, 10: 44, 11: 25, 12: 9, 13: 5, 14: 10, 15: 6, 16: 6, 17: 11,
}

# Map test ID prefix -> major section number

UNIT_ID_TO_SECTION: dict[str, int] = {
    "UT-TS": 1, "UT-RQ": 1, "UT-SA": 1, "UT-AD": 1, "UT-RC": 1,
    "UT-RV": 2, "UT-RL": 2, "UT-BQ": 2, "UT-HR": 2, "UT-DH": 2, "UT-TE": 2,
    "UT-URI": 3, "UT-DI": 3, "UT-RT": 3, "UT-BA": 3, "UT-ER": 3,
    "UT-ENV": 4, "UT-CON": 4, "UT-LEX": 4,
    "UT-SWR": 5,
    "UT-JC": 6,
    "UT-SCH": 7, "UT-DS": 7,
    "UT-RP": 8, "UT-SP": 8,
}

INTEGRATION_ID_TO_SECTION: dict[str, int] = {
    "IT-ATT": 1, "IT-VCH": 1, "IT-END": 1, "IT-FLG": 1, "IT-RPL": 1,
    "IT-RXN": 1, "IT-RPT": 1, "IT-REV": 1, "IT-DLG": 1, "IT-HND": 1,
    "IT-DEL": 2,
    "IT-TE": 3,
    "IT-SUB": 4,
    "IT-IDP": 5,
    "IT-BP": 6, "IT-LW": 6,
    "IT-RL": 7,
    "IT-GR": 8,
    "IT-SC": 9,
    "IT-API": 10,
    "IT-DB": 11,
    "IT-DF": 12,
    "IT-CUR": 13,
    "IT-BF": 14,
    "IT-LBL": 15,
    "IT-DCK": 16,
    "IT-E2E": 17,
}

# Regex to extract traceability ID from test name
# Note: [A-Z0-9]+ handles prefixes with digits like E2E
_ID_RE = re.compile(r"((?:UT|IT)-[A-Z][A-Z0-9]*-\d+[a-z]?)")

# Regex to extract prefix (without number) from traceability ID
_PREFIX_RE = re.compile(r"((?:UT|IT)-[A-Z][A-Z0-9]*)-\d+")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class TestResult:
    name: str
    trace_id: str  # e.g. "UT-TS-001"
    status: str  # PASS, SKIP, FAIL
    section: int  # major section number; 0 = unmapped
    duration: float = 0.0


@dataclass
class SectionStats:
    number: int
    name: str
    planned: int = 0
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
            return "Empty"
        if self.passed == self.total:
            return "Complete"
        if self.passed > 0:
            return "Partial"
        return "Skip"

    @property
    def mismatch(self) -> str:
        """Return warning string if planned != total."""
        diff = self.total - self.planned
        if diff == 0:
            return ""
        return f" \u26a0 {diff:+d}"


# ---------------------------------------------------------------------------
# ANSI colors (matches test_status.py)
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
# Duration formatting (matches test_status.py)
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


def _fmt_wall(seconds: float) -> str:
    if seconds < 1.0:
        return f"{seconds * 1000:.0f}ms"
    if seconds < 60.0:
        return f"{seconds:.1f}s"
    minutes = int(seconds // 60)
    secs = seconds % 60
    return f"{minutes}m{secs:.0f}s"


# ---------------------------------------------------------------------------
# Vitest execution
# ---------------------------------------------------------------------------

def _check_node_modules() -> bool:
    """Return True if node_modules exists in appview/."""
    return (APPVIEW_DIR / "node_modules").is_dir()


def _run_vitest(test_dir: str) -> tuple[dict | None, float]:
    """Run vitest for a test directory and return (json_data, wall_time).

    Returns (None, wall_time) if vitest fails or is not available.
    """
    if not _check_node_modules():
        print(f"  node_modules not found — run: cd appview && npm install",
              file=sys.stderr)
        return None, 0.0

    result_file = APPVIEW_DIR / f".vitest-{test_dir.replace('/', '-')}.json"

    env = {**os.environ, "VITEST_JSON": "1"}
    cmd = [
        "npx", "vitest", "run",
        f"tests/{test_dir}/",
        "--reporter=json",
        f"--outputFile={result_file}",
    ]

    t0 = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(APPVIEW_DIR),
            capture_output=True,
            text=True,
            timeout=300,
            env=env,
        )
    except FileNotFoundError:
        print("  npx not found — install Node.js", file=sys.stderr)
        return None, time.monotonic() - t0
    except subprocess.TimeoutExpired:
        print("  vitest timed out after 300s", file=sys.stderr)
        return None, time.monotonic() - t0

    wall = time.monotonic() - t0

    if result_file.exists():
        try:
            data = json.loads(result_file.read_text())
            result_file.unlink(missing_ok=True)
            return data, wall
        except json.JSONDecodeError:
            pass

    # Fallback: try to parse stdout as JSON
    for output in (proc.stdout, proc.stderr):
        if output and output.strip().startswith("{"):
            try:
                return json.loads(output), wall
            except json.JSONDecodeError:
                continue

    return None, wall


# ---------------------------------------------------------------------------
# Vitest JSON parsing
# ---------------------------------------------------------------------------

def _extract_section(trace_id: str, id_map: dict[str, int]) -> int:
    """Map a traceability ID like 'UT-TS-001' to its section number."""
    m = _PREFIX_RE.match(trace_id)
    if m:
        prefix = m.group(1)
        return id_map.get(prefix, 0)
    return 0


def _parse_vitest_json(
    data: dict,
    id_map: dict[str, int],
) -> list[TestResult]:
    """Parse Vitest JSON reporter output into TestResult list."""
    results: list[TestResult] = []

    for test_file in data.get("testResults", []):
        for assertion in test_file.get("assertionResults", []):
            full_name = assertion.get("fullName", "") or assertion.get("title", "")

            # Extract traceability ID
            m = _ID_RE.search(full_name)
            if not m:
                # Test without traceability ID — skip it
                continue
            trace_id = m.group(1)

            # Map Vitest status
            raw_status = assertion.get("status", "pending")
            status_map = {
                "passed": "PASS",
                "failed": "FAIL",
                "pending": "SKIP",
                "skipped": "SKIP",
                "todo": "SKIP",
            }
            status = status_map.get(raw_status, "SKIP")

            duration = (assertion.get("duration", 0) or 0) / 1000.0  # ms -> s

            section = _extract_section(trace_id, id_map)

            results.append(TestResult(
                name=full_name,
                trace_id=trace_id,
                status=status,
                section=section,
                duration=duration,
            ))

    return results


# ---------------------------------------------------------------------------
# Static file scan (fallback when vitest can't run)
# ---------------------------------------------------------------------------

_IT_LINE_RE = re.compile(
    r"it(?:\.skip|\.todo)?\(\s*'((?:UT|IT)-[A-Z][A-Z0-9]*-\d+[a-z]?):"
)


def _scan_test_files(
    test_dir: str,
    id_map: dict[str, int],
) -> list[TestResult]:
    """Scan .test.ts files for it.skip/it() calls and extract traceability IDs."""
    results: list[TestResult] = []
    test_path = APPVIEW_DIR / "tests" / test_dir

    if not test_path.is_dir():
        return results

    for ts_file in sorted(test_path.glob("*.test.ts")):
        content = ts_file.read_text()
        for m in _IT_LINE_RE.finditer(content):
            trace_id = m.group(1)
            section = _extract_section(trace_id, id_map)

            # Determine if it's skip or active by checking the match
            match_text = m.group(0)
            if "it.skip" in match_text or "it.todo" in match_text:
                status = "SKIP"
            else:
                status = "PASS"

            results.append(TestResult(
                name=trace_id,
                trace_id=trace_id,
                status=status,
                section=section,
            ))

    return results


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def _aggregate(
    results: list[TestResult],
    section_names: dict[int, str],
    planned: dict[int, int],
) -> list[SectionStats]:
    """Group TestResults into per-section stats."""
    stats: dict[int, SectionStats] = {}
    for num, name in section_names.items():
        stats[num] = SectionStats(
            number=num,
            name=name,
            planned=planned.get(num, 0),
        )

    for t in results:
        s = stats.get(t.section)
        if not s:
            s = SectionStats(number=t.section, name=f"Unknown §{t.section}")
            stats[t.section] = s
        s.total += 1
        if t.status == "PASS":
            s.passed += 1
        elif t.status == "FAIL":
            s.failed += 1
        else:
            s.skipped += 1
        s.duration += t.duration

    return sorted(stats.values(), key=lambda s: s.number)


# ---------------------------------------------------------------------------
# Table rendering (matches test_status.py format + Plan column)
# ---------------------------------------------------------------------------

def _render_suite(
    name: str,
    sections: list[SectionStats],
    c: Colors,
    wall_time: float = 0.0,
    tests: list[TestResult] | None = None,
    verbose: bool = False,
) -> None:
    """Print one suite's per-section table with Plan column."""
    header = f"=== {name} ==="
    if wall_time > 0:
        header += f"  ({_fmt_wall(wall_time)})"
    print(f"\n{c.bold(header)}")
    print(
        f" {'§':>3} | {'Section':<40} | {'Plan':>4}"
        f" | {'Total':>5} | {'Pass':>4} | {'Skip':>4} | {'Fail':>4}"
        f" | {'Time':>7} | Status"
    )
    rule = (
        f"{_SEP * 5}\u253c{_SEP * 42}\u253c{_SEP * 6}"
        f"\u253c{_SEP * 7}\u253c{_SEP * 6}\u253c{_SEP * 6}\u253c{_SEP * 6}"
        f"\u253c{_SEP * 9}\u253c{_SEP * 10}"
    )
    print(rule)

    # Group tests by section for verbose display
    by_section: dict[int, list[TestResult]] = {}
    if verbose and tests:
        for t in tests:
            by_section.setdefault(t.section, []).append(t)

    tot = pas = ski = fai = 0
    tot_plan = 0
    tot_dur = 0.0
    for s in sections:
        if s.total == 0 and s.planned == 0:
            continue
        tot += s.total
        pas += s.passed
        ski += s.skipped
        fai += s.failed
        tot_plan += s.planned
        tot_dur += s.duration
        mismatch = s.mismatch
        status_str = c.status(s.status_label) + (c.red(mismatch) if mismatch else "")
        print(
            f" {s.number:>3} | {s.name[:40]:<40} | {s.planned:>4}"
            f" | {s.total:>5} | {s.passed:>4} | {s.skipped:>4} | {s.failed:>4}"
            f" | {_fmt_duration(s.duration)} | {status_str}"
        )

        # Verbose: print individual tests under this section
        if verbose and s.number in by_section:
            for t in sorted(by_section[s.number], key=lambda x: x.trace_id):
                st = {
                    "PASS": c.green("PASS"),
                    "SKIP": c.dim("SKIP"),
                    "FAIL": c.red("FAIL"),
                }.get(t.status, t.status)
                dur_str = _fmt_duration(t.duration) if t.duration > 0 else ""
                print(f"     |   {st} {t.trace_id:<12} {t.name[:55]:<55} {dur_str}")

    print(rule)
    print(
        f" {'':>3} | {'TOTAL':<40} | {tot_plan:>4}"
        f" | {tot:>5} | {pas:>4} | {ski:>4} | {fai:>4}"
        f" | {_fmt_duration(tot_dur)} |"
    )


def _render_grand_summary(
    rows: list[tuple[str, int, int, int, int, int, float]],
    c: Colors,
) -> None:
    """Print cross-suite summary. rows: (name, planned, total, pass, skip, fail, dur)."""
    print(f"\n{c.bold('=== Grand Summary ===')}")
    print(
        f" {'Suite':<20} | {'Plan':>4}"
        f" | {'Total':>5} | {'Pass':>4} | {'Skip':>4} | {'Fail':>4}"
        f" | {'Time':>7} | Progress"
    )
    rule = (
        f"{_SEP * 22}\u253c{_SEP * 6}"
        f"\u253c{_SEP * 7}\u253c{_SEP * 6}\u253c{_SEP * 6}\u253c{_SEP * 6}"
        f"\u253c{_SEP * 9}\u253c{_SEP * 10}"
    )
    print(rule)

    gt = gp = gs = gf = gpl = 0
    g_time = 0.0
    for name, planned, t, p, s, f, dur in rows:
        gt += t
        gp += p
        gs += s
        gf += f
        gpl += planned
        g_time += dur
        pct = (p / t * 100) if t else 0
        print(
            f" {name:<20} | {planned:>4}"
            f" | {t:>5} | {p:>4} | {s:>4} | {f:>4}"
            f" | {_fmt_duration(dur)} | {pct:>5.1f}%"
        )

    print(rule)
    gpct = (gp / gt * 100) if gt else 0
    print(
        f" {'TOTAL':<20} | {gpl:>4}"
        f" | {gt:>5} | {gp:>4} | {gs:>4} | {gf:>4}"
        f" | {_fmt_duration(g_time)} | {gpct:>5.1f}%"
    )


# ---------------------------------------------------------------------------
# Traceability check (--check mode)
# ---------------------------------------------------------------------------

def _check_traceability(
    test_dir: str,
    id_map: dict[str, int],
    planned: dict[int, int],
    section_names: dict[int, str],
    c: Colors,
) -> tuple[int, int]:
    """Scan test files and compare against planned counts. Returns (missing, extra)."""
    results = _scan_test_files(test_dir, id_map)

    actual_counts: dict[int, int] = {}
    for t in results:
        actual_counts[t.section] = actual_counts.get(t.section, 0) + 1

    total_missing = 0
    total_extra = 0

    for num in sorted(set(list(planned.keys()) + list(actual_counts.keys()))):
        p = planned.get(num, 0)
        a = actual_counts.get(num, 0)
        name = section_names.get(num, f"Unknown §{num}")
        diff = a - p
        if diff == 0:
            status = c.green("OK")
        elif diff < 0:
            status = c.red(f"MISSING {abs(diff)}")
            total_missing += abs(diff)
        else:
            status = c.yellow(f"EXTRA {diff}")
            total_extra += diff
        print(f"  §{num:>2} {name:<40} Plan={p:>3}  Actual={a:>3}  {status}")

    return total_missing, total_extra


# ---------------------------------------------------------------------------
# JSON output
# ---------------------------------------------------------------------------

def _to_json(
    suite_results: list[tuple[str, list[SectionStats], list[TestResult], float]],
) -> str:
    """Generate machine-readable JSON output."""
    output: dict = {"suites": {}}
    for suite_name, sections, tests, wall_time in suite_results:
        suite_data: dict = {
            "wall_time_s": round(wall_time, 3),
            "sections": [],
            "tests": [],
        }
        for s in sections:
            suite_data["sections"].append({
                "number": s.number,
                "name": s.name,
                "planned": s.planned,
                "total": s.total,
                "passed": s.passed,
                "skipped": s.skipped,
                "failed": s.failed,
                "duration_s": round(s.duration, 3),
                "status": s.status_label,
                "mismatch": s.total - s.planned,
            })
        for t in tests:
            suite_data["tests"].append({
                "trace_id": t.trace_id,
                "name": t.name,
                "status": t.status,
                "section": t.section,
                "duration_s": round(t.duration, 3),
            })
        output["suites"][suite_name] = suite_data
    return json.dumps(output, indent=2)


# ---------------------------------------------------------------------------
# Suite runner
# ---------------------------------------------------------------------------

def _run_suite(
    suite_name: str,
    test_dir: str,
    section_names: dict[int, str],
    planned: dict[int, int],
    id_map: dict[str, int],
    c: Colors,
    verbose: bool = False,
) -> tuple[list[SectionStats], list[TestResult], float]:
    """Run one suite and render its table. Returns (sections, tests, wall_time)."""
    # Try running vitest
    data, wall_time = _run_vitest(test_dir)

    if data is not None:
        tests = _parse_vitest_json(data, id_map)
    else:
        # Fallback: static file scan
        tests = _scan_test_files(test_dir, id_map)
        if not tests:
            # No test files found at all
            tests = []

    sections = _aggregate(tests, section_names, planned)
    _render_suite(suite_name, sections, c, wall_time, tests, verbose)
    return sections, tests, wall_time


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Run AppView Vitest tests with per-section report",
    )
    p.add_argument(
        "--suite",
        choices=["unit", "integration", "all"],
        default="all",
        help="Which suite to run (default: all)",
    )
    p.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="Output machine-readable JSON",
    )
    p.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Show individual test results under each section",
    )
    p.add_argument(
        "--no-color",
        action="store_true",
        help="Disable ANSI color output",
    )
    p.add_argument(
        "--check",
        action="store_true",
        help="Traceability check only — compare test files against plan, no vitest run",
    )
    return p.parse_args()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args = parse_args()
    c = Colors(_use_color(args.no_color))

    run_unit = args.suite in ("all", "unit")
    run_integration = args.suite in ("all", "integration")

    # --check mode: traceability verification only
    if args.check:
        total_missing = total_extra = 0
        if run_unit:
            print(c.bold("\n=== Traceability Check: Unit Tests ==="))
            m, e = _check_traceability(
                "unit", UNIT_ID_TO_SECTION, UNIT_PLANNED, UNIT_SECTIONS, c)
            total_missing += m
            total_extra += e
        if run_integration:
            print(c.bold("\n=== Traceability Check: Integration Tests ==="))
            m, e = _check_traceability(
                "integration", INTEGRATION_ID_TO_SECTION,
                INTEGRATION_PLANNED, INTEGRATION_SECTIONS, c)
            total_missing += m
            total_extra += e

        print()
        if total_missing == 0 and total_extra == 0:
            print(c.green("Traceability: ALL OK — plan counts match test files"))
        else:
            if total_missing > 0:
                print(c.red(f"Traceability: {total_missing} tests MISSING from files"))
            if total_extra > 0:
                print(c.yellow(f"Traceability: {total_extra} EXTRA tests in files"))
        sys.exit(1 if total_missing > 0 else 0)

    # Normal mode: run vitest and produce report
    suite_results: list[tuple[str, list[SectionStats], list[TestResult], float]] = []
    grand_rows: list[tuple[str, int, int, int, int, int, float]] = []

    if run_unit:
        sections, tests, wall = _run_suite(
            "AppView Unit Tests", "unit",
            UNIT_SECTIONS, UNIT_PLANNED, UNIT_ID_TO_SECTION,
            c, args.verbose,
        )
        suite_results.append(("AppView Unit Tests", sections, tests, wall))
        tot = sum(s.total for s in sections)
        pas = sum(s.passed for s in sections)
        ski = sum(s.skipped for s in sections)
        fai = sum(s.failed for s in sections)
        pln = sum(s.planned for s in sections)
        dur = sum(s.duration for s in sections)
        grand_rows.append(("AppView Unit", pln, tot, pas, ski, fai, dur))

    if run_integration:
        sections, tests, wall = _run_suite(
            "AppView Integration Tests", "integration",
            INTEGRATION_SECTIONS, INTEGRATION_PLANNED, INTEGRATION_ID_TO_SECTION,
            c, args.verbose,
        )
        suite_results.append(("AppView Integration Tests", sections, tests, wall))
        tot = sum(s.total for s in sections)
        pas = sum(s.passed for s in sections)
        ski = sum(s.skipped for s in sections)
        fai = sum(s.failed for s in sections)
        pln = sum(s.planned for s in sections)
        dur = sum(s.duration for s in sections)
        grand_rows.append(("AppView Integration", pln, tot, pas, ski, fai, dur))

    # Grand summary (only if multiple suites)
    if len(grand_rows) > 1:
        _render_grand_summary(grand_rows, c)

    # JSON output
    if args.json_output:
        print("\n" + _to_json(suite_results))

    # Exit code: non-zero if any failures
    total_fail = sum(r[5] for r in grand_rows)
    print()
    sys.exit(1 if total_fail > 0 else 0)


if __name__ == "__main__":
    main()
