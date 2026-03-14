#!/usr/bin/env python3
"""Generate Dina test report from captured suite output.

Called by run_all_tests.sh after all suites complete. Reads per-suite log
files from a temp directory, parses results tables, and produces:
  1. A terminal grand summary table (printed to stdout)
  2. A standalone HTML report at all_test_results.html

Usage:
    python3 scripts/generate_test_report.py <suite_output_dir> <total_elapsed_s>
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUITE_COLORS = {
    1: "#2563EB",  # Core blue
    2: "#059669",  # Brain green
    3: "#7C3AED",  # PDS purple
    4: "#D97706",  # Amber
    5: "#0891B2",  # Teal
}

EMPTY_SUMMARY = {"total": 0, "passed": 0, "failed": 0, "skipped": 0, "xfail": 0}

# Story descriptions — the narrative heart of Dina, mirroring run_user_story_tests.sh
USER_STORY_META = {
    1: {
        "name": "The Purchase Journey",
        "desc": [
            '\u201cI need a chair\u201d -> 5 reviewers created (3 verified Ring 2, 2 unverified Ring 1)',
            "Dina checks health vault (back pain, needs lumbar), finance vault (budget 10-20K INR)",
            "Trust-weighted reviews: skip CheapChair (low trust score), recommends ErgoMax Elite",
        ],
    },
    2: {
        "name": "The Sancho Moment",
        "desc": [
            "Sancho arrives -> Sancho\u2019s Dina contacts your Dina (D2D encrypted, Ed25519 signed)",
            'Your Dina searches vault by Sancho\u2019s DID, finds: \u201chis mother had a fall\u201d, \u201clikes cardamom tea\u201d',
            'Nudge: \u201cSancho 15 min away. Ask about his sick mother. Make cardamom tea.\u201d',
        ],
    },
    3: {
        "name": "The Dead Internet Filter",
        "desc": [
            '\u201cIs this video AI?\u201d -> Dina resolves creator DID via AT Protocol Trust Network',
            'Elena (Ring 3): 200 attestations, 15 peer vouches, 2yr history -> \u201cauthentic, trusted creator\u201d',
            'BotFarm (Ring 1): 0 attestations, 3-day-old account -> \u201cunverified, check other sources\u201d',
        ],
    },
    4: {
        "name": "The Persona Wall",
        "desc": [
            'Shopping agent asks \u201cany health conditions?\u201d -> Guardian blocks cross-persona access',
            'Health (restricted): \u201cL4-L5 herniation\u201d withheld. Proposes \u201cchronic back pain\u201d only',
            "User approves minimal disclosure. PII scrubber confirms no diagnosis leaked",
        ],
    },
    5: {
        "name": "The Agent Gateway",
        "desc": [
            "OpenClaw/Perplexity Computer wants to send email -> pairs with Home Node, asks Dina first",
            'Dina checks: safe? matches your rules? PII leaking? \u201csend_email\u201d -> MODERATE, asks you first',
            "Safe tasks (web search) pass silently. Rogue agent with no auth -> 401, blocked at the gate",
        ],
    },
    6: {
        "name": "The License Renewal",
        "desc": [
            "User uploads license scan -> Brain extracts fields with confidence scores",
            "Deterministic reminder fires 30 days before expiry (no LLM in the scheduling)",
            "Delegation: Brain generates strict JSON for DMV-Bot. Guardian flags for human review",
        ],
    },
    7: {
        "name": "The Daily Briefing",
        "desc": [
            "Most noise waits quietly. Real harm interrupts immediately.",
            "At the end of the day, Dina gives one calm summary and clears the queue.",
        ],
    },
    8: {
        "name": "Move to a New Machine",
        "desc": [
            "Dina exports from the old machine and imports on the new one as an encrypted archive.",
            "The wrong seed cannot unlock the vault. The same seed restores identity and data.",
            "Migration is non-destructive: the old machine still works after export.",
        ],
    },
    9: {
        "name": "Connector Credential Expiry",
        "desc": [
            "Gmail OAuth expires \u2014 connector status: expired. Vault and identity still work.",
            "User reconfigures credentials, connector resumes. No cascade, no crash.",
        ],
    },
    10: {
        "name": "The Operator Journey",
        "desc": [
            "Re-run install script \u2014 DID unchanged (idempotent). No rotation, no orphaned data.",
            "Identity is derived from master seed \u2014 immutable after bootstrap.",
        ],
    },
    11: {
        "name": "The Anti-Her",
        "desc": [
            '\u201cHaven\u2019t talked to Sarah in 45 days\u201d -> proactive nudge in briefing, not on demand.',
            'Life event follow-up: \u201cSancho\u2019s mother was ill\u201d -> \u201cyou might want to check in.\u201d',
            "Emotional dependency detected -> Dina suggests specific humans, never herself.",
        ],
    },
    12: {
        "name": "Verified Truth",
        "desc": [
            "When Dina has little evidence, she says so honestly.",
            "When people disagree, she says the evidence is mixed instead of pretending certainty.",
            "When the signal is strong, she speaks clearly and points back to the original sources.",
        ],
    },
    13: {
        "name": "Silence Under Stress",
        "desc": [
            "Even in a flood of alerts, Dina interrupts only for what truly matters.",
            "Fake urgency from strangers is suspicious; trusted urgent events can break through.",
        ],
    },
    14: {
        "name": "Agent Sandbox",
        "desc": [
            "No auth, no access. Revoked means revoked immediately.",
            "Sensitive actions stay blocked unless you approve them.",
            "Agents cannot impersonate someone else.",
        ],
    },
}


# ---------------------------------------------------------------------------
# ANSI / text helpers
# ---------------------------------------------------------------------------


def strip_ansi(text: str) -> str:
    """Remove ANSI escape sequences from text."""
    return re.sub(r"\x1b\[[0-9;]*m", "", text)


def fmt_duration(seconds: int) -> str:
    """Format seconds as Xm Ys."""
    m, s = divmod(seconds, 60)
    if m > 0:
        return f"{m}m{s:02d}s"
    return f"{s}s"


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------


def _extract_integers(parts: list[str]) -> list[int]:
    """Extract pure integer values from pipe-split parts."""
    nums = []
    for p in parts:
        p = p.strip()
        if re.match(r"^\d+$", p):
            nums.append(int(p))
    return nums


def _nums_to_summary(nums: list[int]) -> dict | None:
    """Map 4-5 consecutive integers to total/pass/skip/fail(/xfail)."""
    if len(nums) < 4:
        return None
    return {
        "total": nums[0],
        "passed": nums[1],
        "skipped": nums[2],
        "failed": nums[3],
        "xfail": nums[4] if len(nums) >= 5 else 0,
    }


def parse_pipe_tables(clean_text: str) -> tuple[list[dict], dict | None]:
    """Parse pipe-delimited tables from test runner output.

    Returns (sub_suites, grand_summary_total).

    Each sub_suite: {"name": str, "sections": [...], "total": dict|None}
    """
    lines = clean_text.splitlines()

    sub_suites: list[dict] = []
    grand_total: dict | None = None

    current_name: str | None = None
    current_sections: list[dict] = []
    current_total: dict | None = None
    in_grand_summary = False

    for line in lines:
        # Detect "=== Name ===" or "=== Name ===  (Xm Ys)"
        hdr = re.match(r"\s*===\s+(.+?)\s+===", line)
        if hdr:
            # Save previous section
            if current_name is not None:
                if in_grand_summary:
                    if current_total:
                        grand_total = current_total
                else:
                    sub_suites.append({
                        "name": current_name,
                        "sections": current_sections,
                        "total": current_total,
                    })

            raw_name = hdr.group(1).strip()
            current_name = re.sub(r"\s*\([\d.]+[msh]+[\d.]*[msh]*\)\s*$", "", raw_name)
            current_sections = []
            current_total = None
            in_grand_summary = "grand summary" in current_name.lower()
            continue

        if "|" not in line:
            continue

        parts = [p.strip() for p in line.split("|")]

        # TOTAL line
        if any("TOTAL" in p for p in parts):
            nums = _extract_integers(parts)
            s = _nums_to_summary(nums)
            if s:
                current_total = s
            continue

        # Section row (starts with a number)
        if parts and parts[0] and parts[0].isdigit():
            name = parts[1] if len(parts) > 1 else ""
            nums = _extract_integers(parts[2:])
            s = _nums_to_summary(nums)
            if s:
                s["number"] = int(parts[0])
                s["name"] = name
                current_sections.append(s)

    # Save last section
    if current_name is not None:
        if in_grand_summary:
            if current_total:
                grand_total = current_total
        else:
            sub_suites.append({
                "name": current_name,
                "sections": current_sections,
                "total": current_total,
            })

    return sub_suites, grand_total


def parse_user_story_output(clean_text: str) -> tuple[list[dict], dict | None]:
    """Parse user story banner output (run_user_story_tests.sh --brief).

    Returns (stories, overall_summary).
    """
    stories: list[dict] = []
    overall_passed: int | None = None
    overall_total: int | None = None
    overall_skipped = 0

    for line in clean_text.splitlines():
        # Per-story inside ║: "║  01 The Purchase Journey  13/13 passed  ║"
        if "\u2551" in line:  # ║
            m = re.search(r"(\d{2})\s+(.+?)\s+(\d+)/(\d+)\s+passed", line)
            if m:
                stories.append({
                    "number": int(m.group(1)),
                    "name": m.group(2).strip(),
                    "total": int(m.group(4)),
                    "passed": int(m.group(3)),
                    "failed": int(m.group(4)) - int(m.group(3)),
                    "skipped": 0,
                    "xfail": 0,
                })
            continue

        # Overall: "103/103 passed" (not inside ║)
        m = re.search(r"(\d+)/(\d+)\s+passed", line)
        if m:
            overall_passed = int(m.group(1))
            overall_total = int(m.group(2))

        # Skipped count: "5 skipped"
        m = re.search(r"(\d+)\s+skipped", line)
        if m:
            overall_skipped = int(m.group(1))

    if overall_total is not None:
        summary = {
            "total": overall_total,
            "passed": overall_passed or 0,
            "failed": overall_total - (overall_passed or 0),
            "skipped": overall_skipped,
            "xfail": 0,
        }
    elif stories:
        summary = {
            "total": sum(s["total"] for s in stories),
            "passed": sum(s["passed"] for s in stories),
            "failed": sum(s["failed"] for s in stories),
            "skipped": 0,
            "xfail": 0,
        }
    else:
        summary = None

    return stories, summary


def parse_pytest_summary(clean_text: str) -> dict | None:
    """Fallback: parse pytest's final summary line.

    E.g.: "714 passed, 12 skipped, 5 xfailed in 245.12s"
    """
    # Look for the pytest summary line (= ... =)
    for line in reversed(clean_text.splitlines()):
        if "passed" in line and ("=" in line or "failed" in line or "error" in line):
            passed = _extract_first_int(r"(\d+)\s+passed", line)
            if passed is None:
                continue
            failed = _extract_first_int(r"(\d+)\s+failed", line) or 0
            skipped = _extract_first_int(r"(\d+)\s+skipped", line) or 0
            xfailed = _extract_first_int(r"(\d+)\s+xfailed", line) or 0
            errors = _extract_first_int(r"(\d+)\s+error", line) or 0
            total = passed + failed + skipped + xfailed + errors
            return {
                "total": total,
                "passed": passed,
                "failed": failed + errors,
                "skipped": skipped,
                "xfail": xfailed,
            }
    return None


def _extract_first_int(pattern: str, text: str) -> int | None:
    m = re.search(pattern, text)
    return int(m.group(1)) if m else None


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def parse_suite_log(filepath: str, suite_name: str, suite_num: int) -> dict:
    """Parse a single suite's captured output log."""
    try:
        text = Path(filepath).read_text()
    except FileNotFoundError:
        return {
            "number": suite_num,
            "name": suite_name,
            "sub_suites": [],
            "summary": dict(EMPTY_SUMMARY),
        }

    clean = strip_ansi(text)

    # Try pipe-delimited tables (test_status.py, test_release.py, test_appview.ts)
    sub_suites, grand_total = parse_pipe_tables(clean)

    if sub_suites:
        if grand_total:
            overall = grand_total
        elif len(sub_suites) == 1 and sub_suites[0].get("total"):
            overall = sub_suites[0]["total"]
        else:
            overall = {
                "total": sum(
                    (s["total"] or {}).get("total", 0) for s in sub_suites
                ),
                "passed": sum(
                    (s["total"] or {}).get("passed", 0) for s in sub_suites
                ),
                "failed": sum(
                    (s["total"] or {}).get("failed", 0) for s in sub_suites
                ),
                "skipped": sum(
                    (s["total"] or {}).get("skipped", 0) for s in sub_suites
                ),
                "xfail": sum(
                    (s["total"] or {}).get("xfail", 0) for s in sub_suites
                ),
            }
        return {
            "number": suite_num,
            "name": suite_name,
            "sub_suites": sub_suites,
            "summary": overall,
        }

    # Try user story format
    stories, story_summary = parse_user_story_output(clean)
    if stories:
        return {
            "number": suite_num,
            "name": suite_name,
            "sub_suites": [
                {"name": suite_name, "sections": stories, "total": story_summary}
            ],
            "summary": story_summary or dict(EMPTY_SUMMARY),
        }

    # Fallback: pytest summary line
    fallback = parse_pytest_summary(clean)
    return {
        "number": suite_num,
        "name": suite_name,
        "sub_suites": [],
        "summary": fallback or dict(EMPTY_SUMMARY),
    }


