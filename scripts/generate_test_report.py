#!/usr/bin/env python3
"""Generate Dina test report from JSON suite results.

Called by run_all_tests.sh after all suites complete. Reads per-phase JSON
files (produced by test_status.py --json-file), and generates a standalone
HTML report at all_test_results.html.

Usage:
    python3 scripts/generate_test_report.py <json_file> [<json_file>...] [--elapsed <seconds>]

Example:
    python3 scripts/generate_test_report.py /tmp/unit.json /tmp/nonunit.json --elapsed 120
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUITE_COLORS = {
    "core": "#2563EB",
    "brain": "#16A34A",
    "cli": "#9333EA",
    "admin_cli": "#D97706",
    "appview": "#0891B2",
    "integration": "#2563EB",
    "e2e": "#059669",
    "release": "#7C3AED",
    "user_stories": "#059669",
    "install": "#D97706",
    "appview_integration": "#0891B2",
    "install-pexpect": "#78716C",
}

NAME_MAP = {
    "core": "Core (Go)",
    "brain": "Brain (Py)",
    "cli": "CLI (Py)",
    "admin_cli": "Admin CLI (Py)",
    "appview": "AppView (TS)",
    "integration": "Integration",
    "e2e": "E2E (Docker)",
    "release": "Release",
    "user_stories": "User Stories",
    "install": "Install",
    "appview_integration": "AppView Integration (TS)",
    "install-pexpect": "Install Lifecycle (pexpect)",
}

# Story descriptions — the narrative heart of Dina.
# Each desc line is a tuple: (bold_lead, rest). Bold lead is the attention-grabbing
# opening phrase; rest is the supporting detail. Matches run_user_story_tests.sh banner.
USER_STORY_META = {
    1: {
        "name": "The Purchase Journey",
        "desc": [
            ('\u201cI need a chair\u201d', '\u2192 5 reviewers created (3 verified Ring 2, 2 unverified Ring 1)'),
            (None, 'Dina checks health vault (back pain, needs lumbar), finance vault (budget 10\u201320K INR)'),
            (None, 'Trust-weighted reviews: skip CheapChair (low trust score), recommends ErgoMax Elite'),
        ],
    },
    2: {
        "name": "The Sancho Moment",
        "desc": [
            ('Sancho arrives', '\u2192 Sancho\u2019s Dina contacts your Dina (D2D encrypted, Ed25519 signed)'),
            (None, 'Your Dina searches vault by Sancho\u2019s DID, finds: \u201chis mother had a fall\u201d, \u201clikes cardamom tea\u201d'),
            (None, 'Nudge: \u201cSancho 15 min away. Ask about his sick mother. Make cardamom tea.\u201d'),
        ],
    },
    3: {
        "name": "The Dead Internet Filter",
        "desc": [
            ('\u201cIs this video AI?\u201d', '\u2192 Dina resolves creator DID via AT Protocol Trust Network'),
            (None, 'Elena (Ring 3): 200 attestations, 15 peer vouches, 2yr history \u2192 \u201cauthentic, trusted creator\u201d'),
            (None, 'BotFarm (Ring 1): 0 attestations, 3\u2011day\u2011old account \u2192 \u201cunverified, check other sources\u201d'),
        ],
    },
    4: {
        "name": "The Persona Wall",
        "desc": [
            ('Shopping agent asks \u201cany health conditions?\u201d', '\u2192 Guardian blocks cross-persona access'),
            (None, 'Health (restricted): \u201cL4\u2011L5 herniation\u201d withheld. Proposes \u201cchronic back pain\u201d only'),
            (None, 'User approves minimal disclosure. PII scrubber confirms no diagnosis leaked'),
        ],
    },
    5: {
        "name": "The Agent Gateway",
        "desc": [
            ('OpenClaw/Perplexity Computer wants to send email', '\u2192 pairs with Home Node, asks Dina first'),
            (None, 'Dina checks: safe? matches your rules? PII leaking? \u201csend_email\u201d \u2192 MODERATE, asks you first'),
            (None, 'Safe tasks (web search) pass silently. Rogue agent with no auth \u2192 401, blocked at the gate'),
        ],
    },
    6: {
        "name": "The License Renewal",
        "desc": [
            ('User uploads license scan', '\u2192 Brain extracts fields with confidence scores'),
            (None, 'Deterministic reminder fires 30 days before expiry (no LLM in the scheduling)'),
            (None, 'Delegation: Brain generates strict JSON for DMV-Bot. Guardian flags for human review'),
        ],
    },
    7: {
        "name": "The Daily Briefing",
        "desc": [
            (None, 'Most noise waits quietly. Real harm interrupts immediately.'),
            (None, 'At the end of the day, Dina gives one calm summary and clears the queue.'),
        ],
    },
    8: {
        "name": "Move to a New Machine",
        "desc": [
            (None, 'Dina exports from the old machine and imports on the new one as an encrypted archive.'),
            (None, 'The wrong seed cannot unlock the vault. The same seed restores identity and data.'),
            (None, 'Migration is non\u2011destructive: the old machine still works after export.'),
        ],
    },
    9: {
        "name": "Connector Credential Expiry",
        "desc": [
            ('Gmail OAuth expires', '\u2014 connector status: expired. Vault and identity still work.'),
            (None, 'User reconfigures credentials, connector resumes. No cascade, no crash.'),
        ],
    },
    10: {
        "name": "The Operator Journey",
        "desc": [
            ('Re-run install script', '\u2014 DID unchanged (idempotent). No rotation, no orphaned data.'),
            (None, 'Identity is derived from master seed \u2014 immutable after bootstrap.'),
        ],
    },
    11: {
        "name": "The Anti-Her",
        "desc": [
            ('\u201cHaven\u2019t talked to Sarah in 45 days\u201d', '\u2192 proactive nudge in briefing, not on demand.'),
            (None, 'Life event follow-up: \u201cSancho\u2019s mother was ill\u201d \u2192 \u201cyou might want to check in.\u201d'),
            (None, 'Emotional dependency detected \u2192 Dina suggests specific humans, never herself.'),
        ],
    },
    12: {
        "name": "Verified Truth",
        "desc": [
            (None, 'When Dina has little evidence, she says so honestly.'),
            (None, 'When people disagree, she says the evidence is mixed instead of pretending certainty.'),
            (None, 'When the signal is strong, she speaks clearly and points back to the original sources.'),
        ],
    },
    13: {
        "name": "Silence Under Stress",
        "desc": [
            (None, 'Even in a flood of alerts, Dina interrupts only for what truly matters.'),
            (None, 'Fake urgency from strangers is suspicious; trusted urgent events can break through.'),
        ],
    },
    14: {
        "name": "Agent Sandbox",
        "desc": [
            (None, 'No auth, no access. Revoked means revoked immediately.'),
            (None, 'Sensitive actions stay blocked unless you approve them.'),
            (None, 'Agents cannot impersonate someone else.'),
        ],
    },
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def fmt_duration(seconds: int | float) -> str:
    """Format seconds as Xm Ys."""
    s = int(seconds)
    m, s = divmod(s, 60)
    if m > 0:
        return f"{m}m{s:02d}s"
    return f"{s}s"


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


# ---------------------------------------------------------------------------
# Load JSON data
# ---------------------------------------------------------------------------

def load_suites(json_files: list[str]) -> list[dict]:
    """Load suite data from JSON files (produced by test_status.py --json-file)."""
    suites = []
    for path in json_files:
        p = Path(path)
        if not p.exists() or p.stat().st_size == 0:
            continue
        try:
            data = json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        for key, suite in data.items():
            if key.startswith("_"):
                continue
            summary = suite.get("summary", {})
            sections = suite.get("sections", [])
            suites.append({
                "key": key,
                "name": NAME_MAP.get(key, key),
                "color": SUITE_COLORS.get(key, "#78716C"),
                "summary": summary,
                "sections": sections,
            })
    return suites


# ---------------------------------------------------------------------------
# HTML generation
# ---------------------------------------------------------------------------

def _section_rows_html(sections: list[dict], has_xfail: bool) -> str:
    """Build <tr> rows for a sections table."""
    rows = []
    for sec in sections:
        st = _status_class(sec)
        xf_td = f'<td class="num">{sec.get("xfail", 0)}</td>' if has_xfail else ""
        rows.append(
            f'<tr>'
            f'<td class="num">{sec.get("number", "")}</td>'
            f'<td>{sec.get("name", "")}</td>'
            f'<td class="num">{sec.get("total", 0)}</td>'
            f'<td class="num">{sec.get("passed", 0)}</td>'
            f'<td class="num">{sec.get("failed", 0)}</td>'
            f'<td class="num">{sec.get("skipped", 0)}</td>'
            f'{xf_td}'
            f'<td>{_badge("PASS" if sec.get("failed", 0) == 0 else "FAIL", st)}</td>'
            f'</tr>'
        )
    return "\n".join(rows)


def _desc_line_html(bold_lead: str | None, rest: str) -> str:
    """Render a single description line with optional bold lead phrase."""
    if bold_lead:
        return f'<p><strong>{bold_lead}</strong> {rest}</p>'
    return f'<p>{rest}</p>'


def _user_stories_card_html(sections: list[dict], summary: dict) -> str:
    """Build the user stories showcase card matching the terminal banner layout."""
    story_blocks = []
    for sec in sections:
        num = sec.get("number", 0)
        meta = USER_STORY_META.get(num, {})
        name = meta.get("name", sec.get("name", f"Story {num:02d}"))
        descriptions = meta.get("desc", [])

        passed = sec.get("passed", 0)
        total = sec.get("total", 0)
        is_pass = sec.get("failed", 0) == 0
        badge_cls = "pass" if is_pass else "fail"

        desc_html = "\n".join(
            _desc_line_html(d[0], d[1]) if isinstance(d, tuple) else f"<p>{d}</p>"
            for d in descriptions
        )

        story_blocks.append(
            f'<div class="story">'
            f'<div class="story-header">'
            f'<span class="story-num {badge_cls}">{num:02d}</span>'
            f'<span class="story-name">{name}</span>'
            f'<span class="badge {badge_cls}">{passed}/{total} passed</span>'
            f'</div>'
            f'<div class="story-desc">{desc_html}</div>'
            f'</div>'
        )

    stories_html = "\n".join(story_blocks)
    sm = summary
    stats = [f'{sm.get("total", 0)} tests']
    stats.append(f'<span class="c-pass">{sm.get("passed", 0)} passed</span>')
    if sm.get("failed", 0):
        stats.append(f'<span class="c-fail">{sm["failed"]} failed</span>')
    if sm.get("skipped", 0):
        stats.append(f'<span class="c-skip">{sm["skipped"]} skipped</span>')
    stats_html = ' <span class="dot">&middot;</span> '.join(stats)

    rate = _pass_rate(sm)
    rate_cls = "pass" if sm.get("failed", 0) == 0 else ("warn" if rate >= 90 else "fail")

    return (
        f'<div class="card stories-showcase">'
        f'<div class="stories-header">'
        f'<h2>DINA User Story Tests</h2>'
        f'<div class="stories-tagline">'
        f'Stack: 2x Go Core + 2x Python Brain + PDS + AppView + Postgres'
        f' &mdash; zero mocks, real crypto, real trust</div>'
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

    # Grand totals
    gt = sum(s["summary"].get("total", 0) for s in suites)
    gp = sum(s["summary"].get("passed", 0) for s in suites)
    gf = sum(s["summary"].get("failed", 0) for s in suites)
    gs = sum(s["summary"].get("skipped", 0) for s in suites)
    gx = sum(s["summary"].get("xfail", 0) for s in suites)
    has_xfail = gx > 0
    rate = gp / gt * 100 if gt else 100
    rate_class = "pass" if gf == 0 else ("warn" if rate >= 90 else "fail")

    # Build summary table rows
    suite_summary_rows = []
    for s in suites:
        sm = s["summary"]
        st = _status_class(sm)
        color = s["color"]
        xf_td = f'<td class="num">{sm.get("xfail", 0)}</td>' if has_xfail else ""
        suite_summary_rows.append(
            f'<tr>'
            f'<td><span class="suite-dot" style="background:{color}"></span> '
            f'{s["name"]}</td>'
            f'<td class="num">{sm.get("total", 0)}</td>'
            f'<td class="num">{sm.get("passed", 0)}</td>'
            f'<td class="num">{sm.get("failed", 0)}</td>'
            f'<td class="num">{sm.get("skipped", 0)}</td>'
            f'{xf_td}'
            f'<td>{_badge("PASS" if sm.get("failed", 0) == 0 else "FAIL", st)}</td>'
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
        if s["key"] == "user_stories":
            user_story_suite = s
        else:
            other_suites.append(s)

    # Build user stories showcase card (rendered first)
    user_stories_card = ""
    if user_story_suite and user_story_suite.get("sections"):
        user_stories_card = _user_stories_card_html(
            user_story_suite["sections"], user_story_suite["summary"]
        )

    # Build per-suite detail cards
    suite_cards = []
    for s in other_suites:
        color = s["color"]
        sm = s["summary"]
        sr = _pass_rate(sm)
        sr_cls = "pass" if sm.get("failed", 0) == 0 else ("warn" if sr >= 90 else "fail")

        sections = s.get("sections", [])
        if sections:
            sub_has_xfail = any(sec.get("xfail", 0) > 0 for sec in sections)
            xf_sec_th = '<th class="num">XFail</th>' if sub_has_xfail else ""
            section_html = _section_rows_html(sections, sub_has_xfail)

            total_sm = sm
            xf_foot = (
                f'<td class="num">{total_sm.get("xfail", 0)}</td>'
                if sub_has_xfail else ""
            )
            total_html = f"""
                <tfoot>
                  <tr>
                    <td></td><td>TOTAL</td>
                    <td class="num">{total_sm.get("total", 0)}</td>
                    <td class="num">{total_sm.get("passed", 0)}</td>
                    <td class="num">{total_sm.get("failed", 0)}</td>
                    <td class="num">{total_sm.get("skipped", 0)}</td>
                    {xf_foot}
                    <td></td>
                  </tr>
                </tfoot>"""

            sub_tables_html = f"""
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
            </table>"""
        else:
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
        <span>{sm.get("total", 0)} tests</span>
        <span class="dot">&middot;</span>
        <span class="c-pass">{sm.get("passed", 0)} passed</span>
        {f'<span class="dot">&middot;</span><span class="c-fail">{sm.get("failed", 0)} failed</span>' if sm.get("failed", 0) else ""}
        {f'<span class="dot">&middot;</span><span class="c-skip">{sm.get("skipped", 0)} skipped</span>' if sm.get("skipped", 0) else ""}
        {f'<span class="dot">&middot;</span><span class="c-xfail">{sm.get("xfail", 0)} xfail</span>' if sm.get("xfail", 0) else ""}
      </div>
      {sub_tables_html}
    </div>""")

    suite_cards_html = user_stories_card + "\n".join(suite_cards)

    html = _HTML_TEMPLATE.format(
        now=now,
        elapsed=fmt_duration(total_elapsed),
        rate=f"{rate:.1f}",
        rate_class=rate_class,
        gt=gt, gp=gp, gf=gf, gs=gs, gx=gx,
        has_xfail=has_xfail,
        xfail_stat_html=f'''<div class="stat xfail">
      <div class="stat-value">{gx}</div>
      <div class="stat-label">XFail</div>
    </div>''' if has_xfail else "",
        summary_table=summary_table,
        suite_cards_html=suite_cards_html,
    )

    output_path.write_text(html)


# ---------------------------------------------------------------------------
# HTML template (extracted to avoid deeply nested f-strings)
# ---------------------------------------------------------------------------

_HTML_TEMPLATE = """<!DOCTYPE html>
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
  <div class="timestamp">Generated {now} &middot; {elapsed} total runtime</div>
</header>

<div class="card">
  <div class="hero-rate {rate_class}">{rate}%</div>
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
    {xfail_stat_html}
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


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    json_files = []
    elapsed = 0

    i = 1
    while i < len(sys.argv):
        if sys.argv[i] == "--elapsed" and i + 1 < len(sys.argv):
            elapsed = int(sys.argv[i + 1])
            i += 2
        else:
            json_files.append(sys.argv[i])
            i += 1

    if not json_files:
        print(
            f"Usage: {sys.argv[0]} <json_file> [<json_file>...] [--elapsed <seconds>]",
            file=sys.stderr,
        )
        sys.exit(1)

    suites = load_suites(json_files)
    if not suites:
        print("No test results found.", file=sys.stderr)
        return

    html_path = Path.cwd() / "all_test_results.html"
    generate_html(suites, elapsed, html_path)

    print(f"  HTML report: {html_path}")


if __name__ == "__main__":
    main()
