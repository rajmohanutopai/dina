#!/usr/bin/env python3
"""Add TST-INT-NNN comments to integration test functions.

Uses the manifest from tag_integration_plan.py to match test functions to
scenario IDs. Unlike Core/Brain tests (which embed section numbers in
function names), integration tests use descriptive names. Matching is done
by:
  1. File-to-section mapping (handcrafted from file topics -> plan sections)
  2. Keyword similarity between function name + docstring and scenario text
  3. Greedy best-match assignment (each scenario matched at most once)

Reports unmatched scenarios and functions for manual review.
Idempotent — skips functions already tagged.
"""

import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

MANIFEST_PATH = PROJECT_ROOT / "tests" / "integration_manifest.json"
TEST_DIR = PROJECT_ROOT / "tests" / "integration"
PREFIX = "TST-INT"

# -----------------------------------------------------------------------
# File -> plan section mapping
# -----------------------------------------------------------------------
# Each test file maps to one or more plan section paths. The plan has
# sections 1-16 with subsections. We map files to the section(s) they
# test based on topic analysis.
#
# Integration plan sections:
#   1. Core <-> Brain Communication (1.1, 1.2, 1.3)
#   2. End-to-End User Flows (2.1-2.6)
#   3. Dina-to-Dina Communication (3.1-3.6)
#   4. LLM Integration (4.1-4.3)
#   5. Docker Networking & Isolation (5.1-5.7)
#   6. Crash Recovery & Resilience (6.1-6.4)
#   7. Security Boundary Tests (7.1-7.9)
#   8. Digital Estate (SSS Custodian Recovery) (8)
#   9. Ingestion-to-Vault Pipeline (9.1-9.4)
#  10. Data Flow Patterns (10.1-10.5)
#  11. Trust Network Integration (11.1-11.5)
#  12. Upgrade & Migration (12)
#  13. Performance & Load Tests (13.1-13.3)
#  14. Chaos Engineering (14)
#  15. Compliance & Privacy (15)
#  16. Deferred (16.1-16.12)

FILE_TO_SECTIONS = {
    "test_home_node.py": ["1", "4", "5.1"],
    "test_didcomm.py": ["3.1", "3.2", "3.3", "3.4", "3.6"],
    "test_dina_to_dina.py": ["3.5", "10.4"],
    "test_client_sync.py": ["2.3", "16.1"],
    "test_personas.py": ["2.4", "7.2"],
    "test_storage_tiers.py": ["5.5", "7.5", "7.6", "7.8", "7.9"],
    "test_pii_scrubber.py": ["4.3", "7.1"],
    "test_safety_layer.py": ["2.6", "7.3"],
    "test_silence_tiers.py": ["10.1"],
    "test_memory_flows.py": ["10.2", "10.3"],
    "test_whisper.py": ["2.1"],
    "test_ingestion.py": ["9.1", "9.2", "9.3", "9.4"],
    "test_delegation.py": ["9.1", "10.5"],
    "test_draft_dont_send.py": ["10.5"],
    "test_cart_handover.py": ["10.5"],
    "test_deep_links.py": ["10.5"],
    "test_trust_network.py": ["11.1", "11.2", "11.3"],
    "test_trust_rings.py": ["7.4", "11.3"],
    "test_digital_estate.py": ["8"],
    "test_anti_her.py": ["10.1"],
    "test_agency.py": ["10.1"],
    "test_open_economy.py": ["10.4", "11.3"],
}

