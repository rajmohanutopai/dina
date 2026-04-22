/**
 * Task 5.31 — intent classifier.
 *
 * Runs once before the reasoning agent starts. A small, fast LLM call
 * reads the user's query + Dina's Working Memory (ToC) and decides
 * which of Dina's THREE information sources can answer:
 *
 *   **vault** — the user's own captured data (preferences,
 *     relationships, past decisions, notes).
 *   **trust_network** — peer-verified opinions + reputation about
 *     products / services / vendors / people. Static at a point in
 *     time.
 *   **provider_services** — live queries to service providers for
 *     current operational state (ETA, status, availability, pricing).
 *     Dynamic minute-to-minute.
 *
 * **Why classify before reasoning?**  The reasoning agent doesn't
 * need to re-read the ToC on every turn — the classifier distills it
 * into a small routing object that primes the agent's first-turn
 * context. Soft priming (§9.3 in WORKING_MEMORY_DESIGN.md), not hard
 * shortlisting: the agent can still call any tool if the query
 * evolves or the classifier missed something.
 *
 * **Output contract** (`IntentClassification`) — filtered aggressively
 * from the LLM's raw response so the reasoning-agent prompt never
 * carries garbage:
 *   - `sources` is always a non-empty subset of the allow-list. An
 *     LLM that returns `[]` or only unknown names collapses to the
 *     conservative `["vault"]` default.
 *   - `temporal` is one of the allowed values or `""`.
 *   - `tocEvidence` is a passthrough dict; the reasoning agent
 *     treats it as a hint, not a contract.
 *
 * **Never throws.**  Every failure mode (empty query, LLM error,
 * unparseable response) returns the conservative default so callers
 * can continue with their full tool set.
 *
 * **Pluggable LLM + ToC fetcher** — production wires these to
 * ModelRouter (task 5.24) + `core.memory_toc`; tests pass scripted
 * stubs.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.31.
 */

export type IntentSource =
  | 'vault'
  | 'trust_network'
  | 'provider_services'
  | 'general_knowledge';

export type IntentTemporal = 'static' | 'live_state' | 'comparative' | '';

const ALLOWED_SOURCES: ReadonlySet<IntentSource> = new Set([
  'vault',
  'trust_network',
  'provider_services',
  'general_knowledge',
]);

const ALLOWED_TEMPORAL: ReadonlySet<IntentTemporal> = new Set([
  'static',
  'live_state',
  'comparative',
  '',
]);

/**
 * LLM response body — what the classifier expects the model to emit.
 * The actual `Record<string, unknown>` we get is coerced into this
 * shape via `coerceRaw`.
 */
export interface IntentClassification {
  sources: IntentSource[];
  relevantPersonas: string[];
  tocEvidence: Record<string, unknown>;
  temporal: IntentTemporal;
  reasoningHint: string;
}

/** One ToC row — minimum shape the classifier prompt needs. */
export interface TocEntry {
  persona: string;
  topic: string;
}

/** Async LLM call: return the raw content string. */
export type IntentLlmCallFn = (prompt: string) => Promise<{ content: string }>;

/** Async ToC fetcher. Returns [] for an empty Working Memory. */
export type TocFetcherFn = () => Promise<TocEntry[]>;

export interface IntentClassifierOptions {
  llmCallFn: IntentLlmCallFn;
  /** Optional ToC fetcher. When absent, prompt says "(empty)" and skips the block. */
  tocFetcherFn?: TocFetcherFn;
  /** Diagnostic hook. */
  onEvent?: (event: IntentClassifierEvent) => void;
}

export type IntentClassifierEvent =
  | { kind: 'classified'; sources: IntentSource[]; temporal: IntentTemporal }
  | { kind: 'empty_query' }
  | { kind: 'toc_fetch_failed'; error: string }
  | { kind: 'llm_failed'; error: string }
  | { kind: 'unparseable'; raw: string };

/**
 * Conservative fallback used by every failure path. Don't commit to a
 * source — the reasoning agent keeps its full tool set. The hint
 * explicitly signals "classifier unavailable" so the agent knows to
 * expand its search, not trust a narrow shortlist.
 */
export function defaultClassification(): IntentClassification {
  return {
    sources: ['vault'],
    relevantPersonas: [],
    tocEvidence: {},
    temporal: '',
    reasoningHint:
      'Classifier unavailable; reasoning agent should use its full tool set.',
  };
}

const SYSTEM_PROMPT = `You are the intent classifier for Dina, a sovereign personal AI.
Your job is to decide which information source(s) can answer a user query
— before any tool is called. You do NOT answer the query yourself.

THE THREE SOURCES

- vault — the user's own captured data: preferences, relationships,
  personal plans, life facts, past decisions, notes.
- trust_network — peer-verified opinions and reputation about
  products, services, vendors, people. Static (opinions at a point in
  time).
- provider_services — live queries to service providers for current
  operational state: ETA, status, availability, pricing, inventory.
  Dynamic (changes minute to minute).

HOW TO DECIDE

For any query, name the sources needed. It can be more than one.

- Source of context: does the query need the user's own data? If yes,
  include "vault". Self-referential grammar (my, I have, for me) is a
  strong signal.
- Temporal nature: does the answer depend on live state? If yes, the
  answer comes from "provider_services" (possibly parameterised with
  vault context).

OUTPUT FORMAT

Return ONLY a JSON object, no prose, no code fence:

{
  "sources": ["vault", "provider_services"],
  "relevant_personas": ["health"],
  "toc_evidence": {
    "entity_matches": ["Dr Carl"],
    "theme_matches": [],
    "persona_context": { "health": ["dentist appointment"] }
  },
  "temporal": "live_state",
  "reasoning_hint": "Short prose: why this routing."
}

Do NOT include extra keys. Do NOT answer the query.`;