# ---------------------------------------------------------------------------
# Terminal grand summary
# ---------------------------------------------------------------------------

_GREEN = "\033[32m"
_RED = "\033[1;31m"
_BOLD = "\033[1m"
_CYAN = "\033[36m"
_DIM = "\033[2m"
_RESET = "\033[0m"


def _flatten_summary_rows(suites: list[dict]) -> list[dict]:
    """Expand suites with multiple sub-suites into flat summary rows.

    A suite like "Integration Tests" with sub-suites Core (Go), Brain (Py),
    Integration, E2E (Docker), CLI (Py) becomes 5 separate rows.
    Single sub-suite entries stay as one row.
    """
    rows: list[dict] = []
    for s in suites:
        subs = s.get("sub_suites", [])
        if len(subs) > 1:
            # Expand: each sub-suite becomes its own row
            for sub in subs:
                total = sub.get("total") or dict(EMPTY_SUMMARY)
                rows.append({"name": sub["name"], "summary": total})
        else:
            # Single sub-suite or no sub-suites: one row
            rows.append({"name": s["name"], "summary": s["summary"]})
    return rows


def render_terminal_summary(
    suites: list[dict], total_elapsed: int, *, use_color: bool = True
) -> None:
    """Print a grand summary table to stdout."""
    if not use_color:
        g = r = b = c = d = x = ""
    else:
        g, r, b, c, d, x = _GREEN, _RED, _BOLD, _CYAN, _DIM, _RESET

    rows = _flatten_summary_rows(suites)

    has_xfail = any(row["summary"].get("xfail", 0) > 0 for row in rows)
    xf_hdr = " \u2502 XFail" if has_xfail else ""
    xf_rule = "\u253c\u2500\u2500\u2500\u2500\u2500\u2500" if has_xfail else ""

    bar = "\u2550" * 64
    print()
    print(f"  {b}{c}{bar}{x}")
    print(f"  {b}  Grand Summary  ({fmt_duration(total_elapsed)}){x}")
    print(f"  {b}{c}{bar}{x}")
    print()

    # Header
    print(
        f"  {b}{'Suite':<30}{x}"
        f" \u2502 {'Total':>5}"
        f" \u2502 {'Pass':>5}"
        f" \u2502 {'Fail':>5}"
        f" \u2502 {'Skip':>5}"
        f"{xf_hdr}"
        f" \u2502 Status"
    )
    rule = (
        f"  {'\u2500' * 30}"
        f"\u253c{'\u2500' * 7}"
        f"\u253c{'\u2500' * 7}"
        f"\u253c{'\u2500' * 7}"
        f"\u253c{'\u2500' * 7}"
        f"{xf_rule}"
        f"\u253c{'\u2500' * 10}"
    )
    print(rule)

    gt = gp = gf = gs = gx = 0
    for row in rows:
        sm = row["summary"]
        t, p, f_, sk, xf = (
            sm["total"], sm["passed"], sm["failed"], sm["skipped"], sm.get("xfail", 0),
        )
        gt += t
        gp += p
        gf += f_
        gs += sk
        gx += xf

        status = f"{g}PASS{x}" if f_ == 0 else f"{r}FAIL{x}"
        xf_col = f" \u2502 {xf:>5}" if has_xfail else ""
        print(
            f"  {row['name']:<30}"
            f" \u2502 {t:>5}"
            f" \u2502 {p:>5}"
            f" \u2502 {f_:>5}"
            f" \u2502 {sk:>5}"
            f"{xf_col}"
            f" \u2502 {status}"
        )

    print(rule)
    all_pass = gf == 0
    total_status = (
        f"{g}{b}ALL PASS{x}" if all_pass else f"{r}{b}FAILED{x}"
    )
    xf_tot = f" \u2502 {gx:>5}" if has_xfail else ""
    print(
        f"  {b}{'TOTAL':<30}{x}"
        f" \u2502 {b}{gt:>5}{x}"
        f" \u2502 {g}{gp:>5}{x}"
        f" \u2502 {(r if gf else d)}{gf:>5}{x}"
        f" \u2502 {(d)}{gs:>5}{x}"
        f"{xf_tot}"
        f" \u2502 {total_status}"
    )
    print()