# Synonyms / aliases: each key maps to a set of equivalent terms.
# When either side uses one of these words, matches against all synonyms.
SYNONYMS = {
    "encrypt": {"encrypt", "encrypted", "encryption", "cipher", "sqlcipher", "crypt"},
    "decrypt": {"decrypt", "decrypted", "decryption"},
    "persona": {"persona", "personas", "compartment", "compartments"},
    "vault": {"vault", "storage", "store", "stored"},
    "crash": {"crash", "crashed", "kill", "oom", "dies"},
    "lock": {"lock", "locked", "locking"},
    "unlock": {"unlock", "unlocked", "unlocking"},
    "pii": {"pii", "scrub", "scrubbed", "scrubbing", "scrubber", "redact", "redacted"},
    "key": {"key", "keys", "keypair", "dek", "kek"},
    "sign": {"sign", "signed", "signature", "signing"},
    "verify": {"verify", "verified", "verification", "validates"},
    "pair": {"pair", "paired", "pairing"},
    "device": {"device", "devices", "client", "phone", "laptop"},
    "token": {"token", "tokens", "credential", "credentials"},
    "auth": {"auth", "authenticated", "authentication", "unauthenticated"},
    "send": {"send", "sent", "sending", "outbound", "egress"},
    "receive": {"receive", "received", "receiving", "inbound", "ingress"},
    "message": {"message", "messages", "msg"},
    "notify": {"notify", "notification", "notifications", "nudge", "whisper"},
    "did": {"did", "dids", "identity", "plc"},
    "sss": {"sss", "shamir", "custodian", "custodians", "shares", "share"},
    "estate": {"estate", "beneficiary", "beneficiaries"},
    "draft": {"draft", "drafts", "staging"},
    "payment": {"payment", "payments", "cart", "checkout", "purchase"},
    "bot": {"bot", "bots", "agent", "agents"},
    "reputation": {"reputation", "attestation", "attestations", "trust"},
    "sync": {"sync", "synced", "synchronization", "push"},
    "offline": {"offline", "disconnected", "down", "unavailable"},
    "recovery": {"recovery", "recover", "recovered", "restore", "restored"},
    "delete": {"delete", "deleted", "deletion", "destroy", "destroyed", "wipe", "erase"},
    "block": {"block", "blocked", "reject", "rejected", "deny", "denied"},
    "expire": {"expire", "expired", "expiry", "expiration", "ttl"},
    "cache": {"cache", "cached", "caching"},
    "relay": {"relay", "relayed", "forward", "forwarded"},
    "mutual": {"mutual", "bidirectional", "both"},
    "plain": {"plain", "plaintext", "unencrypted", "cleartext"},
    "admin": {"admin", "dashboard", "ui"},
    "qr": {"qr", "code", "pairing"},
    "rotate": {"rotate", "rotated", "rotation", "refresh", "refreshed"},
    "tombstone": {"tombstone", "deletion", "retraction"},
    "dedup": {"dedup", "deduplication", "deduplicate", "duplicate", "duplicates"},
    "batch": {"batch", "batches", "bulk"},
    "fts": {"fts", "fts5", "fulltext", "full"},
    "embed": {"embed", "embedding", "embeddings", "vector", "semantic"},
    "llm": {"llm", "model", "inference", "local", "cloud", "gemini", "llama"},
    "connector": {"connector", "connectors", "gmail", "telegram", "calendar"},
    "threshold": {"threshold", "met", "required", "minimum"},
    "scope": {"scope", "scoped", "scoping", "permission", "permissions", "readonly"},
    "isolation": {"isolation", "isolated", "separate", "separated", "compartment"},
}


def load_manifest(path):
    """Load manifest and build lookup structures."""
    data = json.loads(path.read_text())

    scenarios = data["scenarios"]  # tag -> {scenario, path, row, section, line}

    # Group scenarios by path
    by_path = {}
    for tag, info in scenarios.items():
        by_path.setdefault(info["path"], []).append((tag, info))
    for p in by_path:
        by_path[p].sort(key=lambda x: int(x[1]["row"]))

    return scenarios, by_path


def expand_synonyms(tokens):
    """Expand a token set with synonym matches."""
    expanded = set(tokens)
    for token in tokens:
        for group_key, group in SYNONYMS.items():
            if token in group:
                expanded.update(group)
    return expanded


def tokenize(text):
    """Extract lowercase alphanumeric tokens, including split compound words."""
    raw_tokens = set(re.findall(r"[a-z0-9]+", text.lower()))

    # Also split long tokens at common boundaries
    extra = set()
    for token in raw_tokens:
        # Split camelCase if present (unlikely in lowercase but just in case)
        parts = re.findall(r"[a-z]+|[0-9]+", token)
        if len(parts) > 1:
            extra.update(parts)

    return raw_tokens | extra


