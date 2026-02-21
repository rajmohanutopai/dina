#!/usr/bin/env python3
"""Inject [TST-INT-NNN] IDs into integration test plan markdown tables.

Finds all table data rows (lines matching `| N |` inside scenario tables)
and inserts a sequential tag into the Scenario column:
    | 1 | **[TST-INT-001]** scenario text | ...

Idempotent — skips rows already tagged.
Outputs a JSON manifest alongside the modified file.
"""

import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

INT_PLAN = PROJECT_ROOT / "tests" / "INTEGRATION_TEST_PLAN.md"
MANIFEST_PATH = PROJECT_ROOT / "tests" / "integration_manifest.json"

# Detect section headers: ## 1. ... or ## 16. ...
SECTION_RE = re.compile(r"^##\s+(\d+)\.\s+(.*)")
# Detect subsection headers: ### 1.1 ... or ### 16.12 ...
SUBSECTION_RE = re.compile(r"^###\s+([\d.]+)\s+(.*)")
# Detect table data rows: | 1 | ... or | 12 | ...
DATA_ROW_RE = re.compile(r"^\|\s*(\d+)\s*\|")
# Detect table header row: | # | Scenario | ...
HEADER_ROW_RE = re.compile(r"^\|\s*#\s*\|")
# Detect table separator: |---|...|
SEPARATOR_RE = re.compile(r"^\|[-\s|]+$")
# Detect already-tagged scenario
TAGGED_RE = re.compile(r"\[TST-INT-")
# Extract existing tag
EXISTING_TAG_RE = re.compile(r"\*\*\[(TST-INT-\d+)\]\*\*\s*")
# Prefix for tags
PREFIX = "TST-INT"


def main():
    if not INT_PLAN.exists():
        print(f"ERROR: Integration test plan not found: {INT_PLAN}")
        sys.exit(1)

    text = INT_PLAN.read_text()
    lines = text.split("\n")

    manifest = {}
    sections = {}      # section_num -> section_name
    subsections = {}    # path -> subsection_name
    scenarios_by_section = {}  # section_name -> [tag_ids]

    counter = 0
    current_section_num = None
    current_section_name = None
    current_path = None
    in_scenario_table = False

    new_lines = []

    for i, line in enumerate(lines):
        line_num = i + 1

        # Check for section header: ## N. Name
        sm = SECTION_RE.match(line)
        if sm:
            current_section_num = int(sm.group(1))
            current_section_name = sm.group(2).strip()
            sections[current_section_num] = current_section_name
            current_path = str(current_section_num)
            in_scenario_table = False
            new_lines.append(line)
            continue

        # Check for subsection header: ### N.M Name
        ssm = SUBSECTION_RE.match(line)
        if ssm:
            current_path = ssm.group(1).rstrip(".")
            subsections[current_path] = ssm.group(2).strip()
            in_scenario_table = False
            new_lines.append(line)
            continue

        # Check for table header row (| # | Scenario | ...)
        if HEADER_ROW_RE.match(line):
            in_scenario_table = True
            new_lines.append(line)
            continue

        # Check for table separator (|---|...)
        if SEPARATOR_RE.match(line):
            new_lines.append(line)
            continue

        # Blank line or non-table content ends the table
        if not line.strip().startswith("|"):
            in_scenario_table = False
            new_lines.append(line)
            continue

        # Check for table data row
        m = DATA_ROW_RE.match(line)
        if m and in_scenario_table:
            row_num = int(m.group(1))

            # Split by | to get cells
            cells = line.split("|")
            # cells[0] = "" (before first |), cells[1] = " 1 ", cells[2] = " scenario ", ...

            # Already tagged?
            if TAGGED_RE.search(line):
                em = EXISTING_TAG_RE.search(cells[2] if len(cells) > 2 else "")
                if em:
                    tag = em.group(1)
                    scenario_text = cells[2].strip() if len(cells) > 2 else ""
                    scenario_text = EXISTING_TAG_RE.sub("", scenario_text).strip()
                    manifest[tag] = {
                        "scenario": scenario_text,
                        "path": current_path or "",
                        "row": row_num,
                        "section": current_section_name or "",
                        "line": line_num,
                    }
                    scenarios_by_section.setdefault(
                        current_section_name or "", []
                    ).append(tag)
                    counter += 1
                new_lines.append(line)
                continue

            counter += 1
            tag = f"{PREFIX}-{counter:03d}"

            # Inject tag at start of Scenario cell (column index 2)
            if len(cells) > 2:
                scenario_text = cells[2].strip()
                cells[2] = f" **[{tag}]** {scenario_text} "
                line = "|".join(cells)

            manifest[tag] = {
                "scenario": scenario_text,
                "path": current_path or "",
                "row": row_num,
                "section": current_section_name or "",
                "line": line_num,
            }
            scenarios_by_section.setdefault(
                current_section_name or "", []
            ).append(tag)
            new_lines.append(line)
            continue

        # Non-matching table row
        new_lines.append(line)

    # Write modified file
    INT_PLAN.write_text("\n".join(new_lines))

    # Build summary
    unique_sections = set()
    for info in manifest.values():
        if info["section"]:
            unique_sections.add(info["section"])

    output = {
        "scenarios": manifest,
        "summary": {
            "total": counter,
            "sections": len(unique_sections),
        },
    }
    MANIFEST_PATH.write_text(json.dumps(output, indent=2) + "\n")

    # Report
    print(f"Integration Test Plan: {INT_PLAN.relative_to(PROJECT_ROOT)}")
    print(f"  Tagged {counter} scenarios with {PREFIX}-NNN IDs")
    print(f"  Sections: {len(unique_sections)}")
    for snum in sorted(sections.keys()):
        sname = sections[snum]
        scount = len(scenarios_by_section.get(sname, []))
        print(f"    {snum}. {sname} ({scount} scenarios)")
    print(f"  Manifest: {MANIFEST_PATH.relative_to(PROJECT_ROOT)}")
    print()
    print("Done.")


if __name__ == "__main__":
    main()
