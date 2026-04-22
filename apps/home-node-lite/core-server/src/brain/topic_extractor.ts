/**
 * Topic extractor (GAP.md row #27 closure — M1/M2 blocker).
 *
 * Extracts topic labels from a piece of content so Brain's working
 * memory (task 5.42 scratchpad + the ToC maintained by main.py on
 * the Python side) can track what the user has been thinking about.
 *
 * **Working-memory contract** (see CLAUDE.md — "Working Memory /
 * Topic store = ToC"):
 *
 *   On every ingested item, extract topics → update a Table-of-
 *   Contents with EWMA-weighted salience. The ToC is rendered into
 *   Brain's prompts BEFORE vault queries so reasoning carries the
 *   short-term + long-term topic signal.
 *
 * This primitive is the **extractor half** only. The EWMA-weighted
 * store lives separately (not yet ported from Python — a follow-up
 * primitive that composes on top of this one).
 *
 * **Extraction algorithm** (heuristic, no LLM call):
 *
 *   1. Normalise — lowercase, collapse whitespace.
 *   2. Tokenise on word boundaries; keep tokens ≥3 chars.
 *   3. Filter stop-list + common function words.
 *   4. Collapse simple plural / possessive endings (`s`, `es`, `'s`).
 *   5. Extract quoted phrases as multi-word topics (verbatim).
 *   6. Extract capitalised-phrase noun phrases from the ORIGINAL text
 *      (runs of 2+ title-cased tokens) — proper-noun detection
 *      without NER.
 *   7. Score each candidate: count occurrences × length bonus for
 *      multi-word topics × rarity bonus for less-common tokens.
 *      Normalise to [0, 1].
 *   8. Sort by salience desc + cap at `maxTopics`.
 *
 * **No LLM dependency** — deterministic, testable offline.
 *
 * **Why not use a proper NLP library**: keeping this primitive pure +
 * zero-dep keeps the brain-server image slim. The Python side uses
 * spaCy-like processing; the TS side trades perfect recall for
 * shippability. Tests pin the extraction contract so swapping in a
 * smarter extractor later is a drop-in change.
 *
 * Source: GAP.md (task 5.46 follow-up) — M1 memory-flows gate.
 */

export interface Topic {
  /** Canonical label (lowercase for single words; preserved case for multi-word). */
  label: string;
  /** Salience in [0, 1]. 1.0 = dominant topic; 0.1 = marginal. */
  salience: number;
  /** Number of times the topic appeared. */
  occurrences: number;
  /** Character-range spans where the topic was found. */
  spans: Array<{ start: number; end: number }>;
  /** 'word' | 'phrase' — phrases are quoted or capitalised multi-token. */
  kind: 'word' | 'phrase';
}

export interface ExtractTopicsOptions {
  /** Max topics to return. Defaults to 10. */
  maxTopics?: number;
  /** Additional stop words the caller wants filtered. Merged with builtin list. */
  extraStopWords?: ReadonlyArray<string>;
  /** Minimum word length. Default 3. Single chars are almost always noise. */
  minLength?: number;
  /** Minimum occurrence count to survive filtering. Default 1. */
  minOccurrences?: number;
}

export const DEFAULT_MAX_TOPICS = 10;
export const DEFAULT_MIN_WORD_LENGTH = 3;

/**
 * English stop-list — common function words + structural verbs that
 * shouldn't surface as topics. Kept small on purpose; tests pin
 * specific membership so the list is reviewable.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // articles + conjunctions
  'the', 'and', 'but', 'for', 'nor', 'yet', 'so', 'or',
  // pronouns
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'him', 'her',
  'his', 'hers', 'it', 'its', 'they', 'them', 'their', 'this', 'that',
  'these', 'those',
  // common verbs
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'may',
  'might', 'must', 'shall',
  // prepositions
  'of', 'in', 'on', 'at', 'by', 'to', 'from', 'with', 'about', 'into',
  'over', 'under', 'between', 'through', 'across', 'after', 'before',
  // filler
  'not', 'just', 'only', 'very', 'too', 'also', 'then', 'than', 'as', 'if',
  'because', 'when', 'where', 'what', 'who', 'how', 'why',
  // contractions (simplified)
  'don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'weren', 'hasn', 'haven',
  'hadn', 'can', 'couldn', 'shouldn', 'wouldn', 'won', 'wouldn',
]);

/**
 * Extract topics from `text`. Returns at most `maxTopics` ordered by
 * salience descending. Deterministic: same input + same options →
 * same output.
 */
