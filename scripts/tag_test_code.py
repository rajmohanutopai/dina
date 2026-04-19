#!/usr/bin/env python3
"""Add TST-CORE-NNN / TST-BRAIN-NNN comments to test functions.

Uses manifests from tag_test_plans.py to match test functions to scenario IDs.
Matching algorithm:
  1. Extract leading numbers from function name (e.g., TestAuth_1_1_7_... → [1, 1, 7])
  2. Try all possible (section_path, scenario) splits against valid manifest paths
  3. Prefer matches with a scenario number; among those, prefer longest path
  4. For table-driven tests (no scenario), tag with all IDs for that path

Reports unmatched scenarios and functions for manual review.
Idempotent — skips functions already tagged OR already carrying a
`// TRACE: {...}` / `# TRACE: {...}` comment (those are already traceable;
inserting an ID line displaces the TRACE and breaks the
`TestTraceability_30_7_4_PytestCollectOnlyMapsToPlanIDs` regex which
requires TRACE on the line immediately above the test declaration).

Dry-run by default: prints what would change. Pass --apply to write.
"""

import argparse
import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

CONFIGS = [
    {
        "manifest": PROJECT_ROOT / "core" / "test" / "test_manifest.json",
        "test_dir": PROJECT_ROOT / "core" / "test",
        "prefix": "TST-CORE",
        "lang": "go",
        "file_glob": "*_test.go",
    },
    {
        "manifest": PROJECT_ROOT / "brain" / "tests" / "test_manifest.json",
        "test_dir": PROJECT_ROOT / "brain" / "tests",
        "prefix": "TST-BRAIN",
        "lang": "python",
        "file_glob": "test_*.py",
    },
]


def load_manifest(path):
    """Load manifest and build lookup structures."""
    data = json.loads(path.read_text())
    valid_paths = set(data["sections"].keys())

    id_by_path_row = {}
    rows_by_path = {}
    for tag_id, info in data["scenarios"].items():
        key = (info["path"], info["row"])
        # Note: duplicate paths (e.g., two §17.2) will overwrite — acceptable
        id_by_path_row[key] = tag_id
        rows_by_path.setdefault(info["path"], []).append((info["row"], tag_id))
    for p in rows_by_path:
        rows_by_path[p].sort()

    all_ids = set(data["scenarios"].keys())
    return valid_paths, id_by_path_row, rows_by_path, all_ids


def extract_numbers(func_name, lang):
    """Extract leading section/subsection/scenario numbers from function name.

    Skips any non-numeric prefix words, then collects consecutive digits.
    Go:     TestAuth_1_1_7_TokenFileMissing      → [1, 1, 7]
    Python: test_core_client_7_1_1_read_vault    → [7, 1, 1]
    Python: test_anti_her_16_1_emotional_support → [16, 1]
    """
    if lang == "go":
        name = func_name[4:]  # Strip "Test"
    else:
        name = func_name[5:]  # Strip "test_"

    parts = name.split("_")
    numbers = []
    found_first = False
    for part in parts:
        if part.isdigit():
            numbers.append(int(part))
            found_first = True
        elif found_first:
            break  # Stop at first non-numeric part after numbers started
    return numbers


def find_match(numbers, valid_paths, id_by_path_row, rows_by_path):
    """Find best (path, [ids]) match for extracted numbers.

    Returns (path, [ids]):
      - Single ID for standalone tests (specific scenario)
      - All IDs for the path for table-driven tests (covers a subsection)
      - (None, []) if no match
    """
    if not numbers:
        return None, []

    section = str(numbers[0])
    rest = numbers[1:]

    best_with_scenario = None  # (path, [id], path_depth)
    best_without_scenario = None  # (path, [ids])

    for split in range(len(rest) + 1):
        path_parts = [section] + [str(n) for n in rest[:split]]
        path = ".".join(path_parts)
        remaining = rest[split:]

        if path not in valid_paths:
            continue

        if remaining:
            scenario = remaining[0]
            tag_id = id_by_path_row.get((path, scenario))
            if tag_id:
                depth = len(path_parts)
                if best_with_scenario is None or depth > best_with_scenario[2]:
                    best_with_scenario = (path, [tag_id], depth)
        else:
            if best_without_scenario is None:
                ids = [tid for _, tid in rows_by_path.get(path, [])]
                best_without_scenario = (path, ids)

    if best_with_scenario:
        return best_with_scenario[0], best_with_scenario[1]
    if best_without_scenario:
        return best_without_scenario[0], best_without_scenario[1]
    return None, []


