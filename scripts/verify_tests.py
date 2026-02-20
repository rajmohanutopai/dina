#!/usr/bin/env python3
"""Verify test traceability: every plan scenario has test coverage.

Cross-references TEST_PLAN.md IDs against test code references.
Exits 0 if all plan IDs covered, 1 if any gaps.

Usage:
    python scripts/verify_tests.py          # Human-readable output
    python scripts/verify_tests.py --json   # Machine-readable JSON
"""

import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

CONFIGS = [
    {
        "name": "Core",
        "prefix": "TST-CORE",
        "plan": PROJECT_ROOT / "core" / "test" / "TEST_PLAN.md",
        "test_dir": PROJECT_ROOT / "core" / "test",
        "file_glob": "*_test.go",
    },
    {
        "name": "Brain",
        "prefix": "TST-BRAIN",
        "plan": PROJECT_ROOT / "brain" / "tests" / "TEST_PLAN.md",
        "test_dir": PROJECT_ROOT / "brain" / "tests",
        "file_glob": "test_*.py",
    },
]

ID_RE = re.compile(r"TST-(?:CORE|BRAIN)-\d+")


def scan_plan(plan_path, prefix):
    """Extract all IDs from a TEST_PLAN.md file.

    Returns dict: {id_str: line_number}.
    """
    ids = {}
    for lineno, line in enumerate(plan_path.read_text().splitlines(), 1):
        for match in ID_RE.finditer(line):
            tag = match.group()
            if tag.startswith(prefix) and tag not in ids:
                ids[tag] = lineno
    return ids


def scan_code(test_dir, file_glob, prefix):
    """Scan test files for ID references.

    Returns dict: {id_str: [(file_path, line_number), ...]}.
    """
    refs = {}
    for filepath in sorted(test_dir.glob(file_glob)):
        for lineno, line in enumerate(filepath.read_text().splitlines(), 1):
            for match in ID_RE.finditer(line):
                tag = match.group()
                if tag.startswith(prefix):
                    refs.setdefault(tag, []).append(
                        (str(filepath.relative_to(PROJECT_ROOT)), lineno)
                    )
    return refs


def verify_config(config, json_mode=False):
    """Verify one config (Core or Brain). Returns (results, summary)."""
    name = config["name"]
    prefix = config["prefix"]

    plan_ids = scan_plan(config["plan"], prefix)
    code_refs = scan_code(config["test_dir"], config["file_glob"], prefix)

    results = []
    covered = 0
    missing = []

    for tag_id in sorted(plan_ids.keys(), key=lambda x: int(x.rsplit("-", 1)[1])):
        plan_line = plan_ids[tag_id]
        locations = code_refs.get(tag_id, [])
        if locations:
            covered += 1
            results.append({
                "id": tag_id,
                "status": "PASS",
                "plan_line": plan_line,
                "code_locations": locations,
            })
        else:
            missing.append(tag_id)
            results.append({
                "id": tag_id,
                "status": "FAIL",
                "plan_line": plan_line,
                "code_locations": [],
            })

    # Find orphan IDs (in code but not in plan)
    orphans = []
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
        "total": total,
        "covered": covered,
        "missing_count": len(missing),
        "missing_ids": missing,
        "orphan_count": len(orphans),
        "orphans": orphans,
        "coverage_pct": round(pct, 1),
    }

    return results, summary


def print_human(all_results, all_summaries):
    """Print human-readable output."""
    for results, summary in zip(all_results, all_summaries):
        name = summary["name"]
        total = summary["total"]
        covered = summary["covered"]
        pct = summary["coverage_pct"]

        print(f"\n{'=' * 60}")
        print(f"{name}: {covered}/{total} ({pct}%)")
        print(f"{'=' * 60}")

        for r in results:
            tag = r["id"]
            if r["status"] == "PASS":
                loc = r["code_locations"][0]
                extra = f" (+{len(r['code_locations'])-1})" if len(r["code_locations"]) > 1 else ""
                print(f"  [PASS] {tag} -> {loc[0]}:{loc[1]}{extra}")
            else:
                print(f"  [FAIL] {tag} -> NOT FOUND IN CODE")

        if summary["orphans"]:
            print(f"\n  Orphan IDs ({summary['orphan_count']}):")
            for o in summary["orphans"]:
                loc = o["locations"][0]
                print(f"    [WARN] {o['id']} -> {loc[0]}:{loc[1]} (not in plan)")

    # Overall
    total_all = sum(s["total"] for s in all_summaries)
    covered_all = sum(s["covered"] for s in all_summaries)
    missing_all = sum(s["missing_count"] for s in all_summaries)
    pct_all = (covered_all / total_all * 100) if total_all > 0 else 0.0

    print(f"\n{'=' * 60}")
    print(f"OVERALL: {covered_all}/{total_all} ({pct_all:.1f}%) — {missing_all} gaps")
    for s in all_summaries:
        status = "0 missing" if s["missing_count"] == 0 else f"{s['missing_count']} missing"
        print(f"  {s['name']}: {s['covered']}/{s['total']} ({s['coverage_pct']}%) — {status}")
    if missing_all == 0:
        print("  All scenario IDs referenced in test code!")
    else:
        print(f"\n  Missing IDs ({missing_all}):")
        for s in all_summaries:
            for mid in s["missing_ids"]:
                print(f"    {mid}")
    print(f"{'=' * 60}")


def main():
    json_mode = "--json" in sys.argv

    all_results = []
    all_summaries = []

    for config in CONFIGS:
        if not config["plan"].exists():
            print(f"ERROR: Plan not found: {config['plan']}", file=sys.stderr)
            sys.exit(2)

        results, summary = verify_config(config, json_mode)
        all_results.append(results)
        all_summaries.append(summary)

    if json_mode:
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
    else:
        print_human(all_results, all_summaries)

    # Exit code: 0 if all covered, 1 if gaps
    has_gaps = any(s["missing_count"] > 0 for s in all_summaries)
    sys.exit(1 if has_gaps else 0)


if __name__ == "__main__":
    main()