def keyword_score(func_tokens, scenario_tokens):
    """Compute word-overlap score with synonym expansion.

    The file-to-section mapping already constrains candidates to relevant
    sections, so we use a relatively generous scoring approach.
    """
    stopwords = {
        "the", "is", "a", "an", "for", "to", "in", "of", "and", "or",
        "with", "that", "this", "on", "at", "from", "by", "not", "no",
        "all", "be", "are", "was", "were", "has", "have", "had", "do",
        "does", "did", "will", "should", "can", "could", "would", "may",
        "test", "def", "self", "none", "true", "false", "mock", "assert",
        "setup", "expected", "input", "output", "returns", "only",
        "after", "before", "when", "if", "but", "just", "also", "same",
    }
    func_clean = func_tokens - stopwords
    scenario_clean = scenario_tokens - stopwords

    if not func_clean or not scenario_clean:
        return 0.0

    # Expand with synonyms
    func_expanded = expand_synonyms(func_clean)
    scenario_expanded = expand_synonyms(scenario_clean)

    # Direct overlap
    direct_overlap = func_clean & scenario_clean

    # Synonym-expanded overlap (tokens that match via synonym groups)
    expanded_overlap = func_expanded & scenario_expanded
    # But only count the original tokens that contributed
    synonym_matches = set()
    for ft in func_clean:
        ft_syns = expand_synonyms({ft})
        for st in scenario_clean:
            st_syns = expand_synonyms({st})
            if ft_syns & st_syns:
                synonym_matches.add(ft)
                break

    # Substring matching: if a function token is a substring of a scenario
    # token (or vice versa) and both are >3 chars, count partial match
    partial = 0.0
    for ft in func_clean:
        if len(ft) <= 3:
            continue
        for st in scenario_clean:
            if len(st) <= 3:
                continue
            if ft in st or st in ft:
                partial += 0.5
                break

    # Score: direct overlap weighted 1.5, synonym matches weighted 1.0,
    # partial matches weighted 0.5
    score = (
        len(direct_overlap) * 1.5
        + (len(synonym_matches) - len(direct_overlap)) * 1.0
        + partial
    )

    # Normalize slightly by the smaller set size to favor specific matches
    if max(len(func_clean), len(scenario_clean)) > 0:
        coverage = len(synonym_matches) / min(
            len(func_clean), len(scenario_clean)
        )
        score += coverage * 0.5

    return score


def extract_func_info(filepath):
    """Extract test function names and docstrings from a Python test file.

    Returns list of dicts and the raw lines.
    """
    text = filepath.read_text()
    lines = text.split("\n")

    func_re = re.compile(r"^(\s*)def (test_\w+)\(")
    class_re = re.compile(r"^class (Test\w+)")
    decorator_re = re.compile(r"^\s*@")
    tag_re = re.compile(r"^# " + re.escape(PREFIX))

    functions = []
    current_class = None

    i = 0
    while i < len(lines):
        line = lines[i]

        cm = class_re.match(line)
        if cm:
            current_class = cm.group(1)
            i += 1
            continue

        fm = func_re.match(line)
        if fm:
            func_name = fm.group(2)

            # Find insertion point (before decorators)
            insert_idx = i
            while insert_idx > 0 and decorator_re.match(lines[insert_idx - 1]):
                insert_idx -= 1

            # Check if already tagged
            already_tagged = insert_idx > 0 and tag_re.match(lines[insert_idx - 1])

            # Extract docstring — look at lines after the def line
            # The def may span multiple lines (for long parameter lists)
            docstring = ""
            j = i + 1
            # Skip continuation lines of the def (end at line containing ):)
            while j < len(lines):
                stripped = lines[j].strip()
                if not stripped or stripped.startswith('"""') or stripped.startswith("'"):
                    break
                if "):" in lines[j] or ") ->" in lines[j]:
                    j += 1
                    break
                j += 1

            # Now j should be at the docstring line (or blank line before it)
            while j < len(lines) and not lines[j].strip():
                j += 1

            if j < len(lines):
                docline = lines[j].strip()
                if docline.startswith('"""'):
                    # Single-line docstring: """text"""
                    single = re.match(r'"""(.*)"""', docline)
                    if single:
                        docstring = single.group(1)
                    else:
                        # Multi-line docstring
                        docstring = docline[3:]  # text after opening """
                        j += 1
                        while j < len(lines):
                            dl = lines[j].strip()
                            if '"""' in dl:
                                end_match = re.match(r'(.*?)"""', dl)
                                if end_match:
                                    docstring += " " + end_match.group(1)
                                break
                            docstring += " " + dl
                            j += 1

            functions.append({
                "name": func_name,
                "insert_idx": insert_idx,
                "line": i,
                "docstring": docstring.strip(),
                "class_name": current_class,
                "already_tagged": already_tagged,
            })
            i += 1
            continue

        # Track class scope exit
        if line.strip() and not line.startswith(" ") and not line.startswith("\t"):
            if not class_re.match(line) and not line.startswith("#") and not line.startswith("@"):
                current_class = None

        i += 1

    return functions, lines


