#!/usr/bin/env python3
"""Inject [TST-E2E-NNN] IDs into E2E test plan heading lines.

Finds all `#### E2E-X.Y:` headings and inserts a sequential tag:
    #### E2E-X.Y: **[TST-E2E-001]** Title Here

Idempotent — skips headings already tagged.
Outputs a JSON manifest alongside the modified file.
"""

import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

E2E_PLAN = PROJECT_ROOT / "tests" / "E2E_TEST_PLAN.md"
MANIFEST_PATH = PROJECT_ROOT / "tests" / "e2e_manifest.json"

# Match E2E scenario headings: #### E2E-1.1: Title or #### E2E-13.10: Title
HEADING_RE = re.compile(r"^(#### E2E-(\d+\.\d+):)\s*(.*)")
# Detect already-tagged heading
TAGGED_RE = re.compile(r"\[TST-E2E-")
# Extract existing tag
EXISTING_TAG_RE = re.compile(r"\*\*\[(TST-E2E-\d+)\]\*\*\s*")
# Suite header: ### Suite N: Name
SUITE_RE = re.compile(r"^### Suite (\d+):\s*(.*)")


def main():
    if not E2E_PLAN.exists():
        print(f"ERROR: E2E test plan not found: {E2E_PLAN}")
        sys.exit(1)

    text = E2E_PLAN.read_text()
    lines = text.split("\n")

    manifest = {}
    suites = {}  # suite_num -> suite_name
    counter = 0
    current_suite_num = None
    current_suite_name = None

    new_lines = []

    for i, line in enumerate(lines):
        line_num = i + 1

        # Check for suite header
        sm = SUITE_RE.match(line)
        if sm:
            current_suite_num = int(sm.group(1))
            current_suite_name = sm.group(2).strip()
            suites[current_suite_num] = current_suite_name
            new_lines.append(line)
            continue

        # Check for E2E scenario heading
        hm = HEADING_RE.match(line)
        if hm:
            prefix = hm.group(1)   # "#### E2E-1.1:"
            path = hm.group(2)     # "1.1"
            title = hm.group(3).strip()

            # Already tagged?
            if TAGGED_RE.search(line):
                em = EXISTING_TAG_RE.search(title)
                if em:
                    tag = em.group(1)
                    clean_title = EXISTING_TAG_RE.sub("", title).strip()
                    manifest[tag] = {
                        "scenario": clean_title,
                        "path": path,
                        "suite": current_suite_name or "",
                        "line": line_num,
                    }
                    counter += 1
                new_lines.append(line)
                continue

            counter += 1
            tag = f"TST-E2E-{counter:03d}"

            # Inject tag into heading
            new_line = f"{prefix} **[{tag}]** {title}"

            manifest[tag] = {
                "scenario": title,
                "path": path,
                "suite": current_suite_name or "",
                "line": line_num,
            }
            new_lines.append(new_line)
            continue

        new_lines.append(line)

    # Write modified file
    E2E_PLAN.write_text("\n".join(new_lines))

    # Build summary
    unique_suites = set()
    for info in manifest.values():
        if info["suite"]:
            unique_suites.add(info["suite"])

    output = {
        "scenarios": manifest,
        "summary": {
            "total": counter,
            "suites": len(unique_suites),
        },
    }
    MANIFEST_PATH.write_text(json.dumps(output, indent=2) + "\n")

    # Report
    print(f"E2E Test Plan: {E2E_PLAN.relative_to(PROJECT_ROOT)}")
    print(f"  Tagged {counter} scenarios with TST-E2E-NNN IDs")
    print(f"  Suites: {len(unique_suites)}")
    for snum in sorted(suites.keys()):
        sname = suites[snum]
        suite_count = sum(
            1 for info in manifest.values() if info["suite"] == sname
        )
        print(f"    Suite {snum}: {sname} ({suite_count} scenarios)")
    print(f"  Manifest: {MANIFEST_PATH.relative_to(PROJECT_ROOT)}")
    print()
    print("Done.")


if __name__ == "__main__":
    main()