export class IntentClassifier {
  private readonly llmCallFn: IntentLlmCallFn;
  private readonly tocFetcherFn?: TocFetcherFn;
  private readonly onEvent?: (event: IntentClassifierEvent) => void;

  constructor(opts: IntentClassifierOptions) {
    if (typeof opts.llmCallFn !== 'function') {
      throw new TypeError('IntentClassifier: llmCallFn is required');
    }
    this.llmCallFn = opts.llmCallFn;
    if (opts.tocFetcherFn !== undefined) this.tocFetcherFn = opts.tocFetcherFn;
    this.onEvent = opts.onEvent;
  }

  /**
   * Classify `query`. Always returns a classification — uses
   * `defaultClassification()` on every failure path.
   */
  async classify(query: string): Promise<IntentClassification> {
    const trimmed = (query ?? '').trim();
    if (trimmed.length === 0) {
      this.emit({ kind: 'empty_query' });
      return defaultClassification();
    }

    let toc: TocEntry[] = [];
    if (this.tocFetcherFn) {
      try {
        const fetched = await this.tocFetcherFn();
        toc = Array.isArray(fetched) ? fetched : [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit({ kind: 'toc_fetch_failed', error: msg });
        toc = [];
      }
    }

    const prompt = buildPrompt(trimmed, toc);
    let rawContent: string;
    try {
      const resp = await this.llmCallFn(prompt);
      rawContent = typeof resp?.content === 'string' ? resp.content : '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ kind: 'llm_failed', error: msg });
      return defaultClassification();
    }

    const parsed = parseLlmJson(rawContent);
    if (parsed === null) {
      this.emit({ kind: 'unparseable', raw: rawContent.slice(0, 200) });
      return defaultClassification();
    }
    const classification = coerceRaw(parsed);
    this.emit({
      kind: 'classified',
      sources: classification.sources,
      temporal: classification.temporal,
    });
    return classification;
  }

  private emit(event: IntentClassifierEvent): void {
    this.onEvent?.(event);
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function renderToc(entries: TocEntry[]): string {
  if (entries.length === 0) {
    return '(empty — user has not captured any topics yet)';
  }
  const grouped = new Map<string, string[]>();
  for (const e of entries) {
    const persona = e.persona && e.persona.length > 0 ? e.persona : 'general';
    const topic = typeof e.topic === 'string' ? e.topic.trim() : '';
    if (topic === '') continue;
    const list = grouped.get(persona) ?? [];
    list.push(topic);
    grouped.set(persona, list);
  }
  const lines: string[] = [];
  for (const [persona, topics] of grouped) {
    if (topics.length > 0) {
      lines.push(`  ${persona}: ${topics.join(', ')}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(empty)';
}

function buildPrompt(query: string, toc: TocEntry[]): string {
  return `${SYSTEM_PROMPT}\n\nWorking Memory:\n${renderToc(toc)}\n\nUser query:\n${query}\n\nClassification JSON:`;
}

function parseLlmJson(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text === '') return null;
  if (text.startsWith('```')) {
    // Strip ```json and closing ```
    const nl = text.indexOf('\n');
    if (nl === -1) return null;
    text = text.slice(nl + 1);
    const closeIdx = text.lastIndexOf('```');
    if (closeIdx !== -1) text = text.slice(0, closeIdx);
    text = text.trim();
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Reject unknown source / temporal values; keep every other field best-effort. */
export function coerceRaw(data: Record<string, unknown>): IntentClassification {
  const rawSources = asStringList(data['sources']);
  const filteredSources = rawSources.filter((s): s is IntentSource =>
    ALLOWED_SOURCES.has(s as IntentSource),
  );
  // If the LLM gave us nothing actionable, collapse to the conservative default
  // source list (NOT an empty array — downstream code expects >= 1 entry).
  const sources = filteredSources.length > 0 ? filteredSources : ['vault' as const];

  const relevantPersonas = asStringList(data['relevant_personas']);

  const tocEvidenceRaw = data['toc_evidence'];
  const tocEvidence =
    tocEvidenceRaw !== null &&
    typeof tocEvidenceRaw === 'object' &&
    !Array.isArray(tocEvidenceRaw)
      ? (tocEvidenceRaw as Record<string, unknown>)
      : {};

  const temporalRaw = data['temporal'];
  const temporal: IntentTemporal =
    typeof temporalRaw === 'string' && ALLOWED_TEMPORAL.has(temporalRaw as IntentTemporal)
      ? (temporalRaw as IntentTemporal)
      : '';

  const hintRaw = data['reasoning_hint'];
  const reasoningHint = typeof hintRaw === 'string' ? hintRaw : '';

  return {
    sources,
    relevantPersonas,
    tocEvidence,
    temporal,
    reasoningHint,
  };
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t.length > 0) out.push(t);
    }
  }
  return out;
}
