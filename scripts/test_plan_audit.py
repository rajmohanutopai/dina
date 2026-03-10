#!/usr/bin/env python3
"""
Dina Test Plan Audit — Programmatic reconciliation of test plans vs test code.

Usage:
    python scripts/test_plan_audit.py                 # Full audit, generates test_cases_listing.md
    python scripts/test_plan_audit.py --summary       # Summary table only (stdout)
    python scripts/test_plan_audit.py --orphans        # Show test functions with no plan entry
    python scripts/test_plan_audit.py --unimplemented  # Show plan entries with no test function
    python scripts/test_plan_audit.py --json           # Machine-readable JSON output

Cross-references:
  1. Test plan entries (TST-CORE-*, TST-BRAIN-*, TST-INT-*, TST-E2E-*, REL-*,
     UT-*-*, IT-*-*) from markdown
  2. Test functions (func Test*, def test_*, it('ID:...')) from code
  3. Plan IDs referenced in code comments (// TST-CORE-NNN, # TST-BRAIN-NNN)
     or embedded in Vitest it() names (UT-TS-001, IT-ATT-001)

Produces a reconciled test_cases_listing.md with accurate implementation status.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional


# ── Project root ──────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent.parent


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class PlanEntry:
    """A test scenario defined in a test plan markdown file."""
    test_id: str           # TST-CORE-001, TST-BRAIN-042, REL-005, UST-07, etc.
    scenario: str          # Human-readable scenario name
    section: str           # Section/subsection in the test plan
    plan_file: str         # Relative path to the test plan .md
    tier: str              # core, brain, integration, e2e, release, user_story
    implemented: bool = False  # Set True if a code reference is found
    deferred: bool = False     # Phase 2+ / not scheduled for Phase 1
    manual: bool = False       # Requires human judgment
    code_refs: list = field(default_factory=list)  # List of (file, line, func) tuples


@dataclass
class CodeTest:
    """A test function found in source code."""
    file: str              # Relative path to test file
    line: int              # Line number
    func_name: str         # Function/method name
    plan_ids: list = field(default_factory=list)  # TST-* IDs from comments
    tier: str = ""         # core, brain, integration, e2e, release, cli
    is_subtest: bool = False  # Go t.Run() subtest


# ── 1. Extract plan entries from markdown ─────────────────────────────────────

def extract_plan_entries() -> list[PlanEntry]:
    """Read all test plan .md files and extract every TST-*/REL-* entry."""
    entries = []

    # Core
    entries.extend(_extract_tst_entries(
        ROOT / "core" / "test" / "TEST_PLAN.md",
        "core/test/TEST_PLAN.md", r"TST-CORE-\d+", "core"
    ))

    # Brain
    entries.extend(_extract_tst_entries(
        ROOT / "brain" / "tests" / "TEST_PLAN.md",
        "brain/tests/TEST_PLAN.md", r"TST-BRAIN-\d+", "brain"
    ))

    # Integration
    entries.extend(_extract_tst_entries(
        ROOT / "tests" / "INTEGRATION_TEST_PLAN.md",
        "tests/INTEGRATION_TEST_PLAN.md", r"TST-INT-\d+", "integration"
    ))

    # E2E
    entries.extend(_extract_e2e_entries(
        ROOT / "tests" / "E2E_TEST_PLAN.md",
        "tests/E2E_TEST_PLAN.md"
    ))

    # Release
    entries.extend(_extract_release_entries(
        ROOT / "RELEASE_TEST_PLAN.md",
        "RELEASE_TEST_PLAN.md"
    ))

    # CLI
    entries.extend(_extract_tst_entries(
        ROOT / "cli" / "tests" / "TEST_PLAN.md",
        "cli/tests/TEST_PLAN.md", r"TST-CLI-\d+", "cli"
    ))

    # User Stories
    entries.extend(_extract_tst_entries(
        ROOT / "tests" / "system" / "user_stories" / "TEST_PLAN.md",
        "tests/system/user_stories/TEST_PLAN.md", r"TST-USR-\d+", "user_story"
    ))

    # AppView Unit
    entries.extend(_extract_appview_plan_entries(
        ROOT / "appview" / "UNIT_TEST_PLAN.md",
        "appview/UNIT_TEST_PLAN.md", r"UT-[A-Z]+-\d+", "appview_unit"
    ))

    # AppView Integration (section codes may include digits like E2E, and IDs may have letter suffixes like 010a)
    entries.extend(_extract_appview_plan_entries(
        ROOT / "appview" / "INTEGRATION_TEST_PLAN.md",
        "appview/INTEGRATION_TEST_PLAN.md", r"IT-[A-Z0-9]+-\d+[a-z]?", "appview_int"
    ))

    return entries


def _extract_tst_entries(filepath: Path, rel_path: str, id_pattern: str, tier: str) -> list[PlanEntry]:
    """Extract TST-* entries from a standard test plan markdown."""
    entries = []
    if not filepath.exists():
        return entries

    content = filepath.read_text()
    lines = content.split("\n")

    current_section = ""
    current_subsection = ""

    for line in lines:
        # Track section headers: ## N. Title
        m = re.match(r"^## (\d+)\.\s+(.+)", line)
        if m:
            current_section = f"§{m.group(1)}. {m.group(2).strip()}"
            current_subsection = ""
            continue

        # Track subsection headers: ### N.N Title
        m = re.match(r"^### (\d+\.\d+)\s+(.+)", line)
        if m:
            current_subsection = f"§{m.group(1)} {m.group(2).strip()}"
            continue

        # Extract test IDs from table rows
        m = re.search(rf"\*\*\[({id_pattern})\]\*\*\s+(.+?)(?:\s*\|)", line)
        if m:
            test_id = m.group(1)
            scenario = m.group(2).strip()
            section = current_subsection or current_section

            is_deferred = "deferred" in section.lower() or "phase 2" in section.lower()

            entries.append(PlanEntry(
                test_id=test_id,
                scenario=scenario,
                section=section,
                plan_file=rel_path,
                tier=tier,
                deferred=is_deferred,
            ))

    return entries


def _extract_e2e_entries(filepath: Path, rel_path: str) -> list[PlanEntry]:
    """Extract TST-E2E-* entries (uses #### E2E-N.N format)."""
    entries = []
    if not filepath.exists():
        return entries

    content = filepath.read_text()
    current_suite = ""

    for line in content.split("\n"):
        # Suite headers: ### Suite N: Title  or  ## Suite N: Title
        m = re.match(r"^#{2,3}\s+Suite (\d+):\s+(.+)", line)
        if m:
            current_suite = f"Suite {m.group(1)}: {m.group(2).strip()}"
            continue

        # Scenario: #### E2E-N.N: **[TST-E2E-NNN]** Scenario Name
        m = re.search(r"E2E-\d+\.\d+.*?\*\*\[(TST-E2E-\d+)\]\*\*\s+(.+)", line)
        if m:
            test_id = m.group(1)
            scenario = m.group(2).strip()
            entries.append(PlanEntry(
                test_id=test_id,
                scenario=scenario,
                section=current_suite,
                plan_file=rel_path,
                tier="e2e",
            ))

    return entries


def _extract_release_entries(filepath: Path, rel_path: str) -> list[PlanEntry]:
    """Extract REL-NNN entries."""
    entries = []
    if not filepath.exists():
        return entries

    content = filepath.read_text()
    for m in re.finditer(r"^## (REL-\d{3})\s+(.+)", content, re.MULTILINE):
        rel_id = m.group(1)
        title = m.group(2).strip()
        num = int(rel_id.split("-")[1])
        entries.append(PlanEntry(
            test_id=rel_id,
            scenario=title,
            section="Release Scenarios",
            plan_file=rel_path,
            tier="release",
            manual=(num in (13, 14)),
        ))

    return entries


def _extract_appview_plan_entries(filepath: Path, rel_path: str, id_pattern: str, tier: str) -> list[PlanEntry]:
    """Extract UT-*/IT-* entries from AppView test plan markdown (table format: | ID | Name | ...)."""
    entries = []
    if not filepath.exists():
        return entries

    content = filepath.read_text()
    lines = content.split("\n")

    current_section = ""
    current_subsection = ""

    for line in lines:
        # Track section headers: ## §N — Title
        m = re.match(r"^## (§\d+)\s*[—–-]\s*(.+)", line)
        if m:
            current_section = f"{m.group(1)} {m.group(2).strip()}"
            current_subsection = ""
            continue

        # Track subsection headers: ### §N.N Title
        m = re.match(r"^### (§\d+\.\d+)\s+(.+)", line)
        if m:
            current_subsection = f"{m.group(1)} {m.group(2).strip()}"
            continue

        # Extract test IDs from table rows: | UT-TS-001 | name | ... |
        m = re.match(rf"^\|\s*({id_pattern})\s*\|(.+?)(?:\|)", line)
        if m:
            test_id = m.group(1)
            scenario = m.group(2).strip()
            section = current_subsection or current_section

            entries.append(PlanEntry(
                test_id=test_id,
                scenario=scenario,
                section=section,
                plan_file=rel_path,
                tier=tier,
            ))

    return entries


# ── 2. Extract test functions from code ───────────────────────────────────────

def extract_code_tests() -> list[CodeTest]:
    """Scan all test files and extract test functions + plan ID references."""
    tests = []

    # Go Core tests
    tests.extend(_extract_go_tests())

    # Python tests (brain, integration, e2e, release, cli)
    tests.extend(_extract_python_tests(ROOT / "brain" / "tests", "brain"))
    tests.extend(_extract_python_tests(ROOT / "tests" / "integration", "integration"))
    tests.extend(_extract_python_tests(ROOT / "tests" / "e2e", "e2e"))
    tests.extend(_extract_python_tests(ROOT / "tests" / "release", "release"))
    tests.extend(_extract_python_tests(ROOT / "cli" / "tests", "cli"))
    tests.extend(_extract_python_tests(ROOT / "tests" / "system" / "user_stories", "user_story"))

    # TypeScript AppView tests (Vitest — IDs embedded in it() name strings)
    tests.extend(_extract_typescript_tests(ROOT / "appview" / "tests" / "unit", "appview_unit"))
    tests.extend(_extract_typescript_tests(ROOT / "appview" / "tests" / "integration", "appview_int"))

    return tests


def _extract_go_tests() -> list[CodeTest]:
    """Extract Go test functions and t.Run() subtests from core/."""
    tests = []
    go_test_files = list((ROOT / "core").rglob("*_test.go"))

    for fpath in go_test_files:
        rel = str(fpath.relative_to(ROOT))
        try:
            content = fpath.read_text()
        except Exception:
            continue

        lines = content.split("\n")
        pending_ids = []  # IDs from comment lines above a function

        for i, line in enumerate(lines, 1):
            # Collect TST-CORE-* IDs from comments
            id_matches = re.findall(r"TST-CORE-\d+", line)
            if id_matches and line.strip().startswith("//"):
                pending_ids.extend(id_matches)
                continue

            # Top-level test function
            m = re.match(r"^func (Test\w+)\(", line)
            if m:
                tests.append(CodeTest(
                    file=rel, line=i, func_name=m.group(1),
                    plan_ids=list(set(pending_ids)), tier="core"
                ))
                pending_ids = []
                continue

            # t.Run() subtest
            m = re.search(r't\.Run\("([^"]+)"', line)
            if m:
                subtest_name = m.group(1)
                # Check for inline TST-CORE-* comment
                inline_ids = re.findall(r"TST-CORE-\d+", line)
                tests.append(CodeTest(
                    file=rel, line=i, func_name=f"  └ {subtest_name}",
                    plan_ids=inline_ids, tier="core", is_subtest=True
                ))
                continue

            # Reset pending IDs if we hit a non-comment, non-blank line
            if line.strip() and not line.strip().startswith("//"):
                pending_ids = []

    return tests


def _extract_python_tests(test_dir: Path, tier: str) -> list[CodeTest]:
    """Extract Python test functions and plan ID references."""
    tests = []
    if not test_dir.exists():
        return tests

    py_files = list(test_dir.rglob("test_*.py"))
    # Also catch conftest for fixtures
    # py_files.extend(test_dir.rglob("conftest.py"))

    for fpath in py_files:
        rel = str(fpath.relative_to(ROOT))
        try:
            content = fpath.read_text()
        except Exception:
            continue

        lines = content.split("\n")
        pending_ids = []
        current_class = ""
        decorator_depth = 0  # Track multi-line decorator paren nesting

        for i, line in enumerate(lines, 1):
            stripped = line.strip()

            # Track multi-line decorators via paren depth
            if stripped.startswith("@"):
                depth = stripped.count("(") - stripped.count(")")
                if depth > 0:
                    decorator_depth = depth
                # Single-line or balanced decorator — skip, preserve pending_ids
                continue
            if decorator_depth > 0:
                decorator_depth += stripped.count("(") - stripped.count(")")
                continue

            # Track class context
            m = re.match(r"^class (Test\w+)", line)
            if m:
                current_class = m.group(1)
                continue

            # Collect plan IDs from comments
            id_pattern = _id_pattern_for_tier(tier)
            if id_pattern:
                id_matches = re.findall(id_pattern, line)
                if id_matches and stripped.startswith("#"):
                    pending_ids.extend(id_matches)
                    continue

            # Test function (standalone or method)
            m = re.match(r"^(\s*)(?:async\s+)?def (test_\w+)\(", line)
            if m:
                indent = len(m.group(1))
                func_name = m.group(2)
                if indent > 0 and current_class:
                    func_name = f"{current_class}.{func_name}"

                tests.append(CodeTest(
                    file=rel, line=i, func_name=func_name,
                    plan_ids=list(set(pending_ids)), tier=tier
                ))
                pending_ids = []
                continue

            # Reset pending IDs on non-comment, non-blank lines
            if stripped and not stripped.startswith("#"):
                pending_ids = []

    return tests


def _extract_typescript_tests(test_dir: Path, tier: str) -> list[CodeTest]:
    """Extract Vitest test functions from TypeScript .test.ts files.

    IDs are embedded in test names: it('UT-TS-001: description', ...)
    """
    tests = []
    if not test_dir.exists():
        return tests

    ts_files = sorted(test_dir.glob("*.test.ts"))
    id_pattern = _id_pattern_for_tier(tier)

    for fpath in ts_files:
        rel = str(fpath.relative_to(ROOT))
        try:
            content = fpath.read_text()
        except Exception:
            continue

        lines = content.split("\n")
        current_describe = ""

        for i, line in enumerate(lines, 1):
            stripped = line.strip()

            # Track describe blocks
            m = re.search(r"describe\(['\"](.+?)['\"]", stripped)
            if m:
                current_describe = m.group(1)
                continue

            # Extract test IDs from it() calls
            m = re.search(r"it\(['\"](.+?)['\"]", stripped)
            if m:
                test_name = m.group(1)
                plan_ids = re.findall(id_pattern, test_name) if id_pattern else []

                func_name = test_name
                if current_describe:
                    func_name = f"{current_describe} > {test_name}"

                tests.append(CodeTest(
                    file=rel, line=i, func_name=func_name,
                    plan_ids=plan_ids, tier=tier
                ))

    return tests


def _id_pattern_for_tier(tier: str) -> Optional[str]:
    """Return regex pattern for plan IDs in a given tier."""
    return {
        "brain": r"TST-BRAIN-\d+",
        "integration": r"TST-INT-\d+",
        "e2e": r"TST-E2E-\d+",
        "release": r"REL-\d{3}",
        "cli": r"TST-CLI-\d+",
        "user_story": r"TST-USR-\d+",
        "appview_unit": r"UT-[A-Z]+-\d+",
        "appview_int": r"IT-[A-Z0-9]+-\d+[a-z]?",
    }.get(tier)


# ── 3. Cross-reference plan ↔ code ────────────────────────────────────────────

def reconcile(plan_entries: list[PlanEntry], code_tests: list[CodeTest]) -> dict:
    """Cross-reference plan entries with code tests."""

    # Build lookup: plan_id → list of PlanEntry (handles duplicate IDs across sections)
    plan_by_id = defaultdict(list)
    for entry in plan_entries:
        plan_by_id[entry.test_id].append(entry)

    # Build lookup: plan_id → list of CodeTest
    code_by_plan_id = defaultdict(list)
    orphan_tests = []  # Code tests with no plan reference

    for ct in code_tests:
        if ct.plan_ids:
            for pid in ct.plan_ids:
                code_by_plan_id[pid].append(ct)
        elif not ct.is_subtest:
            orphan_tests.append(ct)

    # Mark plan entries as implemented if code references exist
    for pid, entries in plan_by_id.items():
        if pid in code_by_plan_id:
            refs = [
                (ct.file, ct.line, ct.func_name)
                for ct in code_by_plan_id[pid]
            ]
            for entry in entries:
                entry.implemented = True
                entry.code_refs = refs

    # Plan entries with no code reference
    unimplemented = [e for e in plan_entries if not e.implemented and not e.deferred and not e.manual]
    implemented = [e for e in plan_entries if e.implemented]
    deferred = [e for e in plan_entries if e.deferred]
    manual = [e for e in plan_entries if e.manual]

    # Count actual test functions (not subtests) per tier
    func_counts = defaultdict(int)
    subtest_counts = defaultdict(int)
    for ct in code_tests:
        if ct.is_subtest:
            subtest_counts[ct.tier] += 1
        else:
            func_counts[ct.tier] += 1

    return {
        "plan_entries": plan_entries,
        "code_tests": code_tests,
        "implemented": implemented,
        "unimplemented": unimplemented,
        "deferred": deferred,
        "manual": manual,
        "orphan_tests": orphan_tests,
        "func_counts": dict(func_counts),
        "subtest_counts": dict(subtest_counts),
        "code_by_plan_id": code_by_plan_id,
    }


# ── 4. Output formatters ─────────────────────────────────────────────────────

def print_summary(result: dict):
    """Print summary table to stdout."""
    plan_entries = result["plan_entries"]
    func_counts = result["func_counts"]
    subtest_counts = result["subtest_counts"]

    # Group plan entries by tier
    by_tier = defaultdict(lambda: {"total": 0, "implemented": 0, "unimplemented": 0, "deferred": 0, "manual": 0})
    for e in plan_entries:
        t = by_tier[e.tier]
        t["total"] += 1
        if e.deferred:
            t["deferred"] += 1
        elif e.manual:
            t["manual"] += 1
        elif e.implemented:
            t["implemented"] += 1
        else:
            t["unimplemented"] += 1

    plan_files = {
        "core": "core/test/TEST_PLAN.md",
        "brain": "brain/tests/TEST_PLAN.md",
        "integration": "tests/INTEGRATION_TEST_PLAN.md",
        "e2e": "tests/E2E_TEST_PLAN.md",
        "release": "RELEASE_TEST_PLAN.md",
        "cli": "cli/tests/TEST_PLAN.md",
        "user_story": "tests/system/user_stories/TEST_PLAN.md",
        "appview_unit": "appview/UNIT_TEST_PLAN.md",
        "appview_int": "appview/INTEGRATION_TEST_PLAN.md",
    }

    tier_labels = {
        "core": "Core (Unit)",
        "brain": "Brain (Unit)",
        "integration": "Integration",
        "e2e": "E2E",
        "release": "Release",
        "cli": "CLI",
        "user_story": "User Stories",
        "appview_unit": "AppView (Unit)",
        "appview_int": "AppView (Int)",
    }

    print()
    print("═══ Test Plan Audit ═══")
    print()
    print(f"{'Tier':<16} │ {'Plan':<10} │ {'Test Plan':>40} │ {'Code':>6} │ {'Subtests':>8} │ {'Impl':>6} │ {'Unimpl':>6} │ {'Defer':>5} │ {'Manual':>6}")
    print(f"{'─'*16}─┼─{'─'*10}─┼─{'─'*40}─┼─{'─'*6}─┼─{'─'*8}─┼─{'─'*6}─┼─{'─'*6}─┼─{'─'*5}─┼─{'─'*6}")

    tier_order = ["core", "brain", "integration", "e2e", "release", "cli", "user_story", "appview_unit", "appview_int"]
    grand = {"plan": 0, "code": 0, "subtests": 0, "impl": 0, "unimpl": 0, "defer": 0, "manual": 0}

    for tier in tier_order:
        t = by_tier.get(tier, {"total": 0, "implemented": 0, "unimplemented": 0, "deferred": 0, "manual": 0})
        code_count = func_counts.get(tier, 0)
        sub_count = subtest_counts.get(tier, 0)
        plan_file = plan_files.get(tier, "—")
        label = tier_labels.get(tier, tier)

        print(f"{label:<16} │ {t['total']:>10} │ {plan_file:>40} │ {code_count:>6} │ {sub_count:>8} │ {t['implemented']:>6} │ {t['unimplemented']:>6} │ {t['deferred']:>5} │ {t['manual']:>6}")

        grand["plan"] += t["total"]
        grand["code"] += code_count
        grand["subtests"] += sub_count
        grand["impl"] += t["implemented"]
        grand["unimpl"] += t["unimplemented"]
        grand["defer"] += t["deferred"]
        grand["manual"] += t["manual"]

    print(f"{'─'*16}─┼─{'─'*10}─┼─{'─'*40}─┼─{'─'*6}─┼─{'─'*8}─┼─{'─'*6}─┼─{'─'*6}─┼─{'─'*5}─┼─{'─'*6}")
    print(f"{'TOTAL':<16} │ {grand['plan']:>10} │ {'':>40} │ {grand['code']:>6} │ {grand['subtests']:>8} │ {grand['impl']:>6} │ {grand['unimpl']:>6} │ {grand['defer']:>5} │ {grand['manual']:>6}")
    print()
    print("Columns:")
    print("  Plan     = Test scenarios defined in test plan markdown files")
    print("  Code     = Top-level test functions in source code (def test_* / func Test*)")
    print("  Subtests = Go t.Run() subtests (counted separately by test runner)")
    print("  Impl     = Plan entries with matching code reference (# TST-* comment)")
    print("  Unimpl   = Plan entries with NO code reference (not deferred, not manual)")
    print("  Defer    = Phase 2+ / not scheduled for Phase 1")
    print("  Manual   = Requires human judgment — no automated test expected")
    print()
    orphans = result["orphan_tests"]
    print(f"Orphan test functions (code exists, no plan ID in comments): {len(orphans)}")
    print()


def print_orphans(result: dict):
    """Print test functions that have no plan ID reference."""
    orphans = result["orphan_tests"]
    if not orphans:
        print("No orphan test functions found.")
        return

    by_tier = defaultdict(list)
    for ct in orphans:
        by_tier[ct.tier].append(ct)

    for tier in sorted(by_tier.keys()):
        tests = by_tier[tier]
        print(f"\n═══ {tier.upper()} — {len(tests)} orphan test functions ═══\n")
        for ct in sorted(tests, key=lambda x: (x.file, x.line)):
            print(f"  {ct.file}:{ct.line}  {ct.func_name}")


def print_unimplemented(result: dict):
    """Print plan entries that have no code reference."""
    unimpl = result["unimplemented"]
    if not unimpl:
        print("All plan entries are implemented!")
        return

    by_tier = defaultdict(list)
    for e in unimpl:
        by_tier[e.tier].append(e)

    for tier in ["core", "brain", "integration", "e2e", "release", "cli", "user_story", "appview_unit", "appview_int"]:
        entries = by_tier.get(tier, [])
        if not entries:
            continue
        print(f"\n═══ {tier.upper()} — {len(entries)} unimplemented plan entries ═══\n")
        for e in entries:
            print(f"  {e.test_id:<16} {e.scenario[:70]}")
            print(f"  {'':16} Section: {e.section}")
            print(f"  {'':16} Plan:    {e.plan_file}")
            print()


def generate_listing(result: dict):
    """Generate test_cases_listing.md with full reconciliation."""
    plan_entries = result["plan_entries"]
    func_counts = result["func_counts"]
    subtest_counts = result["subtest_counts"]
    orphan_tests = result["orphan_tests"]

    out = []
    out.append("# Dina — Test Cases Listing (Auto-Generated)")
    out.append("")
    out.append("> **Auto-generated by `scripts/test_plan_audit.py`**")
    out.append("> Re-run `python scripts/test_plan_audit.py` to refresh.")
    out.append(">")
    out.append("> This listing cross-references **test plan entries** (scenarios in markdown)")
    out.append("> against **test functions in code** (via `# TST-*` comment matching).")
    out.append(">")
    out.append("> **Plan entries** ≠ **test runner count**. One plan entry may map to multiple")
    out.append("> test functions (parameterized, edge cases). Test functions without plan IDs")
    out.append("> are listed as orphans at the bottom.")
    out.append("")

    # ── Summary ──
    by_tier = defaultdict(lambda: {"total": 0, "implemented": 0, "unimplemented": 0, "deferred": 0, "manual": 0})
    for e in plan_entries:
        t = by_tier[e.tier]
        t["total"] += 1
        if e.deferred:
            t["deferred"] += 1
        elif e.manual:
            t["manual"] += 1
        elif e.implemented:
            t["implemented"] += 1
        else:
            t["unimplemented"] += 1

    plan_files = {
        "core": "`core/test/TEST_PLAN.md`",
        "brain": "`brain/tests/TEST_PLAN.md`",
        "integration": "`tests/INTEGRATION_TEST_PLAN.md`",
        "e2e": "`tests/E2E_TEST_PLAN.md`",
        "release": "`RELEASE_TEST_PLAN.md`",
        "cli": "`cli/tests/TEST_PLAN.md`",
        "user_story": "`tests/system/user_stories/TEST_PLAN.md`",
        "appview_unit": "`appview/UNIT_TEST_PLAN.md`",
        "appview_int": "`appview/INTEGRATION_TEST_PLAN.md`",
    }
    tier_labels = {
        "core": "Core (Unit)",
        "brain": "Brain (Unit)",
        "integration": "Integration",
        "e2e": "E2E",
        "release": "Release",
        "cli": "CLI",
        "user_story": "User Stories",
        "appview_unit": "AppView (Unit)",
        "appview_int": "AppView (Int)",
    }

    out.append("## Summary")
    out.append("")
    out.append("| Tier | Test Plan | Plan Entries | Code Functions | Subtests | Implemented | Unimplemented | Deferred | Manual |")
    out.append("|------|-----------|-------------|----------------|----------|-------------|---------------|----------|--------|")

    tier_order = ["core", "brain", "integration", "e2e", "release", "cli", "user_story", "appview_unit", "appview_int"]
    grand = {"plan": 0, "code": 0, "sub": 0, "impl": 0, "unimpl": 0, "defer": 0, "manual": 0}

    for tier in tier_order:
        t = by_tier[tier]
        code = func_counts.get(tier, 0)
        sub = subtest_counts.get(tier, 0)
        label = tier_labels.get(tier, tier)
        pf = plan_files.get(tier, "—")

        out.append(f"| {label} | {pf} | {t['total']} | {code} | {sub} | {t['implemented']} | {t['unimplemented']} | {t['deferred']} | {t['manual']} |")
        grand["plan"] += t["total"]
        grand["code"] += code
        grand["sub"] += sub
        grand["impl"] += t["implemented"]
        grand["unimpl"] += t["unimplemented"]
        grand["defer"] += t["deferred"]
        grand["manual"] += t["manual"]

    out.append(f"| **TOTAL** | | **{grand['plan']}** | **{grand['code']}** | **{grand['sub']}** | **{grand['impl']}** | **{grand['unimpl']}** | **{grand['defer']}** | **{grand['manual']}** |")

    out.append("")
    out.append(f"**Orphan test functions** (code exists, no `# TST-*` comment): **{len(orphan_tests)}**")
    out.append("")

    out.append("### Status Key")
    out.append("")
    out.append("| Status | Meaning |")
    out.append("|--------|---------|")
    out.append("| Impl | Code reference found via `# TST-*` comment match |")
    out.append("| No | Plan entry exists, no matching code reference found |")
    out.append("| Deferred | Phase 2+ feature — not scheduled for Phase 1 |")
    out.append("| Manual | Requires human judgment — no automated test expected |")
    out.append("")

    # ── Detailed listings per tier ──
    for tier in tier_order:
        tier_entries = [e for e in plan_entries if e.tier == tier]
        if not tier_entries:
            continue

        label = tier_labels.get(tier, tier)
        pf = plan_files.get(tier, "—")

        out.append("---")
        out.append("")
        out.append(f"## {label} — {pf}")
        out.append("")
        out.append("| # | Test ID | Scenario | Section | Impl | Code Location |")
        out.append("|---|---------|----------|---------|------|---------------|")

        for i, e in enumerate(tier_entries, 1):
            scenario = e.scenario[:80] + ("…" if len(e.scenario) > 80 else "")
            section = e.section[:55] + ("…" if len(e.section) > 55 else "")

            if e.deferred:
                status = "Deferred"
            elif e.manual:
                status = "Manual"
            elif e.implemented:
                status = "Yes"
            else:
                status = "No"

            # Code location
            if e.code_refs:
                loc = e.code_refs[0]
                code_loc = f"`{loc[0]}:{loc[1]}`"
                if len(e.code_refs) > 1:
                    code_loc += f" (+{len(e.code_refs)-1})"
            else:
                code_loc = "—"

            out.append(f"| {i} | `{e.test_id}` | {scenario} | {section} | {status} | {code_loc} |")

        out.append("")

    # ── Orphan tests ──
    if orphan_tests:
        out.append("---")
        out.append("")
        out.append("## Orphan Test Functions (No Plan ID)")
        out.append("")
        out.append("> These test functions exist in code but have no `# TST-*` / `# REL-*` comment.")
        out.append("> They may be infrastructure tests, helper validations, or missing plan coverage.")
        out.append("")

        orphan_by_tier = defaultdict(list)
        for ct in orphan_tests:
            orphan_by_tier[ct.tier].append(ct)

        for tier in ["core", "brain", "integration", "e2e", "release", "cli", "user_story", "appview_unit", "appview_int"]:
            tests = orphan_by_tier.get(tier, [])
            if not tests:
                continue

            label = tier_labels.get(tier, tier)
            out.append(f"### {label} — {len(tests)} orphans")
            out.append("")
            out.append("| # | File | Line | Function |")
            out.append("|---|------|------|----------|")

            for i, ct in enumerate(sorted(tests, key=lambda x: (x.file, x.line)), 1):
                out.append(f"| {i} | `{ct.file}` | {ct.line} | `{ct.func_name}` |")

            out.append("")

    # Write
    output_path = ROOT / "test_cases_listing.md"
    output_path.write_text("\n".join(out))
    print(f"Written {len(out)} lines to {output_path}")


def output_json(result: dict):
    """Machine-readable JSON output."""
    data = {
        "plan_entries": [
            {
                "test_id": e.test_id,
                "scenario": e.scenario,
                "section": e.section,
                "plan_file": e.plan_file,
                "tier": e.tier,
                "implemented": e.implemented,
                "deferred": e.deferred,
                "manual": e.manual,
                "code_refs": e.code_refs,
            }
            for e in result["plan_entries"]
        ],
        "orphan_tests": [
            {
                "file": ct.file,
                "line": ct.line,
                "func_name": ct.func_name,
                "tier": ct.tier,
            }
            for ct in result["orphan_tests"]
        ],
        "func_counts": result["func_counts"],
        "subtest_counts": result["subtest_counts"],
        "summary": {
            "total_plan_entries": len(result["plan_entries"]),
            "implemented": len(result["implemented"]),
            "unimplemented": len(result["unimplemented"]),
            "deferred": len(result["deferred"]),
            "manual": len(result["manual"]),
            "orphan_tests": len(result["orphan_tests"]),
        },
    }
    print(json.dumps(data, indent=2))


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Dina Test Plan Audit")
    parser.add_argument("--summary", action="store_true", help="Summary table only")
    parser.add_argument("--orphans", action="store_true", help="List orphan test functions")
    parser.add_argument("--unimplemented", action="store_true", help="List unimplemented plan entries")
    parser.add_argument("--json", action="store_true", help="JSON output")
    args = parser.parse_args()

    print("Extracting plan entries from test plan documents...", file=sys.stderr)
    plan_entries = extract_plan_entries()
    print(f"  Found {len(plan_entries)} plan entries", file=sys.stderr)

    print("Extracting test functions from source code...", file=sys.stderr)
    code_tests = extract_code_tests()
    print(f"  Found {len(code_tests)} test functions", file=sys.stderr)

    print("Cross-referencing...", file=sys.stderr)
    result = reconcile(plan_entries, code_tests)

    if args.json:
        output_json(result)
    elif args.summary:
        print_summary(result)
    elif args.orphans:
        print_summary(result)
        print_orphans(result)
    elif args.unimplemented:
        print_summary(result)
        print_unimplemented(result)
    else:
        # Full: summary to stdout + generate listing file
        print_summary(result)
        generate_listing(result)


if __name__ == "__main__":
    main()
