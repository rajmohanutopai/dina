#!/usr/bin/env python3
"""Inject [TST-CORE-NNN] / [TST-BRAIN-NNN] IDs into test plan markdown tables.

One-time script. Idempotent — skips rows already tagged.
Outputs JSON manifests alongside the modified files.
"""

import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

PLANS = [
    {
        "file": PROJECT_ROOT / "core" / "test" / "TEST_PLAN.md",
        "prefix": "TST-CORE",
        "manifest": PROJECT_ROOT / "core" / "test" / "test_manifest.json",
    },
    {
        "file": PROJECT_ROOT / "brain" / "tests" / "TEST_PLAN.md",
        "prefix": "TST-BRAIN",
        "manifest": PROJECT_ROOT / "brain" / "tests" / "test_manifest.json",
    },
]

# Detect section/subsection headers: ## 1. ... or ### 1.1 ... or ### 3.1.1 ...
SECTION_RE = re.compile(r"^(#{2,3})\s+([\d.]+)")
# Detect table data rows: | 1 | ... or | 12 | ...
DATA_ROW_RE = re.compile(r"^\|\s*(\d+)\s*\|")
# Detect table header row: | # | Scenario | ...
HEADER_ROW_RE = re.compile(r"^\|\s*#\s*\|")
# Detect already-tagged scenario
TAGGED_RE = re.compile(r"\[TST-")


def extract_section_path(line: str) -> str | None:
    """Extract section path (e.g., '1.1', '3.1.1', '5') from a markdown header."""
    m = SECTION_RE.match(line)
    if m:
        return m.group(2).rstrip(".")
    return None


def process_plan(plan_config: dict) -> dict:
    """Process a single test plan file. Returns manifest dict."""
    filepath = plan_config["file"]
    prefix = plan_config["prefix"]
    manifest_path = plan_config["manifest"]

    text = filepath.read_text()
    lines = text.split("\n")

    manifest = {}
    sections = {}  # path -> list of IDs

    # Seed the counter from the highest existing tag in the file so new
    # rows get IDs that continue the sequence instead of restarting from
    # 001 and colliding with previously-tagged sections. Appendix-only or
    # placeholder rows that carry tags but live outside scenario tables
    # don't matter — we just want the max numeric suffix.
    existing_id_re = re.compile(r"\[" + re.escape(prefix) + r"-(\d+)\]")
    max_existing = 0
    for existing_match in existing_id_re.finditer(text):
        n = int(existing_match.group(1))
        if n > max_existing:
            max_existing = n
    counter = max_existing
    current_path = None
    in_scenario_table = False

    new_lines = []

    for i, line in enumerate(lines):
        line_num = i + 1

        # Check for section/subsection header
        path = extract_section_path(line)
        if path is not None:
            current_path = path
            in_scenario_table = False
            new_lines.append(line)
            continue

        # Check for table header row (| # | Scenario | ...)
        if HEADER_ROW_RE.match(line):
            in_scenario_table = True
            new_lines.append(line)
            continue

        # Check for table separator (|---|...)
        if re.match(r"^\|[-\s|]+$", line):
            new_lines.append(line)
            continue

        # Blank line or non-table content ends the table
        if not line.strip().startswith("|"):
            in_scenario_table = False
            new_lines.append(line)
            continue

        # Check for table data row
        m = DATA_ROW_RE.match(line)
        if m and in_scenario_table and current_path is not None:
            row_num = int(m.group(1))

            # Skip if already tagged
            if TAGGED_RE.search(line):
                existing = re.search(r"\[(" + re.escape(prefix) + r"-\d+)\]", line)
                if existing:
                    tag = existing.group(1)
                    cells = line.split("|")
                    scenario_text = cells[2].strip() if len(cells) > 2 else ""
                    scenario_text = re.sub(
                        r"\*\*\[" + re.escape(prefix) + r"-\d+\]\*\*\s*",
                        "",
                        scenario_text,
                    )
                    manifest[tag] = {
                        "path": current_path,
                        "row": row_num,
                        "scenario": scenario_text,
                        "line": line_num,
                    }
                    sections.setdefault(current_path, []).append(tag)
                new_lines.append(line)
                continue

            counter += 1
            tag = f"{prefix}-{counter:03d}"

            # Inject tag at start of Scenario cell (column index 2 after split on |)
            cells = line.split("|")
            if len(cells) > 2:
                scenario_text = cells[2].strip()
                cells[2] = f" **[{tag}]** {scenario_text} "
                line = "|".join(cells)

            manifest[tag] = {
                "path": current_path,
                "row": row_num,
                "scenario": scenario_text,
                "line": line_num,
            }
            sections.setdefault(current_path, []).append(tag)
            new_lines.append(line)
            continue

        # Non-matching table row (e.g., Appendix tables with text in first cell)
        new_lines.append(line)

    # Write modified file
    filepath.write_text("\n".join(new_lines))

    # Write manifest
    output = {
        "scenarios": manifest,
        "sections": sections,
        "total": len(manifest),
        "highest_id": counter,
        "newly_tagged": counter - max_existing,
    }
    manifest_path.write_text(json.dumps(output, indent=2) + "\n")

    return output


def main():
    for plan in PLANS:
        print(f"Processing {plan['file'].relative_to(PROJECT_ROOT)}...")
        result = process_plan(plan)
        print(
            f"  Newly tagged: {result['newly_tagged']}  "
            f"(total in manifest: {result['total']}, highest ID: {plan['prefix']}-{result['highest_id']:03d})"
        )
        print(f"  Manifest: {plan['manifest'].relative_to(PROJECT_ROOT)}")
        print(f"  Sections: {len(result['sections'])}")

    print("\nDone.")


if __name__ == "__main__":
    main()
