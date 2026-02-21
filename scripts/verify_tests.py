#!/usr/bin/env python3
"""Verify test traceability: every plan scenario has test coverage.

Cross-references TEST_PLAN.md IDs against test code references.
Exits 0 if all plan IDs covered, 1 if any gaps.

Usage:
    python scripts/verify_tests.py                    # All 4 suites
    python scripts/verify_tests.py --suite core       # Core only
    python scripts/verify_tests.py --suite integration # Integration only
    python scripts/verify_tests.py --section 8        # Section 8 across all suites
    python scripts/verify_tests.py --suite integration --section 8  # §8 integration
    python scripts/verify_tests.py --json             # Machine-readable JSON
    python scripts/verify_tests.py --run-cmd          # Show commands to run matching tests
"""

import json
import os
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Suite configs
# ---------------------------------------------------------------------------

CONFIGS = [
    {
        "name": "Core",
        "key": "core",
        "prefix": "TST-CORE",
        "plan": PROJECT_ROOT / "core" / "test" / "TEST_PLAN.md",
        "test_dir": PROJECT_ROOT / "core" / "test",
        "file_glob": "*_test.go",
        "manifest": None,  # uses plan scanning
        "lang": "go",
    },
    {
        "name": "Brain",
        "key": "brain",
        "prefix": "TST-BRAIN",
        "plan": PROJECT_ROOT / "brain" / "tests" / "TEST_PLAN.md",
        "test_dir": PROJECT_ROOT / "brain" / "tests",
        "file_glob": "test_*.py",
        "manifest": None,
        "lang": "python",
    },
    {
        "name": "E2E",
        "key": "e2e",
        "prefix": "TST-E2E",
        "plan": PROJECT_ROOT / "tests" / "E2E_TEST_PLAN.md",
        "test_dir": None,  # no test code yet
        "file_glob": None,
        "manifest": PROJECT_ROOT / "tests" / "e2e_manifest.json",
        "lang": "python",
    },
    {
        "name": "Integration",
        "key": "integration",
        "prefix": "TST-INT",
        "plan": PROJECT_ROOT / "tests" / "INTEGRATION_TEST_PLAN.md",
        "test_dir": PROJECT_ROOT / "tests" / "integration",
        "file_glob": "test_*.py",
        "manifest": PROJECT_ROOT / "tests" / "integration_manifest.json",
        "lang": "python",
    },
]

ID_RE = re.compile(r"TST-(?:CORE|BRAIN|E2E|INT)-\d+")
GO_FUNC_RE = re.compile(r"^\s*func\s+(Test\w+)")
PY_FUNC_RE = re.compile(r"^\s*(?:async\s+)?def\s+(test_\w+)")


# ---------------------------------------------------------------------------
# Scanning
# ---------------------------------------------------------------------------

def scan_plan(plan_path, prefix):
    """Extract all IDs from a test plan markdown file.

    Returns dict: {id_str: {"line": lineno, "section": section_path}}.
    """
    ids = {}
    current_section = ""
    for lineno, line in enumerate(plan_path.read_text().splitlines(), 1):
        # Track section headers (### 8.1 ... or ## 8 ...)
        sec_match = re.match(r"^#{2,4}\s+(\d+(?:\.\d+)*)", line)
        if sec_match:
            current_section = sec_match.group(1)
        for match in ID_RE.finditer(line):
            tag = match.group()
            if tag.startswith(prefix) and tag not in ids:
                ids[tag] = {"line": lineno, "section": current_section}
    return ids


def scan_plan_from_manifest(manifest_path, prefix):
    """Extract IDs from a manifest JSON file (E2E / Integration).

    Returns dict: {id_str: {"line": lineno, "section": section_path, "scenario": text}}.
    """
    ids = {}
    with open(manifest_path) as f:
        data = json.load(f)
    for tag, info in data.get("scenarios", {}).items():
        if tag.startswith(prefix):
            ids[tag] = {
                "line": info.get("line", 0),
                "section": str(info.get("path", info.get("suite", ""))),
                "scenario": info.get("scenario", ""),
            }
    return ids


def scan_code(test_dir, file_glob, prefix):
    """Scan test files for ID references.

    Returns dict: {id_str: [{"file": rel_path, "line": lineno, "func": func_name}, ...]}.
    """
    if test_dir is None:
        return {}

    refs = {}
    for filepath in sorted(test_dir.glob(file_glob)):
        lines = filepath.read_text().splitlines()
        for lineno_0, line in enumerate(lines):
            for match in ID_RE.finditer(line):
                tag = match.group()
                if not tag.startswith(prefix):
                    continue
                # Find the test function near this comment
                func_name = _find_func_near(lines, lineno_0, filepath.suffix)
                refs.setdefault(tag, []).append({
                    "file": str(filepath.relative_to(PROJECT_ROOT)),
                    "line": lineno_0 + 1,
                    "func": func_name,
                })
    return refs