def match_functions_to_scenarios(functions, candidate_scenarios):
    """Match test functions to plan scenarios using keyword similarity.

    Uses a stable-marriage style greedy algorithm: compute all scores,
    sort by score descending, assign each pair at most once.

    Returns:
      matched: dict of func_name -> [tags]
      unmatched_funcs: list of func_names
      matched_tags: set of matched tag IDs
    """
    if not candidate_scenarios:
        return {}, [f["name"] for f in functions], set()

    # Build scenario tokens (with class name context from plan section)
    scenario_token_map = {}
    for tag, info in candidate_scenarios:
        text = info["scenario"]
        scenario_token_map[tag] = tokenize(text)

    # Build function token sets
    func_token_map = {}
    for func in functions:
        name_text = func["name"].replace("test_", "").replace("_", " ")
        # Include class name for context
        class_text = ""
        if func.get("class_name"):
            class_text = func["class_name"].replace("Test", "").replace("_", " ")
            # Also split CamelCase
            class_text = re.sub(r"([a-z])([A-Z])", r"\1 \2", class_text)
        combined = f"{name_text} {class_text} {func.get('docstring', '')}"
        func_token_map[func["name"]] = tokenize(combined)

    # Score all pairs
    all_scores = []
    for func in functions:
        ftokens = func_token_map[func["name"]]
        for tag, info in candidate_scenarios:
            stokens = scenario_token_map[tag]
            score = keyword_score(ftokens, stokens)
            if score > 0:
                all_scores.append((score, func["name"], tag))

    # Sort by score descending (greedy best-first)
    all_scores.sort(reverse=True)

    matched = {}
    used_tags = set()
    used_funcs = set()

    for score, func_name, tag in all_scores:
        if func_name in used_funcs or tag in used_tags:
            continue
        # Minimum threshold: since we already constrain by section,
        # even a small overlap is meaningful
        if score >= 1.5:
            matched[func_name] = [tag]
            used_tags.add(tag)
            used_funcs.add(func_name)

    # Collect unmatched functions
    unmatched_funcs = [f["name"] for f in functions if f["name"] not in matched]

    return matched, unmatched_funcs, used_tags


def format_id_comment(ids):
    """Format IDs into comment lines, wrapping at ~100 chars."""
    if not ids:
        return []

    lines = []
    current = "#"
    for i, tag_id in enumerate(ids):
        sep = ", " if i > 0 else " "
        candidate = current + sep + tag_id
        if len(candidate) > 100 and i > 0:
            lines.append(current)
            current = "# " + tag_id
        else:
            current = candidate
    if current != "#":
        lines.append(current)
    return lines


def process_file(filepath, scenarios_by_path, all_scenarios):
    """Process a single integration test file.

    Returns (matched_ids, unmatched_funcs).
    """
    fname = filepath.name
    section_paths = FILE_TO_SECTIONS.get(fname, [])

    # Gather candidate scenarios from mapped sections
    candidates = []
    for path in section_paths:
        # Include exact path and all sub-paths
        for p, items in scenarios_by_path.items():
            if p == path or p.startswith(path + "."):
                candidates.extend(items)

    # Extract functions
    functions, lines = extract_func_info(filepath)
    if not functions:
        return set(), []

    # Match functions to scenarios
    matched, unmatched_funcs, used_tags = match_functions_to_scenarios(
        functions, candidates
    )

    # Build function -> tag mapping for insertion
    func_tag_map = {}
    for func in functions:
        if func["name"] in matched:
            func_tag_map[func["name"]] = matched[func["name"]]

    # Apply tags to file
    tag_re = re.compile(r"^# " + re.escape(PREFIX))
    insertions = {}  # insert_idx -> comment_lines

    for func in functions:
        if func["already_tagged"]:
            continue

        tags = func_tag_map.get(func["name"])
        if tags:
            comment_lines = format_id_comment(tags)
            insertions[func["insert_idx"]] = comment_lines

    # Apply insertions in reverse order
    for idx in sorted(insertions.keys(), reverse=True):
        for comment_line in reversed(insertions[idx]):
            lines.insert(idx, comment_line)

    filepath.write_text("\n".join(lines))

    return used_tags, unmatched_funcs