def format_id_comment(ids, comment_char):
    """Format IDs into comment lines, wrapping at ~100 chars.

    comment_char is '//' for Go or '#' for Python.
    """
    if not ids:
        return []

    lines = []
    current = comment_char
    for i, tag_id in enumerate(ids):
        sep = ", " if i > 0 else " "
        candidate = current + sep + tag_id
        if len(candidate) > 100 and i > 0:
            lines.append(current)
            current = comment_char + " " + tag_id
        else:
            current = candidate
    if current != comment_char:
        lines.append(current)
    return lines


def process_go_file(filepath, valid_paths, id_by_path_row, rows_by_path, apply):
    """Process a Go test file. Returns (matched_ids, unmatched_funcs)."""
    text = filepath.read_text()
    lines = text.split("\n")

    func_re = re.compile(r"^func (Test\w+)\(")
    tag_re = re.compile(r"^// TST-")
    trace_re = re.compile(r"^\s*//\s*TRACE:\s*\{")
    # Subtest patterns (must be indented — inside function body)
    subtest_name_re = re.compile(r'^\s+name:\s*"(\d+)_')
    subtest_run_re = re.compile(r'^\s+t\.Run\("(\d+)_')
    inline_tag_re = re.compile(r"// TST-")

    func_comments = {}  # line_idx -> list of comment lines to insert before
    inline_edits = {}  # line_idx -> new line content
    matched_ids = set()
    unmatched_funcs = []
    current_path = None  # For inline subtest tagging

    for i, line in enumerate(lines):
        m = func_re.match(line)
        if m:
            func_name = m.group(1)
            numbers = extract_numbers(func_name, "go")
            path, ids = find_match(numbers, valid_paths, id_by_path_row, rows_by_path)

            if ids:
                matched_ids.update(ids)
                current_path = path if len(ids) > 1 else None
                # Skip if already has a TST- tag OR a TRACE comment on the
                # preceding line — both count as traceable, and inserting
                # between TRACE and the func breaks 30_7_4 recognition.
                prev = lines[i - 1] if i > 0 else ""
                if not (tag_re.match(prev) or trace_re.match(prev)):
                    func_comments[i] = format_id_comment(ids, "//")
            else:
                unmatched_funcs.append(func_name)
                current_path = None
            continue

        # Inline subtest tagging for table-driven tests
        if current_path:
            for pattern in [subtest_name_re, subtest_run_re]:
                sm = pattern.search(line)
                if sm and not inline_tag_re.search(line):
                    scenario_num = int(sm.group(1))
                    tag_id = id_by_path_row.get((current_path, scenario_num))
                    if tag_id:
                        matched_ids.add(tag_id)
                        stripped = line.rstrip()
                        inline_edits[i] = f"{stripped}  // {tag_id}"
                    break

    # Apply inline edits first (no line count change)
    for idx, new_line in inline_edits.items():
        lines[idx] = new_line

    # Apply function comments in reverse order (preserves indices)
    for idx in sorted(func_comments.keys(), reverse=True):
        for comment_line in reversed(func_comments[idx]):
            lines.insert(idx, comment_line)

    planned = len(func_comments) + len(inline_edits)
    if planned and apply:
        filepath.write_text("\n".join(lines))
    return matched_ids, unmatched_funcs, planned