# ---------------------------------------------------------------------------
# HTML report
# ---------------------------------------------------------------------------


def _pass_rate(summary: dict) -> float:
    t = summary.get("total", 0)
    if t == 0:
        return 100.0
    return summary.get("passed", 0) / t * 100


def _status_class(summary: dict) -> str:
    if summary.get("failed", 0) > 0:
        return "fail"
    if summary.get("skipped", 0) > 0:
        return "skip"
    return "pass"


def _badge(text: str, cls: str) -> str:
    return f'<span class="badge {cls}">{text}</span>'


def _section_rows_html(sections: list[dict], has_xfail: bool) -> str:
    """Build <tr> rows for a sections table."""
    rows = []
    for sec in sections:
        st = _status_class(sec)
        xf_td = f'<td class="num">{sec.get("xfail", 0)}</td>' if has_xfail else ""
        rows.append(
            f'<tr>'
            f'<td class="num">{sec["number"]}</td>'
            f'<td>{sec["name"]}</td>'
            f'<td class="num">{sec["total"]}</td>'
            f'<td class="num">{sec["passed"]}</td>'
            f'<td class="num">{sec.get("failed", 0)}</td>'
            f'<td class="num">{sec.get("skipped", 0)}</td>'
            f'{xf_td}'
            f'<td>{_badge("PASS" if sec.get("failed", 0) == 0 else "FAIL", st)}</td>'
            f'</tr>'
        )
    return "\n".join(rows)