def _find_func_near(lines, comment_line, ext):
    """Find the test function name near a TST-xxx comment line."""
    func_re = GO_FUNC_RE if ext == ".go" else PY_FUNC_RE
    # Look forward up to 5 lines for the function definition
    for i in range(comment_line, min(comment_line + 6, len(lines))):
        m = func_re.match(lines[i])
        if m:
            return m.group(1)
    # Look backward up to 3 lines (comment might be inside the function)
    for i in range(comment_line - 1, max(comment_line - 4, -1), -1):
        m = func_re.match(lines[i])
        if m:
            return m.group(1)
    return None


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

def verify_config(config, section_filter=None):
    """Verify one config. Returns (results, summary)."""
    name = config["name"]
    prefix = config["prefix"]

    # Get plan IDs
    if config["manifest"] and config["manifest"].exists():
        plan_ids = scan_plan_from_manifest(config["manifest"], prefix)
    else:
        plan_ids = scan_plan(config["plan"], prefix)

    # Apply section filter
    if section_filter:
        plan_ids = {
            tag: info for tag, info in plan_ids.items()
            if info["section"].startswith(section_filter)
        }

    # Get code references
    code_refs = scan_code(config["test_dir"], config["file_glob"], prefix)

    results = []
    covered = 0
    missing = []

    for tag_id in sorted(plan_ids.keys(), key=lambda x: int(x.rsplit("-", 1)[1])):
        info = plan_ids[tag_id]
        locations = code_refs.get(tag_id, [])
        scenario = info.get("scenario", "")
        section = info.get("section", "")

        if locations:
            covered += 1
            results.append({
                "id": tag_id,
                "status": "PASS",
                "plan_line": info["line"],
                "section": section,
                "scenario": scenario,
                "code_locations": locations,
            })
        else:
            missing.append(tag_id)
            results.append({
                "id": tag_id,
                "status": "FAIL",
                "plan_line": info["line"],
                "section": section,
                "scenario": scenario,
                "code_locations": [],
            })

    # Find orphan IDs (in code but not in plan) — only if no section filter
    orphans = []
    if not section_filter:
        for tag_id in sorted(code_refs.keys(), key=lambda x: int(x.rsplit("-", 1)[1])):
            if tag_id not in plan_ids:
                orphans.append({
                    "id": tag_id,
                    "locations": code_refs[tag_id],
                })

    total = len(plan_ids)
    pct = (covered / total * 100) if total > 0 else 0.0

    summary = {
        "name": name,
        "key": config["key"],
        "lang": config["lang"],
        "total": total,
        "covered": covered,
        "missing_count": len(missing),
        "missing_ids": missing,
        "orphan_count": len(orphans),
        "orphans": orphans,
        "coverage_pct": round(pct, 1),
    }

    return results, summary


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def print_human(all_results, all_summaries, show_run_cmd=False):
    """Print human-readable output."""
    for results, summary in zip(all_results, all_summaries):
        name = summary["name"]
        total = summary["total"]
        covered = summary["covered"]
        pct = summary["coverage_pct"]

        if total == 0:
            continue

        print(f"\n{'=' * 80}")
        print(f"{name}: {covered}/{total} ({pct}%)")
        print(f"{'=' * 80}")

        for r in results:
            tag = r["id"]
            section = r.get("section", "")
            scenario = r.get("scenario", "")
            section_str = f" §{section}" if section else ""

            if r["status"] == "PASS":
                loc = r["code_locations"][0]
                func = loc["func"] or "?"
                extra = f" (+{len(r['code_locations'])-1})" if len(r["code_locations"]) > 1 else ""
                print(f"  [PASS] {tag}{section_str} -> {func} ({loc['file']}:{loc['line']}){extra}")
                if scenario:
                    print(f"         plan: {scenario[:70]}")
            else:
                print(f"  [FAIL] {tag}{section_str} -> NOT FOUND IN CODE")
                if scenario:
                    print(f"         plan: {scenario[:70]}")

        if summary["orphans"]:
            print(f"\n  Orphan IDs ({summary['orphan_count']}):")
            for o in summary["orphans"]:
                loc = o["locations"][0]
                func = loc.get("func", "?")
                print(f"    [WARN] {o['id']} -> {func} ({loc['file']}:{loc['line']}) (not in plan)")

        # Show run commands for this suite
        if show_run_cmd and covered > 0:
            _print_run_commands(results, summary)

    # Overall
    total_all = sum(s["total"] for s in all_summaries)
    covered_all = sum(s["covered"] for s in all_summaries)
    missing_all = sum(s["missing_count"] for s in all_summaries)
    pct_all = (covered_all / total_all * 100) if total_all > 0 else 0.0

    print(f"\n{'=' * 80}")
    print(f"OVERALL: {covered_all}/{total_all} ({pct_all:.1f}%) — {missing_all} gaps")
    for s in all_summaries:
        if s["total"] == 0:
            continue
        status = "0 missing" if s["missing_count"] == 0 else f"{s['missing_count']} missing"
        print(f"  {s['name']}: {s['covered']}/{s['total']} ({s['coverage_pct']}%) — {status}")
    if missing_all == 0:
        print("  All scenario IDs have test code!")
    else:
        print(f"\n  Missing IDs ({missing_all}):")
        for s in all_summaries:
            for mid in s["missing_ids"]:
                print(f"    {mid}")
    print(f"{'=' * 80}")


