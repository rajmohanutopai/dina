#!/usr/bin/env python3
"""Migrate all test functions to TRACE comment format.

Usage:
    python scripts/migrate_test_traces.py                    # dry-run (show changes)
    python scripts/migrate_test_traces.py --apply            # apply changes
    python scripts/migrate_test_traces.py --suite BRAIN      # single suite
    python scripts/migrate_test_traces.py --apply --suite CLI # apply single suite
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

# Section mappings per suite — maps section number to name.
# Extracted from the existing test runner report.
SECTIONS = {
    "BRAIN": {
        "01": "Authentication & Authorization",
        "02": "Guardian Loop (Core AI Reasoning)",
        "03": "PII Scrubber (Tier 2)",
        "04": "LLM Router (Multi-Provider)",
        "05": "Sync Engine (Ingestion Pipeline)",
        "06": "MCP Client (Agent Delegation)",
        "07": "Core Client (HTTP Client)",
        "08": "Admin UI",
        "09": "Configuration",
        "10": "API Endpoints",
        "11": "Error Handling & Resilience",
        "12": "Scratchpad (Cognitive Checkpointing)",
        "13": "Crash Traceback Safety",
        "14": "Embedding Generation",
        "15": "Silence Classification",
        "16": "Anti-Her Enforcement",
        "17": "Thesis: Human Connection",
        "18": "Thesis: Silence First",
        "19": "Thesis: Pull Economy",
        "20": "Thesis: Action Integrity",
        "21": "Deferred (Phase 2+)",
        "22": "Voice STT Integration",
        "23": "Code Review Fix Verification",
        "24": "Architecture Review Coverage",
    },
    "CORE": {
        "01": "Authentication & Authorization",
        "02": "Key Derivation & Cryptography",
        "03": "Identity (DID)",
        "04": "Vault (SQLCipher)",
        "05": "PII Scrubber (Tier 1)",
        "06": "Gatekeeper (Egress / Sharing Policy)",
        "07": "Transport Layer",
        "08": "Task Queue (Outbox Pattern)",
        "09": "WebSocket Protocol",
        "10": "Device Pairing",
        "11": "Brain Client & Circuit Breaker",
        "12": "Admin Proxy",
        "13": "Rate Limiting",
        "14": "Configuration",
        "15": "API Endpoint Tests",
        "16": "Error Handling & Edge Cases",
        "17": "Security Hardening",
        "18": "Core-Brain API Contract",
        "19": "Onboarding Sequence",
        "20": "Observability & Self-Healing",
        "21": "Logging Policy",
        "22": "PDS Integration (AT Protocol)",
        "23": "Portability & Migration",
        "24": "Deferred (Phase 2+)",
        "25": "Bot Interface",
        "26": "Client Sync Protocol",
        "27": "Digital Estate",
        "28": "CLI Request Signing",
        "29": "Adversarial & Security",
        "30": "Test System Quality",
        "31": "Code Review Fix Verification",
        "32": "Security Fix Verification",
        "33": "Architecture Review Coverage",
        "34": "Thesis: Loyalty",
        "35": "Thesis: Silence First",
        "36": "Thesis: Action Integrity",
    },
    "INT": {
        "01": "Core-Brain Communication",
        "02": "End-to-End User Flows",
        "03": "Dina-to-Dina Communication",
        "04": "LLM Integration",
        "05": "Docker Networking & Isolation",
        "06": "Crash Recovery & Resilience",
        "07": "Security Boundary Tests",
        "08": "Digital Estate",
        "09": "Ingestion-to-Vault Pipeline",
        "10": "Data Flow Patterns",
        "11": "Trust Network Integration",
        "12": "Upgrade & Migration",
        "14": "Chaos Engineering",
        "15": "Compliance & Privacy",
        "16": "Deferred (Phase 2+)",
        "17": "Architecture Validation",
        "18": "Architecture Validation (Medium)",
        "19": "Thesis: Loyalty",
        "20": "Thesis: Human Connection",
        "21": "Thesis: Silence First",
        "22": "Thesis: Pull Economy",
        "23": "Thesis: Action Integrity",
        "24": "Async Approval Flow",
    },
    "E2E": {
        "01": "Onboarding",
        "02": "Sancho Moment",
        "03": "Product Research",
        "04": "Memory Recall",
        "05": "Ingestion",
        "06": "Agent Safety",
        "07": "Privacy & PII",
        "08": "Sensitive Personas",
        "09": "Digital Estate",
        "10": "Resilience",
        "11": "Multi-Device",
        "12": "Trust",
        "13": "Security",
        "14": "Agentic",
        "15": "CLI Signing",
        "16": "AT Protocol PDS",
        "17": "Quiet Dina",
        "18": "Move Machine",
        "19": "Connector Failure",
        "20": "Operator Upgrade",
        "21": "Anti-Her",
        "22": "Verified Truth",
        "23": "Silence Stress",
        "24": "Agent Sandbox",
    },
    "INST": {
        "01": "Wizard",
        "02": "Core Install",
        "03": "Functional",
        "04": "Blackbox",
        "05": "Failure Modes",
        "06": "Post-Install",
        "07": "Model Config",
        "08": "Startup Modes",
    },
    "REL": {
        "01": "Fresh Install",
        "02": "First Conversation",
        "03": "Vault Persistence",
        "04": "Locked State",
        "05": "Recovery",
        "06": "Two Dinas",
        "07": "Trust Network",
        "08": "Agent Gateway",
        "09": "Persona Wall",
        "10": "Hostile Network",
        "11": "Failure Handling",
        "12": "Doc Claims",
        "15": "Install Rerun",
        "16": "Upgrade",
        "17": "Admin Lifecycle",
        "18": "Connector Outage",
        "19": "Silence & Briefing",
        "20": "Cart Handover",
        "21": "Export & Import",
        "22": "Exposure Audit",
        "23": "CLI Agent",
        "24": "Recommendation Integrity",
        "25": "Anti-Her / Staging Pipeline",
        "26": "Silence Stress",
        "27": "Action Integrity",
        "28": "Install Lifecycle",
    },
    "CLI": {
        "01": "Commands",
        "02": "Client",
        "03": "Config",
        "04": "OpenClaw",
        "05": "Session",
        "06": "Task",
        "07": "Tracing",
    },
}

# Tag patterns per suite.
TAG_PATTERNS = {
    "BRAIN": [r"TST-BRAIN-(\d+)"],
    "CLI": [r"TST-CLI-(\d+)"],
    "ADMIN": [r"TST-ADMIN-(\d+)"],
    "INT": [r"TST-INT-(\d+)", r"TST-CORE-(\d+)"],
    "E2E": [r"TST-E2E-(\d+)", r"TST-CORE-(\d+)"],
    "INST": [r"TST-INST-(\d+)"],
    "REL": [r"REL-(\d+)"],
    "SYSTEM": [r"UST-(\d+)", r"STORY-(\d+)"],
    "APPVIEW": [r"TST-APPVIEW-(\d+)"],
}

# Suite directories and languages.
SUITES = {
    "BRAIN": ("brain/tests", "python"),
    "CLI": ("cli/tests", "python"),
    "ADMIN": ("admin-cli/tests", "python"),
    "INT": ("tests/integration", "python"),
    "E2E": ("tests/e2e", "python"),
    "INST": ("tests/install", "python"),
    "REL": ("tests/release", "python"),
    "SYSTEM": ("tests/system", "python"),
    "CORE": ("core/test", "go"),
    "APPVIEW": ("appview/tests", "typescript"),
}

# Regex for finding test functions.
PY_FUNC = re.compile(r"^(\s*)(async\s+)?def\s+(test_\w+)")
GO_FUNC = re.compile(r"^func\s+(Test\w+)\(")
GO_SUBTEST = re.compile(r'^\s*t\.Run\(\s*"([^"]+)"')
TS_IT = re.compile(r'^\s*(it|test)\s*\(\s*["\']([^"\']+)')

# Existing TRACE comment.
TRACE_RE = re.compile(r"^\s*#\s*TRACE:|^\s*//\s*TRACE:")


def extract_section_from_name(func_name: str, suite: str) -> tuple[str, str, str, str]:
    """Extract section, subsection, scenario from function name pattern.

    Returns (section, subsection, scenario, title).

    Uses the same logic as the test runner (_PY_SECTION_RE):
    test_<word>_<N>_<N>_<N>_<desc> → section=N, sub=N, scenario=N
    """
    # Remove test_/Test prefix.
    name = func_name
    if name.startswith("test_"):
        name = name[5:]
    elif name.startswith("Test"):
        name = name[4:]
        if name.startswith("_"):
            name = name[1:]

    # Primary: extract first number after a word prefix.
    # Matches: auth_1_1_service_key, admin_8_1_1_dashboard, rel_001_fresh
    m = re.match(r"[a-zA-Z]+_(\d+)_(\d+)_?(\d+)?_?(.*)", name)
    if m:
        sec = m.group(1).zfill(2)
        sub = m.group(2).zfill(2)
        scen = (m.group(3) or "01").zfill(2)
        title = m.group(4) or name
        return sec, sub, scen, title

    # Go pattern: TestAuth_1_1_ or TestVault_4_2_
    m = re.match(r"[A-Z][a-zA-Z]+_(\d+)_(\d+)_?(\d+)?_?(.*)", name)
    if m:
        sec = m.group(1).zfill(2)
        sub = m.group(2).zfill(2)
        scen = (m.group(3) or "01").zfill(2)
        title = m.group(4) or name
        return sec, sub, scen, title

    # No number pattern — return "00" (needs file-level fallback).
    return "00", "00", "00", name


# File-level section fallback — maps filename → section number.
# Same as _BRAIN_FILE_SECTION_FALLBACK in test_status.py, extended for all suites.
_FILE_SECTION_FALLBACK: dict[str, dict[str, str]] = {
    "BRAIN": {
        "test_telegram.py": "06",
        "test_vault_context.py": "02",
        "test_tier_classifier.py": "14",
        "test_admin_html.py": "08",
        "test_pipeline_safety.py": "02",
        "test_api.py": "10",
        "test_mcp.py": "06",
        "test_core_client.py": "07",
        "test_admin.py": "08",
        "test_config.py": "09",
        "test_scrubber.py": "03",
        "test_sync.py": "05",
        "test_llm_router.py": "04",
        "test_guardian.py": "02",
        "test_embedding.py": "14",
        "test_scratchpad.py": "12",
        "test_crash_safety.py": "13",
        "test_resilience.py": "11",
        "test_silence.py": "15",
        "test_anti_her.py": "16",
        "test_enrichment.py": "05",
        "test_event_extractor.py": "05",
        "test_persona_registry.py": "09",
        "test_staging_processor.py": "05",
        "test_trust_scorer.py": "11",
        "test_pii.py": "03",
        "test_fix_verification.py": "23",
    },
    "CLI": {
        "test_commands.py": "01",
        "test_signing.py": "02",
        "test_config.py": "03",
        "test_client.py": "02",
        "test_openclaw.py": "04",
        "test_session.py": "05",
        "test_task.py": "06",
        "test_tracing.py": "07",
    },
    "ADMIN": {
        "test_commands.py": "01",
        "test_client.py": "02",
    },
    "INT": {
        "test_home_node.py": "02",
        "test_dina_to_dina.py": "03",
        "test_didcomm.py": "03",
        "test_docker_infra.py": "05",
        "test_crash_recovery.py": "06",
        "test_security.py": "07",
        "test_safety_layer.py": "07",
        "test_digital_estate.py": "08",
        "test_ingestion.py": "09",
        "test_staging_pipeline.py": "09",
        "test_memory_flows.py": "10",
        "test_draft_dont_send.py": "10",
        "test_storage_tiers.py": "10",
        "test_tiered_content.py": "10",
        "test_trust_network.py": "11",
        "test_trust_rings.py": "11",
        "test_source_trust.py": "11",
        "test_migration.py": "12",
        "test_chaos.py": "14",
        "test_compliance.py": "15",
        "test_pii_scrubber.py": "15",
        "test_phase2.py": "16",
        "test_arch_validation.py": "17",
        "test_arch_medium_1.py": "18",
        "test_arch_medium_2.py": "18",
        "test_arch_medium_3.py": "18",
        "test_persona_tiers.py": "07",
        "test_personas.py": "07",
        "test_delegation.py": "07",
        "test_agency.py": "07",
        "test_anti_her.py": "20",
        "test_silence_tiers.py": "21",
        "test_deep_links.py": "22",
        "test_open_economy.py": "22",
        "test_cart_handover.py": "22",
        "test_async_approval.py": "24",
        "test_audit.py": "07",
        "test_client_sync.py": "10",
        "test_performance.py": "17",
        "test_whisper.py": "03",
    },
    "E2E": {
        "test_suite_01_onboarding.py": "01",
        "test_suite_02_sancho_moment.py": "02",
        "test_suite_03_product_research.py": "03",
        "test_suite_04_memory_recall.py": "04",
        "test_suite_05_ingestion.py": "05",
        "test_suite_06_agent_safety.py": "06",
        "test_suite_07_privacy_pii.py": "07",
        "test_suite_08_sensitive_personas.py": "08",
        "test_suite_09_digital_estate.py": "09",
        "test_suite_10_resilience.py": "10",
        "test_suite_11_multi_device.py": "11",
        "test_suite_12_trust.py": "12",
        "test_suite_13_security.py": "13",
        "test_suite_14_agentic.py": "14",
        "test_suite_15_cli_signing.py": "15",
        "test_suite_16_at_protocol_pds.py": "16",
        "test_suite_17_quiet_dina.py": "17",
        "test_suite_18_move_machine.py": "18",
        "test_suite_19_connector_failure.py": "19",
        "test_suite_20_operator_upgrade.py": "20",
        "test_suite_21_anti_her.py": "21",
        "test_suite_22_verified_truth.py": "22",
        "test_suite_23_silence_stress.py": "23",
        "test_suite_24_agent_sandbox.py": "24",
        "test_persona_tiers_e2e.py": "08",
    },
    "INST": {
        "test_installer_wizard.py": "01",
        "test_installer_core.py": "02",
        "test_install_functional.py": "03",
        "test_install_blackbox.py": "04",
        "test_install_failures.py": "05",
        "test_post_install.py": "06",
        "test_model_set.py": "07",
        "test_startup_modes.py": "08",
    },
    "REL": {
        "test_rel_001_fresh_install.py": "01",
        "test_rel_002_first_conversation.py": "02",
        "test_rel_003_vault_persistence.py": "03",
        "test_rel_004_locked_state.py": "04",
        "test_rel_005_recovery.py": "05",
        "test_rel_006_two_dinas.py": "06",
        "test_rel_007_trust_network.py": "07",
        "test_rel_008_agent_gateway.py": "08",
        "test_rel_009_persona_wall.py": "09",
        "test_rel_010_hostile_network.py": "10",
        "test_rel_011_failure_handling.py": "11",
        "test_rel_012_doc_claims.py": "12",
        "test_rel_015_install_rerun.py": "15",
        "test_rel_016_upgrade.py": "16",
        "test_rel_017_admin_lifecycle.py": "17",
        "test_rel_018_connector_outage.py": "18",
        "test_rel_019_silence_briefing.py": "19",
        "test_rel_020_cart_handover.py": "20",
        "test_rel_021_export_import.py": "21",
        "test_rel_022_exposure_audit.py": "22",
        "test_rel_023_cli_agent.py": "23",
        "test_rel_024_recommendation_integrity.py": "24",
        "test_rel_025_anti_her.py": "25",
        "test_rel_025_staging_pipeline.py": "25",
        "test_rel_026_silence_stress.py": "26",
        "test_rel_027_action_integrity.py": "27",
        "test_rel_028_install_lifecycle.py": "28",
    },
}


def find_existing_tag(lines: list[str], idx: int, patterns: list[str]) -> str | None:
    """Look back up to 5 lines for an existing tag."""
    for j in range(max(0, idx - 5), idx):
        for pat in patterns:
            m = re.search(pat, lines[j])
            if m:
                return m.group(1)  # The number part.
    return None


def has_trace(lines: list[str], idx: int) -> bool:
    """Check if the line above already has a TRACE comment."""
    if idx > 0 and TRACE_RE.match(lines[idx - 1]):
        return True
    return False


def process_python_file(
    filepath: str, suite: str, case_counter: list[int],
    sections: dict, tag_patterns: list[str], dry_run: bool,
) -> tuple[int, int]:
    """Process a Python test file. Returns (total, modified)."""
    lines = open(filepath).read().split("\n")
    new_lines = []
    total = modified = 0
    i = 0

    while i < len(lines):
        line = lines[i]
        m = PY_FUNC.match(line)
        if m:
            total += 1
            indent = m.group(1)
            func_name = m.group(3)

            # Skip if already has TRACE.
            if has_trace(lines, i):
                new_lines.append(lines[i])
                i += 1
                continue

            # Find existing tag.
            tag_num = find_existing_tag(lines, i, tag_patterns)
            if tag_num:
                case_id = tag_num.zfill(4)
            else:
                case_counter[0] += 1
                case_id = str(case_counter[0]).zfill(4)

            # Extract section from function name.
            sec, sub, scen, title = extract_section_from_name(func_name, suite)

            # File-level fallback if function name had no number pattern.
            if sec == "00":
                fname = os.path.basename(filepath)
                fallback_map = _FILE_SECTION_FALLBACK.get(suite, {})
                sec = fallback_map.get(fname, "99")

            sec_name = sections.get(sec, "Uncategorized")
            if not title or title == func_name:
                title = func_name.replace("test_", "")

            # Build TRACE JSON.
            trace = {
                "suite": suite,
                "case": case_id,
                "section": sec,
                "sectionName": sec_name,
                "subsection": sub,
                "scenario": scen,
                "title": title,
            }
            trace_line = f"{indent}# TRACE: {json.dumps(trace)}"

            new_lines.append(trace_line)
            modified += 1

        new_lines.append(lines[i])
        i += 1

    if modified > 0 and not dry_run:
        open(filepath, "w").write("\n".join(new_lines))

    return total, modified


def process_go_file(
    filepath: str, suite: str, case_counter: list[int],
    sections: dict, tag_patterns: list[str], dry_run: bool,
) -> tuple[int, int]:
    """Process a Go test file. Returns (total, modified)."""
    lines = open(filepath).read().split("\n")
    new_lines = []
    total = modified = 0
    parent_sec = "00"
    i = 0

    while i < len(lines):
        line = lines[i]

        # Top-level test function.
        m = GO_FUNC.match(line)
        if m:
            total += 1
            func_name = m.group(1)

            if has_trace(lines, i):
                new_lines.append(lines[i])
                i += 1
                continue

            tag_num = find_existing_tag(lines, i, tag_patterns)
            if tag_num:
                case_id = tag_num.zfill(4)
            else:
                case_counter[0] += 1
                case_id = str(case_counter[0]).zfill(4)

            sec, sub, scen, title = extract_section_from_name(func_name, suite)
            sec_name = sections.get(sec, "Uncategorized")
            parent_sec = sec  # Track for subtest inheritance.

            trace = {
                "suite": suite,
                "case": case_id,
                "section": sec,
                "sectionName": sec_name,
                "subsection": sub,
                "scenario": scen,
                "title": title,
            }
            trace_line = f"// TRACE: {json.dumps(trace)}"

            new_lines.append(trace_line)
            modified += 1

        # Subtest — inherit section from parent test function.
        m = GO_SUBTEST.match(line)
        if m and not has_trace(lines, i):
            total += 1
            subtest_name = m.group(1)
            case_counter[0] += 1
            case_id = str(case_counter[0]).zfill(4)

            # Try extracting from subtest name first.
            sec, sub, scen, title = extract_section_from_name(subtest_name, suite)
            # If no section found, inherit from parent.
            if sec == "00" and parent_sec != "00":
                sec = parent_sec
            sec_name = sections.get(sec, "Uncategorized")

            indent = re.match(r"(\s*)", line).group(1)
            trace = {
                "suite": suite,
                "case": case_id,
                "section": sec,
                "sectionName": sec_name,
                "title": subtest_name,
            }
            trace_line = f"{indent}// TRACE: {json.dumps(trace)}"

            new_lines.append(trace_line)
            modified += 1

        new_lines.append(lines[i])
        i += 1

    if modified > 0 and not dry_run:
        open(filepath, "w").write("\n".join(new_lines))

    return total, modified


def process_ts_file(
    filepath: str, suite: str, case_counter: list[int],
    sections: dict, tag_patterns: list[str], dry_run: bool,
) -> tuple[int, int]:
    """Process a TypeScript test file. Returns (total, modified)."""
    lines = open(filepath).read().split("\n")
    new_lines = []
    total = modified = 0
    i = 0

    while i < len(lines):
        line = lines[i]
        m = TS_IT.match(line)
        if m:
            total += 1
            test_name = m.group(2)

            if has_trace(lines, i):
                new_lines.append(lines[i])
                i += 1
                continue

            tag_num = find_existing_tag(lines, i, tag_patterns)
            if tag_num:
                case_id = tag_num.zfill(4)
            else:
                case_counter[0] += 1
                case_id = str(case_counter[0]).zfill(4)

            indent = re.match(r"(\s*)", line).group(1)
            trace = {
                "suite": suite,
                "case": case_id,
                "section": "01",
                "sectionName": "General",
                "title": test_name[:80],
            }
            trace_line = f"{indent}// TRACE: {json.dumps(trace)}"

            new_lines.append(trace_line)
            modified += 1

        new_lines.append(lines[i])
        i += 1

    if modified > 0 and not dry_run:
        open(filepath, "w").write("\n".join(new_lines))

    return total, modified


def main():
    parser = argparse.ArgumentParser(description="Migrate tests to TRACE format")
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run)")
    parser.add_argument("--suite", help="Process single suite (e.g., BRAIN, CLI)")
    args = parser.parse_args()

    dry_run = not args.apply
    if dry_run:
        print("DRY RUN — use --apply to write changes\n")

    grand_total = grand_modified = 0

    for suite_name, (dir_path, lang) in SUITES.items():
        if args.suite and suite_name != args.suite.upper():
            continue
        if not os.path.isdir(dir_path):
            continue

        sections = SECTIONS.get(suite_name, {})
        tag_pats = TAG_PATTERNS.get(suite_name, [])

        # Find max existing case number to continue from.
        case_counter = [0]

        suite_total = suite_modified = 0

        if lang == "python":
            for fname in sorted(os.listdir(dir_path)):
                if not fname.startswith("test_") or not fname.endswith(".py"):
                    continue
                fpath = os.path.join(dir_path, fname)
                t, m = process_python_file(fpath, suite_name, case_counter, sections, tag_pats, dry_run)
                suite_total += t
                suite_modified += m

        elif lang == "go":
            for fname in sorted(os.listdir(dir_path)):
                if not fname.endswith("_test.go"):
                    continue
                fpath = os.path.join(dir_path, fname)
                t, m = process_go_file(fpath, suite_name, case_counter, sections, tag_pats, dry_run)
                suite_total += t
                suite_modified += m
            # Also check internal test files.
            for root, dirs, files in os.walk(os.path.join(os.path.dirname(dir_path), "internal")):
                for fname in sorted(files):
                    if not fname.endswith("_test.go"):
                        continue
                    fpath = os.path.join(root, fname)
                    t, m = process_go_file(fpath, suite_name, case_counter, sections, tag_pats, dry_run)
                    suite_total += t
                    suite_modified += m

        elif lang == "typescript":
            for root, dirs, files in os.walk(dir_path):
                for fname in sorted(files):
                    if not fname.endswith(".test.ts"):
                        continue
                    fpath = os.path.join(root, fname)
                    t, m = process_ts_file(fpath, suite_name, case_counter, sections, tag_pats, dry_run)
                    suite_total += t
                    suite_modified += m

        action = "would add" if dry_run else "added"
        print(f"  {suite_name}: {suite_modified}/{suite_total} TRACE comments {action}")
        grand_total += suite_total
        grand_modified += suite_modified

    print(f"\n  TOTAL: {grand_modified}/{grand_total} TRACE comments {'(dry-run)' if dry_run else 'applied'}")


if __name__ == "__main__":
    main()