def _user_stories_card_html(stories: list[dict], summary: dict) -> str:
    """Build the user stories showcase card with descriptions."""
    story_blocks = []
    for story in stories:
        num = story["number"]
        meta = USER_STORY_META.get(num, {})
        name = meta.get("name", story.get("name", f"Story {num:02d}"))
        descriptions = meta.get("desc", [])

        passed = story["passed"]
        total = story["total"]
        is_pass = story.get("failed", 0) == 0
        badge_cls = "pass" if is_pass else "fail"

        desc_html = "\n".join(f"<p>{d}</p>" for d in descriptions)

        story_blocks.append(
            f'<div class="story">'
            f'<div class="story-header">'
            f'<span class="story-num {badge_cls}">{num:02d}</span>'
            f'<span class="story-name">{name}</span>'
            f'<span class="badge {badge_cls}">{passed}/{total}</span>'
            f'</div>'
            f'<div class="story-desc">{desc_html}</div>'
            f'</div>'
        )

    stories_html = "\n".join(story_blocks)
    sm = summary
    stats = [f'{sm["total"]} tests']
    stats.append(f'<span class="c-pass">{sm["passed"]} passed</span>')
    if sm["failed"]:
        stats.append(f'<span class="c-fail">{sm["failed"]} failed</span>')
    if sm["skipped"]:
        stats.append(f'<span class="c-skip">{sm["skipped"]} skipped</span>')
    stats_html = ' <span class="dot">&middot;</span> '.join(stats)

    rate = sm["passed"] / sm["total"] * 100 if sm["total"] else 100
    rate_cls = "pass" if sm["failed"] == 0 else ("warn" if rate >= 90 else "fail")

    return (
        f'<div class="card stories-showcase">'
        f'<div class="stories-header">'
        f'<h2>User Story Tests</h2>'
        f'<div class="stories-tagline">Full stack integration — no mocks.</div>'
        f'<div class="pass-rate {rate_cls}" style="font-size:1.4rem;margin:8px 0">'
        f'{rate:.1f}%</div>'
        f'<div class="stories-stats">{stats_html}</div>'
        f'</div>'
        f'{stories_html}'
        f'</div>'
    )