def assign_novel_ids(filepath, next_id):
    """Assign TST-INT-NNN IDs to unmatched functions (novel tests).

    These are test functions that don't correspond to any plan scenario --
    they test behaviors discovered during implementation.

    Returns (count_assigned, next_id_after).
    """
    text = filepath.read_text()
    lines = text.split("\n")

    func_re = re.compile(r"^(\s*)def (test_\w+)\(")
    decorator_re = re.compile(r"^\s*@")
    tag_re = re.compile(r"^# " + re.escape(PREFIX))

    insertions = {}
    count = 0

    for i, line in enumerate(lines):
        fm = func_re.match(line)
        if not fm:
            continue

        # Find insertion point (before decorators)
        insert_idx = i
        while insert_idx > 0 and decorator_re.match(lines[insert_idx - 1]):
            insert_idx -= 1

        # Already tagged?
        if insert_idx > 0 and tag_re.match(lines[insert_idx - 1]):
            continue

        # Untagged function -- assign novel ID
        tag = f"{PREFIX}-{next_id:03d}"
        insertions[insert_idx] = [f"# {tag}"]
        next_id += 1
        count += 1

    # Apply insertions in reverse order
    for idx in sorted(insertions.keys(), reverse=True):
        for comment_line in reversed(insertions[idx]):
            lines.insert(idx, comment_line)

    filepath.write_text("\n".join(lines))
    return count, next_id


def main():
    if not MANIFEST_PATH.exists():
        print(f"ERROR: Manifest not found: {MANIFEST_PATH}")
        print("  Run scripts/tag_integration_plan.py first.")
        sys.exit(1)

    all_scenarios, by_path = load_manifest(MANIFEST_PATH)

    print(f"{'='*60}")
    print(f"{PREFIX} (Python) -- {TEST_DIR.relative_to(PROJECT_ROOT)}")
    print(f"{'='*60}")
    print(f"  Manifest: {len(all_scenarios)} plan scenarios")
    print()

    all_matched = set()
    all_unmatched_funcs = []
    total_funcs = 0

    # Phase 1: Match functions to plan scenarios
    for filepath in sorted(TEST_DIR.glob("test_*.py")):
        matched, unmatched = process_file(filepath, by_path, all_scenarios)
        all_matched.update(matched)

        funcs_in_file = len(matched) + len(unmatched)
        total_funcs += funcs_in_file

        fname = filepath.name
        if unmatched:
            print(f"  {fname}: {len(matched)} matched, {len(unmatched)} unmatched")
        else:
            print(f"  {fname}: {len(matched)} matched")

        all_unmatched_funcs.extend(
            (filepath.name, func) for func in unmatched
        )

    # Phase 2: Assign novel IDs to unmatched functions
    # Next ID starts after the last plan scenario ID
    plan_total = len(all_scenarios)
    next_id = plan_total + 1
    novel_total = 0

    print(f"\n  Phase 2: Assigning novel IDs (starting at {PREFIX}-{next_id:03d})...")

    for filepath in sorted(TEST_DIR.glob("test_*.py")):
        count, next_id = assign_novel_ids(filepath, next_id)
        if count > 0:
            print(f"    {filepath.name}: {count} novel IDs assigned")
            novel_total += count

    # Summary
    missing = set(all_scenarios.keys()) - all_matched
    print(f"\n  {'='*50}")
    print(f"  SUMMARY")
    print(f"  {'='*50}")
    print(f"  Total test functions:    {total_funcs}")
    print(f"  Matched to plan:         {len(all_matched)}")
    print(f"  Novel (code-only):       {novel_total}")
    print(f"  Plan coverage:           {len(all_matched)}/{len(all_scenarios)} scenarios")
    print(f"  Unmatched plan rows:     {len(missing)}")

    if missing:
        print(f"\n  Unmatched plan scenarios ({len(missing)}):")
        for mid in sorted(missing, key=lambda x: int(x.split("-")[-1])):
            info = all_scenarios[mid]
            print(f"    {mid}: {info['scenario'][:60]}... (section {info['path']})")

    if all_unmatched_funcs:
        print(f"\n  Novel functions ({len(all_unmatched_funcs)}) -- assigned novel IDs:")
        for fname, func in all_unmatched_funcs[:20]:
            print(f"    {fname}: {func}")
        if len(all_unmatched_funcs) > 20:
            print(f"    ... and {len(all_unmatched_funcs) - 20} more")

    print(f"\n{'='*60}")
    print("Done.")


if __name__ == "__main__":
    main()