def process_py_file(filepath, valid_paths, id_by_path_row, rows_by_path, apply):
    """Process a Python test file. Returns (matched_ids, unmatched_funcs)."""
    text = filepath.read_text()
    lines = text.split("\n")

    func_re = re.compile(r"^(?:async )?def (test_\w+)\(")
    tag_re = re.compile(r"^# TST-")
    trace_re = re.compile(r"^\s*#\s*TRACE:\s*\{")
    decorator_re = re.compile(r"^@")

    func_comments = {}  # insert_idx -> list of comment lines
    matched_ids = set()
    unmatched_funcs = []

    for i, line in enumerate(lines):
        m = func_re.match(line)
        if not m:
            continue

        func_name = m.group(1)
        numbers = extract_numbers(func_name, "python")
        path, ids = find_match(numbers, valid_paths, id_by_path_row, rows_by_path)

        if not ids:
            unmatched_funcs.append(func_name)
            continue

        matched_ids.update(ids)

        # Find insertion point (before decorators)
        insert_idx = i
        while insert_idx > 0 and decorator_re.match(lines[insert_idx - 1]):
            insert_idx -= 1

        # Skip if already tagged OR already has a TRACE comment — both are
        # traceable, and inserting would displace TRACE and break 30_7_4.
        prev = lines[insert_idx - 1] if insert_idx > 0 else ""
        if tag_re.match(prev) or trace_re.match(prev):
            continue

        func_comments[insert_idx] = format_id_comment(ids, "#")

    # Apply in reverse order
    for idx in sorted(func_comments.keys(), reverse=True):
        for comment_line in reversed(func_comments[idx]):
            lines.insert(idx, comment_line)

    planned = len(func_comments)
    if planned and apply:
        filepath.write_text("\n".join(lines))
    return matched_ids, unmatched_funcs, planned


def main():
    parser = argparse.ArgumentParser(
        description="Insert TST-CORE-/TST-BRAIN- ID comments above test functions.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write changes to disk. Without this flag, runs dry and reports planned edits.",
    )
    args = parser.parse_args()
    apply = args.apply

    total_matched = set()
    total_all = set()
    total_planned = 0

    if not apply:
        print("DRY RUN — no files will be modified. Pass --apply to write.")

    for config in CONFIGS:
        manifest_path = config["manifest"]
        if not manifest_path.exists():
            print(f"ERROR: Manifest not found: {manifest_path}")
            print("  Run scripts/tag_test_plans.py first.")
            sys.exit(1)

        valid_paths, id_by_path_row, rows_by_path, all_ids = load_manifest(
            manifest_path
        )
        total_all.update(all_ids)

        lang = config["lang"]
        test_dir = config["test_dir"]
        prefix = config["prefix"]

        print(f"\n{'='*60}")
        print(f"{prefix} ({lang.upper()}) — {test_dir.relative_to(PROJECT_ROOT)}")
        print(f"{'='*60}")

        matched = set()
        all_unmatched = []

        for filepath in sorted(test_dir.glob(config["file_glob"])):
            if lang == "go":
                m, u, planned = process_go_file(
                    filepath, valid_paths, id_by_path_row, rows_by_path, apply
                )
            else:
                m, u, planned = process_py_file(
                    filepath, valid_paths, id_by_path_row, rows_by_path, apply
                )

            matched.update(m)
            all_unmatched.extend(u)
            total_planned += planned

            fname = filepath.name
            tag_count = len(m)
            verb = "wrote" if apply else "would insert"
            change_note = f" — {verb} {planned} comment line(s)" if planned else ""
            if u:
                print(f"  {fname}: {tag_count} IDs, {len(u)} unmatched funcs{change_note}")
            else:
                print(f"  {fname}: {tag_count} IDs{change_note}")

        missing = all_ids - matched
        print(f"\n  Summary: {len(matched)}/{len(all_ids)} scenario IDs matched")
        if missing:
            print(f"  Missing ({len(missing)}):")
            for mid in sorted(missing):
                print(f"    {mid}")
        if all_unmatched:
            print(f"  Unmatched functions ({len(all_unmatched)}):")
            for func in all_unmatched:
                print(f"    {func}")

        total_matched.update(matched)

    # Overall summary
    total_missing = total_all - total_matched
    print(f"\n{'='*60}")
    print(f"OVERALL: {len(total_matched)}/{len(total_all)} IDs matched")
    if total_missing:
        print(f"  Missing: {len(total_missing)}")
    else:
        print("  All scenario IDs referenced in test code!")
    if apply:
        print(f"  Wrote {total_planned} comment line(s) across test files.")
    else:
        print(f"  Would insert {total_planned} comment line(s). Re-run with --apply to write.")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
