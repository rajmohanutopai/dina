/**
 * Task 5.35 — contact matcher.
 *
 * Detects mentions of known contacts in free text. Given a user's
 * contact list (names + aliases), builds word-boundary regex
 * patterns once at construction + runs them against each piece of
 * captured text.
 *
 * **Why longest-match-first**:
 *   - If the contact list has both `"Emma"` and `"Emma Watson"`, a
 *     naive scan for `"Emma"` first would claim the span before
 *     `"Emma Watson"` got a chance. Longest-first sorting prevents
 *     the shorter alias from pre-empting the more-specific one.
 *   - Aliases like `"my daughter"` (multi-word) also need priority
 *     over single-word names that happen to appear as substrings
 *     of longer phrases.
 *
 * **Span-claim dedup**: once a pattern claims a text span, shorter
 * patterns skip it. Two different contacts with overlapping names
 * (rare but possible) are resolved by longest-match-wins — matches
 * the Python reference.
 *
 * **Case-insensitive matching** because users rarely capitalise
 * contact names consistently in captured notes. The stored
 * `MatchedContact.name` is the canonical contact name (not the text
 * surface) so downstream code gets a stable id.
 *
 * **Minimum name length 2** prevents false-positive scanning for
 * initials like `"I"` or `"A"`.
 *
 * **Pluggable contact source**: the matcher takes an array at
 * construction. Brain rebuilds the matcher on contact-directory
 * change events — no live-update surface here.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.35.
 */

export interface ContactEntry {
  /** Display name (required). Shown in UI and used as canonical id. */
  name: string;
  did: string;
  /** Free-form relationship label (spouse, child, friend, …). */
  relationship?: string;
  /** Who "owns" the data about this contact (household/care/financial/external). */
  dataResponsibility?: string;
  /** Alternate names the user calls this contact (e.g. "mom", "Dr J"). */
  aliases?: string[];
}

export interface MatchedContact {
  /** Canonical display name (not the text surface form). */
  name: string;
  did: string;
  relationship: string;
  dataResponsibility: string;
  /** [start, end) character offsets in the scanned text. */
  span: [number, number];
  /** The literal text that matched (preserved for audit / UI highlight). */
  matchedText: string;
}

const MIN_PATTERN_LENGTH = 2;

interface CompiledPattern {
  pattern: RegExp;
  info: {
    name: string;
    did: string;
    relationship: string;
    dataResponsibility: string;
  };
  /** Length of the raw name — used for longest-first sort. */
  length: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class ContactMatcher {
  private readonly patterns: readonly CompiledPattern[];

  constructor(contacts: ReadonlyArray<ContactEntry>) {
    this.patterns = compilePatterns(contacts);
  }

  /**
   * Find every contact mention in `text`. Returns matches ordered by
   * their position in the text. Overlapping matches are resolved
   * longest-first (shorter patterns skip spans already claimed).
   */
  findMentions(text: string): MatchedContact[] {
    if (typeof text !== 'string' || text.length === 0) return [];
    if (this.patterns.length === 0) return [];

    const results: MatchedContact[] = [];
    const claimed: Array<[number, number]> = [];

    for (const { pattern, info } of this.patterns) {
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) {
        const start = m.index ?? 0;
        const end = start + m[0]!.length;
        if (overlapsClaimed(start, end, claimed)) continue;
        results.push({
          name: info.name,
          did: info.did,
          relationship: info.relationship,
          dataResponsibility: info.dataResponsibility,
          span: [start, end],
          matchedText: m[0]!,
        });
        claimed.push([start, end]);
      }
    }

    results.sort((a, b) => a.span[0] - b.span[0]);
    return results;
  }

  /** Count of compiled patterns — useful for admin UI + tests. */
  patternCount(): number {
    return this.patterns.length;
  }

  /**
   * Return every compiled pattern's source for debugging. Does NOT
   * expose the regex objects themselves to prevent mutation.
   */
  debugPatterns(): Array<{ source: string; did: string; name: string }> {
    return this.patterns.map((p) => ({
      source: p.pattern.source,
      did: p.info.did,
      name: p.info.name,
    }));
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function compilePatterns(
  contacts: ReadonlyArray<ContactEntry>,
): readonly CompiledPattern[] {
  type Entry = {
    text: string;
    info: CompiledPattern['info'];
  };
  const entries: Entry[] = [];

  for (const c of contacts) {
    const canonicalName = typeof c.name === 'string' ? c.name.trim() : '';
    const info: CompiledPattern['info'] = {
      name: canonicalName,
      did: typeof c.did === 'string' ? c.did : '',
      relationship: typeof c.relationship === 'string' ? c.relationship : 'unknown',
      dataResponsibility:
        typeof c.dataResponsibility === 'string'
          ? c.dataResponsibility
          : 'external',
    };
    if (canonicalName.length >= MIN_PATTERN_LENGTH) {
      entries.push({ text: canonicalName, info });
    }
    if (Array.isArray(c.aliases)) {
      for (const alias of c.aliases) {
        if (typeof alias !== 'string') continue;
        const t = alias.trim();
        if (t.length < MIN_PATTERN_LENGTH) continue;
        entries.push({
          text: t,
          // Aliases inherit the canonical name so downstream code
          // always reports a stable id, even when the surface form
          // differs.
          info: { ...info, name: canonicalName || t },
        });
      }
    }
  }

  // Longest-first so "Emma Watson" matches before "Emma".
  entries.sort((a, b) => b.text.length - a.text.length);

  // Dedup: same DID + same lowered pattern text → one regex.
  const seen = new Set<string>();
  const out: CompiledPattern[] = [];
  for (const e of entries) {
    const key = `${e.info.did}::${e.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      pattern: new RegExp(`\\b${escapeRegex(e.text)}\\b`, 'gi'),
      info: e.info,
      length: e.text.length,
    });
  }
  return out;
}

function overlapsClaimed(
  start: number,
  end: number,
  claimed: ReadonlyArray<[number, number]>,
): boolean {
  // Because patterns run longest-first, a later (shorter) match can
  // only overlap an earlier claim by having its start or end inside
  // the claim range. A shorter match cannot strictly contain a
  // longer claim, so no full-containment check is needed.
  for (const [cs, ce] of claimed) {
    if ((cs <= start && start < ce) || (cs < end && end <= ce)) return true;
  }
  return false;
}