def _print_run_commands(results, summary):
    """Print the commands to run matching tests."""
    lang = summary["lang"]
    funcs_by_file = {}

    for r in results:
        if r["status"] != "PASS":
            continue
        for loc in r["code_locations"]:
            if loc["func"]:
                funcs_by_file.setdefault(loc["file"], set()).add(loc["func"])

    if not funcs_by_file:
        return

    print(f"\n  Run commands for {summary['name']}:")

    if lang == "go":
        all_funcs = set()
        for funcs in funcs_by_file.values():
            all_funcs.update(funcs)
        pattern = "|".join(sorted(all_funcs))
        print(f"    cd core && go test ./test/... -run '{pattern}' -v")
    elif lang == "python":
        # Group by file, show pytest -k for function names
        for filepath, funcs in sorted(funcs_by_file.items()):
            func_pattern = " or ".join(sorted(funcs))
            print(f"    pytest {filepath} -k '{func_pattern}' -v")


def print_json(all_results, all_summaries):
    """Print machine-readable JSON."""
    output = {
        "configs": [
            {"results": results, "summary": summary}
            for results, summary in zip(all_results, all_summaries)
        ],
        "overall": {
            "total": sum(s["total"] for s in all_summaries),
            "covered": sum(s["covered"] for s in all_summaries),
            "missing": sum(s["missing_count"] for s in all_summaries),
            "coverage_pct": round(
                sum(s["covered"] for s in all_summaries)
                / max(sum(s["total"] for s in all_summaries), 1)
                * 100,
                1,
            ),
        },
    }
    json.dump(output, sys.stdout, indent=2)
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args(argv):
    """Parse CLI args. Returns (suite_filter, section_filter, json_mode, run_cmd)."""
    suite_filter = None
    section_filter = None
    json_mode = False
    run_cmd = False

    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg == "--json":
            json_mode = True
        elif arg == "--run-cmd":
            run_cmd = True
        elif arg == "--suite" and i + 1 < len(argv):
            i += 1
            suite_filter = argv[i].lower()
        elif arg == "--section" and i + 1 < len(argv):
            i += 1
            section_filter = argv[i]
        elif arg == "--help":
            print(__doc__)
            sys.exit(0)
        i += 1

    return suite_filter, section_filter, json_mode, run_cmd


def main():
    suite_filter, section_filter, json_mode, run_cmd = parse_args(sys.argv)

    configs = CONFIGS
    if suite_filter:
        configs = [c for c in configs if c["key"] == suite_filter]
        if not configs:
            valid = ", ".join(c["key"] for c in CONFIGS)
            print(f"ERROR: Unknown suite '{suite_filter}'. Valid: {valid}", file=sys.stderr)
            sys.exit(2)

    all_results = []
    all_summaries = []

    for config in configs:
        if not config["plan"].exists():
            print(f"WARNING: Plan not found: {config['plan']}", file=sys.stderr)
            continue

        results, summary = verify_config(config, section_filter)
        all_results.append(results)
        all_summaries.append(summary)

    if not all_summaries:
        print("No test suites found.", file=sys.stderr)
        sys.exit(2)

    if json_mode:
        print_json(all_results, all_summaries)
    else:
        print_human(all_results, all_summaries, show_run_cmd=run_cmd)

    # Exit code: 0 if all covered, 1 if gaps
    has_gaps = any(s["missing_count"] > 0 for s in all_summaries)
    sys.exit(1 if has_gaps else 0)


if __name__ == "__main__":
    main()