export function extractTopics(
  text: string,
  opts: ExtractTopicsOptions = {},
): Topic[] {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const maxTopics = opts.maxTopics ?? DEFAULT_MAX_TOPICS;
  const minLength = opts.minLength ?? DEFAULT_MIN_WORD_LENGTH;
  const minOccurrences = opts.minOccurrences ?? 1;
  const stopWords = opts.extraStopWords
    ? new Set([...STOP_WORDS, ...opts.extraStopWords.map((w) => w.toLowerCase())])
    : STOP_WORDS;

  const candidates = new Map<string, { info: TopicInfo }>();

  // 1. Quoted phrases (verbatim).
  for (const phrase of extractQuotedPhrases(text)) {
    upsertTopic(candidates, phrase.label, phrase.span, 'phrase');
  }

  // 2. Capitalised proper-noun phrases (2+ title-cased tokens).
  for (const phrase of extractCapitalisedPhrases(text)) {
    upsertTopic(candidates, phrase.label, phrase.span, 'phrase');
  }

  // 3. Single-word tokens with stemming + stop-list filter.
  for (const word of iterateWords(text)) {
    const normalised = canonicaliseWord(word.text);
    if (normalised.length < minLength) continue;
    if (stopWords.has(normalised)) continue;
    upsertTopic(candidates, normalised, word.span, 'word');
  }

  // 4. Score + filter + sort + cap.
  const scored: Topic[] = [];
  const totalOccurrences = Array.from(candidates.values()).reduce(
    (sum, { info }) => sum + info.occurrences,
    0,
  );
  for (const [label, { info }] of candidates) {
    if (info.occurrences < minOccurrences) continue;
    const salience = scoreTopic(info, totalOccurrences);
    scored.push({
      label,
      salience,
      occurrences: info.occurrences,
      spans: info.spans.slice(),
      kind: info.kind,
    });
  }

  scored.sort((a, b) => {
    if (b.salience !== a.salience) return b.salience - a.salience;
    // Stable tiebreak by label so output is deterministic across runs.
    return a.label.localeCompare(b.label);
  });

  return scored.slice(0, maxTopics);
}

// ── Internals ──────────────────────────────────────────────────────────

interface TopicInfo {
  occurrences: number;
  spans: Array<{ start: number; end: number }>;
  kind: 'word' | 'phrase';
}

function upsertTopic(
  bucket: Map<string, { info: TopicInfo }>,
  label: string,
  span: { start: number; end: number },
  kind: 'word' | 'phrase',
): void {
  const existing = bucket.get(label);
  if (existing) {
    existing.info.occurrences += 1;
    existing.info.spans.push(span);
    // Promote to phrase if we see a multi-word occurrence.
    if (kind === 'phrase') existing.info.kind = 'phrase';
  } else {
    bucket.set(label, {
      info: { occurrences: 1, spans: [span], kind },
    });
  }
}

/**
 * Simple stemming: drop `'s`, `s`, and `es` endings so "meetings"
 * and "meeting" collapse into one topic. Zero-dep Porter-lite.
 */
function canonicaliseWord(word: string): string {
  let w = word.toLowerCase();
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('es') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

function* iterateWords(
  text: string,
): Generator<{ text: string; span: { start: number; end: number } }> {
  const pattern = /\b[\p{L}][\p{L}'-]*\b/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    yield {
      text: match[0],
      span: { start: match.index, end: match.index + match[0].length },
    };
  }
}

function extractQuotedPhrases(
  text: string,
): Array<{ label: string; span: { start: number; end: number } }> {
  const out: Array<{ label: string; span: { start: number; end: number } }> = [];
  // Double quotes, single quotes, smart quotes.
  const pattern = /"([^"]{2,80})"|“([^”]{2,80})”|'([^']{2,80})'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const captured = match[1] ?? match[2] ?? match[3] ?? '';
    const trimmed = captured.trim();
    if (trimmed === '') continue;
    // Skip if the "phrase" is actually just one word — those aren't
    // multi-word topics, the word extractor will catch them.
    if (!/\s/.test(trimmed)) continue;
    out.push({
      label: trimmed,
      span: { start: match.index, end: match.index + match[0].length },
    });
  }
  return out;
}

function extractCapitalisedPhrases(
  text: string,
): Array<{ label: string; span: { start: number; end: number } }> {
  const out: Array<{ label: string; span: { start: number; end: number } }> = [];
  // 2+ runs of Capitalised Words — proper-noun-ish phrases. Each
  // token is one initial cap + any mix of letters so all-caps
  // acronyms ("AI", "NASA") participate in multi-word proper nouns
  // like "Open AI" or "Bank of NYC".
  const pattern = /\b(?:[A-Z][a-zA-Z]*)(?:\s+[A-Z][a-zA-Z]*){1,4}\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const phrase = match[0];
    // Skip sentence starters — if the phrase is at position 0 OR the
    // preceding char is a sentence terminator, the first token might
    // be a plain sentence-start capital (e.g. "The"). Heuristic: drop
    // leading common sentence starters.
    const tokens = phrase.split(/\s+/);
    const filtered = tokens.filter((t, i) => {
      if (i > 0) return true;
      const lower = t.toLowerCase();
      return !STOP_WORDS.has(lower);
    });
    if (filtered.length < 2) continue;
    const label = filtered.join(' ');
    out.push({
      label,
      span: { start: match.index, end: match.index + match[0].length },
    });
  }
  return out;
}

/**
 * Salience score for a topic. Baseline is occurrence-ratio; multi-word
 * phrases get a 1.5× bonus; very short single words get a slight
 * penalty (they're often false positives).
 */
function scoreTopic(info: TopicInfo, totalOccurrences: number): number {
  if (totalOccurrences === 0) return 0;
  const base = info.occurrences / totalOccurrences;
  const lengthBonus = info.kind === 'phrase' ? 1.5 : 1;
  const raw = base * lengthBonus;
  // Clamp to [0, 1]. Short texts can overshoot because of the bonus.
  return Math.min(1, Math.max(0, raw));
}