def generate_html(
    suites: list[dict], total_elapsed: int, output_path: Path
) -> None:
    """Generate a standalone HTML test report."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Flatten sub-suites into individual rows (matches terminal grand summary)
    flat_rows = _flatten_summary_rows(suites)

    # Grand totals from flattened rows
    gt = sum(r["summary"]["total"] for r in flat_rows)
    gp = sum(r["summary"]["passed"] for r in flat_rows)
    gf = sum(r["summary"]["failed"] for r in flat_rows)
    gs = sum(r["summary"]["skipped"] for r in flat_rows)
    gx = sum(r["summary"].get("xfail", 0) for r in flat_rows)
    has_xfail = gx > 0
    rate = gp / gt * 100 if gt else 100
    rate_class = "pass" if gf == 0 else ("warn" if rate >= 90 else "fail")

    # Assign colors to flattened rows (cycle through palette)
    _colors = list(SUITE_COLORS.values())

    # Build per-suite summary rows (expanded)
    suite_summary_rows = []
    for i, row in enumerate(flat_rows):
        sm = row["summary"]
        st = _status_class(sm)
        color = _colors[i % len(_colors)]
        xf_td = f'<td class="num">{sm.get("xfail", 0)}</td>' if has_xfail else ""
        suite_summary_rows.append(
            f'<tr>'
            f'<td><span class="suite-dot" style="background:{color}"></span> '
            f'{row["name"]}</td>'
            f'<td class="num">{sm["total"]}</td>'
            f'<td class="num">{sm["passed"]}</td>'
            f'<td class="num">{sm["failed"]}</td>'
            f'<td class="num">{sm["skipped"]}</td>'
            f'{xf_td}'
            f'<td>{_badge("PASS" if sm["failed"] == 0 else "FAIL", st)}</td>'
            f'</tr>'
        )
    xf_th = '<th class="num">XFail</th>' if has_xfail else ""
    xf_td_total = f'<td class="num">{gx}</td>' if has_xfail else ""

    summary_table = f"""
    <table>
      <thead>
        <tr>
          <th>Suite</th><th class="num">Total</th><th class="num">Pass</th>
          <th class="num">Fail</th><th class="num">Skip</th>{xf_th}
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {"".join(suite_summary_rows)}
      </tbody>
      <tfoot>
        <tr>
          <td>TOTAL</td><td class="num">{gt}</td><td class="num">{gp}</td>
          <td class="num">{gf}</td><td class="num">{gs}</td>{xf_td_total}
          <td>{_badge("ALL PASS" if gf == 0 else "FAILED", "pass" if gf == 0 else "fail")}</td>
        </tr>
      </tfoot>
    </table>"""

    # Separate user stories from other suites
    user_story_suite = None
    other_suites = []
    for s in suites:
        if "user stor" in s["name"].lower():
            user_story_suite = s
        else:
            other_suites.append(s)

    # Build user stories showcase card (rendered first)
    user_stories_card = ""
    if user_story_suite:
        stories = []
        for sub in user_story_suite.get("sub_suites", []):
            stories.extend(sub.get("sections", []))
        if stories:
            user_stories_card = _user_stories_card_html(
                stories, user_story_suite["summary"]
            )

    # Build per-suite detail cards (remaining suites)
    suite_cards = []
    for s in other_suites:
        color = SUITE_COLORS.get(s["number"], "#78716C")
        sm = s["summary"]
        sr = _pass_rate(sm)
        sr_cls = "pass" if sm["failed"] == 0 else ("warn" if sr >= 90 else "fail")

        # Sub-suite tables
        sub_tables = []
        for sub in s.get("sub_suites", []):
            sections = sub.get("sections", [])
            total = sub.get("total")
            if not sections and not total:
                continue

            sub_has_xfail = any(sec.get("xfail", 0) > 0 for sec in sections)
            if total:
                sub_has_xfail = sub_has_xfail or total.get("xfail", 0) > 0
            xf_sec_th = '<th class="num">XFail</th>' if sub_has_xfail else ""

            section_html = _section_rows_html(sections, sub_has_xfail)

            # TOTAL footer
            total_html = ""
            if total:
                xf_foot = (
                    f'<td class="num">{total.get("xfail", 0)}</td>'
                    if sub_has_xfail else ""
                )
                total_html = f"""
                <tfoot>
                  <tr>
                    <td></td><td>TOTAL</td>
                    <td class="num">{total["total"]}</td>
                    <td class="num">{total["passed"]}</td>
                    <td class="num">{total["failed"]}</td>
                    <td class="num">{total["skipped"]}</td>
                    {xf_foot}
                    <td></td>
                  </tr>
                </tfoot>"""

            # Sub-suite heading (only if multiple sub-suites)
            sub_heading = ""
            if len(s.get("sub_suites", [])) > 1:
                sub_heading = f'<h4>{sub["name"]}</h4>'

            sub_tables.append(f"""
            {sub_heading}
            <table>
              <thead>
                <tr>
                  <th class="num">#</th><th>Section</th>
                  <th class="num">Total</th><th class="num">Pass</th>
                  <th class="num">Fail</th><th class="num">Skip</th>
                  {xf_sec_th}<th>Status</th>
                </tr>
              </thead>
              <tbody>
                {section_html}
              </tbody>
              {total_html}
            </table>""")

        sub_tables_html = "\n".join(sub_tables)
        if not sub_tables_html:
            sub_tables_html = (
                '<p class="no-detail">No section-level detail available.</p>'
            )

        suite_cards.append(f"""
    <div class="card suite-card" style="border-left: 4px solid {color}">
      <div class="suite-header">
        <h3>{s["name"]}</h3>
        <span class="pass-rate {sr_cls}">{sr:.1f}%</span>
      </div>
      <div class="pass-bar"><div class="pass-bar-fill" style="width:{sr:.1f}%;background:{color}"></div></div>
      <div class="suite-stats">
        <span>{sm["total"]} tests</span>
        <span class="dot">&middot;</span>
        <span class="c-pass">{sm["passed"]} passed</span>
        {f'<span class="dot">&middot;</span><span class="c-fail">{sm["failed"]} failed</span>' if sm["failed"] else ""}
        {f'<span class="dot">&middot;</span><span class="c-skip">{sm["skipped"]} skipped</span>' if sm["skipped"] else ""}
        {f'<span class="dot">&middot;</span><span class="c-xfail">{sm.get("xfail", 0)} xfail</span>' if sm.get("xfail", 0) else ""}
      </div>
      {sub_tables_html}
    </div>""")

    suite_cards_html = user_stories_card + "\n".join(suite_cards)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dina &mdash; Test Results</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Figtree:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {{
  --bg: #FAF8F5;
  --card: #FFFFFF;
  --text: #1C1917;
  --text2: #57534E;
  --dim: #A8A29E;
  --border: rgba(0,0,0,0.07);
  --c-pass: #059669;
  --c-fail: #DC2626;
  --c-skip: #D97706;
  --c-xfail: #7C3AED;
  --radius: 20px;
  --radius-sm: 12px;
  --font-h: 'Plus Jakarta Sans', system-ui, sans-serif;
  --font-b: 'Figtree', system-ui, sans-serif;
  --font-m: 'JetBrains Mono', ui-monospace, monospace;
}}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-b);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}}
.container {{ max-width: 1280px; margin: 0 auto; padding: 40px 24px 60px; }}
header {{
  text-align: center;
  margin-bottom: 36px;
  padding: 48px 24px 36px;
  background: linear-gradient(135deg, #FAF8F5 0%, #F5F0EB 100%);
  border-radius: var(--radius);
  border: 1px solid var(--border);
}}
header h1 {{
  font-family: var(--font-h);
  font-size: 2.2rem;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.02em;
}}
header .sub {{ color: var(--text2); margin-top: 6px; font-size: 0.95rem; }}
header .timestamp {{ color: var(--dim); font-size: 0.85rem; margin-top: 4px; }}
.card {{
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 28px 32px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  transition: box-shadow 0.2s;
}}
.card:hover {{ box-shadow: 0 4px 12px rgba(0,0,0,0.06); }}
.card h2, .card h3 {{
  font-family: var(--font-h);
  font-weight: 600;
  margin-bottom: 16px;
}}
.card h4 {{
  font-family: var(--font-h);
  font-weight: 500;
  font-size: 0.95rem;
  color: var(--text2);
  margin: 20px 0 8px;
}}
.stats-row {{
  display: flex;
  gap: 16px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}}
.stat {{
  flex: 1;
  min-width: 100px;
  text-align: center;
  padding: 18px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg);
}}
.stat-value {{
  font-family: var(--font-m);
  font-size: 1.8rem;
  font-weight: 600;
  line-height: 1.2;
}}
.stat-label {{
  font-size: 0.8rem;
  color: var(--text2);
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}}
.stat.total .stat-value {{ color: var(--text); }}
.stat.pass .stat-value {{ color: var(--c-pass); }}
.stat.fail .stat-value {{ color: var(--c-fail); }}
.stat.skip .stat-value {{ color: var(--c-skip); }}
.stat.xfail .stat-value {{ color: var(--c-xfail); }}
.hero-rate {{
  font-family: var(--font-m);
  font-size: 3.5rem;
  font-weight: 700;
  text-align: center;
  margin: 8px 0 4px;
}}
.hero-rate.pass {{ color: var(--c-pass); }}
.hero-rate.warn {{ color: var(--c-skip); }}
.hero-rate.fail {{ color: var(--c-fail); }}
.hero-label {{
  text-align: center;
  color: var(--dim);
  font-size: 0.85rem;
  margin-bottom: 20px;
}}
table {{
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
  margin-top: 8px;
}}
th {{
  font-family: var(--font-h);
  font-weight: 600;
  text-align: left;
  padding: 10px 14px;
  border-bottom: 2px solid var(--border);
  color: var(--text2);
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}}
th.num, td.num {{ text-align: right; font-family: var(--font-m); font-size: 0.85rem; }}
td {{ padding: 8px 14px; border-bottom: 1px solid var(--border); }}
tbody tr:hover {{ background: var(--bg); }}
tfoot td {{
  font-weight: 600;
  font-family: var(--font-h);
  border-top: 2px solid var(--border);
  border-bottom: none;
  padding-top: 10px;
}}
.badge {{
  display: inline-block;
  padding: 2px 10px;
  border-radius: 99px;
  font-size: 0.72rem;
  font-weight: 600;
  font-family: var(--font-h);
  letter-spacing: 0.02em;
}}
.badge.pass {{ background: #ECFDF5; color: var(--c-pass); }}
.badge.fail {{ background: #FEF2F2; color: var(--c-fail); }}
.badge.skip {{ background: #FFFBEB; color: var(--c-skip); }}
.badge.xfail {{ background: #F5F3FF; color: var(--c-xfail); }}
.suite-dot {{
  display: inline-block;
  width: 10px; height: 10px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}}
.suite-card {{ border-left-width: 4px; border-left-style: solid; }}
.suite-header {{ display: flex; justify-content: space-between; align-items: baseline; }}
.pass-rate {{
  font-family: var(--font-m);
  font-size: 1.1rem;
  font-weight: 600;
}}
.pass-rate.pass {{ color: var(--c-pass); }}
.pass-rate.warn {{ color: var(--c-skip); }}
.pass-rate.fail {{ color: var(--c-fail); }}
.pass-bar {{
  height: 6px;
  border-radius: 3px;
  background: #E7E5E4;
  overflow: hidden;
  margin: 6px 0 12px;
}}
.pass-bar-fill {{
  height: 100%;
  border-radius: 3px;
  transition: width 0.6s ease;
}}
.suite-stats {{
  font-size: 0.85rem;
  color: var(--text2);
  margin-bottom: 16px;
}}
.suite-stats .dot {{ margin: 0 6px; color: var(--dim); }}
.c-pass {{ color: var(--c-pass); }}
.c-fail {{ color: var(--c-fail); }}
.c-skip {{ color: var(--c-skip); }}
.c-xfail {{ color: var(--c-xfail); }}
.no-detail {{ color: var(--dim); font-style: italic; font-size: 0.9rem; }}
.stories-showcase {{
  border: 1px solid rgba(5, 150, 105, 0.15);
  background: linear-gradient(135deg, #FFFFFF 0%, #F0FDF4 100%);
}}
.stories-header {{
  text-align: center;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}}
.stories-header h2 {{
  font-family: var(--font-h);
  font-weight: 700;
  font-size: 1.5rem;
  margin-bottom: 4px;
}}
.stories-tagline {{
  color: var(--dim);
  font-style: italic;
  font-size: 0.9rem;
}}
.stories-stats {{
  font-size: 0.9rem;
  color: var(--text2);
  margin-top: 4px;
}}
.stories-stats .dot {{ margin: 0 6px; color: var(--dim); }}
.story {{
  padding: 18px 0 14px;
  border-bottom: 1px solid var(--border);
}}
.story:last-child {{ border-bottom: none; }}
.story-header {{
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 6px;
}}
.story-num {{
  font-family: var(--font-m);
  font-size: 0.82rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
  min-width: 28px;
  text-align: center;
}}
.story-num.pass {{ color: var(--c-pass); background: #ECFDF5; }}
.story-num.fail {{ color: var(--c-fail); background: #FEF2F2; }}
.story-name {{
  font-family: var(--font-h);
  font-weight: 600;
  font-size: 1rem;
  flex: 1;
}}
.story-desc p {{
  color: var(--text2);
  font-size: 0.82rem;
  line-height: 1.55;
  margin: 1px 0;
  padding-left: 48px;
}}
footer {{
  text-align: center;
  margin-top: 32px;
  padding: 24px;
  color: var(--dim);
  font-size: 0.82rem;
}}
footer a {{ color: var(--text2); text-decoration: none; }}
footer a:hover {{ text-decoration: underline; }}
@media (max-width: 768px) {{
  .stats-row {{ gap: 8px; }}
  .stat {{ min-width: 70px; padding: 12px 8px; }}
  .stat-value {{ font-size: 1.3rem; }}
  .hero-rate {{ font-size: 2.5rem; }}
  .card {{ padding: 20px 16px; }}
  header h1 {{ font-size: 1.6rem; }}
  th, td {{ padding: 6px 8px; }}
}}
</style>
</head>
<body>
<div class="container">

<header>
  <h1>Dina &mdash; Test Results</h1>
  <div class="sub">The Architecture of Agency</div>
  <div class="timestamp">Generated {now} &middot; {fmt_duration(total_elapsed)} total runtime</div>
</header>

<div class="card">
  <div class="hero-rate {rate_class}">{rate:.1f}%</div>
  <div class="hero-label">Overall Pass Rate</div>
  <div class="stats-row">
    <div class="stat total">
      <div class="stat-value">{gt}</div>
      <div class="stat-label">Total</div>
    </div>
    <div class="stat pass">
      <div class="stat-value">{gp}</div>
      <div class="stat-label">Passed</div>
    </div>
    <div class="stat fail">
      <div class="stat-value">{gf}</div>
      <div class="stat-label">Failed</div>
    </div>
    <div class="stat skip">
      <div class="stat-value">{gs}</div>
      <div class="stat-label">Skipped</div>
    </div>
    {"" if not has_xfail else f'''<div class="stat xfail">
      <div class="stat-value">{gx}</div>
      <div class="stat-label">XFail</div>
    </div>'''}
  </div>
  {summary_table}
</div>

{suite_cards_html}

<footer>
  <p><strong>Dina</strong> &mdash; The Architecture of Agency</p>
  <p style="margin-top:4px">
    <a href="https://github.com/rajmohanutopai/dina">github.com/rajmohanutopai/dina</a>
  </p>
</footer>

</div>
</body>
</html>"""

    output_path.write_text(html)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    if len(sys.argv) < 3:
        print(
            f"Usage: {sys.argv[0]} <suite_output_dir> <total_elapsed_s>",
            file=sys.stderr,
        )
        sys.exit(1)

    suite_dir = Path(sys.argv[1])
    total_elapsed = int(sys.argv[2])

    # Read suite metadata files
    suites: list[dict] = []
    for meta_file in sorted(suite_dir.glob("suite_*.meta.json")):
        try:
            meta = json.loads(meta_file.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        num = meta["number"]
        name = meta["name"]

        log_file = suite_dir / f"suite_{num}.log"
        parsed = parse_suite_log(str(log_file), name, num)
        parsed["elapsed_s"] = meta.get("elapsed_s", 0)
        parsed["suite_passed"] = meta.get("passed", True)
        suites.append(parsed)

    if not suites:
        return

    use_color = sys.stdout.isatty()
    render_terminal_summary(suites, total_elapsed, use_color=use_color)

    html_path = Path.cwd() / "all_test_results.html"
    generate_html(suites, total_elapsed, html_path)

    g = _GREEN if use_color else ""
    d = _DIM if use_color else ""
    x = _RESET if use_color else ""
    print(f"  {g}HTML report:{x} {d}{html_path}{x}")
    print()


if __name__ == "__main__":
    main()
