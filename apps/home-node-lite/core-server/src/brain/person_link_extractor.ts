/**
 * Person-link extractor (GAP.md row #11 closure — M2 blocker).
 *
 * Extracts `{personA, personB, relation}` triples from free-text so
 * `person_resolver` can build + update its relationship graph. The
 * relationship graph drives:
 *
 *   - Nudge assembly — "your manager Alice needs X" routes through
 *     the manager/direct-report relation.
 *   - Contact-preferred routing — `preferred_for` on contacts depends
 *     on knowing *who* a contact is to the user.
 *   - Audit / export — the graph is surfaced in the relationship
 *     export for migrating to a new machine.
 *
 * **Extraction strategy** (pure, no LLM):
 *
 *   1. Find capitalised proper-noun name candidates. Runs of 1-3
 *      title-cased tokens; all-caps acronyms participate. Short
 *      common sentence-start words ("The", "Today") are filtered by
 *      the built-in stop list.
 *   2. For each relation vocab entry, look for `A <connector> B`
 *      patterns around ±100 chars. Connectors are categorised:
 *      `family`, `work`, `friend`, `romantic`, `associate`. Each
 *      connector entry carries its canonical relation label.
 *   3. Emit a triple with `{a, b, relation, confidence, span}`.
 *
 * **Bidirectional vs directional relations**: `managed_by` is
 * directional; `partner_of` is symmetric. Each connector knows its
 * own symmetry flag; callers decide whether to emit both directions.
 *
 * **False-positive posture**: moderate. Name-pair proximity without
 * a known connector is NOT emitted. Callers who want looser matching
 * can supply extra connectors via `extraConnectors`.
 *
 * **Not a parser, a heuristic**. Reliable on canonical phrasings
 * ("Alice is Bob's manager", "Carol and Dave are married"). Ambiguous
 * sentences yield no output — missing a relation is preferred to
 * inventing one.
 *
 * Source: GAP.md (task 5.46 follow-up) — M2 relationship-graph gate.
 */

export type RelationKind =
  | 'family'
  | 'work'
  | 'friend'
  | 'romantic'
  | 'associate';

export interface RelationConnector {
  /** Canonical relation label, e.g. `manager_of`, `spouse_of`. */
  relation: string;
  /** Category. */
  kind: RelationKind;
  /** Regex matching the connector text between A and B. Should be case-insensitive. */
  pattern: RegExp;
  /**
   * True when the relation is symmetric (reversing A + B preserves
   * meaning). False when directional. Default false.
   */
  symmetric?: boolean;
  /** Confidence weight [0, 1]. Default 0.8. */
  confidence?: number;
}

export interface PersonLink {
  a: { name: string; span: { start: number; end: number } };
  b: { name: string; span: { start: number; end: number } };
  relation: string;
  kind: RelationKind;
  symmetric: boolean;
  confidence: number;
  /** Span of the connector that tied them together. */
  connectorSpan: { start: number; end: number };
  connectorText: string;
}

export interface ExtractPersonLinksOptions {
  /** Additional connectors merged with the built-in set. */
  extraConnectors?: ReadonlyArray<RelationConnector>;
  /** Maximum char distance between A's end and B's start. Default 100. */
  maxGap?: number;
  /** Minimum confidence to emit. Default 0. */
  minConfidence?: number;
}

export const DEFAULT_MAX_GAP = 100;

/**
 * Built-in connector vocabulary. Each pattern matches the text
 * BETWEEN person A and person B. Bias toward canonical phrasings —
 * tests pin each one.
 */
