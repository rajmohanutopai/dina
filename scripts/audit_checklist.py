#!/usr/bin/env python3
"""Comprehensive test audit checklist for the entire Dina project.

Auto-discovers every test function across all test suites and writes
a checklist file showing Reviewed Yes/No status for each.

Covers:
  - test_status.py suites: Integration, E2E, Core Go (unit), Brain Python (unit)
  - run_user_story_tests.sh: User Stories 01-10
  - test_release.py: Release tests

Usage:
    python scripts/audit_checklist.py              # writes AUDIT_CHECKLIST.md
    python scripts/audit_checklist.py --stdout      # prints to terminal instead
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_FILE = ROOT / "AUDIT_CHECKLIST.md"

# ---------------------------------------------------------------------------
# Directories to scan (auto-discover all test files)
# ---------------------------------------------------------------------------

SECTIONS = [
    # (section_name, runner, directory, file_glob, lang)
    ("Integration Tests", "test_status.py", "tests/integration", "test_*.py", "py"),
    ("E2E Tests", "test_status.py", "tests/e2e", "test_suite_*.py", "py"),
    ("Core Go Unit Tests", "test_status.py", "core/test", "*_test.go", "go"),
    ("Brain Python Unit Tests", "test_status.py", "brain/tests", "test_*.py", "py"),
    ("User Story Tests", "run_user_story_tests.sh", "tests/system/user_stories", "test_*.py", "py"),
    ("Release Tests", "test_release.py", "tests/release", "test_*.py", "py"),
]

# ---------------------------------------------------------------------------
# Reviewed tests — these were audited and confirmed correct
# Key: (relative_file_path, test_func_name) or just test_func_name
# ---------------------------------------------------------------------------

# Tests audited in the March 2026 batch (81 tests + Go handler fixes).
# Keyed by (file_stem, func_name) to avoid ambiguity across files.
_REVIEWED_SET: set[tuple[str, str]] = set()

# -- Integration (26 tests from test_arch_medium_2 and test_arch_medium_3) --
for fn in [
    ("test_arch_medium_2", "test_brain_cannot_reach_pds"),
    ("test_arch_medium_2", "test_managed_hosting_15min_snapshots"),
    ("test_arch_medium_2", "test_estate_read_only_90_days_expires"),
    ("test_arch_medium_2", "test_watchdog_breach_tier2_notification"),
    ("test_arch_medium_2", "test_docker_log_rotation_config"),
    ("test_arch_medium_3", "test_reconnect_reestablishes_session"),
    ("test_arch_medium_3", "test_reconnect_no_stale_replay"),
    ("test_arch_medium_3", "test_device_online_offline_tracks_lifecycle"),
    ("test_arch_medium_3", "test_unauth_socket_closes_after_timeout"),
    ("test_arch_medium_3", "test_poisoned_content_no_outbound_side_effect"),
    ("test_arch_medium_3", "test_sender_receives_structured_not_raw"),
    ("test_arch_medium_3", "test_mcp_allowlist_blocks_disallowed_tools"),
    ("test_arch_medium_3", "test_user_directed_egress_allowed_autonomous_blocked"),
    ("test_arch_medium_3", "test_vault_query_limits_enforced"),
    ("test_arch_medium_3", "test_tier1_fiduciary_interrupts"),
    ("test_arch_medium_3", "test_tier2_solicited_notifies"),
    ("test_arch_medium_3", "test_tier3_engagement_queues"),
    ("test_arch_medium_3", "test_briefing_drains_queued_tier3"),
    ("test_arch_medium_3", "test_crash_during_briefing_no_duplicates"),
    ("test_arch_medium_3", "test_expired_message_stored_silently"),
    ("test_arch_medium_3", "test_full_spool_rejects_new_preserves_existing"),
    ("test_arch_medium_3", "test_crash_restart_preserves_spool"),
    ("test_arch_medium_3", "test_backfill_to_live_no_duplicates"),
    ("test_arch_medium_3", "test_subject_canonicalization"),
    ("test_arch_medium_3", "test_aggregate_recomputes_after_amendment"),
    ("test_arch_medium_3", "test_tombstone_removes_from_query"),
]:
    _REVIEWED_SET.add(fn)

# -- E2E suites 17-20 (12 tests) --
for fn in [
    ("test_suite_17_quiet_dina", "test_mixed_tier_interrupt_notify_queue"),
    ("test_suite_17_quiet_dina", "test_daily_briefing_summarizes_queued"),
    ("test_suite_17_quiet_dina", "test_briefing_regenerates_after_crash"),
    ("test_suite_18_move_machine", "test_export_import_restores_data"),
    ("test_suite_18_move_machine", "test_mnemonic_recovery_identity_only"),
    ("test_suite_18_move_machine", "test_import_requires_device_repairing"),
    ("test_suite_19_connector_failure", "test_openclaw_outage_degrades_recovers"),
    ("test_suite_19_connector_failure", "test_telegram_credential_expiry"),
    ("test_suite_19_connector_failure", "test_fast_sync_backfill_resume"),
    ("test_suite_20_operator_upgrade", "test_rerun_install_no_identity_rotation"),
    ("test_suite_20_operator_upgrade", "test_locked_node_admin_journey"),
    ("test_suite_20_operator_upgrade", "test_verified_upgrade_requires_operator_action"),
]:
    _REVIEWED_SET.add(fn)

# -- User stories 07-10 (20 tests) --
for fn in [
    ("test_07_daily_briefing", "test_00_store_context_for_briefing"),
    ("test_07_daily_briefing", "test_01_fiduciary_event_interrupts"),
    ("test_07_daily_briefing", "test_02_engagement_event_queued"),
    ("test_07_daily_briefing", "test_03_briefing_retrieves_queued_items"),
    ("test_07_daily_briefing", "test_04_briefing_clear_after_delivery"),
    ("test_08_move_to_new_machine", "test_00_store_data_on_node_a"),
    ("test_08_move_to_new_machine", "test_01_record_identity"),
    ("test_08_move_to_new_machine", "test_02_data_exportable"),
    ("test_08_move_to_new_machine", "test_03_node_b_has_same_identity_scheme"),
    ("test_08_move_to_new_machine", "test_04_vault_operations_work_on_node_b"),
    ("test_09_connector_expiry", "test_00_core_healthy_baseline"),
    ("test_09_connector_expiry", "test_01_vault_works_without_brain"),
    ("test_09_connector_expiry", "test_02_brain_down_error_clear"),
    ("test_09_connector_expiry", "test_03_recovery_after_outage"),
    ("test_09_connector_expiry", "test_04_did_works_independently"),
    ("test_10_operator_journey", "test_00_record_baseline_did"),
    ("test_10_operator_journey", "test_01_did_stable_across_requests"),
    ("test_10_operator_journey", "test_02_persona_recreate_idempotent"),
    ("test_10_operator_journey", "test_03_healthz_stable"),
    ("test_10_operator_journey", "test_04_locked_persona_clear_error"),
]:
    _REVIEWED_SET.add(fn)

# -- Core Go (11 tests from identity_deterministic_test.go) --
for fn in [
    ("identity_deterministic_test", "TestDeterministicIdentity_CorruptMetadataFailsClosed"),
    ("identity_deterministic_test", "TestDeterministicIdentity_GenerationPersistsAcrossRestart"),
    ("identity_deterministic_test", "TestDeterministicIdentity_RejectsNonNextGeneration"),
    ("identity_deterministic_test", "TestDeterministicIdentity_PLCBranchIsolated"),
    ("identity_deterministic_test", "TestVectorSecurity_UnlockHydratesHNSW"),
    ("identity_deterministic_test", "TestVectorSecurity_LockDestroysIndex"),
    ("identity_deterministic_test", "TestVectorSecurity_NoPlaintextVectorFiles"),
    ("identity_deterministic_test", "TestVectorSecurity_RestartRebuildsFromSQLCipher"),
    ("identity_deterministic_test", "TestStaticAudit_NoLatestTags"),
    ("identity_deterministic_test", "TestStaticAudit_NoUnexpectedPublicRoutes"),
    ("identity_deterministic_test", "TestStaticAudit_NoPlaintextVectorPatterns"),
]:
    _REVIEWED_SET.add(fn)

# -- Brain Python (12 tests from test_pipeline_safety and test_fix_verification) --
for fn in [
    ("test_pipeline_safety", "test_reader_pipeline_no_outbound_tools"),
    ("test_pipeline_safety", "test_sender_receives_structured_not_raw"),
    ("test_pipeline_safety", "test_disallowed_mcp_tool_rejected"),
    ("test_pipeline_safety", "test_tier3_queued_not_interrupted"),
    ("test_pipeline_safety", "test_briefing_deduplicates_repeated_items"),
    ("test_pipeline_safety", "test_briefing_crash_regenerates_from_source"),
    ("test_pipeline_safety", "test_openclaw_unavailable_maps_degraded"),
    ("test_pipeline_safety", "test_telegram_auth_failure_maps_expired"),
    ("test_pipeline_safety", "test_connector_recovery_clears_stale_error"),
    ("test_fix_verification", "test_fix_19_11_1_lifespan_starts_sync"),
    ("test_fix_verification", "test_fix_19_11_2_sync_failure_no_crash"),
    ("test_fix_verification", "test_fix_19_11_3_lifespan_shutdown_cancels"),
]:
    _REVIEWED_SET.add(fn)

# ---------------------------------------------------------------------------
# Bugs found during audit (file_stem, func_name) -> note
# ---------------------------------------------------------------------------

AUDIT_NOTES: dict[tuple[str, str], str] = {
    ("test_suite_17_quiet_dina", "test_briefing_regenerates_after_crash"):
        "FIXED: FTS query 'engagement_event' -> 'daily'",
    ("test_10_operator_journey", "test_04_locked_persona_clear_error"):
        "FIXED: Go handler returns 'persona locked' in body",
    ("test_suite_18_move_machine", "test_export_import_restores_data"):
        "FIXED: TrustRing enum -> .value for JSON",
    ("test_07_daily_briefing", "test_02_engagement_event_queued"):
        "FIXED: Accept (200, 204) for KV PUT",
    ("test_07_daily_briefing", "test_04_briefing_clear_after_delivery"):
        "FIXED: Accept (200, 204) for KV PUT",
    ("test_08_move_to_new_machine", "test_01_record_identity"):
        "FIXED: get('id') not get('did')",
    ("test_08_move_to_new_machine", "test_03_node_b_has_same_identity_scheme"):
        "FIXED: get('id') not get('did')",
    ("test_09_connector_expiry", "test_04_did_works_independently"):
        "FIXED: get('id') not get('did')",
    ("test_10_operator_journey", "test_00_record_baseline_did"):
        "FIXED: get('id') not get('did')",
    ("test_10_operator_journey", "test_01_did_stable_across_requests"):
        "FIXED: get('id') not get('did')",
}

# ---------------------------------------------------------------------------
# Extract tests from a single file
# ---------------------------------------------------------------------------

PY_TEST_RE = re.compile(r"^\s*(?:async\s+)?def\s+(test_\w+)\s*\(", re.MULTILINE)
GO_TEST_RE = re.compile(r"^\s*func\s+(Test\w+)\s*\(", re.MULTILINE)
PY_MARKER_RE = re.compile(r"#\s*(TST-\w+-\d+)")
GO_MARKER_RE = re.compile(r"//\s*(TST-\w+-\d+)")


def extract_tests(filepath: Path, lang: str) -> list[tuple[str, str]]:
    """Return [(func_name, marker), ...] from a test file."""
    if not filepath.exists():
        return []

    text = filepath.read_text()
    is_go = lang == "go"
    test_re = GO_TEST_RE if is_go else PY_TEST_RE
    mark_re = GO_MARKER_RE if is_go else PY_MARKER_RE

    results = []
    lines = text.splitlines()

    for i, line in enumerate(lines):
        m = test_re.match(line)
        if not m:
            continue
        func_name = m.group(1)

        # Search nearby lines for TST marker.
        marker = ""
        for j in range(max(0, i - 5), min(len(lines), i + 4)):
            mm = mark_re.search(lines[j])
            if mm:
                marker = mm.group(1)
                break

        results.append((func_name, marker))

    return results


def file_stem(filepath: Path, lang: str) -> str:
    """Return the stem used for reviewed-set lookup."""
    name = filepath.stem
    if lang == "go":
        # identity_test.go -> identity_test
        return name
    return name


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    to_stdout = "--stdout" in sys.argv

    lines_out: list[str] = []

    def out(s: str = "") -> None:
        lines_out.append(s)

    grand_total = 0
    grand_reviewed = 0
    grand_not_reviewed = 0
    section_summaries: list[tuple[str, int, int, int]] = []

    out("# Dina — Complete Test Audit Checklist")
    out("")
    out("Auto-generated by `python scripts/audit_checklist.py`.")
    out("Covers every test function across all runners.")
    out("")

    for section_name, runner, directory, file_glob, lang in SECTIONS:
        scan_dir = ROOT / directory
        if not scan_dir.exists():
            continue

        files = sorted(scan_dir.glob(file_glob))
        if not files:
            continue

        sec_total = 0
        sec_yes = 0
        sec_no = 0

        out(f"## {section_name}")
        out(f"Runner: `{runner}` | Directory: `{directory}/`")
        out("")
        out(f"| # | File | Test Function | Marker | Reviewed | Note |")
        out(f"|---|------|---------------|--------|----------|------|")

        n = 0
        for fpath in files:
            tests = extract_tests(fpath, lang)
            if not tests:
                continue

            stem = file_stem(fpath, lang)
            rel = fpath.relative_to(ROOT)

            for func_name, marker in tests:
                n += 1
                sec_total += 1

                key = (stem, func_name)
                reviewed = key in _REVIEWED_SET
                note = AUDIT_NOTES.get(key, "")

                if reviewed:
                    sec_yes += 1
                    rv = "Yes"
                else:
                    sec_no += 1
                    rv = "No"

                marker_display = marker if marker else ""
                out(
                    f"| {n} | {rel.name} | `{func_name}` | {marker_display} | {rv} | {note} |"
                )

        grand_total += sec_total
        grand_reviewed += sec_yes
        grand_not_reviewed += sec_no
        section_summaries.append((section_name, sec_total, sec_yes, sec_no))

        out("")
        out(f"**{section_name} totals:** {sec_total} tests, {sec_yes} reviewed, {sec_no} pending")
        out("")
        out("---")
        out("")

    # Summary
    out("## Summary")
    out("")
    out("| Section | Total | Reviewed | Pending |")
    out("|---------|-------|----------|---------|")
    for name, total, yes, no in section_summaries:
        out(f"| {name} | {total} | {yes} | {no} |")
    out(f"| **TOTAL** | **{grand_total}** | **{grand_reviewed}** | **{grand_not_reviewed}** |")
    out("")

    pct = (grand_reviewed / grand_total * 100) if grand_total else 0
    out(f"**Audit coverage: {grand_reviewed}/{grand_total} ({pct:.1f}%)**")
    out("")

    body = "\n".join(lines_out) + "\n"

    if to_stdout:
        sys.stdout.write(body)
    else:
        OUTPUT_FILE.write_text(body)
        print(f"Wrote {OUTPUT_FILE.relative_to(ROOT)} ({grand_total} tests)")
        print(f"  Reviewed: {grand_reviewed}  |  Pending: {grand_not_reviewed}")


if __name__ == "__main__":
    main()