export const BUILT_IN_CONNECTORS: ReadonlyArray<RelationConnector> = [
  // Family
  { relation: 'spouse_of', kind: 'family', symmetric: true, confidence: 0.95,
    pattern: /\s+is\s+married\s+to\s+/i },
  { relation: 'parent_of', kind: 'family', symmetric: false, confidence: 0.9,
    pattern: /\s+is\s+(?:the\s+)?(?:father|mother|parent)\s+of\s+/i },
  { relation: 'child_of', kind: 'family', symmetric: false, confidence: 0.9,
    pattern: /\s+is\s+(?:the\s+)?(?:son|daughter|child)\s+of\s+/i },
  { relation: 'sibling_of', kind: 'family', symmetric: true, confidence: 0.9,
    pattern: /\s+(?:and|is\s+(?:the\s+)?(?:brother|sister|sibling)\s+of)\s+/i },
  // Work
  { relation: 'manager_of', kind: 'work', symmetric: false, confidence: 0.9,
    pattern: /\s+is\s+(?:the\s+)?(?:manager|boss|supervisor)\s+of\s+/i },
  { relation: 'reports_to', kind: 'work', symmetric: false, confidence: 0.9,
    pattern: /\s+reports\s+to\s+/i },
  { relation: 'colleague_of', kind: 'work', symmetric: true, confidence: 0.85,
    pattern: /\s+(?:is\s+)?(?:a\s+)?colleague(?:s)?\s+(?:of|with)\s+/i },
  { relation: 'colleague_of', kind: 'work', symmetric: true, confidence: 0.7,
    pattern: /\s+works?\s+(?:with|alongside)\s+/i },
  // Romantic
  { relation: 'partner_of', kind: 'romantic', symmetric: true, confidence: 0.85,
    pattern: /\s+is\s+(?:dating|engaged\s+to|in\s+a\s+relationship\s+with)\s+/i },
  // Friend
  { relation: 'friend_of', kind: 'friend', symmetric: true, confidence: 0.75,
    pattern: /\s+is\s+(?:a\s+)?friend(?:s)?\s+(?:of|with)\s+/i },
  // Generic "associate"
  { relation: 'introduced_by', kind: 'associate', symmetric: false, confidence: 0.6,
    pattern: /\s+was\s+introduced\s+by\s+/i },
  { relation: 'met_through', kind: 'associate', symmetric: false, confidence: 0.6,
    pattern: /\s+was\s+introduced\s+to\s+(?:me\s+)?by\s+/i },
];

const PROPER_NOUN_STOP: ReadonlySet<string> = new Set([
  'the', 'today', 'yesterday', 'tomorrow', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
  'december', 'i',
]);

/**
 * Extract person-person relation triples from `text`.
 */
export function extractPersonLinks(
  text: string,
  opts: ExtractPersonLinksOptions = {},
): PersonLink[] {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const maxGap = opts.maxGap ?? DEFAULT_MAX_GAP;
  const minConfidence = opts.minConfidence ?? 0;
  const connectors = [
    ...BUILT_IN_CONNECTORS,
    ...(opts.extraConnectors ?? []),
  ];

  const names = findNameCandidates(text);
  if (names.length < 2) return [];

  const out: PersonLink[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < names.length; i++) {
    const a = names[i]!;
    for (let j = i + 1; j < names.length; j++) {
      const b = names[j]!;
      if (b.span.start - a.span.end > maxGap) continue;
      if (b.span.start <= a.span.end) continue;
      const between = text.slice(a.span.end, b.span.start);

      for (const conn of connectors) {
        const fresh = new RegExp(conn.pattern.source, conn.pattern.flags);
        const match = fresh.exec(between);
        if (match === null) continue;
        // Strict match: the connector must span the entire gap
        // between A and B. A sub-string match means there's
        // unrelated text between A + connector OR between
        // connector + B, so the pair isn't really linked by this
        // connector. This avoids pairing "Amy is married to Tom"
        // with "Jane" via the "is married to" pattern.
        if (match.index !== 0 || match[0].length !== between.length) continue;
        const confidence = conn.confidence ?? 0.8;
        if (confidence < minConfidence) continue;

        const link: PersonLink = {
          a: { name: a.text, span: a.span },
          b: { name: b.text, span: b.span },
          relation: conn.relation,
          kind: conn.kind,
          symmetric: conn.symmetric ?? false,
          confidence,
          connectorSpan: {
            start: a.span.end + match.index,
            end: a.span.end + match.index + match[0].length,
          },
          connectorText: match[0],
        };
        const key = dedupKey(link);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(link);
        break; // first matching connector wins per pair
      }
    }
  }

  out.sort((x, y) => x.a.span.start - y.a.span.start);
  return out;
}

// ── Internals ──────────────────────────────────────────────────────────

function dedupKey(link: PersonLink): string {
  const aKey = `${link.a.span.start}:${link.a.span.end}`;
  const bKey = `${link.b.span.start}:${link.b.span.end}`;
  return `${aKey}|${bKey}|${link.relation}`;
}

function findNameCandidates(
  text: string,
): Array<{ text: string; span: { start: number; end: number } }> {
  const out: Array<{ text: string; span: { start: number; end: number } }> = [];
  // 1-3 title-cased tokens (all-caps acronyms allowed for proper-noun mixes).
  const pattern = /\b(?:[A-Z][a-zA-Z]*)(?:\s+[A-Z][a-zA-Z]*){0,2}\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0];
    const firstToken = raw.split(/\s+/)[0]!.toLowerCase();
    // Drop candidates whose first token is a common sentence-start /
    // day / month word — these aren't person names.
    if (PROPER_NOUN_STOP.has(firstToken)) continue;
    out.push({
      text: raw,
      span: { start: match.index, end: match.index + raw.length },
    });
  }
  return out;
}
